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

// A daylight sky, kept dim on purpose. The run is drawn in bright speed colours
// and the panels over it are dark, so a real midday blue would blow past both.
// These read as sky without becoming the brightest thing on screen.
const SKY_ZENITH = "#1d3a5f";
const SKY_HORIZON = "#5d7898";

/**
 * How strongly a map's own baked lighting counts, against the scene's own lights.
 *
 * Used as lightMapIntensity, so it is a straight multiplier on the light the mapper
 * baked in before it is added to the three lights above. High enough that the real
 * sun and the real shadows are what you notice; low enough that the scene's lights
 * still carry the shape of anything the mapper left dark.
 *
 * Measured rather than eyeballed, against the numbers the scene lights alone were
 * tuned to. See sampleBrightness().
 *
 * Raised from 2.2 when the baked lighting started reaching textured maps. 2.2 was tuned
 * on the build that had no textures, where the light was multiplied into a flat colour
 * factor near white. It now multiplies the mapper's own texture instead, and a real
 * surface reflects about a third of what falls on it, so the same number arrived about a
 * third as bright.
 */
const BAKED_LIGHT_GAIN = 3;

/**
 * How much of the scene's own lighting is left on for a map that brought its own.
 *
 * Not zero: with the invented lights off entirely, anywhere the mapper baked no light
 * goes to pure black, and a black silhouette says nothing about the shape of a wall
 * you are about to jump off. Half of kz_grotto's garden is that dark. Low, though —
 * the point of the baked light is the shadows, and a strong second light source
 * fills them straight back in.
 */
const SCENE_LIGHT_SHARE = 0.4;

/**
 * The name of an imported material that carries baked lighting, not a surface colour.
 *
 * src/trimMap.js names them: one per palette colour, `kz_<lowercase hex>_lit`. A map
 * converted with its real textures instead brings the mapper's own material names
 * through unchanged, and none of those can match this.
 */
const BAKED_LIGHT_MATERIAL_NAME = /^kz_[0-9a-f]{6}_lit$/;

/**
 * A vertical gradient, used as the scene background.
 *
 * Four pixels wide because a one pixel texture picks up filtering artefacts at the
 * seam; nothing varies along that axis. Tall enough that the gradient does not
 * band. Mapped equirectangularly, so canvas top becomes the zenith.
 */
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
 * Shortest way round from one angle to another, in degrees.
 *
 * Yaw is recorded in -180..180 and wraps, so a naive lerp from 179 to -179 sweeps
 * 358 degrees the long way — a full spin in one frame, at exactly the moment a
 * runner is turning hardest. Pitch never wraps in practice, but the same function
 * is correct for it, so both use this.
 */
const lerpDegrees = (from, to, t) => {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return from + delta * t;
};

/**
 * What is actually drawing, as the driver reports it.
 *
 * Worth having because "the replay is choppy" has one cause nothing in this file can
 * fix: a browser with hardware acceleration switched off draws WebGL on the CPU,
 * through SwiftShader, and any scene becomes a slideshow. It shows up in this string
 * and nowhere else — the frame rate alone cannot tell you why it is low.
 */
const gpuName = (renderer) => {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info
    ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
};

const isSoftwareRenderer = (name) =>
  /swiftshader|software|llvmpipe|basic render/i.test(name ?? "");

/**
 * @param canvas    the canvas to render into
 * @param track     decoded .kztrack (see src/track.js)
 * @param onFrame   called every rendered frame with live readouts for the HUD
 */
export const createPlayer = ({ canvas, track, onFrame }) => {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    // A laptop with two graphics chips gives a page the integrated one by default,
    // and that is where most reports of a choppy replay come from. This asks for the
    // real card. It is a hint, not a promise: a browser with hardware acceleration
    // switched off entirely still falls back to software, which gpuName() reports.
    powerPreference: "high-performance",
    // Nothing is ever shown behind the canvas, so an opaque drawing buffer saves a
    // blend when the browser composites the page. Neither is the stencil buffer used.
    alpha: false,
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Without tone mapping, several lights add up past 1.0 and every surface clips
  // to flat white, which looks like a paper cut-out instead of a room.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Measured with sampleBrightness() on kz_victoria in the follow view. 0.85 was set
  // back when the baked lighting never reached a textured map at all, so a surface was
  // lit only by the invented lights and the whole level read flat and much darker than
  // the real one. With the mapper's own sun back, this puts the frame's mean luminance
  // at 0.40 with 0.2% of it blown out and 0.1% near black — a daylight level with the
  // highlights and the shadows both still readable. 1.4 starts clipping the sky.
  renderer.toneMappingExposure = 1.15;

  const gpu = gpuName(renderer);
  if (isSoftwareRenderer(gpu)) {
    console.warn(
      `Hardware acceleration is off in this browser — WebGL is running on the CPU (${gpu}). ` +
        `Playback will be choppy no matter what. In Chrome or Edge: Settings, System, ` +
        `"Use graphics acceleration when available", then restart the browser.`,
    );
  }

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  // The fog has to be the sky's own horizon colour. Anything else and distant
  // geometry fades towards a colour that is not behind it, which reads as a grey
  // veil hanging in front of the sky rather than as distance.
  scene.fog = new THREE.Fog(SKY_HORIZON, 2500, 9000);

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
  // before the run has travelled it. Only worth having when the camera is riding
  // with the player or when two runs are being compared — see showGuides().
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

  /**
   * Whether to draw the two things that point at where the player is and is going:
   * the white ball on them, and the dim outline of the route ahead.
   *
   * Both answer a question you only have while following: which of these lines am I
   * on, and which way next. Watching from orbit, neither is a question — the whole
   * course is on screen — and the pair are just clutter over the map, so they are off
   * unless the camera is riding along or a second run is on screen to be told apart
   * from the first.
   */
  const showGuides = () => cameraMode === "follow" || Boolean(rival);

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
  const sky = new THREE.HemisphereLight("#7ea8d4", "#080d16", 1.9);
  scene.add(sky);
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

  // A map that brought its own baked lighting does not need four invented lights at
  // full strength as well: at full strength they flood the baked shadows and the map
  // ends up as evenly lit as it was before any of this. Turned down, they only lift
  // the corners the mapper left black, so the shape still reads there, and the map's
  // own sun does the rest.
  //
  // Guarded rather than trusted to be called once. It is a multiply, so a second call
  // would take the scene lights to 0.16 of full and quietly darken the whole level —
  // and loadMap() is reachable twice on one player, when a map is converted from the
  // page and then loaded into the player that had already reported it missing.
  let sceneLightsDimmed = false;
  const dimSceneLightsForBakedMap = () => {
    if (sceneLightsDimmed) return;
    sceneLightsDimmed = true;
    for (const light of [sky, sun, rim, headlight]) {
      light.intensity *= SCENE_LIGHT_SHARE;
    }
  };

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

  // Every imported material is put on the same footing as the plain one above:
  // flat shaded so the geometry reads without normals, front faces only so the
  // camera can see into the level, and fully rough so nothing turns into a mirror.
  // Only the colour is the map's own.
  //
  // A material named `kz_…_lit` carries the map's own baked lighting: the sun, the
  // shadows and the darkening in every corner, as the mapper compiled them (see
  // src/mapLightmap.js). It arrives as the base colour texture, because that is the
  // only slot glTF has, and is moved to the light map slot here so it adds to the
  // scene's lights instead of replacing the surface colour.
  //
  // The name is the only way to tell the two apart, and it has to be told apart: a map
  // converted with its real surface textures also arrives with a base colour texture,
  // and that one is the wall's own colour, which belongs exactly where it is. Treating
  // it as a light map would multiply the level by a picture of brickwork.
  //
  // Adding rather than replacing, deliberately. Drawn unlit — colour times baked
  // light and nothing else — a sunlit map looks better than this does, but anywhere
  // the mapper baked no light the surface goes to pure black and the shape stops
  // reading at all. kz_grotto's garden is half that. So the scene's lights stay on to
  // carry the shape, and the baked light puts the map's real sun and shadow on top.
  const adoptedMaterials = new Map();
  // Set the moment the first baked-light material is adopted, so the load below knows
  // to turn the scene's own lights down without walking the materials again.
  let adoptedBakedLight = false;
  // The variants that may be given the map's baked lighting later: the ones drawn on
  // geometry that actually carries the atlas UV.
  const lightMapCandidates = new Set();

  /**
   * @param canBeLit whether the geometry drawing this has the atlas UV (`uv1`).
   *
   * A material is shared between many surfaces, and on most maps not all of them are
   * lightmapped — kz_dojo's baked lighting reaches none of its 205 surfaces, and props
   * never carry the atlas UV anywhere. So the two cases get separate materials, cloned
   * on demand, and only one of them is ever given a light map.
   *
   * Not a nicety. Telling three.js a material has a light map when the geometry has no
   * `uv1` to look it up with throws out of the render loop, and the replay stops dead
   * mid-playback with nothing on screen to say why.
   */
  const adoptMapMaterial = (material, canBeLit) => {
    const key = `${material.uuid}${canBeLit ? ":lit" : ""}`;
    let adopted = adoptedMaterials.get(key);
    if (!adopted) {
      adopted = adoptedMaterials.has(material.uuid)
        ? material.clone()
        : material;
      if (canBeLit) lightMapCandidates.add(adopted);
      adopted.side = THREE.FrontSide;
      adopted.roughness = 1;
      adopted.metalness = 0;
      // A textured surface has real normals worth using; anything else has none and
      // reads as shape only because flat shading derives one per triangle.
      adopted.flatShading = !adopted.map;
      if (adopted.map && BAKED_LIGHT_MATERIAL_NAME.test(adopted.name)) {
        adopted.lightMap = adopted.map;
        // The trim pass leaves the atlas UV as the only texture coordinate set, so
        // it is set zero here, where three.js would default a light map to set one.
        adopted.lightMap.channel = 0;
        adopted.lightMapIntensity = BAKED_LIGHT_GAIN;
        adopted.map = null;
        adoptedBakedLight = true;
      }
      // A map can finish loading long after the camera settled on the orbit view,
      // which is where ghosting is on, so match whatever is already in force.
      adopted.transparent = ghosted === true;
      adopted.opacity = ghosted === true ? 0.35 : 1;
      adopted.depthWrite = ghosted !== true;
      adopted.needsUpdate = true;
      adoptedMaterials.set(key, adopted);
    }
    return adopted;
  };

  /**
   * Swap the invented gradient for the map's real sky, when there is one.
   *
   * Written beside the .glb as `<map>.sky.webp` by src/mapSky.js, because glTF has no
   * slot for a scene background. Equirectangular, which is what the gradient already
   * pretends to be, so nothing but the image changes.
   *
   * Silent on failure on purpose. A map converted before this existed has no sky file,
   * a 404 is the normal answer, and the gradient it falls back to is a perfectly good
   * sky. The dev server answers unknown paths with index.html, so the loader is also
   * the thing that rejects an HTML "hit".
   */
  const loadSky = (mapUrl) => {
    const url = mapUrl.replace(/\.glb(\?.*)?$/, ".sky.webp");
    if (url === mapUrl) return;
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        scene.background?.dispose?.();
        scene.background = texture;
      },
      undefined,
      () => {},
    );
  };

  /**
   * Attach the map's baked lighting to its textured surfaces.
   *
   * A map converted with its real textures cannot carry the lighting atlas inside the
   * .glb: glTF has no light map slot, and the one slot that would do — base colour — is
   * where the mapper's own texture goes. So the atlas is written beside the map as
   * `<map>.light.webp` and paired up here, against the second UV set the trim pass kept
   * for exactly this.
   *
   * Silent on failure, like the sky: a map converted with no lighting, or with the
   * lighting embedded because it had no textures, simply has no file to fetch.
   */
  const loadBakedLight = async (mapUrl) => {
    const url = mapUrl.replace(/\.glb(\?.*)?$/, ".light.webp");
    if (url === mapUrl) return;
    const texture = await new Promise((resolve) => {
      new THREE.TextureLoader().load(url, resolve, undefined, () =>
        resolve(null),
      );
    });
    if (!texture) return;

    texture.colorSpace = THREE.SRGBColorSpace;
    // three.js calls the second UV set `uv1`, which is where a light map looks by
    // default — but only if it is told, because the default channel is 1 and the
    // lightmapped-only build puts the atlas on set 0.
    texture.channel = 1;
    let attached = 0;
    for (const material of lightMapCandidates) {
      if (!material.map || material.lightMap) continue;
      material.lightMap = texture;
      material.lightMapIntensity = BAKED_LIGHT_GAIN;
      material.needsUpdate = true;
      attached += 1;
    }
    if (attached) dimSceneLightsForBakedMap();
  };

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
            // A coloured map arrives with a flat colour per surface, worked out from
            // the material the mapper used. Keep those and only match them to the
            // scene's lighting; a map with none still gets the plain concrete.
            object.material = object.material?.isMeshStandardMaterial
              ? adoptMapMaterial(
                  object.material,
                  object.geometry.hasAttribute("uv1"),
                )
              : mapMaterial;
            object.frustumCulled = true;

            // A mesh with morph targets and no influences to blend them with kills the
            // renderer: three.js takes the morph path for any geometry that has targets,
            // reads an array the loader never created, and throws out of the render loop
            // the first frame that mesh is drawn — which is when the camera happens to
            // turn towards it. src/trimMap.js drops targets now, but every map converted
            // before that still carries them, so they are dropped here too.
            if (
              object.geometry.morphAttributes &&
              !object.morphTargetInfluences
            ) {
              object.geometry.morphAttributes = {};
            }
            const index = object.geometry.getIndex();
            triangles +=
              (index
                ? index.count
                : object.geometry.attributes.position.count) / 3;
          });
          for (const light of importedLights) {
            light.removeFromParent();
          }
          if (adoptedBakedLight) {
            dimSceneLightsForBakedMap();
          }

          // The sky is only a background, so it can arrive whenever it likes.
          loadSky(url);

          // The baked lighting is awaited, and that is the whole point. Adding a light
          // map to a material changes which shader it needs, so attaching it to a map
          // already on screen makes three.js rebuild every one of them in a single
          // frame — 80 programs on kz_dojo — and the replay visibly stops dead a couple
          // of seconds in, exactly when the image finishes downloading. Finish the
          // materials first, then show the map.
          loadBakedLight(url)
            .then(() =>
              // And compile them before the first frame that needs them, rather than
              // when the camera turns and a wall is drawn for the first time. That
              // stall is not new — it is every map's first draw — but real textures
              // made it long enough to feel like a freeze.
              renderer.compileAsync
                ? renderer.compileAsync(gltf.scene, camera, scene)
                : null,
            )
            .catch(() => {})
            .then(() => {
              mapGroup.add(gltf.scene);
              mapGroup.visible = true;
              grid.visible = false;
              // With walls to hide behind, near geometry should not fade out.
              scene.fog = new THREE.Fog(SKY_HORIZON, span * 2, span * 8);
              resolve({ triangles: Math.round(triangles) });
            });
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
  const rivalScratch = new THREE.Vector3();
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

  /**
   * Where the runner is looking, between ticks as well as on them.
   *
   * Interpolated, and that is the single thing that makes playback look smooth. A
   * replay is recorded at 64 ticks a second and drawn at 60 to 144 frames a second,
   * so taking the nearest tick's angle means the view holds still for a frame or two
   * and then jerks — measured on kz_grotto, 47% of frames did not turn at all and
   * the rest turned a median of 6 degrees in one go. At quarter speed it was 86% of
   * frames, about sixteen distinct aims a second, which is what a slowed replay
   * looking like a slideshow actually was. Position was already interpolated, so the
   * world slid while the view snapped, which is the worst of both.
   */
  const viewDirection = (index, target, sourceTrack = track) => {
    const clamped = THREE.MathUtils.clamp(index, 0, sourceTrack.count - 1);
    const low = Math.floor(clamped);
    const high = Math.min(low + 1, sourceTrack.count - 1);
    const t = clamped - low;
    const yaw = THREE.MathUtils.degToRad(
      lerpDegrees(sourceTrack.yaw[low], sourceTrack.yaw[high], t),
    );
    const pitch = THREE.MathUtils.degToRad(
      lerpDegrees(sourceTrack.pitch[low], sourceTrack.pitch[high], t),
    );
    // Source forward, then converted to render space by toWorld.
    const fx = Math.cos(pitch) * Math.cos(yaw);
    const fy = Math.cos(pitch) * Math.sin(yaw);
    const fz = -Math.sin(pitch);
    return target.set(...toWorld(fx, fy, fz));
  };

  /**
   * Eye height, with the crouch spread over the tick it happens on.
   *
   * Standing and ducked eyes are 18 units apart and a bhop run ducks several times a
   * second, so switching between them on a tick boundary is a visible jolt each time.
   */
  const eyeHeightAt = (index, sourceTrack) => {
    const clamped = THREE.MathUtils.clamp(index, 0, sourceTrack.count - 1);
    const low = Math.floor(clamped);
    const high = Math.min(low + 1, sourceTrack.count - 1);
    const heightAt = (i) =>
      (sourceTrack.flags[i] & TRACK_FLAG.DUCKING) !== 0
        ? DUCKED_EYE_HEIGHT
        : EYE_HEIGHT;
    return THREE.MathUtils.lerp(heightAt(low), heightAt(high), clamped - low);
  };

  const durationOf = (sourceTrack) =>
    (sourceTrack.count - 1) / sourceTrack.tickRate;
  const activeTrack = () => (pov === "rival" && rival ? rival.track : track);
  const activeDuration = () => durationOf(activeTrack());
  const indexAtTime = (seconds, sourceTrack) =>
    Math.min(seconds * sourceTrack.tickRate, sourceTrack.count - 1);

  let viewWidth = 0;
  let viewHeight = 0;
  // The canvas is sized by CSS, so the renderer has to be told when that changed.
  // Reading clientWidth is what tells you — but reading it forces the browser to
  // recompute layout, and the HUD writes to the document every frame, so asking
  // inside the render loop meant a full layout recalculation a hundred times a
  // second for an answer that changes when someone drags the window. The observer
  // says when to bother instead.
  let sizeMaybeChanged = true;
  const sizeObserver = new ResizeObserver(() => {
    sizeMaybeChanged = true;
  });
  sizeObserver.observe(canvas);

  const resize = () => {
    if (!sizeMaybeChanged) return;
    sizeMaybeChanged = false;
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
    // A coloured map is drawn with its own materials, so ghosting has to reach all
    // of them, not just the plain one.
    for (const material of [mapMaterial, ...adoptedMaterials.values()]) {
      material.transparent = next;
      material.opacity = next ? 0.35 : 1;
      material.depthWrite = !next;
      material.needsUpdate = true;
    }
  };

  // Rebuilding the projection matrix is only needed when the field of view actually
  // changes, which is on a camera switch, not on every one of a hundred frames.
  const setFov = (value) => {
    if (camera.fov === value) return;
    camera.fov = value;
    camera.updateProjectionMatrix();
  };

  const updateCamera = (seconds) => {
    headlight.visible = cameraMode !== "orbit" && mapGroup.visible;
    setGhosted(cameraMode === "orbit");

    if (cameraMode === "orbit") {
      setFov(60);
      controls.enabled = true;
      controls.update();
      return;
    }

    controls.enabled = false;
    const cameraTrack = activeTrack();
    const index = indexAtTime(seconds, cameraTrack);
    positionAt(index, scratch, cameraTrack);
    viewDirection(index, lookTarget, cameraTrack);
    const eye = eyeHeightAt(index, cameraTrack);

    if (cameraMode === "first-person") {
      setFov(90);
      camera.position.set(scratch.x, scratch.y + eye, scratch.z);
      camera.lookAt(
        scratch.x + lookTarget.x * 100,
        scratch.y + eye + lookTarget.y * 100,
        scratch.z + lookTarget.z * 100,
      );
    } else {
      setFov(70);
      followOffset.copy(lookTarget).multiplyScalar(-150);
      camera.position.set(
        scratch.x + followOffset.x,
        scratch.y + eye + 60,
        scratch.z + followOffset.z,
      );
      camera.lookAt(scratch.x, scratch.y + eye, scratch.z);
    }
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
    marker.visible = showGuides();
    routeOutline.visible = showGuides();

    let rivalIndex = null;
    if (rival) {
      // Interpolated for the same reason the main marker is: the two are watched
      // side by side, and one sliding while the other steps is more obvious than
      // either fault on its own.
      const rivalPosition = indexAtTime(playbackTime, rival.track);
      rivalIndex = Math.round(rivalPosition);
      positionAt(rivalPosition, rivalScratch, rival.track);
      rivalMarker.position.copy(rivalScratch);
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
    /** Escape hatch for one-off alignment and lighting experiments from the console. */
    __internals: {
      THREE,
      scene,
      renderer,
      mapGroup,
      track,
      positionAt,
    },
    /** Numbers for checking map alignment without eyeballing a screenshot. */
    debug: () => {
      const mapBox = new THREE.Box3().setFromObject(mapGroup);
      return {
        gpu,
        softwareRendered: isSoftwareRenderer(gpu),
        pixelRatio: renderer.getPixelRatio(),
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
      sizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        object.material?.dispose?.();
      });
    },
  };
};
