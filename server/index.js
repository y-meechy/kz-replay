// The deployed app: static files, one proxy, one scheduler. No framework.
//
// Three jobs it does that a static host cannot:
//
//   1. Proxy the replay bucket. replays.cs2kz.org is public but sends no CORS
//      headers, so a browser cannot fetch it directly. This is the one line of
//      server the whole viewer actually requires.
//   2. Serve the generated data and the converted map geometry from a writable
//      volume, so a redeploy does not wipe hours of map conversion.
//   3. Run the nightly refresh: new maps, new records, convert what is missing.
//
// Everything else is the Vite build output, served as files.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { DATA_DIR, MAPS_DIR, REPO_ROOT } from "../src/config.js";
import { refresh } from "../src/refresh.js";

const PORT = Number(process.env.PORT ?? 8080);
const DIST_DIR = process.env.KZ_DIST_DIR
  ? resolve(process.env.KZ_DIST_DIR)
  : join(REPO_ROOT, "viewer", "dist");

const REPLAY_BASE = "https://replays.cs2kz.org";
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

  const upstream = await fetch(`${REPLAY_BASE}/${recordId}`).catch((error) => {
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
  // Node 18+ gives a web ReadableStream here; Readable.fromWeb would work too but
  // this avoids the import for a body that is a few hundred kilobytes.
  for await (const chunk of upstream.body) {
    response.write(chunk);
  }
  response.end();
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

/** Is the catalog missing or older than a day? Then build it before serving. */
const catalogIsStale = async () => {
  try {
    const info = await stat(join(DATA_DIR, "leaderboards.json"));
    return Date.now() - info.mtimeMs > 24 * 3_600_000;
  } catch {
    return true;
  }
};

// --- routing ----------------------------------------------------------------

const handle = async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const headOnly = request.method === "HEAD";
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/healthz") {
    sendJson(response, 200, { ok: true, refreshing, lastRefresh });
    return;
  }

  if (path.startsWith("/replay/")) {
    await proxyReplay(response, path.slice("/replay/".length));
    return;
  }

  // Generated data and converted geometry live outside the build output, because
  // they have to survive a redeploy.
  for (const [prefix, directory] of [
    ["/data/", DATA_DIR],
    ["/maps/", MAPS_DIR],
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

createServer((request, response) => {
  handle(request, response).catch((error) => {
    log(`${request.method} ${request.url} failed: ${error.stack}`);
    if (!response.headersSent)
      sendJson(response, 500, { error: "server error" });
    else response.end();
  });
}).listen(PORT, () => {
  log(`kz-replay listening on :${PORT}`);
  log(`  app      ${DIST_DIR}`);
  log(`  data     ${DATA_DIR}`);
  log(`  geometry ${MAPS_DIR}`);
  scheduleRefresh();
  // A fresh volume has no catalog at all, and the browse page is empty without one.
  catalogIsStale().then((stale) => {
    if (stale) runRefresh("catalog was missing or stale");
    else log("catalog is fresh, waiting for the nightly run");
  });
});
