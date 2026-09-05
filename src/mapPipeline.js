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
  rm,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { trimMap } from "./trimMap.js";
import {
  readMapEnvironment,
  VRF_19_2_REVISION,
  VRF_RENDER_REFERENCE,
} from "./mapEnvironment.js";
import {
  fingerprintFile,
  MAP_PIPELINE_VERSION,
  publishMapAssets,
} from "./mapAssets.js";
import { qualityReductions, resolveMapQuality } from "./mapQuality.js";
import { buildLightmap } from "./mapLightmap.js";
import { createSourceTextureReader } from "./sourceMaterialRepair.js";
import { readMaterialNames } from "./mapMaterialNames.js";
import { buildSky, readSkyName } from "./mapSky.js";
import { borrowCs2Materials } from "./cs2Materials.js";
import { prepareCs2Shaders } from "./cs2Shaders.js";
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
const textureCompressArgs = ({ withTextures, textureSize }) => {
  if (withTextures && textureSize) {
    return [
      "--texture-compress",
      "webp",
      "--texture-size",
      String(textureSize),
    ];
  }
  // Fidelity builds preserve source texture encodings and dimensions. A caller who
  // supplies textureSize has explicitly selected WebP/downscaling above.
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
  // Reuse an explicitly supplied Workshop item directory for reproducible offline builds.
  workshopDir = null,
  textureCompression = "uastc",
  exporterLightmapUvs = "auto",
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
  profile = "fidelity",
  dropFoliage,
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
  lightmapSize,
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
  textureSize,
  // Geometry simplification is never selected in response to output byte size.
  // Supplying a numeric error is an explicit, recorded fidelity reduction.
  simplifyError = null,
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
  const quality = resolveMapQuality({
    profile,
    dropFoliage,
    textureSize,
    lightmapSize,
    simplifyError,
  });

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
    const [extractorFingerprint, optimizerFingerprint] = await Promise.all([
      fingerprintFile(cli),
      fingerprintFile(optimizer),
    ]);
    const textureEncoder =
      process.env.KTX_TOKTX ??
      join(toolsDir, "KTX-Software-4.4.2-Linux-x86_64", "bin", "toktx");
    if (!["uastc", "source"].includes(textureCompression))
      throw new Error("textureCompression must be uastc or source");
    if (withTextures && textureCompression === "uastc")
      requireTool(
        textureEncoder,
        "toktx",
        "Install pinned KTX-Software 4.4.2 under tools; see docs/fidelity-capture.md.",
      );
    const textureEncoderFingerprint =
      withTextures && textureCompression === "uastc"
        ? await fingerprintFile(textureEncoder)
        : null;

    const workDir = containedPath(toolsDir, "work");
    const steamRoot = containedPath(toolsDir, "steam-workshop");
    await mkdir(workDir, { recursive: true });

    // 1 + 2. Download the workshop item.
    log(`downloading workshop item ${workshopId} (anonymous)…`);
    if (!workshopDir)
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
    const itemDir = workshopDir
      ? resolve(workshopDir)
      : candidates.find((dir) => existsSync(dir));
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
    let shaderMetadata = null;
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
      shaderMetadata = await prepareCs2Shaders({
        cs2Dir,
        toolsDir,
        gameDir,
        log,
      }).catch((error) => {
        log(`compiled shader metadata unavailable: ${error.message}`);
        return { unavailable: error.message };
      });
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
    const environment = await readMapEnvironment({
      cli,
      mapVpk: innerVpk,
      mapName,
      workDir,
    });
    const { stdout: extractorVersion } = await run(cli, ["--version"]);
    if (!["auto", "source", "baked"].includes(exporterLightmapUvs))
      throw new Error("exporterLightmapUvs must be auto, source, or baked");
    const knownSource = extractorVersion.includes(VRF_19_2_REVISION);
    const knownBaked = extractorVersion.includes(VRF_RENDER_REFERENCE);
    if (
      exporterLightmapUvs === "auto" &&
      !knownSource &&
      !knownBaked &&
      environment.lightmapUvScale.some((v) => v !== 1)
    ) {
      throw new Error(
        "Unverified exporter lightmap UV convention. Use pinned Source2Viewer 19.2 or verify --exporter-lightmap-uvs source|baked against upstream.",
      );
    }
    const exporterBakesUvScale =
      exporterLightmapUvs === "baked" ||
      (exporterLightmapUvs === "auto" && !knownSource);
    const sourceFingerprint = await fingerprintFile(innerVpk);

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
        ...(withTextures
          ? ["--gltf_export_materials", "--gltf_textures_adapt"]
          : []),
        "-o",
        exportDir,
      ],
      BIG_OUTPUT,
    );

    const raw = containedPath(exportDir, "maps", mapName, "world.glb");
    if (!existsSync(raw)) {
      throw new Error(`the exporter produced no world.glb for ${mapName}`);
    }

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
        const { missing } = existsSync(join(gameDir, `${skyName}_c`))
          ? { missing: [] }
          : await ensureCs2Assets({
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
            gameDir,
            cs2Dir,
            skyName,
            workDir,
            size: skySize,
            log,
          });
        }
      }
    }

    // 4. Preserve the exporter's visual streams and scenery by default. The named
    // legacy profile can reproduce the old reductions, and records each one.
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
        size: quality.lightmapSize,
        log,
      });
    }

    log(
      quality.profile === "fidelity"
        ? "preparing geometry without visual-data reduction…"
        : "applying explicit legacy reductions…",
    );
    const trimmed = containedPath(exportDir, "world.trimmed.glb");
    const trim = await trimMap({
      input: raw,
      output: trimmed,
      dropFoliage: quality.dropFoliage,
      attributePolicy: quality.attributePolicy,
      preserveMorphTargets: quality.preserveMorphTargets,
      withTextures,
      materialNames,
      lightmap,
      lightmapUvScale: exporterBakesUvScale
        ? [1, 1]
        : environment.lightmapUvScale,
      readSourceTexture: createSourceTextureReader({ cli, gameDir, workDir }),
    });
    log(
      `retained ${trim.meshesRetained}/${trim.meshesBefore} meshes and ` +
        `${trim.attributesRetained.length} vertex attribute semantic(s)` +
        (trim.meshesRemoved || trim.attributesDropped.length
          ? `; explicitly dropped ${trim.meshesRemoved} mesh(es) and ${trim.attributesDropped.length} semantic(s)`
          : ""),
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
    let packInput = existsSync(trimmed) ? trimmed : raw;

    // 5. Pack once using the selected policy. File size is telemetry, never an input
    // to geometry quality; simplification only runs when explicitly requested.
    log("compressing…");
    if (withTextures && textureCompression === "uastc") {
      const texturePacked = containedPath(exportDir, "world.textures.glb");
      // Texture transforms decode EXT_meshopt_compression on read. Run them first
      // so the final geometry pass cannot accidentally publish unpacked buffers.
      await run(
        optimizer,
        [
          "uastc",
          packInput,
          texturePacked,
          "--level",
          "2",
          "--zstd",
          "18",
          "--jobs",
          "2",
        ],
        {
          ...BIG_OUTPUT,
          env: {
            ...process.env,
            PATH: `${dirname(textureEncoder)}:${process.env.PATH}`,
          },
        },
      );
      packInput = texturePacked;
    }
    const textures = textureCompressArgs({
      withTextures,
      textureSize: quality.textureSize,
    });
    const candidate = containedPath(exportDir, "world.optimized.glb");
    await run(
      optimizer,
      [
        "optimize",
        packInput,
        candidate,
        "--compress",
        "meshopt",
        ...textures,
        "--texture-size",
        String(quality.textureSize ?? 16384),
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
        quality.simplifyError === null ? "false" : "true",
        ...(quality.simplifyError === null
          ? []
          : ["--simplify-error", String(quality.simplifyError)]),
      ],
      BIG_OUTPUT,
    );

    let packed = null;
    const packedPath = candidate;
    if (existsSync(packedPath)) {
      const { size } = await stat(packedPath);
      packed = { path: packedPath, size };
      log(
        `${quality.simplifyError === null ? "geometry preserved" : `explicit simplify ${quality.simplifyError}`}, textures ${textureCompression}: ${(size / 1e6).toFixed(1)} MB`,
      );
    }

    if (!packed) {
      // Exit code said success but nothing was written. Shipping the raw export is
      // better than failing, but it is far larger, so say so.
      if (quality.profile === "fidelity")
        throw new Error(
          "Compression produced no file; refusing to publish an unverified fallback",
        );
      log("compression produced no file — shipping the uncompressed export");
    } else if (packed.size > budgetBytes) {
      log(
        `${(packed.size / 1e6).toFixed(1)} MB is over the ${(budgetBytes / 1e6).toFixed(0)} MB advisory budget; fidelity settings are unchanged`,
      );
    }
    const geometry = packed?.path ?? raw;
    await validateGlb(geometry);

    const lightSource = containedPath(exportDir, "light.rgbm.png");
    const shadowSource = containedPath(exportDir, "light.shadows.png");
    const skySource = containedPath(
      exportDir,
      sky?.exr ? "sky.exr" : "sky.webp",
    );
    if (lightmap?.irradiance && trim.lightmap?.lit > 0) {
      await writeFile(lightSource, lightmap.irradiance.png);
    }
    if (lightmap?.shadows) await writeFile(shadowSource, lightmap.shadows.png);
    if (sky?.exr) await writeFile(skySource, sky.exr);
    else if (sky?.webp) await writeFile(skySource, sky.webp);

    const published = await publishMapAssets({
      outputDir,
      mapName,
      source: {
        workshopId,
        mapVpk: sourceFingerprint,
        compiledShaders: shaderMetadata,
      },
      converter: {
        pipelineVersion: MAP_PIPELINE_VERSION,
        profile: quality.profile,
        settings: {
          ...quality,
          textureCompression,
          environment,
          exporterBakesUvScale,
          extractorVersion: extractorVersion.trim(),
          withTextures,
          withColours,
          withLightmap,
          withSky,
        },
        tools: {
          source2Viewer: extractorFingerprint,
          gltfTransform: optimizerFingerprint,
          textureEncoder: textureEncoderFingerprint,
        },
      },
      files: {
        geometry: {
          sourcePath: geometry,
          fileName: `${mapName}.glb`,
          metadata: {
            mediaType: "model/gltf-binary",
            encoding:
              withTextures && textureCompression === "uastc"
                ? "glb+meshopt+ktx2-uastc"
                : "glb+meshopt",
          },
        },
        lightmapIrradiance:
          lightmap?.irradiance && trim.lightmap?.lit > 0
            ? {
                sourcePath: lightSource,
                fileName: `${mapName}.light.rgbm.png`,
                metadata: {
                  mediaType: "image/png",
                  encoding: "rgbm8-linear",
                  colorSpace: "linear",
                  range: lightmap.irradiance.range,
                  width: lightmap.irradiance.width,
                  height: lightmap.irradiance.height,
                },
              }
            : null,
        lightmapShadows: lightmap?.shadows
          ? {
              sourcePath: shadowSource,
              fileName: `${mapName}.light.shadows.png`,
              metadata: {
                mediaType: "image/png",
                encoding: "rgba8-shadow-amount",
                colorSpace: "linear",
                channels: "rgba",
                width: lightmap.shadows.width,
                height: lightmap.shadows.height,
              },
            }
          : null,
        sky: sky
          ? {
              sourcePath: skySource,
              fileName: `${mapName}.sky.${sky.exr ? "exr" : "webp"}`,
              metadata: sky.exr
                ? {
                    mediaType: "image/x-exr",
                    encoding: sky.encoding ?? "exr-linear",
                    projection: sky.projection ?? "vrf-latlong",
                    width: sky.width,
                    height: sky.height,
                    material: sky.material ?? null,
                  }
                : {
                    mediaType: "image/webp",
                    encoding: "srgb8-tonemapped",
                    projection: "equirectangular",
                    width: sky.width,
                    height: sky.height,
                  },
            }
          : null,
      },
      audit: {
        retained: {
          geometry: {
            meshes: trim.meshesRetained,
            triangles: trim.trianglesRetained,
            attributes: trim.attributesRetained,
            morphTargets: quality.preserveMorphTargets,
          },
          materials: {
            preserved: withTextures,
            ...trim.materials,
          },
          scenery: !quality.dropFoliage,
          directShadowChannels: lightmap?.shadows ? 4 : 0,
        },
        dropped: qualityReductions(quality),
        trim,
        fallbacks: {
          missingTexturesFilledNeutral: trim.texturesFilledIn,
          untexturedMaterials: trim.untexturedMaterials,
          untexturedSurfaces: trim.untexturedSurfaces,
        },
      },
    });
    const final = published.paths.geometry;
    const lightPath = published.paths.lightmapIrradiance;
    const shadowPath = published.paths.lightmapShadows;
    const skyPath = published.paths.sky;

    if (cleanup) {
      // Both are reproducible from the workshop id, and both are enormous. The final
      // .glb has already been copied out, so nothing here is needed again.
      const { size } = await stat(final);
      await cleanupConversionArtifacts({ mapName, workshopId, toolsDir });
      log(`cleaned up, keeping ${(size / 1e6).toFixed(1)} MB`);
    }

    return {
      path: final,
      manifestPath: published.manifestPath,
      revision: published.revision,
      lightPath,
      shadowPath,
      skyPath,
      sun: sky?.sun ?? null,
      rawPath: cleanup ? null : raw,
      simplifyError: quality.simplifyError,
    };
  } catch (error) {
    if (cleanup) {
      await cleanupConversionArtifacts({ mapName, workshopId, toolsDir }).catch(
        (cleanupError) => log(`cleanup also failed: ${cleanupError.message}`),
      );
      log("cleaned up the failed conversion");
    }
    throw error;
  }
};
