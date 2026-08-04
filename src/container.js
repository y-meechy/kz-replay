// Walk the outer structure of a .replay file.
//
//   u32               headerSize
//   byte[headerSize]  protobuf ReplayHeader
//   section           TickData      (delta encoded, see ticks.js)
//   section           SubtickData   (raw structs)
//   section           Weapons
//   section           Jumps
//   section           Events        (see events.js)
//   section           CmdData       (version 5)
//   section           CmdSubtickData
//
// Every section is a `CompressedSectionHeader` followed by one zstd frame:
//
//   u32 compressedSize
//   u32 uncompressedSize
//   u32 elementCount
//   byte[compressedSize]
//
// Reference: cs2kz-metamod/src/kz/replays/{data,compression}.cpp

import { decompress } from "fzstd";
import { decodeHeader } from "./header.js";

const SECTION_HEADER_SIZE = 12;
const MAX_INFLATED_SECTION_SIZE = 256 * 1024 * 1024;

/** The order sections appear in the file, as read by LoadReplay in data.cpp. */
export const SECTION_NAMES = [
  "ticks",
  "subticks",
  "weapons",
  "jumps",
  "events",
  "cmdData",
  "cmdSubticks",
];

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  u32() {
    if (this.offset + 4 > this.bytes.length) {
      throw new Error(`truncated replay: wanted 4 bytes at ${this.offset}`);
    }
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  take(length) {
    if (this.offset + length > this.bytes.length) {
      throw new Error(
        `truncated replay: wanted ${length} bytes at ${this.offset}`,
      );
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  get remaining() {
    return this.bytes.length - this.offset;
  }
}

/**
 * Split a .replay buffer into its header and its raw sections.
 *
 * Sections are returned lazily-decompressed: `section.data()` inflates on demand
 * so callers can skip the big ones (subtick and cmd data can be hundreds of MB
 * and we do not use them).
 */
export const openReplay = (buffer) => {
  const cursor = new Cursor(new Uint8Array(buffer));

  const headerSize = cursor.u32();
  if (headerSize === 0 || headerSize > 5 * 1024 * 1024) {
    throw new Error(
      `implausible header size ${headerSize}, this is probably not a .replay file`,
    );
  }
  const header = decodeHeader(cursor.take(headerSize));

  const sections = {};
  for (const name of SECTION_NAMES) {
    if (cursor.remaining < SECTION_HEADER_SIZE) {
      break;
    }
    const compressedSize = cursor.u32();
    const uncompressedSize = cursor.u32();
    const elementCount = cursor.u32();
    const compressed = cursor.take(compressedSize);

    sections[name] = {
      name,
      compressedSize,
      uncompressedSize,
      elementCount,
      data: () => {
        // Some valid replays contain enormous subtick sections that callers do
        // not use. Keep them skippable without handing a claimed u32 size to the
        // allocator when a caller does request their contents.
        if (uncompressedSize > MAX_INFLATED_SECTION_SIZE) {
          throw new Error(
            `section "${name}" claims ${uncompressedSize} bytes uncompressed, refusing`,
          );
        }
        const inflated = decompress(
          compressed,
          new Uint8Array(uncompressedSize),
        );
        if (inflated.length !== uncompressedSize) {
          throw new Error(
            `section "${name}" inflated to ${inflated.length} bytes, expected ${uncompressedSize}`,
          );
        }
        return inflated;
      },
    };
  }

  return { header, sections, trailingBytes: cursor.remaining };
};
