import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fetchRangesInto, readDepotAccess } from "./cs2Chunks.js";
import { fingerprintFile } from "./mapAssets.js";
import {
  CS2_CONTENT_DEPOT,
  CS2_CONTENT_MANIFEST_GID,
  readPinnedContentManifest,
  verifyPinnedContentIndex,
  chunkOccurrenceBatches,
} from "./cs2ContentManifest.js";

// Shader archives must match the content used while this conversion path was built.
// Selecting the newest cached manifest would silently change inputs after a CS2 update.
export const CS2_SHADER_MANIFEST_GID = CS2_CONTENT_MANIFEST_GID;

const COMPLETION_SCHEMA_VERSION = 2;
const COMPLETION_FILE = "complete.json";

export const shaderArchiveNames = (files) =>
  [...files.keys()]
    .filter((name) =>
      /^game\/(?:csgo|csgo_core|core)\/shaders_vulkan_(?:dir|\d{3})\.vpk$/.test(
        name,
      ),
    )
    .sort();

const archiveDescriptor = async (cache, name) => ({
  name,
  bytes: (await stat(join(cache, name))).size,
  sha256: (await fingerprintFile(join(cache, name))).value,
});

// fetchRangesInto avoids downloading the same content hash twice. Whole archives can
// contain that content at multiple offsets, though, and every offset must be written.
// Put each occurrence of a repeated hash in a separate fetch so the helper's transfer
// de-duplication cannot turn later occurrences into holes.
const chunkBatches = chunkOccurrenceBatches;

const validatedChunks = (name, entry) => {
  if (!Number.isSafeInteger(entry?.size) || entry.size <= 0) {
    throw new Error(`Invalid shader archive size in pinned manifest: ${name}`);
  }
  if (!Array.isArray(entry.chunks) || entry.chunks.length === 0) {
    throw new Error(`Shader archive has no chunks in pinned manifest: ${name}`);
  }
  const chunks = [...entry.chunks].sort((a, b) => a.offset - b.offset);
  let covered = 0;
  for (const chunk of chunks) {
    if (
      !/^[a-f0-9]{40}$/.test(chunk?.sha ?? "") ||
      !Number.isSafeInteger(chunk.offset) ||
      !Number.isSafeInteger(chunk.size) ||
      chunk.size <= 0 ||
      chunk.offset !== covered ||
      !Number.isSafeInteger(covered + chunk.size)
    ) {
      throw new Error(`Invalid shader archive chunk coverage: ${name}`);
    }
    covered += chunk.size;
  }
  if (covered !== entry.size) {
    throw new Error(`Incomplete shader archive chunk coverage: ${name}`);
  }
  return chunks;
};

const readCompletedArchives = async ({ cache, files, names, manifestGid }) => {
  let completion;
  try {
    completion = JSON.parse(
      await readFile(join(cache, COMPLETION_FILE), "utf8"),
    );
  } catch {
    return null;
  }
  if (
    completion.schemaVersion !== COMPLETION_SCHEMA_VERSION ||
    completion.depot !== CS2_CONTENT_DEPOT ||
    completion.manifest !== manifestGid ||
    !Array.isArray(completion.archives) ||
    completion.archives.length !== names.length
  ) {
    return null;
  }

  const recorded = new Map(
    completion.archives.map((archive) => [archive?.name, archive]),
  );
  if (recorded.size !== names.length) return null;
  for (const name of names) {
    const expected = files.get(name);
    const archive = recorded.get(name);
    if (
      !archive ||
      archive.bytes !== expected.size ||
      !/^[a-f0-9]{64}$/.test(archive.sha256 ?? "")
    ) {
      return null;
    }
    try {
      const actual = await archiveDescriptor(cache, name);
      if (actual.bytes !== archive.bytes || actual.sha256 !== archive.sha256) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return names.map((name) => recorded.get(name));
};

const writeCompletion = async (cache, manifestGid, archives) => {
  const temporary = await mkdtemp(join(cache, ".complete-"));
  const path = join(temporary, COMPLETION_FILE);
  try {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          schemaVersion: COMPLETION_SCHEMA_VERSION,
          depot: CS2_CONTENT_DEPOT,
          manifest: manifestGid,
          archives,
        },
        null,
        2,
      )}\n`,
    );
    await rename(path, join(cache, COMPLETION_FILE));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

/**
 * Materialize and verify every shader archive described by one pinned manifest.
 *
 * A depot range fetch gives its destination the final length before downloading any
 * chunks. Consequently only the hash-bearing completion record proves this cache is
 * reusable; an interrupted, correctly sized sparse file is fetched again in full.
 */
export const ensureShaderArchives = async ({
  cache,
  files,
  names,
  manifestGid,
  access,
  readAccess,
  fetchRanges = fetchRangesInto,
  log = () => {},
}) => {
  await mkdir(cache, { recursive: true });
  const entries = new Map(
    names.map((name) => {
      const entry = files.get(name);
      return [name, { ...entry, chunks: validatedChunks(name, entry) }];
    }),
  );
  const completed = await readCompletedArchives({
    cache,
    files: entries,
    names,
    manifestGid,
  });
  if (completed) return completed;

  const depotAccess = access ?? (await readAccess?.());
  if (
    !depotAccess ||
    depotAccess.key?.length !== 32 ||
    !Array.isArray(depotAccess.hosts) ||
    depotAccess.hosts.length === 0
  ) {
    throw new Error("Shader metadata requires cached CS2 depot access");
  }

  log(
    `fetching compiled shader metadata from depot manifest ${manifestGid} (${names.length} archives)`,
  );
  for (const name of names) {
    const entry = entries.get(name);
    for (const chunks of chunkBatches(entry.chunks)) {
      await fetchRanges({
        path: join(cache, name),
        totalSize: entry.size,
        chunks,
        ranges: [{ offset: 0, size: entry.size }],
        depotId: CS2_CONTENT_DEPOT,
        key: depotAccess.key,
        hosts: depotAccess.hosts,
        log,
      });
    }
  }

  const archives = [];
  for (const name of names) {
    const archive = await archiveDescriptor(cache, name);
    if (archive.bytes !== entries.get(name).size)
      throw new Error(`Incomplete shader archive: ${name}`);
    archives.push(archive);
  }
  // This is deliberately last and atomic: files with final sizes are not evidence
  // that all of their chunks arrived.
  await writeCompletion(cache, manifestGid, archives);
  return archives;
};

/**
 * VRF queries compiled shader feature/channel metadata during glTF export. Without
 * it, unknown CS2 shader mappings can discard opacity and packed roughness. Cache
 * complete shader archives from the SAME depot manifest as the content cache;
 * never mount incomplete sparse material archives into the exporter's search.
 */
export const prepareCs2Shaders = async ({
  cs2Dir,
  gameDir,
  log = () => {},
}) => {
  const files = await readPinnedContentManifest(cs2Dir);
  const content = await verifyPinnedContentIndex(cs2Dir, files);
  const names = shaderArchiveNames(files);
  if (!names.some((name) => name === "game/csgo/shaders_vulkan_dir.vpk"))
    throw new Error("Pinned depot has no CS2 Vulkan shader archive");

  const cache = resolve(cs2Dir, "shader-metadata", CS2_SHADER_MANIFEST_GID);
  const cachedArchives = await ensureShaderArchives({
    cache,
    files,
    names,
    manifestGid: CS2_SHADER_MANIFEST_GID,
    readAccess: () => readDepotAccess(cs2Dir),
    log,
  });

  const archives = [];
  for (const cachedArchive of cachedArchives) {
    const cached = join(cache, cachedArchive.name);
    // gameDir is <extraction>/game/csgo; core shader packages are sibling folders.
    const target = resolve(gameDir, "..", "..", cachedArchive.name);
    await mkdir(dirname(target), { recursive: true });
    let providedByWorkshop = false;
    try {
      await symlink(relative(dirname(target), cached), target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      providedByWorkshop =
        (await realpath(target)) !== (await realpath(cached));
    }
    archives.push({
      name: cachedArchive.name,
      bytes: (await stat(target)).size,
      sha256: (await fingerprintFile(target)).value,
      providedByWorkshop,
    });
  }
  return {
    depot: CS2_CONTENT_DEPOT,
    manifest: CS2_SHADER_MANIFEST_GID,
    contentIndexSha256: content.indexSha256,
    archives,
  };
};
