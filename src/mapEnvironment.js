import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runTool } from "./toolProcess.js";

export const VRF_RENDER_REFERENCE = "00c629d321171ad0b9be83994c5e9cb15e8c5bd9";
export const VRF_19_2_REVISION = "c72208352f5bf62f1482447ed166c548f303f8fa";

/** VRF's .vents text format separates entities with numbered ==== delimiters. */
export const parseEntityDump = (text) =>
  text
    .split(/^====\d+====\s*$/m)
    .map((block) => {
      const entity = {};
      for (const line of block.split("\n")) {
        const match = /^([a-zA-Z_][\w]*)\s+(.+)$/.exec(line.trim());
        if (!match) continue;
        const raw = match[2].trim();
        if (raw.startsWith('"') && raw.endsWith('"'))
          entity[match[1]] = raw.slice(1, -1);
        else if (raw.startsWith("[")) {
          try {
            entity[match[1]] = JSON.parse(raw);
          } catch {
            entity[match[1]] = raw;
          }
        } else
          entity[match[1]] =
            raw === "true"
              ? true
              : raw === "false"
                ? false
                : Number.isFinite(Number(raw))
                  ? Number(raw)
                  : raw;
      }
      return entity;
    })
    .filter((entity) => entity.classname);

const vector = (value, fallback) => {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "")
        .trim()
        .split(/\s+/)
        .map(Number);
  return values.length === 3 && values.every(Number.isFinite)
    ? values
    : fallback;
};
const srgb = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

export const environmentFromDumps = (worldText, entities) => {
  // Restrict to the compiled lighting block; builder defaults occur earlier and differ.
  const lighting =
    worldText
      .split(/m_worldLightingInfo\s*=/)[1]
      ?.split(/m_entityLumps\s*=/)[0] ?? "";
  const number = (key) =>
    Number(new RegExp(`${key}\\s*=\\s*([\\d.-]+)`).exec(lighting)?.[1]);
  const uvMatch =
    /m_vLightmapUvScale\s*=\s*\[\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)/.exec(
      lighting,
    );
  const version = [
    number("m_nLightmapVersionNumber"),
    number("m_nLightmapGameVersionNumber"),
  ];
  const uvScale = uvMatch ? uvMatch.slice(1, 3).map(Number) : [1, 1];
  const enabled = (value) => value !== false && value !== 0 && value !== "0";
  const lights = entities.filter(
    (e) => e.classname === "light_environment" && enabled(e.enabled),
  );
  let sun = null;
  if (
    version[0] === 8 &&
    [2, 3, 4].includes(version[1]) &&
    lights.length === 1
  ) {
    const light = lights[0];
    const angles = vector(light.angles, null);
    const color = vector(light.color, null);
    const brightness =
      Number(light.brightness ?? 1) * Number(light.brightnessscale ?? 1);
    const channel = Number(
      light.bakedshadowindex ?? light.bakelightindex ?? -1,
    );
    if (
      angles &&
      color &&
      brightness >= 0 &&
      Number.isFinite(brightness) &&
      Number.isInteger(channel) &&
      channel >= 0 &&
      channel < 4
    ) {
      const [pitch, yaw] = angles.map((angle) => (angle * Math.PI) / 180);
      // Negated Source forward points toward the sun; (x,z,-y) is replay render space.
      sun = {
        direction: [
          -Math.cos(pitch) * Math.cos(yaw),
          Math.sin(pitch),
          Math.cos(pitch) * Math.sin(yaw),
        ],
        color: color.map((value) => srgb(value / 255) * brightness),
        shadowMask: [0, 1, 2, 3].map((i) => Number(i === channel)),
        renderDiffuse: enabled(light.renderdiffuse),
        renderSpecular:
          light.renderspecular === undefined ||
          Number(light.renderspecular) === 1,
      };
    }
  }
  return {
    referenceRevision: VRF_RENDER_REFERENCE,
    lightmapVersion: version.map((v) => (Number.isFinite(v) ? v : null)),
    lightmapUvScale: uvScale,
    sun,
    entities: entities.filter((e) =>
      /^(light_|env_(sky|.*fog|.*probe|cubemap)|sky_camera)/.test(e.classname),
    ),
    limitations: [
      "runtime-light-state",
      "local-light-shadows",
      "reflection-probes",
      "light-probe-volumes",
      "3d-skybox",
    ],
  };
};

export const readMapEnvironment = async ({ cli, mapVpk, mapName, workDir }) => {
  const out = join(workDir, "environment", mapName);
  await mkdir(out, { recursive: true });
  const { stdout } = await runTool(
    cli,
    ["-i", mapVpk, "-f", `maps/${mapName}/world.vwrld_c`, "-b", "DATA"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  await runTool(
    cli,
    [
      "-i",
      mapVpk,
      "-f",
      `maps/${mapName}/entities/`,
      "-e",
      "vents_c",
      "-d",
      "-o",
      out,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const entityDir = join(out, "maps", mapName, "entities");
  const entities = [];
  for (const file of await readdir(entityDir))
    if (file.endsWith(".vents"))
      entities.push(
        ...parseEntityDump(await readFile(join(entityDir, file), "utf8")),
      );
  return environmentFromDumps(stdout, entities);
};
