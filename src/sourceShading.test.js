import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  correctSourceMaterial,
  sourceShadingOf,
} from "../viewer/src/sourceShading.js";
import { createMapMaterials } from "../viewer/src/mapMaterials.js";

// Trimmed from kz_bhop_majka's exported extras.vmat.
const majkaWater = {
  Name: "materials/water/watercustomm.vmat",
  ShaderName: "csgo_water_fancy.vfx",
  VectorParams: {
    g_vColorTint: [1, 0, 0, 1],
    g_vWaterFogColor: [0.262745, 0.815686, 1, 1],
  },
};
const majkaLeaves = {
  ShaderName: "csgo_foliage.vfx",
  FloatParams: {
    g_flVertexAmbientOcclusionAmount: 0,
    g_flVertexAmbientOcclusionPower: 1,
  },
};
const underbrushCards = {
  ShaderName: "csgo_foliage.vfx",
  FloatParams: {
    g_flVertexAmbientOcclusionAmount: 0.123,
    g_flVertexAmbientOcclusionPower: 1,
  },
};

// GLTFLoader's shape for a primitive with COLOR_0: a material clone with vertex colours.
const imported = (vmat, color = 0xffffff) => {
  const material = new THREE.MeshStandardMaterial({
    color,
    vertexColors: true,
  });
  material.userData.vmat = vmat;
  return material;
};

const compiled = (material) => {
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
  };
  material.onBeforeCompile(shader, {});
  return shader.fragmentShader;
};

test("majka water is coloured by g_vWaterFogColor, never the unread red tint", () => {
  const material = imported(majkaWater, 0xff0000);
  correctSourceMaterial(material);
  assert.equal(material.color.getHexString(THREE.SRGBColorSpace), "43d0ff");
  const { r, g, b } = material.color;
  assert.ok(b > r && g > r, "blue-cyan, not red");
});

test("foliage vertex colour is animation data, not albedo", () => {
  const material = imported(majkaLeaves);
  const shading = correctSourceMaterial(material);
  assert.equal(shading.ignoreVertexColor, true);
  assert.equal(material.vertexColors, false);
  // The base colour is left exactly as exported.
  assert.equal(material.color.getHexString(), "ffffff");
});

test("foliage that enables vertex AO keeps only the alpha channel", () => {
  const material = imported(underbrushCards);
  correctSourceMaterial(material);
  assert.equal(material.vertexColors, true, "attribute stays bound for alpha");
  const fragment = compiled(material);
  assert.doesNotMatch(fragment, /#include <color_fragment>/);
  assert.match(fragment, /pow\(max\(vColor\.a, 0\.0\), 1\.0000\), 0\.1230\)/);
  assert.match(
    material.customProgramCacheKey(),
    /kz-foliage-vertex-ao:0\.123:1/,
  );
});

test("converter fallback colours ignore orphaned vertex colour", () => {
  // kz_bhop_majka's taro_leaf_plant_1: name-guessed green, COLOR_0 from a missing shader.
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.061, 0.107, 0.045),
    vertexColors: true,
  });
  material.name = "kz_465c3c";
  const shading = correctSourceMaterial(material);
  assert.equal(shading.fallback, true);
  assert.equal(material.vertexColors, false);
  assert.ok(
    material.color.g > material.color.r && material.color.g > material.color.b,
  );
  // The baked-light atlas carriers and anything with a source material are not fallbacks.
  for (const name of ["kz_465c3c_lit", "kz_wall", "taro"]) {
    const other = new THREE.MeshStandardMaterial({ vertexColors: true });
    other.name = name;
    assert.equal(correctSourceMaterial(other), null, name);
    assert.equal(other.vertexColors, true);
  }
});

test("other shaders and unverified water shaders are left untouched", () => {
  for (const vmat of [
    { ShaderName: "csgo_environment.vfx" },
    { ShaderName: "csgo_environment_blend.vfx" },
    { ShaderName: "csgo_complex.vfx" },
    // Not checked against CS2's compiled shader, so no rule is guessed for it.
    {
      ShaderName: "csgo_water.vfx",
      VectorParams: { g_vWaterFogColor: [0, 0, 1, 1] },
    },
    { ShaderName: "csgo_water_fancy.vfx" }, // no fog colour to use
    undefined,
  ]) {
    const material = imported(vmat, 0x336699);
    assert.equal(correctSourceMaterial(material), null);
    assert.equal(material.vertexColors, true);
    assert.equal(material.color.getHexString(), "336699");
  }
  assert.equal(sourceShadingOf(null), null);
});

test("map adoption applies the correction to the clone only", () => {
  const source = imported(majkaLeaves);
  const cache = createMapMaterials(3);
  const adopted = cache.adopt(source, false, new Set(), new Set());
  assert.equal(adopted.vertexColors, false);
  assert.equal(source.vertexColors, true, "imported material is not mutated");
  assert.equal(adopted.userData.kzSourceShading.shader, "csgo_foliage.vfx");
});
