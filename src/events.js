// Decode the Events section.
//
// `RpEvent` is a trivial fixed-size struct (static_assert in kz_replay.h), so the
// section is just an array and the stride is uncompressedSize / elementCount.
// We only care about timer events and teleports; mode and style changes carry a
// 164-byte name blob we skip over.
//
//   u32 type            RpEventType
//   u32 serverTick
//   union {
//     timer    { u32 subType, i32 index, f32 time }
//     teleport { u8 hasOrigin, u8 hasAngles, u8 hasVelocity, pad, f32 origin[3], ... }
//     ...
//   }

const EVENT_TIMER = 0;
const EVENT_MODE_CHANGE = 1;
const EVENT_STYLE_CHANGE = 2;
const EVENT_TELEPORT = 3;

export const TIMER_EVENT = {
  0: "start",
  1: "end",
  2: "stop",
  3: "pause",
  4: "resume",
  5: "split",
  6: "cpz",
  7: "stage",
};

export const decodeEvents = (inflated, elementCount) => {
  if (elementCount === 0) {
    return [];
  }

  const stride = Math.floor(inflated.length / elementCount);
  const view = new DataView(
    inflated.buffer,
    inflated.byteOffset,
    inflated.byteLength,
  );
  const events = [];

  for (let i = 0; i < elementCount; i++) {
    const base = i * stride;
    const type = view.getUint32(base, true);
    const serverTick = view.getUint32(base + 4, true);

    switch (type) {
      case EVENT_TIMER:
        events.push({
          kind: "timer",
          serverTick,
          event: TIMER_EVENT[view.getUint32(base + 8, true)] ?? "unknown",
          index: view.getInt32(base + 12, true),
          time: view.getFloat32(base + 16, true),
        });
        break;
      case EVENT_TELEPORT:
        events.push({ kind: "teleport", serverTick });
        break;
      case EVENT_MODE_CHANGE:
      case EVENT_STYLE_CHANGE:
        events.push({
          kind: type === EVENT_MODE_CHANGE ? "modeChange" : "styleChange",
          serverTick,
        });
        break;
      default:
        events.push({ kind: "unknown", serverTick, type });
    }
  }

  return events;
};

/**
 * Find the tick range the timer was actually running for.
 *
 * Falls back to the whole replay when the events are missing or unusable, because
 * a viewer that shows too much is better than one that shows nothing.
 */
export const runBounds = (events, ticks) => {
  const timer = events
    .map((event, eventIndex) => ({ ...event, eventIndex }))
    .filter((event) => event.kind === "timer");

  // A replay usually holds more than one attempt: the player starts, dies or
  // resets, starts again, and only the last attempt is the run that was submitted.
  // So the run is the stretch from the last start BEFORE the finish, to the finish.
  // Taking the first start instead silently includes the failed attempts, which
  // inflates the duration and every statistic derived from it.
  const end = [...timer].reverse().find((event) => event.event === "end");
  const starts = timer.filter(
    (event) =>
      event.event === "start" &&
      (end === undefined || event.serverTick <= end.serverTick),
  );
  const start = starts.at(-1);

  const firstTick = ticks.serverTick[0];
  const lastTick = ticks.serverTick[ticks.count - 1];

  const lowerBound = (serverTick) => {
    let low = 0;
    let high = ticks.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ticks.serverTick[middle] < serverTick) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const toIndex = (serverTick, fallback) => {
    if (serverTick === undefined) return fallback;
    const index = lowerBound(serverTick);
    return index < ticks.count ? index : fallback;
  };

  const startIndex = toIndex(start?.serverTick, 0);
  const endIndex = toIndex(end?.serverTick, ticks.count - 1);

  // Timer time excludes [pause, resume). Keep one shared ordered source-index
  // selection so tracks, analysis and comparison all use the same clock.
  const attemptEvents =
    start && end
      ? timer.filter(
          (event) =>
            event.eventIndex >= start.eventIndex &&
            event.eventIndex <= end.eventIndex,
        )
      : [];
  const pauses = [];
  let pauseStart;
  for (const event of attemptEvents) {
    if (event.event === "start") {
      pauseStart = undefined;
    } else if (event.event === "pause" && pauseStart === undefined) {
      pauseStart = event.serverTick;
    } else if (event.event === "resume" && pauseStart !== undefined) {
      if (event.serverTick > pauseStart) {
        pauses.push([pauseStart, event.serverTick]);
      }
      pauseStart = undefined;
    } else if (event.event === "end" && pauseStart !== undefined) {
      pauses.push([pauseStart, event.serverTick]);
      pauseStart = undefined;
    }
  }

  const selected = [];
  let pauseIndex = 0;
  for (let index = startIndex; index <= endIndex; index++) {
    const serverTick = ticks.serverTick[index];
    while (pauseIndex < pauses.length && serverTick >= pauses[pauseIndex][1]) {
      pauseIndex += 1;
    }
    const pause = pauses[pauseIndex];
    if (pause && serverTick >= pause[0] && serverTick < pause[1]) continue;
    selected.push(index);
  }

  return {
    startIndex,
    endIndex,
    tickIndices: Int32Array.from(selected),
    pausedRanges: pauses,
    reportedTime: end?.time,
    splits: (attemptEvents.length > 0 ? attemptEvents : timer)
      .filter((event) => event.event === "split" || event.event === "stage")
      .map((event) => ({
        index: event.index,
        time: event.time,
        serverTick: event.serverTick,
      })),
    hasTimerEvents: Boolean(start && end),
    firstTick,
    lastTick,
  };
};
