// Lossless PNG transport for linear HDR pixels. RGBM8 is intentionally declared in
// asset metadata: it is compact and filterable, but still an explicit quantization.

import sharp from "sharp";

const finiteLight = (value) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Standard RGBM8: shader decode is `rgb * alpha * range` in linear space. */
export const encodeLinearRgbm = ({ rgb, range }) => {
  const peak = Math.max(
    1 / 255,
    finiteLight(rgb[0]),
    finiteLight(rgb[1]),
    finiteLight(rgb[2]),
  );
  const multiplier = Math.min(1, Math.ceil((peak / range) * 255) / 255);
  return [
    Math.round((finiteLight(rgb[0]) / (multiplier * range)) * 255),
    Math.round((finiteLight(rgb[1]) / (multiplier * range)) * 255),
    Math.round((finiteLight(rgb[2]) / (multiplier * range)) * 255),
    Math.round(multiplier * 255),
  ];
};

/**
 * Encode a sampled linear HDR image as RGBM8 PNG. Resizing, when explicit, happens
 * on Float32 linear values before RGBM quantization.
 */
export const encodeRgbmImage = async ({
  width,
  height,
  sample,
  targetWidth = width,
  targetHeight = height,
}) => {
  let pixels = null;
  let sampleAt = sample;
  if (width !== targetWidth || height !== targetHeight) {
    // Integrate numeric radiance directly. An image library's ordinary colour
    // pipeline can convert/clamp float RGB, and must not interpret M as opacity.
    pixels = new Float32Array(targetWidth * targetHeight * 3);
    const sx = width / targetWidth,
      sy = height / targetHeight;
    for (let y = 0; y < targetHeight; y++)
      for (let x = 0; x < targetWidth; x++) {
        const x0 = x * sx,
          x1 = (x + 1) * sx,
          y0 = y * sy,
          y1 = (y + 1) * sy;
        const offset = (y * targetWidth + x) * 3;
        for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++)
          for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
            const weight =
              ((Math.min(ix + 1, x1) - Math.max(ix, x0)) *
                (Math.min(iy + 1, y1) - Math.max(iy, y0))) /
              (sx * sy);
            for (let c = 0; c < 3; c++)
              pixels[offset + c] +=
                finiteLight(
                  sample(
                    Math.min(height - 1, iy) * width + Math.min(width - 1, ix),
                    c,
                  ),
                ) * weight;
          }
      }
    sampleAt = (index, channel) => pixels[index * 3 + channel];
  }

  const count = targetWidth * targetHeight;
  let range = 1;
  for (let index = 0; index < count; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      range = Math.max(range, finiteLight(sampleAt(index, channel)));
    }
  }
  const rgba = Buffer.allocUnsafe(count * 4);
  for (let index = 0; index < count; index += 1) {
    rgba.set(
      encodeLinearRgbm({
        rgb: [0, 1, 2].map((channel) => sampleAt(index, channel)),
        range,
      }),
      index * 4,
    );
  }
  return {
    png: await sharp(rgba, {
      raw: { width: targetWidth, height: targetHeight, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer(),
    width: targetWidth,
    height: targetHeight,
    range,
    encoding: "rgbm8-linear",
  };
};
