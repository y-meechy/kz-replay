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
  assert.equal(adopted.flatShading, true);
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
