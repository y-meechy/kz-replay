import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import test from "node:test";
import {
  comparePngBuffers,
  summarizeFrameDurations,
  summarizeFramePhases,
  validateCaptureMetadata,
  validateMatchedCaptureMetadata,
  validateMatchedMeasurementIdentity,
} from "./fidelityMetrics.js";

const metadata = (captureId = "capture-a") => ({
  schema: "kz-replay-fidelity-capture",
  schemaVersion: 1,
  source: "cs2",
  captureId,
  map: { name: "kz_victoria", checksum: "sha256:map", version: "workshop-1" },
  reference: { source: "cs2", build: "cs2-build-under-test" },
  camera: {
    position: [12, -4, 96],
    angles: [0, 90, 0],
    fov: 90,
    fovConvention: "horizontal",
    aspect: 2,
    resolution: { width: 4, height: 2 },
    dpr: 1,
  },
  graphics: { settings: { hdr: true, msaa: 4, shadows: "high" } },
});

const png = (pixels, width, height) =>
  sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

test("PNG comparison reports overall and named ROI metrics and writes an abs diff", async () => {
  const reference = await png([0, 0, 0, 255, 100, 100, 100, 255], 2, 1);
  const candidate = await png([10, 20, 30, 0, 100, 90, 80, 255], 2, 1);
  const directory = await mkdtemp(join(tmpdir(), "kz-fidelity-test-"));
  const diffPath = join(directory, "difference.png");
  const result = await comparePngBuffers(reference, candidate, {
    diffPath,
    rois: { leftPixel: { left: 0, top: 0, width: 1, height: 1 } },
  });

  assert.deepEqual(result.metrics.overall, {
    width: 2,
    height: 1,
    pixelCount: 2,
    channelCount: 3,
    sampleCount: 6,
    differingPixels: 2,
    maxAbsolute: 30,
    mae: 15,
    rmse: Math.sqrt(1900 / 6),
    psnr: 20 * Math.log10(255 / Math.sqrt(1900 / 6)),
  });
  assert.equal(result.metrics.leftPixel.mae, 20);
  assert.equal(result.metrics.leftPixel.pixelCount, 1);
  assert.equal(result.diffPath, diffPath);
  const diffInfo = await sharp(await readFile(diffPath))
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([...diffInfo.data], [10, 20, 30, 255, 0, 10, 20, 255]);
});

test("alpha can be included explicitly and ROIs must fit the image", async () => {
  const reference = await png([0, 0, 0, 255], 1, 1);
  const candidate = await png([0, 0, 0, 0], 1, 1);
  const result = await comparePngBuffers(reference, candidate, {
    includeAlpha: true,
  });
  assert.equal(result.metrics.overall.mae, 63.75);
  assert.equal(result.metrics.overall.rmse, 127.5);
  await assert.rejects(
    comparePngBuffers(reference, candidate, {
      rois: { outside: { left: 1, top: 0, width: 1, height: 1 } },
    }),
    /outside image bounds/,
  );
});

test("capture metadata is strict and matched visual setup ignores captureId", () => {
  assert.doesNotThrow(() => validateCaptureMetadata(metadata()));
  assert.throws(
    () =>
      validateCaptureMetadata({
        ...metadata(),
        reference: { source: "viewer", build: "x" },
      }),
    /viewer captures are not references/,
  );
  assert.throws(
    () =>
      validateCaptureMetadata({
        ...metadata(),
        camera: { ...metadata().camera, aspect: 1 },
      }),
    /aspect.*resolution/,
  );
  const viewerMetadata = { ...metadata("capture-b"), source: "viewer" };
  assert.throws(
    () => validateMatchedCaptureMetadata(viewerMetadata, viewerMetadata),
    /actual CS2 reference/,
  );
  assert.doesNotThrow(() =>
    validateMatchedCaptureMetadata(metadata(), viewerMetadata),
  );
  assert.throws(
    () =>
      validateMatchedCaptureMetadata(metadata(), {
        ...metadata("capture-b"),
        map: { ...metadata().map, checksum: "other" },
      }),
    /mismatch in map/,
  );
});

test("frame summaries reject invalid samples and retain cold/warm phases", () => {
  const summary = summarizeFrameDurations([1, 2, 3, 4]);
  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.median, 2.5);
  assert.ok(Math.abs(summary.p95 - 3.85) < 1e-12);
  assert.ok(Math.abs(summary.p99 - 3.97) < 1e-12);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 4);
  assert.equal(
    summarizeFramePhases({ cold: [10, 20], warm: [2, 4] }).cold.sampleCount,
    2,
  );
  for (const samples of [[], [0], [-1], [Number.NaN], [Infinity]]) {
    assert.throws(() => summarizeFrameDurations(samples), /durations/);
  }
});

test("measurement identities must match across paired captures", () => {
  const base = {
    runId: "run-1",
    hardwareId: "gpu-a",
    browserId: "chrome-1",
    pathId: "victoria-fp",
    repetition: 2,
  };
  assert.doesNotThrow(() =>
    validateMatchedMeasurementIdentity(base, { ...base }),
  );
  assert.throws(
    () =>
      validateMatchedMeasurementIdentity(base, {
        ...base,
        browserId: "firefox-1",
      }),
    /browserId/,
  );
  assert.throws(
    () =>
      validateMatchedMeasurementIdentity(base, {
        ...base,
        pathId: "grotto-fp",
      }),
    /pathId/,
  );
});
