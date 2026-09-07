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

test("a smaller native atlas ships the authored mip chain from that level, never a recompression", async () => {
  const { authoredMipChain } = await import("./mapLightmap.js");
  const mip = (side) => ({
    width: side,
    height: side,
    data: new Uint8Array(Math.ceil(side / 4) ** 2 * 16).fill(side & 255),
  });
  const texture = {
    encoding: "bc6h-unsigned-linear",
    width: 16,
    height: 16,
    mipmaps: [mip(16), mip(8), mip(4)],
  };
  const chain = authoredMipChain(texture, 8);
  assert.equal(chain.width, 8);
  assert.equal(chain.mipmaps.length, 2);
  assert.equal(chain.mipmaps[0].data[0], 8);
  assert.equal(chain.mipmaps[1].data[0], 4);
  assert.equal(authoredMipChain(texture, 6), null);
});
