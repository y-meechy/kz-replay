// Keyboard/mouse/pointer-lock/scroll → per-tick usercmd.
//
// No three.js dependency: this module only produces plain numbers and a
// buttons bitfield, which is what movement.js consumes.

const KEY_FORWARD = new Set(["KeyW", "ArrowUp"]);
const KEY_BACK = new Set(["KeyS", "ArrowDown"]);
const KEY_LEFT = new Set(["KeyA", "ArrowLeft"]);
const KEY_RIGHT = new Set(["KeyD", "ArrowRight"]);
const KEY_JUMP = new Set(["Space"]);
const KEY_DUCK = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]);

export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;

// Source's cl_forwardspeed / cl_sidespeed.
const MOVE_SPEED = 450;

// CS2's m_yaw, degrees per mouse count at sensitivity 1.0.
const M_YAW = 0.022;

const SENS_KEY = "kz-play-sensitivity";
const DEFAULT_SENSITIVITY = 2.0;

const loadSensitivity = () => {
  const stored = Number(localStorage.getItem(SENS_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SENSITIVITY;
};

const wrapYaw = (yaw) => {
  let y = yaw % 360;
  if (y <= -180) y += 360;
  if (y > 180) y -= 360;
  return y;
};

const clampPitch = (pitch) => Math.max(-89, Math.min(89, pitch));

export const createInput = (canvas) => {
  const pressed = new Set();
  // Rising-edge queue of "jump for exactly one tick" tokens, one per wheel notch.
  const scrollJumpQueue = [];

  let sensitivity = loadSensitivity();
  let locked = false;
  // Set on a Space keydown, cleared the next sample() — a held key must not
  // re-fire until it's released and pressed again (sv_autobunnyhopping false).
  let keyJumpEdge = false;

  const viewAngles = { yaw: 0, pitch: 0 };

  const onPointerLockChange = () => {
    locked = document.pointerLockElement === canvas;
  };

  const onClick = () => {
    if (!locked) canvas.requestPointerLock();
  };

  const onMouseMove = (event) => {
    if (!locked) return;
    const sens = M_YAW * sensitivity;
    viewAngles.yaw = wrapYaw(viewAngles.yaw - event.movementX * sens);
    viewAngles.pitch = clampPitch(viewAngles.pitch - event.movementY * sens);
  };

  const onKeyDown = (event) => {
    if (KEY_JUMP.has(event.code) && !pressed.has(event.code)) keyJumpEdge = true;
    pressed.add(event.code);
  };

  const onKeyUp = (event) => {
    pressed.delete(event.code);
  };

  const onWheel = (event) => {
    if (!locked) return;
    scrollJumpQueue.push(true);
    event.preventDefault();
  };

  const attach = () => {
    canvas.addEventListener("click", onClick);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
  };

  const detach = () => {
    canvas.removeEventListener("click", onClick);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("wheel", onWheel);
    pressed.clear();
    scrollJumpQueue.length = 0;
    keyJumpEdge = false;
  };

  const anyPressed = (codes) => {
    for (const code of pressed) if (codes.has(code)) return true;
    return false;
  };

  // Consumes buffered edges and returns the usercmd for one tick.
  const sample = () => {
    let forwardMove = 0;
    let sideMove = 0;
    if (anyPressed(KEY_FORWARD)) forwardMove += MOVE_SPEED;
    if (anyPressed(KEY_BACK)) forwardMove -= MOVE_SPEED;
    if (anyPressed(KEY_RIGHT)) sideMove += MOVE_SPEED;
    if (anyPressed(KEY_LEFT)) sideMove -= MOVE_SPEED;

    let buttons = 0;
    if (anyPressed(KEY_JUMP)) buttons |= IN_JUMP;
    if (anyPressed(KEY_DUCK)) buttons |= IN_DUCK;

    // A queue, not a flag: fast scrolling must not lose notches between ticks.
    let jumpPressed = false;
    if (scrollJumpQueue.length > 0) {
      scrollJumpQueue.shift();
      buttons |= IN_JUMP;
      jumpPressed = true; // every scroll notch is its own press
    }
    if (keyJumpEdge) {
      jumpPressed = true;
      keyJumpEdge = false;
    }

    return {
      forwardMove,
      sideMove,
      buttons,
      jumpPressed,
      viewAngles: { yaw: viewAngles.yaw, pitch: viewAngles.pitch },
    };
  };

  const getSensitivity = () => sensitivity;

  const setSensitivity = (value) => {
    sensitivity = value;
    localStorage.setItem(SENS_KEY, String(sensitivity));
  };

  // Used by respawn so the map's spawn yaw/pitch actually takes effect
  // instead of leaving the live view angles wherever the player last looked.
  const setViewAngles = (yawDeg, pitchDeg) => {
    viewAngles.yaw = wrapYaw(yawDeg);
    viewAngles.pitch = clampPitch(pitchDeg);
  };

  return {
    attach,
    detach,
    sample,
    viewAngles,
    setViewAngles,
    get isLocked() {
      return locked;
    },
    getSensitivity,
    setSensitivity,
  };
};
