// A deliberately narrow, versioned transport for unchanged unsigned BC6H blocks.
// Header: KZBC6H\0\0, version/u32, width/u32, height/u32, mipCount/u32;
// then (width, height, byteLength)/u32 per mip and the blocks, largest mip first.
// All integers are little-endian. No colour conversion or generated mips.
const MAGIC = [75, 90, 66, 67, 54, 72, 0, 0];
export const BC6H_ENCODING = "bc6h-unsigned-linear";
export const bc6hByteLength = (width, height) =>
  Math.ceil(width / 4) * Math.ceil(height / 4) * 16;

const dimensions = (width, height, count) => {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 65535 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 65535 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1 + Math.floor(Math.log2(Math.max(width, height)))
  )
    throw new Error("Invalid BC6H texture dimensions or mip count");
};

export const encodeBc6hTexture = ({ width, height, mipmaps }) => {
  dimensions(width, height, mipmaps.length);
  let size = 24 + mipmaps.length * 12;
  for (const [level, mip] of mipmaps.entries()) {
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level);
    if (
      mip.width !== w ||
      mip.height !== h ||
      !(mip.data instanceof Uint8Array) ||
      mip.data.length !== bc6hByteLength(w, h)
    )
      throw new Error(`Invalid BC6H mip ${level}`);
    size += mip.data.length;
  }
  const bytes = new Uint8Array(size);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  [1, width, height, mipmaps.length].forEach((v, i) =>
    view.setUint32(8 + i * 4, v, true),
  );
  let offset = 24 + mipmaps.length * 12;
  mipmaps.forEach((mip, i) => {
    [mip.width, mip.height, mip.data.length].forEach((v, j) =>
      view.setUint32(24 + i * 12 + j * 4, v, true),
    );
    bytes.set(mip.data, offset);
    offset += mip.data.length;
  });
  return bytes;
};

export const parseBc6hTexture = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 24 || MAGIC.some((v, i) => bytes[i] !== v))
    throw new Error("Invalid BC6H container header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 1)
    throw new Error("Unsupported BC6H container version");
  const width = view.getUint32(12, true),
    height = view.getUint32(16, true);
  const count = view.getUint32(20, true);
  dimensions(width, height, count);
  let offset = 24 + count * 12;
  if (offset > bytes.length) throw new Error("Truncated BC6H mip table");
  const mipmaps = [];
  for (let i = 0; i < count; i++) {
    const w = view.getUint32(24 + i * 12, true);
    const h = view.getUint32(28 + i * 12, true);
    const size = view.getUint32(32 + i * 12, true);
    if (
      w !== Math.max(1, width >> i) ||
      h !== Math.max(1, height >> i) ||
      size !== bc6hByteLength(w, h) ||
      offset + size > bytes.length
    )
      throw new Error(`Invalid or truncated BC6H mip ${i}`);
    mipmaps.push({
      width: w,
      height: h,
      data: bytes.subarray(offset, offset + size),
    });
    offset += size;
  }
  if (offset !== bytes.length) throw new Error("Unexpected trailing BC6H data");
  return { encoding: BC6H_ENCODING, width, height, mipmaps };
};
