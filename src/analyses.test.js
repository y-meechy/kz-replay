import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnalyses } from "../server/analyses.js";
import { createWatcher } from "./replayWatcher.js";

const review = {
  run: { player: "p", map: "kz_a", course: "main", reportedTime: 61 },
  reference: {
    recordId: "11111111-1111-4111-8111-111111111111",
    reportedTime: 60,
  },
  comparison: { finalDelta: 1 },
};

const serve = async (options) => {
  const dir = await mkdtemp(join(tmpdir(), "kz-analyses-"));
  const handle = createAnalyses({
    stateDir: dir,
    replayCacheDir: join(dir, "replays"),
    token: "secret",
    maxBytes: 16,
    review: async (buffer) =>
      new TextDecoder().decode(buffer) === "bad"
        ? { error: "a cheater replay is not a finished run" }
        : { review },
    ...options,
  });
  const server = createServer(async (request, response) => {
    if (!(await handle(request, response))) response.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { dir, url, close: () => server.close() };
};

const post = (url, body, token = "secret") =>
  fetch(`${url}/api/analyses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });

test("stores a review, serves it and caches the replay for the viewer", async (t) => {
  const { dir, url, close } = await serve();
  t.after(close);

  const created = await post(url, "replay");
  assert.equal(created.status, 201);
  const analysis = await created.json();
  assert.equal(
    analysis.watch,
    `/watch?ids=${analysis.id},${review.reference.recordId}`,
  );
  assert.equal(
    await readFile(join(dir, "replays", analysis.id), "utf8"),
    "replay",
  );

  const one = await fetch(`${url}/api/analyses/${analysis.id}`);
  assert.deepEqual(await one.json(), analysis);

  const [summary] = await (await fetch(`${url}/api/analyses`)).json();
  assert.equal(summary.id, analysis.id);
  assert.equal(summary.delta, 1);
  assert.equal(summary.worldRecord, 60);
});

test("refuses uploads without the token, too large, or not a run", async (t) => {
  const { url, close } = await serve();
  t.after(close);

  assert.equal((await post(url, "replay", "wrong")).status, 401);
  assert.equal((await post(url, "x".repeat(17))).status, 413);
  assert.equal((await post(url, "bad")).status, 422);
  assert.equal((await fetch(`${url}/api/analyses/not-an-id`)).status, 404);
  assert.equal((await fetch(`${url}/elsewhere`)).status, 418);
});

test("an unset token disables uploads instead of opening them", async (t) => {
  const { url, close } = await serve({ token: "" });
  t.after(close);
  assert.equal((await post(url, "replay", "")).status, 503);
});

test("the watcher skips old replays and sends a new one once it stops growing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-watch-"));
  await writeFile(join(dir, "old.replay"), "old");
  const sent = [];
  const watcher = createWatcher({
    dir,
    apiUrl: "http://api",
    token: "secret",
    statePath: join(dir, "state.json"),
    log: () => {},
    fetchImpl: async (url, { body }) => {
      sent.push(String(body));
      return new Response(
        JSON.stringify({ run: review.run, watch: "/watch?ids=x" }),
        { status: 201 },
      );
    },
  });

  await watcher.poll();
  await writeFile(join(dir, "new.replay"), "new");
  await watcher.poll(); // first sighting: might still be half written
  assert.deepEqual(sent, []);
  await watcher.poll();
  assert.deepEqual(sent, ["new"]);
  await watcher.poll();
  assert.deepEqual(sent, ["new"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "state.json"), "utf8")).sort(),
    ["new.replay", "old.replay"],
  );
});
