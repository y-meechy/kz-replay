import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { findCachedManifest, readManifestFiles } from "./cs2Manifest.js";
import { fingerprintFile } from "./mapAssets.js";
import { runTool } from "./toolProcess.js";

export const shaderArchiveNames = (files) =>
  [...files.keys()]
    .filter((name) =>
      /^game\/(?:csgo|csgo_core|core)\/shaders_vulkan_(?:dir|\d{3})\.vpk$/.test(
        name,
      ),
    )
    .sort();

/**
 * VRF queries compiled shader feature/channel metadata during glTF export. Without
 * it, unknown CS2 shader mappings can discard opacity and packed roughness. Cache
 * complete shader archives from the SAME depot manifest as the content cache;
 * never mount the incomplete sparse material archives into the exporter's search.
 */
export const prepareCs2Shaders = async ({
  cs2Dir,
  toolsDir,
  gameDir,
  log = () => {},
}) => {
  const manifest = await findCachedManifest(cs2Dir, "2347770");
  if (!manifest || !/^\d+$/.test(manifest.gid))
    throw new Error("Shader metadata requires a pinned CS2 depot manifest");
  const files = await readManifestFiles(manifest.path);
  const names = shaderArchiveNames(files);
  if (!names.some((name) => name === "game/csgo/shaders_vulkan_dir.vpk"))
    throw new Error("Pinned depot has no CS2 Vulkan shader archive");
  const cache = resolve(cs2Dir, "shader-metadata", manifest.gid);
  await mkdir(cache, { recursive: true });
  const missing = [];
  for (const name of names) {
    const cached = await stat(join(cache, name)).catch(() => null);
    if (cached?.size !== files.get(name).size) missing.push(name);
  }
  if (missing.length) {
    const temporary = await mkdtemp(join(cache, "download-"));
    try {
      const list = join(temporary, "files.txt");
      await writeFile(list, missing.join("\n") + "\n");
      log(
        `fetching compiled shader metadata from depot manifest ${manifest.gid} (${missing.length} archives)`,
      );
      await runTool(
        join(toolsDir, "DepotDownloader"),
        [
          "-app",
          "730",
          "-depot",
          "2347770",
          "-manifest",
          manifest.gid,
          "-filelist",
          list,
          "-dir",
          cache,
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const archives = [];
  for (const name of names) {
    const cached = join(cache, name);
    const actual = await stat(cached);
    if (actual.size !== files.get(name).size)
      throw new Error(`Incomplete shader archive: ${name}`);
    // gameDir is <extraction>/game/csgo; core shader packages are sibling folders.
    const target = resolve(gameDir, "..", "..", name);
    await mkdir(dirname(target), { recursive: true });
    let providedByWorkshop = false;
    try {
      await symlink(relative(dirname(target), cached), target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      providedByWorkshop = true;
    }
    archives.push({
      name,
      bytes: (await stat(target)).size,
      sha256: (await fingerprintFile(target)).value,
      providedByWorkshop,
    });
  }
  return { depot: "2347770", manifest: manifest.gid, archives };
};
