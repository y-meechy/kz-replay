// A first-person viewmodel: two gloved hands and a butterfly knife that never
// stops flipping, drawn over the run.
//
// Why a second scene instead of parenting to the world camera: the run happens at
// Source scale, where a knife is about 13 units long and the walls are metres
// away, so anything held in front of the eye clips straight through the map. The
// viewmodel gets its own scene, its own camera and its own lighting, rendered as
// an overlay after the world with the depth buffer cleared. That is how the game
// does it, and it also means this file can work in comfortable units: everything
// below is centimetres.
//
// The knife is a real balisong linkage rather than a spinning prop. One handle is
// held in the fist; the blade swings on a pivot at the top of it; the free handle
// swings relative to the blade, mirroring its movement on the far side. That
// single constraint, plus a springy lag on the free handle, is what makes the
// flips read as a butterfly knife and not as a stick going round.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const PI = Math.PI;

// --- easing -----------------------------------------------------------------

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
// Nearly all of the movement in the first third, then a long tail. This is what a
// flick looks like: the knife is already there before you saw it leave.
const snap = (t) => 1 - Math.pow(1 - t, 5);

const EASES = { smooth: smoother, snap };

/**
 * Sample a keyframe track at a time.
 *
 * A key is [time, value, ease]. The ease named on a key governs the segment that
 * arrives at it, which is the way it reads when writing the timeline: "get to the
 * open position, and snap when you do".
 */
const sample = (keys, t) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [time, value, ease] = keys[i];
    if (t > time) continue;
    const [previousTime, previousValue] = keys[i - 1];
    const span = time - previousTime;
    if (span <= 0) return value;
    const eased = (EASES[ease] ?? smoother)((t - previousTime) / span);
    return previousValue + (value - previousValue) * eased;
  }
  return keys[keys.length - 1][1];
};

// --- the inspect variants ----------------------------------------------------

// One completed inspect selects the next family. Equal durations make the cycle
// deterministic and keep seeking useful: the full three-variant reel is 10.8s.
const INSPECT_SECONDS = 3.6;

// `swing` is the blade angle at its pivot; `flip` rotates the complete knife
// around that pivot. Tracks may accumulate whole turns, but every variant begins
// and ends with the knife visibly open. Small counter-motions before the action
// and quiet holds afterwards supply the anticipation and settle of CS2 inspects.
const INSPECT_VARIANTS = [
  {
    // Family 1: forward/back handle flicks. No whole-knife thumb rotation.
    swing: [
      [0.0, 0],
      [0.34, 0],
      [0.48, 0.1, "smooth"], // draw back before the first flick
      [0.76, -PI, "snap"],
      [1.08, 0, "snap"],
      [1.42, 0],
      [1.56, 0.08, "smooth"], // a smaller anticipation for the repeat
      [1.82, -PI, "snap"],
      [2.14, 0, "snap"],
      [2.46, 0, "smooth"], // settle open
      [INSPECT_SECONDS, 0],
    ],
    flip: [
      [0.0, 0],
      [INSPECT_SECONDS, 0],
    ],
    knifeRoll: [
      [0.0, 0],
      [0.76, -0.08, "smooth"],
      [1.2, 0, "smooth"],
      [1.82, 0.06, "smooth"],
      [2.46, 0, "smooth"],
      [INSPECT_SECONDS, 0],
    ],
  },
  {
    // Family 2: exactly two rotations around the thumb, with the linkage open.
    swing: [
      [0.0, 0],
      [INSPECT_SECONDS, 0],
    ],
    flip: [
      [0.0, 0],
      [0.42, 0],
      [0.58, 0.12, "smooth"], // wind up against the direction of travel
      [2.48, -4 * PI, "smooth"], // two complete thumb rotations
      [2.82, -4 * PI, "smooth"],
      [INSPECT_SECONDS, -4 * PI],
    ],
    knifeRoll: [
      [0.0, 0],
      [0.58, 0],
      [1.48, 0.16, "smooth"],
      [2.48, 0, "smooth"],
      [INSPECT_SECONDS, 0],
    ],
  },
  {
    // Family 3: one forward handle flick, then one rotation around the thumb.
    swing: [
      [0.0, 0],
      [0.4, 0],
      [0.54, 0.1, "smooth"], // cock the handle before the forward flick
      [0.82, -PI, "snap"],
      [1.14, -2 * PI, "snap"], // follow through to the equivalent open pose
      [INSPECT_SECONDS, -2 * PI],
    ],
    flip: [
      [0.0, 0],
      [1.28, 0],
      [1.42, 0.09, "smooth"], // thumb catches before the rotation
      [2.58, -2 * PI, "smooth"], // one complete thumb rotation
      [2.9, -2 * PI, "smooth"],
      [INSPECT_SECONDS, -2 * PI],
    ],
    knifeRoll: [
      [0.0, 0],
      [1.28, 0],
      [1.92, -0.13, "smooth"],
      [2.74, 0, "smooth"],
      [INSPECT_SECONDS, 0],
    ],
  },
];

const INSPECT_REEL_SECONDS = INSPECT_SECONDS * INSPECT_VARIANTS.length;

// --- geometry helpers --------------------------------------------------------

const roundedRect = (width, height, radius) => {
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
};

/** A box with every edge softened, centred on the origin. */
const roundedBox = (width, height, depth, radius, bevel = 0.22) =>
  new THREE.ExtrudeGeometry(roundedRect(width, height, radius), {
    depth: Math.max(0.01, depth - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  }).translate(0, 0, -(depth / 2 - bevel));

// --- the knife ---------------------------------------------------------------

// A clip-point balisong blade, drawn in the plane it is cut from: +y runs to the
// tip, +x is the spine, -x is the edge, and the pivot is the origin.
const bladeProfile = () => {
  const shape = new THREE.Shape();
  shape.moveTo(-0.95, -2.6);
  shape.lineTo(0.95, -2.6);
  shape.lineTo(1.05, 0.3);
  shape.lineTo(1.0, 1.6);
  shape.lineTo(0.98, 8.4);
  shape.quadraticCurveTo(0.92, 11.0, 0.44, 12.3); // the clip
  shape.quadraticCurveTo(0.24, 12.95, 0.0, 13.2); // the tip
  shape.quadraticCurveTo(-0.58, 11.5, -0.87, 8.6); // the belly
  shape.lineTo(-1.0, 2.2);
  shape.lineTo(-0.95, 1.4);
  shape.closePath();
  return shape;
};

// A Fade, because if a butterfly knife is going to spin forever it may as well be
// the one everybody pictures. Painted per vertex along the blade, so the steel of
// the tang and the ricasso stays steel.
const FADE_STOPS = [
  [1.6, new THREE.Color("#f2f5f8")],
  [3.2, new THREE.Color("#ffc94d")],
  [6.4, new THREE.Color("#ff5ea0")],
  [9.6, new THREE.Color("#c05ce0")],
  [13.2, new THREE.Color("#6d5cf0")],
];

const fadeAt = (y, target) => {
  for (let s = 1; s < FADE_STOPS.length; s++) {
    const [stop, value] = FADE_STOPS[s];
    const [previousStop, previousValue] = FADE_STOPS[s - 1];
    if (y > stop && s < FADE_STOPS.length - 1) continue;
    const t = THREE.MathUtils.clamp(
      (y - previousStop) / (stop - previousStop),
      0,
      1,
    );
    return target.copy(previousValue).lerp(value, t);
  }
  return target.copy(FADE_STOPS[0][1]);
};

const paintFade = (geometry) => {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    fadeAt(position.getY(i), colour);
    colors[i * 3] = colour.r;
    colors[i * 3 + 1] = colour.g;
    colors[i * 3 + 2] = colour.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
};

/**
 * The balisong, as a linkage.
 *
 * root → handleB (in the fist) → pivot → bladeGroup → handleAGroup
 *
 * The blade's angle at the pivot is the whole animation: 0 is the knife open with
 * the blade in line with the held handle, π is it folded shut alongside it.
 * handleA is parented to the blade, so giving it the same angle *locally* puts
 * the free handle at twice the blade angle in pivot space. The blade therefore
 * stays halfway between the two handles as they move. Feeding that local angle a
 * lagged copy of the blade's angle makes the free handle chase it round and slap
 * home late, which is the whole look.
 */
const buildKnife = (materials) => {
  const root = new THREE.Group();
  const pinGeometry = new THREE.CylinderGeometry(0.36, 0.36, 1.15, 12);

  const HANDLE_LENGTH = 12.4;
  const HANDLE_WIDTH = 1.75;
  const HANDLE_THICKNESS = 0.82;

  const handleGeometry = roundedBox(
    HANDLE_WIDTH,
    HANDLE_LENGTH,
    HANDLE_THICKNESS,
    0.55,
    0.16,
  );
  const inlayGeometry = roundedBox(
    HANDLE_WIDTH - 0.7,
    HANDLE_LENGTH - 2.6,
    0.16,
    0.3,
    0.06,
  );

  // A handle hangs downwards from the pivot, so its body sits at -y.
  const makeHandle = (side) => {
    const group = new THREE.Group();
    const body = new THREE.Mesh(handleGeometry, materials.handle);
    body.position.y = -HANDLE_LENGTH / 2;
    group.add(body);

    const inlay = new THREE.Mesh(inlayGeometry, materials.inlay);
    inlay.position.set(0, -HANDLE_LENGTH / 2, (side * HANDLE_THICKNESS) / 2);
    group.add(inlay);

    // The pin the handle turns on, and the screw at the far end.
    const pin = new THREE.Mesh(pinGeometry, materials.steel);
    pin.rotation.x = PI / 2;
    group.add(pin);

    const butt = new THREE.Mesh(pinGeometry, materials.steel);
    butt.rotation.x = PI / 2;
    butt.position.y = -HANDLE_LENGTH + 1.1;
    group.add(butt);
    return group;
  };

  // The held handle. Its pivot end is up, at the top of the fist.
  const handleB = makeHandle(-1);
  handleB.position.y = HANDLE_LENGTH;
  root.add(handleB);

  // Everything past the pivot.
  const pivot = new THREE.Group();
  pivot.position.y = HANDLE_LENGTH;
  root.add(pivot);

  const bladeGroup = new THREE.Group();
  pivot.add(bladeGroup);

  const bladeGeometry = new THREE.ExtrudeGeometry(bladeProfile(), {
    depth: 0.3,
    bevelEnabled: true,
    bevelThickness: 0.13,
    bevelSize: 0.13,
    bevelSegments: 2,
    curveSegments: 16,
  }).translate(0, 0, -0.28);
  paintFade(bladeGeometry);
  bladeGroup.add(new THREE.Mesh(bladeGeometry, materials.blade));

  // The latch, on the free handle, which is what makes a balisong a balisong.
  const handleA = makeHandle(1);
  const latch = new THREE.Mesh(
    roundedBox(HANDLE_WIDTH + 0.35, 2.4, 0.34, 0.4, 0.1),
    materials.steel,
  );
  latch.position.set(0, -HANDLE_LENGTH + 1.0, 0.62);
  handleA.add(latch);
  bladeGroup.add(handleA);

  return {
    root,
    setAngles: (bladeAngle, freeHandleLocalAngle) => {
      bladeGroup.rotation.z = bladeAngle;
      handleA.rotation.z = freeHandleLocalAngle;
    },
  };
};

// --- the hand ----------------------------------------------------------------

/**
 * A gloved hand, built around the thing it is holding.
 *
 * The knife's handle runs up the hand's +y and the palm is the slab at -x. A
 * simple silhouette keeps the hand from competing visually with the knife.
 */
const buildHand = (materials, mirror) => {
  const hand = new THREE.Group();
  const flip = mirror ? -1 : 1;

  const palm = new THREE.Mesh(roundedBox(3.6, 7.4, 4.6, 1.3), materials.glove);
  palm.position.set(-2.5, -0.4, 0);
  hand.add(palm);

  // The pad across the back of the hand, in the lighter panel colour, so the
  // glove reads as a glove and not as a mitten.
  const back = new THREE.Mesh(roundedBox(1.6, 6.6, 3.9, 0.7), materials.panel);
  back.position.set(-1.0, -0.2, 1.5 * flip);
  hand.add(back);

  // Wrist: the glove cuff, then the sleeve running back out of frame.
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(3.05, 2.75, 3.4, 18, 1, true),
    materials.cuff,
  );
  cuff.position.set(-1.6, -5.6, 0);
  hand.add(cuff);

  const strap = new THREE.Mesh(
    new THREE.TorusGeometry(2.95, 0.34, 8, 20),
    materials.panel,
  );
  strap.rotation.x = PI / 2;
  strap.position.set(-1.6, -6.9, 0);
  hand.add(strap);

  const sleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(2.9, 4.1, 26, 18, 1, false),
    materials.sleeve,
  );
  sleeve.position.set(-1.6, -19.5, 0);
  hand.add(sleeve);

  return hand;
};

// --- materials ---------------------------------------------------------------

const buildMaterials = () => {
  const materials = {
    blade: new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 1,
      roughness: 0.17,
      envMapIntensity: 1.5,
    }),
    steel: new THREE.MeshStandardMaterial({
      color: "#b9c2cd",
      metalness: 1,
      roughness: 0.3,
      envMapIntensity: 1.2,
    }),
    handle: new THREE.MeshStandardMaterial({
      color: "#2b3140",
      metalness: 0.9,
      roughness: 0.36,
      envMapIntensity: 1.1,
    }),
    inlay: new THREE.MeshStandardMaterial({
      color: "#6d7a91",
      metalness: 0.95,
      roughness: 0.22,
    }),
    glove: new THREE.MeshStandardMaterial({
      color: "#23252c",
      metalness: 0.05,
      roughness: 0.82,
    }),
    panel: new THREE.MeshStandardMaterial({
      color: "#33373f",
      metalness: 0.1,
      roughness: 0.68,
    }),
    cuff: new THREE.MeshStandardMaterial({
      color: "#3d424c",
      metalness: 0.05,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    sleeve: new THREE.MeshStandardMaterial({
      color: "#2f3742",
      metalness: 0.02,
      roughness: 0.95,
    }),
  };
  return materials;
};

// --- the viewmodel -----------------------------------------------------------

/**
 * @param renderer  the same WebGLRenderer the world is drawn with; needed to
 *                  prebake the reflections, without which polished metal is black
 */
export const createViewmodel = (renderer) => {
  const scene = new THREE.Scene();
  scene.background = null;

  // The desktop viewmodel uses its own 62 degree field of view regardless of the
  // world camera. resize() widens that only for narrow canvases, where a fixed
  // vertical FOV would crop almost all of the horizontal knife composition.
  const BASE_VERTICAL_FOV = 62;
  const REFERENCE_ASPECT = 16 / 10;
  const MAX_VERTICAL_FOV = 118;
  const referenceHalfWidth =
    Math.tan(THREE.MathUtils.degToRad(BASE_VERTICAL_FOV / 2)) *
    REFERENCE_ASPECT;
  const camera = new THREE.PerspectiveCamera(BASE_VERTICAL_FOV, 1, 0.5, 400);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment();
  const environment = pmrem.fromScene(roomEnvironment, 0.04);
  roomEnvironment.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.55;

  const key = new THREE.DirectionalLight("#eaf2ff", 2.4);
  key.position.set(0.5, 0.9, 1.1);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#5d7ba8", 0.9);
  fill.position.set(-1.1, -0.2, 0.5);
  scene.add(fill);
  // From behind, to put a line of light down the spine of the blade.
  const rim = new THREE.DirectionalLight("#cfe0ff", 1.8);
  rim.position.set(-0.3, 0.6, -1);
  scene.add(rim);

  const materials = buildMaterials();

  // View space, so bob and sway can be written as "up" and "right".
  const root = new THREE.Group();
  scene.add(root);

  // Where the hands stay in view space. These two lines are the framing of the
  // shot: the fist sits in the bottom corner and the blade reaches about halfway
  // up. Runner bob and sway move their shared root, never either hand separately.
  const RIGHT_REST = new THREE.Vector3(7.8, -8.4, -27);
  const LEFT_REST = new THREE.Vector3(-11.7, -10.4, -26);

  // --- right arm, holding the knife
  const rightOffset = new THREE.Group();
  rightOffset.position.copy(RIGHT_REST);
  root.add(rightOffset);

  const rightTilt = new THREE.Group();
  rightTilt.rotation.z = 0.3; // knife leans in towards the middle of the screen
  rightTilt.rotation.x = -0.1;
  rightOffset.add(rightTilt);

  // Turning the hand about the handle shows the blade flat to the eye.
  const rightRoll = new THREE.Group();
  const RIGHT_YAW = -1.15;
  rightRoll.rotation.y = RIGHT_YAW;
  rightTilt.add(rightRoll);

  const right = buildHand(materials, false);
  rightRoll.add(right);

  // The knife sits in the fist. Its own z is the pivot axis, and it has to line up
  // with the hand's x for the blade to swing over the back of the hand, so the
  // grip is turned a quarter turn.
  const grip = new THREE.Group();
  grip.rotation.y = -PI / 2;
  grip.position.set(0.35, -6.2, 0);
  rightRoll.add(grip);

  const knife = buildKnife(materials);
  grip.add(knife.root);

  // --- left arm, along for the ride
  const leftOffset = new THREE.Group();
  leftOffset.position.copy(LEFT_REST);
  root.add(leftOffset);
  const leftTilt = new THREE.Group();
  leftTilt.rotation.z = -0.42;
  leftTilt.rotation.x = -0.05;
  leftOffset.add(leftTilt);
  const leftRoll = new THREE.Group();
  leftRoll.rotation.y = 1.35;
  leftTilt.add(leftRoll);
  const left = buildHand(materials, true);
  leftRoll.add(left);

  // --- state
  let time = 0;
  let variantIndex = 0;
  let bobPhase = 0;
  // The free handle is not driven straight from the timeline: it is pulled towards
  // where the blade says it should be by a spring. That lag is the whole look —
  // the handle trails the blade round and then slaps home a moment late.
  let handleLag = INSPECT_VARIANTS[0].swing[0][1];
  let handleVelocity = 0;
  let previousYaw = null;
  let previousPitch = null;
  let swayX = 0;
  let swayY = 0;
  let landPunch = 0;
  let landVelocity = 0;
  let wasOnGround = true;

  const HANDLE_STIFFNESS = 1100;
  const HANDLE_DAMPING = 2 * Math.sqrt(HANDLE_STIFFNESS) * 0.52;
  const SPRING_STEP = 1 / 240;
  const MAX_SPRING_CATCHUP = INSPECT_REEL_SECONDS * 2;

  const currentVariant = () => INSPECT_VARIANTS[variantIndex];
  const at = (channel) => sample(currentVariant()[channel], time);

  const finishVariant = () => {
    const outgoing = currentVariant().swing;
    const accumulatedTurn = outgoing[outgoing.length - 1][1] - outgoing[0][1];

    // A variant may finish at -2π rather than numeric zero. Rebase the lagged
    // handle by the same whole turn before selecting the next track; its visible
    // angle and velocity stay continuous instead of springing backwards.
    handleLag -= accumulatedTurn;
    variantIndex = (variantIndex + 1) % INSPECT_VARIANTS.length;
    time = 0;
  };

  const stepInspect = (delta) => {
    let remaining = delta;
    while (remaining > 0) {
      const toBoundary = INSPECT_SECONDS - time;
      const h = Math.min(remaining, SPRING_STEP, toBoundary);
      time += h;

      const target = at("swing");
      handleVelocity +=
        (HANDLE_STIFFNESS * (target - handleLag) -
          HANDLE_DAMPING * handleVelocity) *
        h;
      handleLag += handleVelocity * h;
      remaining -= h;

      if (INSPECT_SECONDS - time < 1e-8) finishVariant();
    }
  };

  const advanceInspect = (delta) => {
    if (!Number.isFinite(delta) || delta <= 0) return;

    // After a long suspended frame there is no visible motion to preserve. Jump
    // over its old portion, settle the spring at that pose, then simulate the
    // final two reels normally. This bounds work and keeps even huge deltas sane.
    if (delta > MAX_SPRING_CATCHUP) {
      const skipped = delta - MAX_SPRING_CATCHUP;
      const elapsed = time + skipped;
      const completed = Math.floor(elapsed / INSPECT_SECONDS);
      time = elapsed - completed * INSPECT_SECONDS;
      variantIndex = (variantIndex + completed) % INSPECT_VARIANTS.length;
      handleLag = at("swing");
      handleVelocity = 0;
      delta = MAX_SPRING_CATCHUP;
    }

    stepInspect(delta);
  };

  const applyKnifePose = () => {
    const swing = at("swing");
    knife.setAngles(swing, handleLag);
    knife.root.rotation.set(0, at("knifeRoll"), at("flip"));
  };

  /**
   * @param delta  seconds since the last frame
   * @param state  what the runner is doing: speed (units/s), onGround, ducking,
   *               yaw and pitch in degrees. All optional.
   */
  const update = (delta, state = {}) => {
    const animationDelta = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const dt = Math.min(animationDelta, 0.1);
    advanceInspect(animationDelta);

    // --- the knife
    applyKnifePose();

    // --- walking
    const speed = state.speed ?? 0;
    const onGround = state.onGround !== false;
    const stepRate = THREE.MathUtils.clamp(speed * 0.0032, 0, 2.6);
    if (onGround) bobPhase += dt * stepRate * 2 * PI;
    const bobAmount = THREE.MathUtils.clamp(speed / 320, 0, 1.15);
    // Two dips per stride vertically, one sway per stride sideways: a figure of
    // eight, which is what stops it looking like a lift.
    const bobY = -Math.abs(Math.sin(bobPhase)) * 0.85 * bobAmount;
    const bobX = Math.sin(bobPhase * 0.5) * 1.15 * bobAmount;

    // Landing drives the hands down and they spring back.
    if (onGround && !wasOnGround) landVelocity -= 26;
    wasOnGround = onGround;
    landVelocity += (-150 * landPunch - 14 * landVelocity) * dt;
    landPunch += landVelocity * dt;

    // Turning leaves the hands behind for a moment. Degrees in, centimetres out.
    const yaw = state.yaw ?? 0;
    const pitch = state.pitch ?? 0;
    if (previousYaw !== null) {
      let dYaw = yaw - previousYaw;
      // Yaw wraps at ±180 and a wrap is not a flick of the mouse.
      if (dYaw > 180) dYaw -= 360;
      if (dYaw < -180) dYaw += 360;
      const dPitch = pitch - previousPitch;
      swayX += dYaw * 0.09;
      swayY += dPitch * 0.07;
    }
    previousYaw = yaw;
    previousPitch = pitch;
    const settle = 1 - Math.exp(-dt * 9);
    swayX -= swayX * settle;
    swayY -= swayY * settle;
    swayX = THREE.MathUtils.clamp(swayX, -4.5, 4.5);
    swayY = THREE.MathUtils.clamp(swayY, -3.5, 3.5);

    const duck = state.ducking ? -1.4 : 0;
    const air = onGround ? 0 : -0.9;

    root.position.set(swayX + bobX, swayY + bobY + landPunch + duck + air, 0);
    root.rotation.z = swayX * 0.012;
  };

  const resize = (width, height) => {
    camera.aspect = width / Math.max(1, height);
    const framingFov = THREE.MathUtils.radToDeg(
      2 * Math.atan(referenceHalfWidth / Math.max(camera.aspect, 0.01)),
    );
    camera.fov =
      camera.aspect < REFERENCE_ASPECT
        ? Math.min(framingFov, MAX_VERTICAL_FOV)
        : BASE_VERTICAL_FOV;
    camera.updateProjectionMatrix();
  };

  /**
   * Draw over whatever is already in the frame. The depth buffer is cleared first,
   * so the hands are in front of the map no matter how close the wall is.
   */
  const render = () => {
    renderer.clearDepth();
    renderer.render(scene, camera);
  };

  const dispose = () => {
    environment.texture.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
    });
    for (const material of Object.values(materials)) {
      material.dispose?.();
    }
  };

  return {
    scene,
    camera,
    update,
    resize,
    render,
    dispose,
    loopSeconds: INSPECT_REEL_SECONDS,
    /** Jump within the three-variant reel and settle the free handle at that pose. */
    seekAnimation: (seconds) => {
      const reelTime =
        ((seconds % INSPECT_REEL_SECONDS) + INSPECT_REEL_SECONDS) %
        INSPECT_REEL_SECONDS;
      const variantTime = reelTime / INSPECT_SECONDS;
      const nearestBoundary = Math.round(variantTime);
      if (Math.abs(variantTime - nearestBoundary) < 1e-9) {
        variantIndex = nearestBoundary % INSPECT_VARIANTS.length;
        time = 0;
      } else {
        variantIndex = Math.floor(variantTime);
        time = reelTime - variantIndex * INSPECT_SECONDS;
      }
      handleLag = at("swing");
      handleVelocity = 0;
      applyKnifePose();
    },
  };
};
