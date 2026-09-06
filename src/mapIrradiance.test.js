import test from "node:test";
import assert from "node:assert/strict";
import { loadPublishedIrradiance } from "../viewer/src/mapIrradiance.js";

const files = {
  lightmapIrradiance: {
    url: "atlas.png",
    width: 8,
    height: 8,
    encoding: "rgbm8-linear",
    range: 4,
  },
  lightmapIrradianceCompressed: {
    url: "atlas.bc6",
    width: 8,
    height: 8,
    encoding: "bc6h-unsigned-linear",
    mipCount: 2,
  },
};
test("native HDR loads exactly one atlas and retains its linear encoding", async () => {
  const texture = {};
  const result = await loadPublishedIrradiance({}, files, {
    supportsCompressed: () => true,
    loadCompressed: async (descriptor) => {
      assert.equal(descriptor, files.lightmapIrradianceCompressed);
      return texture;
    },
    loadImage: () =>
      assert.fail("fallback must not be fetched on supported GPUs"),
  });
  assert.equal(result.texture, texture);
  assert.equal(result.descriptor.encoding, "bc6h-unsigned-linear");
});
test("unsupported or failed native HDR uses the full-resolution RGBM descriptor", async () => {
  for (const supported of [false, true]) {
    let warnings = 0;
    const result = await loadPublishedIrradiance({}, files, {
      supportsCompressed: () => supported,
      loadCompressed: async () => {
        throw new Error("network failure");
      },
      loadImage: async (url) => {
        assert.equal(url, "atlas.png");
        return {};
      },
      warn: () => warnings++,
    });
    assert.equal(result.descriptor, files.lightmapIrradiance);
    assert.equal(warnings, Number(supported));
    assert.match(
      result.fallbackReason,
      supported ? /network failure/ : /bptc-unavailable/,
    );
  }
});
test("native HDR cannot silently substitute a lower-resolution atlas", async () => {
  await assert.rejects(
    loadPublishedIrradiance(
      {},
      {
        ...files,
        lightmapIrradianceCompressed: {
          ...files.lightmapIrradianceCompressed,
          width: 4,
        },
      },
    ),
    /dimensions differ/,
  );
  assert.equal(await loadPublishedIrradiance({}, {}), null);
});
