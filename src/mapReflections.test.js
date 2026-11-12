import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createScreenSpaceReflections,
  createWaterMaterial,
  parseReflectionMode,
  reflectiveSurfaceOf,
} from "../viewer/src/mapReflections.js";

// Trimmed from kz_bhop_majka's exported materials/water/watercustomm.vmat.
const majkaWater = {
  vmat: {
    Name: "materials/water/watercustomm.vmat",
    ShaderName: "csgo_water_fancy.vfx",
    IntParams: {
      F_REFLECTION_TYPE: 2,
      g_nSSRMaxForwardSteps: 15,
      g_nWaveIterations: 4,
    },
    FloatParams: {
      g_flReflectance: 0.025,
      g_flFresnelExponent: 5,
      g_flSSRBrightness: 1,
      g_flSSRStepSize: 0.2,
      g_flSSRMaxThickness: 4,
      g_flWaterFogStrength: 0.428,
      g_flWaterMaxDepth: 100,
      g_flSpecularPower: 300,
      g_flWaterInitialDirection: 5.752,
    },
    VectorParams: {
      g_vColorTint: [1, 0, 0, 1],
      g_vWaterFogColor: [0.262745, 0.815686, 1, 1],
    },
  },
};

test("only an explicit ?reflections=on opts in", () => {
  assert.equal(parseReflectionMode("on"), "on");
  assert.equal(parseReflectionMode(" ON "), "on");
  for (const value of [null, undefined, "", "off", "1", "true", "ssr"])
    assert.equal(parseReflectionMode(value), "off");
});

test("majka's water is selected from its source shader and parameters", () => {
  const surface = reflectiveSurfaceOf(majkaWater);
  assert.equal(surface.kind, "water");
  assert.equal(surface.reflectionType, 2);
  assert.equal(surface.reflectance, 0.025);
  assert.equal(surface.fresnelExponent, 5);
  assert.deepEqual(surface.fogColor, [0.262745, 0.815686, 1]);
  assert.equal(surface.maxDepth, 100);
  // The export's red tint is a shader parameter, never the water's colour.
  assert.notDeepEqual(surface.fogColor, [1, 0, 0]);
  assert.deepEqual(surface.sourceSsr, {
    maxForwardSteps: 15,
    stepSize: 0.2,
    maxThickness: 4,
  });
});

test("non-water materials never become reflective, whatever their colour", () => {
  for (const userData of [
    undefined,
    {},
    {
      vmat: {
        ShaderName: "csgo_environment.vfx",
        Name: "materials/water_blue.vmat",
      },
    },
    {
      vmat: {
        ShaderName: "csgo_lightmappedgeneric.vfx",
        IntParams: { F_SPECULAR_INDIRECT: 1 },
      },
    },
    { vmat: { ShaderName: "csgo_waterfall.vfx" } },
    {
      vmat: {
        ShaderName: "csgo_complex.vfx",
        FloatParams: { g_flMetalness: 1 },
      },
    },
  ])
    assert.equal(reflectiveSurfaceOf(userData), null);
  assert.equal(
    reflectiveSurfaceOf({ vmat: { ShaderName: "water.vfx" } }).kind,
    "water",
  );
});

test("out-of-range source parameters are clamped", () => {
  const surface = reflectiveSurfaceOf({
    vmat: {
      ShaderName: "csgo_water.vfx",
      FloatParams: {
        g_flReflectance: 7,
        g_flFresnelExponent: Number.NaN,
        g_flWaterMaxDepth: -3,
      },
    },
  });
  assert.equal(surface.reflectance, 1);
  assert.equal(surface.fresnelExponent, 5);
  assert.equal(surface.maxDepth, 1);
});

test("water material is tone-mapped in the canvas pass and carries the authored values", () => {
  const surface = reflectiveSurfaceOf(majkaWater);
  const material = createWaterMaterial(surface, {
    sun: { direction: [0, 2, 0], color: [1, 1, 1] },
  });
  assert.equal(material.toneMapped, true);
  assert.match(material.fragmentShader, /#include <tonemapping_fragment>/);
  assert.match(material.fragmentShader, /#include <colorspace_fragment>/);
  assert.equal(material.uniforms.kzReflectance.value, 0.025);
  assert.equal(material.uniforms.kzSsrEnabled.value, false);
  assert.deepEqual(material.uniforms.kzSunDirection.value.toArray(), [0, 1, 0]);
  material.dispose();
});

test("the pass adopts only water, skips work off-screen and frees its target", () => {
  const rendered = [];
  let target = null;
  const renderer = {
    getDrawingBufferSize: (v) => v.set(800, 400),
    getRenderTarget: () => target,
    setRenderTarget: (t) => {
      target = t;
    },
    render: () => rendered.push(target),
    autoClear: true,
  };
  const ssr = createScreenSpaceReflections(renderer);
  const scene = new THREE.Scene();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(100, 100));
  const rock = new THREE.Mesh(new THREE.BoxGeometry());
  const rockMaterial = new THREE.MeshStandardMaterial();
  rockMaterial.userData.vmat = { ShaderName: "csgo_environment.vfx" };
  assert.equal(ssr.adopt(rock, rockMaterial), null);
  const sourceWater = new THREE.MeshStandardMaterial();
  sourceWater.userData = majkaWater;
  plane.material = ssr.adopt(plane, sourceWater, { root: scene });
  assert.ok(plane.material.isShaderMaterial);
  assert.equal(ssr.count, 1);

  const camera = new THREE.PerspectiveCamera(60, 2, 1, 1000);
  camera.position.set(0, 50, 200);
  camera.lookAt(0, 0, 0);

  // Not yet attached to a scene: a map still loading must not trigger the pass.
  assert.equal(ssr.update(scene, camera, 0), false);
  scene.add(plane);
  assert.equal(ssr.update(scene, camera, 0), true);
  assert.equal(rendered.length, 1);
  assert.deepEqual(ssr.targetSize, [400, 200]);
  assert.equal(target, null, "canvas target restored");
  assert.equal(plane.visible, true, "water shown again after the pre-pass");
  assert.equal(plane.material.uniforms.kzSsrEnabled.value, true);

  camera.lookAt(0, 50, 1000); // facing away from the water
  assert.equal(ssr.update(scene, camera, 0), false);
  assert.equal(rendered.length, 1);

  ssr.retain(() => false);
  assert.equal(ssr.count, 0);
  ssr.dispose();
  assert.equal(ssr.targetSize, null);
});
