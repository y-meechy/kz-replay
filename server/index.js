// The deployed app: static files, one proxy, one scheduler. No framework.
//
// Five jobs it does that a static host cannot:
//
//   1. Proxy the replay bucket. replays.cs2kz.org is public but sends no CORS
//      headers, so a browser cannot fetch it directly. This is the one line of
//      server the whole viewer actually requires.
//   2. Serve the generated data, the converted map geometry and the CT character
//      from a writable volume, so a redeploy does not wipe hours of conversion.
//   3. Count views. The only thing here that is written by visitors rather than by
//      the nightly job, and the only reason there is any state to lose.
//   4. Run the nightly refresh: new maps, new records, convert what is missing.
//   5. Borrow the CT character out of CS2 the first time it is missing.
//
// Everything else is the Vite build output, served as files.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  DATA_DIR,
  MAPS_DIR,
  MAPS_JSON,
  MODELS_DIR,
  REPO_ROOT,
  STATE_DIR,
  WRS_JSON,
} from "../src/config.js";
import { buildLatestWorldRecords } from "../src/catalog.js";
import { writeJsonAtomically } from "../src/geometry.js";
import { convertPlayerModel } from "../src/playerModelPipeline.js";
import { refresh } from "../src/refresh.js";
import { createViewCounter, handleViewsRequest } from "../src/views.js";

const PORT = Number(process.env.PORT ?? 8080);
const DIST_DIR = process.env.KZ_DIST_DIR
  ? resolve(process.env.KZ_DIST_DIR)
  : join(REPO_ROOT, "viewer", "dist");

const REPLAY_BASE = "https://replays.cs2kz.org";
const REPLAY_TIMEOUT_MS = 120_000;
const RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".kztrack": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Map geometry is content-addressed in practice: a converted map only changes when
// the mapper republishes, and then it gets a new checksum in the manifest. The JSON
// the catalog writes changes nightly, so it must not be cached for long.
const cacheControl = (path) => {
  if (path.endsWith(".glb")) return "public, max-age=86400";
  if (path.endsWith(".json")) return "public, max-age=300";
  if (path.endsWith(".html")) return "no-cache";
  return "public, max-age=3600";
};

const log = (...parts) =>
  console.log(`[${new Date().toISOString()}]`, ...parts);

const views = createViewCounter({ log: (message) => log(message) });

/**
 * Resolve a url path inside a directory, or null if it escapes.
 *
 * `..` in a url is the classic way to read /etc/passwd off a hand-written static
 * server. Normalising first and then checking the prefix is the whole defence.
 */
const safeJoin = (baseDir, urlPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(baseDir, decoded));
  return full === baseDir || full.startsWith(`${baseDir}${sep}`) ? full : null;
};

const sendFile = async (response, path, headOnly = false) => {
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  response.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": cacheControl(path),
  });
  if (headOnly) {
    response.end();
    return true;
  }
  createReadStream(path).pipe(response);
  return true;
};

const sendJson = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

/**
 * Stream one replay through from the bucket.
 *
 * The id is checked against the uuid shape before it is put in a url: this endpoint
 * exists to fetch record ids, not to be a general purpose proxy for whatever a
 * visitor types.
 */
const proxyReplay = async (response, recordId) => {
  if (!RECORD_ID.test(recordId)) {
    sendJson(response, 400, { error: "that is not a record id" });
    return;
  }

  // The deadline covers headers and the whole body: this is the one public,
  // unauthenticated endpoint, and a stalled upstream must not hold a socket
  // open per request until the process runs out of them.
  const upstream = await fetch(`${REPLAY_BASE}/${recordId}`, {
    signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
  }).catch((error) => {
    log(`replay ${recordId} unreachable: ${error.message}`);
    return null;
  });

  if (!upstream) {
    sendJson(response, 502, { error: "the replay bucket is unreachable" });
    return;
  }
  if (!upstream.ok) {
    sendJson(response, upstream.status, {
      error:
        upstream.status === 404
          ? "no replay stored for that record"
          : `the replay bucket returned ${upstream.status}`,
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/octet-stream",
    // A replay file for a given record never changes, so it can be cached hard.
    "cache-control": "public, max-age=604800, immutable",
  });
  // pipeline() rather than a write loop: it waits for the response socket to
  // drain, so a slow client buffers on its own connection instead of in this
  // process, and it tears both streams down on either side failing. The abort
  // signal above also fires mid-body, so a trickling upstream surfaces here.
  try {
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    log(`replay ${recordId} stream broke: ${error.message}`);
    response.destroy();
  }
};

// --- the nightly job --------------------------------------------------------
//
// setTimeout rather than a cron library: one dependency fewer, and the only thing
// that matters is "roughly 03:30 every night". The timer is re-armed after each run
// so a long conversion pushing past the hour cannot make two runs overlap.

const REFRESH_HOUR = Number(process.env.KZ_REFRESH_HOUR ?? 3);
const REFRESH_MINUTE = Number(process.env.KZ_REFRESH_MINUTE ?? 30);

let refreshing = false;
let lastRefresh = null;

const runRefresh = async (reason) => {
  if (refreshing) {
    log(`refresh (${reason}) skipped: one is already running`);
    return;
  }
  refreshing = true;
  log(`refresh started (${reason})`);
  try {
    await refresh({
      geometry: process.env.KZ_CONVERT_MAPS !== "false",
      geometryBudgetMs: Number(process.env.KZ_GEOMETRY_MINUTES ?? 240) * 60_000,
      log: (message) => log(`  ${message}`),
    });
    lastRefresh = { at: new Date().toISOString(), reason, ok: true };
  } catch (error) {
    log(`refresh failed: ${error.stack ?? error.message}`);
    lastRefresh = {
      at: new Date().toISOString(),
      reason,
      ok: false,
      error: error.message,
    };
  } finally {
    refreshing = false;
  }
};

const millisecondsUntilNextRun = () => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
};

const scheduleRefresh = () => {
  const wait = millisecondsUntilNextRun();
  log(`next refresh in ${(wait / 3_600_000).toFixed(1)}h`);
  setTimeout(async () => {
    await runRefresh("nightly");
    scheduleRefresh();
  }, wait).unref?.();
};

/**
 * Borrow the CT character out of CS2, if the volume has not got it.
 *
 * Once, on the start that finds it missing, rather than nightly: the file changes when
 * CS2 does, which is neither nightly nor something this can detect, and building it is
 * minutes of SteamCMD. Missing is the only case worth acting on, and it is the normal
 * case exactly once — the volume is seeded from the image the first time it is created,
 * and this file is in no image at all.
 *
 * It holds the same flag as the refresh, for the two reasons the flag exists: both jobs
 * drive SteamCMD and the Source 2 exporter over the one CS2 cache on the volume, and the
 * deploy timer reads the flag out of /healthz before it replaces the container.
 *
 * Nothing waits on any of this. Until the file lands, player.js draws its white ball.
 */
const ensurePlayerModel = async () => {
  try {
    await stat(join(MODELS_DIR, "ct.glb"));
    return;
  } catch {
    // Not there, which is the one case this function exists for.
  }

  if (refreshing) {
    log("character build skipped: a refresh is already running");
    return;
  }
  refreshing = true;
  log("character missing, borrowing it out of CS2");
  try {
    const { size, clips } = await convertPlayerModel({
      outputDir: MODELS_DIR,
      log: (message) => log(`  ${message}`),
    });
    log(
      `character written (${(size / 1e6).toFixed(2)} MB, ${clips.length} clips)`,
    );
  } catch (error) {
    log(`character not built (${error.message}), the viewer keeps its ball`);
  } finally {
    refreshing = false;
  }
};

/** Is the catalog missing or older than a day? Then build it before serving. */
const catalogIsStale = async () => {
  try {
    const info = await stat(join(DATA_DIR, "leaderboards.json"));
    return Date.now() - info.mtimeMs > 24 * 3_600_000;
  } catch {
    return true;
  }
};

/**
 * Rebuild the world record feed's list, on every start.
 *
 * Two reasons it happens here and not only in the nightly job:
 *
 *   1. The volume is seeded from the image only the first time it is created, so a
 *      generated file that is new in a release never appears on a volume that already
 *      exists. The feed's list was exactly that, and the page had nothing to show.
 *   2. A deploy should put the current records on screen, not last night's.
 *
 * Four API requests, a couple of seconds, so there is nothing to gain from being
 * clever about when to skip it. A failure leaves the file that is already there: the
 * feed being a day old is nothing, the feed being empty is a broken page.
 */
const refreshWorldRecordFeed = async () => {
  try {
    // The catalog supplies tiers and pictures. Missing costs those two fields.
    const catalog = await readFile(MAPS_JSON, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const latest = await buildLatestWorldRecords(catalog?.maps ?? [], {
      log: (message) => log(`  ${message}`),
    });
    await writeJsonAtomically(WRS_JSON, latest);
    log(`world record feed: ${latest.records.length} runs`);
  } catch (error) {
    log(
      `world record feed not rebuilt (${error.message}), keeping the old one`,
    );
  }
};

// --- routing ----------------------------------------------------------------

const handle = async (request, response) => {
  // The view counter is the only thing here that accepts a POST, so it is routed
  // before the method check rather than after it.
  if (await handleViewsRequest(request, response, views)) return;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const headOnly = request.method === "HEAD";
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      refreshing,
      lastRefresh,
      views: views.stats(),
    });
    return;
  }

  if (path.startsWith("/replay/")) {
    await proxyReplay(response, path.slice("/replay/".length));
    return;
  }

  // Generated data, converted geometry and the borrowed character live outside the
  // build output, because they have to survive a redeploy. The character is in no
  // image at all, so this route is the only way the viewer can ever reach it.
  for (const [prefix, directory] of [
    ["/data/", DATA_DIR],
    ["/maps/", MAPS_DIR],
    ["/models/", MODELS_DIR],
  ]) {
    if (!path.startsWith(prefix)) continue;
    const file = safeJoin(directory, path.slice(prefix.length));
    if (file && (await sendFile(response, file, headOnly))) return;
    sendJson(response, 404, { error: `nothing at ${path}` });
    return;
  }

  const asset = safeJoin(DIST_DIR, path === "/" ? "index.html" : path);
  if (asset && (await sendFile(response, asset, headOnly))) return;

  // Everything else is the single page app. Routing is by hash, so this only ever
  // catches a bad path, but serving the app is friendlier than a bare 404.
  if (await sendFile(response, join(DIST_DIR, "index.html"), headOnly)) return;
  sendJson(response, 404, {
    error: "no build found — run npm run build first",
  });
};

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    log(`${request.method} ${request.url} failed: ${error.stack}`);
    if (!response.headersSent)
      sendJson(response, 500, { error: "server error" });
    else response.end();
  });
});

const waitAtMost = (promise, milliseconds, description) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${description} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

let shuttingDown = null;

/**
 * Stop accepting requests, let active ones finish, then make the view file durable.
 * The hard bounds matter during deploys: a stuck client or filesystem must not keep
 * the old container around forever.
 */
export const shutdown = (signal = "shutdown") => {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    log(`${signal} received, shutting down`);

    const stopped = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    });
    try {
      await waitAtMost(stopped, 8_000, "HTTP server close");
    } catch (error) {
      log(`${error.message}; closing remaining connections`);
      server.closeAllConnections?.();
      try {
        await waitAtMost(stopped, 1_000, "forced HTTP server close");
      } catch (forcedError) {
        log(forcedError.message);
      }
    }

    try {
      await waitAtMost(views.close(), 5_000, "view count flush");
      log("view counts persisted");
      return 0;
    } catch (error) {
      log(`shutdown could not persist view counts: ${error.message}`);
      return 1;
    }
  })();
  return shuttingDown;
};

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void shutdown(signal).then((exitCode) => process.exit(exitCode));
  });
}

server.listen(PORT, () => {
  log(`kz-replay listening on :${PORT}`);
  log(`  app      ${DIST_DIR}`);
  log(`  data     ${DATA_DIR}`);
  log(`  geometry ${MAPS_DIR}`);
  log(`  models   ${MODELS_DIR}`);
  log(`  state    ${STATE_DIR}`);
  views.load();
  scheduleRefresh();
  // The feed first, because it is four requests and the page it feeds is the one
  // people land on. A full refresh, if one is needed, writes the same file again
  // minutes later, and both writes are atomic.
  refreshWorldRecordFeed();
  // A fresh volume has no catalog at all, and the browse page is empty without one.
  // The character comes after it, not alongside it: an empty browse page is a broken
  // site and a missing character is only the old white ball, and the two jobs cannot
  // run at once anyway, because they share the CS2 cache. The `return` is what makes
  // it after — without it the chain would not wait for the refresh to finish.
  catalogIsStale()
    .then((stale) => {
      if (stale) return runRefresh("catalog was missing or stale");
      log("catalog is fresh, waiting for the nightly run");
    })
    .then(ensurePlayerModel);
});
