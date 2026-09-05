import test from "node:test";
import assert from "node:assert/strict";
import { resolveMapAssets, legacySidecarUrl } from "../viewer/src/mapAssets.js";

const entry = (url) => ({ url, sha256: "a".repeat(64), bytes: 20 });
const manifest = {
  schemaVersion: 1,
  activeRevision: "r1",
  revisions: {
    r1: {
      files: {
        geometry: entry("kz_test.assets/r1/map.glb"),
        lightmapIrradiance: null,
        sky: null,
      },
    },
  },
};
test("resolves a generation and never invents missing sidecars", async () => {
  const assets = await resolveMapAssets(
    "https://test/maps/kz_test.glb?v=2",
    async (url, options) => {
      assert.equal(url, "https://test/maps/kz_test.assets.json?v=2");
      assert.equal(options.cache, "no-cache");
      return Response.json(manifest);
    },
  );
  assert.equal(
    assets.geometryUrl,
    "https://test/maps/kz_test.assets/r1/map.glb",
  );
  assert.equal(assets.files.lightmapIrradiance, null);
  assert.equal(assets.legacy, false);
});
test("legacy 404 works but a broken versioned manifest fails closed", async () => {
  assert.equal(
    (
      await resolveMapAssets(
        "https://test/maps/a.glb",
        async () => new Response(null, { status: 404 }),
      )
    ).legacy,
    true,
  );
  await assert.rejects(
    resolveMapAssets("https://test/maps/a.glb", async () =>
      Response.json({ ...manifest, schemaVersion: 9 }),
    ),
    /Unsupported/,
  );
  await assert.rejects(
    resolveMapAssets(
      "https://test/maps/a.glb",
      async () => new Response(null, { status: 503 }),
    ),
    /503/,
  );
});
test("legacy sidecars retain the complete cache key", () => {
  assert.equal(
    legacySidecarUrl("https://test/maps/a.glb?revision=2", ".light.webp"),
    "https://test/maps/a.light.webp?revision=2",
  );
});
