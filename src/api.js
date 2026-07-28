// Read-only clients for the two CS2KZ endpoints we need.
//
// Records live on the API. Replay files live on a separate bucket host, which is
// not in the OpenAPI spec: the URL comes from the plugin itself
// (cs2kz-metamod/src/kz/global/replays.cpp).
//
// Retention, from cs2kz-api/crates/cs2kz/src/replays/cleaner.rs: replays older
// than ~24h are deleted unless the record is a world record, top 10 on a ranked
// course, or on a tier 8 course. World records are safe; anything else is not.

const API_BASE = "https://api.cs2kz.org";
const REPLAY_BASE = "https://replays.cs2kz.org";

const getJson = async (path) => {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return response.json();
};

export const fetchRecord = (recordId) => getJson(`/records/${recordId}`);

/** A map by name, including its Steam Workshop id and its mappers. */
export const fetchMap = async (mapName) => {
  const data = await getJson(`/maps/${encodeURIComponent(mapName)}`);
  return Array.isArray(data?.values) ? data.values[0] : data;
};

/**
 * Every approved map, following the pagination to the end.
 *
 * The list is small (85 maps as of writing) but `total` is in the response, so the
 * loop follows it instead of assuming one page is enough.
 */
export const fetchAllMaps = async ({ pageSize = 200 } = {}) => {
  const maps = [];
  let offset = 0;
  for (;;) {
    const data = await getJson(`/maps?limit=${pageSize}&offset=${offset}`);
    const page = data.values ?? [];
    maps.push(...page);
    offset += page.length;
    if (page.length === 0 || offset >= (data.total ?? maps.length)) break;
  }
  return maps;
};

/**
 * One course's leaderboard, fastest first.
 *
 * `top=true` keeps only each player's best run, which is what a leaderboard is.
 * Every row carries `replay_available`, which is the field this whole app hinges
 * on: most records have no replay stored, so the rows have to be walked to find
 * one that can actually be watched.
 */
export const fetchLeaderboard = async ({
  mapName,
  courseName,
  mode,
  hasTeleports,
  limit = 25,
}) => {
  const params = new URLSearchParams({
    map: mapName,
    course: courseName,
    mode,
    has_teleports: String(hasTeleports),
    top: "true",
    sort_by: "time",
    sort_order: "ascending",
    limit: String(limit),
  });
  const data = await getJson(`/records?${params}`);
  return { total: data.total ?? 0, rows: data.values ?? [] };
};

/** Download a raw .replay file. Returns an ArrayBuffer. */
export const fetchReplay = async (recordId) => {
  const response = await fetch(`${REPLAY_BASE}/${recordId}`);
  if (response.status === 404) {
    throw new Error(
      `no replay stored for record ${recordId} — either it predates replay uploads, ` +
        "or it was cleaned up (only WRs, ranked top 10s and tier 8 runs are kept)",
    );
  }
  if (!response.ok) {
    throw new Error(`replay download failed with ${response.status}`);
  }
  return response.arrayBuffer();
};

/**
 * Current world records, newest submissions first.
 *
 * `max_rank=1` restricts to rank one and `top=true` to each course's best, which
 * together is the world record per course and mode.
 *
 * The sort is spelled out rather than left to the API's default, because the order
 * is the whole point of the call: the feed shows the records that were set most
 * recently, and `submission-date` is what "most recently" means. (The API's default
 * happens to be the same today. That is not something to build on.)
 */
export const fetchWorldRecords = async ({
  mode = "classic",
  hasTeleports = false,
  limit = 20,
  offset = 0,
  sortBy = "submission-date",
  sortOrder = "descending",
} = {}) => {
  const params = new URLSearchParams({
    mode,
    top: "true",
    max_rank: "1",
    has_teleports: String(hasTeleports),
    sort_by: sortBy,
    sort_order: sortOrder,
    limit: String(limit),
    offset: String(offset),
  });
  const data = await getJson(`/records?${params}`);
  return data.values ?? [];
};
