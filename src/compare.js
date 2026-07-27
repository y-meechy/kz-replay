// Compare two runs on the same course and say where the time actually went.
//
// The whole trick is: never compare two runs at the same moment in time. Compare
// them at the same point on the course. Run B being 0.3s behind at the finish says
// nothing about where those 0.3s were lost, and both runs take different lines, so
// "distance travelled so far" is not comparable either (a wider line is longer, not
// further along).
//
// So one run is the reference. Every tick of the other run is projected onto the
// reference's path to answer "how far along the course was this?". That gives both
// runs a shared x axis, and the time difference at each point along it is the
// familiar racing delta: positive means the challenger is behind.

const TICK_RATE = 64;

/**
 * Nearest point on segment ab to p, as a fraction along the segment plus the
 * squared distance to it. Squared, because we only ever compare distances.
 */
const projectOntoSegment = (px, py, pz, ax, ay, az, bx, by, bz) => {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  if (lengthSquared === 0) {
    const dx = px - ax;
    const dy = py - ay;
    const dz = pz - az;
    return { t: 0, distanceSquared: dx * dx + dy * dy + dz * dz };
  }
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return { t, distanceSquared: dx * dx + dy * dy + dz * dz };
};

/**
 * A run reduced to what the comparison needs: one point per tick, plus how far
 * along its own path each of those points is.
 *
 * Takes a flat xyz array so both callers can use it: the CLI passes the full tick
 * origins, and the viewer passes a decoded .kztrack, which carries the same
 * positions in the same coordinates.
 */
export const buildPath = (positions, count) => {
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  const cumulative = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    xs[i] = positions[i * 3];
    ys[i] = positions[i * 3 + 1];
    zs[i] = positions[i * 3 + 2];
    if (i > 0) {
      cumulative[i] =
        cumulative[i - 1] +
        Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1], zs[i] - zs[i - 1]);
    }
  }

  return { xs, ys, zs, cumulative, count };
};

/** Path of an analysed run, over its trimmed tick range. */
const pathOf = (analysis) => {
  const { ticks, from, to, tickIndices } = analysis._series;
  if (!tickIndices) {
    const count = to - from + 1;
    return buildPath(ticks.origin.subarray(from * 3, (to + 1) * 3), count);
  }
  const positions = new Float32Array(tickIndices.length * 3);
  for (let i = 0; i < tickIndices.length; i++) {
    const source = tickIndices[i] * 3;
    positions[i * 3] = ticks.origin[source];
    positions[i * 3 + 1] = ticks.origin[source + 1];
    positions[i * 3 + 2] = ticks.origin[source + 2];
  }
  return buildPath(positions, tickIndices.length);
};

/**
 * For every tick of `challenger`, how far along `reference`'s course it was.
 *
 * Nearest point on the reference path wins, but with a penalty for landing further
 * along the course than the run could plausibly have reached. Both halves matter:
 *
 * - Without the penalty, a course that doubles back or reuses a corridor puts two
 *   very different course positions at nearly the same place in the world. The
 *   match teleports forward, the monotonic pass locks it in, and the delta curve
 *   invents seconds of loss that never happened.
 * - With a hard ceiling instead of a penalty, one tick that legitimately needs a
 *   big advance (the reference wandering while the challenger cuts straight) leaves
 *   the match behind for good: the window then sits in the wrong place, every
 *   candidate is worse, and progress freezes for the rest of the run.
 *
 * A soft cost cannot deadlock. It just makes a big jump forward something the
 * geometry has to earn.
 */
export const alignPaths = (
  ref,
  other,
  {
    windowBack = 250,
    windowForward = 900,
    jumpPenalty = 0.25,
    // How much further along the course than its own movement a run is allowed to
    // advance for free. Cutting a corner the other run took wide genuinely does
    // advance faster than the step, so a little slack here avoids penalising honest
    // matches and the lag-then-catch-up wobble that follows.
    slackFactor = 1.6,
    slackUnits = 12,
  } = {},
) => {
  const progress = new Float64Array(other.count);
  const deviation = new Float64Array(other.count);

  let anchor = 0;
  let travelled = 0;

  for (let j = 0; j < other.count; j++) {
    const px = other.xs[j];
    const py = other.ys[j];
    const pz = other.zs[j];

    // What the run itself covered this tick: the advance we should expect.
    const step =
      j === 0
        ? 0
        : Math.hypot(
            px - other.xs[j - 1],
            py - other.ys[j - 1],
            pz - other.zs[j - 1],
          );
    const expected = travelled + step * slackFactor + slackUnits;

    const scan = (fromIndex, toIndex) => {
      let best = {
        cost: Infinity,
        distanceSquared: Infinity,
        matched: travelled,
        index: anchor,
      };
      const start = Math.max(0, fromIndex);
      const end = Math.min(ref.count - 1, toIndex);
      for (let i = start; i < end; i++) {
        const hit = projectOntoSegment(
          px,
          py,
          pz,
          ref.xs[i],
          ref.ys[i],
          ref.zs[i],
          ref.xs[i + 1],
          ref.ys[i + 1],
          ref.zs[i + 1],
        );
        const segmentStart = ref.cumulative[i];
        const segmentEnd = ref.cumulative[i + 1] ?? segmentStart;
        const matched = segmentStart + (segmentEnd - segmentStart) * hit.t;
        const overshoot = Math.max(0, matched - expected);
        const cost = hit.distanceSquared + jumpPenalty * overshoot * overshoot;
        if (cost < best.cost) {
          best = {
            cost,
            distanceSquared: hit.distanceSquared,
            matched,
            index: i,
          };
        }
      }
      return best;
    };

    let best = scan(anchor - windowBack, anchor + windowForward);
    // 128 units is four jump blocks: past that the window clearly missed, so look
    // everywhere. The penalty still keeps the choice honest.
    if (best.distanceSquared > 128 * 128) {
      const everywhere = scan(0, ref.count - 1);
      if (everywhere.cost < best.cost) best = everywhere;
    }

    anchor = best.index;
    // The course only goes one way.
    travelled = Math.max(best.matched, travelled);
    progress[j] = travelled;
    deviation[j] = Math.sqrt(best.distanceSquared);
  }

  return { progress, deviation };
};

/** Time (seconds) at which a run reached a given distance along the reference. */
export const timeAtDistance = (progress, distance, tickRate = TICK_RATE) => {
  if (distance <= progress[0]) return 0;
  const last = progress.length - 1;
  if (distance >= progress[last]) return last / tickRate;

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (progress[mid] <= distance) low = mid;
    else high = mid;
  }
  const span = progress[high] - progress[low];
  const fraction = span === 0 ? 0 : (distance - progress[low]) / span;
  return (low + fraction) / tickRate;
};

/**
 * Which tick a run was on when it reached a given distance along the course.
 *
 * Same search as timeAtDistance, but returning the index, so callers can read any
 * per-tick value (speed, height, inputs) at a shared point on the course.
 */
export const indexAtDistance = (progress, distance) => {
  const last = progress.length - 1;
  if (distance <= progress[0]) return 0;
  if (distance >= progress[last]) return last;

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (progress[mid] <= distance) low = mid;
    else high = mid;
  }
  return low;
};

/**
 * The delta curve: at evenly spaced points along the course, how far apart in time
 * the two runs were. Positive delta means the challenger is behind.
 *
 * Exported on its own because the viewer draws this from two .kztrack files, with
 * no need for the rest of the analysis.
 */
export const deltaCurve = ({
  referenceProgress,
  challengerProgress,
  tickRate = TICK_RATE,
  samples = 200,
}) => {
  const courseLength = Math.min(
    referenceProgress[referenceProgress.length - 1],
    challengerProgress[challengerProgress.length - 1],
  );

  const curve = [];
  for (let s = 0; s <= samples; s++) {
    const distance = (courseLength * s) / samples;
    const timeReference = timeAtDistance(referenceProgress, distance, tickRate);
    const timeChallenger = timeAtDistance(
      challengerProgress,
      distance,
      tickRate,
    );
    curve.push({
      distance: Math.round(distance),
      progress: +(s / samples).toFixed(4),
      timeReference: +timeReference.toFixed(4),
      timeChallenger: +timeChallenger.toFixed(4),
      delta: +(timeChallenger - timeReference).toFixed(4),
    });
  }

  return { courseLength, curve };
};

/** Equal-distance sectors, with the time each run spent in each one. */
export const sectorTable = ({
  referenceProgress,
  challengerProgress,
  courseLength,
  tickRate = TICK_RATE,
  sectorCount = 20,
}) => {
  const sectors = [];
  for (let s = 0; s < sectorCount; s++) {
    const startDistance = (courseLength * s) / sectorCount;
    const endDistance = (courseLength * (s + 1)) / sectorCount;
    const refStart = timeAtDistance(referenceProgress, startDistance, tickRate);
    const refEnd = timeAtDistance(referenceProgress, endDistance, tickRate);
    const challengerStart = timeAtDistance(
      challengerProgress,
      startDistance,
      tickRate,
    );
    const challengerEnd = timeAtDistance(
      challengerProgress,
      endDistance,
      tickRate,
    );
    const referenceTime = refEnd - refStart;
    const challengerTime = challengerEnd - challengerStart;

    sectors.push({
      sector: s + 1,
      fromDistance: Math.round(startDistance),
      toDistance: Math.round(endDistance),
      referenceTime: +referenceTime.toFixed(3),
      challengerTime: +challengerTime.toFixed(3),
      // Positive: the challenger lost time here.
      delta: +(challengerTime - referenceTime).toFixed(3),
      cumulativeDelta: +(challengerEnd - refEnd).toFixed(3),
      referenceSpeed: Math.round(
        (endDistance - startDistance) / Math.max(referenceTime, 1e-6),
      ),
      challengerSpeed: Math.round(
        (endDistance - startDistance) / Math.max(challengerTime, 1e-6),
      ),
    });
  }
  return sectors;
};

/**
 * Compare two analysed runs.
 *
 * @param reference  the run to measure against (normally the faster one)
 * @param challenger the run being examined
 * @param sectorCount how many equal-distance sectors to split the course into
 */
export const compareRuns = (
  reference,
  challenger,
  { sectorCount = 20, curveSamples = 200 } = {},
) => {
  // The reference is trivially aligned to itself: distance along its own path.
  const refProgress = pathOf(reference).cumulative;
  const { progress: challengerProgress, deviation } = alignPaths(
    pathOf(reference),
    pathOf(challenger),
  );

  const { courseLength, curve } = deltaCurve({
    referenceProgress: refProgress,
    challengerProgress,
    samples: curveSamples,
  });
  const sectors = sectorTable({
    referenceProgress: refProgress,
    challengerProgress,
    courseLength,
    sectorCount,
  });

  const byLoss = [...sectors].sort((a, b) => b.delta - a.delta);

  // Jumps, matched by where on the course they happened rather than by index, so a
  // missing or extra jump does not shift everything after it.
  const challengerJumpDistance = (jump) =>
    challengerProgress[jump.takeoffTick] ?? 0;
  // Two pointers walking both jump lists in course order. Nearest-neighbour
  // matching looks right per jump but shuffles the whole table: as soon as one
  // reference jump pairs with its neighbour, every later row is off by one. Walking
  // in order cannot do that, and an extra jump in either run just stays unmatched.
  const JUMP_MATCH_TOLERANCE = 150; // units, about five jump blocks
  const refJumps = reference.jumps.list;
  const otherJumps = challenger.jumps.list;
  const pairs = [];
  const matched = new Set();

  const addPair = (refJump, match) =>
    pairs.push({
      distanceAlongCourse: refJump.distanceAlongCourse,
      reference: refJump,
      challenger: match,
      distanceGap: match
        ? +(match.distance - refJump.distance).toFixed(1)
        : null,
      takeoffSpeedGap: match ? match.takeoffSpeed - refJump.takeoffSpeed : null,
      airtimeGap: match
        ? +(match.airtimeSeconds - refJump.airtimeSeconds).toFixed(3)
        : null,
    });

  let i = 0;
  let j = 0;
  while (i < refJumps.length) {
    if (j >= otherJumps.length) {
      addPair(refJumps[i], null);
      i += 1;
      continue;
    }
    const gap =
      challengerJumpDistance(otherJumps[j]) - refJumps[i].distanceAlongCourse;

    if (Math.abs(gap) <= JUMP_MATCH_TOLERANCE) {
      matched.add(j);
      addPair(refJumps[i], otherJumps[j]);
      i += 1;
      j += 1;
    } else if (gap > 0) {
      // The challenger's next jump is still further up the course.
      addPair(refJumps[i], null);
      i += 1;
    } else {
      // The challenger jumped somewhere the reference did not.
      j += 1;
    }
  }

  const unmatchedChallengerJumps = otherJumps.filter(
    (_, index) => !matched.has(index),
  );

  const deviations = [...deviation].sort((a, b) => a - b);

  return {
    courseLength: Math.round(courseLength),
    /** Full length of the reference path, to judge how much was compared. */
    referenceLength: Math.round(refProgress[refProgress.length - 1]),
    finalDelta: +(
      challenger.run.reportedTime - reference.run.reportedTime
    ).toFixed(4),
    curve,
    sectors,
    worstSectors: byLoss.slice(0, 5),
    bestSectors: byLoss.slice(-5).reverse(),
    line: {
      // How far apart the two lines are, in Source units.
      medianDeviation: Math.round(
        deviations[Math.floor(deviations.length / 2)] ?? 0,
      ),
      p90Deviation: Math.round(
        deviations[Math.floor(deviations.length * 0.9)] ?? 0,
      ),
      maxDeviation: Math.round(deviations[deviations.length - 1] ?? 0),
    },
    jumpPairs: pairs,
    unmatchedChallengerJumps,
  };
};
