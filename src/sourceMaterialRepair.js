import sharp from "sharp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { runTool } from "./toolProcess.js";

// VRF 00c629d, Renderer/Shaders/complex.frag.slang:494 uses g_tColor.a
// for these shaders. The fallback glTF export mapping can instead discard alpha
// as an "excess" channel. Do not infer channel semantics for unfamiliar shaders.
const COLOR_ALPHA_SHADERS = new Set([
  "csgo_foliage.vfx",
  "csgo_vertexlitgeneric.vfx",
  "csgo_complex.vfx",
  "csgo_lightmappedgeneric.vfx",
  "csgo_unlitgeneric.vfx",
]);

export const createSourceTextureReader =
  ({ cli, gameDir, workDir }) =>
  async (path) => {
    if (typeof path !== "string" || !path.endsWith(".vtex"))
      throw new Error("Invalid source texture path");
    const root = resolve(gameDir);
    const compiled = resolve(root, `${path}_c`);
    if (!compiled.startsWith(root + sep))
      throw new Error("Source texture escaped the content directory");
    const temporary = await mkdtemp(join(workDir, "material-texture-"));
    try {
      await runTool(cli, [
        "-i",
        compiled,
        "-d",
        "-o",
        join(temporary, "texture.png"),
      ]);
      // VRF chooses the texture's resource basename, not the requested output name.
      return await readFile(join(temporary, `${basename(path, ".vtex")}.png`));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };

/** Restore only proven missing channels, leaving source RGB and sampler state intact. */
export const repairSourceMaterialAlpha = async (document, readTexture) => {
  const audit = { restored: [], unresolved: [] };
  const extracted = new Map();
  for (const material of document.getRoot().listMaterials()) {
    if (!["MASK", "BLEND"].includes(material.getAlphaMode())) continue;
    const texture = material.getBaseColorTexture();
    const source = material.getExtras().vmat;
    if (!texture || !source) continue;
    const exported = await sharp(texture.getImage()).metadata();
    if (exported.hasAlpha) continue;
    const path = source.TextureParams?.g_tColor;
    if (!COLOR_ALPHA_SHADERS.has(source.ShaderName) || !path || !readTexture) {
      audit.unresolved.push({
        material: material.getName(),
        reason: "unverified-opacity-channel",
        shader: source.ShaderName,
      });
      continue;
    }
    try {
      if (!extracted.has(path)) extracted.set(path, readTexture(path));
      const raw = await extracted.get(path);
      const sourceMetadata = await sharp(raw).metadata();
      if (
        !sourceMetadata.hasAlpha ||
        sourceMetadata.width !== exported.width ||
        sourceMetadata.height !== exported.height
      ) {
        throw new Error(
          "Source opacity missing or dimensions differ from exported RGB",
        );
      }
      const alpha = await sharp(raw).extractChannel(3).raw().toBuffer();
      const rgba = await sharp(texture.getImage())
        .joinChannel(alpha, {
          raw: { width: exported.width, height: exported.height, channels: 1 },
        })
        .png()
        .toBuffer();
      const repaired = texture
        .clone()
        .setImage(rgba)
        .setMimeType("image/png")
        .setURI("");
      material.setBaseColorTexture(repaired);
      audit.restored.push({
        material: material.getName(),
        texture: path,
        channel: "a",
        shader: source.ShaderName,
      });
    } catch (error) {
      audit.unresolved.push({
        material: material.getName(),
        texture: path,
        reason: error.message,
      });
    }
  }
  return audit;
};
