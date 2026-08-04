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
