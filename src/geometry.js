// Keep a directory of converted map geometry up to date.
//
// Converting one map means a few hundred megabytes of workshop download plus a
// Source 2 export, so it takes minutes, and there are 85 maps. That rules out doing
// it on demand for a deployed site and rules out doing all of it in one go. So:
//
//   - a manifest records what has been converted, from which version of the map
//   - a run only touches maps that are missing or whose checksum has changed
//   - a run stops when its time budget is spent and picks up where it left off
//   - a map that fails is retried, but only a few times, so one broken map cannot
//     eat every nightly run forever
//
// The manifest is also what the browse page reads to know which maps it can show
// geometry for, which is why it is written into the served data directory.

import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTemporaryGlb, convertMap, validateGlb } from "./mapPipeline.js";

const MAX_ATTEMPTS = 3;

const emptyManifest = () => ({ updatedAt: null, maps: {} });

export const writeJsonAtomically = async (path, value, space) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await rm(temporaryPath, { force: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, space)}\n`);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

export const readManifest = async (path) => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.maps ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
};

const writeManifest = async (path, manifest) => {
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomically(path, manifest, 2);
};

/**
 * Does this map need converting?
 *
 * A file on disk is not enough on its own: a mapper can republish, and then the
 * geometry no longer matches the map the runs were set on. The vpk checksum from
 * the API is the version marker.
 */
const needsWork = async (map, entry, outputDir) => {
  const file = join(outputDir, `${map.name}.glb`);
  if (!existsSync(file)) return "missing";
  try {
    await validateGlb(file);
  } catch (error) {
    if (entry) entry.error = error.message;
    return "incomplete geometry";
  }
  if (entry?.error) return "previous conversion failed";
  if (!entry) return null;
  if (map.checksum && entry.checksum && map.checksum !== entry.checksum) {
    return "map was republished";
  }
  return null;
};

/**
 * Write manifest entries for .glb files that are already on disk.
 *
 * Files converted before the manifest existed, or copied in by hand, would otherwise
 * be converted again from scratch — half an hour of work to produce a file that is
 * already there. Their checksum is taken to be the current one, which is right
 * unless the map was republished in between, and a wrong guess only costs one
 * missed reconversion.
 */
const adoptExistingFiles = async (maps, manifest, outputDir, log) => {
  let adopted = 0;
  for (const map of maps) {
    if (manifest.maps[map.name]) continue;
    const file = join(outputDir, `${map.name}.glb`);
    if (!existsSync(file)) continue;
    try {
      await validateGlb(file);
    } catch (error) {
      log(`not adopting ${map.name}: ${error.message}`);
      continue;
    }
    const { size } = await stat(file);
    manifest.maps[map.name] = {
      checksum: map.checksum ?? null,
      megabytes: +(size / 1e6).toFixed(2),
      convertedAt: null,
      adopted: true,
      attempts: 0,
      error: null,
    };
    adopted += 1;
  }
  if (adopted) log(`adopted ${adopted} already converted map(s)`);
  return adopted;
};

/**
 * Convert whatever is missing, newest maps first, until the budget runs out.
 *
 * @param maps      the `maps` array from buildMapCatalog
 * @param budgetMs  stop starting new conversions after this long. One already
 *                  running is allowed to finish: killing steamcmd half way leaves a
 *                  partial download behind.
 * @returns { converted, failed, skipped, remaining }
 */
export const convertPendingMaps = async ({
  maps,
  outputDir,
  toolsDir,
  manifestPath,
  budgetMs = 45 * 60 * 1000,
  force = false,
  only = null,
  // The mapper's own textures, which is as close to the real map as this gets.
  withTextures = true,
  // Colour is the default for anything converted from here on. It costs nothing in
  // file size and a grey map next to a coloured one just looks broken. Still on with
  // textures: it is what the surfaces a textured export cannot texture fall back to.
  withColours = true,
  // And the map's own baked lighting on top of it, for about 150 KB.
  withLightmap = true,
  // And the map's real sky, for about 3 KB. Needs tools/DepotDownloader and borrows one
  // CS2 archive part per distinct sky, so it is the one step that can be turned off for
  // a machine that cannot reach Steam's content depot.
  withSky = true,
  log = () => {},
}) => {
  const manifest = await readManifest(manifestPath);
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    maps.map((map) => cleanupTemporaryGlb(outputDir, map.name)),
  );
  if (await adoptExistingFiles(maps, manifest, outputDir, log)) {
    await writeManifest(manifestPath, manifest);
  }

  const consideredMaps = maps
    .filter((map) => (only ? only.includes(map.name) : true))
    .filter((map) => map.workshopId);
  const candidates = (
    await Promise.all(
      consideredMaps.map(async (map) => ({
        map,
        entry: manifest.maps[map.name],
        reason: force
          ? "forced"
          : await needsWork(map, manifest.maps[map.name], outputDir),
      })),
    )
  )
    .filter((candidate) => candidate.reason !== null)
    .filter(
      (candidate) => force || (candidate.entry?.attempts ?? 0) < MAX_ATTEMPTS,
    )
    // Newest approvals first: a map that has just appeared is the one people are
    // looking for, and it is also the one most likely to be missing.
    .sort((a, b) =>
      (b.map.approvedAt ?? "").localeCompare(a.map.approvedAt ?? ""),
    );

  const givenUp = maps.filter(
    (map) => (manifest.maps[map.name]?.attempts ?? 0) >= MAX_ATTEMPTS,
  ).length;

  log(
    `${candidates.length} maps to convert` +
      (givenUp ? `, ${givenUp} given up on after ${MAX_ATTEMPTS} tries` : ""),
  );

  const deadline = Date.now() + budgetMs;
  const result = { converted: [], failed: [], remaining: 0 };

  for (const [index, candidate] of candidates.entries()) {
    if (Date.now() >= deadline) {
      result.remaining = candidates.length - index;
      log(`budget spent, ${result.remaining} maps left for next time`);
      break;
    }

    const { map, reason } = candidate;
    log(`[${index + 1}/${candidates.length}] ${map.name} (${reason})`);
    const started = Date.now();

    try {
      const { path, simplifyError } = await convertMap({
        mapName: map.name,
        workshopId: map.workshopId,
        toolsDir,
        outputDir,
        withTextures,
        withColours,
        withLightmap,
        withSky,
        log: (message) => log(`  ${map.name}: ${message}`),
      });
      const { size } = await stat(path);
      manifest.maps[map.name] = {
        checksum: map.checksum ?? null,
        megabytes: +(size / 1e6).toFixed(2),
        simplified: simplifyError !== null,
        convertedAt: new Date().toISOString(),
        seconds: Math.round((Date.now() - started) / 1000),
        attempts: 0,
        error: null,
      };
      result.converted.push(map.name);
      log(`  ${map.name}: done, ${(size / 1e6).toFixed(1)} MB`);
    } catch (error) {
      manifest.maps[map.name] = {
        ...(manifest.maps[map.name] ?? {}),
        attempts: (manifest.maps[map.name]?.attempts ?? 0) + 1,
        error: error.message,
        triedAt: new Date().toISOString(),
      };
      result.failed.push({ name: map.name, error: error.message });
      log(`  ${map.name}: failed — ${error.message}`);
    }

    // Written after every map, not at the end: a nightly run that is killed part
    // way through must not forget the work it already did.
    await writeManifest(manifestPath, manifest);
  }

  await writeManifest(manifestPath, manifest);
  return result;
};
