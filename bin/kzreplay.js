#!/usr/bin/env node
// kzreplay — download CS2KZ replays and turn them into viewer tracks.
//
//   kzreplay fetch <record_id>...        download, parse, write a track
//   kzreplay wrs [--mode m] [--limit n]  fetch the current world records
//   kzreplay wrfeed [--limit n]          rebuild the WR feed the /wr page scrolls
//   kzreplay map <map_name>              convert a workshop map to .glb
//   kzreplay compare <a> <b>             full stats for two runs, and the time delta
//   kzreplay inspect <file|record_id>    dump the header and section table
//   kzreplay verify [--limit n]          parse many replays, report desyncs
//   kzreplay refresh [--no-geometry]     rebuild the map + record catalog
//
// Tracks land in viewer/public/tracks/ so `npm run dev` can serve them directly.

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplay, replayToTrack } from "../src/index.js";
import { fetchMap, fetchReplay, fetchWorldRecords } from "../src/api.js";
import { buildLatestWorldRecords } from "../src/catalog.js";
import { MAPS_JSON, WRS_JSON } from "../src/config.js";
import { writeJsonAtomically } from "../src/geometry.js";
import { convertMap } from "../src/mapPipeline.js";
import { analyseRun } from "../src/analysis.js";
import { compareRuns } from "../src/compare.js";
import { renderComparison } from "../src/report.js";
import { refresh } from "../src/refresh.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACK_DIR = join(ROOT, "viewer", "public", "tracks");
const SAMPLE_DIR = join(ROOT, "samples");

const parseFlags = (argv) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      positional.push(argv[i]);
      continue;
    }
    // A flag with nothing usable after it is a switch, not a missing value:
    // `--force --minutes 5` must not swallow `--minutes`.
    const next = argv[i + 1];
    const isSwitch = next === undefined || next.startsWith("--");
    flags[argv[i].slice(2)] = isSwitch ? true : next;
    if (!isSwitch) i += 1;
  }
  return { flags, positional };
};

const seconds = (value) => (value === undefined ? "?" : `${value.toFixed(3)}s`);

const kilobytes = (bytes) => `${(bytes.length / 1024).toFixed(0)} KB`;

const isRecordId = (value) => /^[0-9a-f-]{36}$/i.test(value);

/** A Node Buffer viewed as a standalone ArrayBuffer, which the parser expects. */
const toArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);

const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const loadReplayBytes = async (idOrPath) => {
  if (!isRecordId(idOrPath)) {
    const bytes = await readFile(idOrPath);
    return {
      buffer: toArrayBuffer(bytes),
      recordId: idOrPath.replace(/.*\//, "").replace(/\.replay$/, ""),
      cached: true,
    };
  }

  const samplePath = join(SAMPLE_DIR, `${idOrPath}.replay`);
  try {
    const bytes = await readFile(samplePath);
    return { buffer: toArrayBuffer(bytes), recordId: idOrPath, cached: true };
  } catch {
    // Not in samples/ yet: download it and keep a copy so reruns are offline.
    const buffer = await fetchReplay(idOrPath);
    await mkdir(SAMPLE_DIR, { recursive: true });
    await writeFile(samplePath, Buffer.from(buffer));
    return { buffer, recordId: idOrPath, cached: false };
  }
};

const writeTrack = async ({ bytes, meta }) => {
  await mkdir(TRACK_DIR, { recursive: true });
  const base = join(TRACK_DIR, meta.recordId);
  await writeFile(`${base}.kztrack`, bytes);
  await writeJson(`${base}.json`, meta);
  return `${base}.kztrack`;
};

const readTrackMetas = async () => {
  const files = await readdir(TRACK_DIR);
  const metas = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    metas.push(JSON.parse(await readFile(join(TRACK_DIR, file), "utf8")));
  }
  return metas.sort((a, b) => (a.map ?? "").localeCompare(b.map ?? ""));
};

/** The subset of a track's metadata the viewer's run list needs. */
const indexEntry = (meta) => ({
  recordId: meta.recordId,
  map: meta.map,
  course: meta.course,
  mode: meta.mode,
  player: meta.player?.name,
  time: meta.reportedTime,
  teleports: meta.teleports,
  durationSeconds: meta.durationSeconds,
});

const refreshIndex = async () => {
  const metas = await readTrackMetas();
  await writeJson(join(TRACK_DIR, "index.json"), metas.map(indexEntry));
  return metas.length;
};

const commands = {
  async fetch({ positional }) {
    if (positional.length === 0) {
      throw new Error("usage: kzreplay fetch <record_id|file>...");
    }
    for (const target of positional) {
      const { buffer, recordId, cached } = await loadReplayBytes(target);
      const { bytes, meta } = replayToTrack(buffer, { recordId });
      await writeTrack({ bytes, meta });
      console.log(
        `${meta.map}/${meta.course} ${meta.mode} ${seconds(meta.reportedTime)} by ${meta.player?.name} ` +
          `-> ${meta.tickCount} ticks, ${kilobytes(bytes)}${cached ? " (cached replay)" : ""}`,
      );
    }
    console.log(`\nindex.json now lists ${await refreshIndex()} track(s)`);
  },

  async wrs({ flags }) {
    const mode = flags.mode ?? "classic";
    const limit = Number(flags.limit ?? 5);
    const records = await fetchWorldRecords({ mode, limit: limit * 3 });
    const withReplays = records
      .filter((record) => record.replay_available)
      .slice(0, limit);

    console.log(
      `${records.length} world records checked, ${withReplays.length} have a stored replay\n`,
    );
    for (const record of withReplays) {
      try {
        const buffer = await fetchReplay(record.id);
        const { bytes, meta } = replayToTrack(buffer, { recordId: record.id });
        await writeTrack({ bytes, meta });
        console.log(
          `  ok   ${record.map.name}/${record.course.name} ${seconds(record.time)} by ${record.player.name} (${kilobytes(bytes)})`,
        );
      } catch (error) {
        console.log(
          `  fail ${record.map.name}/${record.course.name}: ${error.message}`,
        );
      }
    }
    console.log(`\nindex.json now lists ${await refreshIndex()} track(s)`);
  },

  /**
   * Rebuild wrs.json, the list the /wr feed scrolls through.
   *
   * Four API requests, so this is the one part of the catalog that is cheap enough
   * to rerun whenever you want the newest records on screen. The nightly refresh
   * writes the same file; this just skips the other 620 requests.
   */
  async wrfeed({ flags }) {
    // Tiers and pictures come from the map catalog rather than the records endpoint,
    // so a missing catalog costs those two fields and nothing else.
    const catalog = await readFile(MAPS_JSON, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (!catalog) {
      console.log(
        `no map catalog at ${MAPS_JSON}, so tiers and pictures will be missing —\n` +
          "run `kzreplay refresh --no-geometry` once to build it\n",
      );
    }

    const latest = await buildLatestWorldRecords(catalog?.maps ?? [], {
      limit: Number(flags.limit ?? 60),
      log: (message) => console.log(`  ${message}`),
    });
    await writeJsonAtomically(WRS_JSON, latest, 2);

    console.log(`\nwrote ${WRS_JSON}`);
    for (const record of latest.records.slice(0, 10)) {
      console.log(
        `  ${(record.setAt ?? "").slice(0, 10)}  ${record.map}/${record.course} ` +
          `${record.mode}${record.hasTeleports ? " TP" : ""} ` +
          `${seconds(record.time)} by ${record.player}`,
      );
    }
    if (latest.records.length > 10) {
      console.log(`  … and ${latest.records.length - 10} more`);
    }
  },

  async map({ positional, flags }) {
    const mapName = positional[0];
    if (!mapName) {
      throw new Error(
        "usage: kzreplay map <map_name>   e.g. kzreplay map kz_victoria",
      );
    }

    const map = await fetchMap(mapName);
    if (!map?.workshop_id) {
      throw new Error(`no workshop id for ${mapName} in the CS2KZ API`);
    }
    const mappers = (map.mappers ?? []).map((m) => m.name ?? m).join(", ");
    console.log(
      `${map.name}  workshop ${map.workshop_id}  by ${mappers || "unknown"}\n`,
    );

    const { path } = await convertMap({
      mapName: map.name,
      workshopId: String(map.workshop_id),
      toolsDir: join(ROOT, "tools"),
      outputDir: join(ROOT, "viewer", "public", "maps"),
      steamcmd: flags.steamcmd ?? "steamcmd",
      // The mapper's own materials and textures, which the workshop item carries.
      // On by default; --no-textures falls back to the map's baked lighting over
      // colours guessed from material names.
      withTextures: !flags["no-textures"],
      // --colors gives every surface a flat colour picked from the material name
      // the mapper used. No textures are involved, and none are needed.
      withColours: Boolean(flags.colors ?? flags.colours),
      // The map's own baked sun and shadows, multiplied into those colours. On by
      // default because it is what makes a converted map look like the map;
      // --no-lightmap goes back to flat colours.
      withLightmap: !flags["no-lightmap"],
      // The map's real sky. Needs tools/DepotDownloader and borrows one CS2 archive
      // part per distinct sky; --no-sky keeps the viewer's own gradient.
      withSky: !flags["no-sky"],
      ...(flags["sky-size"] ? { skySize: Number(flags["sky-size"]) } : {}),
      ...(flags["texture-size"]
        ? { textureSize: Number(flags["texture-size"]) }
        : {}),
      ...(flags["lightmap-size"]
        ? { lightmapSize: Number(flags["lightmap-size"]) }
        : {}),
      log: (message) => console.log(`  ${message}`),
    });

    const { size } = await stat(path);
    console.log(`\nwrote ${path} (${(size / 1e6).toFixed(1)} MB)`);
    console.log("Credit the mappers wherever this geometry is shown.");
  },

  /**
   * Rebuild everything the browse page reads: the map list with its pictures, the
   * record per leaderboard, and any map geometry that is missing.
   *
   * This is what the server runs every night. Running it by hand is the same job.
   */
  async refresh({ flags }) {
    await refresh({
      // Records take seconds; converting a map takes minutes. --no-geometry is for
      // when you only want the tables refreshed.
      geometry: !("no-geometry" in flags),
      forceGeometry: "force" in flags,
      onlyMaps: flags.map ? flags.map.split(",") : null,
      geometryBudgetMs: Number(flags.minutes ?? 45) * 60 * 1000,
    });
  },

  async compare({ positional, flags }) {
    const [referenceId, challengerId] = positional;
    if (!referenceId || !challengerId) {
      throw new Error(
        "usage: kzreplay compare <reference_id> <challenger_id> [--seconds n] [--json out.json]",
      );
    }

    const load = async (idOrPath) => {
      const { buffer } = await loadReplayBytes(idOrPath);
      return analyseRun(parseReplay(buffer));
    };
    const [reference, challenger] = await Promise.all([
      load(referenceId),
      load(challengerId),
    ]);

    if (
      reference.run.map !== challenger.run.map ||
      reference.run.course !== challenger.run.course
    ) {
      throw new Error(
        `these runs are on different courses (${reference.run.map}/${reference.run.course} vs ` +
          `${challenger.run.map}/${challenger.run.course}), so there is nothing to compare`,
      );
    }
    if (reference.run.mode !== challenger.run.mode) {
      console.log(
        `note: different modes (${reference.run.mode} vs ${challenger.run.mode}), ` +
          "so the physics differ too\n",
      );
    }

    const comparison = compareRuns(reference, challenger, {
      minSeconds: Number(flags.seconds ?? 1.5),
    });
    console.log(renderComparison({ reference, challenger, comparison }));

    if (flags.json) {
      // The heavy internal series are for the maths, not for the file.
      const strip = ({ _series, ...rest }) => rest;
      await writeJson(flags.json, {
        reference: strip(reference),
        challenger: strip(challenger),
        comparison,
      });
      console.log(`wrote ${flags.json}`);
    }
  },

  async inspect({ positional }) {
    const { buffer } = await loadReplayBytes(positional[0]);
    const replay = parseReplay(buffer);
    console.log(JSON.stringify(replay.header, null, 2));
    console.log("\nsections:");
    for (const [name, size] of Object.entries(replay.sectionSizes)) {
      console.log(
        `  ${name.padEnd(12)} ${String(size.elements).padStart(7)} elements  ` +
          `${String(size.compressed).padStart(9)} -> ${String(size.uncompressed).padStart(9)} bytes`,
      );
    }
    console.log("\ntimer events:");
    for (const event of replay.events.filter((e) => e.kind === "timer")) {
      console.log(
        `  tick ${String(event.serverTick).padStart(7)}  ${event.event} ${seconds(event.time)}`,
      );
    }
    const { bounds, ticks } = replay;
    console.log(
      `\nticks ${ticks.count}, run ${bounds.startIndex}..${bounds.endIndex} ` +
        `(${((bounds.endIndex - bounds.startIndex) / 64).toFixed(3)}s at 64 ticks/s), ` +
        `header says ${seconds(replay.header.run?.time)}`,
    );
  },

  async verify({ flags }) {
    const limit = Number(flags.limit ?? 25);
    const records = await fetchWorldRecords({
      mode: flags.mode ?? "classic",
      limit,
    });
    const targets = records.filter((record) => record.replay_available);
    let ok = 0;
    const failures = [];

    for (const record of targets) {
      try {
        const buffer = await fetchReplay(record.id);
        const replay = parseReplay(buffer);
        const drift = Math.abs((replay.bounds.reportedTime ?? 0) - record.time);
        if (replay.bounds.hasTimerEvents && drift > 1 / 64) {
          throw new Error(`timer time off by ${drift.toFixed(4)}s`);
        }
        ok += 1;
        process.stdout.write(".");
      } catch (error) {
        failures.push(
          `${record.map.name}/${record.course.name}: ${error.message}`,
        );
        process.stdout.write("x");
      }
    }

    console.log(
      `\n\n${ok}/${targets.length} replays parsed with exact byte sync`,
    );
    for (const failure of failures) {
      console.log(`  ${failure}`);
    }
    if (failures.length > 0) {
      process.exitCode = 1;
    }
  },
};

const [command, ...rest] = process.argv.slice(2);

if (!command || !commands[command]) {
  console.error(`usage: kzreplay <${Object.keys(commands).join("|")}> [args]`);
  process.exit(1);
}

try {
  await commands[command](parseFlags(rest));
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}
