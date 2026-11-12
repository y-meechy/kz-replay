// An 8-bit Source 2 sky cubemap, turned into the equirectangular image the viewer
// draws as its background.
//
// The HDR path (mapSky.js) gets a latlong EXR straight from Source2Viewer. An LDR
// cubemap — kz_bhop_majka's `sky58_png_*.vtex` — only decodes to six PNG faces, named
// rt, lf, bk, ft, up, dn. Their layout is the OpenGL cube-face convention applied to
// Source's own Z-up axes: rt = +X, lf = -X, bk = +Y, ft = -Y, up = +Z, dn = -Z. That is
// what makes the rt and lf faces show the horizon running vertically, and it is checked
// by the horizon meeting itself across all four side faces (see skyCube.test.js and
// docs/viewer.md).
//
// The output uses three.js's own equirectangular convention in the viewer's world
// frame (Source x, y, z drawn as x, z, -y; see player.js toWorld), so the viewer shows
// it with no background rotation.

export const CUBE_FACES = ["rt", "lf", "bk", "ft", "up", "dn"];

/**
 * Which face a Source-space direction hits, and where, by the OpenGL table.
 *
 * @returns { face, u, v } with u, v in [0, 1] and v = 0 at the image's top row.
 */
export const cubeLookup = (x, y, z) => {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face;
  let sc;
  let tc;
  let ma;
  if (ax >= ay && ax >= az) {
    ma = ax;
    if (x > 0) [face, sc, tc] = ["rt", -z, -y];
    else [face, sc, tc] = ["lf", z, -y];
  } else if (ay >= az) {
    ma = ay;
    if (y > 0) [face, sc, tc] = ["bk", x, z];
    else [face, sc, tc] = ["ft", x, -z];
  } else {
    ma = az;
    if (z > 0) [face, sc, tc] = ["up", x, -y];
    else [face, sc, tc] = ["dn", -x, -y];
  }
  return { face, u: (sc / ma + 1) / 2, v: (tc / ma + 1) / 2 };
};

/**
 * The Source-space direction behind one equirectangular pixel, as three.js samples it:
 * u = atan(dir.z, dir.x) / 2π + 0.5 and v = asin(dir.y) / π + 0.5 in the viewer's
 * world, with image row 0 at the top (v = 1).
 */
export const sourceDirectionAt = (u, row01) => {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (0.5 - row01) * Math.PI;
  const wx = Math.cos(theta) * Math.cos(phi);
  const wy = Math.sin(theta);
  const wz = Math.cos(theta) * Math.sin(phi);
  // Inverse of toWorld(x, y, z) = [x, z, -y].
  return [wx, -wz, wy];
};

/**
 * Resample six square RGBA faces into an equirectangular RGB image.
 *
 * @param faces { rt, lf, bk, ft, up, dn } each { data: Uint8Array RGBA, size }
 * @param width output width; height is width / 2
 * @returns { data: Uint8Array RGB, width, height }
 */
export const cubeToEquirect = (faces, width) => {
  for (const name of CUBE_FACES) {
    const face = faces[name];
    if (!face || face.data.length !== face.size * face.size * 4)
      throw new Error(`Sky cube face ${name} is missing or not square RGBA`);
  }
  const height = width / 2;
  if (!Number.isInteger(height) || height < 1)
    throw new Error("Equirectangular width must be a positive even number");
  const out = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [x, y, z] = sourceDirectionAt(
        (col + 0.5) / width,
        (row + 0.5) / height,
      );
      const { face, u, v } = cubeLookup(x, y, z);
      const { data, size } = faces[face];
      // Bilinear, clamped inside the face: seams are where faces meet anyway.
      const fx = Math.min(Math.max(u * size - 0.5, 0), size - 1);
      const fy = Math.min(Math.max(v * size - 0.5, 0), size - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, size - 1);
      const y1 = Math.min(y0 + 1, size - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const o = (row * width + col) * 3;
      for (let c = 0; c < 3; c++) {
        const p = (xx, yy) => data[(yy * size + xx) * 4 + c];
        const top = p(x0, y0) * (1 - tx) + p(x1, y0) * tx;
        const bottom = p(x0, y1) * (1 - tx) + p(x1, y1) * tx;
        out[o + c] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return { data: out, width, height };
};
