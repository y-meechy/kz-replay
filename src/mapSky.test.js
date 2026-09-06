import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { readCompiledSkyTexture, readSkyMaterial } from "./mapSky.js";
import { configureHdrSky } from "../viewer/src/mapSky.js";

test("sky material retains authored exposure multipliers, without inventing a sun", () => {
  assert.deepEqual(
    readSkyMaterial(`
    "g_flBrightnessExposureBias" "1.5"
    "g_flRenderOnlyExposureBias" "-0.5"
    "g_vTint" "[1 0.5 0.25 1]"
    "SolarPosition" "[0 0 1]"
  `),
    {
      brightnessExposureBias: 1.5,
      renderOnlyExposureBias: -0.5,
      tint: [1, 0.5, 0.25],
    },
  );
});

test("compiled sky DATA is read without requiring shader decompilation", () => {
  const data = `
    m_floatParams = [
      { m_name = "g_flBrightnessExposureBias" m_flValue = 1.25 },
      { m_name = "g_flRenderOnlyExposureBias" m_flValue = -0.5 },
    ]
    m_vectorParams = [
      { m_name = "g_vTint" m_value = [ 0.5, 0.25, 1.0, 1.0 ] },
    ]
    m_textureParams = [
      { m_name = "g_tSkyTexture" m_pValue = resource:"materials/skybox/test_hdr.vtex" },
    ]`;
  assert.deepEqual(readSkyMaterial(data), {
    brightnessExposureBias: 1.25,
    renderOnlyExposureBias: -0.5,
    tint: [0.5, 0.25, 1],
  });
  assert.equal(readCompiledSkyTexture(data), "materials/skybox/test_hdr.vtex");
});

test("HDR sky preserves values above one and applies material factors in linear light", () => {
  const texture = new THREE.DataTexture(
    new Float32Array([4, 2, 1, 1, 8, 4, 2, 1]),
    2,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const result = configureHdrSky(texture, {
    encoding: "exr-linear",
    projection: "vrf-latlong",
    width: 2,
    height: 1,
    material: { brightnessExposureBias: 1, tint: [1, 0.5, 0.25] },
  });
  assert.deepEqual([...texture.image.data], [8, 2, 0.5, 1, 16, 4, 1, 1]);
  assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(result.rotation.y, Math.PI);
  let disposed = false;
  texture.addEventListener("dispose", () => {
    disposed = true;
  });
  result.dispose();
  assert.equal(disposed, true);
});

test("HDR sky rejects unknown encodings and mismatched dimensions", () => {
  const texture = new THREE.DataTexture(
    new Float32Array(8),
    2,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  assert.throws(
    () => configureHdrSky(texture, { encoding: "srgb" }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      configureHdrSky(texture, {
        encoding: "exr-linear",
        projection: "vrf-latlong",
        width: 4,
        height: 2,
      }),
    /dimensions/,
  );
});
