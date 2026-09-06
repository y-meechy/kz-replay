// Recover the linear HDR irradiance and direct-light shadow data baked into a CS2
// map. They stay separate: irradiance is indirect light, while the four shadow
// channels are amounts selected by each stationary light's one-hot mask.

import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { HALF_TO_FLOAT } from "./tonemap.js";
import { encodeRgbmImage } from "./hdrImage.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { runTool as run } from "./toolProcess.js";
import { readSource2Bc6h } from "./source2Texture.js";
import { encodeBc6hTexture } from "./bc6hTexture.js";

const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

const dumpedPath = ({ outDir, mapName, name, extension }) =>
  join(outDir, "maps", mapName, "lightmaps", `${name}.${extension}`);

const dumpTexture = async ({
  cli,
  mapVpk,
  mapName,
  name,
  outDir,
  extension,
}) => {
  await run(
    cli,
    [
      "-i",
      mapVpk,
      "-f",
      `maps/${mapName}/lightmaps/${name}`,
      "-d",
      "-o",
      outDir,
    ],
    BIG_OUTPUT,
  );
  const path = dumpedPath({ outDir, mapName, name, extension });
  return existsSync(path) ? path : null;
};

const decoderFor = ({ half, srgb }) => {
  if (half) return (sample) => HALF_TO_FLOAT[sample];
  if (srgb)
    return (sample) => {
      const value = sample / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    };
  return (sample) => sample;
};

const readIrradiance = async (path) => {
  if (path.endsWith(".exr")) {
    const file = await readFile(path);
    const { data, width, height } = new EXRLoader().parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    return {
      data,
      width,
      height,
      channels: 4,
      // EXRLoader prepares bottom-up rows for a Three DataTexture. The PNG and
      // unchanged Source BC6H blocks must both retain the original top-down rows.
      flipRows: true,
      decode: decoderFor({
        half: !(data instanceof Float32Array),
        srgb: false,
      }),
      sourceEncoding: "linear-hdr",
    };
  }

  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    decode: decoderFor({ half: false, srgb: true }),
    sourceEncoding: "srgb8",
  };
};

export const encodeIrradiance = async (source, size) => {
  return encodeRgbmImage({
    width: source.width,
    height: source.height,
    sample: (index, channel) => {
      const sourceIndex = source.flipRows
        ? (source.height - 1 - Math.floor(index / source.width)) *
            source.width +
          (index % source.width)
        : index;
      return source.decode(
        source.data[sourceIndex * source.channels + channel],
      );
    },
    ...(size ? { targetWidth: size, targetHeight: size } : {}),
  });
};

const preserveCompressedIrradiance = async ({
  cli,
  mapVpk,
  mapName,
  outDir,
  source,
  size,
  log,
}) => {
  // A requested resize changes the UV-to-texel relation; native storage must
  // describe the same atlas as the RGBM fallback and direct-shadow atlas.
  if (size && (size !== source.width || size !== source.height)) return null;
  try {
    await run(
      cli,
      [
        "-i",
        mapVpk,
        "-f",
        `maps/${mapName}/lightmaps/irradiance.vtex_c`,
        "-o",
        outDir,
      ],
      BIG_OUTPUT,
    );
    const raw = await readFile(
      dumpedPath({ outDir, mapName, name: "irradiance", extension: "vtex_c" }),
    );
    const parsed = readSource2Bc6h(raw);
    if (parsed.width !== source.width || parsed.height !== source.height)
      throw new Error(
        "Native irradiance dimensions differ from the decoded atlas",
      );
    const data = encodeBc6hTexture(parsed);
    log(
      `preserving native BC6H irradiance: ${parsed.width}×${parsed.height}, ${parsed.mipmaps.length} authored mips, ${data.byteLength} bytes`,
    );
    return {
      data,
      encoding: parsed.encoding,
      width: parsed.width,
      height: parsed.height,
      mipCount: parsed.mipmaps.length,
    };
  } catch (error) {
    log(
      `native BC6H irradiance unavailable; retaining RGBM fallback: ${error.message}`,
    );
    return null;
  }
};

/**
 * @param size optional square target; null preserves the source atlas dimensions
 * @returns linear RGBM irradiance and independent RGBA shadow amounts
 */
export const buildLightmap = async ({
  cli,
  mapVpk,
  mapName,
  workDir,
  size = null,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "lightmaps", mapName);
  await rm(dumpDir, { recursive: true, force: true });

  try {
    const irradiancePath =
      (await dumpTexture({
        cli,
        mapVpk,
        mapName,
        name: "irradiance",
        outDir: dumpDir,
        extension: "exr",
      }).catch(() => null)) ??
      dumpedPath({
        outDir: dumpDir,
        mapName,
        name: "irradiance",
        extension: "png",
      });
    if (!existsSync(irradiancePath)) {
      log("no baked irradiance in this map");
      return null;
    }

    const source = await readIrradiance(irradiancePath);
    const irradiance = await encodeIrradiance(source, size);
    const irradianceCompressed = await preserveCompressedIrradiance({
      cli,
      mapVpk,
      mapName,
      outDir: dumpDir,
      source,
      size,
      log,
    });
    const shadowPath = await dumpTexture({
      cli,
      mapVpk,
      mapName,
      name: "direct_light_shadows",
      outDir: dumpDir,
      extension: "png",
    }).catch(() => null);
    let shadows = null;
    if (shadowPath) {
      const image = sharp(shadowPath).ensureAlpha();
      const metadata = await image.metadata();
      if (
        metadata.width === source.width &&
        metadata.height === source.height
      ) {
        shadows = {
          png: await encodeShadowChannels(
            shadowPath,
            irradiance.width,
            irradiance.height,
          ),
          width: irradiance.width,
          height: irradiance.height,
        };
      } else {
        log("direct-light shadow atlas dimensions do not match irradiance");
      }
    }

    log(
      `baked irradiance: ${source.width}×${source.height} ${source.sourceEncoding} -> ` +
        `${irradiance.width}×${irradiance.height} RGBM8 range ${irradiance.range.toFixed(3)}` +
        (shadows ? ", preserving four direct-shadow channels" : ""),
    );
    return {
      irradiance,
      irradianceCompressed,
      shadows,
      source: {
        width: source.width,
        height: source.height,
        encoding: source.sourceEncoding,
      },
    };
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};

// The fourth channel is another light's shadow amount, not opacity. Resizing RGBA
// as an image premultiplies RGB by that unrelated light, corrupting all four masks.
export const encodeShadowChannels = async (path, width, height) => {
  const metadata = await sharp(path).metadata();
  if (metadata.width === width && metadata.height === height) {
    return sharp(path).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
  }
  const channels = await Promise.all(
    [0, 1, 2, 3].map(async (channel) => {
      const plane = await sharp(path)
        .ensureAlpha()
        .extractChannel(channel)
        .raw()
        .toBuffer();
      // Use a separate pipeline: Sharp schedules resize before extractChannel even
      // when the calls appear in the opposite order.
      return sharp(plane, {
        raw: { width: metadata.width, height: metadata.height, channels: 1 },
      })
        .resize(width, height, { kernel: "lanczos3" })
        .greyscale()
        .raw()
        .toBuffer();
    }),
  );
  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 4; c++) pixels[i * 4 + c] = channels[c][i];
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
};
