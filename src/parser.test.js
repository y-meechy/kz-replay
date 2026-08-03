import assert from "node:assert/strict";
import test from "node:test";
import { parseReplay } from "./index.js";

// A deliberately tiny, project-authored replay container: protobuf header
// `{ version: 5 }` and one tick whose 64-bit change mask is zero. The zstd frame
// is kept as a literal so the test needs no compressor or downloaded fixture.
const syntheticReplay = ({ uncompressedSize = 8 } = {}) => {
  const header = Buffer.from([0x08, 0x05]);
  const tickFrame = Buffer.from("KLUv/QRYQQAAAAAAAAAAAAC7G9vK", "base64");
  const bytes = Buffer.alloc(4 + header.length + 12 + tickFrame.length);
  let offset = 0;
  bytes.writeUInt32LE(header.length, offset);
  offset += 4;
  header.copy(bytes, offset);
  offset += header.length;
  bytes.writeUInt32LE(tickFrame.length, offset);
  bytes.writeUInt32LE(uncompressedSize, offset + 4);
  bytes.writeUInt32LE(1, offset + 8);
  tickFrame.copy(bytes, offset + 12);
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
