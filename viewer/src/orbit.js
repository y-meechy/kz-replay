// An orbit camera for the map guesser's isolated chunk view.
//
// player.js already has a freecam, but it does not fit here: the chunk sits alone
// in an otherwise empty scene, and a fly camera can drift straight off it into the
// void with nothing around to say which way is back. It also has no answer for
// touch beyond drag-to-look — WASD needs a keyboard or thumbsticks that this view
// has no room for. Orbit plus pinch is one gesture set that is already native on
// both mouse and touch: drag to turn, pinch to zoom, and the camera can never
// leave the thing it is looking at because it is always pointed at it.

import * as THREE from "three";

// A held key belongs to the camera only while the page itself has the focus:
// typing into a field must not spin it. Mirrors the isTyping guard in player.js.
const isTyping = (event) =>
  event.target instanceof HTMLElement &&
  event.target.matches("input, textarea, select");

const PITCH_LIMIT = 1.45;

/**
 * @param camera      the THREE.PerspectiveCamera (or any camera) to drive
 * @param element      the element pointer/wheel/key listeners attach to
 * @param target       initial look-at point (THREE.Vector3)
 * @param distance     initial distance from target
 * @param minDistance  closest the camera may zoom in
 * @param maxDistance  furthest the camera may zoom out
 */
export const createOrbit = ({
  camera,
  element,
  target,
  distance,
  minDistance,
  maxDistance,
}) => {
  const state = {
    yaw: 0,
    pitch: 0.4,
    distance,
    target: target.clone(),
  };
  const goal = {
    yaw: state.yaw,
    pitch: state.pitch,
    distance: state.distance,
    target: state.target.clone(),
  };

  const clampDistance = (value) =>
    THREE.MathUtils.clamp(value, minDistance, maxDistance);
  const clampPitch = (value) =>
    THREE.MathUtils.clamp(value, -PITCH_LIMIT, PITCH_LIMIT);

  goal.distance = clampDistance(goal.distance);
  state.distance = goal.distance;

  // Pointers tracked by id so one code path handles a mouse drag and a two
  // finger touch alike — the only difference is how many entries are in here.
  const pointers = new Map();
  let pinchSpread = 0;

  const cameraRight = new THREE.Vector3();
  const cameraUp = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();

  const spreadOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpointOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const panGoalTarget = (dx, dy) => {
    camera.matrixWorld.extractBasis(cameraRight, cameraUp, cameraForward);
    const scale = goal.distance * 0.0015;
    goal.target
      .addScaledVector(cameraRight, -dx * scale)
      .addScaledVector(cameraUp, dy * scale);
  };

  // Re-baseline the pinch whenever the pair of touches changes, so gaining or
  // losing a finger does not read as a sudden zoom.
  const rebasePinch = () => {
    if (pointers.size !== 2) return;
    const [a, b] = pointers.values();
    pinchSpread = spreadOf(a, b);
  };

  const onPointerDown = (event) => {
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    rebasePinch();
  };

  const onPointerMove = (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;

    if (pointers.size === 2) {
      const before = midpointOf(...pointers.values());
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const [a, b] = pointers.values();
      const spread = spreadOf(a, b);
      if (pinchSpread > 0) {
        goal.distance = clampDistance(goal.distance * (pinchSpread / spread));
      }
      pinchSpread = spread;
      const after = midpointOf(a, b);
      panGoalTarget(after.x - before.x, after.y - before.y);
      return;
    }

    if (pointers.size === 1) {
      goal.yaw -= (event.clientX - pointer.x) * 0.006;
      goal.pitch = clampPitch(goal.pitch - (event.clientY - pointer.y) * 0.006);
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  };

  const onPointerUp = (event) => {
    pointers.delete(event.pointerId);
    rebasePinch();
  };

  const onWheel = (event) => {
    event.preventDefault();
    goal.distance = clampDistance(
      goal.distance * Math.exp(event.deltaY * 0.0012),
    );
  };

  const keys = new Set();
  const onKeyDown = (event) => {
    if (isTyping(event)) return;
    keys.add(event.code);
  };
  const onKeyUp = (event) => {
    keys.delete(event.code);
  };

  const held = (code) => keys.has(code);
  const applyKeys = (delta) => {
    const yawAxis =
      (held("KeyD") || held("ArrowRight") ? 1 : 0) -
      (held("KeyA") || held("ArrowLeft") ? 1 : 0);
    const pitchAxis =
      (held("KeyW") || held("ArrowUp") ? 1 : 0) -
      (held("KeyS") || held("ArrowDown") ? 1 : 0);
    const riseAxis = (held("KeyE") ? 1 : 0) - (held("KeyQ") ? 1 : 0);
    const zoomAxis =
      (held("Equal") || held("NumpadAdd") ? 1 : 0) -
      (held("Minus") || held("NumpadSubtract") ? 1 : 0);

    if (yawAxis) goal.yaw -= yawAxis * 1.2 * delta;
    if (pitchAxis)
      goal.pitch = clampPitch(goal.pitch + pitchAxis * 1.2 * delta);
    if (riseAxis) goal.target.y += riseAxis * goal.distance * 0.4 * delta;
    if (zoomAxis)
      goal.distance = clampDistance(
        goal.distance * Math.exp(-zoomAxis * 1.5 * delta),
      );
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  element.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const update = (delta) => {
    applyKeys(delta);

    const damping = 1 - Math.exp(-delta * 12);
    state.yaw += (goal.yaw - state.yaw) * damping;
    state.pitch += (goal.pitch - state.pitch) * damping;
    state.distance += (goal.distance - state.distance) * damping;
    state.target.x += (goal.target.x - state.target.x) * damping;
    state.target.y += (goal.target.y - state.target.y) * damping;
    state.target.z += (goal.target.z - state.target.z) * damping;

    const cosPitch = Math.cos(state.pitch);
    camera.position.set(
      state.target.x + state.distance * cosPitch * Math.sin(state.yaw),
      state.target.y + state.distance * Math.sin(state.pitch),
      state.target.z + state.distance * cosPitch * Math.cos(state.yaw),
    );
    camera.lookAt(state.target);
  };

  const reset = ({
    target: nextTarget,
    distance: nextDistance,
    yaw: nextYaw,
    pitch: nextPitch,
  }) => {
    goal.yaw = state.yaw = nextYaw ?? state.yaw;
    goal.pitch = state.pitch = clampPitch(nextPitch ?? state.pitch);
    goal.distance = state.distance = clampDistance(
      nextDistance ?? state.distance,
    );
    goal.target.copy(nextTarget ?? state.target);
    state.target.copy(goal.target);
  };

  const dispose = () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerUp);
    element.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    pointers.clear();
    keys.clear();
  };

  return { update, dispose, reset };
};
