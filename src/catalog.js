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

import { fetchAllMaps, fetchLeaderboard } from "./api.js";
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
