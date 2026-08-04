// A minimal three.js scene for the map guessr mode: one clipped chunk of a map
// on a dark background, orbited by the player, with a route line revealed on
// answer. Framework-free like player.js — a canvas in, a small API out.

import * as THREE from "three";
import { createOrbit } from "./orbit.js";

// No sky, no fog: the guessr chunk is deliberately ambiguous about indoors vs
// outdoors, and a sky texture behind it would say "outdoor map" before the
// player has looked at a single wall.
const BACKGROUND = "#07090f";

export const createGuessrScene = ({ canvas }) => {
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);

  const camera = new THREE.PerspectiveCamera(60, 1, 1, 20000);

  const sky = new THREE.HemisphereLight("#8fa9c8", "#0b0f18", 1.5);
  scene.add(sky);
  const sun = new THREE.DirectionalLight("#ffffff", 1.7);
  sun.position.set(0.5, 1, 0.35);
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#5b7ba8", 0.6);
  rim.position.set(-0.6, 0.25, -0.5);
  scene.add(rim);

  // Shared across every chunk: box-clipping a solid exposes the interior faces
  // of whatever it cut through, and a front-only material would render those
  // as holes straight through the geometry. DoubleSide keeps the cut chunk
  // looking solid from any angle.
  const chunkMaterial = new THREE.MeshStandardMaterial({
    color: "#9aa3ae",
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  let chunkMesh = null;
  let chunkEdges = null;
  let routeLine = null;
  let chunkSize = 1;

  // The chunk is always built centred on the origin, so the orbit target and the
  // distance limits only ever depend on how big the current chunk is.
  const makeOrbit = () =>
    createOrbit({
      camera,
      element: canvas,
      target: new THREE.Vector3(0, 0, 0),
      distance: chunkSize * 1.25,
      minDistance: chunkSize * 0.35,
      maxDistance: chunkSize * 4,
    });

  let orbit = makeOrbit();

  const positionGeometry = (positions) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    return geometry;
  };

  const disposeChunk = () => {
    if (chunkMesh) {
      scene.remove(chunkMesh);
      chunkMesh.geometry.dispose();
      chunkMesh = null;
    }
    if (chunkEdges) {
      scene.remove(chunkEdges);
      chunkEdges.geometry.dispose();
      chunkEdges.material.dispose();
      chunkEdges = null;
    }
  };

  const disposeRoute = () => {
    if (routeLine) {
      scene.remove(routeLine);
      routeLine.geometry.dispose();
      routeLine.material.dispose();
      routeLine = null;
    }
  };

  const resetCamera = () => {
    orbit.reset({
      target: new THREE.Vector3(0, 0, 0),
      distance: chunkSize * 1.25,
      yaw: Math.PI * 0.25,
      pitch: 0.5,
    });
  };

  const setChunk = ({ positions, size }) => {
    disposeChunk();
    disposeRoute();
    chunkSize = size;

    const geometry = positionGeometry(positions);
    // Non-indexed + flatShading gives each triangle its own normal, which is
    // what makes a cut chunk read as crisp cut faces rather than smeared ones.
    geometry.computeVertexNormals();
    chunkMesh = new THREE.Mesh(geometry, chunkMaterial);
    scene.add(chunkMesh);

    // The clipping box's own edges, drawn dim on top. Without them a cut face
    // just looks like broken geometry; with them it reads as a deliberate cube
    // sample cut out of the map.
    const box = new THREE.BoxGeometry(size, size, size);
    chunkEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({
        color: "#3b4756",
        transparent: true,
        opacity: 0.45,
      }),
    );
    // EdgesGeometry copies what it needs, so the box itself is scratch work.
    box.dispose();
    scene.add(chunkEdges);

    orbit.dispose();
    orbit = makeOrbit();

    resetCamera();
  };

  const showRoute = (routePositions) => {
    disposeRoute();
    routeLine = new THREE.LineSegments(
      positionGeometry(routePositions),
      new THREE.LineBasicMaterial({ color: "#22d3ee" }),
    );
    scene.add(routeLine);
  };

  // --- sizing ----------------------------------------------------------------
  const resize = () => {
    const sizedTo = canvas.parentElement ?? canvas;
    const width = sizedTo.clientWidth;
    const height = sizedTo.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const observer = new ResizeObserver(resize);
  if (canvas.parentElement) observer.observe(canvas.parentElement);
  resize();

  // --- render loop -------------------------------------------------------
  let running = true;
  let paused = false;
  let lastTime = performance.now();

  const tick = (now) => {
    if (!running || paused) return;
    const delta = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    orbit.update(delta);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // The scene stays alive while the player browses other pages (rebuilding a
  // WebGL context per visit is worse), but a hidden page should not keep
  // burning GPU frames — the game page pauses it on hide.
  const setPaused = (value) => {
    if (paused === value) return;
    paused = value;
    if (!paused) {
      lastTime = performance.now();
      requestAnimationFrame(tick);
    }
  };

  const dispose = () => {
    running = false;
    observer.disconnect();
    disposeChunk();
    disposeRoute();
    chunkMaterial.dispose();
    orbit.dispose();
    renderer.dispose();
  };

  return { setChunk, showRoute, resetCamera, setPaused, dispose };
};
