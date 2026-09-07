// Lossless PNG transport for linear HDR pixels. RGBM8 is intentionally declared in
// asset metadata: it is compact and filterable, but still an explicit quantization.

import sharp from "sharp";
import {
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  RGBAFormat,
} from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import {
  EXRExporter,
  ZIPS_COMPRESSION,
} from "three/addons/exporters/EXRExporter.js";

/**
 * Shrink a latlong EXR to `targetWidth` (height follows 2:1) by box filtering
 * linear radiance, and re-encode it as a half-float ZIP EXR.
 */
export const downsampleExr = async (file, targetWidth) => {
  const { data, width, height } = new EXRLoader()
    .setDataType(FloatType)
    .parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
  const targetHeight = Math.round((targetWidth * height) / width);
  const sample = (index, channel) => data[index * 4 + channel];
  const pixels = boxFilter({
    width,
    height,
    sample,
    targetWidth,
    targetHeight,
  });
  const rgba = new Uint16Array(targetWidth * targetHeight * 4);
  for (let i = 0; i < targetWidth * targetHeight; i++) {
    for (let c = 0; c < 3; c++)
      rgba[i * 4 + c] = DataUtils.toHalfFloat(
        Math.min(65504, finiteLight(pixels[i * 3 + c])),
      );
    rgba[i * 4 + 3] = DataUtils.toHalfFloat(1);
  }
  const texture = new DataTexture(
    rgba,
    targetWidth,
    targetHeight,
    RGBAFormat,
    HalfFloatType,
  );
  const exr = await new EXRExporter().parse(texture, {
    type: HalfFloatType,
    compression: ZIPS_COMPRESSION,
  });
  return {
    exr: Buffer.from(exr.buffer, exr.byteOffset, exr.byteLength),
    width: targetWidth,
    height: targetHeight,
  };
};

const finiteLight = (value) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Area-weighted box filter of linear RGB; returns Float32 RGB triplets. */
const boxFilter = ({ width, height, sample, targetWidth, targetHeight }) => {
  const pixels = new Float32Array(targetWidth * targetHeight * 3);
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
  return pixels;
};

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
  let sampleAt = sample;
  if (width !== targetWidth || height !== targetHeight) {
    // Integrate numeric radiance directly. An image library's ordinary colour
    // pipeline can convert/clamp float RGB, and must not interpret M as opacity.
    const pixels = boxFilter({
      width,
      height,
      sample,
      targetWidth,
      targetHeight,
    });
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
