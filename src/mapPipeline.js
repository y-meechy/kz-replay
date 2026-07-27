// Turn a CS2KZ map name into a web-sized .glb of its geometry.
//
// Four steps, none of which need the game installed or a Steam account:
//
//   1. Ask the CS2KZ API for the map's Steam Workshop id.
//   2. steamcmd, logged in anonymously, downloads the workshop item. Anonymous
//      downloads work for CS2 workshop maps, which is what makes this whole thing
//      automatable on a server.
//   3. The workshop item is a VPK containing another VPK. Source2Viewer-CLI
//      (ValveResourceFormat) extracts the inner one and exports the world to glTF.
//   4. gltf-transform shrinks it. kz_victoria goes 26.5 MB -> 5.9 MB.
//
// Alignment with a replay is handled in the viewer, not here: see the two
// correction constants in viewer/src/player.js.

import { execFile } from "node:child_process";
import {
  mkdir,
  copyFile,
  open,
  rename,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { trimMap } from "./trimMap.js";

const run = promisify(execFile);

const STEAMCMD_APP_ID = "730";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GLTF_TRANSFORM = join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  "gltf-transform",
);

// The exporter and the compressor both print a lot; the default 1 MB pipe buffer
// overflows and the step fails with a maxBuffer error instead of a real one.
const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

export const validateGlb = async (path) => {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const { size } = await handle.stat();
    const declaredLength = header.readUInt32LE(8);

    if (
      bytesRead !== header.length ||
      size < 20 ||
      header.toString("ascii", 0, 4) !== "glTF" ||
      header.readUInt32LE(4) !== 2 ||
      declaredLength !== size
    ) {
      throw new Error(
        `invalid GLB ${path}: expected a complete version 2 GLB, got ${size} bytes with ${declaredLength} declared`,
      );
    }
  } finally {
    await handle.close();
  }
};

const temporaryGlbPath = (outputDir, mapName) =>
  join(outputDir, `.${mapName}.tmp.glb`);

export const cleanupTemporaryGlb = (outputDir, mapName) =>
  rm(temporaryGlbPath(outputDir, mapName), { force: true });

const requireTool = (path, name, hint) => {
  if (!existsSync(path)) {
    throw new Error(`${name} not found at ${path}. ${hint}`);
  }
  return path;
};

/** Where steamcmd puts a downloaded workshop item. Depends on its install dir. */
const workshopContentDir = (steamcmdRoot, workshopId) =>
  join(
    steamcmdRoot,
    "steamapps",
    "workshop",
    "content",
    STEAMCMD_APP_ID,
    workshopId,
  );

const cleanupConversionArtifacts = async ({
  mapName,
  workshopId,
  toolsDir,
}) => {
  const workDir = join(toolsDir, "work");
  const steamRoot = join(toolsDir, "steam-workshop");
  await Promise.all([
    rm(join(workDir, "export", mapName), { recursive: true, force: true }),
    rm(join(workDir, "maps", `${mapName}.vpk`), { force: true }),
    rm(workshopContentDir(steamRoot, workshopId), {
      recursive: true,
      force: true,
    }),
    rm(workshopContentDir(steamRoot.toLowerCase(), workshopId), {
      recursive: true,
      force: true,
    }),
  ]);
};

export const convertMap = async ({
  mapName,
  workshopId,
  toolsDir,
  outputDir,
  steamcmd = "steamcmd",
  // Rough ceiling for a file a browser should download. Not a hard limit: a map
  // that cannot get under it is still shipped, with a note.
  budgetBytes = 15_000_000,
  // Leaves and branches are millions of triangles a player runs straight through.
  // Turn this off if a map uses plants as climbable props.
  dropFoliage = true,
  // Delete the workshop download and the intermediate exports afterwards. One map
  // can be half a gigabyte of vpk plus a 250 MB raw glb, so converting all 85 of
  // them without this needs tens of gigabytes that are never read again.
  cleanup = true,
  log = () => {},
}) => {
  let temporaryOutput = null;
  try {
    await mkdir(outputDir, { recursive: true });
    await cleanupTemporaryGlb(outputDir, mapName);

    const cli = requireTool(
      join(toolsDir, "Source2Viewer-CLI"),
      "Source2Viewer-CLI",
      "Download the CLI archive for this platform from the ValveResourceFormat releases into tools/.",
    );
    const optimizer = requireTool(
      GLTF_TRANSFORM,
      "gltf-transform",
      "Run npm install before converting maps.",
    );

    const workDir = join(toolsDir, "work");
    const steamRoot = join(toolsDir, "steam-workshop");
    await mkdir(workDir, { recursive: true });

    // 1 + 2. Download the workshop item.
    log(`downloading workshop item ${workshopId} (anonymous)…`);
    await run(steamcmd, [
      "+force_install_dir",
      steamRoot,
      "+login",
      "anonymous",
      "+workshop_download_item",
      STEAMCMD_APP_ID,
      workshopId,
      "+quit",
    ]);

    // steamcmd resolves force_install_dir against its own prefix, so find the item
    // rather than assuming where it landed.
    const candidates = [
      workshopContentDir(steamRoot, workshopId),
      workshopContentDir(steamRoot.toLowerCase(), workshopId),
    ];
    const itemDir = candidates.find((dir) => existsSync(dir));
    if (!itemDir) {
      throw new Error(
        `steamcmd reported success but no content directory was found. Looked in:\n  ${candidates.join("\n  ")}`,
      );
    }

    const outerVpk = (await readdir(itemDir)).find((file) =>
      file.endsWith("_dir.vpk"),
    );
    if (!outerVpk) {
      throw new Error(`no *_dir.vpk in ${itemDir}`);
    }

    // 3a. The playable map is a VPK nested inside the workshop VPK.
    log("extracting the inner map vpk…");
    await run(cli, [
      "-i",
      join(itemDir, outerVpk),
      "-o",
      workDir,
      "-f",
      `maps/${mapName}.vpk`,
    ]);
    const innerVpk = join(workDir, "maps", `${mapName}.vpk`);
    if (!existsSync(innerVpk)) {
      throw new Error(
        `expected maps/${mapName}.vpk inside the workshop item. The map may be published under a different internal name.`,
      );
    }

    // 3b. Export the world. No materials: we want shapes, not textures.
    log("exporting world geometry to glTF…");
    const exportDir = join(workDir, "export", mapName);
    await rm(exportDir, { recursive: true, force: true });
    await run(
      cli,
      [
        "-i",
        innerVpk,
        "-f",
        `maps/${mapName}/world.vwrld_c`,
        "-d",
        "--gltf_export_format",
        "glb",
        "-o",
        exportDir,
      ],
      BIG_OUTPUT,
    );

    const raw = join(exportDir, "maps", mapName, "world.glb");
    if (!existsSync(raw)) {
      throw new Error(`the exporter produced no world.glb for ${mapName}`);
    }

    // 4. Throw away what the viewer cannot show: unused vertex attributes, and
    // foliage. This is where nearly all of the size goes — on kz_moss it is 251 MB
    // down to 3 MB, because 95% of the triangles in that map are leaves — and unlike
    // simplification it does not move a single vertex.
    log("trimming attributes and foliage…");
    const trimmed = join(exportDir, "world.trimmed.glb");
    const trim = await trimMap({ input: raw, output: trimmed, dropFoliage });
    log(
      `dropped ${trim.meshesRemoved} foliage meshes (${((trim.trianglesRemoved / Math.max(trim.trianglesBefore, 1)) * 100).toFixed(0)}% of triangles) ` +
        `and ${trim.attributesDropped.length} unused attribute streams`,
    );
    const packInput = existsSync(trimmed) ? trimmed : raw;

    // 5. Shrink, escalating only as far as needed.
    //
    // Map sizes vary enormously: kz_victoria exports at 27 MB, kz_moss at 251 MB.
    // Lossless packing alone leaves the big ones far too heavy for a browser, and
    // mesh simplification moves vertices, so it is worth avoiding when it is not
    // needed. Each attempt is therefore tried in order and the first one inside the
    // budget wins, which means small maps keep their exact geometry.
    log("compressing…");
    const attempts = [
      { label: "lossless", simplifyError: null },
      { label: "light simplification", simplifyError: 0.001 },
      { label: "harder simplification", simplifyError: 0.004 },
    ];

    let best = null;
    for (const [index, attempt] of attempts.entries()) {
      const candidate = join(exportDir, `world.opt${index}.glb`);
      await run(
        optimizer,
        [
          "optimize",
          packInput,
          candidate,
          "--compress",
          "meshopt",
          "--texture-compress",
          "false",
          "--simplify",
          attempt.simplifyError === null ? "false" : "true",
          ...(attempt.simplifyError === null
            ? []
            : ["--simplify-error", String(attempt.simplifyError)]),
        ],
        BIG_OUTPUT,
      );

      if (!existsSync(candidate)) continue;
      const { size } = await stat(candidate);
      best = { path: candidate, size, ...attempt };
      log(`${attempt.label}: ${(size / 1e6).toFixed(1)} MB`);
      if (size <= budgetBytes) break;
    }

    if (!best) {
      // Exit code said success but nothing was written. Shipping the raw export is
      // better than failing, but it is far larger, so say so.
      log("compression produced no file — shipping the uncompressed export");
    } else if (best.size > budgetBytes) {
      log(
        `still ${(best.size / 1e6).toFixed(1)} MB, over the ${(budgetBytes / 1e6).toFixed(0)} MB budget — shipping it anyway`,
      );
    }

    const final = join(outputDir, `${mapName}.glb`);
    temporaryOutput = temporaryGlbPath(outputDir, mapName);
    await copyFile(best?.path ?? raw, temporaryOutput);
    await validateGlb(temporaryOutput);
    await rename(temporaryOutput, final);
    temporaryOutput = null;

    if (cleanup) {
      // Both are reproducible from the workshop id, and both are enormous. The final
      // .glb has already been copied out, so nothing here is needed again.
      const { size } = await stat(final);
      await cleanupConversionArtifacts({ mapName, workshopId, toolsDir });
      log(`cleaned up, keeping ${(size / 1e6).toFixed(1)} MB`);
    }

    return {
      path: final,
      rawPath: cleanup ? null : raw,
      simplifyError: best?.simplifyError ?? null,
    };
  } catch (error) {
    if (cleanup) {
      await cleanupConversionArtifacts({ mapName, workshopId, toolsDir }).catch(
        (cleanupError) => log(`cleanup also failed: ${cleanupError.message}`),
      );
      log("cleaned up the failed conversion");
    }
    throw error;
  } finally {
    if (temporaryOutput) {
      await rm(temporaryOutput, { force: true }).catch((cleanupError) =>
        log(`temporary output cleanup failed: ${cleanupError.message}`),
      );
    }
  }
};
