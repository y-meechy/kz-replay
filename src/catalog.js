// Build the two JSON files the browse page runs on.
//
// The browse page has to answer, for every map and course and leaderboard: what is
// the world record, and is there a replay anyone can actually watch? The second
// question is the awkward one. Replays are deleted after about a day unless the
// record is a world record, a ranked top 10, or on a tier 8 course, so the fastest
// run on a course very often has no replay at all — the current kz_victoria Main
// classic record is exactly that case.
//
// So a leaderboard entry stores two things: the world record, and the fastest run
// that still has a replay file. Usually they are the same run. When they are not,
// the page can say "the record has no replay, here is rank 4 instead" rather than
// offering a button that fails.
//
// Cost: 156 courses x 4 leaderboards is about 620 requests, which is why this runs
// on a schedule and writes a file rather than happening when someone opens the page.

import { fetchAllMaps, fetchLeaderboard, fetchWorldRecords } from "./api.js";
import { LEADERBOARDS, leaderboardKey } from "./leaderboards.js";
import { fetchWorkshopPreviews } from "./workshop.js";

/** Run `worker` over `items`, at most `limit` at a time, results in input order. */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
};

const tierOf = (course, mode) => {
  const filter = course.filters?.[mode];
  return filter
    ? {
        nub: filter.nub_tier ?? null,
        pro: filter.pro_tier ?? null,
        state: filter.state ?? null,
      }
    : null;
};

const rowSummary = (row) => ({
  id: row.id,
  player: row.player?.name ?? null,
  time: row.time,
  teleports: row.teleports ?? 0,
  replay: Boolean(row.replay_available),
  proRank: row.pro_rank ?? null,
  nubRank: row.nub_rank ?? null,
});

/**
 * The map list, with a picture and its courses.
 *
 * Geometry is deliberately not in here: whether a map has been converted changes
 * far more often than the map list does, and the server knows it by looking at the
 * directory.
 */
export const buildMapCatalog = async ({ log = () => {} } = {}) => {
  log("fetching the map list…");
  const revisions = await fetchAllMaps();

  // The API keeps earlier approvals when a map is re-approved. Showing those as
  // separate cards produces duplicate names with stale courses and, sometimes, an
  // old workshop id. Keep the newest approval for each name: it contains the full
  // current course list and the checksum the geometry pipeline should track.
  const currentByName = new Map();
  for (const map of revisions) {
    const previous = currentByName.get(map.name);
    if (!previous || (map.approved_at ?? "") > (previous.approved_at ?? "")) {
      currentByName.set(map.name, map);
    }
  }
  const maps = [...currentByName.values()];
  log(
    `${maps.length} current maps` +
      (maps.length === revisions.length
        ? ""
        : ` (${revisions.length - maps.length} older approvals ignored)`),
  );

  log("fetching workshop preview images…");
  const previews = await fetchWorkshopPreviews(
    maps.map((map) => map.workshop_id).filter(Boolean),
    { log },
  );
  log(`${previews.size} of ${maps.length} maps have a picture`);

  return {
    updatedAt: new Date().toISOString(),
    maps: maps
      .map((map) => ({
        name: map.name,
        workshopId: map.workshop_id ? String(map.workshop_id) : null,
        // The checksum changes when a mapper republishes, which is the signal that
        // converted geometry has gone stale.
        checksum: map.vpk_checksum ?? null,
        image: previews.get(String(map.workshop_id))?.image ?? null,
        description: map.description ?? null,
        mappers: (map.mappers ?? []).map(
          (mapper) => mapper.name ?? String(mapper),
        ),
        approvedAt: map.approved_at ?? null,
        courses: (map.courses ?? []).map((course) => ({
          name: course.name,
          tiers: {
            classic: tierOf(course, "classic"),
            vanilla: tierOf(course, "vanilla"),
          },
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

/**
 * Every leaderboard of every course, reduced to "the record" and "what you can
 * watch".
 *
 * @param maps the `maps` array from buildMapCatalog
 */
export const buildLeaderboards = async (
  maps,
  { concurrency = 6, rows = 25, log = () => {} } = {},
) => {
  const jobs = maps.flatMap((map) =>
    map.courses.flatMap((course) =>
      LEADERBOARDS.map((board) => ({ map, course, board })),
    ),
  );
  log(`fetching ${jobs.length} leaderboards…`);

  let done = 0;
  let withReplay = 0;
  const entries = {};

  const results = await mapWithConcurrency(
    jobs,
    concurrency,
    async ({ map, course, board }) => {
      try {
        const { total, rows: page } = await fetchLeaderboard({
          mapName: map.name,
          courseName: course.name,
          mode: board.mode,
          hasTeleports: board.hasTeleports,
          limit: rows,
        });
        return { map, course, board, total, page };
      } catch (error) {
        return { map, course, board, error: error.message };
      }
    },
  );

  for (const result of results) {
    done += 1;
    if (done % 100 === 0) log(`${done} of ${jobs.length}`);
    if (result.error || result.page.length === 0) continue;

    const record = result.page[0];
    // The rows are already fastest first, so the first one with a file is the
    // fastest watchable run by construction.
    const watchable = result.page.find((row) => row.replay_available);
    if (watchable) withReplay += 1;

    entries[
      leaderboardKey(result.map.name, result.course.name, result.board.id)
    ] = {
      total: result.total,
      record: rowSummary(record),
      watchable: watchable ? rowSummary(watchable) : null,
      // Which row of the leaderboard the watchable run is, so the page can say
      // "rank 4" when the record itself cannot be watched.
      watchableRank: watchable ? result.page.indexOf(watchable) + 1 : null,
    };
  }

  log(
    `${Object.keys(entries).length} leaderboards have runs, ${withReplay} have a replay to watch`,
  );

  return { updatedAt: new Date().toISOString(), entries };
};

/**
 * When a record was set, read out of its own id.
 *
 * The API has no timestamp on a record: `/records` will sort by `submission-date`
 * but never tells you the date it sorted on. Record ids are UUIDv7, and the first
 * 48 bits of a UUIDv7 are the millisecond it was generated, so the id carries the
 * answer. The check that this is the right number rather than a plausible one: the
 * ids come back in exactly the order the API's own submission-date sort puts them,
 * every time, across all four leaderboards.
 *
 * Guarded rather than trusted. Anything that is not version 7, or lands outside the
 * years CS2KZ has existed, returns null and the feed simply shows no date.
 */
const setAtFromRecordId = (recordId) => {
  const hex = String(recordId).replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return null;
  const milliseconds = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(milliseconds)) return null;
  // CS2 itself did not exist before 2023, and a record cannot be set tomorrow.
  const earliest = Date.UTC(2023, 0, 1);
  if (milliseconds < earliest || milliseconds > Date.now() + 86_400_000) {
    return null;
  }
  return new Date(milliseconds).toISOString();
};

/**
 * One `/records` row as a card in the feed.
 *
 * @param board which leaderboard the row was fetched from
 * @param map the catalog entry for the row's map, or undefined with no catalog on disk
 */
const toFeedRecord = (row, board, map) => {
  const course = map?.courses.find(
    (candidate) => candidate.name === row.course?.name,
  );
  const tiers = course?.tiers?.[board.mode];
  return {
    recordId: row.id,
    map: row.map?.name ?? null,
    course: row.course?.name ?? null,
    mode: board.mode,
    hasTeleports: board.hasTeleports,
    board: board.id,
    boardLabel: board.label,
    player: row.player?.name ?? null,
    time: row.time,
    teleports: row.teleports ?? 0,
    // The tier of the course as this mode ranks it, so the card can say how hard the
    // thing you are watching actually is.
    tier: board.hasTeleports ? (tiers?.nub ?? null) : (tiers?.pro ?? null),
    state: tiers?.state ?? null,
    image: map?.image ?? null,
    server: row.server?.name ?? null,
    setAt: setAtFromRecordId(row.id),
  };
};

/**
 * The world records that were set most recently, newest first.
 *
 * Four requests, not 620: `max_rank=1&top=true` already means "the record of every
 * course" and the sort already means "newest first", so one request per leaderboard
 * covers every map at once. That is why this can be rebuilt on its own in a second
 * (`kzreplay wrfeed`) instead of waiting for the full nightly catalog.
 *
 * Records with no replay file are left out entirely, which is the one place this
 * differs from the browse page. Browse has something honest to say about a record it
 * cannot play — "the record has no replay, here is rank 4". A feed does not: it is a
 * stack of runs you scroll through and watch, and an item that cannot be watched is
 * just a dead card. Roughly one WR in ten is in that state at any time.
 *
 * @param maps the `maps` array from buildMapCatalog, for tiers and pictures
 */
export const buildLatestWorldRecords = async (
  maps = [],
  { perBoard = 40, limit = 60, log = () => {} } = {},
) => {
  log(`fetching the latest world records on ${LEADERBOARDS.length} boards…`);

  const mapByName = new Map(maps.map((map) => [map.name, map]));
  let failed = 0;
  const pages = await Promise.all(
    LEADERBOARDS.map(async (board) => {
      try {
        const rows = await fetchWorldRecords({
          mode: board.mode,
          hasTeleports: board.hasTeleports,
          limit: perBoard,
        });
        return { board, rows };
      } catch (error) {
        failed += 1;
        log(`  ${board.id} failed: ${error.message}`);
        return { board, rows: [] };
      }
    }),
  );

  // Every request failing means the network was down, not that the game has no world
  // records. Saying so is the caller's cue to keep the file it already has: an empty
  // feed written over a good one is a five second outage turned into a day of it.
  if (failed === LEADERBOARDS.length) {
    throw new Error(
      `could not reach the CS2KZ API on any of the ${LEADERBOARDS.length} leaderboards`,
    );
  }

  const records = pages
    .flatMap(({ board, rows }) =>
      rows
        .filter((row) => row.replay_available)
        .map((row) => toFeedRecord(row, board, mapByName.get(row.map?.name))),
    )
    // Four separate "newest first" lists, interleaved into one.
    .sort((a, b) => String(b.setAt ?? "").localeCompare(String(a.setAt ?? "")))
    .slice(0, limit);

  log(`${records.length} recent world records have a replay to watch`);

  return { updatedAt: new Date().toISOString(), records };
};
