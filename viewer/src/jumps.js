// Every jump in a run, found once when the track is first read.
//
// The HUD wants two things a single tick cannot answer: the speed the runner
// took off with (prespeed) and whether the takeoff was a perf. Both are
// questions about the ticks *before* the current one, so they are answered in
// one pass over the track and then looked up by tick.

import { TRACK_FLAG } from "../../src/track.js";

/**
 * Upward speed that means the runner has just jumped.
 *
 * The jump button alone cannot answer this. CS2 takes jump input between ticks, so
 * a scroll-wheel hop never shows the button held in the per-tick mask at all:
 * measured across the sample replays the mask misses two thirds of the real jumps,
 * including every perf. The impulse is unambiguous, always 286-296 against 100 or
 * less for a runner who simply walked off an edge, and gravity bleeds it away
 * within a few ticks, so testing for it lights the key for a moment on every real
 * jump however it was bound.
 */
export const JUMP_IMPULSE = 250; // units per second, upward

/**
 * A takeoff counts as a perf when the runner spent no more than this many ticks
 * on the ground since landing.
 *
 * One tick is the textbook bunnyhop. Zero also happens, and often: the runner
 * landed and left again between two recorded ticks, so no grounded tick was ever
 * written down. On a WR bhop run those two cases are most of the jumps, and two
 * grounded ticks or more is a hop the runner had to wait on the floor for.
 */
const PERF_GROUND_TICKS = 1;

const onGround = (track, i) => (track.flags[i] & TRACK_FLAG.ONGROUND) !== 0;

/**
 * Find every jump in a track.
 *
 * @returns an ascending array of { tick, prespeed, perf }, where tick is the
 *          first tick carrying the upward impulse, prespeed is the horizontal
 *          speed on the tick before it, and perf says the runner barely touched
 *          the ground first.
 */
export const findJumps = (track) => {
  const jumps = [];

  for (let i = 1; i < track.count; i += 1) {
    const takeoff =
      track.verticalSpeed[i] > JUMP_IMPULSE &&
      track.verticalSpeed[i - 1] <= JUMP_IMPULSE;
    if (!takeoff) continue;
    // A teleport moves the runner, so the speed either side of it is not one
    // continuous jump and nothing about it is worth showing.
    if (track.teleports[i] !== track.teleports[i - 1]) continue;

    // Walk back over the ground contact this jump left from. Its length is the
    // whole of the perf question.
    let ground = 0;
    let before = i - 1;
    while (before >= 0 && onGround(track, before)) {
      ground += 1;
      before -= 1;
    }
    // Where the ground contact began, or the tick before the impulse when there
    // was no recorded contact at all. Only used to check for a teleport.
    const landing = ground > 0 ? before + 1 : i - 1;

    jumps.push({
      tick: i,
      prespeed: track.speed[i - 1],
      perf:
        ground <= PERF_GROUND_TICKS &&
        track.teleports[landing] === track.teleports[i],
    });
  }

  return jumps;
};

/**
 * The jump the runner is currently in: the last one that took off at or before
 * this tick, or null before the first jump of the run.
 */
export const jumpAtTick = (jumps, tick) => {
  let low = 0;
  let high = jumps.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (jumps[mid].tick <= tick) {
      found = jumps[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};
