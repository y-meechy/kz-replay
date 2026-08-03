// Plain {x, y, z} vec3 math, Source space. No three.js dependency so
// movement code can be tested headlessly in node.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

export const copy = (out, a) => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};

export const set = (out, x, y, z) => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const add = (out, a, b) => {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
};

export const sub = (out, a, b) => {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
};

export const scale = (out, a, s) => {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
};

// out = a + b*s
export const addScaled = (out, a, b, s) => {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
};

export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (out, a, b) => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const length = (a) => Math.hypot(a.x, a.y, a.z);

export const length2D = (a) => Math.hypot(a.x, a.y);

// returns the original length
export const normalize = (out, a) => {
  const len = length(a);
  if (len > 1e-12) {
    out.x = a.x / len;
    out.y = a.y / len;
    out.z = a.z / len;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return len;
};

export const distance2DSq = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

// The only three.js touch point in physics code — out is a THREE.Vector3.
export const sourceToRender = (out, s) => out.set(s.x, s.z, -s.y);

export const renderToSource = (out, X, Y, Z) => set(out, X, -Z, Y);
