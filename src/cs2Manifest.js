// Read a depot manifest: which chunks cover which bytes of which file.
//
// This is the half of chunk-level fetching that needs no network at all. DepotDownloader
// already caches the manifest it downloaded, under
// `<cs2Dir>/.DepotDownloader/<depot>_<gid>.manifest`, and that file is an eight byte
// header followed by an ordinary protobuf: repeated FileMapping, each with a filename, a
// size, and a list of ChunkData carrying a SHA-1, an offset into the file and a length.
//
// So the expensive question — "which 250 KB pieces of this 105 MB archive part do I
// actually need" — is answered from a file already on disk. Only the pieces themselves
// have to be fetched. See cs2Chunks.js.
//
// Parsed by hand rather than with a protobuf library: the two messages involved have
// eight fields between them, the project already decodes protobuf this way for the replay
// header (src/protobuf.js), and adding a code generator and a schema to read eight fields
// would be the larger dependency.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** DepotDownloader writes its own eight byte marker before the protobuf. */
const HEADER_BYTES = 8;

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

/**
 * Walk one protobuf message, calling back per field.
 *
 * @param onField (fieldNumber, wireType, reader) -> void. The reader is positioned at
 *                the field's value and must consume exactly it.
 */
const eachField = (bytes, start, end, onField) => {
  let at = start;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[at++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
  };

  while (at < end) {
    const tag = Number(varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === WIRE_VARINT) {
      onField(field, wire, { varint });
    } else if (wire === WIRE_LENGTH) {
      const length = Number(varint());
      const from = at;
      at += length;
      onField(field, wire, { from, to: from + length });
    } else if (wire === WIRE_32BIT) {
      at += 4;
    } else if (wire === WIRE_64BIT) {
      at += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
};

/** ChunkData: sha, crc, offset, original length, compressed length. */
const readChunk = (bytes, start, end) => {
  const chunk = { sha: null, offset: 0, size: 0 };
  eachField(bytes, start, end, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      chunk.sha = bytes.toString("hex", reader.from, reader.to);
    } else if (field === 3 && wire === WIRE_VARINT) {
      chunk.offset = Number(reader.varint());
    } else if (field === 4 && wire === WIRE_VARINT) {
      chunk.size = Number(reader.varint());
    } else if (wire === WIRE_VARINT) {
      reader.varint();
    }
  });
  return chunk;
};

/** FileMapping: filename, size, flags, hashes, chunks. */
const readFileMapping = (bytes, start, end) => {
  const mapping = { name: "", size: 0, chunks: [] };
  eachField(bytes, start, end, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      // Depot paths are Windows-shaped; every other path in this project is not.
      mapping.name = bytes
        .toString("utf8", reader.from, reader.to)
        .replace(/\\/g, "/");
    } else if (field === 2 && wire === WIRE_VARINT) {
      mapping.size = Number(reader.varint());
    } else if (field === 6 && wire === WIRE_LENGTH) {
      mapping.chunks.push(readChunk(bytes, reader.from, reader.to));
    } else if (wire === WIRE_VARINT) {
      reader.varint();
    }
  });
  return mapping;
};

/** The newest manifest DepotDownloader has cached for a depot, or null. */
export const findCachedManifest = async (cs2Dir, depotId) => {
  const dir = join(cs2Dir, ".DepotDownloader");
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const candidates = files
    .filter(
      (file) => file.startsWith(`${depotId}_`) && file.endsWith(".manifest"),
    )
    .sort();
  if (candidates.length === 0) return null;
  const name = candidates.at(-1);
  return {
    path: join(dir, name),
    gid: name.slice(`${depotId}_`.length, -".manifest".length),
  };
};

/**
 * Every file in the manifest, by depot-relative path.
 *
 * @returns Map of "game/csgo/pak01_286.vpk" -> { name, size, chunks: [{sha, offset, size}] }
 */
export const readManifestFiles = async (path) => {
  const bytes = await readFile(path);
  const files = new Map();

  // Read the file list only, and stop at the first thing that is not one. DepotDownloader
  // appends 73 bytes of its own after the 2,947 mappings, and walking into that with a
  // protobuf reader raises "unsupported wire type" on what is really the end of the data.
  let at = HEADER_BYTES;
  while (at < bytes.length) {
    const tagStart = at;
    let tag = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++];
      tag |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    if (tag >>> 3 !== 1 || (tag & 7) !== WIRE_LENGTH) {
      at = tagStart;
      break;
    }
    let length = 0;
    shift = 0;
    for (;;) {
      const byte = bytes[at++];
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const mapping = readFileMapping(bytes, at, at + length);
    files.set(mapping.name, mapping);
    at += length;
  }
  return files;
};
