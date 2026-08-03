import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createReplayProxy, requestAddress } from "../server/replayProxy.js";

const RECORD_ID = "12345678-1234-1234-1234-123456789abc";

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

test("replay proxy streams a body without a declared length", async () => {
  const response = new CaptureResponse();
  const proxy = createReplayProxy({
    maxBytes: 8,
    fetchImpl: async () => new Response("replay"),
  });

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.text(), "replay");
});

test("replay proxy rejects a declared oversized body before streaming", async () => {
  const response = new CaptureResponse();
  const proxy = createReplayProxy({
    maxBytes: 4,
    fetchImpl: async () =>
      new Response("large", { headers: { "content-length": "5" } }),
  });

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 502);
  assert.match(response.text(), /unexpectedly large/);
});

test("replay proxy stops an oversized stream with a misleading length", async () => {
  const response = new CaptureResponse();
  const messages = [];
  const proxy = createReplayProxy({
    maxBytes: 4,
    log: (message) => messages.push(message),
    fetchImpl: async () =>
      new Response("large", { headers: { "content-length": "2" } }),
  });

  await proxy(request(), response, RECORD_ID);

  assert.equal(response.statusCode, 200);
  assert.ok(response.destroyed);
  assert.match(messages.join("\n"), /exceeded 4 bytes/);
});

test("replay proxy forwards HEAD without downloading a body", async () => {
  const response = new CaptureResponse();
  let method = null;
  const proxy = createReplayProxy({
    fetchImpl: async (_url, options) => {
      method = options.method;
      return new Response(null, { headers: { "content-length": "42" } });
    },
  });

  await proxy(request(), response, RECORD_ID, true);

  assert.equal(method, "HEAD");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-length"], 42);
  assert.equal(response.text(), "");
});

test("replay proxy enforces per-address and concurrency limits", async () => {
  const rateLimited = createReplayProxy({
    requestsPerMinute: 1,
    fetchImpl: async () => new Response("ok"),
  });
  await rateLimited(request(), new CaptureResponse(), RECORD_ID);
  const rateResponse = new CaptureResponse();
  await rateLimited(request(), rateResponse, RECORD_ID);
  assert.equal(rateResponse.statusCode, 429);

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const concurrent = createReplayProxy({
    maxConcurrent: 1,
    fetchImpl: () => pending,
  });
  const first = concurrent(
    request("203.0.113.1"),
    new CaptureResponse(),
    RECORD_ID,
  );
  const busyResponse = new CaptureResponse();
  await concurrent(request("203.0.113.2"), busyResponse, RECORD_ID);
  assert.equal(busyResponse.statusCode, 503);
  release(new Response("ok"));
  await first;
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
