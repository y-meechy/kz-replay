import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  cleanupTemporaryGlb,
  convertMap,
  validateMapConversionInput,
} from "./mapPipeline.js";

test("accepts the identifier characters used by KZ map names", () => {
  for (const mapName of [
    "kz_victoria",
    "kz_bhop_slide",
    "kz_worlds2026_blue",
    "KZ-map_2",
  ]) {
    assert.doesNotThrow(() =>
      validateMapConversionInput({ mapName, workshopId: "3086304337" }),
    );
  }
});

test("rejects map path traversal and non-numeric workshop ids", () => {
  for (const mapName of [
    "",
    ".",
    "..",
    "../kz_victoria",
    "maps/kz_victoria",
    "kz_victoria.glb",
    "kz victoria",
  ]) {
    assert.throws(
      () => validateMapConversionInput({ mapName, workshopId: "3086304337" }),
      /mapName/,
    );
  }

  for (const workshopId of [
    undefined,
    "",
    "../3086304337",
    "3086304337/other",
    "+3086304337",
    "3086304337x",
  ]) {
    assert.throws(
      () => validateMapConversionInput({ mapName: "kz_victoria", workshopId }),
      /workshopId/,
    );
  }
});

test("convertMap rejects unsafe input before creating output directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "kz-map-path-test-"));
  const outputDir = join(root, "not-created");

  await assert.rejects(
    convertMap({
      mapName: "../outside",
      workshopId: "3086304337",
      toolsDir: join(root, "tools"),
      outputDir,
    }),
    /mapName/,
  );
  await assert.rejects(access(outputDir));
});

test("temporary cleanup only removes the validated map's sibling file", async () => {
  const root = await mkdtemp(join(tmpdir(), "kz-map-cleanup-test-"));
  const outputDir = join(root, "maps");
  const temporary = join(outputDir, ".kz_victoria.tmp.glb");
  const sibling = join(root, "keep.txt");
  await mkdir(outputDir);
  await Promise.all([
    writeFile(temporary, "temporary"),
    writeFile(sibling, "keep"),
  ]);

  await cleanupTemporaryGlb(outputDir, "kz_victoria");

  await assert.rejects(access(temporary));
  await access(sibling);
  assert.throws(() => cleanupTemporaryGlb(outputDir, "../keep"), /mapName/);
  await access(sibling);
});
