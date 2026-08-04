import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP_FILE =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f-]{36}\.tmp$/;

const sendJson = (response, status, body, headers = {}) => {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...headers,
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
  maxBytes = 67_108_864,
  cacheDir = join(tmpdir(), "kz-replay-cache"),
  cacheMaxBytes = 4 * 1024 * 1024 * 1024,
  maxConcurrent = 8,
  maxConcurrentPerIp = 2,
  requestsPerMinute = 60,
  byteBurst = 256 * 1024 * 1024,
  bytesPerHour = 1024 * 1024 * 1024,
  maxByteBudgets = 10_000,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
} = {}) => {
  let inFlight = 0;
  const addressInFlight = new Map();
  const requestBudgets = new Map();
  const byteBudgets = new Map();
  const downloads = new Map();
  const pinnedReplays = new Map();
  const activeTemporaryFiles = new Set();
  let eviction = Promise.resolve();
  let cacheOverLimit = false;
  let cacheChecked = false;

  const requestAllowed = (address) => {
    const currentTime = now();
    const budget = requestBudgets.get(address);
    if (!budget || currentTime - budget.startedAt >= 60_000) {
      requestBudgets.set(address, { startedAt: currentTime, count: 1 });
      if (requestBudgets.size > 10_000) {
        for (const [other, value] of requestBudgets) {
          if (currentTime - value.startedAt >= 60_000)
            requestBudgets.delete(other);
        }
      }
      return null;
    }
    if (budget.count >= requestsPerMinute)
      return Math.ceil((60_000 - (currentTime - budget.startedAt)) / 1000);
    budget.count += 1;
    return null;
  };

  const chargeBytes = (address, bytes) => {
    const currentTime = now();
    if (!byteBudgets.has(address) && byteBudgets.size >= maxByteBudgets) {
      for (const [other, budget] of byteBudgets) {
        if (
          budget.available +
            ((currentTime - budget.updatedAt) * bytesPerHour) / 3_600_000 >=
          byteBurst
        ) {
          byteBudgets.delete(other);
        }
      }
      if (byteBudgets.size >= maxByteBudgets) {
        const oldest = [...byteBudgets.entries()]
          .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
          .slice(0, byteBudgets.size - maxByteBudgets + 1);
        for (const [other] of oldest) byteBudgets.delete(other);
      }
    }
    const previous = byteBudgets.get(address);
    const available = previous
      ? Math.min(
          byteBurst,
          previous.available +
            ((currentTime - previous.updatedAt) * bytesPerHour) / 3_600_000,
        )
      : byteBurst;
    if (available < bytes) {
      byteBudgets.set(address, { available, updatedAt: currentTime });
      return Math.max(
        1,
        Math.ceil(((bytes - available) * 3_600_000) / bytesPerHour / 1000),
      );
    }
    byteBudgets.set(address, {
      available: available - bytes,
      updatedAt: currentTime,
    });
    return null;
  };

  const upstreamReplay = async (recordId, method) => {
    const upstream = await fetchImpl(`${baseUrl}/${recordId}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      log(`replay ${recordId} unreachable: ${error.message}`);
      return null;
    });

    if (!upstream) {
      return { error: [502, "the replay bucket is unreachable"] };
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return {
        error: [
          upstream.status === 404 ? 404 : 502,
          upstream.status === 404
            ? "no replay stored for that record"
            : `the replay bucket returned ${upstream.status}`,
        ],
      };
    }

    const lengthHeader = upstream.headers.get("content-length");
    const parsedLength = lengthHeader === null ? NaN : Number(lengthHeader);
    const declaredLength =
      Number.isSafeInteger(parsedLength) && parsedLength >= 0
        ? parsedLength
        : null;
    if (declaredLength !== null && declaredLength > maxBytes) {
      await upstream.body?.cancel();
      return { error: [502, "the replay is unexpectedly large"] };
    }
    return { upstream, declaredLength };
  };

  const cachedReplay = async (recordId) => {
    const path = join(cacheDir, recordId);
    if (!cacheChecked) {
      cacheChecked = true;
      await queueEviction(path);
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    if (info.size > maxBytes) {
      await rm(path, { force: true });
      log(`replay cache rejected oversized ${path}`);
      return { error: [502, "the cached replay is unexpectedly large"] };
    }
    return { path, size: info.size };
  };

  const evictOldReplays = async (keepPath) => {
    const entries = await readdir(cacheDir, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            TEMP_FILE.test(entry.name) &&
            !activeTemporaryFiles.has(join(cacheDir, entry.name)),
        )
        .map((entry) => rm(join(cacheDir, entry.name), { force: true })),
    );
    const cached = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && RECORD_ID.test(entry.name))
        .map(async (entry) => {
          const path = join(cacheDir, entry.name);
          const info = await stat(path).catch(() => null);
          return info?.isFile()
            ? { path, size: info.size, createdAt: info.mtimeMs }
            : null;
        }),
    );
    const files = cached.filter(Boolean);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((left, right) => left.createdAt - right.createdAt);
    for (const file of files) {
      if (total <= cacheMaxBytes) break;
      if (file.path === keepPath || pinnedReplays.has(file.path)) continue;
      await rm(file.path, { force: true });
      total -= file.size;
      log(`replay cache evicted ${file.path}`);
    }
    cacheOverLimit = total > cacheMaxBytes;
  };

  const queueEviction = (keepPath = null) => {
    eviction = eviction.then(
      () => evictOldReplays(keepPath),
      () => evictOldReplays(keepPath),
    );
    return eviction;
  };

  const downloadReplay = async (recordId) => {
    const result = await upstreamReplay(recordId, "GET");
    if (result.error) return result;
    if (!result.upstream.body) {
      return { error: [502, "the replay bucket returned no body"] };
    }

    await mkdir(cacheDir, { recursive: true });
    const path = join(cacheDir, recordId);
    const temporaryPath = join(cacheDir, `.${recordId}.${randomUUID()}.tmp`);
    let file;
    activeTemporaryFiles.add(temporaryPath);
    try {
      file = await open(temporaryPath, "wx");
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
      await pipeline(
        Readable.fromWeb(result.upstream.body),
        limit,
        file.createWriteStream(),
      );
      file = null;
      await rename(temporaryPath, path);
      activeTemporaryFiles.delete(temporaryPath);
      await queueEviction(path);
      cacheChecked = true;
      return { path, size: received };
    } catch (error) {
      activeTemporaryFiles.delete(temporaryPath);
      await file?.close().catch(() => {});
      await result.upstream.body?.cancel().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error.message === `replay exceeded ${maxBytes} bytes`) {
        log(`replay ${recordId} rejected: ${error.message}`);
        return { error: [502, "the replay is unexpectedly large"] };
      }
      log(`replay ${recordId} cache write failed: ${error.message}`);
      return { error: [502, "the replay could not be cached"] };
    }
  };

  const getReplay = async (recordId) => {
    const cached = await cachedReplay(recordId);
    if (cached) return cached;

    let download = downloads.get(recordId);
    if (!download) {
      download = downloadReplay(recordId).finally(() => {
        downloads.delete(recordId);
      });
      downloads.set(recordId, download);
    }
    return download;
  };

  const sendHead = async (response, recordId) => {
    const cached = await cachedReplay(recordId);
    if (cached?.error) {
      sendJson(response, cached.error[0], { error: cached.error[1] });
      return;
    }
    if (cached) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": cached.size,
        "cache-control": "public, max-age=604800, immutable",
      });
      response.end();
      return;
    }

    const result = await upstreamReplay(recordId, "HEAD");
    if (result.error) {
      sendJson(response, result.error[0], { error: result.error[1] });
      return;
    }
    await result.upstream.body?.cancel();
    const headers = {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=604800, immutable",
    };
    if (result.declaredLength !== null)
      headers["content-length"] = result.declaredLength;
    response.writeHead(200, headers);
    response.end();
  };

  const sendReplay = async (response, recordId, address) => {
    const path = join(cacheDir, recordId);
    pinnedReplays.set(path, (pinnedReplays.get(path) ?? 0) + 1);
    try {
      const replay = await getReplay(recordId);
      if (replay.error) {
        sendJson(response, replay.error[0], { error: replay.error[1] });
        return;
      }
      let file;
      try {
        file = await open(replay.path, "r");
      } catch (error) {
        log(`replay ${recordId} cache read failed: ${error.message}`);
        sendJson(response, 502, { error: "the cached replay is unavailable" });
        return;
      }
      const retryAfter = chargeBytes(address, replay.size);
      if (retryAfter !== null) {
        await file.close();
        sendJson(
          response,
          429,
          { error: "replay bandwidth limit exceeded" },
          { "retry-after": retryAfter },
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": replay.size,
        "cache-control": "public, max-age=604800, immutable",
      });
      try {
        await pipeline(file.createReadStream(), response);
      } catch (error) {
        log(`replay ${recordId} stream broke: ${error.message}`);
        if (!response.destroyed) response.destroy(error);
      }
    } finally {
      const remainingPins = (pinnedReplays.get(path) ?? 1) - 1;
      if (remainingPins === 0) pinnedReplays.delete(path);
      else pinnedReplays.set(path, remainingPins);
      if (cacheOverLimit) await queueEviction();
    }
  };

  return async (request, response, recordId, headOnly = false) => {
    const normalizedId = recordId.toLowerCase();
    if (!RECORD_ID.test(normalizedId)) {
      sendJson(response, 400, { error: "that is not a record id" });
      return;
    }

    const address = requestAddress(request);
    const requestRetryAfter = requestAllowed(address);
    if (requestRetryAfter !== null) {
      sendJson(
        response,
        429,
        { error: "too many replay requests" },
        { "retry-after": requestRetryAfter },
      );
      return;
    }
    if ((addressInFlight.get(address) ?? 0) >= maxConcurrentPerIp) {
      sendJson(
        response,
        429,
        { error: "too many concurrent replay requests" },
        { "retry-after": 1 },
      );
      return;
    }
    if (inFlight >= maxConcurrent) {
      sendJson(
        response,
        503,
        { error: "the replay proxy is busy" },
        { "retry-after": 1 },
      );
      return;
    }

    inFlight += 1;
    addressInFlight.set(address, (addressInFlight.get(address) ?? 0) + 1);
    try {
      if (headOnly) await sendHead(response, normalizedId);
      else await sendReplay(response, normalizedId, address);
    } finally {
      inFlight -= 1;
      const remaining = (addressInFlight.get(address) ?? 1) - 1;
      if (remaining === 0) addressInFlight.delete(address);
      else addressInFlight.set(address, remaining);
    }
  };
};
