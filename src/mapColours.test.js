import test from "node:test";
import assert from "node:assert/strict";
import { isEffectMaterial, isInvisibleMaterial } from "./mapColours.js";

test("god rays are effects, not invisible tool textures", () => {
  assert.equal(isEffectMaterial("materials/effects/godray_01.vmat"), true);
  assert.equal(isInvisibleMaterial("materials/effects/godray_01.vmat"), false);
  assert.equal(isInvisibleMaterial("materials/tools/toolsclip.vmat"), true);
  assert.equal(
    isEffectMaterial("n0_lr0_c0_s_cb_nomerge0_gradient.meshset_0"),
    true,
  );
  assert.equal(isEffectMaterial("materials/props/array_box.vmat"), false);
});
