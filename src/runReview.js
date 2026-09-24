// Review one finished run against the world record on its course.
//
// This is what the game server used to do itself. A watcher next to the server
// uploads each new .replay and gets back the comparison and a link the viewer can
// open; the game process does none of the work.

import { parseReplay } from "./index.js";
import { analyseRun } from "./analysis.js";
import { compareRuns } from "./compare.js";
import { fetchLeaderboard, fetchReplay } from "./api.js";

/**
 * The fastest run on the same course, mode and teleport class that still has a
 * replay stored. Most rows have none (see api.js), so the board is walked.
 */
export const findWorldRecord = async (
  run,
  { leaderboard = fetchLeaderboard } = {},
) => {
  const { rows } = await leaderboard({
    mapName: run.map,
    courseName: run.course,
    // The API wants "classic"/"vanilla"; the replay header says "Classic".
    mode: String(run.mode).toLowerCase(),
    hasTeleports: run.teleports > 0,
  });
  return rows.find((row) => row.replay_available) ?? null;
};

/**
 * @param buffer an ArrayBuffer holding a .replay file
 * @returns {{ review } | { error }} error is a message a client can show
 */
export const reviewReplay = async (
  buffer,
  { findReference = findWorldRecord, loadReplay = fetchReplay } = {},
) => {
  const replay = parseReplay(buffer);
  // The plugin also writes cheater, manual and jumpstat replays to the same
  // folder. Only a finished timer run has a course to compare against.
  if (replay.header.type !== "run" || !replay.header.run) {
    return { error: `a ${replay.header.type} replay is not a finished run` };
  }

  const challenger = analyseRun(replay);
  const record = await findReference(challenger.run);
  if (!record) {
    return {
      review: { run: challenger.run, reference: null, comparison: null },
    };
  }

  const reference = analyseRun(parseReplay(await loadReplay(record.id)));
  return {
    review: {
      run: challenger.run,
      reference: { recordId: record.id, ...reference.run },
      comparison: compareRuns(reference, challenger),
    },
  };
};
