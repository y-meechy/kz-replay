// A small canvas chart toolkit. Enough for line, area, bar and scatter plots on a
// shared x axis, and nothing more: eight bespoke renderers would be worse than one
// slightly general one, and a charting library would be heavier than the viewer.
//
// Every chart takes device pixel ratio into account and lays out from the canvas's
// CSS size, so they stay sharp and reflow with the panel.

const TEXT = "#8494a8";
const GRID = "rgba(148, 163, 184, 0.14)";
const AXIS = "rgba(148, 163, 184, 0.4)";

export const COLOURS = {
  reference: "#22d3ee",
  challenger: "#f59e0b",
  bad: "#fb7185",
  good: "#4ade80",
  neutral: "#94a3b8",
};

/** Finite numeric bounds without spreading an unbounded series into a call. */
export const finiteExtent = (values, valueOf = (value) => value) => {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const item of values) {
    const value = valueOf(item);
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    count += 1;
  }
  return { min, max, count };
};

const niceStep = (range, targetSteps = 4) => {
  const rough = range / targetSteps;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (magnitude * multiple >= rough) return magnitude * multiple;
  }
  return magnitude * 10;
};

/** Sets up the backing store and returns a plot rectangle in CSS pixels. */
const prepare = (canvas, padding) => {
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 140;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const context = canvas.getContext("2d");
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = "10px ui-monospace, Menlo, monospace";
  context.textBaseline = "middle";

  return {
    context,
    width,
    height,
    plot: {
      x: padding.left,
      y: padding.top,
      width: Math.max(1, width - padding.left - padding.right),
      height: Math.max(1, height - padding.top - padding.bottom),
    },
  };
};

const drawFrame = ({ context, plot }, { yMin, yMax, yFormat, xLabels }) => {
  const step = niceStep(yMax - yMin);
  const first = Math.ceil(yMin / step) * step;

  context.strokeStyle = GRID;
  context.lineWidth = 1;
  context.fillStyle = TEXT;
  context.textAlign = "right";

  for (let value = first; value <= yMax + 1e-9; value += step) {
    const y =
      plot.y + plot.height - ((value - yMin) / (yMax - yMin)) * plot.height;
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.strokeStyle = Math.abs(value) < 1e-9 ? AXIS : GRID;
    context.stroke();
    context.fillText(yFormat(value), plot.x - 6, y);
  }

  context.textAlign = "left";
  if (xLabels?.[0]) {
    context.fillText(xLabels[0], plot.x, plot.y + plot.height + 9);
  }
  if (xLabels?.[1]) {
    context.textAlign = "right";
    context.fillText(xLabels[1], plot.x + plot.width, plot.y + plot.height + 9);
  }
};

/**
 * Line chart with an optional filled band and highlighted x ranges.
 *
 * @param series   [{ values, colour, fillTo, width, dashed }]
 * @param x        x value per sample, shared by every series
 * @param highlights [{ from, to, colour }] in x units, drawn behind everything
 * @returns a scale for turning a click back into an x value, or null if nothing
 *          was drawn. Without this a chart is a picture; with it, it is clickable.
 */
export const drawLines = (
  canvas,
  {
    x,
    series,
    yFormat = (value) => value.toFixed(0),
    xLabels,
    highlights = [],
    padding = { top: 10, right: 8, bottom: 16, left: 42 },
    forceZero = false,
    playhead = null,
  },
) => {
  const view = prepare(canvas, padding);
  const { context, plot } = view;

  let yMin = Infinity;
  let yMax = -Infinity;
  let valueCount = 0;
  for (const line of series) {
    const extent = finiteExtent(line.values);
    if (extent.count === 0) continue;
    yMin = Math.min(yMin, extent.min);
    yMax = Math.max(yMax, extent.max);
    valueCount += extent.count;
  }
  if (valueCount === 0 || x.length < 2) return null;

  if (forceZero) {
    const peak = Math.max(Math.abs(yMin), Math.abs(yMax), 1e-6);
    yMin = -peak;
    yMax = peak;
  }
  if (yMax - yMin < 1e-6) {
    yMax += 1;
    yMin -= 1;
  }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;

  const xMin = x[0];
  const xMax = x.at(-1);
  const toX = (value) =>
    plot.x + ((value - xMin) / (xMax - xMin || 1)) * plot.width;
  const toY = (value) =>
    plot.y +
    plot.height -
    ((Math.min(Math.max(value, yMin), yMax) - yMin) / (yMax - yMin)) *
      plot.height;

  for (const band of highlights) {
    const left = toX(band.from);
    const right = toX(band.to);
    context.fillStyle = band.colour ?? "rgba(251, 113, 133, 0.16)";
    context.fillRect(left, plot.y, Math.max(1.5, right - left), plot.height);
  }

  drawFrame(view, { yMin, yMax, yFormat, xLabels });

  for (const line of series) {
    if (line.fillTo !== undefined) {
      context.beginPath();
      context.moveTo(toX(x[0]), toY(line.fillTo));
      line.values.forEach((value, index) =>
        context.lineTo(toX(x[index]), toY(value)),
      );
      context.lineTo(toX(x.at(-1)), toY(line.fillTo));
      context.closePath();
      context.fillStyle = line.fill ?? "rgba(34, 211, 238, 0.14)";
      context.fill();
    }

    context.beginPath();
    line.values.forEach((value, index) => {
      const px = toX(x[index]);
      const py = toY(value);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle = line.colour;
    context.lineWidth = line.width ?? 1.6;
    if (line.dashed) context.setLineDash([4, 3]);
    context.stroke();
    context.setLineDash([]);
  }

  if (playhead !== null) {
    const px = toX(playhead);
    context.beginPath();
    context.moveTo(px, plot.y);
    context.lineTo(px, plot.y + plot.height);
    context.strokeStyle = "rgba(226, 232, 240, 0.65)";
    context.lineWidth = 1;
    context.stroke();
  }

  return {
    /** Pixel offset inside the canvas (CSS pixels) back to an x value. */
    xFromPixel: (pixel) =>
      Math.min(
        Math.max(
          xMin + ((pixel - plot.x) / (plot.width || 1)) * (xMax - xMin),
          Math.min(xMin, xMax),
        ),
        Math.max(xMin, xMax),
      ),
    inside: (pixel) => pixel >= plot.x - 4 && pixel <= plot.x + plot.width + 4,
  };
};

/**
 * Grouped or stacked bars, one group per category.
 *
 * @param groups [{ label, bars: [{ value, colour }] }]
 * @param stacked when true, positive and negative bars stack from zero
 */
export const drawBars = (
  canvas,
  {
    groups,
    yFormat = (value) => value.toFixed(2),
    stacked = false,
    padding = { top: 10, right: 8, bottom: 16, left: 42 },
    xLabels,
  },
) => {
  const view = prepare(canvas, padding);
  const { context, plot } = view;
  if (groups.length === 0) return;

  let peak = 1e-6;
  for (const group of groups) {
    if (stacked) {
      let positive = 0;
      let negative = 0;
      for (const bar of group.bars) {
        if (bar.value > 0) positive += bar.value;
        if (bar.value < 0) negative += bar.value;
      }
      peak = Math.max(peak, Math.abs(positive), Math.abs(negative));
    } else {
      for (const bar of group.bars) {
        peak = Math.max(peak, Math.abs(bar.value));
      }
    }
  }
  const yMin = -peak * 1.1;
  const yMax = peak * 1.1;
  const toY = (value) =>
    plot.y + plot.height - ((value - yMin) / (yMax - yMin)) * plot.height;

  drawFrame(view, { yMin, yMax, yFormat, xLabels });

  const groupWidth = plot.width / groups.length;
  groups.forEach((group, index) => {
    const left = plot.x + index * groupWidth;
    if (stacked) {
      let up = 0;
      let down = 0;
      for (const bar of group.bars) {
        const base = bar.value >= 0 ? up : down;
        const top = base + bar.value;
        context.fillStyle = bar.colour;
        const y0 = toY(base);
        const y1 = toY(top);
        context.fillRect(
          left + groupWidth * 0.18,
          Math.min(y0, y1),
          groupWidth * 0.64,
          Math.max(1, Math.abs(y1 - y0)),
        );
        if (bar.value >= 0) up = top;
        else down = top;
      }
    } else {
      const barWidth = (groupWidth * 0.7) / group.bars.length;
      group.bars.forEach((bar, barIndex) => {
        const y0 = toY(0);
        const y1 = toY(bar.value);
        context.fillStyle = bar.colour;
        context.fillRect(
          left + groupWidth * 0.15 + barIndex * barWidth,
          Math.min(y0, y1),
          Math.max(1, barWidth - 1),
          Math.max(1, Math.abs(y1 - y0)),
        );
      });
    }
  });
};

/** Scatter plot, for per-jump data where x is a position on the course. */
export const drawScatter = (
  canvas,
  {
    sets,
    yFormat = (value) => value.toFixed(0),
    xLabels,
    padding = { top: 10, right: 8, bottom: 16, left: 42 },
  },
) => {
  const view = prepare(canvas, padding);
  const { context, plot } = view;

  let xMin = Infinity;
  let xMax = -Infinity;
  let rawYMin = Infinity;
  let rawYMax = -Infinity;
  let pointCount = 0;
  for (const set of sets) {
    const xExtent = finiteExtent(set.points, (point) => point.x);
    const yExtent = finiteExtent(set.points, (point) => point.y);
    if (xExtent.count === 0 || yExtent.count === 0) continue;
    xMin = Math.min(xMin, xExtent.min);
    xMax = Math.max(xMax, xExtent.max);
    rawYMin = Math.min(rawYMin, yExtent.min);
    rawYMax = Math.max(rawYMax, yExtent.max);
    pointCount += Math.min(xExtent.count, yExtent.count);
  }
  if (pointCount === 0) return;

  const yMin = rawYMin * 0.95;
  const yMax = rawYMax * 1.05;

  drawFrame(view, { yMin, yMax, yFormat, xLabels });

  const toX = (value) =>
    plot.x + ((value - xMin) / (xMax - xMin || 1)) * plot.width;
  const toY = (value) =>
    plot.y + plot.height - ((value - yMin) / (yMax - yMin || 1)) * plot.height;

  for (const set of sets) {
    context.fillStyle = set.colour;
    for (const point of set.points) {
      context.beginPath();
      context.arc(toX(point.x), toY(point.y), set.radius ?? 3, 0, Math.PI * 2);
      context.fill();
    }
  }
};
