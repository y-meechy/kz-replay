import assert from "node:assert/strict";

import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { Matrix4, Scene } from "three";

import { decodeTrack } from "../src/track.js";
import { finiteExtent } from "../viewer/src/charts.js";
import {
  createTeleportMarkers,
  maxTrackSpeed,
  worldPointsOf,
} from "../viewer/src/player.js";

const TICK_COUNT = 130_000;
const HEADER_BYTES = 40;
const BYTES_PER_TICK = 19;
const MAGIC = 0x4b54_5a4b;

const bytes = new Uint8Array(HEADER_BYTES + TICK_COUNT * BYTES_PER_TICK);
const view = new DataView(bytes.buffer);
view.setUint32(0, MAGIC, true);
view.setUint16(4, 1, true);
view.setUint16(6, 64, true);
view.setUint32(8, TICK_COUNT, true);
view.setFloat32(24, 1, true);
view.setFloat32(28, 1, true);
view.setFloat32(32, 1, true);

const x = new Uint16Array(bytes.buffer, HEADER_BYTES, TICK_COUNT);
for (let i = 0; i < TICK_COUNT; i++) {
  x[i] = Math.round((i / (TICK_COUNT - 1)) * 65_535);
}

// x/y/z, yaw and pitch occupy ten bytes per tick before the speed column.
const speed = new Uint16Array(
  bytes.buffer,
  HEADER_BYTES + TICK_COUNT * 10,
  TICK_COUNT,
);
speed.fill(400);
speed[TICK_COUNT - 1] = 65_535;

// Teleports are the final two-byte column. Alternating creates 65,000 visible
// increments without overflowing its uint16 counter.
const teleports = new Uint16Array(
  bytes.buffer,
  HEADER_BYTES + TICK_COUNT * 17,
  TICK_COUNT,
);
for (let i = 0; i < TICK_COUNT; i++) teleports[i] = i % 2;

const track = decodeTrack(bytes.buffer);
assert.equal(track.count, TICK_COUNT);
assert.equal(maxTrackSpeed(track.speed), 65_535);
assert.deepEqual(finiteExtent(track.speed), {
  min: 400,
  max: 65_535,
  count: TICK_COUNT,
});

const points = worldPointsOf(track);
assert(points instanceof Float32Array);
assert.equal(points.length, TICK_COUNT * 3);

const geometry = new LineGeometry().setPositions(points);
assert.equal(geometry.attributes.instanceStart.count, TICK_COUNT - 1);
geometry.dispose();

const teleportMarkers = createTeleportMarkers(track);
assert(teleportMarkers?.isInstancedMesh);
assert.equal(teleportMarkers.count, TICK_COUNT / 2);
const firstTeleport = new Matrix4();
const lastTeleport = new Matrix4();
teleportMarkers.getMatrixAt(0, firstTeleport);
teleportMarkers.getMatrixAt(teleportMarkers.count - 1, lastTeleport);
assert.equal(firstTeleport.elements[12], track.positions[3]);
assert.equal(lastTeleport.elements[12], track.positions[(TICK_COUNT - 1) * 3]);

// Every location remains visible, but all of them are one scene object and one
// instanced draw call. The normal player traversal also disposes both resources.
const scene = new Scene();
scene.add(teleportMarkers);
assert.equal(scene.children.length, 1);
let geometryDisposals = 0;
let materialDisposals = 0;
teleportMarkers.geometry.addEventListener(
  "dispose",
  () => (geometryDisposals += 1),
);
teleportMarkers.material.addEventListener(
  "dispose",
  () => (materialDisposals += 1),
);
scene.traverse((object) => {
  object.geometry?.dispose?.();
  object.material?.dispose?.();
});
assert.equal(geometryDisposals, 1);
assert.equal(materialDisposals, 1);

console.log(
  `large-track check passed: ${TICK_COUNT.toLocaleString()} decoded ticks, ${teleportMarkers.count.toLocaleString()} teleports in one mesh`,
);
