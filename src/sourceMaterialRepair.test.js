import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Document } from "@gltf-transform/core";
import { repairSourceMaterialAlpha } from "./sourceMaterialRepair.js";

test("restore source foliage opacity without changing RGB, cutoff or shared opaque material", async () => {
  const document = new Document();
  const rgb = await sharp(Buffer.from([25, 80, 10, 50, 100, 20]), {
    raw: { width: 2, height: 1, channels: 3 },
  })
    .png()
    .toBuffer();
  const raw = await sharp(Buffer.from([200, 200, 200, 0, 200, 200, 200, 255]), {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  const texture = document
    .createTexture()
    .setImage(rgb)
    .setMimeType("image/png");
  const opaque = document.createMaterial("opaque").setBaseColorTexture(texture);
  const leaf = document
    .createMaterial("leaf")
    .setBaseColorTexture(texture)
    .setAlphaMode("MASK")
    .setAlphaCutoff(0.658)
    .setDoubleSided(true)
    .setExtras({
      vmat: {
        ShaderName: "csgo_foliage.vfx",
        TextureParams: { g_tColor: "materials/leaf.vtex" },
      },
    });
  const report = await repairSourceMaterialAlpha(document, async (path) => {
    assert.equal(path, "materials/leaf.vtex");
    return raw;
  });
  assert.equal(report.restored.length, 1);
  assert.equal(report.unresolved.length, 0);
  assert.equal(leaf.getAlphaCutoff(), 0.658);
  assert.equal(leaf.getDoubleSided(), true);
  assert.equal(opaque.getBaseColorTexture(), texture);
  assert.deepEqual(
    [...(await sharp(leaf.getBaseColorTexture().getImage()).raw().toBuffer())],
    [25, 80, 10, 0, 50, 100, 20, 255],
  );
  assert.equal((await sharp(texture.getImage()).metadata()).hasAlpha, false);
});

test("unknown shaders and missing sources are explicit gaps, not invented masks", async () => {
  const document = new Document();
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const material = document
    .createMaterial("unknown")
    .setAlphaMode("MASK")
    .setBaseColorTexture(
      document.createTexture().setImage(png).setMimeType("image/png"),
    )
    .setExtras({
      vmat: {
        ShaderName: "unknown.vfx",
        TextureParams: { g_tColor: "materials/x.vtex" },
      },
    });
  const first = await repairSourceMaterialAlpha(document, () => {
    throw new Error("must not extract unverified channel");
  });
  assert.equal(first.unresolved[0].reason, "unverified-opacity-channel");
  material.setExtras({
    vmat: {
      ShaderName: "csgo_foliage.vfx",
      TextureParams: { g_tColor: "materials/x.vtex" },
    },
  });
  const second = await repairSourceMaterialAlpha(document, async () => {
    throw new Error("missing source");
  });
  assert.equal(second.unresolved[0].reason, "missing source");
});
