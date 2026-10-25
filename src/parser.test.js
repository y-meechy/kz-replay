import assert from "node:assert/strict";
import test from "node:test";
import { openReplay, parseReplay } from "./index.js";

// A deliberately tiny, project-authored replay container: protobuf header
// `{ version: 5 }` and one tick whose 64-bit change mask is zero. The zstd frame
// is kept as a literal so the test needs no compressor or downloaded fixture.
const syntheticReplay = ({ uncompressedSize = 8, subticks } = {}) => {
  const header = Buffer.from([0x08, 0x05]);
  const tickFrame = Buffer.from("KLUv/QRYQQAAAAAAAAAAAAC7G9vK", "base64");
  const sectionSize = 12 + tickFrame.length;
  const bytes = Buffer.alloc(
    4 + header.length + sectionSize * (subticks ? 2 : 1),
  );
  let offset = 0;
  bytes.writeUInt32LE(header.length, offset);
  offset += 4;
  header.copy(bytes, offset);
  offset += header.length;
  const writeSection = (size, count) => {
    bytes.writeUInt32LE(tickFrame.length, offset);
    bytes.writeUInt32LE(size, offset + 4);
    bytes.writeUInt32LE(count, offset + 8);
    tickFrame.copy(bytes, offset + 12);
    offset += sectionSize;
  };
  writeSection(uncompressedSize, 1);
  if (subticks) writeSection(subticks.uncompressedSize, subticks.elementCount);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

test("parses a complete synthetic replay container without network fixtures", () => {
  const replay = parseReplay(syntheticReplay());

  assert.equal(replay.header.version, 5);
  assert.equal(replay.ticks.count, 1);
  assert.deepEqual([...replay.ticks.origin], [0, 0, 0]);
  assert.deepEqual(replay.events, []);
  assert.equal(replay.sectionSizes.ticks.uncompressed, 8);
});

test("rejects a section whose declared size does not match its zstd frame", () => {
  assert.throws(
    () => parseReplay(syntheticReplay({ uncompressedSize: 9 })),
    /desynced|offset|size|length|inflate|memory/i,
  );
});

test("skips an oversized subtick section without weakening lazy inflation limits", () => {
  const buffer = syntheticReplay({
    subticks: { uncompressedSize: 620_784_920, elementCount: 715_190 },
  });

  const replay = parseReplay(buffer);
  assert.equal(replay.ticks.count, 1);
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.sectionSizes.subticks, {
    compressed: 21,
    uncompressed: 620_784_920,
    elements: 715_190,
  });

  const { sections, trailingBytes } = openReplay(buffer);
  assert.equal(trailingBytes, 0);
  assert.throws(
    () => sections.subticks.data(),
    /section "subticks" claims 620784920 bytes uncompressed, refusing/,
  );
});

// Version 7 widened section headers to u64 and writes one zstd frame per
// recording piece. Two one-tick frames make a two-tick section.
const syntheticV7Replay = ({ uncompressedSize = 16 } = {}) => {
  const header = Buffer.from([0x08, 0x07]);
  // Unlike the frame above, this one records its content size, as ZSTD_compress
  // always does and the v7 frame walk requires.
  const tickFrame = Buffer.from("KLUv/SAIQQAAAAAAAAAAAAA=", "base64");
  const frames = Buffer.concat([tickFrame, tickFrame]);
  const section = Buffer.alloc(24);
  section.writeBigUInt64LE(BigInt(frames.length), 0);
  section.writeBigUInt64LE(BigInt(uncompressedSize), 8);
  section.writeBigUInt64LE(2n, 16);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  const bytes = Buffer.concat([length, header, section, frames]);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

test("reads v7 wide section headers over several zstd frames", () => {
  const replay = parseReplay(syntheticV7Replay());

  assert.equal(replay.header.version, 7);
  assert.equal(replay.ticks.count, 2);
  assert.deepEqual(replay.sectionSizes.ticks, {
    compressed: 34,
    uncompressed: 16,
    elements: 2,
  });
  assert.equal(openReplay(syntheticV7Replay()).trailingBytes, 0);
});

test("refuses v7 frames that do not add up to the section header", () => {
  assert.throws(
    () => parseReplay(syntheticV7Replay({ uncompressedSize: 17 })),
    /frames hold 16 bytes, header says 17/,
  );
});
