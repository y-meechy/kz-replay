// Decode the `cs2kz.replay.ReplayHeader` protobuf message.
// Field numbers come from cs2kz-metamod/protobuf/kz_replay.proto (proto2).

import { decodeMessage, first, num, str, sub } from "./protobuf.js";

export const REPLAY_TYPE = {
  0: "manual",
  1: "cheater",
  2: "run",
  3: "jumpstats",
};

/** Newest format version this parser was written against. */
export const MAX_SUPPORTED_VERSION = 5;

const readPlayer = (fields) =>
  fields && {
    name: str(fields, 1),
    steamId64: first(fields, 2)?.toString(),
  };

const readModeStyle = (fields) =>
  fields && {
    name: str(fields, 1),
    shortName: str(fields, 2),
  };

export const decodeHeader = (bytes) => {
  const fields = decodeMessage(bytes);
  const version = num(fields, 1) ?? 0;
  const type = REPLAY_TYPE[num(fields, 2) ?? 0];

  if (version < 1 || version > MAX_SUPPORTED_VERSION) {
    throw new Error(
      `replay format version ${version} is not supported (this parser knows 1-${MAX_SUPPORTED_VERSION}). ` +
        "The tick decoder must be checked against cs2kz-metamod before bumping this.",
    );
  }

  const mapFields = sub(fields, 4);
  const runFields = sub(fields, 16);

  const header = {
    version,
    type,
    player: readPlayer(sub(fields, 3)),
    map: mapFields && { name: str(mapFields, 1), md5: str(mapFields, 2) },
    timestamp: first(fields, 7)?.toString(),
    pluginVersion: str(fields, 8),
  };

  if (runFields) {
    header.run = {
      courseName: str(runFields, 1),
      mode: readModeStyle(sub(runFields, 2)),
      styles: (runFields.get(3) ?? []).map((bytes) =>
        readModeStyle(decodeMessage(bytes)),
      ),
      time: num(runFields, 4),
      teleports: num(runFields, 5) ?? 0,
    };
  }

  return header;
};
