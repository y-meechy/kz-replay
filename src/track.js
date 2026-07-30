// The ".kztrack" file: the small, browser-facing shape of a run.
//
// A replay is a few hundred KB of engine state we mostly do not need. A track is
// only what the viewer draws, quantised, so a two minute run is ~140 KB raw and
// far less over the wire. Struct-of-arrays keeps each column smooth, which helps
// gzip and lets the viewer upload positions straight into a buffer.
//
// Layout, little endian:
//
//   0  char[4]  "KZTK"
//   4  u16      format version
//   6  u16      tick rate
//   8  u32      tick count
//  12  f32[3]   position origin (world units)
//  24  f32[3]   position range  (world units)
//  36  u16      lead-in ticks (breathing room recorded before the timer started)
//  38  u16      lead-out ticks (breathing room recorded after the timer ended)
//  40  columns, in COLUMNS order
//
// The lead-in and lead-out were both zero in every file written before they
// existed — the field was reserved padding, always written as zero — so an old
// track decodes as a run with no breathing room, which is exactly what it is.

import { FL_ONGROUND } from "./ticks.js";

const MAGIC = 0x4b54_5a4b; // "KZTK" read as a little-endian u32
const TRACK_VERSION = 1;
const HEADER_BYTES = 40;

/** IN_JUMP, bit 1 of the button mask. */
const IN_JUMP = 1 << 1;

export const TRACK_FLAG = {
  ONGROUND: 1 << 0,
  DUCKING: 1 << 1,
  JUMPING: 1 << 2,
};

// name, typed-array constructor. Order is the on-disk order.
const COLUMNS = [
  ["x", Uint16Array],
  ["y", Uint16Array],
  ["z", Uint16Array],
  ["yaw", Int16Array],
  ["pitch", Int16Array],
  ["speed", Uint16Array],
  ["verticalSpeed", Int16Array],
  ["forward", Int8Array],
  ["left", Int8Array],
  ["flags", Uint8Array],
  ["teleports", Uint16Array],
];

const clamp = (value, min, max) =>
  value < min ? min : value > max ? max : value;

/** How much of the recording either side of the timed run a track keeps, in seconds. */
const PADDING_SECONDS = 3;

/**
 * Turn decoded ticks into a track, trimmed to `startIndex..endIndex` plus a few
 * seconds of breathing room either side — the recording usually reaches back
 * before the timer started and past the finish, and cutting exactly on the
 * timer makes every replay open mid-stride. The header records how many ticks
 * of each kind of padding made it in, so the viewer knows where the run itself
 * begins and ends.
 *
 * Positions are quantised into the run's own bounding box, so precision is
 * ~1/65535 of the run size: well under a millimetre on any real course.
 */
export const buildTrack = (
  ticks,
  bounds,
  { tickRate = 64, paddingSeconds = PADDING_SECONDS } = {},
) => {
  const from = bounds.startIndex;
  const to = bounds.endIndex;
  let tickIndices =
    bounds.tickIndices ??
    Int32Array.from({ length: to - from + 1 }, (_, i) => from + i);

  // Breathing room is raw recorded ticks, straight off the recording: the run
  // itself may skip paused stretches, but nothing outside the run is timed, so
  // there is nothing to skip there. Capped by what was actually recorded, and by
  // what a u16 header field can say.
  const padTicks = Math.min(Math.round(paddingSeconds * tickRate), 65535);
  const leadIn = Math.max(Math.min(padTicks, from), 0);
  const leadOut = Math.max(Math.min(padTicks, ticks.count - 1 - to), 0);
  if (leadIn || leadOut) {
    const padded = new Int32Array(leadIn + tickIndices.length + leadOut);
    for (let i = 0; i < leadIn; i++) padded[i] = from - leadIn + i;
    padded.set(tickIndices, leadIn);
    for (let i = 0; i < leadOut; i++) {
      padded[leadIn + tickIndices.length + i] = to + 1 + i;
    }
    tickIndices = padded;
  }
  const count = tickIndices.length;

  if (count < 2) {
    throw new Error(`run is only ${count} tick(s) long, nothing to draw`);
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of tickIndices) {
    for (let axis = 0; axis < 3; axis++) {
      const value = ticks.origin[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  // A run that never moves on one axis would divide by zero.
  const range = min.map((low, axis) => Math.max(max[axis] - low, 1e-3));

  const columns = {};
  for (const [name, Type] of COLUMNS) {
    columns[name] = new Type(count);
  }

  let topSpeed = 0;
  for (let i = 0; i < count; i++) {
    const tick = tickIndices[i];

    columns.x[i] = Math.round(
      ((ticks.origin[tick * 3] - min[0]) / range[0]) * 65535,
    );
    columns.y[i] = Math.round(
      ((ticks.origin[tick * 3 + 1] - min[1]) / range[1]) * 65535,
    );
    columns.z[i] = Math.round(
      ((ticks.origin[tick * 3 + 2] - min[2]) / range[2]) * 65535,
    );

    columns.yaw[i] = Math.round(
      (clamp(ticks.yaw[tick], -180, 180) / 180) * 32767,
    );
    columns.pitch[i] = Math.round(
      (clamp(ticks.pitch[tick], -90, 90) / 90) * 32767,
    );

    const vx = ticks.velocity[tick * 3];
    const vy = ticks.velocity[tick * 3 + 1];
    const speed = Math.hypot(vx, vy);
    if (speed > topSpeed) topSpeed = speed;
    columns.speed[i] = clamp(Math.round(speed), 0, 65535);
    columns.verticalSpeed[i] = clamp(
      Math.round(ticks.velocity[tick * 3 + 2]),
      -32768,
      32767,
    );

    columns.forward[i] = clamp(
      Math.round(ticks.forward[tick] * 127),
      -128,
      127,
    );
    columns.left[i] = clamp(Math.round(ticks.left[tick] * 127), -128, 127);

    let flags = 0;
    if (ticks.entityFlags[tick] & FL_ONGROUND) flags |= TRACK_FLAG.ONGROUND;
    if (ticks.duckAmount[tick] > 0.5) flags |= TRACK_FLAG.DUCKING;
    if (ticks.buttons[tick] & IN_JUMP) flags |= TRACK_FLAG.JUMPING;
    columns.flags[i] = flags;

    columns.teleports[i] = clamp(ticks.teleportCount[tick], 0, 65535);
  }

  const bytes = new Uint8Array(HEADER_BYTES + byteLength(count));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, TRACK_VERSION, true);
  view.setUint16(6, tickRate, true);
  view.setUint32(8, count, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat32(12 + axis * 4, min[axis], true);
    view.setFloat32(24 + axis * 4, range[axis], true);
  }
  view.setUint16(36, leadIn, true);
  view.setUint16(38, leadOut, true);

  let offset = HEADER_BYTES;
  for (const [name, Type] of COLUMNS) {
    bytes.set(new Uint8Array(columns[name].buffer), offset);
    offset += count * Type.BYTES_PER_ELEMENT;
  }

  return {
    bytes,
    stats: {
      tickCount: count,
      tickRate,
      durationSeconds: (count - 1) / tickRate,
      leadInSeconds: leadIn / tickRate,
      leadOutSeconds: leadOut / tickRate,
      runDurationSeconds: (count - 1 - leadIn - leadOut) / tickRate,
      topSpeed: Math.round(topSpeed),
      bboxMin: min,
      bboxMax: max,
      bytesPerTick: byteLength(1),
    },
  };
};

const byteLength = (count) =>
  COLUMNS.reduce(
    (total, [, Type]) => total + count * Type.BYTES_PER_ELEMENT,
    0,
  );

/** Read a track back. Shared with the viewer, so it must stay dependency-free. */
export const decodeTrack = (buffer) => {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(
      `truncated .kztrack header: got ${buffer.byteLength} bytes, expected at least ${HEADER_BYTES}`,
    );
  }

  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error("not a .kztrack file");
  }
  const version = view.getUint16(4, true);
  if (version !== TRACK_VERSION) {
    throw new Error(
      `track format version ${version}, expected ${TRACK_VERSION}`,
    );
  }

  const tickRate = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  if (tickRate === 0) {
    throw new Error("invalid .kztrack tick rate 0");
  }
  if (count < 2) {
    throw new Error(`invalid .kztrack tick count ${count}`);
  }

  const bytesPerTick = byteLength(1);
  const expectedBytes = HEADER_BYTES + count * bytesPerTick;
  if (!Number.isSafeInteger(expectedBytes)) {
    throw new Error(`.kztrack byte length overflows for ${count} ticks`);
  }
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `invalid .kztrack byte length: got ${buffer.byteLength}, expected ${expectedBytes} for ${count} ticks`,
    );
  }

  const origin = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  const range = [
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  ];
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(origin[axis])) {
      throw new Error(`invalid .kztrack origin on axis ${axis}`);
    }
    if (!Number.isFinite(range[axis]) || range[axis] <= 0) {
      throw new Error(`invalid .kztrack range on axis ${axis}`);
    }
  }

  let leadIn = view.getUint16(36, true);
  let leadOut = view.getUint16(38, true);
  if (leadIn + leadOut >= count) {
    // Padding cannot be the whole track. Treat nonsense as "no breathing room"
    // rather than refusing a file whose run data is fine.
    leadIn = 0;
    leadOut = 0;
  }

  const columns = {};
  let offset = HEADER_BYTES;
  for (const [name, Type] of COLUMNS) {
    // Copy rather than view: the header size does not guarantee alignment forever.
    columns[name] = new Type(
      buffer.slice(offset, offset + count * Type.BYTES_PER_ELEMENT),
    );
    offset += count * Type.BYTES_PER_ELEMENT;
  }

  // Dequantise into world units once, so the viewer never thinks about encoding.
  const positions = new Float32Array(count * 3);
  const yaw = new Float32Array(count);
  const pitch = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = origin[0] + (columns.x[i] / 65535) * range[0];
    positions[i * 3 + 1] = origin[1] + (columns.y[i] / 65535) * range[1];
    positions[i * 3 + 2] = origin[2] + (columns.z[i] / 65535) * range[2];
    yaw[i] = (columns.yaw[i] / 32767) * 180;
    pitch[i] = (columns.pitch[i] / 32767) * 90;
  }

  return {
    tickRate,
    count,
    durationSeconds: (count - 1) / tickRate,
    // The breathing room either side of the timed run, in ticks. Zero on old
    // files, so everything downstream can rely on them without checking.
    leadIn,
    leadOut,
    runDurationSeconds: (count - 1 - leadIn - leadOut) / tickRate,
    positions,
    yaw,
    pitch,
    speed: columns.speed,
    verticalSpeed: columns.verticalSpeed,
    forward: columns.forward,
    left: columns.left,
    flags: columns.flags,
    teleports: columns.teleports,
  };
};
