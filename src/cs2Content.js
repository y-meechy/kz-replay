// Borrow single files out of the CS2 install, without installing CS2.
//
// A workshop map packages the materials its mapper made or copied, and for most maps
// that is most of them (44 of kz_victoria's 55). The rest are base game assets, and
// they include the one thing no map can supply for itself: the sky. `skyname` points at
// `materials/skybox/sky_de_annubis.vmat` and that lives in CS2 and nowhere else.
//
// Installing CS2 to read a 3 KB sky is not reasonable: depot 2347770 is 52 GB to
// download and 61 GB on disk. Three facts together make the small version work:
//
//   1. The depot's own file list is 479 archive parts of about 105 MB each, plus a
//      7.4 MB index, `pak01_dir.vpk`. DepotDownloader can fetch named files from a
//      depot, so the index costs 3 MB of transfer on its own.
//   2. The index says, for every one of the 132,585 assets in CS2, which archive part
//      holds it. So the parts a given asset needs are known before anything is
//      downloaded.
//   3. ValveResourceFormat reads a partial install happily. Given `gameinfo.gi`, the
//      index and the parts an asset happens to live in, it resolves that asset and
//      never touches the rest.
//
// So the cache under tools/cs2 grows by the parts that were actually needed and stops.
// All 58 CS2 skies together are 88 MB of asset spread over 27 parts, so a complete set
// of skies for every map is a one-off 2.5 GB and then nothing.
//
// What is deliberately NOT here: fetching whole parts is coarse. The index knows the
// byte range of each asset inside its part, and Steam serves depots in ~1 MB chunks, so
// a chunk-level fetcher could pull a 1 MB sky texture instead of the 105 MB part it
// sits in. That needs the CDN protocol rather than a CLI, and 105 MB once per part is
// not worth it yet.

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchRangesInto, readDepotAccess } from "./cs2Chunks.js";
import { findCachedManifest, readManifestFiles } from "./cs2Manifest.js";

import { runTool as run } from "./toolProcess.js";

const CS2_APP_ID = "730";

/** The depot holding every shared CS2 asset. The per-OS ones are binaries only. */
const CS2_CONTENT_DEPOT = "2347770";

/** Where the assets sit inside the depot, and so inside our cache. */
const CONTENT_PREFIX = "game/csgo";

const INDEX_FILE = "pak01_dir.vpk";

// `gameinfo.gi` is what ValveResourceFormat looks for to decide it has found a game.
const GAME_INFO = "gameinfo.gi";

// The index lists 132,585 assets; the tool prints one line each.
const BIG_OUTPUT = { maxBuffer: 256 * 1024 * 1024 };

// Where the cached assets sit. Not exported: callers want one of the two named files
// below, or they want ValveResourceFormat pointed at the index, which is the same thing.
const cs2ContentDir = (cs2Dir) => join(cs2Dir, CONTENT_PREFIX);

/** The archive index, which every asset lookup goes through. */
export const cs2IndexPath = (cs2Dir) => join(cs2ContentDir(cs2Dir), INDEX_FILE);

/**
 * Where an archive sits inside the cache, given either its part number or its file name.
 *
 * Named the same way in the depot and in the cache, so one function answers for both.
 */
export const cs2ArchivePath = (partOrName) =>
  `${CONTENT_PREFIX}/${
    typeof partOrName === "number"
      ? `pak01_${String(partOrName).padStart(3, "0")}.vpk`
      : partOrName
  }`;

/**
 * The archives the cache actually holds, the index among them.
 *
 * Which is a subset of the depot's 479, and the point of the whole cache: mounting
 * these makes exactly the assets that were borrowed resolvable. See cs2Materials.js.
 */
export const cs2ArchiveFiles = async (cs2Dir) =>
  (await readdir(cs2ContentDir(cs2Dir))).filter((file) =>
    /^pak01_.*\.vpk$/.test(file),
  );

/** The file that makes ValveResourceFormat treat the cache as a game. */
export const cs2GameInfoPath = (cs2Dir) =>
  join(cs2ContentDir(cs2Dir), GAME_INFO);

/** The index and gameinfo, without which nothing else can be resolved. */
export const hasCs2Index = (cs2Dir) =>
  existsSync(cs2IndexPath(cs2Dir)) && existsSync(cs2GameInfoPath(cs2Dir));

const depotDownloader = (toolsDir) => {
  const path = join(toolsDir, "DepotDownloader");
  if (!existsSync(path)) {
    throw new Error(
      `DepotDownloader not found at ${path}. Download the build for this platform from ` +
        `https://github.com/SteamRE/DepotDownloader/releases and unzip it into tools/.`,
    );
  }
  return path;
};

/**
 * Fetch named files out of the CS2 content depot into the cache.
 *
 * Anonymous, like the workshop downloads: no Steam account and no copy of the game.
 */
const fetchFiles = async ({ cs2Dir, toolsDir, files, log = () => {} }) => {
  if (files.length === 0) return;
  const listPath = join(cs2Dir, ".filelist.txt");
  await mkdir(cs2Dir, { recursive: true });
  await writeFile(listPath, `${files.join("\n")}\n`);
  try {
    await run(
      depotDownloader(toolsDir),
      [
        "-app",
        CS2_APP_ID,
        "-depot",
        CS2_CONTENT_DEPOT,
        "-filelist",
        listPath,
        "-dir",
        cs2Dir,
      ],
      BIG_OUTPUT,
    );
  } finally {
    await rm(listPath, { force: true });
  }
  log(`fetched ${files.length} file(s) from the CS2 content depot`);
};

/**
 * Put the index in place if it is not already, so assets can be looked up.
 *
 * 3 MB of transfer. Everything else in this file needs it first.
 */
export const syncCs2Index = async ({ cs2Dir, toolsDir, log = () => {} }) => {
  if (hasCs2Index(cs2Dir)) return false;
  log("fetching the CS2 asset index (about 3 MB)…");
  await fetchFiles({
    cs2Dir,
    toolsDir,
    files: [
      `${CONTENT_PREFIX}/${INDEX_FILE}`,
      `${CONTENT_PREFIX}/${GAME_INFO}`,
    ],
    log,
  });
  if (!hasCs2Index(cs2Dir)) {
    throw new Error(
      `the CS2 content depot did not yield ${INDEX_FILE} and ${GAME_INFO}`,
    );
  }
  return true;
};

/**
 * Where each asset lives: which archive part, and which bytes of it.
 *
 * Cached on disk as JSON, because listing the index takes about a minute and the answer
 * only changes when CS2 updates — which the index's own modification time tracks.
 *
 * @returns Map of lowercased asset path (with the `_c` suffix) -> [part, offset, size]
 */
export const readCs2Index = async ({ cs2Dir, cli, log = () => {} }) => {
  const indexPath = cs2IndexPath(cs2Dir);
  const cachePath = join(cs2Dir, "index.json");
  const { mtimeMs } = await stat(indexPath);

  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.mtimeMs === mtimeMs)
      return new Map(Object.entries(cached.parts));
  } catch {
    // No cache, or one written for an older CS2. Rebuild it.
  }

  log("reading the CS2 asset index…");
  const { stdout } = await run(cli, ["-i", indexPath, "--vpk_dir"], BIG_OUTPUT);
  const parts = {};
  // `path crc=0x… metadatasz=0 fnumber=286 ofs=0x… sz=1060480`
  // `path crc=0x… metadatasz=0 fnumber=286 ofs=0x102b000 sz=1060480`. The offset and
  // length are what makes chunk-level fetching possible: they say which slice of which
  // archive part an asset is, so only the chunks over that slice need downloading.
  const entry =
    /^(\S+) crc=\S+ metadatasz=\d+ fnumber=(\d+) ofs=(0x[0-9a-f]+|\d+) sz=(\d+)/;
  for (const line of stdout.split("\n")) {
    const match = entry.exec(line.trim());
    if (!match) continue;
    parts[match[1].toLowerCase()] = [
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
    ];
  }

  // No mkdir: the index we just read lives under cs2Dir, so the cache's directory is
  // already there.
  await writeFile(cachePath, JSON.stringify({ mtimeMs, parts }));
  log(`the CS2 index lists ${Object.keys(parts).length} assets`);
  return new Map(Object.entries(parts));
};

/**
 * Make sure every one of these assets can be read locally, fetching what is missing.
 *
 * @param paths uncompiled asset paths as a map names them, e.g.
 *              `materials/skybox/sky_de_annubis.vmat`. The compiled `_c` suffix is
 *              added here, because that is what is actually in the archive.
 * @param siblings also fetch everything whose name starts with the same stem. Worth it
 *              for a sky, whose texture is named after it. Turn it off when the caller
 *              knows the companions by name: it over-matches, so a material called
 *              `wood01` drags in every `wood01_*` in the game.
 * @returns { fetched, missing } — parts downloaded, and paths CS2 does not have
 */
export const ensureCs2Assets = async ({
  cs2Dir,
  toolsDir,
  cli,
  paths,
  siblings = true,
  log = () => {},
}) => {
  await syncCs2Index({ cs2Dir, toolsDir, log });
  const index = await readCs2Index({ cs2Dir, cli, log });

  // Group the assets by the archive part they live in, keeping the byte range of each,
  // so a part can be fetched once for everything wanted out of it.
  const rangesByPart = new Map();
  const missing = [];
  const want = (found) => {
    const [part, offset, size] = found;
    if (!rangesByPart.has(part)) rangesByPart.set(part, []);
    rangesByPart.get(part).push({ offset, size });
  };

  for (const path of paths) {
    const lower = path.toLowerCase();
    const found = index.get(`${lower}_c`) ?? index.get(lower);
    if (found === undefined) {
      missing.push(path);
      continue;
    }
    want(found);

    // A material on its own draws nothing: the textures it samples are separate assets,
    // and a compiled one is named after the material it belongs to —
    // `sky_de_annubis.vmat_c` is useless without `sky_de_annubis_exr_2c5e0b53.vtex_c`.
    // Fetching everything that shares the name is how they come along.
    //
    // This over-matches when one name is a prefix of another, so `wood01` also drags in
    // `wood01_dark`. The cost of that is a few extra chunks, against a texture that
    // silently fails to load.
    if (!siblings) continue;
    const stem = lower.replace(/\.[a-z0-9_]+$/, "_");
    for (const [asset, at] of index) {
      if (asset !== `${lower}_c` && asset.startsWith(stem)) want(at);
    }
  }

  const parts = [...rangesByPart.keys()].sort((a, b) => a - b);
  if (parts.length === 0) return { fetched: [], missing, bytes: 0 };

  // Chunk-level when the depot key is on hand, which costs the bytes the assets occupy
  // instead of the 105 MB parts they sit in — for a sky, about 2 MB instead of 105.
  // Whole parts otherwise, which always works and is what DepotDownloader can do alone.
  const access = await readDepotAccess(cs2Dir);
  const manifest = access
    ? await findCachedManifest(cs2Dir, CS2_CONTENT_DEPOT)
    : null;
  if (access && manifest) {
    const files = await readManifestFiles(manifest.path);
    let bytes = 0;
    const fetched = [];
    for (const part of parts) {
      const name = cs2ArchivePath(part);
      const entry = files.get(name);
      if (!entry) {
        // In the index but not in the manifest: the two came from different CS2
        // versions. Re-syncing is the fix, and a whole-part fetch would be wrong too.
        missing.push(name);
        continue;
      }
      const result = await fetchRangesInto({
        path: join(cs2Dir, name),
        totalSize: entry.size,
        chunks: entry.chunks,
        ranges: rangesByPart.get(part),
        depotId: CS2_CONTENT_DEPOT,
        key: access.key,
        hosts: access.hosts,
        log,
      });
      if (result.chunks) fetched.push(part);
      bytes += result.bytes;
    }
    if (bytes) {
      log(
        `borrowed ${(bytes / 1e6).toFixed(1)} MB of CS2 in chunks, across ` +
          `${fetched.length} archive part(s)`,
      );
    }
    return { fetched, missing, bytes };
  }

  const absent = parts.filter(
    (part) => !existsSync(join(cs2Dir, cs2ArchivePath(part))),
  );
  if (absent.length) {
    log(
      `no depot key cached, so whole archive parts: ${absent.length} of them, about ` +
        `${absent.length * 105} MB. Run scripts/cs2-depot-key.py to fetch by chunk instead.`,
    );
    await fetchFiles({
      cs2Dir,
      toolsDir,
      files: absent.map(cs2ArchivePath),
      log,
    });
  }

  return { fetched: absent, missing, bytes: absent.length * 105e6 };
};
