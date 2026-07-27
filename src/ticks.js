// Port of DecodeTickDataBuffer from cs2kz-metamod/src/kz/replays/compression.cpp.
//
// Each tick is a u64 change-flag mask followed by only the fields that changed,
// in a fixed order. Unchanged fields inherit:
//
//   top level  <- the same field on the previous tick (serverTick defaults to +1)
//   pre        <- the previous tick's post
//   post       <- this tick's pre
//
// The decoder MUST consume the buffer exactly. Any leftover or shortfall means a
// field size or a flag bit is wrong, and every value after that point is garbage,
// so we throw instead of returning plausible-looking nonsense.

// Top-level flag bits.
const CHANGED_SERVER_TICK = 0;
const CHANGED_GAME_TIME = 1;
const CHANGED_REAL_TIME = 2;
const CHANGED_UNIX_TIME = 3;
const CHANGED_CMD_NUMBER = 4;
const CHANGED_CLIENT_TICK = 5;
const CHANGED_FORWARD = 6;
const CHANGED_LEFT = 7;
const CHANGED_UP = 8;
const CHANGED_LEFT_HANDED = 9;
const CHANGED_CHECKPOINT = 38;
const CHANGED_WEAPON = 39;

// Movement block bits, relative to a base: 10 for `pre`, 24 for `post`.
const PRE_BASE = 10;
const POST_BASE = 24;
const MOVE_ORIGIN = 0;
const MOVE_VELOCITY = 1;
const MOVE_ANGLES = 2;
const MOVE_BUTTONS_0 = 3;
const MOVE_BUTTONS_1 = 4;
const MOVE_BUTTONS_2 = 5;
const MOVE_JUMP_PRESSED_TIME = 6;
const MOVE_DUCK_SPEED = 7;
const MOVE_DUCK_AMOUNT = 8;
const MOVE_DUCK_OFFSET = 9;
const MOVE_LAST_DUCK_TIME = 10;
const MOVE_REPLAY_FLAGS = 11;
const MOVE_ENTITY_FLAGS = 12;
const MOVE_MOVE_TYPE = 13;

/** Source engine entity flag. Bit 0 of `entityFlags`. */
export const FL_ONGROUND = 1 << 0;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  u8() {
    return this.bytes[this.offset++];
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  skip(count) {
    this.offset += count;
  }

  vec3(target) {
    target[0] = this.view.getFloat32(this.offset, true);
    target[1] = this.view.getFloat32(this.offset + 4, true);
    target[2] = this.view.getFloat32(this.offset + 8, true);
    this.offset += 12;
  }
}

const emptyMovement = () => ({
  origin: [0, 0, 0],
  velocity: [0, 0, 0],
  angles: [0, 0, 0], // QAngle order: pitch, yaw, roll
  buttons: [0, 0, 0],
  jumpPressedTime: 0,
  duckSpeed: 0,
  duckAmount: 0,
  duckOffset: 0,
  lastDuckTime: 0,
  replayFlags: 0, // ducking / ducked / desiresDuck packed into one byte
  entityFlags: 0,
  moveType: 0,
});

const copyMovement = (source) => ({
  ...source,
  origin: [...source.origin],
  velocity: [...source.velocity],
  angles: [...source.angles],
  buttons: [...source.buttons],
});

const readMovement = (reader, state, has, base) => {
  if (has(base + MOVE_ORIGIN)) reader.vec3(state.origin);
  if (has(base + MOVE_VELOCITY)) reader.vec3(state.velocity);
  if (has(base + MOVE_ANGLES)) reader.vec3(state.angles);
  if (has(base + MOVE_BUTTONS_0)) state.buttons[0] = reader.u32();
  if (has(base + MOVE_BUTTONS_1)) state.buttons[1] = reader.u32();
  if (has(base + MOVE_BUTTONS_2)) state.buttons[2] = reader.u32();
  if (has(base + MOVE_JUMP_PRESSED_TIME)) state.jumpPressedTime = reader.f32();
  if (has(base + MOVE_DUCK_SPEED)) state.duckSpeed = reader.f32();
  if (has(base + MOVE_DUCK_AMOUNT)) state.duckAmount = reader.f32();
  if (has(base + MOVE_DUCK_OFFSET)) state.duckOffset = reader.f32();
  if (has(base + MOVE_LAST_DUCK_TIME)) state.lastDuckTime = reader.f32();
  if (has(base + MOVE_REPLAY_FLAGS)) state.replayFlags = reader.u8();
  if (has(base + MOVE_ENTITY_FLAGS)) state.entityFlags = reader.u32();
  if (has(base + MOVE_MOVE_TYPE)) state.moveType = reader.u8();
};

/**
 * Decode the tick section into flat typed arrays.
 *
 * `origin`, `velocity` and `angles` are the post-simulation values, which is what
 * the player actually ended the tick at. Angles are stored as pitch/yaw only;
 * roll is always zero in KZ.
 */
export const decodeTicks = (inflated, elementCount, version) => {
  const reader = new Reader(inflated);

  const out = {
    count: elementCount,
    serverTick: new Int32Array(elementCount),
    gameTime: new Float32Array(elementCount),
    origin: new Float32Array(elementCount * 3),
    velocity: new Float32Array(elementCount * 3),
    pitch: new Float32Array(elementCount),
    yaw: new Float32Array(elementCount),
    forward: new Float32Array(elementCount),
    left: new Float32Array(elementCount),
    up: new Float32Array(elementCount),
    duckAmount: new Float32Array(elementCount),
    entityFlags: new Uint32Array(elementCount),
    buttons: new Uint32Array(elementCount),
    teleportCount: new Int32Array(elementCount),
  };

  // v2 shifted the ModernJump bits down by one, which makes its first bit collide
  // with the weapon bit. compression.cpp reads both on that bit for v2, so we do too.
  const modernBase = version >= 3 ? 40 : 39;
  const hasModernJump = version >= 2;

  let serverTick = 0;
  let gameTime = 0;
  let forward = 0;
  let left = 0;
  let up = 0;
  let teleportCount = 0;
  let previousPost = emptyMovement();

  for (let i = 0; i < elementCount; i++) {
    const flagsLow = reader.u32();
    const flagsHigh = reader.u32();
    const has = (bit) =>
      bit < 32
        ? ((flagsLow >>> bit) & 1) === 1
        : ((flagsHigh >>> (bit - 32)) & 1) === 1;

    serverTick = i === 0 ? 0 : serverTick + 1;

    if (has(CHANGED_SERVER_TICK)) serverTick = reader.u32();
    if (has(CHANGED_GAME_TIME)) gameTime = reader.f32();
    if (has(CHANGED_REAL_TIME)) reader.skip(4);
    if (has(CHANGED_UNIX_TIME)) reader.skip(8);
    if (has(CHANGED_CMD_NUMBER)) reader.skip(4);
    if (has(CHANGED_CLIENT_TICK)) reader.skip(4);
    if (has(CHANGED_FORWARD)) forward = reader.f32();
    if (has(CHANGED_LEFT)) left = reader.f32();
    if (has(CHANGED_UP)) up = reader.f32();
    if (has(CHANGED_LEFT_HANDED)) reader.skip(1);
    if (has(CHANGED_WEAPON)) reader.skip(4);

    const pre = copyMovement(previousPost);
    readMovement(reader, pre, has, PRE_BASE);

    const post = copyMovement(pre);
    readMovement(reader, post, has, POST_BASE);

    if (has(CHANGED_CHECKPOINT)) {
      reader.skip(4); // checkpoint index
      reader.skip(4); // checkpoint count
      teleportCount = reader.i32();
    }

    if (hasModernJump) {
      if (has(modernBase)) reader.skip(8); // lastActualJumpPress tick + frac
      if (has(modernBase + 1)) reader.skip(8); // lastUsableJumpPress tick + frac
      if (has(modernBase + 2)) reader.skip(8 + 12); // lastLanded tick + frac + velocity
    }

    out.serverTick[i] = serverTick;
    out.gameTime[i] = gameTime;
    out.origin[i * 3] = post.origin[0];
    out.origin[i * 3 + 1] = post.origin[1];
    out.origin[i * 3 + 2] = post.origin[2];
    out.velocity[i * 3] = post.velocity[0];
    out.velocity[i * 3 + 1] = post.velocity[1];
    out.velocity[i * 3 + 2] = post.velocity[2];
    out.pitch[i] = post.angles[0];
    out.yaw[i] = post.angles[1];
    out.forward[i] = forward;
    out.left[i] = left;
    out.up[i] = up;
    out.duckAmount[i] = post.duckAmount;
    out.entityFlags[i] = post.entityFlags;
    // Pre and post are sampled either side of movement processing, and a button
    // can be cleared by it. Either side counts as held for this tick.
    out.buttons[i] = pre.buttons[0] | post.buttons[0];
    out.teleportCount[i] = teleportCount;

    previousPost = post;
  }

  if (reader.offset !== inflated.length) {
    throw new Error(
      `tick decoder desynced: consumed ${reader.offset} of ${inflated.length} bytes ` +
        `(${elementCount} ticks, format version ${version}). The flag table in ticks.js ` +
        "no longer matches compression.cpp.",
    );
  }

  return out;
};
