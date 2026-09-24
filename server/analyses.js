// Run reviews for replays a game server uploads.
//
//   POST /api/analyses        raw .replay body, bearer token. Reviews it, stores it.
//   GET  /api/analyses        the latest reviews, newest first, without the details.
//   GET  /api/analyses/<id>   one review in full.
//
// The uploaded replay is written into the replay proxy's cache under a fresh id,
// so /watch?ids=<id>,<world record> plays it with no viewer change: the proxy
// serves a cached file before it ever asks the bucket.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reviewReplay as defaultReview } from "../src/runReview.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_LIMIT = 50;

const sendJson = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

const tokenMatches = (header, token) => {
  const given = Buffer.from(String(header ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const readLimited = async (request, maxBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const summaryOf = ({ id, createdAt, watch, run, reference, comparison }) => ({
  id,
  createdAt,
  watch,
  player: run.player,
  map: run.map,
  course: run.course,
  mode: run.mode,
  time: run.reportedTime,
  teleports: run.teleports,
  worldRecord: reference?.reportedTime ?? null,
  delta: comparison?.finalDelta ?? null,
});

export const createAnalyses = ({
  stateDir,
  replayCacheDir,
  token,
  maxBytes,
  review = defaultReview,
  now = () => new Date(),
  log = () => {},
}) => {
  const dir = join(stateDir, "analyses");
  const fileOf = (id) => join(dir, `${id}.json`);

  const create = async (request, response) => {
    // No token configured means nobody may upload, rather than everybody.
    if (!token) {
      sendJson(response, 503, { error: "uploads are not configured" });
      return;
    }
    if (!tokenMatches(request.headers.authorization, token)) {
      sendJson(response, 401, { error: "bad or missing token" });
      return;
    }
    const body = await readLimited(request, maxBytes);
    if (!body) {
      sendJson(response, 413, { error: `replay is over ${maxBytes} bytes` });
      return;
    }

    let result;
    try {
      // ponytail: parsing runs on the event loop (well under a second per run);
      // move it to a worker thread if uploads ever come from more than our servers.
      result = await review(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      );
    } catch (error) {
      log(`analysis failed: ${error.message}`);
      sendJson(response, 422, { error: error.message });
      return;
    }
    if (result.error) {
      sendJson(response, 422, { error: result.error });
      return;
    }

    const id = randomUUID();
    const reference = result.review.reference;
    const analysis = {
      id,
      createdAt: now().toISOString(),
      watch: `/watch?ids=${id}${reference ? `,${reference.recordId}` : ""}`,
      ...result.review,
    };
    await mkdir(dir, { recursive: true });
    await mkdir(replayCacheDir, { recursive: true });
    // ponytail: the proxy cache evicts oldest-first past its size cap, so a very
    // old upload can stop playing; keep a second copy here if that ever bites.
    await writeFile(join(replayCacheDir, id), body);
    await writeFile(fileOf(id), JSON.stringify(analysis));
    log(
      `analysis ${id}: ${analysis.run.player} ${analysis.run.map} ` +
        `${analysis.run.reportedTime}s, ${analysis.comparison?.finalDelta ?? "no"} vs WR`,
    );
    sendJson(response, 201, analysis);
  };

  const list = async (response) => {
    const names = await readdir(dir).catch(() => []);
    const all = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          readFile(join(dir, name), "utf8").then(JSON.parse, () => null),
        ),
    );
    // ponytail: reads every review per request; an index file once there are
    // thousands of them.
    const latest = all
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LIST_LIMIT)
      .map(summaryOf);
    sendJson(response, 200, latest);
  };

  const get = async (response, id) => {
    const text = ID.test(id)
      ? await readFile(fileOf(id), "utf8").catch(() => null)
      : null;
    if (!text) {
      sendJson(response, 404, { error: "no such analysis" });
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    response.end(text);
  };

  /** Handle the request if it is ours; false if it belongs to someone else. */
  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/api/analyses" && !path.startsWith("/api/analyses/"))
      return false;

    if (path === "/api/analyses" && request.method === "POST")
      await create(request, response);
    else if (path === "/api/analyses" && request.method === "GET")
      await list(response);
    else if (request.method === "GET")
      await get(response, path.slice("/api/analyses/".length));
    else
      sendJson(response, 405, {
        error: "POST or GET /api/analyses, GET /api/analyses/<id>",
      });
    return true;
  };
};
