// Preserve the export's material and geometry data before packing. Attribute and
// foliage removal belongs only to the explicitly selected legacy profile: these
// streams carry normal mapping, tint, cutouts and lighting in the fidelity renderer.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune } from "@gltf-transform/functions";
import { colourFor, isInvisibleMaterial } from "./mapColours.js";
import { normaliseMeshName } from "./mapMaterialNames.js";
import { repairSourceMaterialAlpha } from "./sourceMaterialRepair.js";

/** Attribute sets used only by the explicit legacy reduction profile. */
const KEEP_ATTRIBUTES = new Set(["POSITION"]);

/**
 * The set the exporter puts the lightmap atlas UV in: the address of this vertex
 * inside the map's baked lighting (see mapLightmap.js). Renamed to TEXCOORD_0 below,
 * because glTF requires texture coordinate sets to be numbered from zero with no
 * gaps and it is the only set left by then.
 */
const LIGHTMAP_UV = "TEXCOORD_1";

/**
 * What a lightmapped map needs instead.
 *
 * NORMAL is not in here. Baked light is the whole of the lighting, so the viewer
 * draws these surfaces unlit and never reads a normal.
 */
const KEEP_ATTRIBUTES_LIGHTMAP = new Set(["POSITION", LIGHTMAP_UV]);

/**
 * What a textured map needs instead.
 *
 * TEXCOORD_0 to look the texture up and NORMAL to light it. TANGENT is left out:
 * it is only read for normal mapping, and three.js derives one in the shader when
 * a normal map is present, so carrying a fourth stream per vertex buys nothing.
 */
const KEEP_ATTRIBUTES_TEXTURED = new Set(["POSITION", "NORMAL", "TEXCOORD_0"]);

/**
 * Both at once, which is as close to the real map as this gets: the mapper's own
 * surfaces, lit by the mapper's own sun.
 *
 * Four streams, and worth it. The two UV sets address different things — TEXCOORD_0
 * repeats a brick texture across a wall, TEXCOORD_1 finds that wall's one patch of the
 * baked lighting atlas — so neither can stand in for the other.
 *
 * The atlas UV keeps its own number here rather than being moved to zero, because
 * TEXCOORD_0 is in use. glTF is fine with that; three.js calls it `uv1` and that is
 * where a light map looks by default.
 */
const KEEP_ATTRIBUTES_TEXTURED_LIT = new Set([
  "POSITION",
  "NORMAL",
  "TEXCOORD_0",
  LIGHTMAP_UV,
]);

/** Which of the four sets above applies, given what this map is being shipped with. */
const legacyAttributesFor = ({ withTextures, withLightmap }) => {
  if (withTextures && withLightmap) return KEEP_ATTRIBUTES_TEXTURED_LIT;
  if (withLightmap) return KEEP_ATTRIBUTES_LIGHTMAP;
  if (withTextures) return KEEP_ATTRIBUTES_TEXTURED;
  return KEEP_ATTRIBUTES;
};

// Plant words as they appear in exported mesh names, which are built from the model
// and material names the mapper used.
//
// Note what is NOT here: "grass". A grass blend is as likely to be the ground as it
// is to be a tuft, and deleting the ground is unforgivable.
const FOLIAGE_WORDS = [
  "branch",
  "leaf",
  "leaves",
  "foliage",
  "tree",
  "bush",
  "shrub",
  "fern",
  "ivy",
  "vine",
  "flower",
  "weed",
  "hedge",
  "poplar",
  "dogwood",
  "cypress",
  "banyan",
  "birch",
  "willow",
  "maple",
  "oak",
  "pine",
  "palm",
  "sumac",
  "reed",
  "plant",
];

// Matched between separators, never as a substring. Plain `includes("fern")` deleted
// every `inferno_stone_floor` mesh in kz_grotto — the floors the run stands on — and
// the run then had nothing under it at all. Word boundaries, always.
const FOLIAGE_PATTERN = new RegExp(
  `(^|[_\\-. ])(${FOLIAGE_WORDS.join("|")})([_\\-. 0-9]|$)`,
  "i",
);

// A floor is a handful of triangles; foliage is thousands. Requiring some bulk means
// that even if a name does match by accident, a structural mesh survives.
const MIN_FOLIAGE_TRIANGLES = 150;

const isFoliage = (name, triangles) =>
  triangles >= MIN_FOLIAGE_TRIANGLES && FOLIAGE_PATTERN.test(name ?? "");

const countTriangles = (primitive) => {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute("POSITION");
  return Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
};

/**
 * Fill in the textures the exporter promised and never wrote.
 *
 * A textured .glb keeps its images beside it as .png files rather than inside itself,
 * and now and again one of them fails to decode — on kz_grotto it is a tree branch
 * whose source was a Photoshop file. The .glb still points at it, and a glTF reader
 * treats a file that is not there as fatal, so one bad leaf took the whole map with
 * it and the pipeline shipped nothing. Each one is written out as a small neutral
 * grey image instead: that surface loses its pattern, and the other four hundred
 * arrive exactly as the mapper made them.
 */
const fillInMissingTextures = async (glb) => {
  const bytes = await readFile(glb);
  // A .glb is a twelve byte header followed by length-prefixed chunks, the first of
  // which is the glTF JSON. Read straight out of the file because gltf-transform
  // cannot get this far without the images it is missing.
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));

  const beside = dirname(glb);
  const missing = [];
  let greyPng = null;
  for (const image of gltf.images ?? []) {
    if (!image.uri || image.uri.startsWith("data:")) continue;
    const file = join(beside, decodeURIComponent(image.uri));
    if (existsSync(file)) continue;
    // The same four pixels serve every hole, so it is only ever encoded once.
    greyPng ??= await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .png()
      .toBuffer();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, greyPng);
    missing.push(image.uri);
  }
  return missing;
};

/**
 * @returns counts of what was removed, for logging
 */
export const trimMap = async ({
  input,
  output,
  // Visible scenery is source content, even when it is non-playable and expensive.
  // Removing it is an explicit legacy choice, never the conversion default.
  dropFoliage = false,
  // `all` preserves every stream emitted by the exporter, including tangent-space
  // and vertex-colour data used by normal mapped, tinted, and blended materials.
  // `legacy` retains only the small set the old viewer happened to read.
  attributePolicy = "all",
  preserveMorphTargets = true,
  // Keep the map's own materials and the attributes they need. Everything above
  // about attribute bloat still applies, so the set kept is still the smallest one
  // that can be drawn — it is just three streams now instead of one.
  withTextures = false,
  // Mesh name -> material path, from readMaterialNames(). Given one, every surface
  // gets a flat colour picked from that name. Costs about thirty material
  // definitions and not one byte of texture.
  materialNames = null,
  // { png, size } from buildLightmap(): the map's own baked lighting as one image.
  // Given one, every surface that carries a lightmap UV is multiplied by it, so the
  // flat colour picks up the map's real sun, shadows and corner darkening. Requires
  // materialNames, because the flat colour is what the light is multiplied into.
  lightmap = null,
  lightmapUvScale = [1, 1],
  readSourceTexture = null,
}) => {
  if (!new Set(["all", "legacy"]).has(attributePolicy)) {
    throw new TypeError(`unknown map attribute policy: ${attributePolicy}`);
  }
  const keepAttributes =
    attributePolicy === "all"
      ? null
      : legacyAttributesFor({
          withTextures,
          withLightmap: Boolean(lightmap),
        });
  const texturesFilledIn = withTextures
    ? await fillInMissingTextures(input)
    : [];
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(input);
  const root = document.getRoot();
  const sourceMaterialRepairs =
    withTextures && attributePolicy === "all"
      ? await repairSourceMaterialAlpha(document, readSourceTexture)
      : null;

  let trianglesBefore = 0;
  let meshesBefore = 0;
  let trianglesRemoved = 0;
  let meshesRemoved = 0;
  const attributesDropped = new Set();
  const attributesRetained = new Set();
  // How well the colouring did: how many surfaces the world actually named, and how
  // many landed on a rule rather than the default grey.
  let colouredTotal = 0;
  let colouredNamed = 0;
  let colouredMatched = 0;
  // How much of the map the baked lighting actually reaches.
  let litSurfaces = 0;
  let unlitSurfaces = 0;
  // Surfaces a textured export could not texture, which fall back to a colour from
  // their name. Counted separately because they are two different failures: a shader
  // glTF has no room for, like water, and a surface whose material the workshop item
  // does not carry at all.
  let morphTargetsRemoved = 0;
  let untexturedMaterials = 0;
  let untexturedSurfaces = 0;

  // Taken before any colour material is made, so the clean-up below throws away
  // what the exporter brought and never what we just added.
  const importedMaterials = root.listMaterials();
  const importedTextures = root.listTextures();
  const materialAudit = {
    imported: importedMaterials.length,
    textured: importedMaterials.filter((material) =>
      Boolean(material.getBaseColorTexture()),
    ).length,
    doubleSided: importedMaterials.filter((material) =>
      material.getDoubleSided(),
    ).length,
    alphaBlend: importedMaterials.filter(
      (material) => material.getAlphaMode() === "BLEND",
    ).length,
    alphaMask: importedMaterials.filter(
      (material) => material.getAlphaMode() === "MASK",
    ).length,
  };

  // The baked lighting, as one texture shared by every material in the map. Created
  // lazily so a map whose meshes all turn out to be unlit ships no image at all.
  // Only when there are no real textures. A textured map ships the atlas as its own
  // file instead, because glTF has no light map slot and the base colour slot is taken
  // by the mapper's own texture. See mapPipeline.js and the viewer's loadBakedLight().

  // One material per colour rather than per mesh, so the compressor can still merge
  // everything that ends up the same colour into a single draw call. A lightmapped
  // map has two per colour: the surfaces that carry an atlas UV, and the handful
  // that do not and can only be flat.
  const paletteByHex = new Map();
  const colourMaterial = ({ hex, linear }, lit) => {
    const key = lit ? `${hex}+lit` : hex;
    let material = paletteByHex.get(key);
    if (!material) {
      material = document
        .createMaterial(`kz_${hex.slice(1)}`)
        .setBaseColorFactor([...linear, 1])
        .setRoughnessFactor(1)
        .setMetallicFactor(0);
      paletteByHex.set(key, material);
    }
    return material;
  };

  const dropMesh = (mesh, meshTriangles) => {
    // Detach from the scene as well: a node with no mesh is pruned later.
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === "Node") parent.setMesh(null);
    }
    mesh.dispose();
    meshesRemoved += 1;
    trianglesRemoved += meshTriangles;
  };

  for (const mesh of root.listMeshes()) {
    meshesBefore += 1;
    if (!preserveMorphTargets) mesh.setWeights([]);
    const meshTriangles = mesh
      .listPrimitives()
      .reduce((total, primitive) => total + countTriangles(primitive), 0);
    trianglesBefore += meshTriangles;

    if (dropFoliage && isFoliage(mesh.getName(), meshTriangles)) {
      dropMesh(mesh, meshTriangles);
      continue;
    }

    // The material path when the world named one, and the mesh's own name when it
    // did not. Both are descriptive; only the first is authoritative.
    const named =
      materialNames?.get(normaliseMeshName(mesh.getName() ?? "")) ?? null;
    const describedBy = named ?? mesh.getName() ?? "";

    if (materialNames && isInvisibleMaterial(describedBy)) {
      // A trigger or clip brush. Solid here, invisible in the game.
      dropMesh(mesh, meshTriangles);
      continue;
    }

    for (const primitive of mesh.listPrimitives()) {
      // Props are model instances rather than world geometry, and they were lit at
      // runtime in the game, so they carry no atlas UV and cannot be lightmapped.
      // There are five of them in kz_victoria, ten triangles in total.
      const lit = Boolean(
        lightmap &&
        primitive.getAttribute(LIGHTMAP_UV) &&
        (!materialNames || named),
      );
      primitive.setExtras({
        ...primitive.getExtras(),
        kzLightmapUv: lit ? 1 : null,
      });
      if (lit && lightmapUvScale.some((value) => value !== 1)) {
        const atlasUv = primitive.getAttribute(LIGHTMAP_UV).clone();
        const values = atlasUv.getArray().slice();
        for (let i = 0; i < values.length; i++)
          values[i] *= lightmapUvScale[i % 2];
        atlasUv.setArray(values);
        primitive.setAttribute(LIGHTMAP_UV, atlasUv);
      }

      for (const semantic of primitive.listSemantics()) {
        if (keepAttributes && !keepAttributes.has(semantic)) {
          attributesDropped.add(semantic);
          primitive.setAttribute(semantic, null);
        } else {
          attributesRetained.add(semantic);
        }
      }

      // Morph targets: vertex deltas for deforming a model, which nothing here animates.
      // kz_dojo has a koi fish carrying 150 of them and no weights to blend them with,
      // and that combination is not merely wasted download — three.js takes the morph
      // path for any geometry that has targets, then reads the influences array the
      // loader never made, and throws out of the render loop. The replay stops dead the
      // moment the camera turns towards the pond.
      if (!preserveMorphTargets) {
        for (const target of primitive.listTargets()) {
          primitive.removeTarget(target);
          morphTargetsRemoved += 1;
        }
      }
      if (lit) {
        if (!primitive.getAttribute("TEXCOORD_0")) {
          primitive.setAttribute(
            "TEXCOORD_0",
            primitive.getAttribute(LIGHTMAP_UV),
          );
        }
        litSurfaces += 1;
      } else if (lightmap) {
        // Nothing addresses the atlas, so drop the UV set with everything else.
        primitive.setAttribute(LIGHTMAP_UV, null);
        unlitSurfaces += 1;
      }
      if (withTextures) {
        // The mapper's own material is the whole point of a textured build, so it is
        // never replaced by a colour guessed from a filename. Only a surface with
        // nothing at all to draw falls back.
        if (!primitive.getMaterial()) {
          // A textured export leaves some surfaces with no material at all — 52 of them
          // on kz_victoria, 47k triangles — because the material they name is a base
          // game asset that is not in the workshop item and so could not be loaded. glTF
          // says a primitive with no material is plain white, and white is the brightest
          // thing on screen: they read as holes cut in the level.
          //
          // The colour guessed from the surface's name is what an untextured map would
          // have given it, so that is what they fall back to.
          primitive.setMaterial(colourMaterial(colourFor(describedBy), false));
          untexturedSurfaces += 1;
        }
      } else if (materialNames) {
        const colour = colourFor(describedBy);
        primitive.setMaterial(colourMaterial(colour, lit));
        colouredNamed += named ? 1 : 0;
        colouredMatched += colour.rule ? 1 : 0;
        colouredTotal += 1;
      }
    }
  }

  // Geometry-only exports replace the source materials. Textured fidelity exports
  // retain them, including authored colours on materials without a base texture.
  if (!withTextures) {
    for (const material of importedMaterials) {
      material.dispose();
    }
    for (const texture of importedTextures) {
      texture.dispose();
    }
  } else if (attributePolicy === "legacy") {
    // Not every Source 2 shader is a PBR material, and the ones that are not export
    // with no base colour texture and a white factor — so they render as pure white,
    // which is the brightest thing on screen and reads as a hole in the level. On
    // kz_victoria that is the water: `sky.vfx`, `water.vfx` and friends are their own
    // shaders, and glTF has nowhere to put them.
    //
    // The colour guessed from the material's name is exactly what an untextured map
    // would have used for that surface, so it is the right thing to fall back to. See
    // mapColours.js — "water" is in the word list.
    for (const material of importedMaterials) {
      if (material.isDisposed() || material.getBaseColorTexture()) continue;
      const { linear } = colourFor(material.getName() ?? "");
      const [, , , alpha] = material.getBaseColorFactor();
      material.setBaseColorFactor([...linear, alpha]);
      untexturedMaterials += 1;
    }
  }

  // keepAttributes, because the lighting atlas's UV set is unused *inside the file* by
  // design: the atlas ships beside the .glb, since glTF has no light map slot, and the
  // viewer pairs the two at load time. Pruning decides an attribute nothing references
  // is dead, and it was right about every other one — but this one it threw away on
  // every map, so a textured map arrived with the mapper's own lighting stripped out and
  // lit by the viewer's invented lights alone. Flat, and much darker than the real level.
  await document.transform(prune({ keepAttributes: true }), dedup());
  await io.write(output, document);

  return {
    sourceMaterialRepairs,
    attributePolicy,
    meshesBefore,
    meshesRetained: meshesBefore - meshesRemoved,
    trianglesBefore,
    trianglesRetained: trianglesBefore - trianglesRemoved,
    trianglesRemoved,
    meshesRemoved,
    attributesDropped: [...attributesDropped].sort(),
    attributesRetained: [...attributesRetained].sort(),
    materials: materialAudit,
    colours: materialNames
      ? {
          palette: paletteByHex.size,
          surfaces: colouredTotal,
          named: colouredNamed,
          matched: colouredMatched,
        }
      : null,
    lightmap: lightmap
      ? {
          width: lightmap.irradiance.width,
          height: lightmap.irradiance.height,
          lit: litSurfaces,
          unlit: unlitSurfaces,
        }
      : null,
    untexturedMaterials,
    untexturedSurfaces,
    morphTargetsRemoved,
    texturesFilledIn,
  };
};
