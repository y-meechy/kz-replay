// Pure geometry helpers for the map-guessr minigame: turning glTF-exported map
// meshes and a replay route into small "guess the chunk" boxes. No I/O here —
// callers own reading meshes/replays and writing chunk manifests.

import {
  VRF_UNITS_PER_EXPORTED_METRE,
  VRF_YAW_CORRECTION,
} from "../viewer/src/vrfExport.js";

const YAW_COS = Math.cos(VRF_YAW_CORRECTION);
const YAW_SIN = Math.sin(VRF_YAW_CORRECTION);

// Source2Viewer's node matrices and yaw offset only make sense combined with the
// scale/rotation constants that live next to the viewer's own map loader — see
// viewer/src/vrfExport.js for why these particular numbers.
export function toViewerSpace(out, v, nodeMatrix) {
  const [x, y, z] = v;
  const m = nodeMatrix;
  let px = m[0] * x + m[4] * y + m[8] * z + m[12];
  let py = m[1] * x + m[5] * y + m[9] * z + m[13];
  let pz = m[2] * x + m[6] * y + m[10] * z + m[14];

  px *= VRF_UNITS_PER_EXPORTED_METRE;
  py *= VRF_UNITS_PER_EXPORTED_METRE;
  pz *= VRF_UNITS_PER_EXPORTED_METRE;

  const rx = YAW_COS * px + YAW_SIN * pz;
  const rz = -YAW_SIN * px + YAW_COS * pz;

  out[0] = rx;
  out[1] = py;
  out[2] = rz;
  return out;
}

export function boxAt(centre, size) {
  const half = size / 2;
  return {
    min: [centre[0] - half, centre[1] - half, centre[2] - half],
    max: [centre[0] + half, centre[1] + half, centre[2] + half],
  };
}

// True when every vertex of tri is inside [min, max] on all three axes.
function fullyInside(tri, min, max) {
  for (const v of tri) {
    for (let axis = 0; axis < 3; axis++) {
      if (v[axis] < min[axis] || v[axis] > max[axis]) return false;
    }
  }
  return true;
}

// True when every vertex of tri is outside the box on the same side of one axis
// (a cheap reject; Sutherland-Hodgman below still handles the general case).
function fullyOutside(tri, min, max) {
  for (let axis = 0; axis < 3; axis++) {
    if (tri.every((v) => v[axis] < min[axis])) return true;
    if (tri.every((v) => v[axis] > max[axis])) return true;
  }
  return false;
}

// One Sutherland-Hodgman clip against a single axis-aligned plane, defined by
// which axis, the plane's offset, and whether "inside" means >= or <=.
function clipPolygonToPlane(poly, axis, value, keepGreaterEqual) {
  if (poly.length === 0) return poly;
  const inside = (v) =>
    keepGreaterEqual ? v[axis] >= value : v[axis] <= value;
  const output = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const currIn = inside(curr);
    const prevIn = inside(prev);
    if (currIn) {
      if (!prevIn) {
        output.push(intersectPlane(prev, curr, axis, value));
      }
      output.push(curr);
    } else if (prevIn) {
      output.push(intersectPlane(prev, curr, axis, value));
    }
  }
  return output;
}

function intersectPlane(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
    a[2] + t * (b[2] - a[2]),
  ];
}

function crossLength(a, b, c) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

export function clipTriangleToBox(tri, min, max) {
  if (fullyInside(tri, min, max)) return [tri];
  if (fullyOutside(tri, min, max)) return [];

  let poly = tri;
  poly = clipPolygonToPlane(poly, 0, min[0], true); // -x
  poly = clipPolygonToPlane(poly, 0, max[0], false); // +x
  poly = clipPolygonToPlane(poly, 1, min[1], true); // -y
  poly = clipPolygonToPlane(poly, 1, max[1], false); // +y
  poly = clipPolygonToPlane(poly, 2, min[2], true); // -z
  poly = clipPolygonToPlane(poly, 2, max[2], false); // +z

  if (poly.length < 3) return [];

  const triangles = [];
  for (let i = 1; i < poly.length - 1; i++) {
    const out = [poly[0], poly[i], poly[i + 1]];
    // Clipping against near-parallel planes produces zero-area slivers; drop them.
    if (crossLength(out[0], out[1], out[2]) >= 1e-3) triangles.push(out);
  }
  return triangles;
}

// Liang-Barsky slab clipping of a single segment against an axis-aligned box.
function clipSegmentToBox(a, b, min, max) {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];

  // One slab plane: p is the direction along the plane's inward normal, q the
  // signed distance from a to the plane. Returns false when the segment is
  // wholly outside and the whole clip can stop.
  const clipToPlane = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  for (let axis = 0; axis < 3; axis++) {
    if (!clipToPlane(-d[axis], a[axis] - min[axis])) return null;
    if (!clipToPlane(d[axis], max[axis] - a[axis])) return null;
  }

  if (t0 > t1) return null;
  return [
    [a[0] + t0 * d[0], a[1] + t0 * d[1], a[2] + t0 * d[2]],
    [a[0] + t1 * d[0], a[1] + t1 * d[1], a[2] + t1 * d[2]],
  ];
}

export function clipPolylineToBox(points, min, max) {
  const segments = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const clipped = clipSegmentToBox(points[i], points[i + 1], min, max);
    if (clipped) segments.push(clipped);
  }
  return segments;
}

// Replay positions are game-space (x, y, z); the viewer's world is (x, z, -y).
// Lead-in/lead-out ticks idle at spawn/finish and would bias every candidate
// toward a boring, motionless chunk, so they're excluded.
function routeWorldPoints(positions, { leadIn, leadOut, count }) {
  const points = [];
  for (let i = leadIn; i < count - leadOut; i++) {
    points.push([
      positions[i * 3],
      positions[i * 3 + 2],
      -positions[i * 3 + 1],
    ]);
  }
  return points;
}

export function routeCandidateCentres(positions, tickRange, size) {
  const worldPoints = routeWorldPoints(positions, tickRange);
  if (worldPoints.length === 0) return [];

  const cumulative = [0];
  for (let i = 1; i < worldPoints.length; i++) {
    const a = worldPoints[i - 1];
    const b = worldPoints[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const total = cumulative[cumulative.length - 1];

  const pointAtFraction = (fraction) => {
    const target = total * fraction;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return worldPoints[0];
    const a = worldPoints[lo - 1];
    const b = worldPoints[lo];
    const segLen = cumulative[lo] - cumulative[lo - 1];
    const t = segLen === 0 ? 0 : (target - cumulative[lo - 1]) / segLen;
    return [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      a[2] + t * (b[2] - a[2]),
    ];
  };

  const drop = size * 0.15;
  return [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((fraction) => {
    const point = pointAtFraction(fraction);
    return [point[0], point[1] - drop, point[2]];
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function bboxOverlapsBox(meshMin, meshMax, min, max) {
  for (let axis = 0; axis < 3; axis++) {
    if (meshMax[axis] < min[axis] || meshMin[axis] > max[axis]) return false;
  }
  return true;
}

export function extractChunk({ meshes, route, centre, size }) {
  const { min, max } = boxAt(centre, size);
  // Chunk geometry ships centred on the origin, rounded to keep manifests small.
  const pushLocal = (into, v) => {
    into.push(
      round2(v[0] - centre[0]),
      round2(v[1] - centre[1]),
      round2(v[2] - centre[2]),
    );
  };
  const positions = [];
  let triangleCount = 0;
  let nodeCount = 0;

  for (const mesh of meshes) {
    if (!bboxOverlapsBox(mesh.min, mesh.max, min, max)) continue;

    let contributed = false;
    const verts = mesh.triangles;
    for (let i = 0; i + 9 <= verts.length; i += 9) {
      const tri = [
        [verts[i], verts[i + 1], verts[i + 2]],
        [verts[i + 3], verts[i + 4], verts[i + 5]],
        [verts[i + 6], verts[i + 7], verts[i + 8]],
      ];
      const clipped = clipTriangleToBox(tri, min, max);
      for (const outTri of clipped) {
        for (const v of outTri) {
          pushLocal(positions, v);
        }
        triangleCount++;
        contributed = true;
      }
    }
    if (contributed) nodeCount++;
  }

  const routePoints = [];
  for (let i = 0; i + 2 < route.length; i += 3) {
    routePoints.push([route[i], route[i + 1], route[i + 2]]);
  }
  const clippedSegments = clipPolylineToBox(routePoints, min, max);
  const routePositions = [];
  for (const [a, b] of clippedSegments) {
    pushLocal(routePositions, a);
    pushLocal(routePositions, b);
  }

  return {
    positions,
    routePositions,
    triangles: triangleCount,
    nodeCount,
  };
}

export function pickChunk({
  meshes,
  route,
  tickRange,
  size,
  minTriangles = 24,
  // Roughly "about 3 brushes" worth of geometry: rejects chunks that are just a
  // lone floor slab, which technically has triangles but no readable shape.
  minNodes = 3,
}) {
  const centres = routeCandidateCentres(route, tickRange, size);
  const routeWorld = routeWorldPoints(route, tickRange).flat();

  for (const centre of centres) {
    const result = extractChunk({ meshes, route: routeWorld, centre, size });
    if (result.triangles >= minTriangles && result.nodeCount >= minNodes) {
      return { ...result, centre };
    }
  }
  return null;
}
