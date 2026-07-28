// Recover a map's own baked lighting, without the game files.
//
// The surface textures of a CS2 map are not in the map. Every material it names
// points into the CS2 install, which is a 52 GB download, so the exporter writes a
// world with no materials at all (see mapMaterialNames.js).
//
// The baked lighting *is* in the map. A compiled Source 2 world ships a lightmap
// set under `maps/<map>/lightmaps/`, and the world meshes still carry the atlas UVs
// that address it. That is the real sun, the real shadows and the real coloured
// bounce of the level, from the level, for no extra download.
//
// Two of the set are worth having:
//
//   irradiance            the indirect light: sky colour in the open, bounced wall
//                         colour indoors, and the soft darkening in every corner.
//   direct_light_shadows  where the sun reaches, as a mask. Hard edged, because it
//                         is a visibility test rather than a light.
//
// They are added in linear light — indirect everywhere, plus sun where the mask says
// so — then tone mapped once into one image, which is the whole of a surface's
// lighting. `directional_irradiance` is left alone: it encodes which direction the
// indirect light arrives from, which only matters for normal mapping, and there are
// no normal maps here.
//
// The result is one small texture for an entire map. At 1024 it is about 250 KB.

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { HALF_TO_FLOAT, encodeSrgb } from "./tonemap.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const run = promisify(execFile);

// The dumps print one line per file and a lightmap set has a dozen.
const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

/**
 * Colour of the baked sun, as a tint. Its strength is not here: see SUN_SHARE.
 *
 * The map does not say what the sun was. The shadow mask is a visibility test, and
 * the sun's own colour and brightness live in an entity the exporter does not write,
 * so both are invented. Warm, against the blue of the sky it sits in.
 */
const SUN_TINT = [1, 0.94, 0.82];

/**
 * How much brighter a sunlit patch is than the same patch in shadow, after tone
 * mapping. A share of the curve rather than an amount of light, on purpose.
 *
 * Adding a fixed amount of light instead is what broke kz_grotto. Its sun mask is
 * lit almost everywhere, so a fixed sun landed the same large number on nearly every
 * pixel, swamped the map's own indirect light, and produced an atlas that was 86%
 * white: every surface the same flat brightness and not one baked shadow left. Scaled
 * to the exposure, the sun is worth the same amount of contrast on every map,
 * whatever level its mapper lit at.
 */
const SUN_SHARE = 0.85;

/**
 * Where the brightest part of a map's lighting should land, and which part counts.
 *
 * The tone mapping curve is `1 - exp(-light × exposure)`, and the exposure has to be
 * measured per map rather than assumed: the baked light is real radiance, not a pixel
 * value, and mappers light at wildly different levels. Measured from the indirect
 * light alone, which is real data, and never from the invented sun on top of it.
 *
 * So: put the 98th percentile of the indirect light just short of white. Not the
 * maximum, which on a map with one small very bright light source would darken
 * everything else to nothing.
 */
const BRIGHT_PERCENTILE = 0.98;
const BRIGHT_TARGET = 0.9;

/**
 * Exposure that lands the map's bright end on BRIGHT_TARGET.
 *
 * @param lightAt (pixel, channel) -> linear indirect light
 * @param pixels  how many pixels the atlas has
 */
const exposureFor = (lightAt, pixels) => {
  // A histogram rather than a sort: 67 million samples cannot be sorted, and light
  // over 32 is far past anything a percentile will land on.
  const BINS = 4096;
  const SCALE = BINS / 32;
  const histogram = new Uint32Array(BINS + 1);
  let counted = 0;
  // Every sixteenth pixel. A percentile does not need more, and this runs over an
  // atlas that can be 8192 on a side.
  for (let index = 0; index < pixels; index += 16) {
    for (let channel = 0; channel < 3; channel += 1) {
      const light = lightAt(index, channel);
      histogram[Math.min(BINS, Math.max(0, (light * SCALE) | 0))] += 1;
      counted += 1;
    }
  }

  const target = counted * BRIGHT_PERCENTILE;
  let running = 0;
  let bin = 0;
  for (; bin < histogram.length; bin += 1) {
    running += histogram[bin];
    if (running >= target) break;
  }
  // Mid-bin, and never zero: a map whose whole atlas is black would divide by it.
  const bright = Math.max((bin + 0.5) / SCALE, 0.05);
  return -Math.log(1 - BRIGHT_TARGET) / bright;
};

/** Where a decompiled lightmap texture lands: the dump mirrors the vpk's own paths. */
const dumpedPath = ({ outDir, mapName, name, extension }) =>
  join(outDir, "maps", mapName, "lightmaps", `${name}.${extension}`);

/** Decompile one lightmap texture and return the path written, or null. */
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

/**
 * One stored sample to linear light, picked once for the whole atlas.
 *
 * Chosen up front rather than asked per sample: the read below runs 67 million times
 * on a 4096² atlas, four times that on an 8192² one.
 */
const decoderFor = ({ half, srgb }) => {
  // Half precision floats, which is what a BC6H texture decodes to.
  if (half) return (sample) => HALF_TO_FLOAT[sample];
  // A byte that was gamma encoded on the way into the PNG, so undo that.
  if (srgb) return (sample) => (sample / 255) ** 2.2;
  // A float EXR: already linear light, already a number.
  return (sample) => sample;
};

/**
 * The irradiance atlas as linear light, whether it came as HDR or not.
 *
 * Returned in whatever form it arrived in rather than converted to floats up front.
 * A 4096² atlas is 67 million samples and a big map's is 8192², so widening it to
 * Float32 first would cost a gigabyte for no reason: the caller reads every sample
 * exactly once.
 *
 * @returns { data, width, height, half } — `half` says to put samples through
 *          HALF_TO_FLOAT, and `srgb` says to undo gamma encoding first.
 */
const readIrradiance = async (path) => {
  if (path.endsWith(".exr")) {
    const file = await readFile(path);
    const { data, width, height } = new EXRLoader().parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    // Half float is what a BC6H texture decodes to; a float EXR needs no table.
    return {
      data,
      width,
      height,
      half: !(data instanceof Float32Array),
      srgb: false,
      hdr: true,
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
    half: false,
    srgb: true,
    hdr: false,
  };
};

/**
 * The map's baked lighting as one low resolution PNG.
 *
 * @param size  width and height of the result. This is one atlas for a whole map, so
 *              it is the only thing between a 4096² source and a file a browser
 *              downloads: 4096 is 24 MB, 1024 about 250 KB.
 * @returns { png, size, shadows } or null when the map has no usable lightmap
 */
export const buildLightmap = async ({
  cli,
  mapVpk,
  mapName,
  workDir,
  size = 1024,
  // Left null on purpose: measured from the map. Only set it to pin one down.
  exposure = null,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "lightmaps", mapName);
  await rm(dumpDir, { recursive: true, force: true });

  try {
    // BC6H is an HDR format, so the decompiler writes an .exr. Anything else in
    // there decodes to a .png.
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
      log("no baked lightmap in this map, so surfaces keep their flat colour");
      return null;
    }

    // A map lit entirely by dynamic lights has no baked sun mask. The indirect light
    // on its own is still worth shipping, just flatter.
    const shadowPath = await dumpTexture({
      cli,
      mapVpk,
      mapName,
      name: "direct_light_shadows",
      outDir: dumpDir,
      extension: "png",
    }).catch(() => null);

    const { data, width, height, half, srgb, hdr } =
      await readIrradiance(irradiancePath);
    const pixels = width * height;

    // The mask is one channel repeated, so only the first is read.
    let shadow = null;
    if (shadowPath) {
      const mask = await sharp(shadowPath).greyscale().raw().toBuffer();
      shadow = mask.length >= pixels ? mask : null;
      if (!shadow) {
        log("the sun shadow mask does not match the atlas, skipping it");
      }
    }

    // The map's own indirect light, in linear units, one sample at a time. Never a
    // whole converted copy of the atlas: Float32Array.from() over an 8192² one is a
    // gigabyte and ran the process out of memory.
    const decode = decoderFor({ half, srgb });
    const indirectAt = (index, channel) => decode(data[index * 4 + channel]);

    const chosenExposure = exposure ?? exposureFor(indirectAt, pixels);
    // Divided by the exposure so it is worth SUN_SHARE of the curve rather than a
    // fixed number of units of light. See SUN_SHARE.
    const sun = SUN_TINT.map((tint) => (tint * SUN_SHARE) / chosenExposure);

    const out = Buffer.allocUnsafe(pixels * 3);
    let sum = 0;
    let white = 0;
    for (let index = 0; index < pixels; index += 1) {
      // Visibility of the sun here, 0 to 1.
      const lit = shadow ? shadow[index] / 255 : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const light = indirectAt(index, channel) + lit * sun[channel];
        // Rolls off towards white instead of hitting a wall at it, which is what
        // keeps the sunlit half of a map from turning into one flat shape.
        const mapped = 1 - Math.exp(-light * chosenExposure);
        if (mapped > 0.98) white += 1;
        const encoded = encodeSrgb(mapped);
        out[index * 3 + channel] = encoded;
        sum += encoded;
      }
    }

    const png = await sharp(out, {
      raw: { width, height, channels: 3 },
    })
      .resize(size, size, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    log(
      `baked lighting: ${width}² ${hdr ? "HDR " : ""}irradiance` +
        `${shadow ? " + sun shadows" : ""} -> ${size}², ` +
        `exposure ${chosenExposure.toFixed(2)}, ` +
        `mean ${(sum / (pixels * 3) / 255).toFixed(2)}, ` +
        `${((white / (pixels * 3)) * 100).toFixed(1)}% white, ` +
        `${(png.length / 1024).toFixed(0)} KB before webp`,
    );
    return { png, size, shadows: Boolean(shadow) };
  } finally {
    // The decompiled atlases are tens of megabytes and rebuild from the vpk in
    // seconds.
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};
