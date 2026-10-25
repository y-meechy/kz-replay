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
// Every section is a `CompressedSectionHeader` followed by zstd data:
//
//   u32 compressedSize      (u64 from version 7)
//   u32 uncompressedSize    (u64 from version 7)
//   u32 elementCount        (u64 from version 7)
//   byte[compressedSize]
//
// Up to version 6 the data is one zstd frame. From version 7 it is one frame per
// recording piece: long runs are flushed to disk every 15 minutes and each piece is
// compressed on its own, so the frames must be inflated back to back. The delta
// streams carry on across frame boundaries, as if it were one frame.
//
// Reference: cs2kz-metamod/src/kz/replays/{data,compression}.cpp

import { decompress } from "fzstd";
import { decodeHeader } from "./header.js";

const WIDE_SECTIONS_VERSION = 7;
const ZSTD_MAGIC = 0xfd2fb528;
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

  u64() {
    if (this.offset + 8 > this.bytes.length) {
      throw new Error(`truncated replay: wanted 8 bytes at ${this.offset}`);
    }
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`implausible section size ${value}`);
    }
    return Number(value);
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
 * Where each zstd frame in a section starts and ends, and how much it inflates to.
 *
 * fzstd can inflate concatenated frames, but not into one preallocated buffer, and
 * without one it allocates whatever each frame header claims. Walking the frames
 * first keeps the claimed sizes checked against the section header before anything
 * is allocated, the same check upstream's GetSectionContentSize makes.
 */
export const zstdFrames = (bytes, name) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let offset = 0;
  const need = (length) => {
    if (offset + length > bytes.length) {
      throw new Error(`section "${name}" ends inside a zstd frame`);
    }
  };

  while (offset < bytes.length) {
    const start = offset;
    need(5);
    if (view.getUint32(offset, true) !== ZSTD_MAGIC) {
      throw new Error(
        `section "${name}" has no zstd frame at byte ${offset - start}`,
      );
    }
    const descriptor = bytes[offset + 4];
    offset += 5;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryIdSize = [0, 1, 2, 4][descriptor & 0x03];
    const contentSizeSize = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
    if (contentSizeSize === 0) {
      // Upstream always records it, so a frame without one is not theirs.
      throw new Error(`section "${name}" has a zstd frame of unknown size`);
    }
    offset += (singleSegment ? 0 : 1) + dictionaryIdSize;
    need(contentSizeSize);
    let contentSize;
    if (contentSizeSize === 1) contentSize = bytes[offset];
    else if (contentSizeSize === 2)
      contentSize = view.getUint16(offset, true) + 256;
    else if (contentSizeSize === 4) contentSize = view.getUint32(offset, true);
    else contentSize = Number(view.getBigUint64(offset, true));
    offset += contentSizeSize;

    for (let last = false; !last;) {
      need(3);
      const block =
        bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      offset += 3;
      last = (block & 1) === 1;
      const type = (block >> 1) & 3;
      if (type === 3) {
        throw new Error(`section "${name}" has a reserved zstd block type`);
      }
      // An RLE block stores its one repeated byte, whatever its size says.
      const blockSize = type === 1 ? 1 : block >>> 3;
      need(blockSize);
      offset += blockSize;
    }
    if (hasChecksum) {
      need(4);
      offset += 4;
    }
    frames.push({ start, end: offset, contentSize });
  }
  return frames;
};

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
  const wide = header.version >= WIDE_SECTIONS_VERSION;
  const readSize = wide ? () => cursor.u64() : () => cursor.u32();
  const sectionHeaderSize = wide ? 24 : 12;

  const sections = {};
  for (const name of SECTION_NAMES) {
    if (cursor.remaining < sectionHeaderSize) {
      break;
    }
    const compressedSize = readSize();
    const uncompressedSize = readSize();
    const elementCount = readSize();
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
        if (!wide) {
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
        }

        const frames = zstdFrames(compressed, name);
        const claimed = frames.reduce(
          (sum, frame) => sum + frame.contentSize,
          0,
        );
        if (claimed !== uncompressedSize) {
          throw new Error(
            `section "${name}" frames hold ${claimed} bytes, header says ${uncompressedSize}`,
          );
        }
        const inflated = new Uint8Array(uncompressedSize);
        let offset = 0;
        for (const frame of frames) {
          const target = inflated.subarray(offset, offset + frame.contentSize);
          const out = decompress(
            compressed.subarray(frame.start, frame.end),
            target,
          );
          if (
            out.length !== frame.contentSize ||
            out.buffer !== inflated.buffer
          ) {
            throw new Error(
              `section "${name}" frame at byte ${frame.start} inflated to ${out.length} bytes, expected ${frame.contentSize}`,
            );
          }
          offset += frame.contentSize;
        }
        return inflated;
      },
    };
  }

  return { header, sections, trailingBytes: cursor.remaining };
};
