import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { configureLightmapEncoding } from "../viewer/src/mapLighting.js";
import {
  createScreenSpaceReflections,
  decorateWaterMaterial,
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
  // g_vColorTint is never read by csgo_water_fancy's pixel shader, so it is not carried.
  assert.equal("tint" in surface, false);
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

const compileWith = (material) => {
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
  };
  material.onBeforeCompile(shader, {});
  return shader;
};

test("water keeps its lit material and gains untinted reflections on top", () => {
  const surface = reflectiveSurfaceOf(majkaWater);
  const material = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  decorateWaterMaterial(material, surface, {
    sun: { direction: [0, 2, 0], color: [1, 1, 1] },
  });
  // Same material, same base colour: the "off" surface is the starting point.
  assert.ok(material.isMeshStandardMaterial);
  assert.equal(material.color.getHexString(), "4488ff");
  const shader = compileWith(material);
  const body = shader.fragmentShader;
  // Spliced after the lit surface is final and before ACES/sRGB output.
  assert.ok(
    body.indexOf("kzTrace(kzViewPos") >
      body.indexOf("#include <opaque_fragment>"),
  );
  assert.ok(
    body.indexOf("kzTrace(kzViewPos") <
      body.indexOf("#include <tonemapping_fragment>"),
  );
  assert.match(body, /mix\(kzSurface, kzReflection, kzFresnel\)/);
  assert.doesNotMatch(body, /kzTint/);
  // Shallow water shows its bed through g_vWaterFogColor.
  assert.match(body, /kzSceneColor, kzRefractedUv\)\.rgb \* kzFogColor/);
  // Without baked sun shadows the glint is not gated.
  assert.match(body, /#define KZ_SUN_VISIBILITY 1\.0/);
  // 0.262745 / 0.815686 / 1 picked in sRGB, uploaded linear.
  assert.equal(
    shader.uniforms.kzFogColor.value.getHexString(THREE.SRGBColorSpace),
    "43d0ff",
  );
  assert.equal(shader.uniforms.kzReflectance.value, 0.025);
  assert.equal(shader.uniforms.kzSsrEnabled.value, false);
  assert.deepEqual(
    shader.uniforms.kzWaterSunDirection.value.toArray(),
    [0, 1, 0],
  );
  // Idempotent: a shared adopted material is decorated once.
  const hook = material.onBeforeCompile;
  decorateWaterMaterial(material, surface);
  assert.equal(material.onBeforeCompile, hook);
});

test("the baked lightmap still attaches to decorated water", () => {
  const material = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  decorateWaterMaterial(material, reflectiveSurfaceOf(majkaWater));
  configureLightmapEncoding(material, {
    encoding: "rgbm8-linear",
    range: 54.84375,
    excludeSceneLights: true,
    sun: { direction: [0, 1, 0], color: [1, 1, 1], shadowMask: [1, 0, 0, 0] },
    shadowTexture: new THREE.Texture(),
  });
  const key = material.customProgramCacheKey();
  assert.match(key, /kz-ssr-water/);
  assert.match(key, /kz-hdr-lightmap/);
  const shader = compileWith(material);
  assert.ok(shader.uniforms.kzLightmapRange);
  assert.ok(shader.uniforms.kzSceneColor);
  assert.match(shader.fragmentShader, /kzLightmapRange \* PI/);
  assert.ok(shader.uniforms.kzSunShadows, "baked sun shadows still apply");
  // The sun glint is gated by the same baked shadow the diffuse sun uses.
  assert.match(shader.fragmentShader, /#define KZ_SUN_VISIBILITY kzVisibility/);
  assert.ok(
    shader.fragmentShader.indexOf("float kzVisibility") <
      shader.fragmentShader.indexOf("KZ_SUN_VISIBILITY;"),
  );
  // GLSL rejects a uniform declared twice; both hooks must keep their own names.
  const declared = [
    ...shader.fragmentShader.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    declared.filter((name, i) => declared.indexOf(name) !== i),
    [],
  );
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
  const rockAdopted = rockMaterial.clone();
  assert.equal(ssr.decorate(rock, rockMaterial, rockAdopted), false);
  assert.equal(rockAdopted.userData.kzSsrUniforms, undefined);
  const sourceWater = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  sourceWater.userData = majkaWater;
  plane.material = sourceWater.clone();
  assert.equal(
    ssr.decorate(plane, sourceWater, plane.material, { root: scene }),
    true,
  );
  assert.ok(plane.material.isMeshStandardMaterial);
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
  assert.equal(plane.material.userData.kzSsrUniforms.kzSsrEnabled.value, true);

  camera.lookAt(0, 50, 1000); // facing away from the water
  assert.equal(ssr.update(scene, camera, 0), false);
  assert.equal(rendered.length, 1);

  ssr.retain(() => false);
  assert.equal(ssr.count, 0);
  ssr.dispose();
  assert.equal(ssr.targetSize, null);
});
