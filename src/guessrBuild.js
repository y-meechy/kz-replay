// Build rounds for the map-guessr minigame: for each map/course with a watchable
// leaderboard entry, cut one small "guess the chunk" of geometry out of the
// converted map plus the run's route through it, and write the pair the viewer
// needs to play a round without ever loading the whole map.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { fetchReplay } from "./api.js";
import { parseReplay } from "./index.js";
import { buildTrack, decodeTrack } from "./track.js";
import { pickChunk, toViewerSpace } from "./guessrChunk.js";
import { writeJsonAtomically } from "./geometry.js";
import {
  REPO_ROOT,
  DATA_DIR,
  MAPS_DIR,
  MAPS_JSON,
  LEADERBOARDS_JSON,
} from "./config.js";

const SAMPLE_DIR = join(REPO_ROOT, "samples");
const GUESSR_DIR = join(DATA_DIR, "guessr");
const GUESSR_JSON = join(DATA_DIR, "guessr.json");

// 150 units (the brief's original number) is under two player heights: a chunk
// that size is a featureless slab, not something a run through it looks like
// anything in particular. 512 is small enough to hide the map but large enough
// to still show a recognisable piece of level.
const DEFAULT_SIZE = 512;

// Preference order when a map/course has more than one leaderboard: classic is
// the mode most runs and viewers know, and pro (no teleports) is the fuller run.
const BOARD_ORDER = ["classic-pro", "classic-tp", "vanilla-pro", "vanilla-tp"];

const toArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);

const loadReplayBytes = async (recordId) => {
  const samplePath = join(SAMPLE_DIR, `${recordId}.replay`);
  try {
    const bytes = await readFile(samplePath);
    return toArrayBuffer(bytes);
  } catch {
    const buffer = await fetchReplay(recordId);
    await mkdir(SAMPLE_DIR, { recursive: true });
    await writeFile(samplePath, Buffer.from(buffer));
    return buffer;
  }
};

/**
 * Every readable triangle mesh in a converted map, in the viewer's coordinate
 * space, with a world-space bounding box for extractChunk's cheap overlap test.
 */
const loadMapMeshes = async (mapName) => {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const document = await io.read(join(MAPS_DIR, `${mapName}.glb`));
  const root = document.getRoot();

  const meshes = [];
  const nodes = root.listNodes();
  for (const [nodeIndex, node] of nodes.entries()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const worldMatrix = node.getWorldMatrix();

    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4 /* TRIANGLES */) continue;
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      const positionArray = position.getArray();
      const indexAccessor = primitive.getIndices();
      const indices = indexAccessor
        ? indexAccessor.getArray()
        : Uint32Array.from({ length: positionArray.length / 3 }, (_, i) => i);
      if (indices.length === 0) continue;

      const triangles = new Float32Array(indices.length * 3);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const out = [0, 0, 0];
      for (let i = 0; i < indices.length; i++) {
        const vertexIndex = indices[i];
        const local = [
          positionArray[vertexIndex * 3],
          positionArray[vertexIndex * 3 + 1],
          positionArray[vertexIndex * 3 + 2],
        ];
        toViewerSpace(out, local, worldMatrix);
        triangles[i * 3] = out[0];
        triangles[i * 3 + 1] = out[1];
        triangles[i * 3 + 2] = out[2];
        for (let axis = 0; axis < 3; axis++) {
          if (out[axis] < min[axis]) min[axis] = out[axis];
          if (out[axis] > max[axis]) max[axis] = out[axis];
        }
      }

      meshes.push({
        nodeIndex,
        materialName: primitive.getMaterial()?.getName() ?? null,
        min,
        max,
        triangles,
      });
    }
  }
  return meshes;
};

/** Pick the best watchable board for one map/course, in BOARD_ORDER. */
const pickBoard = (entries, mapName, courseName) => {
  for (const board of BOARD_ORDER) {
    const entry = entries[`${mapName}|${courseName}|${board}`];
    if (entry?.watchable) return { board, entry };
  }
  return null;
};

/**
 * Chunk ids are opaque so a casual glance at the manifest, or the filename in a
 * network tab, never leaks which map or course a round is from. The hash input
 * is fully deterministic, so reruns keep the same id for the same round.
 */
const chunkId = (mapName, courseName, board, candidateIndex = 0) =>
  createHash("sha1")
    .update(`${mapName}|${courseName}|${board}|${candidateIndex}`)
    .digest("hex")
    .slice(0, 12);

export const buildGuessrRounds = async ({
  limit = 40,
  size = DEFAULT_SIZE,
  force = false,
  maps = null,
  onProgress = () => {},
} = {}) => {
  const leaderboards = JSON.parse(await readFile(LEADERBOARDS_JSON, "utf8"));
  const mapsCatalog = JSON.parse(await readFile(MAPS_JSON, "utf8"));
  const mapByName = new Map(mapsCatalog.maps.map((map) => [map.name, map]));

  // Group "map|course|board" leaderboard keys back into one map/course pair.
  const groupsByKey = new Map();
  for (const key of Object.keys(leaderboards.entries)) {
    const [mapName, courseName] = key.split("|");
    const groupKey = `${mapName}|${courseName}`;
    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, { mapName, courseName });
    }
  }

  let groups = [...groupsByKey.values()]
    .filter((group) => mapByName.has(group.mapName))
    .filter((group) => existsSync(join(MAPS_DIR, `${group.mapName}.glb`)));
  if (maps) {
    groups = groups.filter((group) => maps.includes(group.mapName));
  }
  groups.sort(
    (a, b) =>
      a.mapName.localeCompare(b.mapName) ||
      a.courseName.localeCompare(b.courseName),
  );

  const withBoards = [];
  for (const group of groups) {
    const picked = pickBoard(
      leaderboards.entries,
      group.mapName,
      group.courseName,
    );
    if (picked) withBoards.push({ ...group, ...picked });
  }
  const chosen = withBoards.slice(0, limit);

  await mkdir(GUESSR_DIR, { recursive: true });

  const meshCache = new Map();
  const loadMeshesCached = async (mapName) => {
    if (!meshCache.has(mapName)) {
      meshCache.set(mapName, await loadMapMeshes(mapName));
    }
    return meshCache.get(mapName);
  };

  const written = [];
  const skipped = [];
  const failures = [];

  for (const round of chosen) {
    const { mapName, courseName, board, entry } = round;
    const label = `${mapName}|${courseName}`;
    const id = chunkId(mapName, courseName, board);
    const chunkPath = join(GUESSR_DIR, `${id}.json`);

    if (!force && existsSync(chunkPath)) {
      skipped.push({
        map: mapName,
        course: courseName,
        reason: "already built",
      });
      onProgress(`${label} -> skip (already built)`);
      continue;
    }

    try {
      const recordId = entry.watchable.id;
      const buffer = await loadReplayBytes(recordId);
      const replay = parseReplay(buffer);
      const { bytes } = buildTrack(replay.ticks, replay.bounds);
      const track = decodeTrack(bytes.buffer);

      const meshes = await loadMeshesCached(mapName);
      const chunk = pickChunk({
        meshes,
        route: track.positions,
        tickRange: {
          leadIn: track.leadIn,
          leadOut: track.leadOut,
          count: track.count,
        },
        size,
      });

      if (!chunk) {
        failures.push({
          map: mapName,
          course: courseName,
          reason: "no chunk had enough geometry",
        });
        onProgress(`${label} -> fail (no chunk had enough geometry)`);
        continue;
      }

      await writeJsonAtomically(
        chunkPath,
        {
          id,
          size,
          triangles: chunk.triangles,
          positions: chunk.positions,
          route: chunk.routePositions,
          answer: {
            map: mapName,
            course: courseName,
            mode: board,
            recordId,
            player: entry.watchable.player,
            time: entry.watchable.time,
          },
        },
        2,
      );
      written.push({
        id,
        map: mapName,
        course: courseName,
        triangles: chunk.triangles,
      });
      onProgress(
        `${label} -> ${chunk.triangles} triangles, ${chunk.nodeCount} meshes`,
      );
    } catch (error) {
      failures.push({
        map: mapName,
        course: courseName,
        reason: error.message,
      });
      onProgress(`${label} -> fail (${error.message})`);
    }
  }

  // The manifest lists every valid chunk file currently on disk for this round set,
  // not just the ones just written — a rerun with a smaller --limit must not make
  // rounds built earlier disappear from the manifest. It carries no answer data:
  // someone skimming the network tab must not be able to read it off this file.
  const manifestRounds = [];
  for (const name of (await readdir(GUESSR_DIR)).sort()) {
    if (!name.endsWith(".json")) continue;
    const chunkData = JSON.parse(
      await readFile(join(GUESSR_DIR, name), "utf8"),
    );
    manifestRounds.push({
      id: chunkData.id,
      file: `/data/guessr/${name}`,
      triangles: chunkData.triangles,
    });
  }
  await writeJsonAtomically(
    GUESSR_JSON,
    {
      updatedAt: new Date().toISOString(),
      chunkSize: size,
      rounds: manifestRounds,
    },
    2,
  );

  return { written, skipped, failures };
};
