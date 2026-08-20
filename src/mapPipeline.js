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

import {
  mkdir,
  copyFile,
  open,
  rename,
  rm,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { trimMap } from "./trimMap.js";
import { buildLightmap } from "./mapLightmap.js";
import { readMaterialNames } from "./mapMaterialNames.js";
import { buildSky, readSkyName } from "./mapSky.js";
import { borrowCs2Materials } from "./cs2Materials.js";
import {
  cs2GameInfoPath,
  ensureCs2Assets,
  syncCs2Index,
} from "./cs2Content.js";
import { CS2_DIR } from "./config.js";
import { runTool as run } from "./toolProcess.js";

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

const MAP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WORKSHOP_ID_PATTERN = /^\d+$/;

const validateMapName = (mapName) => {
  if (typeof mapName !== "string" || !MAP_NAME_PATTERN.test(mapName)) {
    throw new TypeError(
      "mapName must be a non-empty map identifier containing only letters, digits, underscores, or hyphens",
    );
  }
};

const validateWorkshopId = (workshopId) => {
  if (typeof workshopId !== "string" || !WORKSHOP_ID_PATTERN.test(workshopId)) {
    throw new TypeError("workshopId must contain digits only");
  }
};

export const validateMapConversionInput = ({ mapName, workshopId }) => {
  validateMapName(mapName);
  validateWorkshopId(workshopId);
};

/**
 * Resolve a path below a caller-selected root and assert that it stays there.
 *
 * The identifier checks already prevent traversal through mapName/workshopId.
 * Keeping the containment check next to every output/destructive path makes that
 * safety property explicit if those names are ever loosened in the future.
 */
const containedPath = (root, ...parts) => {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, ...parts);
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`path escapes its configured root: ${path}`);
  }
  return path;
};

/**
 * What the compressor should do with the images in the file, if it has any.
 *
 * WebP over KTX2: every browser decodes it natively, where KTX2 needs a transcoder
 * shipped alongside the viewer. VRAM suffers, download does not.
 */
const textureCompressArgs = ({ withTextures, bakeLighting, textureSize }) => {
  if (withTextures) {
    return [
      "--texture-compress",
      "webp",
      "--texture-size",
      String(textureSize),
    ];
  }
  if (bakeLighting) {
    // The atlas was resized on the way in, so only the encoding is left to do. WebP
    // takes the baked lighting from 1.4 MB of PNG to about 150 KB.
    return ["--texture-compress", "webp"];
  }
  // A colour-only or grey map carries no image at all.
  return ["--texture-compress", "false"];
};

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
  containedPath(outputDir, `.${mapName}.tmp.glb`);

export const cleanupTemporaryGlb = (outputDir, mapName) => {
  validateMapName(mapName);
  return rm(temporaryGlbPath(outputDir, mapName), { force: true });
};

const requireTool = (path, name, hint) => {
  if (!existsSync(path)) {
    throw new Error(`${name} not found at ${path}. ${hint}`);
  }
  return path;
};

/** Where steamcmd puts a downloaded workshop item. Depends on its install dir. */
const workshopContentDir = (steamcmdRoot, workshopId) => {
  validateWorkshopId(workshopId);
  return containedPath(
    steamcmdRoot,
    "steamapps",
    "workshop",
    "content",
    STEAMCMD_APP_ID,
    workshopId,
  );
};

const cleanupConversionArtifacts = async ({
  mapName,
  workshopId,
  toolsDir,
}) => {
  const workDir = containedPath(toolsDir, "work");
  const steamRoot = containedPath(toolsDir, "steam-workshop");
  await Promise.all([
    rm(containedPath(workDir, "export", mapName), {
      recursive: true,
      force: true,
    }),
    rm(containedPath(workDir, "maps", `${mapName}.vpk`), { force: true }),
    rm(containedPath(workDir, "content", mapName), {
      recursive: true,
      force: true,
    }),
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
  //
  // Worth knowing when tuning this: keeping the meshes separate for the sake of
  // culling (see --join below) puts roughly 50% on every map, so a map that used to
  // land just inside this now needs simplification to get there, and simplification
  // is the one step that moves vertices.
  budgetBytes = 15_000_000,
  // Leaves and branches are millions of triangles a player runs straight through.
  // Turn this off if a map uses plants as climbable props.
  dropFoliage = true,
  // Export the map's own materials and textures, which the workshop item carries and
  // which are the closest thing to what a player actually sees. On by default; it
  // roughly doubles the conversion time, because every material and image has to be
  // decoded, and adds two vertex streams.
  withTextures = true,
  // Colour every surface from the material name the world was built with. The
  // names survive without the game files; the textures do not. See mapColours.js.
  withColours = false,
  // Multiply those colours by the map's own baked lighting, which the map does ship.
  // Real sun, real shadows, real corner darkening, one small texture for the whole
  // level. Implies withColours: the light is multiplied into the flat colour.
  // See mapLightmap.js.
  withLightmap = false,
  // Side of the baked lighting atlas. One image covers a whole map, so this is the
  // only thing between a 4096² source and a browser download: 4096 is 24 MB, 1024 is
  // about 150 KB, 512 about 70 KB and starts to bleed light across the seams
  // between one surface's patch of the atlas and the next.
  lightmapSize = 1024,
  // Write the map's real sky beside the .glb, as `<map>.sky.webp`. The map names it and
  // CS2 holds it, so this is the one step that needs anything from the game — one
  // archive part per distinct sky, cached under CS2_DIR. See mapSky.js.
  withSky = false,
  // Width of that image; the height is half, because it is equirectangular. 1024 is
  // about 5 KB: a sky is smooth, so there is nothing for WebP to spend bytes on.
  skySize = 1024,
  // Where the borrowed CS2 assets are cached. Only read when withSky is on.
  cs2Dir = CS2_DIR,
  // Only read when withTextures is on. Textures tile, so this is detail per repeat
  // rather than per map, and it is nearly free: on kz_victoria 128 is 2.8 MB, 256 is
  // 3.0 MB and 512 is 4.2 MB, because the cost is the vertex streams a texture needs
  // and not the images. 256 is where the mortar lines in a brick wall start reading;
  // 512 is the first step that costs real megabytes on a big map.
  textureSize = 256,
  // Delete the workshop download and the intermediate exports afterwards. One map
  // can be half a gigabyte of vpk plus a 250 MB raw glb, so converting all 85 of
  // them without this needs tens of gigabytes that are never read again.
  cleanup = true,
  log = () => {},
}) => {
  // Every build writes `<map>.glb`, whatever it was built with. A textured build used
  // to go to `<map>.textured.glb` so the experiment could be thrown away by deleting
  // files, but the viewer only ever looks for `<map>.glb`, so the flag produced a file
  // nothing could load.
  validateMapConversionInput({ mapName, workshopId });

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

    const workDir = containedPath(toolsDir, "work");
    const steamRoot = containedPath(toolsDir, "steam-workshop");
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

    // A workshop item is either one .vpk or a split archive, and a split one has to be
    // opened through its `_dir.vpk` index rather than through any of the parts. So the
    // index wins where there is one, and a lone .vpk is just as valid: kz_phamous
    // ships as `3104579274.vpk` and nothing else, and looking only for `_dir.vpk` is
    // why that map could never be converted.
    const vpks = (await readdir(itemDir)).filter((file) =>
      file.endsWith(".vpk"),
    );
    const outerVpk =
      vpks.find((file) => file.endsWith("_dir.vpk")) ??
      (vpks.length === 1 ? vpks[0] : null);
    if (!outerVpk) {
      throw new Error(
        vpks.length
          ? `${vpks.length} vpk parts in ${itemDir} but no _dir.vpk to open them with`
          : `no .vpk in ${itemDir}`,
      );
    }

    // 3a. The playable map is a VPK nested inside the workshop VPK.
    //
    // For a shapes-only build that one file is all we want. For a textured one it is
    // not enough: the mapper's own materials and models sit beside it in the workshop
    // item, and the exporter only finds them if the map is opened from inside a tree
    // that looks like a game — `game/csgo/maps/<map>.vpk` with `materials/` and
    // `models/` as siblings, and `gameinfo.gi` at the top of it.
    //
    // gameinfo.gi is what makes ValveResourceFormat believe it has found a game and
    // start resolving paths at all. Without it the export comes back with zero
    // materials and zero textures, which is exactly how this looked when the
    // conclusion was "the textures are not in the workshop item". They are; the
    // exporter just could not see them.
    const contentRoot = containedPath(workDir, "content", mapName);
    const gameDir = containedPath(contentRoot, "game", "csgo");
    let innerVpk;
    if (withTextures) {
      log("extracting the workshop item's maps, materials and models…");
      await rm(contentRoot, { recursive: true, force: true });
      await run(
        cli,
        ["-i", containedPath(itemDir, outerVpk), "-o", gameDir],
        BIG_OUTPUT,
      );
      await syncCs2Index({ cs2Dir, toolsDir, log });
      await copyFile(
        cs2GameInfoPath(cs2Dir),
        containedPath(gameDir, "gameinfo.gi"),
      );
      innerVpk = containedPath(gameDir, "maps", `${mapName}.vpk`);
    } else {
      log("extracting the inner map vpk…");
      await run(cli, [
        "-i",
        containedPath(itemDir, outerVpk),
        "-o",
        workDir,
        "-f",
        `maps/${mapName}.vpk`,
      ]);
      innerVpk = containedPath(workDir, "maps", `${mapName}.vpk`);
    }
    if (!existsSync(innerVpk)) {
      throw new Error(
        `expected maps/${mapName}.vpk inside the workshop item. The map may be published under a different internal name.`,
      );
    }

    // 3b. Which material every surface was built with.
    //
    // Read before the export, not after, because it is what says which materials the
    // exporter is about to come up short on. Wanted for three separate reasons: the flat
    // colour fallback, the choice of which surfaces the lighting atlas reaches, and the
    // list of base game materials to borrow.
    let materialNames = null;
    if (withColours || withLightmap || withTextures) {
      log("reading material names from the world nodes…");
      const named = await readMaterialNames({
        cli,
        mapVpk: innerVpk,
        mapName,
        workDir,
        log,
      });
      materialNames = named.byMesh;
      log(
        `the world names a material for ${materialNames.size} meshes, ` +
          `${named.paths.size} distinct`,
      );

      // The materials the mapper reused rather than made. Without these, a map built
      // out of the game's own concrete exports with nothing to draw on almost every
      // surface. See cs2Materials.js.
      if (withTextures) {
        await borrowCs2Materials({
          cli,
          cs2Dir,
          toolsDir,
          gameDir,
          paths: named.paths,
          log,
        }).catch((error) => {
          // Swallowed like the sky: a map with flat colours on its stock surfaces is
          // still worth having, and this reaches out to Steam, so it can fail for
          // reasons that have nothing to do with the map.
          log(`could not borrow the base game materials: ${error.message}`);
        });
      }
    }

    // 3c. Export the world. Shapes only unless textures were asked for, because
    // decoding every material and image is the slowest part of the whole pipeline.
    log(
      withTextures
        ? "exporting world geometry and materials to glTF…"
        : "exporting world geometry to glTF…",
    );
    const exportDir = containedPath(workDir, "export", mapName);
    // CLI 20.0 writes a single -f match to the exact -o path plus extension, so the
    // world lands beside exportDir as `<mapName>.glb` rather than inside it, with the
    // collision mesh as `<mapName>_physics.glb`. Clear both layouts so a stale file
    // can never be mistaken for this run's output.
    const flatGlb = containedPath(workDir, "export", `${mapName}.glb`);
    await Promise.all([
      rm(exportDir, { recursive: true, force: true }),
      rm(flatGlb, { force: true }),
      rm(containedPath(workDir, "export", `${mapName}_physics.glb`), {
        force: true,
      }),
    ]);
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
        ...(withTextures
          ? ["--gltf_export_materials", "--gltf_textures_adapt"]
          : []),
        "-o",
        exportDir,
      ],
      BIG_OUTPUT,
    );

    // Older CLIs nest the world under the -o directory; 20.0 writes it flat.
    const nested = containedPath(exportDir, "maps", mapName, "world.glb");
    const raw = existsSync(nested) ? nested : flatGlb;
    if (!existsSync(raw)) {
      throw new Error(`the exporter produced no world.glb for ${mapName}`);
    }
    // The flat layout skips creating exportDir, but the trim and optimize steps
    // still write their intermediates inside it.
    await mkdir(exportDir, { recursive: true });

    // 3d. The map's real sky, written beside the .glb rather than into it: glTF has no
    // slot for a scene background, and the viewer wants it as an equirectangular image
    // either way. Costs a few kilobytes, and one CS2 archive part the first time a
    // given sky is seen.
    let sky = null;
    if (withSky) {
      const skyName = await readSkyName({
        cli,
        mapVpk: innerVpk,
        mapName,
        workDir,
        log,
      });
      if (!skyName) {
        log("the map names no sky, so the viewer keeps its gradient");
      } else {
        const { missing } = await ensureCs2Assets({
          cs2Dir,
          toolsDir,
          cli,
          paths: [skyName],
          log,
        });
        if (missing.length) {
          log(`CS2 has no ${skyName}, so the viewer keeps its gradient`);
        } else {
          sky = await buildSky({
            cli,
            cs2Dir,
            skyName,
            workDir,
            size: skySize,
            log,
          });
        }
      }
    }

    // 4. Throw away what the viewer cannot show: unused vertex attributes, and
    // foliage. This is where nearly all of the size goes — on kz_moss it is 251 MB
    // down to 3 MB, because 95% of the triangles in that map are leaves — and unlike
    // simplification it does not move a single vertex.
    //
    // Textures and baked lighting are a pair, not alternatives: the mapper's own
    // surfaces, lit by the mapper's own sun. They address different things — one UV set
    // repeats a brick texture across a wall, the other finds that wall's patch of the
    // lighting atlas — so the trim pass keeps both, and the atlas ships as its own file
    // rather than inside the .glb, because glTF has no light map slot and the base
    // colour slot is taken by the mapper's texture.
    let lightmap = null;
    if (withLightmap) {
      log("baking out the map's own lighting…");
      lightmap = await buildLightmap({
        cli,
        mapVpk: innerVpk,
        mapName,
        workDir,
        size: lightmapSize,
        log,
      });
    }

    log("trimming attributes and foliage…");
    const trimmed = containedPath(exportDir, "world.trimmed.glb");
    const trim = await trimMap({
      input: raw,
      output: trimmed,
      dropFoliage,
      withTextures,
      materialNames,
      lightmap,
    });
    log(
      `dropped ${trim.meshesRemoved} foliage meshes (${((trim.trianglesRemoved / Math.max(trim.trianglesBefore, 1)) * 100).toFixed(0)}% of triangles) ` +
        `and ${trim.attributesDropped.length} unused attribute streams`,
    );
    if (trim.texturesFilledIn?.length) {
      log(
        `${trim.texturesFilledIn.length} texture(s) the exporter could not decode ` +
          `were filled in with neutral grey: ${trim.texturesFilledIn.join(", ")}`,
      );
    }
    if (trim.morphTargetsRemoved) {
      log(`dropped ${trim.morphTargetsRemoved} morph targets nothing animates`);
    }
    if (trim.untexturedMaterials || trim.untexturedSurfaces) {
      log(
        `${trim.untexturedSurfaces} surface(s) and ${trim.untexturedMaterials} material(s) ` +
          `had nothing to draw and fell back to a colour from their name`,
      );
    }
    if (trim.lightmap) {
      log(
        `baked lighting reaches ${trim.lightmap.lit} of ${trim.lightmap.lit + trim.lightmap.unlit} surfaces`,
      );
    }
    if (trim.colours) {
      const { palette, surfaces, named, matched } = trim.colours;
      log(
        `coloured ${surfaces} surfaces with ${palette} colours: ` +
          `${named} named by the world, ${matched} matched a rule, ` +
          `${surfaces - matched} left default grey`,
      );
    }
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

    const textures = textureCompressArgs({
      withTextures,
      bakeLighting: withLightmap,
      textureSize,
    });

    let best = null;
    for (const [index, attempt] of attempts.entries()) {
      const candidate = containedPath(exportDir, `world.opt${index}.glb`);
      await run(
        optimizer,
        [
          "optimize",
          packInput,
          candidate,
          "--compress",
          "meshopt",
          ...textures,
          // Flat colours are already the cheapest thing a material can be. Baking
          // them into a palette texture would add an image to a file that has one
          // already, and on a lightmapped map it would overwrite the lighting.
          ...(withColours || withLightmap ? ["--palette", "false"] : []),
          // Keep the lighting atlas's UVs. The optimizer prunes a vertex attribute
          // nothing in the file references, and nothing in the file does reference
          // this one: the atlas ships beside the .glb, because glTF has no light map
          // slot, and the viewer pairs the two up at load time. So the optimizer threw
          // away every map's baked lighting on the way out, which is why a textured
          // map arrived lit only by the viewer's own invented lights — flat, and far
          // darker than the same map in the game. Nothing else is kept by this: the
          // trim pass has already dropped every attribute that really is unused.
          "--prune-attributes",
          "false",
          // Do not weld the map into one shape. Joining every mesh that shares a
          // material sounds like a saving and is the opposite: the result is a
          // handful of shapes that each span the whole map, so nothing is ever off
          // screen and the whole level is drawn every frame. Keeping the exporter's
          // split (median mesh spans 0.7% of the map) lets the renderer throw away
          // what is behind the camera: on kz_victoria, 253k triangles a frame became
          // 76k, for 13 draw calls becoming 119 and 0.84 MB becoming 1.24 MB.
          "--join",
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

    const final = containedPath(outputDir, `${mapName}.glb`);
    temporaryOutput = temporaryGlbPath(outputDir, mapName);
    await copyFile(best?.path ?? raw, temporaryOutput);
    await validateGlb(temporaryOutput);
    await rename(temporaryOutput, final);
    temporaryOutput = null;

    // After the .glb, so a half-written conversion never leaves a sky with no map to
    // put it behind. The viewer treats a missing one as "no sky for this map".
    // The baked lighting, when the .glb could not carry it. Same reasoning as the sky:
    // a sibling file, and the viewer treating a missing one as "not lit".
    const lightPath = containedPath(outputDir, `${mapName}.light.webp`);
    // Only when it reaches something. A map can have a lightmap set and no surface that
    // addresses it — kz_dojo's reaches none of its 205 — and shipping 200 KB of atlas
    // that nothing can look up is both waste and a trap: the viewer used to attach it to
    // every textured material, including geometry with no atlas UV to look it up with,
    // and three.js throws out of the render loop when asked to draw that.
    if (lightmap && withTextures && trim.lightmap?.lit > 0) {
      await writeFile(
        lightPath,
        await sharp(lightmap.png).webp({ quality: 85 }).toBuffer(),
      );
    } else if (withLightmap) {
      await rm(lightPath, { force: true });
    }

    const skyPath = containedPath(outputDir, `${mapName}.sky.webp`);
    if (sky) {
      await writeFile(skyPath, sky.webp);
    } else if (withSky) {
      // A reconversion that looked for a sky and stopped finding one must not leave the
      // old one behind. Guarded on withSky, though: without that, a `--no-sky` build or
      // any caller that simply does not ask for a sky deletes the one already there,
      // and every nightly refresh would quietly strip the skies off every map.
      await rm(skyPath, { force: true });
    }

    if (cleanup) {
      // Both are reproducible from the workshop id, and both are enormous. The final
      // .glb has already been copied out, so nothing here is needed again.
      const { size } = await stat(final);
      await cleanupConversionArtifacts({ mapName, workshopId, toolsDir });
      log(`cleaned up, keeping ${(size / 1e6).toFixed(1)} MB`);
    }

    return {
      path: final,
      lightPath: lightmap && withTextures ? lightPath : null,
      skyPath: sky ? skyPath : null,
      sun: sky?.sun ?? null,
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
