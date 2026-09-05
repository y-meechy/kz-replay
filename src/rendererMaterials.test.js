import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  attachBakedLight,
  createMapMaterials,
} from "../viewer/src/mapMaterials.js";
import { createCharacter } from "../viewer/src/character.js";

for (const order of [
  [true, false],
  [false, true],
]) {
  test(`shared material stays isolated when UV1 flags are ${order}`, () => {
    const source = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const cache = createMapMaterials(3);
    const candidates = new Set();
    const owned = new Set();
    const byUv = new Map(
      order.map((hasUv) => [
        hasUv,
        cache.adopt(source, hasUv, candidates, owned),
      ]),
    );
    const atlas = new THREE.Texture();

    assert.equal(attachBakedLight(atlas, candidates, 3), 1);
    assert.notEqual(byUv.get(true), byUv.get(false));
    assert.equal(byUv.get(true).lightMap, atlas);
    assert.equal(byUv.get(false).lightMap, null);
    assert.equal(source.lightMap, null);
    assert.equal(owned.size, 2);
    assert.equal(cache.adopt(source, true, candidates, owned), byUv.get(true));
    assert.equal(
      cache.adopt(source, false, candidates, owned),
      byUv.get(false),
    );
    assert.equal(owned.size, 2);

    cache.release(owned);
    const replacement = cache.adopt(source, true, new Set(), new Set());
    assert.notEqual(replacement, byUv.get(true));
    assert.equal(replacement.lightMap, null);
  });
}

test("a colour fallback gets baked light only when it has atlas UVs", () => {
  const cache = createMapMaterials(3);
  const source = new THREE.MeshStandardMaterial({ color: "#475868" });
  const candidates = new Set();
  const owned = new Set();
  const lit = cache.adopt(source, true, candidates, owned);
  const unlit = cache.adopt(source, false, candidates, owned);
  const atlas = new THREE.Texture();

  assert.equal(attachBakedLight(atlas, candidates, 3), 1);
  assert.equal(lit.map, null);
  assert.equal(lit.lightMap, atlas);
  assert.equal(lit.lightMapIntensity, 3);
  assert(lit.color.equals(source.color));
  assert.equal(unlit.lightMap, null);
  assert.equal(atlas.flipY, false);
  assert.equal(atlas.channel, 1);
  assert.equal(atlas.colorSpace, THREE.SRGBColorSpace);
  assert.equal(atlas.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(atlas.wrapT, THREE.ClampToEdgeWrapping);
});

test("an embedded UV0 atlas survives adoption and an external atlas", () => {
  const embedded = new THREE.Texture();
  embedded.flipY = false;
  const source = new THREE.MeshStandardMaterial({ map: embedded });
  source.name = "kz_475868_lit";
  const cache = createMapMaterials(3);
  const candidates = new Set();
  const adopted = cache.adopt(source, true, candidates, new Set());

  assert.equal(adopted.map, null);
  assert.equal(adopted.lightMap, embedded);
  assert.equal(adopted.lightMap.channel, 0);
  assert.equal(adopted.flatShading, source.flatShading);
  assert.equal(source.map, embedded);
  assert.equal(source.lightMap, null);
  assert.equal(attachBakedLight(new THREE.Texture(), candidates, 3), 0);
  assert.equal(adopted.lightMap, embedded);
});

test("only character materials receive the extra lighting shader", () => {
  const source = new THREE.MeshStandardMaterial();
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
  const runner = createCharacter({ asset: { scene, animations: [] } });
  let material;
  runner.object.traverse((child) => {
    if (child.isMesh) material = child.material;
  });
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader);

  assert.notEqual(material, source);
  assert.equal(material.customProgramCacheKey(), "kz-character-lighting-v1");
  assert(shader.uniforms.kzSkyColor.value.isColor);
  assert(shader.fragmentShader.includes("irradiance += mix( kzGroundColor"));
  assert(shader.fragmentShader.includes("RE_Direct( kzLight"));
  const mapShader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  source.onBeforeCompile(mapShader);
  assert.equal(
    mapShader.fragmentShader,
    THREE.ShaderLib.standard.fragmentShader,
  );
  assert.deepEqual(mapShader.uniforms, {});
  runner.dispose();
});

test("map adoption preserves authored PBR, alpha, sidedness and normal handling", () => {
  const source = new THREE.MeshPhysicalMaterial({
    color: "#bc3412",
    roughness: 0.24,
    metalness: 0.8,
    side: THREE.DoubleSide,
    flatShading: false,
    normalMap: new THREE.Texture(),
    roughnessMap: new THREE.Texture(),
    metalnessMap: new THREE.Texture(),
    emissive: "#123456",
    emissiveIntensity: 2,
    transparent: true,
    opacity: 0.65,
    alphaTest: 0.4,
    clearcoat: 0.7,
  });
  source.normalScale.set(0.4, -0.8);
  const adopted = createMapMaterials(1).adopt(
    source,
    false,
    new Set(),
    new Set(),
  );
  assert(adopted.isMeshPhysicalMaterial);
  for (const property of [
    "roughness",
    "metalness",
    "side",
    "flatShading",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "emissiveIntensity",
    "transparent",
    "opacity",
    "alphaTest",
    "clearcoat",
  ])
    assert.equal(adopted[property], source[property], property);
  assert(adopted.color.equals(source.color));
  assert(adopted.emissive.equals(source.emissive));
  assert(adopted.normalScale.equals(source.normalScale));
});

test("RGBM lightmap remains linear and changes only baked-light shader sampling", () => {
  const source = new THREE.MeshStandardMaterial({
    normalMap: new THREE.Texture(),
  });
  const candidates = new Set();
  const adopted = createMapMaterials(1).adopt(
    source,
    true,
    candidates,
    new Set(),
  );
  const atlas = new THREE.Texture();
  assert.equal(
    attachBakedLight(atlas, candidates, 1, {
      encoding: "rgbm8-linear",
      range: 32,
      excludeSceneLights: true,
    }),
    1,
  );
  assert.equal(atlas.colorSpace, THREE.NoColorSpace);
  assert.equal(adopted.normalMap, source.normalMap);
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  adopted.onBeforeCompile(shader);
  assert.equal(shader.uniforms.kzLightmapRange.value, 32);
  assert(shader.fragmentShader.includes("uniform float kzLightmapRange;"));
  assert(
    shader.fragmentShader.includes(
      "lightMapTexel.rgb * lightMapTexel.a * kzLightmapRange",
    ),
  );
  assert(
    shader.fragmentShader.includes(
      "reflectedLight.directDiffuse = vec3( 0.0 );",
    ),
  );
  assert(shader.fragmentShader.includes("#include <normal_fragment_maps>"));
  assert(shader.fragmentShader.includes("#include <lights_fragment_end>"));
  assert(shader.fragmentShader.includes("#include <tonemapping_fragment>"));
  assert.equal(adopted.flatShading, false);
  assert.equal(source.lightMap, null);
});

test("unknown HDR encodings and malformed ranges fail before mutating textures", () => {
  for (const descriptor of [
    { encoding: "rgbm8-linear", range: 0 },
    { encoding: "rgbm8-linear", range: NaN },
    { encoding: "rgbm8-linear", range: Infinity },
    { encoding: "invented" },
  ]) {
    const atlas = new THREE.Texture();
    assert.throws(() => attachBakedLight(atlas, new Set(), 1, descriptor));
    assert.equal(atlas.flipY, true);
  }
});
