// Everything measurable about a single run, derived from its tick data.
//
// This works on the full parsed replay rather than the compact .kztrack, because
// the track drops fields the browser does not draw (button masks, exact velocity,
// entity flags) and those are exactly what the interesting numbers come from.
//
// Terms used below, as KZ players use them:
//   takeoff / landing  leaving and touching the ground
//   airtime            ticks spent off the ground between the two
//   strafe             one left-or-right air movement input while turning
//   sync               share of airborne ticks where the turn direction matches the
//                      strafe key, which is what actually gains speed in the air
//   perf               landing and jumping on the same tick, keeping all speed

import { FL_ONGROUND } from "./ticks.js";

// Button bits, from cs2kz-metamod/src/sdk/datatypes.h.
export const IN_ATTACK = 0x1;
export const IN_JUMP = 0x2;
export const IN_DUCK = 0x4;
export const IN_FORWARD = 0x8;
export const IN_BACK = 0x10;
export const IN_MOVELEFT = 0x200;
export const IN_MOVERIGHT = 0x400;
export const IN_SPEED = 0x10000;

const TICK_RATE = 64;

/** A run is "standing still" below this, for counting dead time. */
const STILL_SPEED = 20;

/** Air speed only grows while turning; below this the tick is not a real strafe. */
const MIN_TURN_RATE = 0.05; // degrees per tick

const quantile = (sorted, fraction) =>
  sorted.length === 0
    ? 0
    : sorted[
        Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))
      ];

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const extrema = (values) => {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return values.length === 0 ? { min: 0, max: 0 } : { min, max };
};

const maximum = (values) => {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
};

/** Shortest signed angle from a to b, so 179 -> -179 is +2 and not -358. */
const angleDelta = (a, b) => {
  let delta = b - a;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
};

/**
 * Analyse one parsed replay.
 *
 * @param replay the result of parseReplay()
 * @returns a plain object of stats, safe to JSON.stringify
 */
export const analyseRun = (replay) => {
  const { header, ticks, bounds, events } = replay;
  const from = bounds.startIndex;
  const to = bounds.endIndex;
  const tickIndices =
    bounds.tickIndices ??
    Int32Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const n = tickIndices.length;

  const at = (i) => tickIndices[i];
  const pos = (i, axis) => ticks.origin[at(i) * 3 + axis];
  const vel = (i, axis) => ticks.velocity[at(i) * 3 + axis];
  const speedAt = (i) => Math.hypot(vel(i, 0), vel(i, 1));
  const onGroundAt = (i) => (ticks.entityFlags[at(i)] & FL_ONGROUND) !== 0;
  const buttonsAt = (i) => ticks.buttons[at(i)];

  // --- per tick walk --------------------------------------------------------
  const speeds = [];
  let pathHorizontal = 0;
  let path3d = 0;
  let climb = 0;
  let descent = 0;
  let groundTicks = 0;
  let airTicks = 0;
  let stillTicks = 0;
  let duckTicks = 0;
  let yawTurned = 0;
  let maxTurnRate = 0;
  let maxFallSpeed = 0;
  const keyTicks = {
    forward: 0,
    back: 0,
    left: 0,
    right: 0,
    jump: 0,
    duck: 0,
    walk: 0,
  };
  const pitches = [];
  // Cumulative distance is the spine of the comparison: two runs are compared at
  // the same point on the course, never at the same moment in time.
  const cumulative = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const speed = speedAt(i);
    speeds.push(speed);
    pitches.push(ticks.pitch[at(i)]);

    if (speed < STILL_SPEED) stillTicks += 1;
    if (onGroundAt(i)) groundTicks += 1;
    else airTicks += 1;
    if (ticks.duckAmount[at(i)] > 0.5) duckTicks += 1;
    maxFallSpeed = Math.min(maxFallSpeed, vel(i, 2));

    const buttons = buttonsAt(i);
    if (buttons & IN_FORWARD) keyTicks.forward += 1;
    if (buttons & IN_BACK) keyTicks.back += 1;
    if (buttons & IN_MOVELEFT) keyTicks.left += 1;
    if (buttons & IN_MOVERIGHT) keyTicks.right += 1;
    if (buttons & IN_JUMP) keyTicks.jump += 1;
    if (buttons & IN_DUCK) keyTicks.duck += 1;
    if (buttons & IN_SPEED) keyTicks.walk += 1;

    if (i > 0) {
      const dx = pos(i, 0) - pos(i - 1, 0);
      const dy = pos(i, 1) - pos(i - 1, 1);
      const dz = pos(i, 2) - pos(i - 1, 2);
      const flat = Math.hypot(dx, dy);
      pathHorizontal += flat;
      path3d += Math.hypot(flat, dz);
      if (dz > 0) climb += dz;
      else descent -= dz;

      const turn = Math.abs(angleDelta(ticks.yaw[at(i - 1)], ticks.yaw[at(i)]));
      yawTurned += turn;
      maxTurnRate = Math.max(maxTurnRate, turn);

      cumulative[i] = cumulative[i - 1] + Math.hypot(flat, dz);
    }
  }

  // --- jumps ---------------------------------------------------------------
  const jumps = [];
  let lastLandingTick = null;
  let open = null;

  for (let i = 1; i < n; i++) {
    const wasOnGround = onGroundAt(i - 1);
    const isOnGround = onGroundAt(i);

    if (wasOnGround && !isOnGround) {
      open = {
        takeoffTick: i,
        takeoffSpeed: speedAt(i - 1),
        takeoffZ: pos(i, 2),
        peakZ: pos(i, 2),
        groundTicksBefore:
          lastLandingTick === null ? null : i - lastLandingTick,
        strafes: 0,
        syncTicks: 0,
        airInputTicks: 0,
        maxSpeed: speedAt(i),
      };
    } else if (!wasOnGround && isOnGround && open) {
      const airtime = i - open.takeoffTick;
      const dx = pos(i, 0) - pos(open.takeoffTick, 0);
      const dy = pos(i, 1) - pos(open.takeoffTick, 1);
      jumps.push({
        takeoffTick: open.takeoffTick,
        takeoffSecond: +(open.takeoffTick / TICK_RATE).toFixed(3),
        landingTick: i,
        airtimeTicks: airtime,
        airtimeSeconds: +(airtime / TICK_RATE).toFixed(3),
        distance: +Math.hypot(dx, dy).toFixed(1),
        heightGain: +(open.peakZ - open.takeoffZ).toFixed(1),
        takeoffSpeed: Math.round(open.takeoffSpeed),
        landingSpeed: Math.round(speedAt(i)),
        maxSpeed: Math.round(open.maxSpeed),
        speedGain: Math.round(speedAt(i) - open.takeoffSpeed),
        strafes: open.strafes,
        sync:
          open.airInputTicks === 0
            ? null
            : +((open.syncTicks / open.airInputTicks) * 100).toFixed(1),
        // A perf keeps every unit of speed; one or more ground ticks bleeds it.
        groundTicksBefore: open.groundTicksBefore,
        perf: open.groundTicksBefore !== null && open.groundTicksBefore <= 1,
        distanceAlongCourse: Math.round(cumulative[open.takeoffTick]),
      });
      lastLandingTick = i;
      open = null;
    }

    // Air statistics belong to the jump that is currently open.
    if (open && !isOnGround && i > open.takeoffTick) {
      const turn = angleDelta(ticks.yaw[at(i - 1)], ticks.yaw[at(i)]);
      const buttons = buttonsAt(i);
      const strafingLeft = (buttons & IN_MOVELEFT) !== 0;
      const strafingRight = (buttons & IN_MOVERIGHT) !== 0;

      if (Math.abs(turn) > MIN_TURN_RATE && (strafingLeft || strafingRight)) {
        open.airInputTicks += 1;
        // Turning left is a rising yaw in Source, and gains speed only with the
        // left strafe key. Same idea mirrored for the right.
        if ((turn > 0 && strafingLeft) || (turn < 0 && strafingRight)) {
          open.syncTicks += 1;
        }
      }

      const previousTurn = angleDelta(
        ticks.yaw[at(i - 2)] ?? ticks.yaw[at(i - 1)],
        ticks.yaw[at(i - 1)],
      );
      if (
        Math.abs(turn) > MIN_TURN_RATE &&
        Math.sign(turn) !== Math.sign(previousTurn)
      ) {
        open.strafes += 1;
      }

      open.peakZ = Math.max(open.peakZ, pos(i, 2));
      open.maxSpeed = Math.max(open.maxSpeed, speedAt(i));
    }
  }

  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const bhops = jumps.filter((jump) => jump.groundTicksBefore !== null);
  const perfs = bhops.filter((jump) => jump.perf);
  const speedRange = extrema(speeds);
  const pitchRange = extrema(pitches);

  const netDisplacement = Math.hypot(
    pos(n - 1, 0) - pos(0, 0),
    pos(n - 1, 1) - pos(0, 1),
  );

  return {
    run: {
      player: header.player?.name,
      steamId64: header.player?.steamId64,
      map: header.map?.name,
      course: header.run?.courseName,
      mode: header.run?.mode?.name,
      styles: (header.run?.styles ?? [])
        .map((style) => style.name)
        .filter(Boolean),
      reportedTime: header.run?.time,
      teleports: header.run?.teleports ?? 0,
      pluginVersion: header.pluginVersion,
      recordedAt: header.timestamp ? Number(header.timestamp) : null,
      formatVersion: header.version,
    },
    timing: {
      tickRate: TICK_RATE,
      ticks: n,
      durationSeconds: +((n - 1) / TICK_RATE).toFixed(4),
      splits: bounds.splits,
    },
    speed: {
      max: Math.round(speedRange.max),
      mean: Math.round(mean(speeds)),
      median: Math.round(quantile(sortedSpeeds, 0.5)),
      p10: Math.round(quantile(sortedSpeeds, 0.1)),
      p90: Math.round(quantile(sortedSpeeds, 0.9)),
      atStart: Math.round(speeds[0]),
      atFinish: Math.round(speeds[n - 1]),
      stillSeconds: +(stillTicks / TICK_RATE).toFixed(2),
    },
    movement: {
      pathLengthHorizontal: Math.round(pathHorizontal),
      pathLength3d: Math.round(path3d),
      netDisplacement: Math.round(netDisplacement),
      // 1.0 would be a straight line from start to finish.
      routeEfficiency: +(netDisplacement / Math.max(pathHorizontal, 1)).toFixed(
        3,
      ),
      climb: Math.round(climb),
      descent: Math.round(descent),
      maxFallSpeed: Math.round(Math.abs(maxFallSpeed)),
      groundSeconds: +(groundTicks / TICK_RATE).toFixed(2),
      airSeconds: +(airTicks / TICK_RATE).toFixed(2),
      airShare: +((airTicks / n) * 100).toFixed(1),
      duckSeconds: +(duckTicks / TICK_RATE).toFixed(2),
    },
    jumps: {
      count: jumps.length,
      bhops: bhops.length,
      perfs: perfs.length,
      perfRate:
        bhops.length === 0
          ? null
          : +((perfs.length / bhops.length) * 100).toFixed(1),
      totalAirSeconds: +(
        jumps.reduce((sum, j) => sum + j.airtimeTicks, 0) / TICK_RATE
      ).toFixed(2),
      longestAirtimeSeconds: maximum(jumps.map((j) => j.airtimeSeconds)),
      maxDistance: maximum(jumps.map((j) => j.distance)),
      meanDistance: +mean(jumps.map((j) => j.distance)).toFixed(1),
      maxTakeoffSpeed: maximum(jumps.map((j) => j.takeoffSpeed)),
      meanTakeoffSpeed: Math.round(mean(jumps.map((j) => j.takeoffSpeed))),
      meanStrafesPerJump: +mean(jumps.map((j) => j.strafes)).toFixed(1),
      totalStrafes: jumps.reduce((sum, j) => sum + j.strafes, 0),
      meanSync: +mean(
        jumps.map((j) => j.sync).filter((v) => v !== null),
      ).toFixed(1),
      list: jumps,
    },
    aim: {
      yawTurnedDegrees: Math.round(yawTurned),
      meanTurnRate: +(yawTurned / Math.max(n - 1, 1)).toFixed(2),
      maxTurnRate: +maxTurnRate.toFixed(2),
      meanPitch: +mean(pitches).toFixed(1),
      minPitch: +pitchRange.min.toFixed(1),
      maxPitch: +pitchRange.max.toFixed(1),
    },
    keys: Object.fromEntries(
      Object.entries(keyTicks).map(([key, count]) => [
        key,
        {
          seconds: +(count / TICK_RATE).toFixed(2),
          share: +((count / n) * 100).toFixed(1),
        },
      ]),
    ),
    events: {
      teleports: events.filter((event) => event.kind === "teleport").length,
      modeChanges: events.filter((event) => event.kind === "modeChange").length,
    },
    // Internal: the comparison needs these, they are not part of the report.
    _series: { cumulative, speeds, from, to, ticks, tickIndices },
  };
};
