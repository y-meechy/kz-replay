// Where the generated files live.
//
// In development everything lands under viewer/public, so Vite serves it and the
// paths the browser asks for (/data/maps.json, /maps/kz_grotto.glb) work with no
// server of our own. In production those two directories have to survive a redeploy,
// so they move to a mounted volume and the server serves them itself. Same paths in
// the browser either way.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fromEnv = (name, fallback) =>
  process.env[name] ? resolve(process.env[name]) : fallback;

/** Generated JSON: maps.json, leaderboards.json, geometry.json. */
export const DATA_DIR = fromEnv(
  "KZ_DATA_DIR",
  join(REPO_ROOT, "viewer", "public", "data"),
);

/** Converted map geometry, one .glb per map. */
export const MAPS_DIR = fromEnv(
  "KZ_MAPS_DIR",
  join(REPO_ROOT, "viewer", "public", "maps"),
);

/** steamcmd's download area and the Source 2 exporter. Never served. */
export const TOOLS_DIR = fromEnv("KZ_TOOLS_DIR", join(REPO_ROOT, "tools"));

/**
 * Base game assets borrowed out of CS2, one archive part at a time.
 *
 * Not an install: an index plus whatever parts the converted maps turned out to need,
 * which is how a map's real sky is reachable without 61 GB of game. See cs2Content.js.
 */
export const CS2_DIR = fromEnv("KZ_CS2_DIR", join(TOOLS_DIR, "cs2"));

/**
 * State the running app writes itself, as opposed to the catalog, which the nightly
 * refresh regenerates from the API.
 *
 * Kept out of DATA_DIR on purpose. Everything in there is generated, replaceable and
 * seeded into the volume from the image on first boot; the view counter is none of
 * those things and must never be overwritten by a copy of the bundled files.
 */
export const STATE_DIR = fromEnv("KZ_STATE_DIR", join(REPO_ROOT, ".state"));

export const MAPS_JSON = join(DATA_DIR, "maps.json");
export const LEADERBOARDS_JSON = join(DATA_DIR, "leaderboards.json");
export const GEOMETRY_JSON = join(DATA_DIR, "geometry.json");

/** The most recently set world records, newest first. The feed reads this. */
export const WRS_JSON = join(DATA_DIR, "wrs.json");

/** How many people have watched each run. */
export const VIEWS_JSON = join(STATE_DIR, "views.json");
