// The map's real sky, as one small image.
//
// Every CS2 map names its sky outright. The entity lump is plain text and carries
//
//     skyname   "materials/skybox/sky_de_annubis.vmat"
//
// and that material is a Source 2 `sky.vfx` whose one texture is a 2048×1024 HDR image
// in equirectangular projection — the same projection three.js wants for a scene
// background, and the same one the viewer's invented gradient already fakes. So this is
// a straight swap of a guess for the real thing.
//
// It is also almost free. The sky is smooth, so at 1024×512 as WebP it lands around
// 5 KB. The atlas of baked lighting costs fifty times more.
//
// The one catch: skies are base game assets, not map assets, so this needs the CS2
// content cache. See cs2Content.js — a sky costs one 105 MB archive part, once, and
// several maps share the same sky.

import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { cs2IndexPath } from "./cs2Content.js";
import { HALF_TO_FLOAT, encodeSrgb } from "./tonemap.js";
import { runTool as run } from "./toolProcess.js";

const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

/**
 * Where the sky's brightest part should land.
 *
 * Lower than the ceiling the baked lighting aims for. A sky fills the top half of every
 * outdoor shot, and the run is drawn over it in bright speed colours: pushed to white it
 * becomes the brightest thing on screen and the run stops reading against it. The
 * project's invented gradient was dim on purpose for exactly this reason.
 */
const SKY_PERCENTILE = 0.99;
const SKY_TARGET = 0.72;

/**
 * The sky material a map asks for.
 *
 * Read out of the entity lump, which the decompiler writes as plain text key/value
 * pairs. A map with no `skyname` gets null and keeps the gradient.
 *
 * @returns e.g. "materials/skybox/sky_de_annubis.vmat", or null
 */
export const readSkyName = async ({
  cli,
  mapVpk,
  mapName,
  workDir,
  log = () => {},
}) => {
  const texts = await readEntityLumps({ cli, mapVpk, mapName, workDir });
  if (!texts.length) {
    log("this map has no entity lump, so the sky stays the default gradient");
    return null;
  }
  for (const text of texts) {
    const match = /skyname\s+"([^"]+\.vmat)"/i.exec(text);
    if (match) return match[1];
  }
  return null;
};

/** The decompiled entity lump(s), as plain text. Empty when the map has none. */
const readEntityLumps = async ({ cli, mapVpk, mapName, workDir }) => {
  const dumpDir = join(workDir, "entities", mapName);
  await rm(dumpDir, { recursive: true, force: true });
  try {
    // Swallowed, like every other step in here: a map is worth having without its sky,
    // and the viewer's own gradient is a perfectly good fallback. Left to throw, one
    // map with an entity lump the decompiler chokes on would fail the whole conversion.
    await run(
      cli,
      ["-i", mapVpk, "-f", `maps/${mapName}/entities/`, "-d", "-o", dumpDir],
      BIG_OUTPUT,
    ).catch(() => {});
    const entityDir = join(dumpDir, "maps", mapName, "entities");
    let files = [];
    try {
      files = await readdir(entityDir);
    } catch {
      return [];
    }
    const texts = [];
    for (const file of files) {
      if (!file.endsWith(".vents")) continue;
      texts.push(await readFile(join(entityDir, file), "latin1"));
    }
    return texts;
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * The map's own lamp entities, for the viewer to relight.
 *
 * The baked atlas carries only what the compiler put in it — for these lights that
 * is their bounce, not their direct throw — so a room lit by lamps comes out flat
 * without them. Only `light_omni2` for now: it is what CS2 maps overwhelmingly use.
 *
 * @returns [{ origin: [x,y,z], color: [r,g,b] 0-255, lumens, range }]
 */
export const readLights = async ({ cli, mapVpk, mapName, workDir }) => {
  const texts = await readEntityLumps({ cli, mapVpk, mapName, workDir });
  const lights = [];
  for (const text of texts) {
    // Blocks are key/value lines; a classname line opens a new entity.
    for (const block of text.split(/classname\s+/)) {
      if (!block.startsWith('"light_omni2"')) continue;
      if (field(block, "enabled") === "false") continue;
      const origin = field(block, "origin")?.split(/\s+/).map(Number);
      const lumens = Number(field(block, "brightness_lumens"));
      if (origin?.length !== 3 || !(lumens > 0)) continue;
      // Colours are the one bracketed value in here: color [255, 200, 160].
      const color = /\bcolor\s+\[([^\]]+)\]/
        .exec(block)?.[1]
        .split(",")
        .map(Number);
      lights.push({
        origin,
        color: color ?? [255, 255, 255],
        lumens,
        range: Number(field(block, "range")),
      });
    }
  }
  return lights;
};

/** One plain key/value out of an entity block, or null when it has no such key. */
const field = (block, key) => {
  const match = new RegExp(`\\b${key}\\s+"?([^"\\n]+)"?`).exec(block);
  return match ? match[1].trim() : null;
};

/** Exposure that puts the sky's bright end on SKY_TARGET. Same idea as the lightmap. */
const exposureFor = (sample, count) => {
  const BINS = 4096;
  const SCALE = BINS / 64;
  const histogram = new Uint32Array(BINS + 1);
  for (let index = 0; index < count; index += 1) {
    histogram[Math.min(BINS, Math.max(0, (sample(index) * SCALE) | 0))] += 1;
  }
  const target = count * SKY_PERCENTILE;
  let running = 0;
  let bin = 0;
  for (; bin < histogram.length; bin += 1) {
    running += histogram[bin];
    if (running >= target) break;
  }
  const bright = Math.max((bin + 0.5) / SCALE, 0.05);
  return -Math.log(1 - SKY_TARGET) / bright;
};

/**
 * Decode, tone map and shrink a map's sky.
 *
 * @param cs2Dir the local CS2 content cache, holding the sky's archive part
 * @param size   width of the result; height is half, because equirectangular
 * @returns { webp, width, height, sun } or null when the sky cannot be read.
 *          `sun` is the map's real sun — direction and colour — which the sky material
 *          carries as SolarPosition and SolarIrradiance.
 */
export const buildSky = async ({
  cli,
  cs2Dir,
  skyName,
  workDir,
  size = 1024,
  // Where to read the sky from: the CS2 content cache by default, or the unpacked
  // workshop tree for the custom skies mappers ship inside the item itself.
  input = null,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "sky");
  await rm(dumpDir, { recursive: true, force: true });

  try {
    // Without the `.vmat` suffix, so the filter also catches the compiled texture the
    // material points at.
    const base = skyName.replace(/\.vmat$/i, "");
    await run(
      cli,
      [
        "-i",
        input ?? cs2IndexPath(cs2Dir),
        // Folder input (the unpacked workshop tree) needs the recursive scan; the
        // filter still applies, the CLI just refuses a bare folder without it.
        ...(input ? ["--recursive"] : []),
        "-f",
        base,
        "-d",
        "-o",
        dumpDir,
      ],
      BIG_OUTPUT,
    ).catch(() => {});

    const exrPath = join(dumpDir, `${base}.exr`);
    const materialPath = join(dumpDir, `${base}.vmat`);
    if (!existsSync(exrPath)) {
      log(`the sky ${skyName} is not there, keeping the gradient`);
      return null;
    }

    // The material states the real sun. Worth carrying out of here even though the
    // background does not need it: every sun in this project is otherwise invented.
    let sun = null;
    if (existsSync(materialPath)) {
      const text = await readFile(materialPath, "utf8");
      const vector = (key) => {
        const match = new RegExp(`"${key}"\\s+"\\[([^\\]]+)\\]"`).exec(text);
        return match
          ? match[1].trim().split(/\s+/).slice(0, 3).map(Number)
          : null;
      };
      const direction = vector("SolarPosition");
      const irradiance = vector("SolarIrradiance");
      if (direction && irradiance) sun = { direction, irradiance };
    }

    const file = await readFile(exrPath);
    const { data, width, height } = new EXRLoader().parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    const half = !(data instanceof Float32Array);
    const at = (index) => (half ? HALF_TO_FLOAT[data[index]] : data[index]);

    const pixels = width * height;
    // Sampled on luminance, so a bright blue sky and a bright grey one expose alike.
    const exposure = exposureFor(
      (index) =>
        0.2126 * at(index * 4) +
        0.7152 * at(index * 4 + 1) +
        0.0722 * at(index * 4 + 2),
      pixels,
    );

    const out = Buffer.allocUnsafe(pixels * 3);
    for (let index = 0; index < pixels; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const light = at(index * 4 + channel);
        out[index * 3 + channel] = encodeSrgb(1 - Math.exp(-light * exposure));
      }
    }

    // Half the width, because an equirectangular image covers 360° across and 180° up.
    const outHeight = Math.round(size / 2);
    const webp = await sharp(out, { raw: { width, height, channels: 3 } })
      .resize(size, outHeight, { kernel: "lanczos3" })
      .webp({ quality: 88 })
      .toBuffer();

    log(
      `sky ${skyName}: ${width}×${height} HDR -> ${size}×${outHeight}, ` +
        `exposure ${exposure.toFixed(2)}, ${(webp.length / 1024).toFixed(0)} KB` +
        (sun ? ", and the map's own sun" : ""),
    );
    return { webp, width: size, height: outHeight, sun };
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};
