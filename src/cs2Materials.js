// Borrow the base game materials a map builds on, so its surfaces have textures.
//
// A workshop map packages the materials its mapper *made*. It does not package the
// ones the mapper reused, because every CS2 player already has those. So a map built
// mostly out of the game's own concrete, metal and wood ships with almost no materials
// of its own, and the exporter — which can only draw what it can resolve — writes those
// surfaces with no material at all. They then fall back to a flat colour from the
// material's name (see mapColours.js), which is why kz_grotto arrived with textures on
// its twenty custom signs and mushrooms and on nothing else, and kz_niche with none.
//
// The world nodes name every material, base game ones included, so the fix is:
//
//   1. Take the material paths the world mentions and drop the ones the workshop item
//      already supplied.
//   2. Fetch the rest out of the CS2 content depot, by chunk. See cs2Content.js.
//   3. Fetch the textures each of those materials samples. This is a second pass on
//      purpose: a compiled material names its textures inside itself, and there is no
//      guessing them from the outside — `nuke_concrete_wall.vmat_c` samples
//      `de_nuke/nuke_trim_concrete_color_psd_9b6c1a2f.vtex_c`, which shares neither
//      folder nor stem with it.
//   4. Write them into the tree the exporter reads, beside the mapper's own files, so
//      they resolve the same way those do.
//
// Step 4 writes loose files rather than linking the cached archives in, which is the
// obvious shortcut and does not work. The cache's archives are sparse: the index inside
// them describes all 132,585 CS2 assets while only the borrowed byte ranges are really
// there, so the exporter follows a reference into a hole, reads zeros, and dies on the
// bad header instead of reporting a missing file and carrying on. Loose files promise
// only what was actually fetched.
//
// Nothing here can shadow the mapper's own work: step 1 drops any path the workshop item
// already supplied, so the two sets never overlap.

import { mkdir, open, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { cs2ArchivePath, ensureCs2Assets, readCs2Index } from "./cs2Content.js";

/**
 * One borrowed asset's bytes, straight out of the archive part holding it.
 *
 * The index gives the part, the offset and the length, and every CS2 asset is stored as
 * one contiguous run with no preload chunk in the index file, so a plain read reproduces
 * the file exactly. No decompiler in the loop: ensureCs2Assets has just put these bytes
 * on disk, and one process per asset over hundreds of assets per map is minutes wasted.
 *
 * @returns the bytes, or null when the asset is unknown or was never fetched
 */
const readAsset = async ({ cs2Dir, index, path }) => {
  const found = index.get(`${path}_c`) ?? index.get(path);
  if (!found) return null;
  const [part, offset, size] = found;
  const file = join(cs2Dir, cs2ArchivePath(part));
  if (!existsSync(file)) return null;

  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, offset);
    // A hole in the sparse archive: this asset shares a part with one that was wanted,
    // but its own chunks were never downloaded. Every Source 2 resource starts with a
    // non-zero length and version, so all-zero means there is nothing here.
    if (
      size >= 8 &&
      bytes.readUInt32LE(0) === 0 &&
      bytes.readUInt32LE(4) === 0
    ) {
      return null;
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

/** The texture paths a compiled material samples, from its external reference list. */
const texturesInside = (bytes) =>
  bytes.toString("latin1").match(/materials\/[\w/.-]+\.vtex/g) ?? [];

/**
 * Write borrowed assets into the export tree as loose compiled files.
 *
 * @returns how many were written
 */
const placeAssets = async ({ cs2Dir, index, paths, gameDir }) => {
  let placed = 0;
  for (const path of paths) {
    const bytes = await readAsset({ cs2Dir, index, path });
    if (!bytes) continue;
    const target = join(gameDir, `${path}_c`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    placed += 1;
  }
  return placed;
};

/**
 * Put every base game material this map uses within the exporter's reach.
 *
 * @param paths  every material path the world nodes mention, lowercased
 * @param gameDir the extracted workshop item, i.e. `<work>/content/<map>/game/csgo`
 * @returns { borrowed, missing, textures } — materials placed in the tree, ones CS2 does
 *          not have, and textures placed alongside them
 */
export const borrowCs2Materials = async ({
  cli,
  cs2Dir,
  toolsDir,
  gameDir,
  paths,
  log = () => {},
}) => {
  // The workshop item wins wherever it supplied the material itself. Both spellings,
  // because an extracted tree holds compiled `.vmat_c` and a source tree `.vmat`.
  const wanted = [...paths].filter(
    (path) =>
      !existsSync(join(gameDir, `${path}_c`)) &&
      !existsSync(join(gameDir, path)),
  );
  if (wanted.length === 0) return { borrowed: 0, missing: [], textures: 0 };

  log(
    `${wanted.length} of the map's materials are base game ones — borrowing…`,
  );
  // No siblings: the prefix guess ensureCs2Assets makes for an asset's companions earns
  // its keep on a sky, whose texture is named after it, and is pure waste here, where the
  // textures are read out of the material itself a few lines down.
  const { missing } = await ensureCs2Assets({
    cs2Dir,
    toolsDir,
    cli,
    paths: wanted,
    siblings: false,
    log,
  });

  // The textures those materials sample, which is a second round of fetching because
  // nothing outside a material knows what it samples.
  const index = await readCs2Index({ cs2Dir, cli, log });
  const found = [];
  const textures = new Set();
  for (const path of wanted) {
    const bytes = await readAsset({ cs2Dir, index, path });
    if (!bytes) continue;
    found.push(path);
    for (const texture of texturesInside(bytes))
      textures.add(texture.toLowerCase());
  }
  if (textures.size) {
    log(`those materials sample ${textures.size} base game texture(s)`);
    await ensureCs2Assets({
      cs2Dir,
      toolsDir,
      cli,
      paths: [...textures],
      siblings: false,
      log,
    });
  }

  const borrowed = await placeAssets({
    cs2Dir,
    index,
    paths: found,
    gameDir,
  });
  const placedTextures = await placeAssets({
    cs2Dir,
    index,
    paths: [...textures],
    gameDir,
  });
  log(
    `borrowed ${borrowed} material(s) and ${placedTextures} texture(s) from CS2` +
      (missing.length ? `; CS2 has no ${missing.length} of them` : ""),
  );
  return { borrowed, missing, textures: placedTextures };
};
