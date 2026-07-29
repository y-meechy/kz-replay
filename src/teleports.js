// What a teleport run threw away.
//
// A TP run is a run with checkpoints. The runner saves a spot, tries the jump ahead
// of it, and on a miss teleports back to that spot and tries again — sometimes fifty
// times. The replay records every one of those attempts, so the drawn path of a TP
// run is a thicket: dozens of lines going nowhere, all crossing at the checkpoint.
//
// This works out which stretches of the recorded path are those failed attempts, so
// the viewer can rub them out and leave the one route the runner actually took.
//
// It has one thing to go on. A track carries a running teleport count and nothing
// else: no checkpoint positions, no checkpoint ticks. But a teleport puts the runner
// on the exact spot they were standing on when they saved the checkpoint, so the
// place they land is a place the path has already been, and finding it is a matter
// of looking back through the current attempt for the tick nearest the landing spot.

/**
 * How far a teleport may land from anywhere the runner has been during the current
 * attempt and still count as a return to a checkpoint, in Source units.
 *
 * A player is 32 units wide and a jump block is 32 tall, so 64 is already generous.
 * Past that the teleport went somewhere the runner had not been — a map's own
 * trigger, a reset back to the start of a block they had not reached — and there is
 * no failed attempt of theirs to rub out.
 */
const CHECKPOINT_REACH = 64;

/**
 * How far from the landing spot still counts as standing on it, in Source units.
 *
 * The runner usually stands on the checkpoint for a moment before setting off, so
 * several ticks in a row sit on the same spot to within quantisation noise. The one
 * that matters is the last of them — the tick they left on — because the erased
 * stretch has to start there for the surviving line to join up cleanly.
 */
const SAME_SPOT = 2;

const distanceTo = (positions, tick, x, y, z) =>
  Math.hypot(
    positions[tick * 3] - x,
    positions[tick * 3 + 1] - y,
    positions[tick * 3 + 2] - z,
  );

/**
 * The stretches of the run that ended in a teleport back to a checkpoint.
 *
 * `{ from, to }` are tick indices: `from` is the tick the runner left the checkpoint
 * on, `to` is the tick they arrived back at it. Both ends are on the checkpoint, so
 * dropping the path between them leaves no gap to look at.
 *
 * Ranges are in order and never overlap: the search for a checkpoint only ever looks
 * back as far as the previous teleport, because anything before that belongs to an
 * attempt that has already been dealt with.
 */
export const wastedRanges = (track) => {
  const ranges = [];
  let attemptStart = 0;

  for (let tick = 1; tick < track.count; tick++) {
    if (track.teleports[tick] <= track.teleports[tick - 1]) continue;

    const x = track.positions[tick * 3];
    const y = track.positions[tick * 3 + 1];
    const z = track.positions[tick * 3 + 2];

    let nearest = Infinity;
    for (let back = attemptStart; back < tick; back++) {
      const distance = distanceTo(track.positions, back, x, y, z);
      if (distance < nearest) nearest = distance;
    }

    // Not a return to anywhere this attempt had been, so nothing of it was wasted.
    if (nearest > CHECKPOINT_REACH) {
      attemptStart = tick;
      continue;
    }

    // The last tick that was still on the spot: where the failed attempt began.
    let from = attemptStart;
    for (let back = attemptStart; back < tick; back++) {
      if (distanceTo(track.positions, back, x, y, z) <= nearest + SAME_SPOT) {
        from = back;
      }
    }

    if (from < tick) ranges.push({ from, to: tick });
    attemptStart = tick;
  }

  return ranges;
};

/**
 * Everything the player needs to draw and time a TP run without its failed attempts.
 *
 * A path of `count` ticks is drawn as `count - 1` segments, segment `s` joining tick
 * `s` to tick `s + 1`, and everything here is counted in segments rather than ticks
 * for that reason: a duration is a number of segments over the tick rate, so cutting
 * segments out of the path cuts exactly that much time out of the run.
 *
 * Takes the ranges rather than finding them, so a caller that does not want the run
 * trimmed at all can pass none and get a description of the whole recorded path back
 * in the same shape, with nothing wasted and nothing to skip.
 *
 * @returns ranges          the wasted stretches, in order
 * @returns rangeOfSegment  for each segment, which range erases it, or -1
 * @returns erasedThrough   segments erased by the first n ranges, for n = 0..ranges
 * @returns keptSegments    the surviving segments, in order — the clean route
 * @returns keptBefore      for each tick, how many surviving segments come before it
 * @returns wastedSeconds   how long the runner spent on attempts that came to nothing
 * @returns cleanDuration   how long the run would have taken with none of them
 */
export const analyseTeleports = (track, ranges = wastedRanges(track)) => {
  const segments = track.count - 1;

  const rangeOfSegment = new Int32Array(segments).fill(-1);
  const erasedThrough = new Int32Array(ranges.length + 1);
  for (let r = 0; r < ranges.length; r++) {
    const { from, to } = ranges[r];
    // Segments `from`..`to - 1`: leaving the checkpoint, up to and including the
    // teleport back to it.
    for (let s = from; s < to; s++) rangeOfSegment[s] = r;
    erasedThrough[r + 1] = erasedThrough[r] + (to - from);
  }

  const wastedSegments = erasedThrough[ranges.length];
  const keptSegments = new Int32Array(segments - wastedSegments);
  const keptBefore = new Int32Array(track.count);
  let kept = 0;
  for (let s = 0; s < segments; s++) {
    keptBefore[s] = kept;
    if (rangeOfSegment[s] < 0) keptSegments[kept++] = s;
  }
  keptBefore[segments] = kept;

  return {
    ranges,
    rangeOfSegment,
    erasedThrough,
    keptSegments,
    keptBefore,
    wastedSeconds: wastedSegments / track.tickRate,
    cleanDuration: keptSegments.length / track.tickRate,
  };
};

/**
 * How many of the wasted stretches the runner has already teleported out of by a
 * given tick — which is how many of them should have been rubbed off the screen.
 *
 * Binary search rather than a walking cursor because the timeline is draggable, so
 * playback jumps backwards as often as it runs forwards.
 */
export const rangesReachedBy = (ranges, tick) => {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle].to <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
};
