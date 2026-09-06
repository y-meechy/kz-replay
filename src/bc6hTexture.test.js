import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  encodeBc6hTexture,
  parseBc6hTexture,
  BC6H_ENCODING,
} from "./bc6hTexture.js";
import { readSource2Bc6h, decodeLz4Block } from "./source2Texture.js";
import {
  createBc6hLightmap,
  loadBc6hLightmap,
} from "../viewer/src/compressedLightmap.js";
import { attachBakedLight } from "../viewer/src/mapMaterials.js";

// Synthetic 8x4 single-slice array. Source stores mip1 (16 bytes) before mip0
// (32 bytes); mip0's LZ4 block expands one literal and an overlapping match.
const sourceFixture = () => {
  const b = Buffer.alloc(112 + 16 + 5);
  b.writeUInt32LE(112, 0);
  b.writeUInt16LE(12, 4);
  b.writeUInt16LE(1, 6);
  b.writeUInt32LE(8, 8);
  b.writeUInt32LE(1, 12);
  b.write("DATA", 16);
  b.writeUInt32LE(12, 20);
  b.writeUInt32LE(80, 24);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(0x40, 34);
  b.writeUInt16LE(8, 52);
  b.writeUInt16LE(4, 54);
  b.writeUInt16LE(1, 56);
  b[58] = 19;
  b[59] = 2;
  b.writeUInt32LE(8, 64);
  b.writeUInt32LE(1, 68);
  b.writeUInt32LE(4, 72);
  b.writeUInt32LE(8, 76);
  b.writeUInt32LE(12, 80);
  b.writeUInt32LE(1, 84);
  b.writeUInt32LE(8, 88);
  b.writeUInt32LE(2, 92);
  b.writeUInt32LE(5, 96);
  b.writeUInt32LE(16, 100);
  b.fill(9, 112, 128);
  b.set([0x1f, 7, 1, 0, 12], 128);
  return b;
};

test("Source 2 unsigned BC6H retains authored mip order and decompresses LZ4 only", () => {
  const parsed = readSource2Bc6h(sourceFixture());
  assert.equal(parsed.encoding, BC6H_ENCODING);
  assert.deepEqual(
    parsed.mipmaps.map((m) => [m.width, m.height]),
    [
      [8, 4],
      [4, 2],
    ],
  );
  assert.deepEqual([...parsed.mipmaps[0].data], Array(32).fill(7));
  assert.deepEqual([...parsed.mipmaps[1].data], Array(16).fill(9));
  const roundtrip = parseBc6hTexture(encodeBc6hTexture(parsed));
  assert.deepEqual(
    roundtrip.mipmaps.map((m) => [...m.data]),
    parsed.mipmaps.map((m) => [...m.data]),
  );
});

test("Source 2 rejects unsupported layout, compression, cropped display and truncation", () => {
  for (const [offset, value] of [
    [4, 13],
    [32, 2],
    [34, 0x50],
    [56, 2],
    [58, 20],
    [59, 9],
    [84, 2],
    [92, 1],
    [96, 0],
  ]) {
    const b = sourceFixture();
    b[offset] = value;
    assert.throws(() => readSource2Bc6h(b), undefined, `offset ${offset}`);
  }
  const crop = sourceFixture();
  crop.writeUInt32LE(3, 72);
  crop.writeUInt16LE(4, 86);
  crop.writeUInt16LE(4, 88);
  assert.throws(() => readSource2Bc6h(crop), /display rectangle/);
  assert.throws(
    () => readSource2Bc6h(sourceFixture().subarray(0, 130)),
    /truncated/,
  );
  assert.throws(
    () => readSource2Bc6h(Buffer.concat([sourceFixture(), Buffer.from([0])])),
    /trailing/,
  );
  assert.throws(
    () => decodeLz4Block(Uint8Array.of(0, 0, 0), 4),
    /match offset/,
  );
  assert.throws(() => decodeLz4Block(Uint8Array.of(0xf0), 16), /length/);
});

test("BC6H transport rejects bad tables and unknown versions", () => {
  const encoded = encodeBc6hTexture(readSource2Bc6h(sourceFixture()));
  for (const [offset, value] of [
    [0, 0],
    [8, 2],
    [20, 20],
    [24, 4],
    [32, 31],
  ]) {
    const b = encoded.slice();
    b[offset] = value;
    assert.throws(() => parseBc6hTexture(b));
  }
  assert.throws(
    () => parseBc6hTexture(encoded.subarray(0, encoded.length - 1)),
    /truncated/,
  );
});

test("BC6H loader retains partial mip chains as linear unsigned compressed textures", async () => {
  const encoded = encodeBc6hTexture(readSource2Bc6h(sourceFixture()));
  const descriptor = {
    encoding: BC6H_ENCODING,
    width: 8,
    height: 4,
    mipCount: 2,
    url: "atlas.bc6",
  };
  const renderer = {
    capabilities: { maxTextureSize: 8192 },
    extensions: { has: () => true },
  };
  const texture = await loadBc6hLightmap(descriptor, {
    renderer,
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => encoded.buffer,
    }),
  });
  assert.equal(texture.format, THREE.RGB_BPTC_UNSIGNED_Format);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.flipY, false);
  assert.equal(texture.mipmaps.length, 2);
  assert.throws(
    () => createBc6hLightmap(encoded, { ...descriptor, width: 4 }),
    /descriptor/,
  );
  renderer.extensions.has = () => false;
  await assert.rejects(
    loadBc6hLightmap(descriptor, {
      renderer,
      fetchImpl: () => assert.fail("must not fetch"),
    }),
    /unsupported/,
  );
  texture.dispose();
});

test("BC6H lightmap shader never decodes RGBM but retains Source diffuse units", () => {
  const material = new THREE.MeshStandardMaterial();
  const texture = createBc6hLightmap(
    encodeBc6hTexture(readSource2Bc6h(sourceFixture())),
  );
  attachBakedLight(texture, new Set([material]), 1, {
    encoding: BC6H_ENCODING,
    excludeSceneLights: true,
  });
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader);
  assert.match(
    shader.fragmentShader,
    /lightMapTexel\.rgb \* PI \* lightMapIntensity/,
  );
  assert.doesNotMatch(
    shader.fragmentShader,
    /kzLightmapRange|lightMapTexel\.a/,
  );
  assert.equal(material.userData.kzLightmapEncoding, BC6H_ENCODING);
  material.dispose();
  texture.dispose();
});
