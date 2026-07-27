// Load a run straight from a record id, in the browser.
//
// Nothing here is viewer-specific: it is the same parser, the same track builder
// and the same analysis the CLI runs. That is the point of keeping src/ free of
// Node APIs — paste an id and the browser does the whole pipeline itself, with no
// prepared files.
//
// The one thing the browser cannot do is fetch the replay bucket: it sends no CORS
// headers, so the dev server proxies /replay/<id> to it (see vite.config.js).

import { parseReplay } from "../../src/index.js";
import { analyseRun } from "../../src/analysis.js";
import { buildTrack, decodeTrack } from "../../src/track.js";

const API_BASE = "https://api.cs2kz.org";

const RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull record ids out of whatever the user pasted: commas, spaces, newlines, URLs. */
export const parseRecordIds = (text) => {
  const found = String(text)
    .split(/[^0-9a-fA-F-]+/)
    .map((token) => token.trim())
    .filter((token) => RECORD_ID.test(token));
  return [...new Set(found.map((id) => id.toLowerCase()))];
};

const fetchRecord = async (recordId) => {
  const response = await fetch(`${API_BASE}/records/${recordId}`);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "no such record"
        : `the API returned ${response.status}`,
    );
  }
  return response.json();
};

const fetchReplay = async (recordId) => {
  const response = await fetch(`/replay/${recordId}`);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "no replay stored (only world records, ranked top 10s and tier 8 runs are kept)"
        : `the replay download returned ${response.status}`,
    );
  }
  return response.arrayBuffer();
};

/**
 * Everything the viewer needs about one run.
 *
 * The track is built and then decoded again rather than used directly, so the
 * viewer always renders from the same quantised data a prepared file would give
 * it. Costs about a millisecond and removes a whole class of "works from a file
 * but not from a paste" bugs.
 */
export const loadRunById = async (recordId) => {
  const [record, buffer] = await Promise.all([
    fetchRecord(recordId).catch(() => null),
    fetchReplay(recordId),
  ]);

  const replay = parseReplay(buffer);
  const analysis = analyseRun(replay);
  const { bytes, stats } = buildTrack(replay.ticks, replay.bounds);

  return {
    recordId,
    track: decodeTrack(bytes.buffer),
    analysis,
    meta: {
      recordId,
      player: replay.header.player,
      map: replay.header.map?.name,
      course: replay.header.run?.courseName,
      mode: replay.header.run?.mode?.name,
      reportedTime: replay.header.run?.time,
      teleports: replay.header.run?.teleports ?? 0,
      // Ranks only exist on the API, and only for records still in the tables.
      nubRank: record?.nub_rank ?? null,
      proRank: record?.pro_rank ?? null,
      server: record?.server?.name ?? null,
      ...stats,
    },
  };
};
