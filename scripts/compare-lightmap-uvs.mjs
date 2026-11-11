// Compare the lightmap UVs of the same map converted by two Source2Viewer releases.
//
//   node scripts/compare-lightmap-uvs.mjs old.glb new.glb
//
// Convert one map whose atlas UV scale is not 1 (kz_sxb2_onlyslide: 1.14284) with
// the pinned release and the candidate, then compare. Matching extents mean the
// candidate follows the same convention and LAST_VERIFIED_RELEASE in
// src/mapEnvironment.js can be bumped. Extents off by the scale mean it flipped.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const extents = async (file) => {
  const document = await io.read(file);
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  let vertices = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const index = primitive.getExtras()?.kzLightmapUv;
      const uv =
        index == null ? null : primitive.getAttribute(`TEXCOORD_${index}`);
      if (!uv) continue;
      const element = [];
      for (let i = 0; i < uv.getCount(); i += 1) {
        uv.getElement(i, element);
        for (const axis of [0, 1]) {
          min[axis] = Math.min(min[axis], element[axis]);
          max[axis] = Math.max(max[axis], element[axis]);
        }
        vertices += 1;
      }
    }
  }
  return { vertices, min, max };
};

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error("usage: compare-lightmap-uvs.mjs <old.glb> <new.glb>");
  process.exit(2);
}
const a = await extents(before);
const b = await extents(after);
const ratios = [0, 1].map((axis) => b.max[axis] / a.max[axis]);
console.log({ before: a, after: b, ratios });
const same =
  a.vertices === b.vertices && ratios.every((r) => Math.abs(r - 1) < 0.01);
console.log(
  same ? "same convention" : "DIFFERENT — do not bump LAST_VERIFIED_RELEASE",
);
process.exit(same ? 0 : 1);
