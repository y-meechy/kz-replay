// Static map collision: triangle-soup extraction from a loaded GLTF scene, and
// the swept-AABB-vs-triangle tracer everything in movement.js is built on.

import * as THREE from "three";
import { buildBvh, queryBox } from "./bvh.js";
import { renderToSource } from "./vec.js";
import { VRF_UNITS_PER_EXPORTED_METRE, VRF_YAW_CORRECTION } from "../vrfExport.js";
import { DIST_EPSILON } from "./constants.js";

// Which meshes are solid — measured, not guessed (§2.4.1). Filtering by mesh name
// would delete most of the map: `/_cb_|nomerge/i` matches 563 of 629 meshes on
// kz_victoria, since `nomerge`/`_cb_`/`agg`/`meshset` are just Source2Viewer's
// aggregate naming, not clip-brush markers. Filter by material name instead.
const NON_SOLID_MATERIAL = /^gradient|water|^grass\d|branch|leaf|leaves|foliage|overlay|_decal|skybox|^sky_/i;
const TERRAIN_KEEP = /^blend_/i; // blend_grass_sand IS the real terrain — never skip it

const isNonSolid = (name) => !TERRAIN_KEEP.test(name) && NON_SOLID_MATERIAL.test(name);

/**
 * Builds the collision mesh (flat triangle soup + BVH) from a loaded GLTF scene,
 * applying the same mapGroup transform player.js uses so Source-space output
 * lines up with replay positions.
 */
export const buildCollisionFromGltf = (gltfScene) => {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();

  const root = new THREE.Group();
  root.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE);
  root.rotation.y = VRF_YAW_CORRECTION;
  root.add(gltfScene);
  root.updateMatrixWorld(true);

  const verts = [];
  const skippedMaterials = new Set();
  const v = new THREE.Vector3();
  const srcTmp = { x: 0, y: 0, z: 0 };

  gltfScene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;

    const material = Array.isArray(node.material) ? node.material[0] : node.material;
    const materialName = (material && material.name) || "";
    if (isNonSolid(materialName)) {
      skippedMaterials.add(materialName);
      return;
    }

    const geometry = node.geometry;
    const position = geometry.attributes && geometry.attributes.position;
    if (!position) return;

    node.updateMatrixWorld(true);
    const matrixWorld = node.matrixWorld;

    const index = geometry.index;
    const vertexCount = position.count;
    const triCount = index ? index.count / 3 : vertexCount / 3;

    const readVert = (i, out) => {
      v.fromBufferAttribute(position, i);
      v.applyMatrix4(matrixWorld);
      renderToSource(srcTmp, v.x, v.y, v.z);
      out.x = srcTmp.x;
      out.y = srcTmp.y;
      out.z = srcTmp.z;
    };

    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const c = { x: 0, y: 0, z: 0 };

    for (let t = 0; t < triCount; t++) {
      let i0, i1, i2;
      if (index) {
        i0 = index.getX(t * 3);
        i1 = index.getX(t * 3 + 1);
        i2 = index.getX(t * 3 + 2);
      } else {
        i0 = t * 3;
        i1 = t * 3 + 1;
        i2 = t * 3 + 2;
      }
      readVert(i0, a);
      readVert(i1, b);
      readVert(i2, c);
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });

  console.log("[collision] skipped materials (non-solid):", [...skippedMaterials]);

  // Drop degenerate triangles whose cross-product length is < 1e-6.
  const rawTriCount = verts.length / 9;
  const kept = [];
  for (let i = 0; i < rawTriCount; i++) {
    const o = i * 9;
    const v0x = verts[o], v0y = verts[o + 1], v0z = verts[o + 2];
    const v1x = verts[o + 3], v1y = verts[o + 4], v1z = verts[o + 5];
    const v2x = verts[o + 6], v2y = verts[o + 7], v2z = verts[o + 8];
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (Math.hypot(nx, ny, nz) < 1e-6) continue;
    kept.push(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  }

  const positions = new Float32Array(kept);
  const bvh = buildBvh(positions);

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const triCount = positions.length / 9;
  for (let i = 0; i < triCount; i++) {
    const bo = i * 6;
    for (let a = 0; a < 3; a++) {
      if (bvh.bounds[bo + a] < bounds.min[a]) bounds.min[a] = bvh.bounds[bo + a];
      if (bvh.bounds[bo + 3 + a] > bounds.max[a]) bounds.max[a] = bvh.bounds[bo + 3 + a];
    }
  }

  const t1 = (typeof performance !== "undefined" ? performance : Date).now();
  console.log(
    `[collision] built ${triCount} triangles (dropped ${rawTriCount - triCount} degenerate) in ${(t1 - t0).toFixed(1)}ms`
  );

  return { bvh, triangleCount: triCount, bounds };
};

// --- Swept AABB vs triangle by 13-axis SAT ---

const AXES_SCRATCH = new Float64Array(13 * 3);

// Fills AXES_SCRATCH with the 13 test axes for this triangle and returns the count
// of non-degenerate axes actually written, compacted to the front.
const buildAxes = (triNormal, e0x, e0y, e0z, e1x, e1y, e1z, e2x, e2y, e2z) => {
  let n = 0;
  const push = (x, y, z) => {
    AXES_SCRATCH[n * 3] = x;
    AXES_SCRATCH[n * 3 + 1] = y;
    AXES_SCRATCH[n * 3 + 2] = z;
    n++;
  };
  push(1, 0, 0);
  push(0, 1, 0);
  push(0, 0, 1);
  push(triNormal.x, triNormal.y, triNormal.z);
  const boxAxes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const edges = [
    [e0x, e0y, e0z],
    [e1x, e1y, e1z],
    [e2x, e2y, e2z],
  ];
  for (const ba of boxAxes) {
    for (const ed of edges) {
      push(
        ba[1] * ed[2] - ba[2] * ed[1],
        ba[2] * ed[0] - ba[0] * ed[2],
        ba[0] * ed[1] - ba[1] * ed[0]
      );
    }
  }
  return n;
};

/**
 * Builds the collision-query tracer for a given built collision struct.
 * Returns { traceHull(start, end, mins, maxs, out) }.
 */
export const createTracer = (collision) => {
  const { bvh } = collision;
  const { positions, normals } = bvh;

  const traceHull = (start, end, mins, maxs, out) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const dlen = Math.hypot(dx, dy, dz);

    const c0x = start.x + (mins.x + maxs.x) / 2;
    const c0y = start.y + (mins.y + maxs.y) / 2;
    const c0z = start.z + (mins.z + maxs.z) / 2;
    const hx = (maxs.x - mins.x) / 2;
    const hy = (maxs.y - mins.y) / 2;
    const hz = (maxs.z - mins.z) / 2;

    // Query AABB = union of the box at t=0 and t=1, padded by 1 unit.
    const qminx = Math.min(start.x + mins.x, end.x + mins.x) - 1;
    const qminy = Math.min(start.y + mins.y, end.y + mins.y) - 1;
    const qminz = Math.min(start.z + mins.z, end.z + mins.z) - 1;
    const qmaxx = Math.max(start.x + maxs.x, end.x + maxs.x) + 1;
    const qmaxy = Math.max(start.y + maxs.y, end.y + maxs.y) + 1;
    const qmaxz = Math.max(start.z + maxs.z, end.z + maxs.z) + 1;

    let bestT = 1;
    let bestNx = 0, bestNy = 0, bestNz = 0;
    let bestDist = 0;
    let anyHit = false;
    let anyStartSolid = false;

    queryBox(bvh, [qminx, qminy, qminz], [qmaxx, qmaxy, qmaxz], (tri) => {
      const o = tri * 9;
      const v0x = positions[o], v0y = positions[o + 1], v0z = positions[o + 2];
      const v1x = positions[o + 3], v1y = positions[o + 4], v1z = positions[o + 5];
      const v2x = positions[o + 6], v2y = positions[o + 7], v2z = positions[o + 8];
      const no = tri * 3;
      const nnx = normals[no], nny = normals[no + 1], nnz = normals[no + 2];

      const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
      const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
      const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

      // Back-face rejection: sweep moving into the face's back side is skipped.
      const dDotN = dx * nnx + dy * nny + dz * nnz;
      const startSideDot = (c0x - v0x) * nnx + (c0y - v0y) * nny + (c0z - v0z) * nnz;
      if (dDotN > 0 && startSideDot < 0) return;

      const axisCount = buildAxes(
        { x: nnx, y: nny, z: nnz },
        e0x, e0y, e0z,
        e1x, e1y, e1z,
        e2x, e2y, e2z
      );

      let tEnter = 0;
      let tExit = 1;
      let hitAx = 0, hitAy = 0, hitAz = 0;
      let miss = false;
      let isFaceAxis = false;
      let enterIsFace = false;

      for (let ai = 0; ai < axisCount; ai++) {
        const ax = AXES_SCRATCH[ai * 3];
        const ay = AXES_SCRATCH[ai * 3 + 1];
        const az = AXES_SCRATCH[ai * 3 + 2];
        const lenSq = ax * ax + ay * ay + az * az;
        if (lenSq < 1e-12) continue;

        const r = Math.abs(ax) * hx + Math.abs(ay) * hy + Math.abs(az) * hz;
        const d0 = ax * v0x + ay * v0y + az * v0z;
        const d1 = ax * v1x + ay * v1y + az * v1z;
        const d2 = ax * v2x + ay * v2y + az * v2z;
        const lo = Math.min(d0, d1, d2) - r;
        const hi = Math.max(d0, d1, d2) + r;
        const p = ax * c0x + ay * c0y + az * c0z;
        const s = ax * dx + ay * dy + az * dz;

        if (Math.abs(s) < 1e-9) {
          if (p < lo || p > hi) {
            miss = true;
            break;
          }
          continue;
        }

        let t0 = (lo - p) / s;
        let t1 = (hi - p) / s;
        if (t0 > t1) {
          const tmp = t0;
          t0 = t1;
          t1 = tmp;
        }
        if (t0 > tEnter) {
          tEnter = t0;
          hitAx = ax;
          hitAy = ay;
          hitAz = az;
          enterIsFace = ai === 3; // triangle face normal is axis index 3
        }
        if (t1 < tExit) tExit = t1;
        if (tEnter > tExit) {
          miss = true;
          break;
        }
      }

      if (miss) return;
      if (tEnter > 1) return;

      const startSolid = tEnter <= 0 && tExit > 0;
      if (startSolid) anyStartSolid = true;

      if (tEnter < bestT) {
        bestT = tEnter;
        anyHit = true;

        let normX, normY, normZ;
        if (enterIsFace) {
          // Flip the stored face normal to oppose d.
          const dot = nnx * dx + nny * dy + nnz * dz;
          const sign = dot > 0 ? -1 : 1;
          normX = nnx * sign;
          normY = nny * sign;
          normZ = nnz * sign;
        } else {
          let len = Math.hypot(hitAx, hitAy, hitAz);
          if (len < 1e-12) len = 1;
          const dot = hitAx * dx + hitAy * dy + hitAz * dz;
          const sign = dot > 0 ? -1 : 1;
          normX = (hitAx / len) * sign;
          normY = (hitAy / len) * sign;
          normZ = (hitAz / len) * sign;
        }
        bestNx = normX;
        bestNy = normY;
        bestNz = normZ;
        bestDist = normX * v0x + normY * v0y + normZ * v0z;
      }
    });

    if (!anyHit) {
      out.fraction = 1;
      out.endpos = { x: end.x, y: end.y, z: end.z };
      out.plane = { normal: { x: 0, y: 0, z: 0 }, dist: 0 };
      out.startSolid = anyStartSolid;
      out.allSolid = anyStartSolid && dlen < 1e-9;
      out.hit = false;
      return out;
    }

    const fraction = Math.max(0, bestT - DIST_EPSILON / Math.max(dlen, 1e-6));
    out.fraction = fraction;
    out.endpos = {
      x: start.x + dx * fraction,
      y: start.y + dy * fraction,
      z: start.z + dz * fraction,
    };
    out.plane = { normal: { x: bestNx, y: bestNy, z: bestNz }, dist: bestDist };
    out.startSolid = anyStartSolid;
    out.allSolid = anyStartSolid && bestT <= 0 && dlen < 1e-9;
    out.hit = fraction < 1;
    return out;
  };

  return { traceHull };
};

const UNSTUCK_OFFSETS = (() => {
  const offsets = [];
  for (const d of [1, 2, 4, 8, 16]) {
    offsets.push({ x: 0, y: 0, z: d });
    offsets.push({ x: 0, y: 0, z: -d });
    offsets.push({ x: d, y: 0, z: 0 });
    offsets.push({ x: -d, y: 0, z: 0 });
    offsets.push({ x: 0, y: d, z: 0 });
    offsets.push({ x: 0, y: -d, z: 0 });
    const diag = d / Math.SQRT2;
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        offsets.push({ x: sx * diag, y: sy * diag, z: 0 });
      }
    }
  }
  return offsets;
})();

/**
 * Tries a series of offsets (±1,2,4,8,16 along z, then x, y, then the 8 xy
 * diagonals) and returns the first origin where a zero-length trace reports no
 * startSolid, or null if none within 16 units worked.
 */
export const unstuck = (tracer, origin, mins, maxs) => {
  const probe = { fraction: 1, endpos: null, plane: null, startSolid: false, allSolid: false, hit: false };
  tracer.traceHull(origin, origin, mins, maxs, probe);
  if (!probe.startSolid) return origin;

  for (const off of UNSTUCK_OFFSETS) {
    const candidate = { x: origin.x + off.x, y: origin.y + off.y, z: origin.z + off.z };
    tracer.traceHull(candidate, candidate, mins, maxs, probe);
    if (!probe.startSolid) return candidate;
  }
  return null;
};
