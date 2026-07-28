// Split a course into sections at places both runs physically touched, and time
// each section on both runs' own clocks.
//
// The boundaries are landings. In KZ almost all of a run is airborne, so touching
// the ground is a rare, deliberate event: a block, a ledge, a corner. If both runs
// touched down within a block's width of each other, they were standing on the same
// thing, and the time between two such touches is directly comparable. No map
// geometry needed — the landing IS the block, and it comes with proof that both
// players were there.
//
// Two properties this has that sampling the delta curve does not:
//
//   - Each section time is an exact tick count on that run's own clock, not a time
//     read off a projection. Nothing about it depends on how well the two lines were
//     matched up.
//   - The deltas telescope. Add up every section and you get the final gap exactly,
//     so the table can never tell a story that contradicts the scoreboard.
//
// The alignment from compare.js is still used, but only for bookkeeping: to put the
// touches in course order, and to cut a section that ran too long without a landing.

const TICK_RATE = 64;

/**
 * How close two touchdowns must be to count as the same place.
 *
 * A jump block is 64 units across and players land anywhere on one, so the
 * horizontal window has to be about that wide. Vertically it must stay tight:
 * courses stack blocks and platforms directly above each other, and 40 units is
 * under one player height, so a landing one floor up can never be mistaken for the
 * same place.
 */
const HORIZONTAL_TOLERANCE = 80;
const VERTICAL_TOLERANCE = 40;

/**
 * How far apart along the course two touchdowns may be and still pair up.
 *
 * Being in the same world position is not quite enough on a course that doubles
 * back through a corridor. Two touches that are 80 units apart in space but a
 * thousand units apart along the course are two different moments in the run.
 */
const COURSE_TOLERANCE = 300;

/** Every tick where a run first touches the ground after being airborne. */
export const groundTouches = (path, isOnGround, progress) => {
  const touches = [];
  for (let i = 1; i < path.count; i++) {
    if (isOnGround(i - 1) || !isOnGround(i)) continue;
    touches.push({
      index: i,
      x: path.xs[i],
      y: path.ys[i],
      z: path.zs[i],
      distance: progress[i] ?? 0,
    });
  }
  return touches;
};

/**
 * Pair up two lists of touchdowns, walking both in course order.
 *
 * In-order and not nearest-neighbour, for the same reason the jump matching in
 * compare.js is: one touch pairing with its neighbour would shift every later pair
 * by one, and a table of sections that are each off by one block is worse than a
 * table with a few sections missing. An unpaired touch is simply not a boundary.
 */
export const matchTouches = (referenceTouches, challengerTouches) => {
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < referenceTouches.length && j < challengerTouches.length) {
    const a = referenceTouches[i];
    const b = challengerTouches[j];
    const horizontal = Math.hypot(a.x - b.x, a.y - b.y);
    const vertical = Math.abs(a.z - b.z);
    const along = Math.abs(a.distance - b.distance);
    if (
      horizontal <= HORIZONTAL_TOLERANCE &&
      vertical <= VERTICAL_TOLERANCE &&
      along <= COURSE_TOLERANCE
    ) {
      pairs.push({ reference: a, challenger: b, gap: horizontal });
      i += 1;
      j += 1;
      continue;
    }
    // Advance whichever run is further back along the course, so neither list runs
    // ahead of the other.
    if (a.distance <= b.distance) i += 1;
    else j += 1;
  }
  return pairs;
};

/**
 * Where a run was when it reached a distance along the course: the tick before it,
 * and how far past that tick.
 *
 * Same search as timeAtDistance in compare.js, but the fraction is kept so time and
 * distance travelled can be read off the same point. Reading them at two different
 * points is what makes a "speed" that does not match the times next to it.
 */
const locate = (progress, distance) => {
  const last = progress.length - 1;
  if (distance <= progress[0]) return { index: 0, fraction: 0 };
  if (distance >= progress[last]) return { index: last, fraction: 0 };

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (progress[middle] <= distance) low = middle;
    else high = middle;
  }
  const span = progress[high] - progress[low];
  return {
    index: low,
    fraction: span === 0 ? 0 : (distance - progress[low]) / span,
  };
};

const lerp = (values, index, fraction) =>
  fraction === 0
    ? values[index]
    : values[index] + (values[index + 1] - values[index]) * fraction;

/**
 * One end of a section, as both runs experienced it.
 *
 * `kind` is "landing" when both runs touched the ground here, which is the whole
 * point of this file. "split" and "line" boundaries are the fallbacks: a distance
 * cut inside a section that had no landing in it, and the start and finish.
 *
 * Both ends are given as `locate()` results, so every boundary carries its fraction
 * of a tick alongside its tick. Built in one place because the section maths reads
 * all four of those fields back out, and a boundary missing one of them would not
 * fail, it would quietly produce a time of NaN.
 */
const boundaryAt = ({
  kind,
  distance,
  reference,
  challenger,
  gap = null,
  tickRate,
}) => ({
  kind,
  distance,
  referenceIndex: reference.index,
  challengerIndex: challenger.index,
  referenceTime: (reference.index + reference.fraction) / tickRate,
  challengerTime: (challenger.index + challenger.fraction) / tickRate,
  referenceFraction: reference.fraction,
  challengerFraction: challenger.fraction,
  gap,
});

/** A boundary that sits on a whole tick of a run, in the shape `locate()` returns. */
const wholeTick = (index) => ({ index, fraction: 0 });

/** A landing both runs made: a whole tick on each of their clocks. */
const landingBoundary = (pair, tickRate) =>
  boundaryAt({
    kind: "landing",
    distance: pair.reference.distance,
    reference: wholeTick(pair.reference.index),
    challenger: wholeTick(pair.challenger.index),
    gap: pair.gap,
    tickRate,
  });

/** A boundary at a distance along the course, wherever that lands on each run. */
const distanceBoundary = ({
  kind,
  distance,
  referenceProgress,
  challengerProgress,
  tickRate,
}) =>
  boundaryAt({
    kind,
    distance,
    reference: locate(referenceProgress, distance),
    challenger: locate(challengerProgress, distance),
    tickRate,
  });

/**
 * Drop boundaries until every section lasts at least `minSeconds`.
 *
 * Landings come in bursts — a chain of hops crossing four blocks in a second, or the
 * on-ground flag flickering across a slope — and a table of 0.1s rows says nothing
 * about where a run was lost. The finish is always kept, and if that leaves a sliver
 * at the end, the boundary before it goes instead of leaving a row nobody can read.
 */
const thinBoundaries = (boundaries, minSeconds) => {
  if (boundaries.length <= 2) return boundaries;
  const kept = [boundaries[0]];
  for (const boundary of boundaries.slice(1, -1)) {
    if (boundary.referenceTime - kept.at(-1).referenceTime >= minSeconds) {
      kept.push(boundary);
    }
  }
  const finish = boundaries.at(-1);
  while (
    kept.length > 1 &&
    finish.referenceTime - kept.at(-1).referenceTime < minSeconds / 2
  ) {
    kept.pop();
  }
  kept.push(finish);
  return kept;
};

const clamp = (value, low, high) => {
  if (value < low) return low;
  if (value > high) return high;
  return value;
};

/** A boundary held inside the two it sits between, on both runs' clocks. */
const clampBetween = (boundary, after, before) => {
  const referenceTime = clamp(
    boundary.referenceTime,
    after.referenceTime,
    before.referenceTime,
  );
  const challengerTime = clamp(
    boundary.challengerTime,
    after.challengerTime,
    before.challengerTime,
  );
  return {
    ...boundary,
    referenceTime,
    challengerTime,
    referenceIndex: clamp(
      boundary.referenceIndex,
      after.referenceIndex,
      before.referenceIndex,
    ),
    challengerIndex: clamp(
      boundary.challengerIndex,
      after.challengerIndex,
      before.challengerIndex,
    ),
    // A clamped boundary landed on the tick it was clamped to, so the leftover
    // fraction would double-count part of a tick that is no longer inside it.
    referenceFraction:
      referenceTime === boundary.referenceTime ? boundary.referenceFraction : 0,
    challengerFraction:
      challengerTime === boundary.challengerTime
        ? boundary.challengerFraction
        : 0,
  };
};

/**
 * Cut any section longer than `maxSeconds` into equal-distance pieces.
 *
 * Not every course is blocks. A long slide, a ladder, a run-up: stretches with no
 * landing at all, which would otherwise be one ten second row saying "you lost 0.4s
 * somewhere in here". These cuts are arbitrary, which is why they are marked as
 * such, but they still telescope: both runs get their time read at the same
 * distance, so the sum over the pieces is the sum over the section.
 */
const splitLongSections = (
  boundaries,
  { referenceProgress, challengerProgress, maxSeconds, tickRate },
) => {
  const out = [boundaries[0]];
  for (let k = 1; k < boundaries.length; k++) {
    const from = boundaries[k - 1];
    const to = boundaries[k];
    const pieces = Math.ceil(
      (to.referenceTime - from.referenceTime) / maxSeconds,
    );
    for (let piece = 1; piece < pieces; piece++) {
      const cut = distanceBoundary({
        kind: "split",
        distance:
          from.distance + ((to.distance - from.distance) * piece) / pieces,
        referenceProgress,
        challengerProgress,
        tickRate,
      });
      // The landings either side of this cut are facts; the cut is a guess made from
      // the alignment, and the alignment can disagree with them. Keep it inside its
      // own section so no section can come out with negative time.
      out.push(clampBetween(cut, out.at(-1), to));
    }
    out.push(to);
  }
  return out;
};

/**
 * Which half of a section's route/speed split did the damage: "line" or "speed".
 *
 * The rule lives here rather than in each of the three places that words it, because
 * it is a judgement about the numbers and not about phrasing. A tie goes to "speed",
 * which only happens when both halves are zero.
 */
export const blameOf = (section) =>
  Math.abs(section.routeCost) > Math.abs(section.speedCost) ? "line" : "speed";

/**
 * The section table.
 *
 * @param referencePath      buildPath() of the run being measured against
 * @param challengerPath     buildPath() of the run being examined
 * @param challengerProgress alignPaths() progress of the challenger on the reference
 * @param referenceOnGround  (tickIndex) => boolean, on the reference's own ticks
 * @param challengerOnGround the same for the challenger
 * @param minSeconds         shortest section worth showing
 * @param maxSeconds         longest section before it gets cut by distance
 */
export const buildSections = ({
  referencePath,
  challengerPath,
  challengerProgress,
  referenceOnGround,
  challengerOnGround,
  tickRate = TICK_RATE,
  minSeconds = 1.5,
  maxSeconds = 5,
}) => {
  const referenceProgress = referencePath.cumulative;
  // Distance covered has to be measured along the path the player actually took, so
  // this is the challenger's own path length. Not `challengerProgress`, which is how
  // far along the REFERENCE's course each challenger tick got to.
  const challengerOwnProgress = challengerPath.cumulative;
  const referenceTouches = groundTouches(
    referencePath,
    referenceOnGround,
    referenceProgress,
  );
  const challengerTouches = groundTouches(
    challengerPath,
    challengerOnGround,
    challengerProgress,
  );
  const pairs = matchTouches(referenceTouches, challengerTouches);

  const start = distanceBoundary({
    kind: "line",
    distance: 0,
    referenceProgress,
    challengerProgress,
    tickRate,
  });
  // The finish is each run's own last tick, not a shared distance. That is what
  // makes the deltas add up to the real gap instead of to the gap at whatever point
  // the alignment happened to reach.
  //
  // Its distance is the reference's own full length, so the distance axis stays
  // consistent with the tick this boundary sits on. If the challenger never got this
  // far, the distance cuts near the end resolve to its last tick, which is the truth.
  const finish = boundaryAt({
    kind: "line",
    distance: referenceProgress.at(-1),
    reference: wholeTick(referencePath.count - 1),
    challenger: wholeTick(challengerPath.count - 1),
    tickRate,
  });

  // A landing after the finish line, or before the start, is not a boundary: the
  // clock was not running.
  const inside = pairs.filter(
    (pair) =>
      pair.reference.index > 0 &&
      pair.reference.index < finish.referenceIndex &&
      pair.challenger.index > 0 &&
      pair.challenger.index < finish.challengerIndex,
  );

  const landings = inside.map((pair) => landingBoundary(pair, tickRate));
  const boundaries = splitLongSections(
    thinBoundaries([start, ...landings, finish], minSeconds),
    { referenceProgress, challengerProgress, maxSeconds, tickRate },
  );

  const sections = [];
  let cumulativeDelta = 0;
  for (let k = 1; k < boundaries.length; k++) {
    const from = boundaries[k - 1];
    const to = boundaries[k];
    const referenceTime = to.referenceTime - from.referenceTime;
    const challengerTime = to.challengerTime - from.challengerTime;
    const delta = challengerTime - referenceTime;
    cumulativeDelta += delta;

    // How far each run actually travelled to cross the section, along its own path.
    const referenceDistance = Math.max(
      lerp(referenceProgress, to.referenceIndex, to.referenceFraction) -
        lerp(referenceProgress, from.referenceIndex, from.referenceFraction),
      1e-6,
    );
    const challengerDistance = Math.max(
      lerp(challengerOwnProgress, to.challengerIndex, to.challengerFraction) -
        lerp(
          challengerOwnProgress,
          from.challengerIndex,
          from.challengerFraction,
        ),
      1e-6,
    );
    const referenceSpeed = referenceDistance / Math.max(referenceTime, 1e-6);
    const challengerSpeed = challengerDistance / Math.max(challengerTime, 1e-6);

    sections.push({
      section: k,
      /** How the section ended: a shared landing, a distance cut, or the finish. */
      kind: to.kind,
      fromDistance: from.distance,
      toDistance: to.distance,
      referenceFromTime: from.referenceTime,
      referenceToTime: to.referenceTime,
      challengerFromTime: from.challengerTime,
      challengerToTime: to.challengerTime,
      referenceTime,
      challengerTime,
      /** Positive: the challenger lost time here. */
      delta,
      cumulativeDelta,
      referenceDistance,
      challengerDistance,
      referenceSpeed,
      challengerSpeed,
      // Same split as the headline totals: time is distance over speed, so a gap can
      // only come from covering more ground or covering it slower. The two add up to
      // `delta` exactly, whatever the numbers are.
      routeCost: (challengerDistance - referenceDistance) / referenceSpeed,
      speedCost:
        challengerDistance * (1 / challengerSpeed - 1 / referenceSpeed),
    });
  }

  const comparable = Math.min(
    referenceTouches.length,
    challengerTouches.length,
  );
  return {
    sections,
    boundaries,
    touches: {
      reference: referenceTouches.length,
      challenger: challengerTouches.length,
      matched: inside.length,
      /** Share of the touchdowns of the shorter list that paired up. */
      matchedFraction: comparable === 0 ? 0 : inside.length / comparable,
      /** Share of sections whose end is a real shared landing. */
      landingFraction:
        sections.length === 0
          ? 0
          : sections.filter((section) => section.kind === "landing").length /
            sections.length,
    },
  };
};
