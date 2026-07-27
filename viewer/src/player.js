// The replay player. Framework-free on purpose: it takes a canvas and a decoded
// track and owns everything else. The React wrapper in the website later is just
// a useEffect that calls createPlayer() and dispose() — no three.js in components.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TRACK_FLAG } from "../../src/track.js";

// Source is Z-up and we render Y-up.
const toWorld = (x, y, z) => [x, z, -y];

// Lining up an exported map with a replay path takes exactly two corrections.
//
// 1. Scale. Source2Viewer bakes a 1/39.37 unit conversion into every node matrix
//    (it treats one Source unit as one inch) while leaving the mesh data itself in
//    Source units. Scaling the group by 39.37 cancels that, leaving the map at its
//    true Source size, which is the same space the replay positions live in. Do not
//    "correct" this to 52.4934, the real 0.75-inch conversion: the job is to match
//    the exporter, not reality.
//
// 2. Yaw. The export ends up turned a quarter turn about the up axis relative to
//    the replay's coordinates.
//
// Both numbers were measured, not assumed: probeGround() casts a ray down from the
// player's feet on ticks where the replay says they were standing still. With these
// values the floor is a median of 0 units below the feet. Every other combination
// of scale, axis order and yaw that was tried is off by 150 units or more.
const VRF_UNITS_PER_EXPORTED_METRE = 39.37;
const VRF_YAW_CORRECTION = Math.PI / 2;

// Source units: a player is 72 tall, a standard jump block is 32.
const EYE_HEIGHT = 64;
const DUCKED_EYE_HEIGHT = 46;
const BLOCK = 32;

export const CAMERA_MODES = ["orbit", "follow", "first-person"];

// Slow to fast. Deliberately not a rainbow: cool for walk speed, hot for a run
// that is genuinely moving, so a glance at the line reads as a speed chart.
const SPEED_STOPS = [
  [0.0, new THREE.Color("#1e3a8a")],
  [0.45, new THREE.Color("#22d3ee")],
  [0.7, new THREE.Color("#4ade80")],
  [0.87, new THREE.Color("#fde047")],
  [1.0, new THREE.Color("#fb7185")],
];

const speedColor = (fraction, target) => {
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [stop, color] = SPEED_STOPS[i];
    if (fraction <= stop || i === SPEED_STOPS.length - 1) {
      const [previousStop, previousColor] = SPEED_STOPS[i - 1];
      const t = (fraction - previousStop) / (stop - previousStop);
      return target
        .copy(previousColor)
        .lerp(color, THREE.MathUtils.clamp(t, 0, 1));
    }
  }
  return target.copy(SPEED_STOPS[0][1]);
};

/** Largest recorded speed without turning every tick into a function argument. */
export const maxTrackSpeed = (speeds, floor = 400) => {
  let maximum = floor;
  for (const speed of speeds) {
    if (speed > maximum) maximum = speed;
  }
  return maximum;
};

/** Convert a track to render coordinates in one compact, Three-compatible array. */
export const worldPointsOf = (track) => {
  const points = new Float32Array(track.count * 3);
  for (let i = 0; i < track.count; i++) {
    const offset = i * 3;
    points[offset] = track.positions[offset];
    points[offset + 1] = track.positions[offset + 2];
    points[offset + 2] = -track.positions[offset + 1];
  }
  return points;
};

/**
 * All teleport locations in one instanced mesh, so marker count does not become
 * scene-object and draw-call count on long or heavily segmented runs.
 */
export const createTeleportMarkers = (track) => {
  let count = 0;
  for (let i = 1; i < track.count; i++) {
    if (track.teleports[i] > track.teleports[i - 1]) count += 1;
  }
  if (count === 0) return null;

  const markers = new THREE.InstancedMesh(
    new THREE.SphereGeometry(6, 16, 12),
    new THREE.MeshBasicMaterial({
      color: "#fb923c",
      transparent: true,
      opacity: 0.9,
    }),
    count,
  );
  const matrix = new THREE.Matrix4();
  let instance = 0;
  for (let i = 1; i < track.count; i++) {
    if (track.teleports[i] <= track.teleports[i - 1]) continue;
    const offset = i * 3;
    matrix.makeTranslation(
      track.positions[offset],
      track.positions[offset + 2],
      -track.positions[offset + 1],
    );
    markers.setMatrixAt(instance, matrix);
    instance += 1;
  }
  markers.instanceMatrix.needsUpdate = true;
  markers.computeBoundingBox();
  markers.computeBoundingSphere();
  return markers;
};

/**
 * @param canvas    the canvas to render into
 * @param track     decoded .kztrack (see src/track.js)
 * @param onFrame   called every rendered frame with live readouts for the HUD
 */
export const createPlayer = ({ canvas, track, onFrame }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Without tone mapping, several lights add up past 1.0 and every surface clips
  // to flat white, which looks like a paper cut-out instead of a room.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#07090f");
  scene.fog = new THREE.Fog("#07090f", 2500, 9000);

  // Render-space position of one recorded tick.
  const worldPointAt = (index) =>
    toWorld(
      track.positions[index * 3],
      track.positions[index * 3 + 1],
      track.positions[index * 3 + 2],
    );

  // --- path geometry --------------------------------------------------------
  const points = worldPointsOf(track);
  const colors = new Float32Array(track.count * 3);
  const colorScratch = new THREE.Color();
  const speedCeiling = maxTrackSpeed(track.speed);

  for (let i = 0; i < track.count; i++) {
    speedColor(track.speed[i] / speedCeiling, colorScratch);
    const offset = i * 3;
    colors[offset] = colorScratch.r;
    colors[offset + 1] = colorScratch.g;
    colors[offset + 2] = colorScratch.b;
  }

  const bounds = new THREE.Box3().setFromArray(points);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);

  const resolution = new THREE.Vector2(1, 1);

  // The whole route, dim, drawn up front so the shape of the course is visible
  // before the run has travelled it.
  const routeOutline = new Line2(
    new LineGeometry().setPositions(points),
    new LineMaterial({
      color: "#334155",
      linewidth: 1.4,
      transparent: true,
      opacity: 0.55,
      resolution,
      dashed: false,
    }),
  );
  routeOutline.computeLineDistances();
  scene.add(routeOutline);

  const trailGeometry = new LineGeometry().setPositions(points);
  trailGeometry.setColors(colors);
  const trail = new Line2(
    trailGeometry,
    new LineMaterial({
      linewidth: 3.4,
      vertexColors: true,
      resolution,
      dashed: false,
    }),
  );
  trail.computeLineDistances();
  scene.add(trail);

  // --- markers -------------------------------------------------------------
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(7, 20, 14),
    new THREE.MeshBasicMaterial({ color: "#ffffff" }),
  );
  // No glow sprite: an untextured sprite is a flat square, which reads as a blue
  // box stuck to the player rather than a halo.
  scene.add(marker);

  // --- the run being compared against --------------------------------------
  // A second run shown at the same time, on the same clock: both markers start
  // together, so one visibly pulls ahead. Amber throughout, so it never competes
  // with the speed colours of the main run.
  const RIVAL_COLOUR = "#f59e0b";
  const rivalGroup = new THREE.Group();
  scene.add(rivalGroup);

  const rivalMarker = new THREE.Mesh(
    new THREE.SphereGeometry(7, 20, 14),
    new THREE.MeshBasicMaterial({ color: RIVAL_COLOUR }),
  );
  rivalMarker.visible = false;
  scene.add(rivalMarker);

  let rival = null;
  let pov = "main";

  const setRival = (rivalTrack) => {
    rivalGroup.clear();
    rival = null;
    rivalMarker.visible = false;
    if (!rivalTrack) {
      pov = "main";
      playbackTime = Math.min(playbackTime, activeDuration());
      return;
    }

    const rivalPoints = worldPointsOf(rivalTrack);

    const line = new Line2(
      new LineGeometry().setPositions(rivalPoints),
      new LineMaterial({
        color: RIVAL_COLOUR,
        linewidth: 2.2,
        transparent: true,
        opacity: 0.85,
        resolution,
        dashed: false,
      }),
    );
    line.computeLineDistances();
    rivalGroup.add(line);

    rival = { track: rivalTrack, points: rivalPoints, line };
    rivalMarker.visible = true;
  };

  const setPov = (next) => {
    pov = next === "rival" && rival ? "rival" : "main";
    playbackTime = Math.min(playbackTime, activeDuration());
    return pov;
  };

  const addDot = (color, index, radius) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    mesh.position.set(...worldPointAt(index));
    scene.add(mesh);
  };

  addDot("#4ade80", 0, 10);
  addDot("#f87171", track.count - 1, 10);
  const teleportMarkers = createTeleportMarkers(track);
  if (teleportMarkers) scene.add(teleportMarkers);

  // --- ground reference ----------------------------------------------------
  const gridSize = Math.ceil((span * 1.6) / BLOCK) * BLOCK;
  // One grid cell is one jump block, so the grid doubles as a distance reference.
  const grid = new THREE.GridHelper(
    gridSize,
    gridSize / BLOCK,
    "#3f5978",
    "#1b2534",
  );
  grid.position.set(center.x, bounds.min.y - 8, center.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.85;
  scene.add(grid);

  // --- map geometry (optional) ---------------------------------------------
  // Lights only matter once a map is loaded; the path and markers are unlit.
  const mapGroup = new THREE.Group();
  mapGroup.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE);
  mapGroup.rotation.y = VRF_YAW_CORRECTION;
  mapGroup.visible = false;
  scene.add(mapGroup);

  const hasMapLoaded = () => mapGroup.children.length > 0;

  // Sky above, near black bounce below, so up-facing surfaces read brighter than
  // walls and the level's shape is legible without any textures.
  // These intensities were tuned against sampleBrightness(), not by eye: they put
  // the mean picture luminance around 0.16 in the overview and 0.30 indoors, with
  // effectively no pixels clipped to white.
  scene.add(new THREE.HemisphereLight("#7ea8d4", "#080d16", 1.9));
  const sun = new THREE.DirectionalLight("#e8f1ff", 2.3);
  sun.position.set(0.45, 1, 0.3);
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#31527a", 0.7);
  rim.position.set(-0.6, 0.2, -0.5);
  scene.add(rim);

  // Sky light cannot reach indoors, and KZ maps are full of tunnels and rooms. A
  // light carried by the camera keeps those readable. Only for the inside views:
  // the overview shot is better lit from above, without a flattening front light.
  const headlight = new THREE.DirectionalLight("#cfe3ff", 1.25);
  headlight.position.set(0, 0.35, 1); // camera space: shines forwards
  headlight.visible = false;

  // Flat, unpainted concrete. The map is scenery: it has to read as shape without
  // competing with the speed colours of the run.
  //
  // Front faces only, deliberately. A map is a sealed box, so a double sided
  // material turns it into a bright opaque lump from the outside. Culling back
  // faces lets the camera see straight into the level, which is what makes an
  // overview shot readable.
  const mapMaterial = new THREE.MeshStandardMaterial({
    color: "#4d5a6e",
    roughness: 1,
    metalness: 0,
    flatShading: true,
    side: THREE.FrontSide,
  });

  const loadMap = (url) =>
    new Promise((resolve, reject) => {
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        url,
        (gltf) => {
          let triangles = 0;
          // Maps ship their own lights, and their intensities are in real world
          // units: kz_victoria's sun arrives at intensity 2732, which washes every
          // surface to pure white no matter how the scene's own lights are tuned.
          // We do our own lighting, so the map's lights have to go.
          const importedLights = [];
          gltf.scene.traverse((object) => {
            if (object.isLight) {
              importedLights.push(object);
              return;
            }
            if (!object.isMesh) return;
            object.material = mapMaterial;
            object.frustumCulled = true;
            const index = object.geometry.getIndex();
            triangles +=
              (index
                ? index.count
                : object.geometry.attributes.position.count) / 3;
          });
          for (const light of importedLights) {
            light.removeFromParent();
          }
          mapGroup.add(gltf.scene);
          mapGroup.visible = true;
          grid.visible = false;
          // With walls to hide behind, near geometry should not fade out.
          scene.fog = new THREE.Fog("#07090f", span * 2, span * 8);
          resolve({ triangles: Math.round(triangles) });
        },
        undefined,
        reject,
      );
    });

  // --- cameras -------------------------------------------------------------
  // Where the orbit camera sits: off to one side and above the run, far enough out
  // that the whole path fits. Used on start and whenever orbit is re-selected.
  const orbitEye = new THREE.Vector3(
    center.x + span * 0.7,
    bounds.max.y + span * 0.5,
    center.z + span * 0.7,
  );

  const camera = new THREE.PerspectiveCamera(60, 1, 1, 40000);
  camera.position.copy(orbitEye);

  camera.add(headlight);
  scene.add(camera);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = span * 6;

  let cameraMode = "orbit";

  const followOffset = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  // --- playback state ------------------------------------------------------
  let playing = true;
  let playbackTime = 0;
  let rate = 1;
  let disposed = false;
  let lastTime = performance.now();

  const positionAt = (index, target, sourceTrack = track) => {
    const clamped = THREE.MathUtils.clamp(index, 0, sourceTrack.count - 1);
    const low = Math.floor(clamped);
    const high = Math.min(low + 1, sourceTrack.count - 1);
    const t = clamped - low;
    // axis is the Source axis: 0 = x, 1 = y, 2 = z. Still Source space here —
    // toWorld does the conversion, in its own argument order.
    const between = (axis) =>
      THREE.MathUtils.lerp(
        sourceTrack.positions[low * 3 + axis],
        sourceTrack.positions[high * 3 + axis],
        t,
      );
    return target.set(...toWorld(between(0), between(1), between(2)));
  };

  const viewDirection = (index, target, sourceTrack = track) => {
    const i = Math.round(
      THREE.MathUtils.clamp(index, 0, sourceTrack.count - 1),
    );
    const yaw = THREE.MathUtils.degToRad(sourceTrack.yaw[i]);
    const pitch = THREE.MathUtils.degToRad(sourceTrack.pitch[i]);
    // Source forward, then converted to render space by toWorld.
    const fx = Math.cos(pitch) * Math.cos(yaw);
    const fy = Math.cos(pitch) * Math.sin(yaw);
    const fz = -Math.sin(pitch);
    return target.set(...toWorld(fx, fy, fz));
  };

  const durationOf = (sourceTrack) =>
    (sourceTrack.count - 1) / sourceTrack.tickRate;
  const activeTrack = () => (pov === "rival" && rival ? rival.track : track);
  const activeDuration = () => durationOf(activeTrack());
  const indexAtTime = (seconds, sourceTrack) =>
    Math.min(seconds * sourceTrack.tickRate, sourceTrack.count - 1);

  let viewWidth = 0;
  let viewHeight = 0;

  // Called every frame so the canvas can be resized by CSS alone, but the renderer
  // is only touched when the size actually changed.
  const resize = () => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    if (width === viewWidth && height === viewHeight) return;
    viewWidth = width;
    viewHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    resolution.set(width, height);
  };

  // Caves and indoor maps bury the overview camera inside solid rock. Ghosting the
  // geometry in the orbit view lets the run show through, while the inside cameras
  // keep it solid where you actually want walls to look like walls. Only touched on
  // change: flipping `transparent` rebuilds the shader.
  let ghosted = null;
  const setGhosted = (next) => {
    if (ghosted === next) return;
    ghosted = next;
    mapMaterial.transparent = next;
    mapMaterial.opacity = next ? 0.35 : 1;
    mapMaterial.depthWrite = !next;
    mapMaterial.needsUpdate = true;
  };

  const updateCamera = (seconds) => {
    headlight.visible = cameraMode !== "orbit" && mapGroup.visible;
    setGhosted(cameraMode === "orbit");

    if (cameraMode === "orbit") {
      camera.fov = 60;
      controls.enabled = true;
      controls.update();
      camera.updateProjectionMatrix();
      return;
    }

    controls.enabled = false;
    const cameraTrack = activeTrack();
    const index = indexAtTime(seconds, cameraTrack);
    positionAt(index, scratch, cameraTrack);
    viewDirection(index, lookTarget, cameraTrack);

    const cameraIndex = Math.round(
      THREE.MathUtils.clamp(index, 0, cameraTrack.count - 1),
    );
    const ducked = (cameraTrack.flags[cameraIndex] & TRACK_FLAG.DUCKING) !== 0;
    const eye = ducked ? DUCKED_EYE_HEIGHT : EYE_HEIGHT;

    if (cameraMode === "first-person") {
      camera.fov = 90;
      camera.position.set(scratch.x, scratch.y + eye, scratch.z);
      camera.lookAt(
        scratch.x + lookTarget.x * 100,
        scratch.y + eye + lookTarget.y * 100,
        scratch.z + lookTarget.z * 100,
      );
    } else {
      camera.fov = 70;
      followOffset.copy(lookTarget).multiplyScalar(-150);
      camera.position.set(
        scratch.x + followOffset.x,
        scratch.y + eye + 60,
        scratch.z + followOffset.z,
      );
      camera.lookAt(scratch.x, scratch.y + eye, scratch.z);
    }
    camera.updateProjectionMatrix();
  };

  const setCameraMode = (mode) => {
    cameraMode = CAMERA_MODES.includes(mode) ? mode : "orbit";
    if (cameraMode === "orbit") {
      controls.target.copy(center);
      camera.position.copy(orbitEye);
    }
    return cameraMode;
  };

  const render = () => {
    if (disposed) return;
    const now = performance.now();
    const delta = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;

    if (playing) {
      playbackTime += delta * rate;
      if (playbackTime >= activeDuration()) {
        playbackTime = 0;
      }
    }

    const referencePosition = indexAtTime(playbackTime, track);
    const index = Math.round(referencePosition);
    // Line2 draws one instance per segment, so this reveals the path as it goes.
    trailGeometry.instanceCount = Math.max(1, index);

    positionAt(referencePosition, scratch);
    marker.position.copy(scratch);
    // Held at the finish rather than hidden, so you can see the gap open up.
    marker.material.opacity = playbackTime > durationOf(track) ? 0.35 : 1;
    marker.material.transparent = true;

    let rivalIndex = null;
    if (rival) {
      rivalIndex = Math.round(indexAtTime(playbackTime, rival.track));
      rivalMarker.position.set(
        rival.points[rivalIndex * 3],
        rival.points[rivalIndex * 3 + 1],
        rival.points[rivalIndex * 3 + 2],
      );
      rival.line.geometry.instanceCount = Math.max(1, rivalIndex);
    }

    updateCamera(playbackTime);
    resize();
    renderer.render(scene, camera);

    const hudTrack = activeTrack();
    const hudIndex = Math.round(indexAtTime(playbackTime, hudTrack));

    onFrame?.({
      index,
      rivalIndex,
      referenceTime: index / track.tickRate,
      referenceFinished: playbackTime > durationOf(track),
      rivalFinished: rival ? playbackTime > durationOf(rival.track) : false,
      finished: playbackTime > durationOf(hudTrack),
      gapToRival:
        rivalIndex === null
          ? null
          : Math.round(marker.position.distanceTo(rivalMarker.position)),
      time: hudIndex / hudTrack.tickRate,
      progress: hudIndex / (hudTrack.count - 1),
      speed: hudTrack.speed[hudIndex],
      verticalSpeed: hudTrack.verticalSpeed[hudIndex],
      forward: hudTrack.forward[hudIndex] / 127,
      left: hudTrack.left[hudIndex] / 127,
      onGround: (hudTrack.flags[hudIndex] & TRACK_FLAG.ONGROUND) !== 0,
      ducking: (hudTrack.flags[hudIndex] & TRACK_FLAG.DUCKING) !== 0,
      jumping: (hudTrack.flags[hudIndex] & TRACK_FLAG.JUMPING) !== 0,
      teleports: hudTrack.teleports[hudIndex],
      totalTeleports: hudTrack.teleports[hudTrack.count - 1],
      playing,
      rate,
      cameraMode,
    });

    requestAnimationFrame(render);
  };

  requestAnimationFrame(render);

  return {
    speedCeiling,
    loadMap,
    setRival,
    setPov,
    tickRate: track.tickRate,
    tickCount: track.count,
    /**
     * Alignment check: for ticks where the replay says the player was standing on
     * something, cast a ray down from just above their feet and measure how far it
     * is to the first surface. Correct alignment means almost every one of those
     * ticks finds a floor within a few units. This is the test that a screenshot
     * cannot give you.
     */
    probeGround: (samples = 200) => {
      if (!hasMapLoaded()) return { error: "no map loaded" };
      const raycaster = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      const from = new THREE.Vector3();
      const distances = [];
      let grounded = 0;
      let missed = 0;

      const step = Math.max(1, Math.floor(track.count / samples));
      for (let i = 0; i < track.count; i += step) {
        if ((track.flags[i] & TRACK_FLAG.ONGROUND) === 0) continue;
        grounded += 1;
        positionAt(i, from);
        from.y += 4; // start just above the feet to avoid starting inside the floor
        raycaster.set(from, down);
        raycaster.far = 64;
        const hit = raycaster.intersectObject(mapGroup, true)[0];
        if (hit) {
          distances.push(hit.distance - 4);
        } else {
          missed += 1;
        }
      }

      distances.sort((a, b) => a - b);
      return {
        groundedTicksSampled: grounded,
        foundFloor: distances.length,
        noFloorWithin64Units: missed,
        medianDropToFloor: distances[Math.floor(distances.length / 2)],
        p90DropToFloor: distances[Math.floor(distances.length * 0.9)],
        worstDropToFloor: distances.at(-1),
      };
    },
    /**
     * Measured brightness of the current view. Judging "too bright" or "too dark"
     * from a description is unreliable, so this reads the framebuffer back and
     * returns a luminance histogram. Renders first, because the drawing buffer is
     * only readable in the same tick as the draw.
     */
    sampleBrightness: () => {
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      let sum = 0;
      let blown = 0;
      let dark = 0;
      let count = 0;
      // Every 16th pixel is plenty for a histogram and keeps this instant.
      for (let i = 0; i < pixels.length; i += 64) {
        const lum =
          (0.2126 * pixels[i] +
            0.7152 * pixels[i + 1] +
            0.0722 * pixels[i + 2]) /
          255;
        sum += lum;
        if (lum > 0.9) blown += 1;
        if (lum < 0.06) dark += 1;
        count += 1;
      }
      return {
        cameraMode,
        mean: +(sum / count).toFixed(3),
        shareBlownOut: +(blown / count).toFixed(3),
        shareNearBlack: +(dark / count).toFixed(3),
      };
    },
    /** Escape hatch for one-off alignment experiments from the console. */
    __internals: {
      THREE,
      scene,
      mapGroup,
      track,
      positionAt,
    },
    /** Numbers for checking map alignment without eyeballing a screenshot. */
    debug: () => {
      const mapBox = new THREE.Box3().setFromObject(mapGroup);
      return {
        drawnTriangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        mapVisible: mapGroup.visible,
        mapMeshes: mapGroup.children.length,
        mapBox: mapBox.isEmpty()
          ? null
          : { min: mapBox.min.toArray(), max: mapBox.max.toArray() },
        runBox: { min: bounds.min.toArray(), max: bounds.max.toArray() },
        cameraPosition: camera.position.toArray(),
        cameraFar: camera.far,
        fog: scene.fog && { near: scene.fog.near, far: scene.fog.far },
      };
    },
    setMapVisible: (visible) => {
      mapGroup.visible = visible && hasMapLoaded();
      grid.visible = !mapGroup.visible;
      return mapGroup.visible;
    },
    hasMap: hasMapLoaded,
    play: () => {
      playing = true;
    },
    pause: () => {
      playing = false;
    },
    togglePlay: () => {
      playing = !playing;
      return playing;
    },
    seekToSeconds: (value) => {
      playbackTime = THREE.MathUtils.clamp(value, 0, activeDuration());
    },
    seekToProgress: (fraction) => {
      playbackTime = THREE.MathUtils.clamp(fraction, 0, 1) * activeDuration();
    },
    nudge: (ticks) => {
      playbackTime = THREE.MathUtils.clamp(
        playbackTime + ticks / activeTrack().tickRate,
        0,
        activeDuration(),
      );
    },
    setRate: (value) => {
      rate = value;
    },
    setCameraMode,
    cycleCamera: () =>
      setCameraMode(
        CAMERA_MODES[
          (CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length
        ],
      ),
    dispose: () => {
      disposed = true;
      controls.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        object.material?.dispose?.();
      });
    },
  };
};
