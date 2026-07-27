// The full analysis: one chart, and every number side by side.
//
// It used to be eight charts. Seven of them were interesting once and then never
// looked at again, because only one of them answers the question you actually have —
// "where did the time go?" — and the others just make that one smaller. So: the time
// gap along the course, at full width, and you can click anywhere on it to jump the
// replay to that point.
//
// The shaded bands are still the biggest swings, red where time was lost and green
// where it came back, because knowing where to click is most of the value.

import { COLOURS, drawLines } from "./charts.js";
import { formatDelta } from "./format.js";

const plain = (value, digits = 2) => value.toFixed(digits);

/** Loss moments, worst first. `moments` itself is in course order. */
const byWorst = (insights) =>
  [...insights.moments].sort((a, b) => b.secondsLost - a.secondsLost);

/**
 * The biggest swings as shaded x ranges: red where time went, green where it came
 * back. Only the top few of each — shading a dozen bands over a short course leaves
 * the chart unreadable, which defeats the point of marking anything.
 */
const swingBands = (insights, perSide = 3) => [
  ...byWorst(insights)
    .slice(0, perSide)
    .map((moment) => ({
      from: moment.fromDistance,
      to: moment.toDistance,
      colour: "rgba(251, 113, 133, 0.22)",
    })),
  ...[...insights.gains]
    .sort((a, b) => a.secondsLost - b.secondsLost)
    .slice(0, perSide)
    .map((moment) => ({
      from: moment.fromDistance,
      to: moment.toDistance,
      colour: "rgba(74, 222, 128, 0.18)",
    })),
];

const drawDelta = (canvas, insights, playhead) =>
  drawLines(canvas, {
    x: insights.traces.distance,
    highlights: swingBands(insights),
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
    const worst = byWorst(insights)[0];
    const headline = document.createElement("div");
    headline.className = "analysis__headline";
    headline.innerHTML = [
      ["Final gap", formatDelta(insights.finalDelta)],
      ["From a longer line", formatDelta(insights.totals.route)],
      ["From less speed", formatDelta(insights.totals.speed)],
      [
        "Worst single moment",
        worst
          ? `${formatDelta(worst.secondsLost)} at ${plain(worst.referenceTime)}s`
          : "—",
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
