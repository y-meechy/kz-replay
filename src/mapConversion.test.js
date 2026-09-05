import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from "@gltf-transform/extensions";
import { trimMap } from "./trimMap.js";
import { publishMapAssets, publishedGeometryPath } from "./mapAssets.js";
import { resolveMapQuality } from "./mapQuality.js";

test("fidelity conversion preserves foliage, source material/extension, tangents and colours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fidelity-conversion-"));
  const doc = new Document();
  const buffer = doc.createBuffer();
  const attribute = (type, values) =>
    doc
      .createAccessor()
      .setType(type)
      .setArray(new Float32Array(values))
      .setBuffer(buffer);
  const position = attribute(
    "VEC3",
    Array.from({ length: 1800 }, (_, i) => (i % 3 === 0 ? i / 3 : 0)),
  );
  const normal = attribute(
    "VEC3",
    Array.from({ length: 1800 }, (_, i) => Number(i % 3 === 2)),
  );
  const tangent = attribute(
    "VEC4",
    Array.from({ length: 2400 }, (_, i) => Number(i % 4 === 0 || i % 4 === 3)),
  );
  const colors = attribute("VEC4", new Array(2400).fill(0.7));
  const uv = attribute("VEC2", new Array(1200).fill(0.25));
  const unlit = doc.createExtension(KHRMaterialsUnlit).createUnlit();
  const material = doc
    .createMaterial("authored-solid")
    .setBaseColorFactor([0.7, 0.2, 0.1, 0.5])
    .setAlphaMode("MASK")
    .setAlphaCutoff(0.3)
    .setDoubleSided(true)
    .setExtension("KHR_materials_unlit", unlit);
  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setAttribute("TANGENT", tangent)
    .setAttribute("COLOR_0", colors)
    .setAttribute("TEXCOORD_0", uv)
    .setAttribute("TEXCOORD_1", uv)
    .setMaterial(material);
  const mesh = doc.createMesh("poplar_leaf_0").addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await io.write(join(dir, "raw.glb"), doc);
  const report = await trimMap({
    input: join(dir, "raw.glb"),
    output: join(dir, "trim.glb"),
    withTextures: true,
    lightmap: { irradiance: { width: 4, height: 4 } },
    lightmapUvScale: [2, 2],
  });
  assert.equal(report.meshesRemoved, 0);
  assert.equal(report.trianglesRetained, 200);
  const result = await io.read(join(dir, "trim.glb"));
  const p = result.getRoot().listMeshes()[0].listPrimitives()[0];
  assert(p.getAttribute("TANGENT"));
  assert(p.getAttribute("COLOR_0"));
  assert.equal(p.getAttribute("TEXCOORD_0").getArray()[0], 0.25);
  assert.equal(p.getAttribute("TEXCOORD_1").getArray()[0], 0.5);
  assert.equal(p.getExtras().kzLightmapUv, 1);
  assert.deepEqual(p.getMaterial().getBaseColorFactor(), [0.7, 0.2, 0.1, 0.5]);
  assert.equal(p.getMaterial().getDoubleSided(), true);
  assert(p.getMaterial().getExtension("KHR_materials_unlit"));
});

test("immutable publication preserves old assets and never retains stale sidecars", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fidelity-publish-"));
  const sourcePath = join(dir, "input.bin");
  await writeFile(sourcePath, "first");
  await writeFile(join(dir, "kz_test.glb"), "legacy");
  const args = {
    outputDir: dir,
    mapName: "kz_test",
    source: { id: 1 },
    converter: { version: 2 },
    audit: {},
    files: {
      geometry: { sourcePath, fileName: "map.glb" },
      sky: { sourcePath, fileName: "sky.exr" },
    },
  };
  const first = await publishMapAssets(args);
  await writeFile(sourcePath, "second");
  const second = await publishMapAssets({
    ...args,
    files: { geometry: args.files.geometry, sky: null },
  });
  assert.notEqual(first.revision, second.revision);
  assert.equal(await readFile(first.paths.geometry, "utf8"), "first");
  assert.equal(await readFile(join(dir, "kz_test.glb"), "utf8"), "legacy");
  assert.equal(second.manifest.revisions[second.revision].files.sky, null);
  assert.equal(
    await publishedGeometryPath(dir, "kz_test"),
    second.paths.geometry,
  );
  await assert.rejects(
    publishMapAssets({
      ...args,
      files: {
        geometry: { sourcePath: join(dir, "missing"), fileName: "map.glb" },
      },
    }),
  );
  assert.equal(
    await publishedGeometryPath(dir, "kz_test"),
    second.paths.geometry,
  );
  await assert.rejects(
    publishMapAssets({ ...args, mapName: "../bad" }),
    /Invalid map name/,
  );
});

test("the default profile does not reduce detail or simplify geometry by file size", () => {
  const defaults = resolveMapQuality();
  assert.equal(defaults.dropFoliage, false);
  assert.equal(defaults.textureSize, null);
  assert.equal(defaults.lightmapSize, null);
  assert.equal(defaults.simplifyError, null);
  assert.equal(resolveMapQuality({ profile: "legacy" }).dropFoliage, true);
});
