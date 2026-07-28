// The full analysis: one chart, the section table, and every number side by side.
//
// It used to be eight charts. Seven of them were interesting once and then never
// looked at again, because only one of them answers the question you actually have —
// "where did the time go?" — and the others just make that one smaller. So: the time
// gap along the course, at full width, and you can click anywhere on it to jump the
// replay to that point.
//
// Under it, the section table: the course cut at places both runs touched the ground,
// with the time each run spent between them. The chart shows the shape of the gap,
// the table says where it went in numbers that add up. The shaded bands are the worst
// and best sections, because knowing where to click is most of the value.

import { blameOf } from "../../src/sections.js";
import { COLOURS, drawLines } from "./charts.js";
import { formatDelta } from "./format.js";

const plain = (value, digits = 2) => value.toFixed(digits);

/** The bigger half of a section's route/speed split, named and signed. */
const mostly = (section) =>
  blameOf(section) === "line"
    ? `line ${formatDelta(section.routeCost)}`
    : `speed ${formatDelta(section.speedCost)}`;

/**
 * The biggest sections as shaded x ranges: red where time went, green where it came
 * back. Only the top few of each — shading a dozen bands over a short course leaves
 * the chart unreadable, which defeats the point of marking anything.
 */
const sectionBands = (insights) => [
  ...insights.worst.map((section) => ({
    from: section.fromDistance,
    to: section.toDistance,
    colour: "rgba(251, 113, 133, 0.22)",
  })),
  ...insights.best.map((section) => ({
    from: section.fromDistance,
    to: section.toDistance,
    colour: "rgba(74, 222, 128, 0.18)",
  })),
];

const drawDelta = (canvas, insights, playhead) =>
  drawLines(canvas, {
    x: insights.traces.distance,
    highlights: sectionBands(insights),
    forceZero: true,
    playhead,
    padding: { top: 12, right: 12, bottom: 20, left: 52 },
    yFormat: (value) =>
      `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`,
    xLabels: ["start", "finish"],
    series: [
      {
        values: insights.traces.delta,
        colour: COLOURS.bad,
        fillTo: 0,
        fill: "rgba(251, 113, 133, 0.16)",
        width: 1.8,
      },
    ],
  });

const summaryRows = (insights) => {
  const a = insights.reference.analysis;
  const b = insights.challenger.analysis;
  return [
    [
      "Finish time",
      `${a.run.reportedTime.toFixed(4)}s`,
      `${b.run.reportedTime.toFixed(4)}s`,
    ],
    ["Top speed", `${a.speed.max} u/s`, `${b.speed.max} u/s`],
    ["Average speed", `${a.speed.mean} u/s`, `${b.speed.mean} u/s`],
    ["Slowest 10% below", `${a.speed.p10} u/s`, `${b.speed.p10} u/s`],
    [
      "Time under 20 u/s",
      `${a.speed.stillSeconds}s`,
      `${b.speed.stillSeconds}s`,
    ],
    [
      "Path travelled",
      `${a.movement.pathLength3d} u`,
      `${b.movement.pathLength3d} u`,
    ],
    ["Time in air", `${a.movement.airSeconds}s`, `${b.movement.airSeconds}s`],
    [
      "Time on ground",
      `${a.movement.groundSeconds}s`,
      `${b.movement.groundSeconds}s`,
    ],
    ["Ducking", `${a.movement.duckSeconds}s`, `${b.movement.duckSeconds}s`],
    ["Jumps", a.jumps.count, b.jumps.count],
    [
      "Perfect bhops",
      `${a.jumps.perfs} of ${a.jumps.bhops} (${a.jumps.perfRate ?? 0}%)`,
      `${b.jumps.perfs} of ${b.jumps.bhops} (${b.jumps.perfRate ?? 0}%)`,
    ],
    ["Mean sync", `${a.jumps.meanSync}%`, `${b.jumps.meanSync}%`],
    [
      "Strafes per jump",
      a.jumps.meanStrafesPerJump,
      b.jumps.meanStrafesPerJump,
    ],
    ["Longest jump", `${a.jumps.maxDistance} u`, `${b.jumps.maxDistance} u`],
    [
      "Total yaw turned",
      `${a.aim.yawTurnedDegrees}°`,
      `${b.aim.yawTurnedDegrees}°`,
    ],
    [
      "Peak turn rate",
      `${a.aim.maxTurnRate}°/tick`,
      `${b.aim.maxTurnRate}°/tick`,
    ],
  ];
};

/**
 * @param onJumpDistance called with a course distance when the chart is clicked.
 *        Distance, not time: the chart's x axis is distance along the course, and
 *        the caller is the only thing that knows how to turn that into a tick.
 */
export const createAnalysisPanel = ({
  overlay,
  openButton,
  onJumpDistance,
  deltaAtDistance,
  timeAtDistance,
}) => {
  let insights = null;
  let playhead = 0;
  let open = false;
  let canvas = null;
  let scale = null;
  let readout = null;

  /**
   * The section table: one row per stretch of course between two shared landings.
   *
   * Every row is clickable, because a number is only useful if you can go and watch
   * the thing it is describing. A row hands the caller its start distance rather than
   * a time, so the seek lands on that place on the course whichever run is on screen.
   */
  const buildSectionTable = () => {
    const referenceName = insights.reference.meta.player?.name ?? "reference";
    const challengerName =
      insights.challenger.meta.player?.name ?? "challenger";
    const onLanding = insights.sections.filter(
      (section) => section.kind === "landing",
    ).length;

    const card = document.createElement("section");
    card.className = "card card--wide";
    const head = document.createElement("div");
    head.className = "card__head";
    const title = document.createElement("span");
    title.className = "card__title";
    title.textContent = "Section by section";
    const hint = document.createElement("span");
    hint.className = "card__hint";
    // Count the sections, not the matched touchdowns: most touchdowns are too close
    // together to be worth a row of their own, so quoting that number next to a
    // shorter table just looks like an off-by-a-lot.
    hint.textContent =
      `${onLanding} of ${insights.sections.length} sections end where both runs ` +
      "touched down · click a row to watch it";
    head.append(title, hint);

    const table = document.createElement("table");
    table.className = "table table--rows";
    const headRow = document.createElement("tr");
    for (const [label, align, explain] of [
      ["#", "", null],
      // One clock has to own this column, and it is the reference's. Said out loud in
      // the tooltip, because "at 25.1s" is a different moment in each run.
      ["At", "", `where the section starts on ${referenceName}'s clock`],
      [referenceName, "right", "seconds spent in the section"],
      [challengerName, "right", "seconds spent in the section"],
      ["Gap", "right", "the difference, positive means time lost"],
      ["Total", "right", "the gap so far, adding up to the finishing gap"],
      ["Mostly", "", "which of a longer line or less speed did the damage"],
    ]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      if (align) cell.style.textAlign = align;
      if (explain) cell.title = explain;
      headRow.append(cell);
    }
    const thead = document.createElement("thead");
    thead.append(headRow);
    const body = document.createElement("tbody");

    // Two ticks. Section times are exact tick counts, so anything smaller is a
    // rounding difference nobody could feel, and the point of exact counts is being
    // able to say that instead of dressing it up as a mistake.
    const floor = 2 / insights.tickRate;

    for (const section of insights.sections) {
      const row = document.createElement("tr");
      const notable = Math.abs(section.delta) >= floor;
      const cells = [
        [section.section, "", null],
        [`${plain(section.referenceFromTime, 1)}s`, "", null],
        [plain(section.referenceTime, 3), "right", null],
        [plain(section.challengerTime, 3), "right", null],
        // Only the gap columns get coloured: colouring the raw times would suggest
        // one of them is wrong, and neither is.
        [formatDelta(section.delta), "right", notable ? section.delta : null],
        [
          formatDelta(section.cumulativeDelta),
          "right",
          Math.abs(section.cumulativeDelta) >= floor
            ? section.cumulativeDelta
            : null,
        ],
        // Nothing to blame a difference on when there is no difference: below the
        // floor both halves are rounding, and naming a winner between them tells a
        // story about a tenth of a tick.
        [notable ? mostly(section) : "—", "", null],
      ];
      for (const [value, align, signal] of cells) {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (align) cell.style.textAlign = align;
        if (signal !== null) cell.className = signal > 0 ? "bad" : "good";
        row.append(cell);
      }
      if (section.kind === "split") {
        row.title =
          "no shared landing in this stretch, so it was cut by distance instead";
      }
      row.addEventListener("click", () => {
        onJumpDistance?.(section.fromDistance);
        panel.close();
      });
      body.append(row);
    }

    table.append(thead, body);
    card.append(head, table);
    return card;
  };

  const buildOverlay = () => {
    overlay.innerHTML = "";
    const reference = insights.reference.meta;
    const challenger = insights.challenger.meta;

    const header = document.createElement("header");
    header.className = "analysis__header";
    const heading = document.createElement("div");
    const title = document.createElement("div");
    title.className = "analysis__title";
    title.textContent = `${reference.map} · ${reference.course}`;
    const subtitle = document.createElement("div");
    subtitle.className = "analysis__subtitle";
    const referenceSwatch = document.createElement("span");
    referenceSwatch.className = "swatch swatch--you";
    const challengerSwatch = document.createElement("span");
    challengerSwatch.className = "swatch swatch--rival";
    subtitle.append(
      referenceSwatch,
      document.createTextNode(
        `${reference.player?.name ?? "?"} ${reference.reportedTime.toFixed(3)}s `,
      ),
      challengerSwatch,
      document.createTextNode(
        `${challenger.player?.name ?? "?"} ${challenger.reportedTime.toFixed(3)}s`,
      ),
    );
    heading.append(title, subtitle);
    header.append(heading);
    const close = document.createElement("button");
    close.className = "button";
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => panel.close());
    header.append(close);
    overlay.append(header);

    if (insights.warning) {
      const warning = document.createElement("div");
      warning.className = "analysis__warning";
      warning.textContent = `Careful: ${insights.warning}.`;
      overlay.append(warning);
    }

    // Headline numbers. Sign convention throughout: positive is time the challenger
    // gave away.
    const worst = insights.worst[0];
    const headline = document.createElement("div");
    headline.className = "analysis__headline";
    headline.innerHTML = [
      ["Final gap", formatDelta(insights.finalDelta)],
      ["From a longer line", formatDelta(insights.totals.route)],
      ["From less speed", formatDelta(insights.totals.speed)],
      [
        "Worst section",
        worst
          ? `${formatDelta(worst.secondsLost)} at ${plain(worst.referenceTime)}s`
          : "too close to call",
      ],
      ["Lines apart (median)", `${insights.line.medianDeviation.toFixed(0)} u`],
    ]
      .map(
        ([label, value]) =>
          `<div class="headline"><span class="headline__label">${label}</span><span class="headline__value">${value}</span></div>`,
      )
      .join("");
    overlay.append(headline);

    const card = document.createElement("section");
    card.className = "card card--chart";
    card.innerHTML = `
      <div class="card__head">
        <span class="card__title">Time gap along the course</span>
        <span class="card__hint">click anywhere to jump the replay there · red bands lost the most time, green won it back</span>
      </div>`;
    canvas = document.createElement("canvas");
    canvas.className = "card__canvas card__canvas--tall";
    readout = document.createElement("div");
    readout.className = "card__readout";
    readout.textContent = "above the line the rival is behind, below it ahead";
    card.append(canvas, readout);
    overlay.append(card);
    wireCanvas();

    overlay.append(buildSectionTable());

    const summary = document.createElement("section");
    summary.className = "card card--wide";
    const summaryHead = document.createElement("div");
    summaryHead.className = "card__head";
    const summaryTitle = document.createElement("span");
    summaryTitle.className = "card__title";
    summaryTitle.textContent = "Side by side";
    summaryHead.append(summaryTitle);

    const table = document.createElement("table");
    table.className = "table";
    const tableHead = document.createElement("thead");
    const headingRow = document.createElement("tr");
    for (const value of [
      "",
      reference.player?.name ?? "reference",
      challenger.player?.name ?? "challenger",
    ]) {
      const cell = document.createElement("th");
      cell.textContent = value;
      headingRow.append(cell);
    }
    tableHead.append(headingRow);

    const tableBody = document.createElement("tbody");
    for (const row of summaryRows(insights)) {
      const tableRow = document.createElement("tr");
      for (const value of row) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tableRow.append(cell);
      }
      tableBody.append(tableRow);
    }
    table.append(tableHead, tableBody);
    summary.append(summaryHead, table);
    overlay.append(summary);
  };

  /** Distance under the pointer, or null if the pointer is off the plot. */
  const distanceAt = (event) => {
    if (!scale) return null;
    const pixel = event.clientX - canvas.getBoundingClientRect().left;
    return scale.inside(pixel) ? scale.xFromPixel(pixel) : null;
  };

  const wireCanvas = () => {
    canvas.addEventListener("mousemove", (event) => {
      const distance = distanceAt(event);
      if (distance === null) return;
      // No redraw on hover: the numbers are enough, and redrawing the whole chart
      // on every mouse move for a crosshair is not a trade worth making.
      readout.textContent =
        `at ${plain(timeAtDistance(distance))}s · ` +
        `gap ${formatDelta(deltaAtDistance(distance))} · click to jump`;
    });
    canvas.addEventListener("mouseleave", () => {
      readout.textContent =
        "above the line the rival is behind, below it ahead";
    });
    canvas.addEventListener("click", (event) => {
      const distance = distanceAt(event);
      if (distance === null) return;
      onJumpDistance?.(distance);
      panel.close();
    });
  };

  const draw = () => {
    if (!insights || !canvas) return;
    scale = drawDelta(canvas, insights, playhead);
  };

  const panel = {
    setInsights(next) {
      insights = next;
      openButton.disabled = !insights;
      if (!insights) {
        panel.close();
        return;
      }
      if (open) {
        buildOverlay();
        draw();
      }
    },
    setPlayheadDistance(distance) {
      playhead = distance;
      if (open) draw();
    },
    refresh() {
      if (!open) return;
      buildOverlay();
      draw();
    },
    open() {
      if (!insights) return;
      open = true;
      overlay.hidden = false;
      buildOverlay();
      draw();
    },
    close() {
      open = false;
      overlay.hidden = true;
    },
    toggle() {
      if (open) panel.close();
      else panel.open();
    },
    get isOpen() {
      return open;
    },
  };

  openButton.addEventListener("click", () => panel.toggle());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) panel.close();
  });
  window.addEventListener("resize", () => {
    if (open) draw();
  });

  openButton.disabled = true;
  return panel;
};
