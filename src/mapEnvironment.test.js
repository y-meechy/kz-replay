import test from "node:test";
import assert from "node:assert/strict";
import {
  environmentFromDumps,
  exporterLightmapUvConvention,
  exporterRelease,
  parseEntityDump,
} from "./mapEnvironment.js";
import { isNewerFormatError } from "./geometry.js";

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

test("lightmap UV convention follows measured Source2Viewer releases", () => {
  const version = (release, sha) =>
    `Version: ${release}.6339+${sha}\nOS: Debian GNU/Linux 12 (bookworm) (X64)`;
  assert.deepEqual(
    exporterLightmapUvConvention(
      version("19.2", "c72208352f5bf62f1482447ed166c548f303f8fa"),
    ),
    { bakes: false, verified: true },
  );
  assert.deepEqual(
    exporterLightmapUvConvention(
      version("20.1", "00c629d321171ad0b9be83994c5e9cb15e8c5bd9"),
    ),
    { bakes: true, verified: true },
  );
  assert.deepEqual(exporterLightmapUvConvention(version("20.1", "abc")), {
    bakes: false,
    verified: true,
  });
  // A newer release is assumed to match rather than stopping every conversion.
  assert.deepEqual(exporterLightmapUvConvention(version("21.0", "abc")), {
    bakes: false,
    verified: false,
  });
  assert.deepEqual(exporterLightmapUvConvention("garbage"), {
    bakes: null,
    verified: false,
  });
  assert.equal(exporterRelease(version("20.1", "abc")), "20.1");
  assert.equal(exporterRelease(""), null);
});

test("a map compiled by a newer Source 2 compiler is recognised", () => {
  assert.equal(
    isNewerFormatError(
      "ValveResourceFormat.Utils.UnexpectedMagicException: Unknown KVType for variable 'datatype': 26 (0x1A)",
    ),
    true,
  );
  assert.equal(isNewerFormatError("the exporter produced no world.glb"), false);
});
