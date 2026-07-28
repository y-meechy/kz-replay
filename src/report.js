// Text rendering for the run comparison. Pure formatting: all the numbers come
// from analysis.js and compare.js.

import { blameOf } from "./sections.js";

const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

/** A signed number, because in a comparison the sign is the whole point. */
const signed = (value, digits = 3) =>
  `${value > 0 ? "+" : value < 0 ? "" : " "}${value.toFixed(digits)}`;

const rule = (label = "", width = 78) => {
  if (!label) return "─".repeat(width);
  return `── ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}`;
};

/**
 * A bar drawn from the centre: left means the challenger is ahead, right behind.
 * Reading a column of these top to bottom shows where the run was won or lost.
 */
const deltaBar = (delta, scale, halfWidth = 22) => {
  const cells = Math.min(
    halfWidth,
    Math.round((Math.abs(delta) / scale) * halfWidth),
  );
  const behind = delta >= 0;
  const left = behind
    ? " ".repeat(halfWidth)
    : " ".repeat(halfWidth - cells) + "█".repeat(cells);
  const right = behind
    ? "█".repeat(cells) + " ".repeat(halfWidth - cells)
    : " ".repeat(halfWidth);
  return `${left}│${right}`;
};

const sideBySide = (rows, labelWidth, aWidth = 12) =>
  rows
    .map(([label, a, b, diff]) =>
      [
        padEnd(label, labelWidth),
        pad(a, aWidth),
        pad(b, aWidth),
        diff === undefined ? "" : pad(diff, 12),
      ].join(""),
    )
    .join("\n");

export const renderComparison = ({ reference, challenger, comparison }) => {
  const out = [];
  const refName = reference.run.player ?? "reference";
  const challengerName = challenger.run.player ?? "challenger";
  const labelWidth = 30;

  out.push("");
  out.push(rule("RUN COMPARISON"));
  out.push(
    `${reference.run.map} · ${reference.run.course} · ${reference.run.mode}` +
      `${reference.run.styles.length ? ` · styles: ${reference.run.styles.join(", ")}` : ""}`,
  );
  out.push("");
  out.push(
    `${padEnd("", labelWidth)}${pad(refName, 12)}${pad(challengerName, 12)}${pad("diff", 12)}`,
  );
  out.push(
    sideBySide(
      [
        [
          "time",
          `${reference.run.reportedTime.toFixed(4)}s`,
          `${challenger.run.reportedTime.toFixed(4)}s`,
          `${signed(comparison.finalDelta, 4)}s`,
        ],
        ["teleports", reference.run.teleports, challenger.run.teleports],
        ["ticks recorded", reference.timing.ticks, challenger.timing.ticks],
      ],
      labelWidth,
    ),
  );

  // --- where the time went -------------------------------------------------
  const { sections, touches } = comparison;
  const cut = sections.filter((section) => section.kind === "split").length;

  out.push("");
  out.push(rule("WHERE THE TIME WENT"));
  out.push(
    `Course split into ${sections.length} sections at places both runs touched the ` +
      `ground.`,
  );
  out.push(
    `${refName} touched down ${touches.reference} times, ${challengerName} ` +
      `${touches.challenger}, and ${touches.matched} of those were the same place` +
      (cut > 0
        ? `. ${cut} section(s) had no landing in them and were cut by distance instead.`
        : "."),
  );
  out.push(
    `Times are exact tick counts on each run's own clock, so the deltas add up to ` +
      `the final gap.`,
  );
  out.push(`Bar left of centre: ${challengerName} faster. Right: slower.`);
  out.push("");

  const scale = Math.max(
    ...sections.map((section) => Math.abs(section.delta)),
    0.01,
  );
  out.push(
    `${padEnd("sect", 6)}${pad("at", 8)}${pad(refName.slice(0, 8), 9)}${pad(challengerName.slice(0, 8), 9)}${pad("delta", 8)}${pad("cum", 8)}  chart`,
  );
  for (const section of sections) {
    out.push(
      padEnd(section.section, 6) +
        pad(`${section.referenceFromTime.toFixed(1)}s`, 8) +
        pad(section.referenceTime.toFixed(3), 9) +
        pad(section.challengerTime.toFixed(3), 9) +
        pad(signed(section.delta), 8) +
        pad(signed(section.cumulativeDelta), 8) +
        (section.kind === "split" ? " ~" : "  ") +
        deltaBar(section.delta, scale),
    );
  }

  const place = (section) =>
    `${pad(section.referenceFromTime.toFixed(1), 5)}→${pad(section.referenceToTime.toFixed(1), 5)}s on ${refName.slice(0, 8)}`;
  const blame = (section) =>
    blameOf(section) === "line"
      ? `mostly a longer line (${signed(section.routeCost)}s)`
      : `mostly less speed (${signed(section.speedCost)}s)`;

  for (const [heading, ranked] of [
    [`Biggest losses for ${challengerName}:`, comparison.worstSections],
    [`Biggest gains for ${challengerName}:`, comparison.bestSections],
  ]) {
    out.push("");
    out.push(heading);
    for (const section of ranked) {
      out.push(
        `  section ${pad(section.section, 2)}  ${signed(section.delta)}s   ` +
          `${place(section)}   ${blame(section)}`,
      );
    }
  }

  // --- side by side stats --------------------------------------------------
  const stat = (label, path, format = (v) => v) => {
    const a = path(reference);
    const b = path(challenger);
    if (typeof a !== "number" || typeof b !== "number") {
      return [label, format(a), format(b), undefined];
    }
    const difference = b - a;
    // Enough decimals to actually show the difference: a route efficiency gap of
    // 0.007 must not print as "-0.0".
    const magnitude = Math.abs(difference);
    const digits =
      magnitude === 0 ? 1 : magnitude < 0.1 ? 3 : magnitude < 10 ? 2 : 1;
    return [label, format(a), format(b), signed(difference, digits)];
  };

  out.push("");
  out.push(rule("SPEED"));
  out.push(
    sideBySide(
      [
        stat("top speed (u/s)", (r) => r.speed.max),
        stat("average speed (u/s)", (r) => r.speed.mean),
        stat("median speed (u/s)", (r) => r.speed.median),
        stat("slowest 10% below (u/s)", (r) => r.speed.p10),
        stat("fastest 10% above (u/s)", (r) => r.speed.p90),
        stat("speed at finish (u/s)", (r) => r.speed.atFinish),
        stat("time under 20 u/s (s)", (r) => r.speed.stillSeconds),
      ],
      labelWidth,
    ),
  );

  out.push("");
  out.push(rule("MOVEMENT AND ROUTE"));
  out.push(
    sideBySide(
      [
        stat("path length (units)", (r) => r.movement.pathLength3d),
        stat("horizontal path (units)", (r) => r.movement.pathLengthHorizontal),
        stat(
          "route efficiency",
          (r) => r.movement.routeEfficiency,
          (v) => v.toFixed(3),
        ),
        stat("climbed (units)", (r) => r.movement.climb),
        stat("descended (units)", (r) => r.movement.descent),
        stat("max fall speed (u/s)", (r) => r.movement.maxFallSpeed),
        stat("time in air (s)", (r) => r.movement.airSeconds),
        stat("time on ground (s)", (r) => r.movement.groundSeconds),
        stat("air share (%)", (r) => r.movement.airShare),
        stat("time ducking (s)", (r) => r.movement.duckSeconds),
      ],
      labelWidth,
    ),
  );

  out.push("");
  out.push(rule("JUMPS"));
  out.push(
    sideBySide(
      [
        stat("jumps", (r) => r.jumps.count),
        stat("bhops", (r) => r.jumps.bhops),
        stat("perfect bhops", (r) => r.jumps.perfs),
        stat("perf rate (%)", (r) => r.jumps.perfRate ?? 0),
        stat("longest airtime (s)", (r) => r.jumps.longestAirtimeSeconds),
        stat("longest jump (units)", (r) => r.jumps.maxDistance),
        stat("mean jump (units)", (r) => r.jumps.meanDistance),
        stat("best takeoff speed (u/s)", (r) => r.jumps.maxTakeoffSpeed),
        stat("mean takeoff speed (u/s)", (r) => r.jumps.meanTakeoffSpeed),
        stat("total strafes", (r) => r.jumps.totalStrafes),
        stat("strafes per jump", (r) => r.jumps.meanStrafesPerJump),
        stat("mean sync (%)", (r) => r.jumps.meanSync),
      ],
      labelWidth,
    ),
  );
  out.push(
    "A perf is a landing and takeoff on the same tick, which keeps all the speed.",
  );
  out.push(
    "Counted from ground contact, not the jump key: CS2 registers jumps between",
  );
  out.push("ticks, so the key never appears in the per-tick button mask.");

  out.push("");
  out.push(rule("AIM AND INPUT"));
  out.push(
    sideBySide(
      [
        stat("total yaw turned (deg)", (r) => r.aim.yawTurnedDegrees),
        stat("mean turn rate (deg/tick)", (r) => r.aim.meanTurnRate),
        stat("peak turn rate (deg/tick)", (r) => r.aim.maxTurnRate),
        stat("mean pitch (deg)", (r) => r.aim.meanPitch),
        stat("W held (s)", (r) => r.keys.forward.seconds),
        stat("S held (s)", (r) => r.keys.back.seconds),
        stat("A held (s)", (r) => r.keys.left.seconds),
        stat("D held (s)", (r) => r.keys.right.seconds),
        stat("duck held (s)", (r) => r.keys.duck.seconds),
        stat("walk held (s)", (r) => r.keys.walk.seconds),
      ],
      labelWidth,
    ),
  );

  out.push("");
  out.push(rule("HOW DIFFERENT ARE THE LINES"));
  out.push(
    `median gap between the two paths   ${comparison.line.medianDeviation} units`,
  );
  out.push(
    `90th percentile gap                ${comparison.line.p90Deviation} units`,
  );
  out.push(
    `largest gap                        ${comparison.line.maxDeviation} units`,
  );

  // --- jump by jump --------------------------------------------------------
  out.push("");
  out.push(rule("JUMP BY JUMP"));
  out.push(
    'Matched by position on the course. "—" means the other run had no jump there.',
  );
  out.push("");
  out.push(
    `${padEnd("#", 4)}${pad("dist", 7)}${pad("at", 8)}` +
      `${pad(`${refName.slice(0, 7)} jmp`, 12)}${pad("spd", 6)}${pad("air", 6)}` +
      `${pad(`${challengerName.slice(0, 7)} jmp`, 12)}${pad("spd", 6)}${pad("air", 6)}${pad("Δdist", 8)}`,
  );
  comparison.jumpPairs.forEach((pair, index) => {
    const a = pair.reference;
    const b = pair.challenger;
    out.push(
      padEnd(index + 1, 4) +
        pad(pair.distanceAlongCourse, 7) +
        pad(`${a.takeoffSecond.toFixed(2)}s`, 8) +
        pad(a.distance.toFixed(1), 12) +
        pad(a.takeoffSpeed, 6) +
        pad(a.airtimeSeconds.toFixed(2), 6) +
        pad(b ? b.distance.toFixed(1) : "—", 12) +
        pad(b ? b.takeoffSpeed : "—", 6) +
        pad(b ? b.airtimeSeconds.toFixed(2) : "—", 6) +
        pad(pair.distanceGap === null ? "—" : signed(pair.distanceGap, 1), 8),
    );
  });
  if (comparison.unmatchedChallengerJumps.length > 0) {
    out.push("");
    out.push(
      `${challengerName} made ${comparison.unmatchedChallengerJumps.length} extra jump(s) ` +
        `with no counterpart: ${comparison.unmatchedChallengerJumps
          .map((jump) => `${jump.takeoffSecond.toFixed(2)}s`)
          .join(", ")}`,
    );
  }

  out.push("");
  return out.join("\n");
};
