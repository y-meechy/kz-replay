// Layout and unsigned BC6H interpretation verified against ValveResourceFormat
// 00c629d321171ad0b9be83994c5e9cb15e8c5bd9: Resource.cs, Texture.cs and
// Renderer/Renderer/OpenGL/GLImageFormatExtensions.cs. This handles only a single
// full-rectangle 2D BC6H image, including Source's depth-one array representation.
import { bc6hByteLength, BC6H_ENCODING } from "./bc6hTexture.js";

export const decodeLz4Block = (source, size) => {
  const output = new Uint8Array(size);
  let read = 0,
    written = 0;
  const length = (initial) => {
    let result = initial;
    if (initial === 15) {
      let next;
      do {
        if (read >= source.length) throw new Error("Truncated LZ4 length");
        next = source[read++];
        result += next;
      } while (next === 255);
    }
    return result;
  };
  while (read < source.length) {
    const token = source[read++];
    const literals = length(token >> 4);
    if (read + literals > source.length || written + literals > size)
      throw new Error("Invalid LZ4 literal length");
    output.set(source.subarray(read, read + literals), written);
    read += literals;
    written += literals;
    if (read === source.length) break;
    if (read + 2 > source.length) throw new Error("Truncated LZ4 match offset");
    const distance = source[read++] | (source[read++] << 8);
    if (distance === 0 || distance > written)
      throw new Error("Invalid LZ4 match offset");
    const count = length(token & 15) + 4;
    if (written + count > size) throw new Error("Invalid LZ4 match length");
    for (let i = 0; i < count; i++) {
      output[written] = output[written - distance];
      written++;
    }
  }
  if (written !== size) throw new Error("LZ4 decoded size mismatch");
  return output;
};

export const readSource2Bc6h = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounds = (offset, length, end = bytes.length) => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      length < 0 ||
      offset + length > end
    )
      throw new Error("Invalid or truncated Source 2 texture offset");
  };
  bounds(0, 16);
  const resourceSize = view.getUint32(0, true);
  if (
    resourceSize < 16 ||
    resourceSize > bytes.length ||
    view.getUint16(4, true) !== 12
  )
    throw new Error("Unsupported Source 2 resource header");
  const table = 8 + view.getUint32(8, true),
    count = view.getUint32(12, true);
  bounds(table, count * 12, resourceSize);
  let data;
  for (let i = 0; i < count; i++) {
    const entry = table + i * 12;
    const offset = entry + 4 + view.getUint32(entry + 4, true);
    const size = view.getUint32(entry + 8, true);
    bounds(offset, size, resourceSize);
    if (view.getUint32(entry, true) === 0x41544144) {
      if (data) throw new Error("Duplicate Source 2 texture DATA block");
      data = { offset, size };
    }
  }
  if (!data || data.size < 40)
    throw new Error("Missing Source 2 texture DATA header");
  const start = data.offset,
    end = start + data.size;
  if (view.getUint16(start, true) !== 1 || view.getUint8(start + 26) !== 19)
    throw new Error("Only Source 2 VTEX version 1 BC6H is supported");
  const flags = view.getUint16(start + 2, true);
  // Array flag is common on irradiance even though it contains exactly one slice.
  if (view.getUint16(start + 24, true) !== 1 || (flags & ~0x024f) !== 0)
    throw new Error("Unsupported BC6H texture layout or flags");
  const width = view.getUint16(start + 20, true),
    height = view.getUint16(start + 22, true);
  const mipCount = view.getUint8(start + 27);
  if (
    !width ||
    !height ||
    !mipCount ||
    mipCount > 1 + Math.floor(Math.log2(Math.max(width, height)))
  )
    throw new Error("Invalid Source 2 BC6H dimensions or mip count");
  const extraCount = view.getUint32(start + 36, true);
  const extraTable = start + 32 + view.getUint32(start + 32, true);
  bounds(extraTable, extraCount * 12, end);
  let sizes = null,
    compressed = false;
  const seen = new Set();
  for (let i = 0; i < extraCount; i++) {
    const entry = extraTable + i * 12;
    const type = view.getUint32(entry, true);
    const offset = entry + 4 + view.getUint32(entry + 4, true);
    const size = view.getUint32(entry + 8, true);
    bounds(offset, size, end);
    if (seen.has(type))
      throw new Error("Duplicate Source 2 texture extra data");
    seen.add(type);
    if (type === 3) {
      if (size < 8) throw new Error("Truncated Source 2 display rectangle");
      const w = view.getUint16(offset + 2, true),
        h = view.getUint16(offset + 4, true);
      if ((w !== 0 || h !== 0) && (w !== width || h !== height))
        throw new Error(
          "BC6H display rectangle differs from stored dimensions",
        );
    } else if (type === 4) {
      if (size < 12)
        throw new Error("Truncated Source 2 compressed mip header");
      const compression = view.getUint32(offset, true);
      if (compression > 1 || view.getUint32(offset + 8, true) !== mipCount)
        throw new Error("Unsupported Source 2 mip compression metadata");
      compressed = compression === 1;
      const location = offset + 4 + view.getUint32(offset + 4, true);
      bounds(location, mipCount * 4, end);
      sizes = Array.from({ length: mipCount }, (_, level) =>
        view.getUint32(location + level * 4, true),
      );
    } else {
      throw new Error(`Unsupported Source 2 BC6H extra data ${type}`);
    }
  }
  let offset = end;
  const mipmaps = new Array(mipCount);
  // Source serializes the smallest mip first; WebGL/Three expects level zero first.
  for (let level = mipCount - 1; level >= 0; level--) {
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level);
    const decodedSize = bc6hByteLength(w, h);
    const storedSize = sizes
      ? Math.min(sizes[level], decodedSize)
      : decodedSize;
    if (!storedSize || (!compressed && storedSize !== decodedSize))
      throw new Error("Inconsistent Source 2 mip compression size");
    bounds(offset, storedSize);
    const source = bytes.subarray(offset, offset + storedSize);
    mipmaps[level] = {
      width: w,
      height: h,
      data:
        storedSize < decodedSize ? decodeLz4Block(source, decodedSize) : source,
    };
    offset += storedSize;
  }
  if (offset !== bytes.length)
    throw new Error("Unexpected trailing Source 2 BC6H data");
  return { encoding: BC6H_ENCODING, width, height, mipmaps };
};
