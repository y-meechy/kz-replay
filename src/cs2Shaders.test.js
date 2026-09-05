import test from "node:test";
import assert from "node:assert/strict";
import { shaderArchiveNames } from "./cs2Shaders.js";

test("select complete Vulkan shader archives only from known Source game search roots", () => {
  const paths = [
    "game/csgo/shaders_vulkan_dir.vpk",
    "game/csgo_core/shaders_vulkan_001.vpk",
    "game/core/shaders_vulkan_000.vpk",
    "game/csgo/pak01_000.vpk",
    "game/csgo/shaders_pc_000.vpk",
    "game/csgo/shaders_vulkan_../escape.vpk",
    "game/custom/shaders_vulkan_dir.vpk",
  ];
  assert.deepEqual(
    shaderArchiveNames(new Map(paths.map((path) => [path, {}]))),
    paths.slice(0, 3).sort(),
  );
});
