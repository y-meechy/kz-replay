import test from "node:test";
import assert from "node:assert/strict";
import { referenceCameraPose } from "../viewer/src/referenceCamera.js";

test("reference camera maps Source eye axes and actual horizontal FOV without an eye-height offset", () => {
  const pose = referenceCameraPose({
    position: [100, 200, 300],
    angles: [0, 90, 0],
    fov: 90,
    fovConvention: "horizontal",
    aspect: 4 / 3,
  });
  assert.deepEqual(pose.position, [100, 300, -200]);
  assert.deepEqual(pose.target, [100, 300, -201]);
  assert(Math.abs(pose.verticalFov - 73.73979529168804) < 1e-10);
  const down = referenceCameraPose({
    position: [0, 0, 0],
    angles: [90, 0, 0],
    fov: 60,
    fovConvention: "vertical",
    aspect: 16 / 9,
  });
  assert(Math.abs(down.target[1] + 1) < 1e-10);
  assert.equal(down.verticalFov, 60);
  assert.throws(
    () =>
      referenceCameraPose({
        position: [0, 0, 0],
        angles: [0, 0, 1],
        fov: 90,
        fovConvention: "vertical",
        aspect: 1,
      }),
    /Rolled/,
  );
});
