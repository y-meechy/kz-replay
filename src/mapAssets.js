// Publish one map conversion as an immutable, internally consistent asset bundle.
//
// A map is more than its GLB: lighting and sky files must come from the same source
// and converter settings. Publishing those names independently lets a viewer observe
// a new GLB beside an old lightmap. A complete revision directory is renamed into
// place first, then one small manifest switches consumers to it atomically. Older
// revisions deliberately remain available to in-flight viewers and for rollback.

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export const MAP_ASSET_SCHEMA_VERSION = 1;
export const MAP_PIPELINE_VERSION = 2;

export const publishedGeometryPath = async (outputDir, mapName) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mapName))
    throw new Error("Invalid map name");
  const path = join(outputDir, `${mapName}.assets.json`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return join(outputDir, `${mapName}.glb`);
    throw error;
  }
  if (
    manifest.schemaVersion !== MAP_ASSET_SCHEMA_VERSION ||
    manifest.map !== mapName ||
    !/^[a-f0-9]{24}$/.test(manifest.activeRevision ?? "")
  )
    throw new Error("Invalid published map manifest");
  const entry = manifest.revisions?.[manifest.activeRevision]?.files?.geometry;
  const prefix = `${mapName}.assets/${manifest.activeRevision}/`;
  if (
    !entry?.url?.startsWith(prefix) ||
    entry.url.slice(prefix.length).includes("/") ||
    entry.url.includes("..")
  )
    throw new Error("Invalid geometry descriptor");
  return join(outputDir, entry.url);
};

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const fingerprintFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { algorithm: "sha256", value: hash.digest("hex") };
};

const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const readPublishedManifest = async (path, mapName) => {
  try {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (
      manifest.schemaVersion === MAP_ASSET_SCHEMA_VERSION &&
      manifest.map === mapName &&
      manifest.revisions &&
      typeof manifest.revisions === "object"
    ) {
      return manifest;
    }
  } catch {
    // Missing and malformed manifests are both replaced only after the new immutable
    // revision is complete. Existing asset directories are never touched.
  }
  return {
    schemaVersion: MAP_ASSET_SCHEMA_VERSION,
    map: mapName,
    activeRevision: null,
    revisions: {},
  };
};

const fileDescriptor = async ({ path, url, metadata = {} }) => {
  const [{ size }, fingerprint] = await Promise.all([
    stat(path),
    fingerprintFile(path),
  ]);
  return {
    url,
    bytes: size,
    sha256: fingerprint.value,
    ...metadata,
  };
};

/**
 * @param files named files, each `{ sourcePath, fileName, metadata }`, or null
 * @returns the stable manifest and immutable paths for the active revision
 */
export const publishMapAssets = async ({
  outputDir,
  mapName,
  source,
  converter,
  files,
  audit,
  createdAt = new Date().toISOString(),
}) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mapName))
    throw new Error("Invalid map name");
  for (const file of Object.values(files))
    if (file && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file.fileName))
      throw new Error("Invalid asset filename");
  if (!files.geometry?.sourcePath) {
    throw new TypeError("files.geometry.sourcePath is required");
  }

  await mkdir(outputDir, { recursive: true });
  const assetsDir = join(outputDir, `${mapName}.assets`);
  await mkdir(assetsDir, { recursive: true });

  // Content-derived revisions make retries idempotent while distinguishing changes
  // to source, settings, converter, or any emitted byte.
  const inputs = {};
  for (const [kind, file] of Object.entries(files)) {
    inputs[kind] = file
      ? {
          sha256: (await fingerprintFile(file.sourcePath)).value,
          fileName: file.fileName,
          metadata: file.metadata ?? {},
        }
      : null;
  }
  const revision = sha256Bytes(
    Buffer.from(JSON.stringify({ source, converter, inputs, audit })),
  ).slice(0, 24);
  const revisionDir = join(assetsDir, revision);
  const temporaryDir = await mkdtemp(join(assetsDir, `.${revision}.tmp-`));
  const descriptors = {};
  let installedRevision = false;
  try {
    for (const [kind, file] of Object.entries(files)) {
      if (!file) {
        descriptors[kind] = null;
        continue;
      }
      const target = join(temporaryDir, file.fileName);
      await copyFile(file.sourcePath, target);
      descriptors[kind] = await fileDescriptor({
        path: target,
        url: `${mapName}.assets/${revision}/${file.fileName}`,
        metadata: file.metadata,
      });
    }

    const revisionEntry = {
      source,
      converter,
      createdAt,
      files: descriptors,
      audit,
    };
    await writeJson(join(temporaryDir, "manifest.json"), {
      schemaVersion: MAP_ASSET_SCHEMA_VERSION,
      map: mapName,
      revision,
      ...revisionEntry,
    });
    try {
      await rename(temporaryDir, revisionDir);
      installedRevision = true;
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      // An identical concurrent/repeated conversion already installed this immutable
      // content-derived revision. Its files are the same by construction.
    }

    const manifestPath = join(outputDir, `${mapName}.assets.json`);
    const manifest = await readPublishedManifest(manifestPath, mapName);
    manifest.activeRevision = revision;
    manifest.revisions[revision] = revisionEntry;
    manifest.updatedAt = createdAt;

    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeJson(temporaryManifest, manifest);
      await rename(temporaryManifest, manifestPath);
    } finally {
      await rm(temporaryManifest, { force: true });
    }

    const paths = Object.fromEntries(
      Object.entries(files).map(([kind, file]) => [
        kind,
        file ? join(revisionDir, file.fileName) : null,
      ]),
    );
    return { manifestPath, manifest, revision, paths };
  } finally {
    if (!installedRevision) {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  }
};
