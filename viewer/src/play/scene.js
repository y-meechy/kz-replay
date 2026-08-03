// A deliberately small three.js renderer for the /play page. Do not reuse
// createPlayer() from ../../src/player.js — that one is built around a replay
// track and dragging it into an interactive game would couple two things that
// should stay apart. Lighting/sky/fog/tone-mapping are copied from it (not
// imported) so the play page still looks like the rest of the viewer.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { findMapFile } from "../mapFile.js";
import {
  VRF_UNITS_PER_EXPORTED_METRE,
  VRF_YAW_CORRECTION,
} from "../vrfExport.js";
import { buildCollisionFromGltf } from "./collision.js";
import { FOV_VERTICAL_DEG } from "./constants.js";
import { sourceToRender } from "./vec.js";

const SKY_ZENITH = "#1d3a5f";
const SKY_HORIZON = "#5d7898";

// A vertical gradient, used as the scene background. Four pixels wide because a
// one pixel texture picks up filtering artefacts at the seam; nothing varies
// along that axis. Mapped equirectangularly, so canvas top becomes the zenith.
const skyTexture = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, SKY_ZENITH);
  gradient.addColorStop(0.62, "#3c5a80");
  gradient.addColorStop(1, SKY_HORIZON);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

// Flat, unpainted concrete — the fallback for any mesh whose imported material
// is not a MeshStandardMaterial we can adopt.
const mapMaterial = new THREE.MeshStandardMaterial({
  color: "#4d5a6e",
  roughness: 1,
  metalness: 0,
  flatShading: true,
  side: THREE.FrontSide,
});

// Free a GLTF scene's geometry, materials and textures. Three only disposes what
// the application explicitly owns, so a cancelled load and a torn-down scene both
// need their own sweep. The shared mapMaterial above is skipped: it outlives any
// one map.
const disposeMapScene = (root) => {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of objectMaterials) {
      if (!material || material === mapMaterial) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
};

// Put an imported material on the same footing as the plain one above: flat shaded
// where there is no texture to give it normals, front faces only, fully rough.
const adoptMapMaterial = (material) => {
  material.side = THREE.FrontSide;
  material.roughness = 1;
  material.metalness = 0;
  material.flatShading = !material.map;
  material.needsUpdate = true;
  return material;
};

export const createPlayScene = ({ canvas }) => {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    alpha: false,
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(SKY_HORIZON, 2500, 9000);

  const sky = new THREE.HemisphereLight("#7ea8d4", "#080d16", 1.9);
  scene.add(sky);
  const sun = new THREE.DirectionalLight("#e8f1ff", 2.3);
  sun.position.set(0.45, 1, 0.3);
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#31527a", 0.7);
  rim.position.set(-0.6, 0.2, -0.5);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(FOV_VERTICAL_DEG, 1, 1, 40000);
  camera.up.set(0, 1, 0);
  scene.add(camera);

  const mapGroup = new THREE.Group();
  mapGroup.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE);
  mapGroup.rotation.y = VRF_YAW_CORRECTION;
  mapGroup.visible = false;
  scene.add(mapGroup);

  let disposed = false;
  let mapLoadGeneration = 0;
  let collision = null;

  const loadMap = async (url) => {
    if (disposed) throw new Error("scene disposed");

    const found = await findMapFile(url);
    if (!found) {
      throw new Error(`Map not converted yet: ${url}`);
    }

    const generation = ++mapLoadGeneration;
    const isCurrent = () => !disposed && generation === mapLoadGeneration;

    const gltf = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(url);

    if (!isCurrent()) {
      disposeMapScene(gltf.scene);
      throw new Error("map load cancelled");
    }

    let triangles = 0;
    const importedLights = [];
    gltf.scene.traverse((object) => {
      if (object.isLight) {
        importedLights.push(object);
        return;
      }
      if (!object.isMesh) return;
      object.material = object.material?.isMeshStandardMaterial
        ? adoptMapMaterial(object.material)
        : mapMaterial;
      object.frustumCulled = true;
      // A mesh with morph targets and no influences to blend them with kills the
      // renderer — see player.js for the full story. Drop any leftover targets.
      if (object.geometry.morphAttributes && !object.morphTargetInfluences) {
        object.geometry.morphAttributes = {};
      }
      const index = object.geometry.getIndex();
      triangles +=
        (index ? index.count : object.geometry.attributes.position.count) / 3;
    });
    for (const light of importedLights) light.removeFromParent();

    // buildCollisionFromGltf() parents gltf.scene under its own throwaway group
    // internally, and THREE's add() reparents rather than copies — so this must
    // run before mapGroup.add(gltf.scene) below, or the map is stolen out of
    // mapGroup and never renders. mapGroup.add() then reparents it right back,
    // and since mapGroup carries the identical scale/rotation, both the
    // collision build and the render see the same transform.
    collision = buildCollisionFromGltf(gltf.scene);

    mapGroup.clear();
    mapGroup.add(gltf.scene);
    mapGroup.visible = true;
    mapGroup.updateMatrixWorld(true);

    return { triangles: Math.round(triangles) };
  };

  // Scratch, reused every call so setView never allocates.
  const eyePosSource = { x: 0, y: 0, z: 0 };
  const eyePosRender = new THREE.Vector3();
  const forwardSource = { x: 0, y: 0, z: 0 };
  const forwardRender = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  const setView = (originSource, eyeHeight, yawDeg, pitchDeg) => {
    eyePosSource.x = originSource.x;
    eyePosSource.y = originSource.y;
    eyePosSource.z = originSource.z + eyeHeight;
    sourceToRender(eyePosRender, eyePosSource);
    camera.position.copy(eyePosRender);
    camera.rotation.set(0, 0, 0);

    const yaw = THREE.MathUtils.degToRad(yawDeg);
    const pitch = THREE.MathUtils.degToRad(pitchDeg);
    forwardSource.x = Math.cos(pitch) * Math.cos(yaw);
    forwardSource.y = Math.cos(pitch) * Math.sin(yaw);
    forwardSource.z = -Math.sin(pitch);
    sourceToRender(forwardRender, forwardSource);

    camera.up.set(0, 1, 0);
    lookTarget.copy(camera.position).add(forwardRender);
    camera.lookAt(lookTarget);
  };

  const resize = () => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const render = () => {
    renderer.render(scene, camera);
  };

  const dispose = () => {
    disposed = true;
    disposeMapScene(mapGroup);
    collision = null;
    renderer.dispose();
  };

  return {
    loadMap,
    get collision() {
      return collision;
    },
    setView,
    render,
    resize,
    dispose,
  };
};
