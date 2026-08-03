// Triangle soup + BVH build + swept-AABB query.
// Self-contained: no imports from vec.js or three. Physics primitive only.

const LEAF_MAX = 8;
const MAX_DEPTH = 40;

/**
 * positions: Float32Array, 9 floats per triangle (v0,v1,v2), Source space.
 * Builds normals/bounds derived from positions, then a median-split BVH
 * over triangle centroids, splitting on the longest axis of the node's bounds.
 */
export const buildBvh = (positions) => {
  const triCount = positions.length / 9;

  const normals = new Float32Array(triCount * 3);
  const bounds = new Float32Array(triCount * 6);
  const centroids = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const v0x = positions[o], v0y = positions[o + 1], v0z = positions[o + 2];
    const v1x = positions[o + 3], v1y = positions[o + 4], v1z = positions[o + 5];
    const v2x = positions[o + 6], v2y = positions[o + 7], v2z = positions[o + 8];

    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    const no = i * 3;
    normals[no] = nx; normals[no + 1] = ny; normals[no + 2] = nz;

    const minx = Math.min(v0x, v1x, v2x);
    const miny = Math.min(v0y, v1y, v2y);
    const minz = Math.min(v0z, v1z, v2z);
    const maxx = Math.max(v0x, v1x, v2x);
    const maxy = Math.max(v0y, v1y, v2y);
    const maxz = Math.max(v0z, v1z, v2z);
    const bo = i * 6;
    bounds[bo] = minx; bounds[bo + 1] = miny; bounds[bo + 2] = minz;
    bounds[bo + 3] = maxx; bounds[bo + 4] = maxy; bounds[bo + 5] = maxz;

    const co = i * 3;
    centroids[co] = (v0x + v1x + v2x) / 3;
    centroids[co + 1] = (v0y + v1y + v2y) / 3;
    centroids[co + 2] = (v0z + v1z + v2z) / 3;
  }

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const nodes = [];

  const computeBoundsFor = (start, count) => {
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = start; i < start + count; i++) {
      const tri = order[i];
      const bo = tri * 6;
      if (bounds[bo] < minx) minx = bounds[bo];
      if (bounds[bo + 1] < miny) miny = bounds[bo + 1];
      if (bounds[bo + 2] < minz) minz = bounds[bo + 2];
      if (bounds[bo + 3] > maxx) maxx = bounds[bo + 3];
      if (bounds[bo + 4] > maxy) maxy = bounds[bo + 4];
      if (bounds[bo + 5] > maxz) maxz = bounds[bo + 5];
    }
    return [minx, miny, minz, maxx, maxy, maxz];
  };

  const build = (start, count, depth) => {
    const [minx, miny, minz, maxx, maxy, maxz] = computeBoundsFor(start, count);
    const nodeIndex = nodes.length;
    const node = { min: [minx, miny, minz], max: [maxx, maxy, maxz], left: -1, right: -1, start, count };
    nodes.push(node);

    if (count <= LEAF_MAX || depth > MAX_DEPTH) {
      return nodeIndex;
    }

    const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz;
    let axis = 0;
    if (dy > dx && dy >= dz) axis = 1;
    else if (dz > dx && dz > dy) axis = 2;

    // Median split on the chosen axis via centroid sort of the [start, start+count) slice.
    const slice = [];
    for (let i = start; i < start + count; i++) slice.push(order[i]);
    slice.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
    for (let i = 0; i < slice.length; i++) order[start + i] = slice[i];

    const mid = count >> 1;
    if (mid === 0 || mid === count) {
      // Degenerate split (all centroids equal): keep as leaf.
      node.count = count;
      return nodeIndex;
    }

    node.count = 0;
    node.left = build(start, mid, depth + 1);
    node.right = build(start + mid, count - mid, depth + 1);
    return nodeIndex;
  };

  const root = triCount > 0 ? build(0, triCount, 0) : -1;

  return { positions, normals, bounds, nodes, order, root, triCount };
};

const boxOverlap = (aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, bMin, bMax) =>
  aMinX <= bMax[0] && aMaxX >= bMin[0] &&
  aMinY <= bMax[1] && aMaxY >= bMin[1] &&
  aMinZ <= bMax[2] && aMaxZ >= bMin[2];

/**
 * Calls visit(triIndex) for every triangle whose AABB overlaps the query box.
 * Iterative stack-based descent, no recursion, reusable Int32Array stack
 * allocated once per BVH (stored on bvh._stack, grown on demand).
 */
export const queryBox = (bvh, min, max, visit) => {
  const { nodes, root, bounds, order } = bvh;
  if (root === -1) return;

  if (!bvh._stack) bvh._stack = new Int32Array(256);
  let stack = bvh._stack;
  let sp = 0;
  stack[sp++] = root;

  const minx = min[0], miny = min[1], minz = min[2];
  const maxx = max[0], maxy = max[1], maxz = max[2];

  while (sp > 0) {
    const nodeIndex = stack[--sp];
    const node = nodes[nodeIndex];

    if (!boxOverlap(minx, miny, minz, maxx, maxy, maxz, node.min, node.max)) continue;

    if (node.left === -1 && node.right === -1) {
      for (let i = node.start; i < node.start + node.count; i++) {
        const tri = order[i];
        const bo = tri * 6;
        if (
          minx <= bounds[bo + 3] && maxx >= bounds[bo] &&
          miny <= bounds[bo + 4] && maxy >= bounds[bo + 1] &&
          minz <= bounds[bo + 5] && maxz >= bounds[bo + 2]
        ) {
          visit(tri);
        }
      }
      continue;
    }

    if (sp + 2 > stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
      bvh._stack = stack;
    }
    if (node.left !== -1) stack[sp++] = node.left;
    if (node.right !== -1) stack[sp++] = node.right;
  }
};
