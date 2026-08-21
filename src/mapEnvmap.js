// The map's own baked reflections, as one small equirectangular image.
//
// A compiled world ships `maps/<map>/cubemaps/env_cubemap_array.vtex_c`: the HDR
// cubemaps the game samples for specular reflections, one per probe volume. Real
// per-volume assignment needs the game's shaders; what a browser viewer can use is
// one representative environment, and even that beats lighting metal with the sky —
// indoors the sky is the one thing a reflection should not show.
//
// The decompiler writes the array as one EXR per face, six faces per cubemap, named
// `env_cubemap_array_f00.exr` onward. The first cubemap is used; face order is
// assumed +X -X +Y -Y +Z -Z, which is what the exporter emits for D3D-style arrays.
// The result is tone mapped exactly like the sky and written beside the map as
// `<map>.env.webp` for three.js to use as scene.environment.

import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { HALF_TO_FLOAT, encodeSrgb, exposureFor } from "./tonemap.js";
import { runTool as run } from "./toolProcess.js";

const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

// Same idea as the sky's exposure, and the same target: reflections should read,
// not glow brighter than the run drawn over them.
const ENV_PERCENTILE = 0.99;
const ENV_TARGET = 0.72;

const readExr = async (path) => {
  const file = await readFile(path);
  const { data, width, height } = new EXRLoader().parse(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  );
  const half = !(data instanceof Float32Array);
  return {
    width,
    height,
    at: (index) => (half ? HALF_TO_FLOAT[data[index]] : data[index]),
  };
};

/**
 * Build the map's environment image from its baked cubemap array.
 *
 * @returns { webp, width, height } or null when the map bakes no cubemaps.
 */
export const buildEnvmap = async ({
  cli,
  mapVpk,
  mapName,
  workDir,
  size = 512,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "envmap");
  await rm(dumpDir, { recursive: true, force: true });
  try {
    await run(
      cli,
      [
        "-i",
        mapVpk,
        "-f",
        `maps/${mapName}/cubemaps/env_cubemap_array`,
        "-d",
        "-o",
        dumpDir,
      ],
      BIG_OUTPUT,
    ).catch(() => {});

    const facePath = (face) =>
      join(
        dumpDir,
        "maps",
        mapName,
        "cubemaps",
        `env_cubemap_array_f${String(face).padStart(2, "0")}.exr`,
      );
    if (!existsSync(facePath(5))) {
      log("the map bakes no cubemaps, so reflections stay on the sky");
      return null;
    }
    const faces = [];
    for (let face = 0; face < 6; face += 1) {
      faces.push(await readExr(facePath(face)));
    }
    const faceSize = faces[0].width;

    // Cube lookup: the dominant axis picks the face, the other two coordinates
    // index into it. Face UV conventions per the D3D cubemap spec.
    const sampleCube = (x, y, z, channel) => {
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      const az = Math.abs(z);
      let face;
      let u;
      let v;
      if (ax >= ay && ax >= az) {
        face = x > 0 ? 0 : 1;
        u = x > 0 ? -z / ax : z / ax;
        v = -y / ax;
      } else if (ay >= az) {
        face = y > 0 ? 2 : 3;
        u = x / ay;
        v = y > 0 ? z / ay : -z / ay;
      } else {
        face = z > 0 ? 4 : 5;
        u = z > 0 ? x / az : -x / az;
        v = -y / az;
      }
      const px = Math.min(
        faceSize - 1,
        Math.max(0, Math.round(((u + 1) / 2) * (faceSize - 1))),
      );
      const py = Math.min(
        faceSize - 1,
        Math.max(0, Math.round(((v + 1) / 2) * (faceSize - 1))),
      );
      return faces[face].at((py * faceSize + px) * 4 + channel);
    };

    // Project onto an equirectangular image, the shape three.js already consumes
    // for the sky. Y is up here to match the viewer's world.
    const width = size;
    const height = Math.round(size / 2);
    const linear = new Float32Array(width * height * 3);
    for (let row = 0; row < height; row += 1) {
      const lat = (0.5 - (row + 0.5) / height) * Math.PI;
      for (let col = 0; col < width; col += 1) {
        const lon = ((col + 0.5) / width - 0.5) * 2 * Math.PI;
        const x = Math.cos(lat) * Math.sin(lon);
        const y = Math.sin(lat);
        const z = -Math.cos(lat) * Math.cos(lon);
        const index = (row * width + col) * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          linear[index + channel] = sampleCube(x, y, z, channel);
        }
      }
    }

    const pixels = width * height;
    const exposure = exposureFor(
      (index) =>
        0.2126 * linear[index * 3] +
        0.7152 * linear[index * 3 + 1] +
        0.0722 * linear[index * 3 + 2],
      pixels,
      ENV_PERCENTILE,
      ENV_TARGET,
    );
    const out = Buffer.allocUnsafe(pixels * 3);
    for (let index = 0; index < pixels * 3; index += 1) {
      out[index] = encodeSrgb(1 - Math.exp(-linear[index] * exposure));
    }
    const webp = await sharp(out, { raw: { width, height, channels: 3 } })
      .webp({ quality: 88 })
      .toBuffer();
    log(
      `reflections: ${faceSize}² HDR cubemap -> ${width}×${height}, ` +
        `exposure ${exposure.toFixed(2)}, ${(webp.length / 1024).toFixed(0)} KB`,
    );
    return { webp, width, height };
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};
