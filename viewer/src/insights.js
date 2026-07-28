// Everything derived from two runs, ready to plot.
//
// Two ideas hold this together.
//
// The plotted series are only ever measured at the same DISTANCE along the course,
// never at the same moment in time, so every trace below has course distance on its
// x axis.
//
// The numbers that explain the gap come from sections.js instead: the course cut at
// places both runs touched the ground, timed on each run's own clock. Those are
// events that really happened in both runs, so a section time owes nothing to how
// well the two lines were matched up, and the deltas add up to the final gap.
//
// Each section also splits its delta two ways. Time is distance over speed, so
// losing time can only come from travelling further or travelling slower. That turns
// "you lost 0.39s here" into "0.24s of it was a wider line and 0.15s was less
// speed", which is the difference between a routing mistake and a movement mistake.

import {
  alignPaths,
  buildPath,
  deltaCurve,
  indexAtDistance,
} from "../../src/compare.js";
import { blameOf, buildSections } from "../../src/sections.js";
import { TRACK_FLAG } from "../../src/track.js";

const pathOfTrack = (track) => buildPath(track.positions, track.count);

/**
 * Whether a run was standing on something, by index along its path.
 *
 * A .kztrack has one entry per recorded tick, so the path index and the flag index
 * are the same thing here. The CLI has to map between the two.
 */
const onGroundOf = (track) => (index) =>
  (track.flags[index] & TRACK_FLAG.ONGROUND) !== 0;

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
 * Moving average over the delta curve, for drawing only.
 *
 * Two kinds of noise sit on the raw curve. Time only exists at tick resolution, so
 * every sample is quantised by about 16 ms; and where the reference line wiggles,
 * the nearest-point projection can flick between passes of the wiggle, moving the
 * matched course position by tens of units. Neither is a mistake by the player, and
 * a chart full of both is harder to read for no gain. No number is taken off this
 * curve — the sections do that — so smoothing it costs nothing.
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
 * The sections worth marking on the chart and the timeline, biggest first.
 *
 * A section time is an exact tick count, so the noise floor here is honest: two
 * ticks. Below that there is nothing to look at, and two runs that are genuinely the
 * same should leave the chart clean rather than covered in confident red bands.
 */
const findHighlights = (sections, tickRate, { losses, limit }) => {
  const floor = 2 / tickRate;
  return sections
    .filter((section) =>
      losses ? section.delta >= floor : section.delta <= -floor,
    )
    .sort((a, b) => (losses ? b.delta - a.delta : a.delta - b.delta))
    .slice(0, limit)
    .map((section) => ({
      section: section.section,
      fromDistance: section.fromDistance,
      toDistance: section.toDistance,
      /** Positive: time the challenger lost. Negative: time it took back. */
      secondsLost: section.delta,
      referenceTime: section.referenceFromTime,
      challengerTime: section.challengerFromTime,
      referenceToTime: section.referenceToTime,
      challengerToTime: section.challengerToTime,
      // Which half of the split is doing the work, for a one-line explanation.
      blame: blameOf(section) === "line" ? "a longer line" : "less speed",
    }));
};

/**
 * Why these two runs might not be comparable at all, or null if they are.
 *
 * Two runs on the same named course can still be incomparable: a route the other
 * player never took, or a map republished with different geometry. Say so rather than
 * plotting a delta curve built on a bad match.
 *
 * Checked worst first, and only one is shown: a bad match sets off all three, and
 * three warnings about one problem read like three problems.
 */
const comparabilityWarning = ({ coverage, medianDeviation, touches }) => {
  if (coverage < 0.9) {
    return `only ${(coverage * 100).toFixed(0)}% of the reference route could be followed in the other run`;
  }
  if (medianDeviation > 200) {
    return `the two runs are a median of ${medianDeviation.toFixed(0)} units apart, so they are not really on the same line`;
  }
  // Barely any shared landings is the same story told a different way, and it is the
  // one that matters here: with nothing shared to cut the course at, the sections
  // stop being places and become arbitrary distance slices.
  if (touches.matchedFraction < 0.4) {
    return `the two runs only touched down in the same place ${(touches.matchedFraction * 100).toFixed(0)}% of the time, so the sections below are guesses`;
  }
  return null;
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
  { samples = 240, minSeconds = 1.5, maxSeconds = 5, highlights = 3 } = {},
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
    traces.delta.push(smoothed[index].delta);
  }

  const { sections, touches } = buildSections({
    referencePath,
    challengerPath,
    challengerProgress,
    referenceOnGround: onGroundOf(reference.track),
    challengerOnGround: onGroundOf(challenger.track),
    tickRate,
    minSeconds,
    maxSeconds,
  });

  const worst = findHighlights(sections, tickRate, {
    losses: true,
    limit: highlights,
  });
  const best = findHighlights(sections, tickRate, {
    losses: false,
    limit: highlights,
  });

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

  const totals = sections.reduce(
    (sum, section) => ({
      route: sum.route + section.routeCost,
      speed: sum.speed + section.speedCost,
      delta: sum.delta + section.delta,
    }),
    { route: 0, speed: 0, delta: 0 },
  );

  const sortedDeviation = [...deviation].sort((a, b) => a - b);
  const medianDeviation =
    sortedDeviation[Math.floor(sortedDeviation.length / 2)] ?? 0;
  const referenceLength = referencePath.cumulative.at(-1);
  const coverage = courseLength / Math.max(referenceLength, 1);

  return {
    warning: comparabilityWarning({ coverage, medianDeviation, touches }),
    coverage,
    reference,
    challenger,
    tickRate,
    courseLength,
    curve,
    traces,
    sections,
    touches,
    /** The worst sections, and the best, for shading and for the headline. */
    worst,
    best,
    /** Losses and gains together, biggest first. */
    highlights: [...worst, ...best].sort(
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
