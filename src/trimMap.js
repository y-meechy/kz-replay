// Throw away the parts of an exported map the viewer can never show.
//
// Two things dominate a map export, and neither of them is the level:
//
// 1. Vertex attributes nobody reads. The exporter writes POSITION, NORMAL,
//    TANGENT, TEXCOORD_0, TEXCOORD_1, COLOR_0 and more for every vertex. The viewer
//    draws untextured flat-shaded geometry, so it reads POSITION and nothing else.
//    On kz_moss that is nine attribute streams where one is used: roughly 70 bytes
//    per vertex to carry 12 bytes of information. Dropping the rest is lossless.
//
// 2. Foliage. The ten largest meshes in kz_moss are poplar branches, dogwood
//    branches and cypress trees. Leaves are millions of triangles that a KZ player
//    runs straight through, and they hide the level behind them.
//
// Neither pass touches vertex positions, so the geometry a run is measured against
// stays exactly where it was. That matters: mesh simplification does move it.

import { NodeIO } from "@gltf-transform/core";
import { dedup, prune } from "@gltf-transform/functions";
import { colourFor, isInvisibleMaterial } from "./mapColours.js";
import { normaliseMeshName } from "./mapMaterialNames.js";

/** The only attribute the flat-shaded viewer material reads. */
const KEEP_ATTRIBUTES = new Set(["POSITION"]);

/**
 * What a textured map needs instead.
 *
 * TEXCOORD_0 to look the texture up and NORMAL to light it. TANGENT is left out:
 * it is only read for normal mapping, and three.js derives one in the shader when
 * a normal map is present, so carrying a fourth stream per vertex buys nothing.
 */
const KEEP_ATTRIBUTES_TEXTURED = new Set(["POSITION", "NORMAL", "TEXCOORD_0"]);

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
 * @returns counts of what was removed, for logging
 */
export const trimMap = async ({
  input,
  output,
  dropFoliage = true,
  // Keep the map's own materials and the attributes they need. Everything above
  // about attribute bloat still applies, so the set kept is still the smallest one
  // that can be drawn — it is just three streams now instead of one.
  withTextures = false,
  // Mesh name -> material path, from readMaterialNames(). Given one, every surface
  // gets a flat colour picked from that name. Costs about thirty material
  // definitions and not one byte of texture.
  materialNames = null,
}) => {
  const keepAttributes = withTextures
    ? KEEP_ATTRIBUTES_TEXTURED
    : KEEP_ATTRIBUTES;
  const io = new NodeIO();
  const document = await io.read(input);
  const root = document.getRoot();

  let trianglesBefore = 0;
  let trianglesRemoved = 0;
  let meshesRemoved = 0;
  const attributesDropped = new Set();
  // How well the colouring did: how many surfaces the world actually named, and how
  // many landed on a rule rather than the default grey.
  let colouredTotal = 0;
  let colouredNamed = 0;
  let colouredMatched = 0;

  // Taken before any colour material is made, so the clean-up below throws away
  // what the exporter brought and never what we just added.
  const importedMaterials = root.listMaterials();
  const importedTextures = root.listTextures();

  // One material per colour rather than per mesh, so the compressor can still merge
  // everything that ends up the same colour into a single draw call.
  const paletteByHex = new Map();
  const colourMaterial = ({ hex, linear }) => {
    let material = paletteByHex.get(hex);
    if (!material) {
      material = document
        .createMaterial(`kz_${hex.slice(1)}`)
        .setBaseColorFactor([...linear, 1])
        .setRoughnessFactor(1)
        .setMetallicFactor(0);
      paletteByHex.set(hex, material);
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
      for (const semantic of primitive.listSemantics()) {
        if (keepAttributes.has(semantic)) continue;
        attributesDropped.add(semantic);
        primitive.setAttribute(semantic, null);
      }
      if (materialNames) {
        const colour = colourFor(describedBy);
        primitive.setMaterial(colourMaterial(colour));
        colouredNamed += named ? 1 : 0;
        colouredMatched += colour.rule ? 1 : 0;
        colouredTotal += 1;
      }
    }
  }

  // The exporter's own materials only referenced textures through the attributes
  // just removed, and every orphaned accessor and buffer view goes with them.
  if (!withTextures) {
    for (const material of importedMaterials) {
      material.dispose();
    }
    for (const texture of importedTextures) {
      texture.dispose();
    }
  }

  await document.transform(prune(), dedup());
  await io.write(output, document);

  return {
    trianglesBefore,
    trianglesRemoved,
    meshesRemoved,
    attributesDropped: [...attributesDropped].sort(),
    colours: materialNames
      ? {
          palette: paletteByHex.size,
          surfaces: colouredTotal,
          named: colouredNamed,
          matched: colouredMatched,
        }
      : null,
  };
};
