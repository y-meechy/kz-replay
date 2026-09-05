import test from "node:test";
import assert from "node:assert/strict";
import { parseEntityDump, environmentFromDumps } from "./mapEnvironment.js";

test("compiled UV scale overrides builder defaults; sunlight uses assigned shadow channel", () => {
  const world =
    "m_builderParams={m_vLightmapUvScale=[1,1]} m_worldLightingInfo={m_nLightmapVersionNumber=8 m_nLightmapGameVersionNumber=2 m_vLightmapUvScale=[1.14284,1.14284]} m_entityLumps=[]";
  const entities = parseEntityDump(
    '====1====\nclassname "light_environment"\nangles "90 0 0"\ncolor [255,255,255]\nbrightness 4.0\nbakedshadowindex "2"\nenabled true',
  );
  const env = environmentFromDumps(world, entities);
  assert.deepEqual(env.lightmapUvScale, [1.14284, 1.14284]);
  assert.deepEqual(env.sun.shadowMask, [0, 0, 1, 0]);
  assert.deepEqual(env.sun.color, [4, 4, 4]);
  assert(Math.abs(env.sun.direction[1] - 1) < 1e-12);
  assert.equal(
    environmentFromDumps(
      world.replace("VersionNumber=2", "VersionNumber=1"),
      entities,
    ).sun,
    null,
  );
});
