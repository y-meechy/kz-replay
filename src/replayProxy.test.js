import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { createReplayProxy, requestAddress } from "../server/replayProxy.js";

const RECORD_ID = "12345678-1234-1234-1234-123456789abc";
const OTHER_ID = "abcdefab-1234-1234-1234-123456789abc";
const THIRD_ID = "feedfeed-1234-1234-1234-123456789abc";

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.body = [];
    this.headers = {};
    this.statusCode = null;
  }

  _write(chunk, _encoding, callback) {
    this.body.push(Buffer.from(chunk));
    callback();
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  text() {
    return Buffer.concat(this.body).toString();
  }
}

const request = (address = "203.0.113.10", headers = {}) => ({
  headers,
  socket: { remoteAddress: address },
});

const testProxy = async (t, options = {}) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "kz-replay-test-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return {
    cacheDir,
    proxy: createReplayProxy({ cacheDir, ...options }),
  };
};

test("replay proxy caches a body without a declared length", async (t) => {
  const response = new CaptureResponse();
  const { cacheDir, proxy } = await testProxy(t, {
    maxBytes: 8,
    fetchImpl: async () => new Response("replay"),
  });

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-length"], 6);
  assert.equal(response.text(), "replay");
  assert.deepEqual(await readdir(cacheDir), [RECORD_ID]);
});

test("replay proxy accepts the exact size limit and rejects one byte more", async (t) => {
  let body = "1234";
  const { proxy } = await testProxy(t, {
    maxBytes: 4,
    fetchImpl: async () => new Response(body),
  });
  const boundary = new CaptureResponse();
  await proxy(request(), boundary, RECORD_ID);
  assert.equal(boundary.statusCode, 200);
  assert.equal(boundary.text(), "1234");

  body = "12345";
  const oversized = new CaptureResponse();
  await proxy(request(), oversized, OTHER_ID);
  assert.equal(oversized.statusCode, 502);
  assert.match(oversized.text(), /unexpectedly large/);
});

test("replay proxy rejects a declared oversized body before caching", async (t) => {
  const { cacheDir, proxy } = await testProxy(t, {
    maxBytes: 4,
    fetchImpl: async () =>
      new Response("large", { headers: { "content-length": "5" } }),
  });
  const response = new CaptureResponse();

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 502);
  assert.match(response.text(), /unexpectedly large/);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("replay proxy rejects an oversized stream with a misleading length", async (t) => {
  const messages = [];
  const { proxy } = await testProxy(t, {
    maxBytes: 4,
    log: (message) => messages.push(message),
    fetchImpl: async () =>
      new Response("large", { headers: { "content-length": "2" } }),
  });
  const response = new CaptureResponse();

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 502);
  assert.match(response.text(), /unexpectedly large/);
  assert.match(messages.join("\n"), /exceeded 4 bytes/);
});

test("GET and HEAD reject and remove an oversized cached replay", async (t) => {
  let fetches = 0;
  const { cacheDir, proxy } = await testProxy(t, {
    maxBytes: 4,
    fetchImpl: async () => {
      fetches += 1;
      return new Response("upstream");
    },
  });
  const path = join(cacheDir, RECORD_ID);
  await writeFile(path, "12345");

  const getResponse = new CaptureResponse();
  await proxy(request(), getResponse, RECORD_ID);
  assert.equal(getResponse.statusCode, 502);
  assert.match(getResponse.text(), /unexpectedly large/);
  await assert.rejects(access(path));

  await writeFile(path, "12345");
  const headResponse = new CaptureResponse();
  await proxy(request(), headResponse, RECORD_ID, true);
  assert.equal(headResponse.statusCode, 502);
  assert.match(headResponse.text(), /unexpectedly large/);
  await assert.rejects(access(path));
  assert.equal(fetches, 0);
});

test("lazy cache cleanup removes abandoned replay temp files", async (t) => {
  const { cacheDir, proxy } = await testProxy(t, {
    fetchImpl: async () =>
      new Response(null, { headers: { "content-length": "4" } }),
  });
  const orphan = join(
    cacheDir,
    `.${RECORD_ID}.11111111-1111-1111-1111-111111111111.tmp`,
  );
  const unrelated = join(cacheDir, ".operator.tmp");
  await writeFile(orphan, "partial download");
  await writeFile(unrelated, "keep");

  const response = new CaptureResponse();
  await proxy(request(), response, RECORD_ID, true);

  assert.equal(response.statusCode, 200);
  await assert.rejects(access(orphan));
  await access(unrelated);
});

test("HEAD misses use upstream HEAD and cache hits stay local", async (t) => {
  const methods = [];
  const { proxy } = await testProxy(t, {
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return options.method === "HEAD"
        ? new Response(null, { headers: { "content-length": "42" } })
        : new Response("cached");
    },
  });

  const miss = new CaptureResponse();
  await proxy(request(), miss, RECORD_ID, true);
  assert.equal(miss.statusCode, 200);
  assert.equal(miss.headers["content-length"], 42);
  assert.deepEqual(methods, ["HEAD"]);

  await proxy(request(), new CaptureResponse(), RECORD_ID);
  const hit = new CaptureResponse();
  await proxy(request(), hit, RECORD_ID, true);
  assert.equal(hit.statusCode, 200);
  assert.equal(hit.headers["content-length"], 6);
  assert.equal(hit.text(), "");
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("concurrent cache misses for a normalized UUID share one download", async (t) => {
  let release;
  let fetchStarted;
  let fetches = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const { proxy } = await testProxy(t, {
    fetchImpl: async () => {
      fetches += 1;
      fetchStarted();
      await pending;
      return new Response("shared");
    },
  });
  const firstResponse = new CaptureResponse();
  const secondResponse = new CaptureResponse();
  const first = proxy(request("203.0.113.1"), firstResponse, RECORD_ID);
  const second = proxy(
    request("203.0.113.2"),
    secondResponse,
    RECORD_ID.toUpperCase(),
  );

  await started;
  assert.equal(fetches, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(firstResponse.text(), "shared");
  assert.equal(secondResponse.text(), "shared");

  await proxy(request("203.0.113.3"), new CaptureResponse(), RECORD_ID);
  assert.equal(fetches, 1);
});

test("replay proxy preserves request and global concurrency limits", async (t) => {
  const rate = await testProxy(t, {
    requestsPerMinute: 1,
    fetchImpl: async () => new Response("ok"),
  });
  await rate.proxy(request(), new CaptureResponse(), RECORD_ID);
  const rateResponse = new CaptureResponse();
  await rate.proxy(request(), rateResponse, RECORD_ID);
  assert.equal(rateResponse.statusCode, 429);
  assert.equal(rateResponse.headers["retry-after"], 60);

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const concurrent = await testProxy(t, {
    maxConcurrent: 1,
    fetchImpl: () => pending,
  });
  const first = concurrent.proxy(
    request("203.0.113.1"),
    new CaptureResponse(),
    RECORD_ID,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const busyResponse = new CaptureResponse();
  await concurrent.proxy(request("203.0.113.2"), busyResponse, OTHER_ID);
  assert.equal(busyResponse.statusCode, 503);
  assert.equal(busyResponse.headers["retry-after"], 1);
  release(new Response("ok"));
  await first;
});

test("replay proxy limits concurrent requests per address", async (t) => {
  let release;
  let started = 0;
  let bothStarted;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const { proxy } = await testProxy(t, {
    fetchImpl: async () => {
      started += 1;
      if (started === 2) bothStarted();
      await pending;
      return new Response("ok");
    },
  });
  const first = proxy(request(), new CaptureResponse(), RECORD_ID);
  const second = proxy(request(), new CaptureResponse(), OTHER_ID);
  await ready;
  const limited = new CaptureResponse();
  await proxy(request(), limited, THIRD_ID);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], 1);
  release();
  await Promise.all([first, second]);
});

test("byte budget charges cache hits and refills over time", async (t) => {
  let currentTime = 0;
  let fetches = 0;
  const { proxy } = await testProxy(t, {
    byteBurst: 5,
    bytesPerHour: 4,
    now: () => currentTime,
    fetchImpl: async () => {
      fetches += 1;
      return new Response("1234");
    },
  });
  const address = request();
  const first = new CaptureResponse();
  await proxy(address, first, RECORD_ID);
  assert.equal(first.statusCode, 200);

  const exhausted = new CaptureResponse();
  await proxy(address, exhausted, RECORD_ID);
  assert.equal(exhausted.statusCode, 429);
  assert.equal(exhausted.headers["retry-after"], 2700);
  assert.equal(fetches, 1);

  currentTime += 45 * 60_000;
  const refilled = new CaptureResponse();
  await proxy(address, refilled, RECORD_ID);
  assert.equal(refilled.statusCode, 200);
  assert.equal(refilled.text(), "1234");
  assert.equal(fetches, 1);
});

test("byte budget state stays bounded across changing addresses", async (t) => {
  let currentTime = 0;
  let fetches = 0;
  const { proxy } = await testProxy(t, {
    byteBurst: 4,
    bytesPerHour: 1,
    maxByteBudgets: 2,
    now: () => currentTime,
    fetchImpl: async () => {
      fetches += 1;
      return new Response("1234");
    },
  });

  for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    const response = new CaptureResponse();
    await proxy(request(address), response, RECORD_ID);
    assert.equal(response.statusCode, 200);
    currentTime += 1;
  }

  const oldestAddress = new CaptureResponse();
  await proxy(request("203.0.113.1"), oldestAddress, RECORD_ID);
  assert.equal(oldestAddress.statusCode, 200);
  assert.equal(fetches, 1);
});

test("cache lazily evicts the oldest immutable replay", async (t) => {
  const { cacheDir, proxy } = await testProxy(t, {
    cacheMaxBytes: 6,
    fetchImpl: async () => new Response("1234"),
  });
  await proxy(request(), new CaptureResponse(), RECORD_ID);
  await utimes(join(cacheDir, RECORD_ID), new Date(0), new Date(0));
  await proxy(request(), new CaptureResponse(), OTHER_ID);

  await assert.rejects(access(join(cacheDir, RECORD_ID)));
  await access(join(cacheDir, OTHER_ID));
});

test("forwarded addresses are accepted only from private peers", () => {
  assert.equal(
    requestAddress(
      request("172.20.0.2", { "x-forwarded-for": "198.51.100.8" }),
    ),
    "198.51.100.8",
  );
  assert.equal(
    requestAddress(
      request("203.0.113.7", { "x-forwarded-for": "198.51.100.8" }),
    ),
    "203.0.113.7",
  );
});
