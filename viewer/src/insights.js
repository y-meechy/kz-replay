// Everything derived from two runs, ready to plot.
//
// The one idea worth understanding: a run is only ever measured against another at
// the same DISTANCE along the course, never at the same moment in time. Every
// series below therefore has course distance on its x axis.
//
// The decomposition in sectorBreakdown() is the piece that actually explains a
// gap. Time is distance over speed, so losing time can only come from two places:
// travelling further, or travelling slower. Splitting each sector into those two
// numbers turns "you lost 0.58s here" into "0.12s of it was a wider line and
// 0.46s was simply less speed", which is the difference between a routing mistake
// and a movement mistake.

import {
  alignPaths,
  buildPath,
  deltaCurve,
  indexAtDistance,
  timeAtDistance,
} from "../../src/compare.js";
import { TRACK_FLAG } from "../../src/track.js";

const pathOfTrack = (track) => buildPath(track.positions, track.count);

const sampleTrack = (track, progress, distance, tickRate) => {
  const index = indexAtDistance(progress, distance);
  return {
    index,
    time: index / tickRate,
    speed: track.speed[index],
    height: track.positions[index * 3 + 2],
    verticalSpeed: track.verticalSpeed[index],
    onGround: (track.flags[index] & TRACK_FLAG.ONGROUND) !== 0,
    ducking: (track.flags[index] & TRACK_FLAG.DUCKING) !== 0,
  };
};

/**
 * Time each run spent in each sector, split into how much of any difference came
 * from the line taken and how much from raw speed.
 *
 * The two costs add up to the sector delta exactly, by construction:
 *   Δt = (distB - distA)/vA  +  distB·(1/vB - 1/vA)
 */
const sectorBreakdown = ({
  reference,
  challenger,
  referencePath,
  challengerPath,
  challengerProgress,
  courseLength,
  sectorCount,
  tickRate,
}) => {
  const sectors = [];

  for (let s = 0; s < sectorCount; s++) {
    const from = (courseLength * s) / sectorCount;
    const to = (courseLength * (s + 1)) / sectorCount;

    const refStartTime = timeAtDistance(
      referencePath.cumulative,
      from,
      tickRate,
    );
    const refEndTime = timeAtDistance(referencePath.cumulative, to, tickRate);
    const chalStartTime = timeAtDistance(challengerProgress, from, tickRate);
    const chalEndTime = timeAtDistance(challengerProgress, to, tickRate);

    const refTime = Math.max(refEndTime - refStartTime, 1e-6);
    const chalTime = Math.max(chalEndTime - chalStartTime, 1e-6);

    // How far each run actually travelled to cross this sector.
    const refDistance = to - from;
    const chalStartIndex = indexAtDistance(challengerProgress, from);
    const chalEndIndex = indexAtDistance(challengerProgress, to);
    const chalDistance = Math.max(
      challengerPath.cumulative[chalEndIndex] -
        challengerPath.cumulative[chalStartIndex],
      1e-6,
    );

    const refSpeed = refDistance / refTime;
    const chalSpeed = chalDistance / chalTime;

    sectors.push({
      sector: s + 1,
      from,
      to,
      referenceTime: refTime,
      challengerTime: chalTime,
      delta: chalTime - refTime,
      referenceDistance: refDistance,
      challengerDistance: chalDistance,
      referenceSpeed: refSpeed,
      challengerSpeed: chalSpeed,
      // Cost of the extra ground covered, priced at the reference's speed.
      routeCost: (chalDistance - refDistance) / refSpeed,
      // Cost of being slower, over the distance actually covered.
      speedCost: chalDistance * (1 / chalSpeed - 1 / refSpeed),
      referenceStartTime: refStartTime,
      challengerStartTime: chalStartTime,
    });
  }

  return sectors;
};

/**
 * Moving average over the delta curve, used before hunting for swings.
 *
 * Two kinds of noise sit on the raw curve. Time only exists at tick resolution, so
 * every sample is quantised by about 16 ms; and where the reference line wiggles,
 * the nearest-point projection can flick between passes of the wiggle, moving the
 * matched course position by tens of units. Neither is a mistake by the player, but
 * both are big enough to fake a two-tenths "moment" if you difference the raw curve.
 */
const smoothDelta = (curve, window = 5) => {
  const half = Math.floor(window / 2);
  return curve.map((point, index) => {
    let sum = 0;
    let count = 0;
    for (let i = index - half; i <= index + half; i++) {
      if (i < 0 || i >= curve.length) continue;
      sum += curve[i].delta;
      count += 1;
    }
    return { ...point, delta: sum / count };
  });
};

/**
 * The moments that actually cost the run.
 *
 * Slides a window along the delta curve and ranks by how much the gap grew inside
 * it, then keeps the worst non-overlapping ones. A ranking of sectors would miss a
 * loss that straddles a sector boundary; a window does not care where the
 * boundaries are.
 */
const findSwings = ({
  curve,
  windowSamples,
  limit,
  losses,
  reference,
  challenger,
  referencePath,
  challengerProgress,
  tickRate,
}) => {
  const candidates = [];
  for (let i = 0; i + windowSamples < curve.length; i++) {
    const start = curve[i];
    const end = curve[i + windowSamples];
    candidates.push({
      startIndex: i,
      endIndex: i + windowSamples,
      // Positive: the gap grew, so the challenger lost time in this window.
      gained: end.delta - start.delta,
    });
  }
  // Worst losses first, or biggest gains first, depending on what was asked for.
  candidates.sort((a, b) =>
    losses ? b.gained - a.gained : a.gained - b.gained,
  );

  const chosen = [];
  for (const candidate of candidates) {
    if (losses ? candidate.gained <= 0.005 : candidate.gained >= -0.005) break;
    const overlaps = chosen.some(
      (kept) =>
        candidate.startIndex < kept.endIndex &&
        candidate.endIndex > kept.startIndex,
    );
    if (overlaps) continue;
    chosen.push(candidate);
    if (chosen.length >= limit) break;
  }

  return chosen
    .sort((a, b) => a.startIndex - b.startIndex)
    .map((window) => {
      const start = curve[window.startIndex];
      const end = curve[window.endIndex];
      const midDistance = (start.distance + end.distance) / 2;
      const ref = sampleTrack(
        reference.track,
        referencePath.cumulative,
        midDistance,
        tickRate,
      );
      const chal = sampleTrack(
        challenger.track,
        challengerProgress,
        midDistance,
        tickRate,
      );

      // What was going on: a slow landing reads very differently from a slow
      // stretch of air, and the fix is different too.
      const state =
        !ref.onGround && !chal.onGround
          ? "in the air"
          : chal.onGround && !ref.onGround
            ? "on the ground while the other was still flying"
            : "on the ground";

      return {
        fromDistance: start.distance,
        toDistance: end.distance,
        atProgress: (start.progress + end.progress) / 2,
        // Positive: time the challenger lost. Negative: time it took back.
        secondsLost: end.delta - start.delta,
        referenceTime: start.timeReference,
        challengerTime: start.timeChallenger,
        referenceSpeed: ref.speed,
        challengerSpeed: chal.speed,
        speedDeficit: chal.speed - ref.speed,
        state,
      };
    });
};

/** Share of ticks in each speed bucket, as a percentage. */
const speedHistogram = (track, bucketSize = 25) => {
  const buckets = new Map();
  for (let i = 0; i < track.count; i++) {
    const bucket = Math.floor(track.speed[i] / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([speed, count]) => ({ speed, share: (count / track.count) * 100 }));
};

/**
 * Compare two loaded runs.
 *
 * @param reference  the run everything is measured against, normally the faster
 * @param challenger the run being examined
 */
export const buildInsights = (
  reference,
  challenger,
  {
    samples = 240,
    sectorCount = 20,
    lossWindowSamples = 8,
    lossMoments = 6,
  } = {},
) => {
  const tickRate = reference.track.tickRate;
  const referencePath = pathOfTrack(reference.track);
  const challengerPath = pathOfTrack(challenger.track);
  const { progress: challengerProgress, deviation } = alignPaths(
    referencePath,
    challengerPath,
  );

  const { courseLength, curve } = deltaCurve({
    referenceProgress: referencePath.cumulative,
    challengerProgress,
    tickRate,
    samples,
  });

  // Everything plottable, sampled on the shared distance axis.
  const traces = {
    distance: [],
    progress: [],
    referenceSpeed: [],
    challengerSpeed: [],
    speedDelta: [],
    referenceHeight: [],
    challengerHeight: [],
    delta: [],
  };

  const smoothed = smoothDelta(curve);

  for (const [index, point] of curve.entries()) {
    const ref = sampleTrack(
      reference.track,
      referencePath.cumulative,
      point.distance,
      tickRate,
    );
    const chal = sampleTrack(
      challenger.track,
      challengerProgress,
      point.distance,
      tickRate,
    );
    traces.distance.push(point.distance);
    traces.progress.push(point.progress);
    traces.referenceSpeed.push(ref.speed);
    traces.challengerSpeed.push(chal.speed);
    traces.speedDelta.push(chal.speed - ref.speed);
    traces.referenceHeight.push(ref.height);
    traces.challengerHeight.push(chal.height);
    // The plotted curve is the smoothed one, so what the chart shows and what the
    // highlights were found in are the same thing.
    traces.delta.push(smoothed[index].delta);
  }

  const sectors = sectorBreakdown({
    reference,
    challenger,
    referencePath,
    challengerPath,
    challengerProgress,
    courseLength,
    sectorCount,
    tickRate,
  });

  const swingArgs = {
    curve: smoothed,
    windowSamples: lossWindowSamples,
    limit: lossMoments,
    reference,
    challenger,
    referencePath,
    challengerProgress,
    tickRate,
  };
  const moments = findSwings({ ...swingArgs, losses: true });
  const gains = findSwings({ ...swingArgs, losses: false });

  // Jumps placed on the shared axis, so a weak jump can be blamed on a place.
  const jumpsOf = (run, progress) =>
    run.analysis.jumps.list.map((jump) => ({
      distance: progress
        ? (progress[jump.takeoffTick] ?? 0)
        : jump.distanceAlongCourse,
      takeoffSpeed: jump.takeoffSpeed,
      jumpDistance: jump.distance,
      airtime: jump.airtimeSeconds,
      sync: jump.sync,
      strafes: jump.strafes,
      perf: jump.perf,
    }));

  const totals = sectors.reduce(
    (sum, sector) => ({
      route: sum.route + sector.routeCost,
      speed: sum.speed + sector.speedCost,
      delta: sum.delta + sector.delta,
    }),
    { route: 0, speed: 0, delta: 0 },
  );

  const sortedDeviation = [...deviation].sort((a, b) => a - b);
  const medianDeviation =
    sortedDeviation[Math.floor(sortedDeviation.length / 2)] ?? 0;
  const referenceLength = referencePath.cumulative.at(-1);
  const coverage = courseLength / Math.max(referenceLength, 1);

  // Two runs on the same named course can still be incomparable: a route the other
  // player never took, or a map republished with different geometry. Say so rather
  // than plotting a delta curve built on a bad match.
  const warning =
    coverage < 0.9
      ? `only ${(coverage * 100).toFixed(0)}% of the reference route could be followed in the other run`
      : medianDeviation > 200
        ? `the two runs are a median of ${medianDeviation.toFixed(0)} units apart, so they are not really on the same line`
        : null;

  return {
    warning,
    coverage,
    reference,
    challenger,
    tickRate,
    courseLength,
    curve,
    traces,
    sectors,
    moments,
    gains,
    /** Losses and gains together, biggest swing first. */
    swings: [...moments, ...gains].sort(
      (a, b) => Math.abs(b.secondsLost) - Math.abs(a.secondsLost),
    ),
    totals,
    finalDelta:
      (challenger.meta.reportedTime ?? 0) - (reference.meta.reportedTime ?? 0),
    referenceProgress: referencePath.cumulative,
    challengerProgress,
    histograms: {
      reference: speedHistogram(reference.track),
      challenger: speedHistogram(challenger.track),
    },
    jumps: {
      reference: jumpsOf(reference, null),
      challenger: jumpsOf(challenger, challengerProgress),
    },
    line: {
      medianDeviation,
      p90Deviation:
        sortedDeviation[Math.floor(sortedDeviation.length * 0.9)] ?? 0,
      maxDeviation: sortedDeviation.at(-1) ?? 0,
    },
  };
};
