// The nightly job, as one function.
//
// Four parts, in this order, because each depends on the one before:
//
//   1. maps      — the map list and its pictures. Cheap, a handful of requests.
//   2. records   — the world record and the fastest watchable run per leaderboard.
//                  About 620 requests, a few seconds. This is what goes stale
//                  fastest: records are broken daily.
//   3. wr feed   — the records set most recently, newest first. Four requests.
//   4. geometry  — convert maps that have no .glb yet. Minutes per map, so it runs
//                  last and under a time budget.
//
// Steps 1 to 3 are written to disk before step 4 starts, so a run that is cut short
// during conversion still leaves fresh records behind.

import {
  buildLatestWorldRecords,
  buildLeaderboards,
  buildMapCatalog,
} from "./catalog.js";
import {
  convertPendingMaps,
  readManifest,
  writeJsonAtomically,
} from "./geometry.js";
import {
  GEOMETRY_JSON,
  LEADERBOARDS_JSON,
  MAPS_DIR,
  MAPS_JSON,
  TOOLS_DIR,
  WRS_JSON,
} from "./config.js";

const writeJson = async (path, value) => {
  await writeJsonAtomically(path, value);
};

export const refresh = async ({
  // Skip the slow part when only the records matter, which is most nights.
  geometry = true,
  geometryBudgetMs = 45 * 60 * 1000,
  forceGeometry = false,
  onlyMaps = null,
  log = console.log,
} = {}) => {
  const started = Date.now();

  const catalog = await buildMapCatalog({ log });
  await writeJson(MAPS_JSON, catalog);

  const leaderboards = await buildLeaderboards(catalog.maps, { log });
  await writeJson(LEADERBOARDS_JSON, leaderboards);

  // The feed is the one part of the catalog that is better stale than empty: it is a
  // list of sixty runs that are all still watchable tomorrow, so a failed fetch keeps
  // yesterday's file rather than taking the page down with it.
  let latest = null;
  try {
    latest = await buildLatestWorldRecords(catalog.maps, { log });
    await writeJson(WRS_JSON, latest);
  } catch (error) {
    log(
      `world record feed not rebuilt (${error.message}), keeping the old one`,
    );
  }

  let converted = null;
  if (geometry) {
    converted = await convertPendingMaps({
      maps: catalog.maps,
      outputDir: MAPS_DIR,
      toolsDir: TOOLS_DIR,
      manifestPath: GEOMETRY_JSON,
      budgetMs: geometryBudgetMs,
      force: forceGeometry,
      only: onlyMaps,
      log,
    });
  }

  const manifest = await readManifest(GEOMETRY_JSON);
  const ready = Object.values(manifest.maps).filter((entry) => !entry.error);
  log(
    `refresh done in ${Math.round((Date.now() - started) / 1000)}s · ` +
      `${catalog.maps.length} maps · ` +
      `${Object.keys(leaderboards.entries).length} leaderboards · ` +
      `${latest ? latest.records.length : "no new"} runs in the WR feed · ` +
      `${ready.length} maps with geometry`,
  );

  return { catalog, leaderboards, latest, converted };
};
