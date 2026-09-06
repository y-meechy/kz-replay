// Preserve the source sky's HDR pixels. VRF exports its cubemap to latlong EXR;
// exposure belongs to the final renderer, after sky and surfaces share a scene.

import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { cs2IndexPath } from "./cs2Content.js";
import { runTool as run } from "./toolProcess.js";

const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

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
      log("this map has no entity lump, so the sky stays the default gradient");
      return null;
    }
    for (const file of files) {
      if (!file.endsWith(".vents")) continue;
      const text = await readFile(join(entityDir, file), "latin1");
      const match = /skyname\s+"([^"]+\.vmat)"/i.exec(text);
      if (match) return match[1];
    }
    return null;
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};

export const readSkyMaterial = (text) => {
  const scalar = (key) => {
    const quoted = new RegExp(`"${key}"\\s+"([^"\\n]+)"`).exec(text);
    const compiled = new RegExp(
      `m_name\\s*=\\s*"${key}"[\\s\\S]*?m_flValue\\s*=\\s*([-+0-9.eE]+)`,
    ).exec(text);
    const match = quoted ?? compiled;
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  const match =
    /"g_vTint"\s+"\[([^\]]+)\]"/.exec(text) ??
    /m_name\s*=\s*"g_vTint"[\s\S]*?m_value\s*=\s*\[([^\]]+)\]/.exec(text);
  const tint = match
    ? match[1]
        .trim()
        .split(/[\s,]+/)
        .slice(0, 3)
        .map(Number)
    : [1, 1, 1];
  return {
    brightnessExposureBias: scalar("g_flBrightnessExposureBias"),
    renderOnlyExposureBias: scalar("g_flRenderOnlyExposureBias"),
    tint: tint.length === 3 && tint.every(Number.isFinite) ? tint : [1, 1, 1],
  };
};

export const readCompiledSkyTexture = (text) => {
  const match =
    /m_name\s*=\s*"g_tSkyTexture"[\s\S]*?m_pValue\s*=\s*resource:"([^"]+\.vtex)"/.exec(
      text,
    );
  return match?.[1] ?? null;
};

/**
 * Extract the unmodified HDR sky and the material's authored multipliers.
 *
 * @param cs2Dir the local CS2 content cache, holding the sky's archive part
 * @returns EXR plus explicit encoding/projection, or null if unavailable.
 * Entity sky rotation/tint and source light entities still require separate extraction.
 */
export const buildSky = async ({
  cli,
  cs2Dir,
  gameDir = null,
  skyName,
  workDir,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "sky");
  await rm(dumpDir, { recursive: true, force: true });

  try {
    const localMaterial = gameDir && join(gameDir, `${skyName}_c`);
    // Reading DATA does not load the shader. That matters when a map contains a newer
    // VCS version than the pinned exporter understands: ordinary material decompilation
    // fails before it can reach an otherwise supported HDR texture.
    const { stdout: materialData } = await run(
      cli,
      localMaterial && existsSync(localMaterial)
        ? ["-i", localMaterial, "-b", "DATA"]
        : ["-i", cs2IndexPath(cs2Dir), "-f", `${skyName}_c`, "-b", "DATA"],
      BIG_OUTPUT,
    );
    const textureName = readCompiledSkyTexture(materialData);
    if (!textureName) {
      log(
        `the sky ${skyName} names no supported HDR texture, keeping the gradient`,
      );
      return null;
    }
    const textureBase = textureName.replace(/\.vtex$/i, "");
    const localTexture = gameDir && join(gameDir, `${textureName}_c`);
    await run(
      cli,
      localTexture && existsSync(localTexture)
        ? [
            "-i",
            localTexture,
            "-d",
            "--texture_decode_flags",
            "none",
            "-o",
            join(dumpDir, `${textureName}`),
          ]
        : [
            "-i",
            cs2IndexPath(cs2Dir),
            "-f",
            `${textureName}_c`,
            "-d",
            "--texture_decode_flags",
            "none",
            "-o",
            dumpDir,
          ],
      BIG_OUTPUT,
    );

    const exrPath = join(dumpDir, `${textureBase}.exr`);
    if (!existsSync(exrPath)) {
      log(`the sky ${skyName} is not in the CS2 cache, keeping the gradient`);
      return null;
    }

    const material = readSkyMaterial(materialData);

    const file = await readFile(exrPath);
    const { width, height } = new EXRLoader().parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    if (width !== height * 2)
      throw new Error("Sky EXR is not a 2:1 latlong image");
    log(
      `sky ${skyName}: preserved ${width}×${height} HDR EXR, ${(file.length / 1024).toFixed(0)} KB`,
    );
    return {
      exr: file,
      width,
      height,
      encoding: "exr-linear",
      projection: "vrf-latlong",
      material,
      // A sky material's SolarPosition is not the world's light_environment.
      sun: null,
    };
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }
};
