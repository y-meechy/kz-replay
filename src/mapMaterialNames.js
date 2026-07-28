// Recover which material each surface of a map uses, without the game files.
//
// The exporter cannot load the materials themselves — they live in the CS2 install
// — so the world it writes has none at all. It can still decompile the world nodes,
// and those name the material every mesh was built with. That name is all the
// colouring in mapColours.js needs.
//
// The join between the two is the mesh name. A dumped node is
// `n0_lr0_c24_s_cb_nv_mesh_meshset_0.dmx` and the mesh it describes arrives in the
// glTF as `n0_lr0_c24_s_cb_nv_mesh.meshset_0`, so only the separator differs.

import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// The node dumps are binary, and the paths sit in them as plain ASCII.
const MATERIAL_PATH = /materials\/[a-zA-Z0-9_/.-]+\.vmat/g;

/** `a.meshset_0` and `a_meshset_0` are the same mesh, written by different tools. */
const normalise = (name) => name.toLowerCase().replace(/[.]/g, "_");

/**
 * Material path per mesh, for every world node in a map.
 *
 * Only the world's own geometry carries a material here. Props do not: they are
 * model instances, and their materials live inside the model. Those come back with
 * no entry, and the caller falls back to the mesh name, which the exporter builds
 * from the model name and which is descriptive enough to colour.
 *
 * @returns { byMesh, paths } — normalised mesh name -> material path, and the set of
 *          every material path the world mentions. The set is wider than the map:
 *          a mesh set built from several materials contributes all of them, and only
 *          the first is what colours it. Callers that have to make those materials
 *          loadable (see cs2Materials.js) want all of them.
 */
export const readMaterialNames = async ({
  cli,
  mapVpk,
  mapName,
  workDir,
  log = () => {},
}) => {
  const dumpDir = join(workDir, "worldnodes", mapName);
  await rm(dumpDir, { recursive: true, force: true });

  await run(
    cli,
    ["-i", mapVpk, "-f", `maps/${mapName}/worldnodes/`, "-d", "-o", dumpDir],
    // The dumps print one line per file and a map has hundreds.
    { maxBuffer: 64 * 1024 * 1024 },
  );

  const nodeDir = join(dumpDir, "maps", mapName, "worldnodes");
  let files = [];
  try {
    files = await readdir(nodeDir);
  } catch {
    log("no world nodes were dumped, so every surface falls back to its name");
    return { byMesh: new Map(), paths: new Set() };
  }

  const byMesh = new Map();
  const paths = new Set();
  for (const file of files) {
    if (!file.endsWith(".dmx")) continue;
    const contents = await readFile(join(nodeDir, file), "latin1");
    const matches = [...new Set(contents.match(MATERIAL_PATH) ?? [])];
    for (const path of matches) paths.add(path.toLowerCase());
    if (matches.length === 0) continue;
    // A mesh set can list more than one material when it was built from several.
    // The first is the one covering most of it, and a surface only gets one colour.
    byMesh.set(normalise(file.replace(/\.dmx$/, "")), matches[0]);
  }

  await rm(dumpDir, { recursive: true, force: true });
  return { byMesh, paths };
};

export const normaliseMeshName = normalise;
