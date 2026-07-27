// Minimal proto2 reader. Enough for the CS2KZ replay header and nothing more.
//
// We hand-roll instead of pulling in protobufjs so the parser has no opinion about
// how the upstream .proto file evolves: we read exactly the field numbers we know,
// and unknown fields are skipped by wire type.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

/**
 * Decode a protobuf message into a Map of field number -> array of raw values.
 *
 * Values are `bigint` for varints and fixed64, `number` for fixed32 (read as
 * float32), and `Uint8Array` for length-delimited fields.
 */
export const decodeMessage = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = new Map();
  let offset = 0;

  const push = (fieldNumber, value) => {
    const existing = fields.get(fieldNumber);
    if (existing) {
      existing.push(value);
    } else {
      fields.set(fieldNumber, [value]);
    }
  };

  while (offset < bytes.length) {
    const [key, afterKey] = readVarint(bytes, offset);
    offset = afterKey;
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);

    switch (wireType) {
      case WIRE_VARINT: {
        const [value, next] = readVarint(bytes, offset);
        push(fieldNumber, value);
        offset = next;
        break;
      }
      case WIRE_FIXED64: {
        push(fieldNumber, view.getFloat64(offset, true));
        offset += 8;
        break;
      }
      case WIRE_LENGTH: {
        const [length, next] = readVarint(bytes, offset);
        const size = Number(length);
        push(fieldNumber, bytes.subarray(next, next + size));
        offset = next + size;
        break;
      }
      case WIRE_FIXED32: {
        push(fieldNumber, view.getFloat32(offset, true));
        offset += 4;
        break;
      }
      default:
        throw new Error(
          `unsupported protobuf wire type ${wireType} at byte ${offset}`,
        );
    }
  }

  return fields;
};

const readVarint = (bytes, offset) => {
  let result = 0n;
  let shift = 0n;
  let index = offset;

  for (;;) {
    if (index >= bytes.length) {
      throw new Error("truncated varint");
    }
    const byte = bytes[index];
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, index];
    }
    shift += 7n;
  }
};

/** First value of a field, or undefined. */
export const first = (fields, fieldNumber) => fields.get(fieldNumber)?.[0];

/** Field read as a submessage. */
export const sub = (fields, fieldNumber) => {
  const bytes = first(fields, fieldNumber);
  return bytes ? decodeMessage(bytes) : undefined;
};

/** Field read as a UTF-8 string. */
export const str = (fields, fieldNumber) => {
  const bytes = first(fields, fieldNumber);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/** Field read as a JS number (varints are small enough here). */
export const num = (fields, fieldNumber) => {
  const value = first(fields, fieldNumber);
  return typeof value === "bigint" ? Number(value) : value;
};
