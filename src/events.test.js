import assert from "node:assert/strict";
import test from "node:test";
import { decodeEvents } from "./events.js";

// Hand-rolled proto2 encoding, enough for the v6 `ReplayEvent` messages below.
const varint = (value) => {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return bytes;
};
const field = (number, value) => [...varint(number << 3), ...varint(value)];
const float = (number, value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return [...varint((number << 3) | 5), ...bytes];
};
const message = (number, body) => [
  ...varint((number << 3) | 2),
  ...varint(body.length),
  ...body,
];
const origin = message(4, [...float(1, 1), ...float(2, 2), ...float(3, 3)]);
const timer = (serverTick, type, index, time) => [
  ...field(1, 0),
  ...field(2, serverTick),
  ...field(3, 1),
  ...message(4, [
    ...field(1, type),
    ...field(2, index),
    ...float(3, time),
    ...origin,
  ]),
];
const section = (events) =>
  Uint8Array.from(
    events.flatMap((event) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(event.length);
      return [...length, ...event];
    }),
  );

test("decodes v6 length-prefixed protobuf events", () => {
  const events = decodeEvents(
    section([
      timer(100, 0, 1, 0),
      [...field(1, 4), ...field(2, 120), ...message(8, field(1, 1))],
      [...field(1, 3), ...field(2, 130), ...message(7, field(1, 0))],
      [...field(1, 99), ...field(2, 140)],
      timer(150, 2, -1, 0.5),
      timer(200, 1, 1, 1.5),
    ]),
    6,
    6,
  );

  assert.deepEqual(events, [
    { kind: "timer", serverTick: 100, event: "start", index: 1, time: 0 },
    { kind: "checkpoint", serverTick: 120 },
    { kind: "teleport", serverTick: 130 },
    { kind: "unknown", serverTick: 140, type: 99 },
    { kind: "timer", serverTick: 150, event: "stop", index: -1, time: 0.5 },
    { kind: "timer", serverTick: 200, event: "end", index: 1, time: 1.5 },
  ]);
});

test("refuses a v6 events section that does not end on its last byte", () => {
  const bytes = section([timer(100, 0, 1, 0)]);
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  assert.throws(() => decodeEvents(padded, 1, 6), /desynced/);
  assert.throws(
    () => decodeEvents(bytes.subarray(0, bytes.length - 1), 1, 6),
    /claims/,
  );
});
