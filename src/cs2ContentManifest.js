import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { readManifestFiles } from "./cs2Manifest.js";

export const CS2_CONTENT_DEPOT = "2347770";
export const CS2_CONTENT_MANIFEST_GID = "7673916425787288234";

export class ContentManifestError extends Error {
  constructor(message, options) {
    super(`CS2 manifest ${CS2_CONTENT_MANIFEST_GID}: ${message}`, options);
    this.code = "CS2_CONTENT_MANIFEST_MISMATCH";
  }
}

export const readPinnedContentManifest = async (cs2Dir) => {
  const path = join(
    cs2Dir,
    ".DepotDownloader",
    `${CS2_CONTENT_DEPOT}_${CS2_CONTENT_MANIFEST_GID}.manifest`,
  );
  try {
    return await readManifestFiles(path);
  } catch (cause) {
    throw new ContentManifestError(
      `cannot read pinned depot manifest ${path}`,
      { cause },
    );
  }
};

export const manifestChunks = (name, entry) => {
  if (
    !Number.isSafeInteger(entry?.size) ||
    entry.size <= 0 ||
    !Array.isArray(entry.chunks)
  )
    throw new ContentManifestError(`invalid file metadata for ${name}`);
  const chunks = [...entry.chunks].sort((a, b) => a.offset - b.offset);
  let offset = 0;
  for (const chunk of chunks) {
    if (
      !/^[a-f0-9]{40}$/.test(chunk.sha ?? "") ||
      chunk.offset !== offset ||
      !Number.isSafeInteger(chunk.size) ||
      chunk.size <= 0 ||
      !Number.isSafeInteger(offset + chunk.size)
    )
      throw new ContentManifestError(`invalid chunk coverage for ${name}`);
    offset += chunk.size;
  }
  if (offset !== entry.size)
    throw new ContentManifestError(`incomplete chunk coverage for ${name}`);
  return chunks;
};

// The lower-level transfer deduplicates by SHA. Keep repeated occurrences in
// separate batches so every required destination offset receives verified bytes.
export const chunkOccurrenceBatches = (chunks) => {
  const counts = new Map(),
    batches = [];
  for (const chunk of chunks) {
    const occurrence = counts.get(chunk.sha) ?? 0;
    counts.set(chunk.sha, occurrence + 1);
    (batches[occurrence] ??= []).push(chunk);
  }
  return batches;
};

export const chunksForRanges = (name, entry, ranges) => {
  const chunks = manifestChunks(name, entry);
  if (!ranges) return chunks;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.size) ||
      range.offset < 0 ||
      range.size <= 0 ||
      range.offset + range.size > entry.size
    )
      throw new ContentManifestError(`index addresses bytes outside ${name}`);
  }
  return chunks.filter((chunk) =>
    ranges.some(
      (range) =>
        chunk.offset < range.offset + range.size &&
        chunk.offset + chunk.size > range.offset,
    ),
  );
};

/** Prove old or newly downloaded bytes belong to the selected manifest. */
export const verifyDepotFile = async (path, name, entry, ranges) => {
  const chunks = chunksForRanges(name, entry, ranges);
  let file;
  try {
    file = await open(path, "r");
    if ((await file.stat()).size !== entry.size)
      throw new Error("file size differs");
    const hash = createHash("sha256");
    for (const chunk of chunks) {
      const bytes = Buffer.allocUnsafe(chunk.size);
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(
          bytes,
          read,
          bytes.length - read,
          chunk.offset + read,
        );
        if (!result.bytesRead)
          throw new Error(`truncated chunk at ${chunk.offset}`);
        read += result.bytesRead;
      }
      if (createHash("sha1").update(bytes).digest("hex") !== chunk.sha)
        throw new Error(`chunk hash differs at ${chunk.offset}`);
      hash.update(bytes);
    }
    return ranges ? null : hash.digest("hex");
  } catch (cause) {
    throw new ContentManifestError(
      `${name} does not match pinned content (${cause.message}); preserve this cache and use a separate cache for another version`,
      { cause },
    );
  } finally {
    await file?.close();
  }
};

export const verifyPinnedContentIndex = async (cs2Dir, files) => {
  files ??= await readPinnedContentManifest(cs2Dir);
  const index = "game/csgo/pak01_dir.vpk",
    gameInfo = "game/csgo/gameinfo.gi";
  const indexSha256 = await verifyDepotFile(
    join(cs2Dir, index),
    index,
    files.get(index),
  );
  await verifyDepotFile(join(cs2Dir, gameInfo), gameInfo, files.get(gameInfo));
  return { manifest: CS2_CONTENT_MANIFEST_GID, indexSha256, files };
};
