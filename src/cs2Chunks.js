// Fetch single assets out of the CS2 depot, at chunk granularity.
//
// cs2Content.js borrows whole archive parts, which works and is coarse: a part is about
// 105 MB and holds thousands of unrelated assets, so kz_victoria's seven missing base
// game materials cost 735 MB and every CS2 sky costs 2.5 GB.
//
// A depot is not stored as those parts, though. Steam stores it as content-addressed
// chunks of about 250 KB, and the manifest says which chunks cover which byte range of
// which file. The VPK index says which byte range of which part holds a given asset. Put
// the two together and an asset costs the chunks it actually overlaps: the same seven
// materials come to roughly 20 MB, and every sky for every map to about 60 MB.
//
// What arrives per chunk, in order:
//
//   1. HTTPS GET `https://<cache host>/depot/<depot>/chunk/<sha hex>`. No auth on the
//      request itself — the CDN serves the object to anyone who knows the hash.
//   2. Steam symmetric decryption with the depot key: the first 16 bytes are the IV,
//      encrypted with AES-256-ECB, and the rest is AES-256-CBC under that IV.
//   3. A `VSZa` container: four byte magic, a four byte id, then the payload, then a
//      15 byte trailer ending in `zsv`.
//   4. The payload is **zstd**, not zip. Every tool and library that predates this
//      change assumes zip and fails on `BadZipFile`, which is what made the format look
//      undocumented. fzstd is already a dependency here, for the replay sections.
//
// The one thing that cannot be done from Node is the depot key: it comes over Steam's
// own protocol, which is days of work to implement and one line of Python through the
// `steam` package. Keys change only when Valve rotates them, so it is fetched once by
// scripts/cs2-depot-key.py and cached on disk; everything after that is Node.
//
// Byte ranges are written into a sparse file at their real offsets, and the gaps are
// left as holes. That is safe because nothing ever reads them: ValveResourceFormat seeks
// to an asset's offset and reads its length, and the VPK index it seeks by is a file we
// fetched in full.

import { createHash, createDecipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { decompress } from "fzstd";
import { TOOL_TIMEOUT_MS } from "./toolProcess.js";

// Steam wraps a chunk in one of two containers, and a depot mixes them freely: of the
// 111 chunks of pak01_286.vpk, one was zstd and the rest LZMA. Both end in a two byte
// marker and carry the uncompressed length in their trailer.
//
//   VSZa  4 byte magic, 4 byte id, zstd stream, 15 byte trailer ending "zsv"
//   VZa   "VZ" + version, 4 byte crc, 5 byte LZMA properties, raw LZMA1 stream,
//         10 byte trailer: u32 crc, u32 uncompressed size, "zv"
//
// Every tool that predates the zstd one assumes zip and dies on BadZipFile, which is what
// made this look undocumented rather than merely undescribed.
const ZSTD_MAGIC = "VSZa";
const ZSTD_HEADER = 8;
const ZSTD_TRAILER = 15;
const LZMA_MAGIC = "VZ";
const LZMA_HEADER = 12;
const LZMA_TRAILER = 10;

/**
 * Inflate a raw LZMA1 stream by handing it to `xz` as an ordinary `.lzma` file.
 *
 * Node has zlib, brotli and zstd built in, and no LZMA. The alternative to a subprocess
 * is a pure-JavaScript decoder as a new dependency; `xz` is already on every machine that
 * can build this project, and the ".lzma alone" container it reads is exactly the five
 * property bytes and the uncompressed length that the chunk trailer already gives us.
 */
const inflateLzma = async (properties, body, size) => {
  const header = Buffer.alloc(13);
  properties.copy(header, 0);
  header.writeBigUInt64LE(BigInt(size), 5);
  return new Promise((resolve, reject) => {
    const xz = execFile(
      "xz",
      ["--format=lzma", "--decompress", "--stdout"],
      {
        encoding: "buffer",
        maxBuffer: 1 << 28,
        timeout: TOOL_TIMEOUT_MS,
        killSignal: "SIGTERM",
      },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                `xz could not inflate an LZMA chunk (${error.message}). Install xz-utils.`,
              ),
            )
          : resolve(stdout),
    );
    xz.stdin.end(Buffer.concat([header, body]));
  });
};

/**
 * Undo Steam's symmetric encryption.
 *
 * The IV is not sent in the clear: the first block is the IV encrypted with AES-256-ECB
 * under the same depot key, and everything after it is ordinary AES-256-CBC.
 */
const symmetricDecrypt = (blob, key) => {
  const ivDecipher = createDecipheriv("aes-256-ecb", key, null);
  ivDecipher.setAutoPadding(false);
  const iv = Buffer.concat([
    ivDecipher.update(blob.subarray(0, 16)),
    ivDecipher.final(),
  ]);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
};

/** Strip whichever container this chunk came in, and inflate what is inside. */
export const decodeChunk = async (blob, key) => {
  const decrypted = symmetricDecrypt(blob, key);

  if (decrypted.subarray(0, 4).toString("latin1") === ZSTD_MAGIC) {
    return Buffer.from(
      decompress(
        new Uint8Array(
          decrypted.subarray(ZSTD_HEADER, decrypted.length - ZSTD_TRAILER),
        ),
      ),
    );
  }

  if (decrypted.subarray(0, 2).toString("latin1") === LZMA_MAGIC) {
    return inflateLzma(
      decrypted.subarray(7, LZMA_HEADER),
      decrypted.subarray(LZMA_HEADER, decrypted.length - LZMA_TRAILER),
      decrypted.readUInt32LE(decrypted.length - 6),
    );
  }

  // Guessing here would write silent garbage into the middle of a VPK, which surfaces
  // much later as an unreadable asset. Better to stop.
  throw new Error(
    `unknown chunk container ${JSON.stringify(decrypted.subarray(0, 4).toString("latin1"))}`,
  );
};

/**
 * The depot key, and the cache hosts to ask for chunks.
 *
 * Written by scripts/cs2-depot-key.py. Not fetched here, and not fetched implicitly:
 * a missing key is a setup step, not an error to paper over.
 */
export const readDepotAccess = async (cs2Dir) => {
  const path = join(cs2Dir, "depot-access.json");
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    key: Buffer.from(parsed.key, "hex"),
    hosts: parsed.hosts,
    manifestGid: parsed.manifestGid ?? null,
  };
};

export const writeDepotAccess = async (cs2Dir, access) => {
  const path = join(cs2Dir, "depot-access.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(access, null, 2)}\n`);
  return path;
};

/**
 * Which chunks of a file cover a byte range.
 *
 * @param chunks  the file's chunk list, from cs2Manifest.js
 * @param ranges  [{ offset, size }], the assets wanted out of that file
 */
export const chunksCovering = (chunks, ranges) => {
  const wanted = new Map();
  for (const { offset, size } of ranges) {
    const end = offset + size;
    for (const chunk of chunks) {
      const chunkEnd = chunk.offset + chunk.size;
      if (chunkEnd <= offset || chunk.offset >= end) continue;
      wanted.set(chunk.sha, chunk);
    }
  }
  // In file order, so the sparse write walks forwards and the progress log reads
  // sensibly rather than jumping about.
  return [...wanted.values()].sort((a, b) => a.offset - b.offset);
};

/**
 * Download one chunk and verify it is what was asked for.
 *
 * The sha is the hash of the *decrypted, decompressed* bytes, which makes it a real
 * end-to-end check on the key, the container and the zstd decode all at once. A wrong
 * depot key cannot silently corrupt a VPK past this point.
 */
const fetchChunk = async ({ chunk, depotId, key, hosts, attempt = 0 }) => {
  const host = hosts[attempt % hosts.length];
  const url = `${host}/depot/${depotId}/chunk/${chunk.sha}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const data = await decodeChunk(
    Buffer.from(await response.arrayBuffer()),
    key,
  );
  const digest = createHash("sha1").update(data).digest("hex");
  if (digest !== chunk.sha) {
    throw new Error(
      `chunk ${chunk.sha} decoded to something else (sha1 ${digest})`,
    );
  }
  return data;
};

const withRetries = async (task, attempts = 4) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/**
 * Write the chunks covering `ranges` into a sparse copy of a depot file.
 *
 * Existing content is kept and added to, so a second asset from the same archive part
 * only costs its own chunks. The result is a file of the right total length with holes
 * everywhere nothing was asked for.
 *
 * @returns { chunks, bytes } actually downloaded
 */
export const fetchRangesInto = async ({
  path,
  totalSize,
  chunks,
  ranges,
  depotId,
  key,
  hosts,
  concurrency = 8,
  log = () => {},
}) => {
  const needed = chunksCovering(chunks, ranges);
  if (needed.length === 0) return { chunks: 0, bytes: 0 };

  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, existsSync(path) ? "r+" : "w+");
  try {
    // Give the file its real length up front. Nothing reads the holes, but a VPK whose
    // declared size is short of what the index addresses is a harder failure to read
    // than a hole would ever be.
    await handle.truncate(totalSize);

    let downloaded = 0;
    let bytes = 0;
    let next = 0;
    const worker = async () => {
      while (next < needed.length) {
        const chunk = needed[next++];
        const data = await withRetries((attempt) =>
          fetchChunk({ chunk, depotId, key, hosts, attempt }),
        );
        await handle.write(data, 0, data.length, chunk.offset);
        downloaded += 1;
        bytes += data.length;
        if (downloaded % 25 === 0) {
          log(
            `${downloaded}/${needed.length} chunks, ${(bytes / 1e6).toFixed(0)} MB`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, needed.length) }, worker),
    );
    return { chunks: downloaded, bytes };
  } finally {
    await handle.close();
  }
};
