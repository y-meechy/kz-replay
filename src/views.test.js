import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createViewCounter } from "./views.js";

const RECORD_ID = "11111111-1111-1111-1111-111111111111";

test("close cancels the debounce and persists a pending view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kz-views-"));
  const path = join(directory, "views.json");
  const counter = createViewCounter({ path, writeDelayMs: 60_000 });

  await counter.add(RECORD_ID, { visitor: "one", address: "127.0.0.1" });
  await counter.close();

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.runs[RECORD_ID], 1);
  assert.equal(stored.total, 1);
  assert.equal(counter.stats().pendingWrite, false);
});

test("close waits for an in-flight write and then persists newer counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kz-views-"));
  let announceFirstWrite;
  let releaseFirstWrite;
  const firstWriteStarted = new Promise((resolve) => {
    announceFirstWrite = resolve;
  });
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writes = [];
  let calls = 0;
  const counter = createViewCounter({
    path: join(directory, "views.json"),
    writeDelayMs: 0,
    write: async (_path, body) => {
      calls += 1;
      if (calls === 1) {
        announceFirstWrite();
        await firstWriteGate;
      }
      writes.push(body);
    },
  });

  await counter.add(RECORD_ID, { visitor: "one", address: "127.0.0.1" });
  // Keep the test process alive while the production debounce timer is unref'ed.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await firstWriteStarted;
  await counter.add(RECORD_ID, { visitor: "two", address: "127.0.0.1" });

  const closed = counter.close();
  releaseFirstWrite();
  await closed;

  assert.equal(writes.at(-1).runs[RECORD_ID], 2);
  assert.equal(writes.at(-1).total, 2);
});

test("close is idempotent and retries a failed pending write once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kz-views-"));
  const writes = [];
  const counter = createViewCounter({
    path: join(directory, "views.json"),
    writeDelayMs: 60_000,
    write: async (_path, body) => {
      writes.push(body);
      if (writes.length === 1) throw new Error("temporary failure");
    },
  });

  await counter.add(RECORD_ID, { visitor: "one", address: "127.0.0.1" });
  const firstClose = counter.close();
  const secondClose = counter.close();

  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].runs[RECORD_ID], 1);
});
