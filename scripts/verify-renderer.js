import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  attachBakedLight,
  createMapMaterials,
} from "../viewer/src/mapMaterials.js";
import { createCharacter } from "../viewer/src/character.js";

const status = document.querySelector('[role="status"]');
const checks = [];
const check = (condition, description) => {
  if (!condition) throw new Error(description);
  checks.push(`PASS: ${description}`);
  status.textContent = checks.join("\n");
};

try {
  const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector("canvas"),
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(512, 256);
  const errors = [];
  renderer.debug.onShaderError = (gl, program) => {
    errors.push(gl.getProgramInfoLog(program));
  };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const pixels = () => {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const data = new Uint8Array(512 * 256 * 4);
    gl.readPixels(0, 0, 512, 256, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return data;
  };

  // An asymmetric atlas makes a vertical flip obvious. Load the same PNG through
  // GLTFLoader and TextureLoader, just as the two map formats do in production.
  const atlas = document.createElement("canvas");
  atlas.width = atlas.height = 8;
  const context = atlas.getContext("2d");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 8, 4);
  context.fillStyle = "#0000ff";
  context.fillRect(0, 4, 8, 4);
  const image = atlas.toDataURL();
  const positions = new Float32Array([
    -0.8, -0.8, 0, 0.8, -0.8, 0, -0.8, 0.8, 0, 0.8, 0.8, 0,
  ]);
  const uv = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
  const bytes = new Uint8Array(
    positions.byteLength + uv.byteLength + indices.byteLength,
  );
  bytes.set(new Uint8Array(positions.buffer));
  bytes.set(new Uint8Array(uv.buffer), positions.byteLength);
  bytes.set(
    new Uint8Array(indices.buffer),
    positions.byteLength + uv.byteLength,
  );
  const gltf = await new GLTFLoader().parseAsync(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, TEXCOORD_0: 1 },
              indices: 2,
              material: 0,
            },
          ],
        },
      ],
      buffers: [
        {
          byteLength: bytes.length,
          uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`,
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        {
          buffer: 0,
          byteOffset: positions.byteLength,
          byteLength: uv.byteLength,
        },
        {
          buffer: 0,
          byteOffset: positions.byteLength + uv.byteLength,
          byteLength: indices.byteLength,
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: "VEC3",
          min: [-0.8, -0.8, 0],
          max: [0.8, 0.8, 0],
        },
        { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" },
        { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
      ],
      materials: [
        {
          name: "kz_ffffff_lit",
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        },
      ],
      samplers: [{ wrapS: 33071, wrapT: 33071 }],
      textures: [{ source: 0, sampler: 0 }],
      images: [{ uri: image }],
    }),
    "",
  );
  const mesh = gltf.scene.children[0];
  const cache = createMapMaterials(3);
  mesh.material = cache.adopt(mesh.material, false, new Set(), new Set());
  scene.add(mesh);
  const embedded = pixels();
  mesh.geometry.setAttribute("uv1", mesh.geometry.getAttribute("uv").clone());
  const candidates = new Set();
  mesh.material = cache.adopt(
    new THREE.MeshStandardMaterial(),
    true,
    candidates,
    new Set(),
  );
  const external = await new THREE.TextureLoader().loadAsync(image);
  attachBakedLight(external, candidates, 3);
  const separate = pixels();
  check(
    embedded.every((value, index) => Math.abs(value - separate[index]) <= 1),
    "Embedded UV0 and external UV1 lightmaps render the same pixels",
  );
  const top = (192 * 512 + 256) * 4;
  const bottom = (64 * 512 + 256) * 4;
  check(
    separate[top] > 200 && separate[top + 2] < 20 && separate[bottom + 2] > 200,
    "Atlas orientation is red above blue",
  );

  scene.remove(mesh);
  // Exercise the actual skinned-character path, including normal mapping.
  const geometry = new THREE.SphereGeometry(0.7, 24, 16);
  const count = geometry.attributes.position.count;
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4),
  );
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(weights, 4),
  );
  const normalMap = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
  );
  normalMap.needsUpdate = true;
  const sourceMaterial = new THREE.MeshStandardMaterial({
    color: "#536a84",
    normalMap,
  });
  const body = new THREE.SkinnedMesh(geometry, sourceMaterial);
  const bone = new THREE.Bone();
  body.add(bone);
  body.bind(new THREE.Skeleton([bone]));
  const asset = { scene: new THREE.Group(), animations: [] };
  asset.scene.add(body);
  const runner = createCharacter({ asset });
  runner.object.children[0].scale.setScalar(1);
  runner.object.children[0].rotation.set(0, 0, 0);
  runner.object.position.x = 1;
  scene.add(runner.object);
  const wall = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 24, 16),
    sourceMaterial,
  );
  wall.position.x = -1;
  scene.add(wall);
  let characterMesh;
  runner.object.traverse((child) => {
    if (child.isMesh) characterMesh = child;
  });
  const litMaterial = characterMesh.material;
  const baselineMaterial = sourceMaterial.clone();
  characterMesh.material = baselineMaterial;
  const before = pixels();
  const callsBefore = renderer.info.render.calls;
  const trianglesBefore = renderer.info.render.triangles;
  characterMesh.material = litMaterial;
  const after = pixels();
  let mapUnchanged = true;
  let addedLight = 0;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const offset = (y * 512 + x) * 4;
      for (let c = 0; c < 3; c++) {
        if (x < 256 && before[offset + c] !== after[offset + c])
          mapUnchanged = false;
        if (x >= 256) addedLight += after[offset + c] - before[offset + c];
      }
    }
  }
  check(
    addedLight > 10000,
    "Character fill lights a skinned, normal-mapped mesh with no scene lights",
  );
  check(mapUnchanged, "Character lighting leaves every map pixel unchanged");
  check(
    renderer.info.render.calls === callsBefore &&
      renderer.info.render.triangles === trianglesBefore,
    `Draw calls (${callsBefore}) and triangles (${trianglesBefore}) are unchanged`,
  );
  check(
    errors.length === 0,
    `No shader compilation errors (${errors.join("; ")})`,
  );
  check(
    renderer.getContext().getError() === renderer.getContext().NO_ERROR,
    "No WebGL errors",
  );
  status.textContent +=
    "\n\nAll graphics checks passed. Black map at left; lit character at right.";
} catch (error) {
  status.textContent = [...checks, `FAIL: ${error.stack}`].join("\n");
  console.error(error);
}
