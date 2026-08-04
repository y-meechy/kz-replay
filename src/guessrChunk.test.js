import assert from "node:assert/strict";
import test from "node:test";
import {
  clipTriangleToBox,
  clipPolylineToBox,
  routeCandidateCentres,
  pickChunk,
} from "./guessrChunk.js";

const BOX_MIN = [-10, -10, -10];
const BOX_MAX = [10, 10, 10];

function triangleArea(tri) {
  const [a, b, c] = tri;
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

function assertInsideBox(triangles) {
  for (const tri of triangles) {
    for (const v of tri) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(v[axis] >= BOX_MIN[axis] - 1e-6);
        assert.ok(v[axis] <= BOX_MAX[axis] + 1e-6);
      }
    }
  }
}

test("triangle entirely inside a box passes through unmodified", () => {
  const tri = [
    [1, 1, 1],
    [2, 1, 1],
    [1, 2, 1],
  ];
  const result = clipTriangleToBox(tri, BOX_MIN, BOX_MAX);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], tri);
});

test("triangle entirely outside the box clips to nothing", () => {
  const tri = [
    [100, 100, 100],
    [101, 100, 100],
    [100, 101, 100],
  ];
  const result = clipTriangleToBox(tri, BOX_MIN, BOX_MAX);
  assert.deepEqual(result, []);
});

test("triangle straddling one face clips inside the box with less area", () => {
  const tri = [
    [5, 0, 0],
    [15, 0, 0],
    [5, 10, 0],
  ];
  const result = clipTriangleToBox(tri, BOX_MIN, BOX_MAX);
  assert.ok(result.length > 0);

  assertInsideBox(result);
  let outputArea = 0;
  for (const outTri of result) {
    outputArea += triangleArea(outTri);
  }
  assert.ok(outputArea < triangleArea(tri));
});

test("large floor quad through box centre clips to triangles confined to the box", () => {
  const quad = [
    [
      [-100, 0, -100],
      [100, 0, -100],
      [100, 0, 100],
    ],
    [
      [-100, 0, -100],
      [100, 0, 100],
      [-100, 0, 100],
    ],
  ];
  const results = quad.flatMap((tri) =>
    clipTriangleToBox(tri, BOX_MIN, BOX_MAX),
  );
  assert.ok(results.length > 0);
  assertInsideBox(results);
});

test("clipPolylineToBox clips a segment crossing two opposite faces to one segment on the box surface", () => {
  const points = [
    [-20, 0, 0],
    [20, 0, 0],
  ];
  const segments = clipPolylineToBox(points, BOX_MIN, BOX_MAX);
  assert.equal(segments.length, 1);
  const [a, b] = segments[0];
  assert.ok(
    Math.abs(a[0] - BOX_MIN[0]) < 1e-6 || Math.abs(a[0] - BOX_MAX[0]) < 1e-6,
  );
  assert.ok(
    Math.abs(b[0] - BOX_MIN[0]) < 1e-6 || Math.abs(b[0] - BOX_MAX[0]) < 1e-6,
  );
});

test("routeCandidateCentres ignores lead-in/lead-out ticks and returns the arc-length midpoint first", () => {
  // Straight line along replay X, from x=0 to x=100, padded with idle ticks at
  // both ends that must not affect the arc-length walk.
  const leadIn = 5;
  const leadOut = 5;
  const moving = 101; // x = 0..100 inclusive
  const count = leadIn + moving + leadOut;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < leadIn; i++) {
    positions[i * 3] = 0;
  }
  for (let i = 0; i < moving; i++) {
    positions[(leadIn + i) * 3] = i;
  }
  for (let i = 0; i < leadOut; i++) {
    positions[(leadIn + moving + i) * 3] = 100;
  }

  const centres = routeCandidateCentres(
    positions,
    { leadIn, leadOut, count },
    40,
  );
  // toWorld(x, 0, 0) = [x, 0, 0]; the arc-length midpoint of a straight 0..100
  // run is x=50, and the box-floor drop only affects Y.
  assert.ok(Math.abs(centres[0][0] - 50) < 1e-6);
  assert.equal(centres.length, 7);
});

test("pickChunk returns null when only one node contributes triangles", () => {
  const floor = new Float32Array([
    -50, 0, -50, 50, 0, -50, 50, 0, 50, -50, 0, -50, 50, 0, 50, -50, 0, 50,
  ]);
  const meshes = [
    {
      nodeIndex: 0,
      materialName: "floor",
      min: [-50, 0, -50],
      max: [50, 0, 50],
      triangles: floor,
    },
  ];
  const route = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]);

  const result = pickChunk({
    meshes,
    route,
    tickRange: { leadIn: 0, leadOut: 0, count: 3 },
    size: 40,
    minTriangles: 1,
    minNodes: 3,
  });
  assert.equal(result, null);
});
