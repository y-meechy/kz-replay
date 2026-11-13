import assert from "node:assert/strict";
import test from "node:test";
import {
  CUBE_FACES,
  cubeLookup,
  cubeToEquirect,
  sourceDirectionAt,
} from "./skyCube.js";
import { skyNameFromEntities } from "./mapSky.js";

test("skyname is read in both entity lump forms", () => {
  // kz_bhop_majka's env_sky, as Source2Viewer 20.1 decompiles it.
  assert.equal(
    skyNameFromEntities(
      'tint_color [ 255, 255, 255 ]\nskyname resource_name:"materials/skybox/sky58.vmat"\nclassname "env_sky"',
    ),
    "materials/skybox/sky58.vmat",
  );
  assert.equal(
    skyNameFromEntities('skyname "materials/skybox/sky_de_annubis.vmat"'),
    "materials/skybox/sky_de_annubis.vmat",
  );
  assert.equal(skyNameFromEntities('classname "env_sky"'), null);
});

test("Source axes land on the faces their names say", () => {
  assert.equal(cubeLookup(1, 0, 0).face, "rt");
  assert.equal(cubeLookup(-1, 0, 0).face, "lf");
  assert.equal(cubeLookup(0, 1, 0).face, "bk");
  assert.equal(cubeLookup(0, -1, 0).face, "ft");
  assert.equal(cubeLookup(0, 0, 1).face, "up");
  assert.equal(cubeLookup(0, 0, -1).face, "dn");
  for (const [x, y, z] of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const { u, v } = cubeLookup(x, y, z);
    assert.deepEqual([u, v], [0.5, 0.5]);
  }
});

test("equirect pixels follow three's convention in the viewer's world frame", () => {
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  // Image centre is three's +X, which is Source +X.
  assert.ok(close(sourceDirectionAt(0.5, 0.5), [1, 0, 0]));
  // u = 0.25 is three's -Z, which toWorld makes from Source +Y.
  assert.ok(close(sourceDirectionAt(0.25, 0.5), [0, 1, 0]));
  // Top row is straight up.
  assert.ok(Math.abs(sourceDirectionAt(0.3, 0)[2] - 1) < 1e-9);
});

// Every texel painted with whether its own direction is above the horizon, using the
// OpenGL table read backwards. If any face were turned or flipped, the horizon in the
// equirect would break up instead of being one straight row boundary.
const directionOf = (face, u, v) => {
  const sc = u * 2 - 1;
  const tc = v * 2 - 1;
  return {
    rt: [1, -tc, -sc],
    lf: [-1, -tc, sc],
    bk: [sc, 1, tc],
    ft: [sc, -1, -tc],
    up: [sc, -tc, 1],
    dn: [-sc, -tc, -1],
  }[face];
};

test("the horizon is one unbroken line across all six faces", () => {
  const size = 32;
  const faces = {};
  for (const face of CUBE_FACES) {
    const data = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++) {
        const [, , z] = directionOf(
          face,
          (col + 0.5) / size,
          (row + 0.5) / size,
        );
        const o = (row * size + col) * 4;
        data[o] = z > 0 ? 255 : 0;
        data[o + 3] = 255;
      }
    faces[face] = { data, size };
  }
  const { data, width, height } = cubeToEquirect(faces, 128);
  for (let row = 0; row < height; row++) {
    const wanted = row < height / 2 ? 255 : 0;
    // One row either side of the horizon blends across texels.
    if (Math.abs(row - height / 2) <= 1) continue;
    for (let col = 0; col < width; col++)
      assert.equal(
        data[(row * width + col) * 3],
        wanted,
        `row ${row} col ${col}`,
      );
  }
});

test("bad faces and sizes are refused", () => {
  assert.throws(() => cubeToEquirect({}, 64), /missing/);
  const face = { data: new Uint8Array(4 * 4 * 4), size: 4 };
  const faces = Object.fromEntries(CUBE_FACES.map((f) => [f, face]));
  assert.throws(() => cubeToEquirect(faces, 63), /even/);
});
