// Turning high dynamic range light into an 8 bit image.
//
// Two of the things a map ships are real radiance rather than pixels: the baked
// lightmap (mapLightmap.js) and the sky (mapSky.js). Both arrive as half precision
// floats running well past 1, and both are read a pixel at a time over an image that
// can be 8192 on a side. So both want the same two lookup tables, and neither wants a
// function call per component if a table will do.
//
// The exposure search at the bottom is shared for the same reason: sky and cubemap
// (mapEnvmap.js) pick their exposure the same way, only aiming at different targets.

/**
 * Half precision float bits to a number.
 *
 * A table, because BC6H decodes to half floats and there are up to 200 million of them
 * in one atlas. Widening the whole buffer to Float32 up front is the obvious
 * alternative and it is a trap: `Float32Array.from(halfData, fn)` builds an intermediate
 * JS array and ran out of memory on kz_grotto's 8192² atlas.
 */
export const HALF_TO_FLOAT = (() => {
  const table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits += 1) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) {
      // Subnormal, including zero.
      table[bits] = sign * mantissa * 2 ** -24;
    } else if (exponent === 31) {
      // Infinity or not-a-number. Neither is light, so both become black rather than
      // poisoning every pixel they are averaged into on the way down to 1024.
      table[bits] = 0;
    } else {
      table[bits] = sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }
  }
  return table;
})();

const SRGB = (() => {
  // Encoding tens of millions of pixels three channels at a time is worth a table.
  const table = new Uint8Array(4096);
  for (let i = 0; i < table.length; i += 1) {
    const linear = i / (table.length - 1);
    const encoded =
      linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * linear ** (1 / 2.4) - 0.055;
    table[i] = Math.round(encoded * 255);
  }
  return table;
})();

/** A 0..1 linear value as one gamma encoded byte. Values above 1 clamp to white. */
export const encodeSrgb = (linear) =>
  SRGB[Math.min(4095, Math.max(0, (linear * 4095) | 0))];

/**
 * Exposure that lands an image's bright end on `target`.
 *
 * A histogram rather than a sort: these run over millions of samples, and light past
 * 64 is far beyond anything a percentile will land on.
 *
 * @param sample     index -> linear light (luminance, for the callers in here)
 * @param count      how many samples there are
 * @param percentile which end counts as "bright", e.g. 0.99
 * @param target     where that bright end should land, 0..1
 */
export const exposureFor = (sample, count, percentile, target) => {
  const BINS = 4096;
  const SCALE = BINS / 64;
  const histogram = new Uint32Array(BINS + 1);
  for (let index = 0; index < count; index += 1) {
    histogram[Math.min(BINS, Math.max(0, (sample(index) * SCALE) | 0))] += 1;
  }
  const wanted = count * percentile;
  let running = 0;
  let bin = 0;
  for (; bin < histogram.length; bin += 1) {
    running += histogram[bin];
    if (running >= wanted) break;
  }
  // Mid-bin, and never zero: an all-black image would divide by it.
  const bright = Math.max((bin + 0.5) / SCALE, 0.05);
  return -Math.log(1 - target) / bright;
};
