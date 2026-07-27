#!/usr/bin/env node

import assert from "node:assert/strict";
import { analyseRun } from "../src/analysis.js";
import { compareRuns } from "../src/compare.js";
import { runBounds } from "../src/events.js";
import { buildTrack, decodeTrack } from "../src/track.js";

const timer = (event, serverTick, time = 0, index = 1) => ({
  kind: "timer",
  event,
  serverTick,
  time,
  index,
});

const makeTicks = (count, stateAt = (i) => ({ x: i })) => {
  const ticks = {
    count,
    serverTick: new Int32Array(count),
    gameTime: new Float32Array(count),
    origin: new Float32Array(count * 3),
    velocity: new Float32Array(count * 3),
    pitch: new Float32Array(count),
    yaw: new Float32Array(count),
    forward: new Float32Array(count),
    left: new Float32Array(count),
    up: new Float32Array(count),
    duckAmount: new Float32Array(count),
    entityFlags: new Uint32Array(count),
    buttons: new Uint32Array(count),
    teleportCount: new Int32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const state = stateAt(i);
    ticks.serverTick[i] = 100 + i;
    ticks.gameTime[i] = i / 64;
    ticks.origin[i * 3] = state.x ?? i;
    ticks.origin[i * 3 + 1] = state.y ?? 0;
    ticks.origin[i * 3 + 2] = state.z ?? 0;
    ticks.velocity[i * 3] = state.vx ?? 100;
    ticks.yaw[i] = state.yaw ?? 0;
    ticks.pitch[i] = state.pitch ?? 0;
    ticks.teleportCount[i] = state.teleports ?? 0;
    ticks.entityFlags[i] = 1;
  }
  return ticks;
};

const replayOf = (ticks, events, reportedTime) => ({
  header: {
    player: { name: "test" },
    map: { name: "test" },
    run: {
      courseName: "Main",
      mode: { name: "classic" },
      styles: [],
      time: reportedTime,
      teleports: ticks.teleportCount[ticks.count - 1],
    },
    version: 5,
  },
  ticks,
  events,
  bounds: runBounds(events, ticks),
});

{
  const ticks = makeTicks(61);
  const events = [
    timer("start", 100),
    timer("pause", 110, 10 / 64),
    timer("resume", 130, 10 / 64),
    timer("end", 150, 30 / 64),
  ];
  const bounds = runBounds(events, ticks);
  assert.equal(bounds.tickIndices.length, 31);
  assert.deepEqual(
    [...bounds.tickIndices],
    [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array.from({ length: 21 }, (_, i) => i + 30),
    ],
  );
  assert.deepEqual(bounds.pausedRanges, [[110, 130]]);
}

{
  const ticks = makeTicks(81);
  const events = [
    timer("resume", 101),
    timer("start", 105),
    timer("resume", 106),
    timer("pause", 110),
    timer("resume", 115),
    timer("pause", 120),
    timer("resume", 120),
    timer("pause", 130),
    timer("end", 140),
  ];
  const bounds = runBounds(events, ticks);
  assert.deepEqual(bounds.pausedRanges, [
    [110, 115],
    [130, 140],
  ]);
  assert.equal(bounds.tickIndices.at(-1), 40);
  assert(!bounds.tickIndices.includes(10));
  assert(bounds.tickIndices.includes(15));
}

{
  const ticks = makeTicks(101);
  const events = [
    timer("start", 100),
    timer("pause", 105),
    timer("resume", 150),
    timer("stop", 160),
    timer("start", 170),
    timer("end", 190, 20 / 64),
  ];
  const bounds = runBounds(events, ticks);
  assert.equal(bounds.startIndex, 70);
  assert.equal(bounds.endIndex, 90);
  assert.equal(bounds.tickIndices.length, 21);
  assert.deepEqual(bounds.pausedRanges, []);
}

{
  const ticks = makeTicks(61, (i) => ({
    x: i < 30 ? i : i - 20,
    yaw: i,
    pitch: i / 2,
    teleports: i >= 20 ? 1 : 0,
  }));
  const events = [
    timer("start", 100),
    timer("pause", 110),
    { kind: "teleport", serverTick: 120 },
    timer("resume", 130),
    timer("end", 150, 30 / 64),
  ];
  const replay = replayOf(ticks, events, 30 / 64);
  const { bytes, stats } = buildTrack(ticks, replay.bounds);
  const track = decodeTrack(bytes.buffer);
  assert.equal(track.count, 31);
  assert.equal(stats.durationSeconds, 30 / 64);
  assert.equal(track.teleports[9], 0);
  assert.equal(track.teleports[10], 1);
  assert(Math.abs(track.positions[10 * 3] - ticks.origin[30 * 3]) < 0.001);
  assert(Math.abs(track.yaw[10] - ticks.yaw[30]) < 0.01);

  const invalid = (mutate) => {
    const copy = bytes.slice();
    mutate(new DataView(copy.buffer), copy);
    return copy.buffer;
  };
  assert.throws(() => decodeTrack(bytes.buffer.slice(0, 39)), /header/);
  assert.throws(
    () => decodeTrack(invalid((view) => view.setUint16(6, 0, true))),
    /tick rate/,
  );
  assert.throws(
    () => decodeTrack(invalid((view) => view.setUint32(8, 1, true))),
    /tick count/,
  );
  assert.throws(
    () => decodeTrack(invalid((view) => view.setUint32(8, 0xffff_ffff, true))),
    /byte length/,
  );
  assert.throws(
    () => decodeTrack(invalid((view) => view.setFloat32(12, NaN, true))),
    /origin/,
  );
  assert.throws(
    () => decodeTrack(invalid((view) => view.setFloat32(24, 0, true))),
    /range/,
  );
  assert.throws(
    () => decodeTrack(invalid((view) => view.setFloat32(28, Infinity, true))),
    /range/,
  );
  assert.throws(
    () => decodeTrack(bytes.buffer.slice(0, bytes.byteLength - 1)),
    /byte length/,
  );
  const trailing = new Uint8Array(bytes.byteLength + 1);
  trailing.set(bytes);
  assert.throws(() => decodeTrack(trailing.buffer), /byte length/);
}

{
  const baselineTicks = makeTicks(101, (i) => ({ x: i * 2 }));
  const baselineEvents = [timer("start", 100), timer("end", 200, 100 / 64)];
  const pausedTicks = makeTicks(121, (i) => ({
    x: (i < 40 ? i : i < 60 ? 40 : i - 20) * 2,
  }));
  const pausedEvents = [
    timer("start", 100),
    timer("pause", 140, 40 / 64),
    timer("resume", 160, 40 / 64),
    timer("end", 220, 100 / 64),
  ];
  const baseline = analyseRun(
    replayOf(baselineTicks, baselineEvents, 100 / 64),
  );
  const paused = analyseRun(replayOf(pausedTicks, pausedEvents, 100 / 64));
  assert.equal(paused.timing.ticks, baseline.timing.ticks);
  assert.equal(paused.timing.durationSeconds, baseline.timing.durationSeconds);
  const comparison = compareRuns(baseline, paused);
  assert(Math.abs(comparison.curve.at(-1).delta) <= 1 / 64);
  assert.equal(comparison.finalDelta, 0);
}

{
  const count = 130_001;
  const ticks = makeTicks(count, (i) => ({
    x: i,
    yaw: (i % 360) - 180,
    pitch: (i % 180) - 90,
  }));
  const events = [
    timer("start", 100),
    timer("end", 100 + count - 1, (count - 1) / 64),
  ];
  const analysis = analyseRun(replayOf(ticks, events, (count - 1) / 64));
  assert.equal(analysis.timing.ticks, count);
  assert.equal(analysis.speed.max, 100);
  assert.equal(analysis.aim.minPitch, -90);
  assert.equal(analysis.aim.maxPitch, 89);
}

console.log("pause compression and large-run checks passed");
