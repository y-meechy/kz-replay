import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendJson = (response, status, body) => {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
};

const isPrivatePeer = (peer) => {
  const v4 = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  const octets = v4.split(".");
  const second = Number(octets[1]);
  return (
    peer === "::1" ||
    v4 === "127.0.0.1" ||
    v4.startsWith("10.") ||
    v4.startsWith("192.168.") ||
    (octets[0] === "172" && second >= 16 && second <= 31)
  );
};

export const requestAddress = (request) => {
  const peer = request.socket?.remoteAddress ?? "";
  if (!isPrivatePeer(peer)) return peer;
  return String(request.headers["x-forwarded-for"] ?? peer)
    .split(",")[0]
    .trim();
};

export const createReplayProxy = ({
  baseUrl = "https://replays.cs2kz.org",
  timeoutMs = 120_000,
  maxBytes = 8_000_000,
  maxConcurrent = 8,
  requestsPerMinute = 60,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
} = {}) => {
  let inFlight = 0;
  const budgets = new Map();

  const requestAllowed = (request) => {
    const currentTime = now();
    const address = requestAddress(request);
    const budget = budgets.get(address);
    if (!budget || currentTime - budget.startedAt >= 60_000) {
      budgets.set(address, { startedAt: currentTime, count: 1 });
      if (budgets.size > 10_000) {
        for (const [other, value] of budgets) {
          if (currentTime - value.startedAt >= 60_000) budgets.delete(other);
        }
      }
      return true;
    }
    if (budget.count >= requestsPerMinute) return false;
    budget.count += 1;
    return true;
  };

  const fetchReplay = async (response, recordId, headOnly) => {
    if (!RECORD_ID.test(recordId)) {
      sendJson(response, 400, { error: "that is not a record id" });
      return;
    }

    const upstream = await fetchImpl(`${baseUrl}/${recordId}`, {
      method: headOnly ? "HEAD" : "GET",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      log(`replay ${recordId} unreachable: ${error.message}`);
      return null;
    });

    if (!upstream) {
      sendJson(response, 502, { error: "the replay bucket is unreachable" });
      return;
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      sendJson(response, upstream.status === 404 ? 404 : 502, {
        error:
          upstream.status === 404
            ? "no replay stored for that record"
            : `the replay bucket returned ${upstream.status}`,
      });
      return;
    }

    const lengthHeader = upstream.headers.get("content-length");
    const parsedLength = lengthHeader === null ? NaN : Number(lengthHeader);
    const declaredLength =
      Number.isSafeInteger(parsedLength) && parsedLength >= 0
        ? parsedLength
        : null;
    if (declaredLength !== null && declaredLength > maxBytes) {
      await upstream.body?.cancel();
      sendJson(response, 502, { error: "the replay is unexpectedly large" });
      return;
    }

    const headers = {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=604800, immutable",
    };
    if (declaredLength !== null) headers["content-length"] = declaredLength;
    response.writeHead(200, headers);
    if (headOnly) {
      await upstream.body?.cancel();
      response.end();
      return;
    }

    try {
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(
            received > maxBytes
              ? new Error(`replay exceeded ${maxBytes} bytes`)
              : null,
            chunk,
          );
        },
      });
      await pipeline(Readable.fromWeb(upstream.body), limit, response);
    } catch (error) {
      log(`replay ${recordId} stream broke: ${error.message}`);
      response.destroy();
    }
  };

  return async (request, response, recordId, headOnly = false) => {
    if (!requestAllowed(request)) {
      sendJson(response, 429, { error: "too many replay requests" });
      return;
    }
    if (inFlight >= maxConcurrent) {
      sendJson(response, 503, { error: "the replay proxy is busy" });
      return;
    }
    inFlight += 1;
    try {
      await fetchReplay(response, recordId, headOnly);
    } finally {
      inFlight -= 1;
    }
  };
};
