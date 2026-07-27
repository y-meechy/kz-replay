// Public entry point: a .replay buffer in, a parsed run out.

import { openReplay } from "./container.js";
import { decodeTicks } from "./ticks.js";
import { decodeEvents, runBounds } from "./events.js";
import { buildTrack } from "./track.js";

export { openReplay } from "./container.js";
export { decodeTrack, TRACK_FLAG } from "./track.js";
export * from "./api.js";

/**
 * Parse a replay into its header, its ticks and its timer events.
 *
 * The tick decoder throws rather than guessing if the format has drifted, so a
 * successful return means every byte of the tick section was accounted for.
 */
export const parseReplay = (buffer) => {
  const { header, sections } = openReplay(buffer);

  if (!sections.ticks) {
    throw new Error("replay has no tick section");
  }
  const ticks = decodeTicks(
    sections.ticks.data(),
    sections.ticks.elementCount,
    header.version,
  );

  const events = sections.events
    ? decodeEvents(sections.events.data(), sections.events.elementCount)
    : [];

  return {
    header,
    ticks,
    events,
    bounds: runBounds(events, ticks),
    sectionSizes: Object.fromEntries(
      Object.values(sections).map((section) => [
        section.name,
        {
          compressed: section.compressedSize,
          uncompressed: section.uncompressedSize,
          elements: section.elementCount,
        },
      ]),
    ),
  };
};

/** Parse a replay and produce the browser-facing track plus its metadata. */
export const replayToTrack = (buffer, { recordId } = {}) => {
  const replay = parseReplay(buffer);
  const { bytes, stats } = buildTrack(replay.ticks, replay.bounds);

  const meta = {
    recordId,
    formatVersion: replay.header.version,
    player: replay.header.player,
    map: replay.header.map?.name,
    course: replay.header.run?.courseName,
    mode: replay.header.run?.mode?.name,
    styles: (replay.header.run?.styles ?? [])
      .map((style) => style.name)
      .filter(Boolean),
    reportedTime: replay.header.run?.time,
    teleports: replay.header.run?.teleports ?? 0,
    pluginVersion: replay.header.pluginVersion,
    recordedAt: replay.header.timestamp,
    timerTime: replay.bounds.reportedTime,
    trimmedFromTimerEvents: replay.bounds.hasTimerEvents,
    splits: replay.bounds.splits,
    ...stats,
  };

  return { bytes, meta, replay };
};
