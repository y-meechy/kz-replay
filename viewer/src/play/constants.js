// CKZ + Source constants, hull dimensions, spawns.
// See PLAY_PLAN.md §0.4 / §0.6 for the research these are transcribed from.

// --- CKZ cvars (cs2kz-metamod, kz_mode_ckz.h modeCvarValues[]) ---
export const SV_ACCELERATE = 6.5;
export const SV_AIRACCELERATE = 100.0;
export const SV_AIR_MAX_WISHSPEED = 30.0;
export const SV_FRICTION = 5.2;
export const SV_GRAVITY = 800.0;
export const SV_JUMP_IMPULSE = 302.0; // stock CS2 is 301.993377
export const SV_MAXSPEED = 320.0;
export const SV_MAXVELOCITY = 3500.0;
export const SV_ENABLEBUNNYHOPPING = true;
export const SV_AUTOBUNNYHOPPING = false;
export const SV_STAMINAJUMPCOST = 0.0; // stamina fully off
export const SV_STAMINALANDCOST = 0.0; // stamina fully off
export const SV_STAMINAMAX = 0.0; // stamina fully off
export const SV_STANDABLE_NORMAL = 0.7;
export const SV_WALKABLE_NORMAL = 0.7;
export const SV_STEP_MOVE_VEL_MIN = 64.0; // intentionally unused, see movement.js
export const SV_BOUNCE = 0.0;
export const SV_LADDER_SCALE_SPEED = 1.0;
export const SV_LADDER_DAMPEN = 1.0;
export const SV_LADDER_ANGLE = -0.707;
export const SV_TIMEBETWEENDUCKS = 0.0;

// --- CKZ #define constants (kz_mode_ckz.h) ---
export const SPEED_NORMAL = 250.0; // ground wish-speed reference, NOT sv_maxspeed
export const MAX_BUMPS = 4;
export const PS_SPEED_MAX = 26.0; // max prestrafe bonus on top of SPEED_NORMAL
export const PS_MIN_REWARD_RATE = 2.0;
export const PS_MAX_REWARD_RATE = 15.5;
export const PS_MAX_PS_TIME = 0.5;
export const PS_TURN_RATE_WINDOW = 0.02;
export const PS_DECREMENT_RATIO = 3.0;
export const PS_RATIO_TO_SPEED = 0.5; // sqrt curve
export const PS_LANDING_GRACE_PERIOD = 0.25;
export const BH_PERF_WINDOW = 0.02; // <= 1 tick on ground == perf
export const BH_BASE_MULTIPLIER = 51.5;
export const BH_LANDING_DECREMENT_MULTIPLIER = 75.0;
const PS_SPEED_CAP = SPEED_NORMAL + PS_SPEED_MAX; // 276
export const BH_NORMALIZE_FACTOR =
  BH_BASE_MULTIPLIER * Math.log(PS_SPEED_CAP) - PS_SPEED_CAP;
export const DUCK_SPEED_NORMAL = 8.0; // crouch transition rate, not a timer
export const DUCK_SPEED_MINIMUM = 6.0234375;

// --- Stock Source values CKZ does not override (gamemovement.cpp) ---
export const SV_STOPSPEED = 80;
export const SV_STEPSIZE = 18;
export const NON_JUMP_VELOCITY = 140;
export const MAX_CLIP_PLANES = 5;
export const DIST_EPSILON = 0.03125;
export const DUCK_SPEED_MULTIPLIER = 0.34; // ducked ground speed cap fraction

// --- Tick timing ---
export const TICK_RATE = 64;
export const TICK_INTERVAL = 1 / TICK_RATE; // 0.015625

// --- Hulls (CS family, origin at the feet, mins.z = 0 for both) ---
export const HULL_MINS = { x: -16, y: -16, z: 0 };
export const HULL_MAXS = { x: 16, y: 16, z: 72 };
export const DUCK_HULL_MAXS = { x: 16, y: 16, z: 54 };
export const EYE_STANDING = 64;
export const EYE_DUCKED = 46;

export const FOV_VERTICAL_DEG = 73.74; // matches player.js first-person

// Spawn z is the render mesh floor (48.00) plus 8 units so the player drops
// onto the floor instead of possibly starting embedded in it.
export const SPAWNS = {
  kz_victoria: { origin: { x: 1576, y: -1300.77, z: 56 }, yaw: 232, pitch: 0 },
};
export const DEFAULT_MAP = "kz_victoria";
