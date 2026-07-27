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

/** The only attribute the viewer's material reads. */
const KEEP_ATTRIBUTES = new Set(["POSITION"]);

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
export const trimMap = async ({ input, output, dropFoliage = true }) => {
  const io = new NodeIO();
  const document = await io.read(input);
  const root = document.getRoot();

  let trianglesBefore = 0;
  let trianglesRemoved = 0;
  let meshesRemoved = 0;
  const attributesDropped = new Set();

  for (const mesh of root.listMeshes()) {
    const meshTriangles = mesh
      .listPrimitives()
      .reduce((total, primitive) => total + countTriangles(primitive), 0);
    trianglesBefore += meshTriangles;

    if (dropFoliage && isFoliage(mesh.getName(), meshTriangles)) {
      // Detach from the scene as well: a node with no mesh is pruned later.
      for (const parent of mesh.listParents()) {
        if (parent.propertyType === "Node") parent.setMesh(null);
      }
      mesh.dispose();
      meshesRemoved += 1;
      trianglesRemoved += meshTriangles;
      continue;
    }

    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (KEEP_ATTRIBUTES.has(semantic)) continue;
        attributesDropped.add(semantic);
        primitive.setAttribute(semantic, null);
      }
    }
  }

  // Materials only referenced textures through the attributes just removed, and
  // every orphaned accessor and buffer view goes with them.
  for (const material of root.listMaterials()) {
    material.dispose();
  }
  for (const texture of root.listTextures()) {
    texture.dispose();
  }

  await document.transform(prune(), dedup());
  await io.write(output, document);

  return {
    trianglesBefore,
    trianglesRemoved,
    meshesRemoved,
    attributesDropped: [...attributesDropped].sort(),
  };
};
