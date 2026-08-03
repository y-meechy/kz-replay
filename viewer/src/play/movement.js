// The CKZ movement tick. Ports source-sdk-2013 gamemovement.cpp plus the
// cs2kz-metamod CKZ-mode overlays from kz_mode_ckz.cpp. See PLAY_PLAN.md §2.6.

import { v3, copy, scale, addScaled, dot, cross, length, length2D, normalize } from "./vec.js";
import {
  SV_ACCELERATE,
  SV_AIRACCELERATE,
  SV_AIR_MAX_WISHSPEED,
  SV_FRICTION,
  SV_GRAVITY,
  SV_JUMP_IMPULSE,
  SV_MAXVELOCITY,
  SV_STOPSPEED,
  SV_STEPSIZE,
  DIST_EPSILON,
  MAX_CLIP_PLANES,
  MAX_BUMPS,
  SPEED_NORMAL,
  PS_SPEED_MAX,
  PS_MIN_REWARD_RATE,
  PS_MAX_REWARD_RATE,
  PS_MAX_PS_TIME,
  PS_DECREMENT_RATIO,
  PS_TURN_RATE_WINDOW,
  BH_PERF_WINDOW,
  BH_BASE_MULTIPLIER,
  BH_LANDING_DECREMENT_MULTIPLIER,
  BH_NORMALIZE_FACTOR,
  DUCK_SPEED_NORMAL,
  DUCK_SPEED_MINIMUM,
  DUCK_SPEED_MULTIPLIER,
  HULL_MINS,
  HULL_MAXS,
  DUCK_HULL_MAXS,
  EYE_STANDING,
  EYE_DUCKED,
  TICK_INTERVAL,
} from "./constants.js";
import { unstuck } from "./collision.js";

const IN_JUMP = 1 << 1;
const IN_DUCK = 1 << 2;

const DEG2RAD = Math.PI / 180;

// A fresh trace_t-shaped output object for traceHull() to fill.
const newTrace = () => ({ fraction: 1, endpos: null, plane: null, startSolid: false, allSolid: false, hit: false });

const zeroVelocity = (state) => {
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = 0;
};

// AngleVectors — Source forward/right/up from (yaw, pitch) degrees, Source space.
const angleVectors = (viewAngles) => {
  const yaw = viewAngles.yaw * DEG2RAD;
  const pitch = viewAngles.pitch * DEG2RAD;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const forward = v3(cp * cy, cp * sy, -sp);
  // right = forward x up-ish, per Source: right points to the player's right.
  const right = v3(sy, -cy, 0);
  const up = v3(0, 0, 1);
  return { forward, right, up };
};

// Shared wishdir/wishspeed (2D, unclamped) construction for walkMove/airMove.
const computeWishDir = (state, cmd) => {
  const { forward, right } = angleVectors(state.viewAngles);

  const wishvel = v3();
  addScaled(wishvel, wishvel, forward, cmd.forwardMove);
  addScaled(wishvel, wishvel, right, cmd.sideMove);
  wishvel.z = 0;

  const wishspeed = length2D(wishvel);
  const wishdir = v3();
  if (wishspeed > 1e-6) {
    wishdir.x = wishvel.x / wishspeed;
    wishdir.y = wishvel.y / wishspeed;
  }

  return { wishdir, wishspeed };
};

export const createPlayerState = (spawn) => ({
  origin: v3(spawn.origin.x, spawn.origin.y, spawn.origin.z),
  velocity: v3(0, 0, 0),
  viewAngles: { yaw: spawn.yaw, pitch: spawn.pitch },
  onGround: false,
  groundNormal: v3(0, 0, 1),
  ducking: false,
  ducked: false,
  duckAmount: 0,
  duckSpeed: DUCK_SPEED_NORMAL,
  oldButtons: 0,
  buttons: 0,
  // CKZ prestrafe / perf bookkeeping
  leftPreRatio: 0,
  rightPreRatio: 0,
  angleHistory: [],
  lastYaw: spawn.yaw,
  landingTime: -1,
  landingVelocity: v3(0, 0, 0),
  takeoffTime: -1,
  curTime: 0,
  tick: 0,
  surfaceFriction: 1,
  lastTickStuck: false,
  prestrafeGain: 0,
  lastJump: null,
});

const getHullMaxs = (state) => (state.ducked ? DUCK_HULL_MAXS : HULL_MAXS);

const eyeHeight = (state) => EYE_STANDING + (EYE_DUCKED - EYE_STANDING) * state.duckAmount;

// --- CKZ helpers ---

// GetPrestrafeGain — kz_mode_ckz.cpp
const ckzPrestrafeGain = (state) => {
  const maxRatio = Math.max(state.leftPreRatio, state.rightPreRatio);
  if (maxRatio <= 0) return 0;
  return PS_SPEED_MAX * Math.sqrt(maxRatio / PS_MAX_PS_TIME);
};

// UpdateAngleHistory + CalcPrestrafe — kz_mode_ckz.cpp. leftPreRatio/rightPreRatio
// build up over ~PS_MAX_PS_TIME seconds of sustained good strafing (they are
// accumulators, not per-tick snapshots) and decay when the turn rate drops
// below PS_MIN_REWARD_RATE or the matching strafe key is released. Writes
// state.prestrafeGain, the single source of truth read everywhere else.
const ckzUpdatePrestrafe = (state, cmd) => {
  let yawDelta = cmd.viewAngles.yaw - state.lastYaw;
  if (yawDelta > 180) yawDelta -= 360;
  if (yawDelta < -180) yawDelta += 360;
  state.lastYaw = cmd.viewAngles.yaw;

  state.angleHistory.push({ t: state.curTime, yawDelta });
  while (state.angleHistory.length > 0 && state.curTime - state.angleHistory[0].t > PS_TURN_RATE_WINDOW) {
    state.angleHistory.shift();
  }

  let turnSum = 0;
  for (const h of state.angleHistory) turnSum += h.yawDelta;
  const turnRate = turnSum / PS_TURN_RATE_WINDOW; // deg/s, signed (positive = turning left/CCW)

  if (!state.onGround) {
    // Airborne: no new build-up and no decay, but a strafe key held mid-air
    // syncs the lower ratio up to the higher one, so switching strafe
    // direction in the air doesn't cost banked prestrafe.
    if (cmd.sideMove !== 0) {
      const maxRatio = Math.max(state.leftPreRatio, state.rightPreRatio);
      state.leftPreRatio = maxRatio;
      state.rightPreRatio = maxRatio;
    }
    state.prestrafeGain = ckzPrestrafeGain(state);
    return;
  }

  const decay = TICK_INTERVAL * PS_DECREMENT_RATIO;

  // Reward when the held strafe key matches the turn direction and the turn
  // rate clears the minimum; the reward itself scales up to PS_MAX_REWARD_RATE.
  // Otherwise the ratio decays. Ratios are clamped to [0, PS_MAX_PS_TIME].
  const step = (ratio, turningThisWay) => {
    if (turningThisWay && Math.abs(turnRate) >= PS_MIN_REWARD_RATE) {
      const reward = Math.min(1, Math.abs(turnRate) / PS_MAX_REWARD_RATE) * TICK_INTERVAL;
      return Math.min(PS_MAX_PS_TIME, ratio + reward);
    }
    return Math.max(0, ratio - decay);
  };

  state.leftPreRatio = step(state.leftPreRatio, cmd.sideMove < 0 && turnRate > 0);
  state.rightPreRatio = step(state.rightPreRatio, cmd.sideMove > 0 && turnRate < 0);

  state.prestrafeGain = ckzPrestrafeGain(state);
};

// OnStopTouchGround — kz_mode_ckz.cpp. Perf-bhop log-curve speed compression.
const ckzOnTakeoff = (state) => {
  let perf = false;

  if (state.landingTime >= 0 && state.curTime - state.landingTime <= BH_PERF_WINDOW) {
    const timeOnGround = state.curTime - state.landingTime;
    const landingSpeed2D = length2D(state.landingVelocity);
    let spd = Math.max(landingSpeed2D, length2D(state.velocity));
    const floorSpeed = SPEED_NORMAL + state.prestrafeGain;
    if (spd > floorSpeed) {
      spd = (BH_BASE_MULTIPLIER - timeOnGround * BH_LANDING_DECREMENT_MULTIPLIER) * Math.log(spd) - BH_NORMALIZE_FACTOR;
      spd = Math.max(spd, floorSpeed);
    }
    perf = true;

    // Direction from the landing velocity's XY.
    if (landingSpeed2D > 1e-6) {
      const dirx = state.landingVelocity.x / landingSpeed2D;
      const diry = state.landingVelocity.y / landingSpeed2D;
      state.velocity.x = dirx * spd;
      state.velocity.y = diry * spd;
    }
  }

  state.takeoffTime = state.curTime;
  // Reflects the real post-takeoff horizontal velocity, not the computed
  // curve value — the two can differ when the direction rewrite above is
  // skipped (landingSpeed2D too small to normalize).
  state.lastJump = { speed: length2D(state.velocity), perf };
};

// OnStartTouchGround + SlopeFix — kz_mode_ckz.cpp
const ckzOnLand = (state, tracer) => {
  state.landingTime = state.curTime;
  copy(state.landingVelocity, state.velocity);

  // Slope fix: trace 2 units down from the landing point; if the hit normal's z
  // is in (0.7, 1.0), re-ClipVelocity the landing velocity against that normal
  // and keep the result only if 2D speed did not decrease.
  const probeStart = { x: state.origin.x, y: state.origin.y, z: state.origin.z };
  const probeEnd = { x: state.origin.x, y: state.origin.y, z: state.origin.z - 2 };
  const probe = newTrace();
  tracer.traceHull(probeStart, probeEnd, HULL_MINS, getHullMaxs(state), probe);

  if (probe.hit && probe.plane.normal.z > 0.7 && probe.plane.normal.z < 1.0) {
    const before = length2D(state.velocity);
    const clipped = v3();
    clipVelocity(state.velocity, probe.plane.normal, 1, clipped);
    const after = length2D(clipped);
    if (after >= before) copy(state.velocity, clipped);
  }
};

// ReduceDuckSlowdown — kz_mode_ckz.cpp. Each fresh duck press knocks duckSpeed
// down a step (floored at DUCK_SPEED_MINIMUM), so duck-spamming makes every
// later crouch visibly slower to complete. duckSpeed recovers back to
// DUCK_SPEED_NORMAL as soon as duck is released.
const ckzReduceDuckSlowdown = (state, cmd) => {
  const duckHeld = !!(cmd.buttons & IN_DUCK);
  const duckJustPressed = duckHeld && !(state.oldButtons & IN_DUCK);

  if (!duckHeld) {
    state.duckSpeed = DUCK_SPEED_NORMAL;
  } else if (duckJustPressed && state.duckSpeed > DUCK_SPEED_MINIMUM) {
    const step = (DUCK_SPEED_NORMAL - DUCK_SPEED_MINIMUM) / 4;
    state.duckSpeed = Math.max(DUCK_SPEED_MINIMUM, state.duckSpeed - step);
  }
};

// RemoveCrouchJumpBind — kz_mode_ckz.cpp. If grounded, duck was not held last
// tick, and jump was just pressed, strip the duck bit for this tick.
const ckzRemoveCrouchJumpBind = (state, cmd) => {
  const duckJustPressed = (cmd.buttons & IN_DUCK) && !(state.oldButtons & IN_DUCK);
  const jumpJustPressed = (cmd.buttons & IN_JUMP) && !(state.oldButtons & IN_JUMP);
  if (state.onGround && jumpJustPressed && duckJustPressed) {
    cmd.buttons &= ~IN_DUCK;
  }
};

// --- Base Source movement ---

const clipVelocity = (velocity, normal, overbounce, out) => {
  const backoff = dot(velocity, normal) * overbounce;
  out.x = velocity.x - normal.x * backoff;
  out.y = velocity.y - normal.y * backoff;
  out.z = velocity.z - normal.z * backoff;
  const adjust = dot(out, normal);
  if (adjust < 0) {
    out.x -= normal.x * adjust;
    out.y -= normal.y * adjust;
    out.z -= normal.z * adjust;
  }
  return out;
};

const checkVelocity = (state) => {
  state.velocity.x = Math.max(-SV_MAXVELOCITY, Math.min(SV_MAXVELOCITY, state.velocity.x));
  state.velocity.y = Math.max(-SV_MAXVELOCITY, Math.min(SV_MAXVELOCITY, state.velocity.y));
  state.velocity.z = Math.max(-SV_MAXVELOCITY, Math.min(SV_MAXVELOCITY, state.velocity.z));
};

const setGround = (state, normal) => {
  if (normal) {
    state.onGround = true;
    copy(state.groundNormal, normal);
  } else {
    state.onGround = false;
  }
};

const categorizePosition = (state, tracer) => {
  if (state.velocity.z > 140) {
    setGround(state, null);
    return;
  }
  const end = { x: state.origin.x, y: state.origin.y, z: state.origin.z - 2 };
  const tr = newTrace();
  tracer.traceHull(state.origin, end, HULL_MINS, getHullMaxs(state), tr);

  if (!tr.hit || tr.plane.normal.z < 0.7) {
    setGround(state, null);
    if (state.velocity.z > 0) state.surfaceFriction = 0.25; // CS "deadstrafe"
  } else {
    const wasOnGround = state.onGround;
    if (!wasOnGround) ckzOnLand(state, tracer);
    setGround(state, tr.plane.normal);
    state.surfaceFriction = 1;
    if (tr.fraction < 1) copy(state.origin, tr.endpos);
  }
};

const friction = (state) => {
  const speed = length(state.velocity);
  if (speed < 0.1) return;
  if (!state.onGround) return;

  const fric = SV_FRICTION * state.surfaceFriction;
  const control = speed < SV_STOPSPEED ? SV_STOPSPEED : speed;
  const drop = control * fric * TICK_INTERVAL;

  const newspeed = Math.max(speed - drop, 0);
  if (newspeed !== speed) {
    const scaleFactor = newspeed / speed;
    state.velocity.x *= scaleFactor;
    state.velocity.y *= scaleFactor;
    state.velocity.z *= scaleFactor;
  }
};

const accelerate = (state, wishdir, wishspeed, accel) => {
  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  const accelspeed = Math.min(accel * TICK_INTERVAL * wishspeed * state.surfaceFriction, addspeed);
  addScaled(state.velocity, state.velocity, wishdir, accelspeed);
};

const airAccelerate = (state, wishdir, wishspeed, accel) => {
  const wishspd = Math.min(wishspeed, SV_AIR_MAX_WISHSPEED);
  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  const accelspeed = Math.min(accel * wishspeed * TICK_INTERVAL * state.surfaceFriction, addspeed);
  addScaled(state.velocity, state.velocity, wishdir, accelspeed);
};

// TryPlayerMove — 4-bump loop with plane list and crease case. Integrates
// state.velocity itself (SDK: time_left starts at frametime, not 1.0 — a
// full second would fling the player nearly a full tick's worth of terminal
// velocity instead of one 1/64s slice of it).
const tryPlayerMove = (state, tracer) => {
  const primalVelocity = v3(state.velocity.x, state.velocity.y, state.velocity.z);
  const planes = [];
  let timeLeft = TICK_INTERVAL;
  let allFraction = 0;

  const origin = state.origin;
  const mins = HULL_MINS;
  const maxs = getHullMaxs(state);

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (length(state.velocity) < 1e-6) break;

    const end = {
      x: origin.x + state.velocity.x * timeLeft,
      y: origin.y + state.velocity.y * timeLeft,
      z: origin.z + state.velocity.z * timeLeft,
    };

    const tr = newTrace();
    tracer.traceHull(origin, end, mins, maxs, tr);

    if (tr.allSolid) {
      zeroVelocity(state);
      break;
    }

    if (tr.fraction > 0) {
      copy(origin, tr.endpos);
      allFraction += tr.fraction;
      planes.length = 0;
    }

    if (tr.fraction === 1) break; // moved the entire distance

    timeLeft -= timeLeft * tr.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      zeroVelocity(state);
      break;
    }

    planes.push({ x: tr.plane.normal.x, y: tr.plane.normal.y, z: tr.plane.normal.z });

    if (planes.length === 1) {
      // Single-plane case: clip once.
      const clipped = v3();
      clipVelocity(state.velocity, planes[0], 1, clipped);
      copy(state.velocity, clipped);
    } else {
      // Search for a plane whose clip doesn't re-penetrate any other plane.
      let i;
      for (i = 0; i < planes.length; i++) {
        const clipped = v3();
        clipVelocity(state.velocity, planes[i], 1, clipped);
        let ok = true;
        for (let j = 0; j < planes.length; j++) {
          if (j === i) continue;
          if (dot(clipped, planes[j]) < 0) {
            ok = false;
            break;
          }
        }
        if (ok) {
          copy(state.velocity, clipped);
          break;
        }
      }
      if (i === planes.length) {
        // No valid clip. If exactly 2 planes, slide along their crease.
        if (planes.length === 2) {
          const dir = v3();
          cross(dir, planes[0], planes[1]);
          const dirLen = normalize(dir, dir);
          const d = dirLen > 1e-6 ? dot(dir, state.velocity) : 0;
          scale(state.velocity, dir, d);
        } else {
          zeroVelocity(state);
          break;
        }
      }
    }

    if (dot(state.velocity, primalVelocity) <= 0) {
      zeroVelocity(state);
      break;
    }
  }

  if (allFraction === 0) zeroVelocity(state);
};

// StayOnGround — SDK form: probe up 2 then sv_stepsize+2 down and snap if
// standable and the move was under 0.5 units.
const stayOnGround = (state, tracer) => {
  const start = { x: state.origin.x, y: state.origin.y, z: state.origin.z + 2 };
  const end = { x: state.origin.x, y: state.origin.y, z: state.origin.z - SV_STEPSIZE - 2 };
  const tr = newTrace();
  tracer.traceHull(start, end, HULL_MINS, getHullMaxs(state), tr);

  if (tr.hit && !tr.startSolid && tr.plane.normal.z >= 0.7) {
    const moveDist = Math.hypot(tr.endpos.x - state.origin.x, tr.endpos.y - state.origin.y, tr.endpos.z - state.origin.z);
    if (moveDist < 0.5) {
      copy(state.origin, tr.endpos);
    }
  }
};

const distXY = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// StepMove — try flat, then a stepped attempt raised by stepsize, keep whichever
// travelled further horizontally.
const stepMove = (state, tracer) => {
  const startOrigin = { x: state.origin.x, y: state.origin.y, z: state.origin.z };
  const startVelocity = { x: state.velocity.x, y: state.velocity.y, z: state.velocity.z };

  // Flat attempt (state is already at startOrigin/startVelocity here).
  tryPlayerMove(state, tracer);
  const flatOrigin = { x: state.origin.x, y: state.origin.y, z: state.origin.z };
  const flatVelocity = { x: state.velocity.x, y: state.velocity.y, z: state.velocity.z };
  const flatDist2D = distXY(startOrigin, flatOrigin);

  // Stepped attempt: rewind, trace up stepsize+eps, TryPlayerMove at raised
  // height, trace back down stepsize+eps, reject if landing normal z < 0.7.
  copy(state.origin, startOrigin);
  copy(state.velocity, startVelocity);

  const eps = 0.1;
  const upEnd = { x: state.origin.x, y: state.origin.y, z: state.origin.z + SV_STEPSIZE + eps };
  const upTr = newTrace();
  tracer.traceHull(state.origin, upEnd, HULL_MINS, getHullMaxs(state), upTr);
  copy(state.origin, upTr.endpos);

  tryPlayerMove(state, tracer);

  const downEnd = { x: state.origin.x, y: state.origin.y, z: state.origin.z - (SV_STEPSIZE + eps) };
  const downTr = newTrace();
  tracer.traceHull(state.origin, downEnd, HULL_MINS, getHullMaxs(state), downTr);

  const steppedOk = downTr.hit && downTr.plane.normal.z >= 0.7;

  if (steppedOk) {
    const steppedOrigin = { x: downTr.endpos.x, y: downTr.endpos.y, z: downTr.endpos.z };
    const steppedDist2D = distXY(startOrigin, steppedOrigin);
    if (steppedDist2D > flatDist2D) {
      copy(state.origin, steppedOrigin);
      // Keep the flat move's velocity.z when the stepped one wins.
      state.velocity.z = flatVelocity.z;
      return;
    }
  }

  copy(state.origin, flatOrigin);
  copy(state.velocity, flatVelocity);
};

// Ducked ground speed cap: SPEED_NORMAL * DUCK_SPEED_MULTIPLIER, further
// reduced by the CKZ duck-speed floor model.
const duckSpeedCap = (state, groundMax) => {
  if (!state.ducked && state.duckAmount <= 0) return groundMax;
  return groundMax * DUCK_SPEED_MULTIPLIER;
};

// WalkMove
const walkMove = (state, cmd, tracer) => {
  const { wishdir, wishspeed: rawWishspeed } = computeWishDir(state, cmd);

  const groundMax = SPEED_NORMAL + state.prestrafeGain;
  let wishspeed = Math.min(rawWishspeed, groundMax);
  wishspeed = Math.min(wishspeed, duckSpeedCap(state, groundMax));

  state.velocity.z = 0;
  accelerate(state, wishdir, wishspeed, SV_ACCELERATE);
  state.velocity.z = 0;

  if (length(state.velocity) < 1) {
    zeroVelocity(state);
    return;
  }

  const dest = {
    x: state.origin.x + state.velocity.x * TICK_INTERVAL,
    y: state.origin.y + state.velocity.y * TICK_INTERVAL,
    z: state.origin.z,
  };

  const tr = newTrace();
  tracer.traceHull(state.origin, dest, HULL_MINS, getHullMaxs(state), tr);

  if (tr.fraction === 1) {
    copy(state.origin, tr.endpos);
    stayOnGround(state, tracer);
    return;
  }

  stepMove(state, tracer);
  stayOnGround(state, tracer);
};

// AirMove — same wishvel construction, maxspeed = SPEED_NORMAL with no
// prestrafe bonus (CKZ explicitly resets it here).
const airMove = (state, cmd, tracer) => {
  const { wishdir, wishspeed: rawWishspeed } = computeWishDir(state, cmd);
  const wishspeed = Math.min(rawWishspeed, SPEED_NORMAL);

  airAccelerate(state, wishdir, wishspeed, SV_AIRACCELERATE);

  tryPlayerMove(state, tracer);
};

// CheckJumpButton — lives inside FullWalkMove, after Friction/CheckVelocity.
// Uses cmd.jumpPressed (an explicit edge flag from input.js: scroll tokens
// always set it, keyboard sets it only on keydown edges) rather than
// reconstructing the edge from oldButtons — two consecutive one-tick scroll
// jump tokens both have IN_JUMP set with oldButtons also IN_JUMP on the
// second, which would silently eat every other scroll notch.
const checkJumpButton = (state, cmd) => {
  if (!state.onGround) return;
  if (!cmd.jumpPressed) return; // sv_autobunnyhopping false: edge only, not held

  state.velocity.z = SV_JUMP_IMPULSE;
  setGround(state, null);
  ckzOnTakeoff(state);
};

// Duck — crouch transition driven by duckSpeed, not a fixed timer.
const duck = (state, cmd, tracer) => {
  const wantDuck = !!(cmd.buttons & IN_DUCK);

  ckzReduceDuckSlowdown(state, cmd);

  const delta = (wantDuck ? 1 : -1) * state.duckSpeed * TICK_INTERVAL;
  let newAmount = Math.max(0, Math.min(1, state.duckAmount + delta));

  // Refuse to unduck (grounded or airborne) if the standing hull would start
  // solid at the current origin — this is the same probe that must gate the
  // airborne instant hull swap below, or releasing duck mid-air in a
  // 54-unit gap would pop the 72 hull straight into geometry.
  let unduckRefused = false;
  if (newAmount < state.duckAmount && state.ducked) {
    const probe = newTrace();
    tracer.traceHull(state.origin, state.origin, HULL_MINS, HULL_MAXS, probe);
    if (probe.startSolid) {
      newAmount = state.duckAmount; // refuse the unduck this tick
      unduckRefused = true;
    }
  }

  state.duckAmount = newAmount;

  // Airborne: swap the hull immediately (crouch-jump over gaps), which is why
  // the check comes before the ground-based endpoint checks below. On the
  // ground, swap only once the duckAmount transition fully completes.
  if (!state.onGround) {
    if (wantDuck) {
      state.ducked = true;
    } else if (!unduckRefused) {
      state.ducked = false;
    }
  } else if (state.duckAmount >= 1) {
    state.ducked = true;
  } else if (state.duckAmount <= 0) {
    state.ducked = false;
  }

  state.ducking = wantDuck;
};

// FullWalkMove
const fullWalkMove = (state, cmd, tracer) => {
  // StartGravity
  state.velocity.z -= SV_GRAVITY * 0.5 * TICK_INTERVAL;

  if (state.onGround) {
    state.velocity.z = 0;
    friction(state);
  }

  checkVelocity(state);
  checkJumpButton(state, cmd);

  if (state.onGround) {
    walkMove(state, cmd, tracer);
  } else {
    airMove(state, cmd, tracer);
  }

  categorizePosition(state, tracer);
  checkVelocity(state);

  // FinishGravity
  state.velocity.z -= SV_GRAVITY * 0.5 * TICK_INTERVAL;

  if (state.onGround) state.velocity.z = 0;
};

export const movementTick = (state, cmd, tracer) => {
  state.curTime += TICK_INTERVAL;
  state.tick++;
  state.viewAngles = cmd.viewAngles;

  if (state.lastTickStuck) {
    const fixed = unstuck(tracer, state.origin, HULL_MINS, getHullMaxs(state));
    if (fixed) copy(state.origin, fixed);
  }

  ckzRemoveCrouchJumpBind(state, cmd);
  categorizePosition(state, tracer);
  ckzUpdatePrestrafe(state, cmd);
  duck(state, cmd, tracer);
  fullWalkMove(state, cmd, tracer);

  // Detect stuck-ness for next tick's unstuck() pass.
  const probe = newTrace();
  tracer.traceHull(state.origin, state.origin, HULL_MINS, getHullMaxs(state), probe);
  state.lastTickStuck = probe.startSolid;

  state.oldButtons = cmd.buttons;
};

export { eyeHeight, getHullMaxs };
