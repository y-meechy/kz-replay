// The CT the viewer draws instead of a white sphere.
//
// A replay knows, for every tick, where the player was, which way they looked, whether
// they were ducking and whether they were on the ground. That is enough to drive a real
// character, and CS2 ships one. Same trick as the sky (see mapSky.js): the model and the
// clips we want are a few megabytes of a 52 GB depot, and cs2Content.js can borrow
// exactly those bytes without installing the game.
//
// Three things had to be found out the hard way, and they shape everything below.
//
//  1. `characters/models/ctm_sas/ctm_sas.vmdl_c` is a 4.7 KB stub. The real model —
//     skeleton, skinned meshes, materials — is `agents/models/ctm_sas/ctm_sas.vmdl_c`,
//     at 563 KB.
//  2. That model carries no locomotion. Its own two clips are `tools_preview` and
//     `eye_test`. The walk and the run live in separate `.vnmclip_c` files, reached in
//     game through an animation graph that names every clip for a weapon class — far too
//     many to borrow, and the exporter does not follow it anyway.
//  3. But a `.vnmclip_c` exports on its own: the CLI writes a skeleton-only glb with the
//     clip in it, and the bone names match the model's. So each clip is exported
//     separately and its channels are re-pointed at the model's own bones here.
//
// What comes out is one `ct.glb` of a few megabytes, holding the third-person body, its
// gloves and eight named locomotion clips the viewer's state machine picks between.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { cs2IndexPath, ensureCs2Assets, syncCs2Index } from "./cs2Content.js";
import { validateGlb } from "./mapPipeline.js";
import { CS2_DIR, REPO_ROOT, TOOLS_DIR } from "./config.js";

const run = promisify(execFile);

const GLTF_TRANSFORM = join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  "gltf-transform",
);

// The exporter and the compressor are both chatty, and the default 1 MB pipe buffer
// overflows into a maxBuffer error that hides the real one.
const BIG_OUTPUT = { maxBuffer: 64 * 1024 * 1024 };

/** The model. SAS is the CT the game gives you when nothing else has been chosen. */
const CT_MODEL = "agents/models/ctm_sas/ctm_sas.vmdl";

/**
 * Which of the model's meshes to keep.
 *
 * The other three are the first-person arms, the first-person sleeves and the defuse
 * kit. The arms are a floating pair of hands from any angle but the wearer's, and they
 * cost the two largest textures in the file.
 */
const CT_MESHES = ["thirdperson_body", "thirdperson_default_gloves"];

/** Where the locomotion clips live. Shared by every player model in the game. */
const CLIP_DIR = "animation/anims/world/rifle/_default_rifle";

/**
 * The clips the viewer's state machine can pick between, and nothing else.
 *
 * The folder holds 194. Most are the eight compass directions of these same cycles, or
 * the ladder set, the turn-in-place set and the bomb-planting set: a replay carries no
 * strafe direction and no ladder flag, so none of those could ever be selected.
 *
 * The rifle set rather than the knife or pistol one because it is the fullest — every
 * one of idle, walk, run, crouch, jump and in-air is there, standing and ducked — and a
 * KZ player carries nothing, so the pose of the arms is a wash either way.
 *
 * Names are what the viewer looks up in the .glb, so character.js and this list have to
 * agree. Kept as the CS2 names rather than renamed to idle/walk/run: it is one less
 * mapping to hold in your head, and it says where they came from.
 */
export const CT_CLIPS = [
  "idle_rifle",
  "walk_n_rifle",
  "run_n_rifle",
  "idle_crouch_rifle",
  "crouch_n_rifle",
  "jump_stand_rifle",
  "inair_stand_rifle",
  "inair_crouch_stand_rifle",
];

/**
 * The bone every clip drives to carry the character across the ground.
 *
 * Dropped on the way in. The replay says where the player was on every tick and the
 * viewer puts them there, so a run cycle that also travels would leave the body sliding
 * out from under its own position. Skipping the channel leaves the bone at rest, which
 * is a run cycle on the spot — exactly what is wanted.
 */
const ROOT_MOTION_BONE = "root_motion";

/**
 * Assets a decompile reaches for beyond the one it was asked about.
 *
 * A model names its materials, a material names its textures, and the compiled name of
 * a texture carries a content hash that cannot be guessed — so the only way to know what
 * to borrow is to ask each file what it references and follow that.
 *
 * Animation graphs are fetched and not followed. One names every clip in the game for a
 * weapon class, which is hundreds of megabytes for the eight we want.
 */
const OPAQUE_TO_FOLLOW = /\.(vnmgraph|vnmclip)_c$/;

const externalRefs = async ({ cli, cs2Dir, path }) => {
  const { stdout } = await run(
    cli,
    ["-i", cs2IndexPath(cs2Dir), "-f", path, "-b", "RERL"],
    BIG_OUTPUT,
  ).catch(() => ({ stdout: "" }));
  // `CResourceString m_pResourceName = "materials/…/ctm_sas_body.vmat"`, uncompiled.
  return [...stdout.matchAll(/m_pResourceName = "([^"]+)"/g)].map(
    (match) => `${match[1].toLowerCase()}_c`,
  );
};

/**
 * Borrow everything the export will reach for, following references as they are found.
 *
 * Two rounds in practice: the model names its materials and its skeletons, and the
 * materials name their textures.
 */
const borrowAssets = async ({ cs2Dir, toolsDir, cli, roots, log }) => {
  const seen = new Set();
  let frontier = roots;
  while (frontier.length) {
    const fresh = frontier.filter((path) => !seen.has(path));
    if (fresh.length === 0) break;
    for (const path of fresh) seen.add(path);

    const { missing } = await ensureCs2Assets({
      cs2Dir,
      toolsDir,
      cli,
      paths: fresh,
      // The names are exact and already compiled. Sibling matching here would drag in
      // every other character in the game.
      siblings: false,
      log,
    });
    if (missing.length) {
      throw new Error(
        `CS2 does not have ${missing.length} of the files the CT model needs, ` +
          `starting with ${missing[0]}`,
      );
    }

    const next = new Set();
    for (const path of fresh) {
      if (OPAQUE_TO_FOLLOW.test(path)) continue;
      for (const ref of await externalRefs({ cli, cs2Dir, path })) {
        if (!seen.has(ref)) next.add(ref);
      }
    }
    frontier = [...next];
  }
  return seen.size;
};

/** Ask the CLI to decompile one asset into `dir`, as glb where it makes sense. */
const exportGlb = async ({ cli, cs2Dir, path, dir, extra = [] }) =>
  run(
    cli,
    [
      "-i",
      cs2IndexPath(cs2Dir),
      "-f",
      path,
      "-d",
      "--gltf_export_format",
      "glb",
      ...extra,
      "-o",
      dir,
    ],
    BIG_OUTPUT,
  );

/**
 * Copy one document's animation onto another document's bones.
 *
 * Matched by bone name, which is what makes this work at all: a clip exports against
 * `animation/skeletons/characters/worldmodel.vnmskel` and the model is skinned to the
 * same skeleton, so `pelvis` means the same joint in both. The dozen channels a clip has
 * for bones the model does not carry — weapon attachment points, foot and hand
 * attachments — have nowhere to go and are dropped.
 *
 * @returns the number of channels that landed
 */
const copyAnimation = ({ into, from, name, bones }) => {
  const source = from.getRoot().listAnimations()[0];
  if (!source) return 0;

  const buffer = into.getRoot().listBuffers()[0];
  const animation = into.createAnimation(name);
  let channels = 0;

  for (const channel of source.listChannels()) {
    const boneName = channel.getTargetNode()?.getName();
    if (boneName === ROOT_MOTION_BONE) continue;
    const bone = bones.get(boneName);
    if (!bone) continue;

    const sampler = channel.getSampler();
    const times = sampler.getInput();
    const values = sampler.getOutput();
    // New accessors rather than the source ones: an accessor belongs to the document
    // that made it, and the two documents are about to go their separate ways.
    const input = into
      .createAccessor()
      .setType(times.getType())
      .setArray(times.getArray().slice())
      .setBuffer(buffer);
    const output = into
      .createAccessor()
      .setType(values.getType())
      .setArray(values.getArray().slice())
      .setNormalized(values.getNormalized())
      .setBuffer(buffer);

    const copied = into
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation(sampler.getInterpolation());
    animation.addSampler(copied);
    animation.addChannel(
      into
        .createAnimationChannel()
        .setTargetNode(bone)
        .setTargetPath(channel.getTargetPath())
        .setSampler(copied),
    );
    channels += 1;
  }

  if (channels === 0) animation.dispose();
  return channels;
};

/**
 * Make the model's rest pose the same rest pose the clips were authored against.
 *
 * The two exports do not agree on where the skeleton's own axes point, and they disagree
 * at exactly one joint. A clip leaves `root_motion` unrotated and hands the Source Z-up
 * frame straight to `pelvis`; the model turns `root_motion` by 120° about (1,1,1) so that
 * `pelvis` receives a Y-up one. Every joint below that matches to six decimal places,
 * because those are all in their parent's space and the frame has already been settled.
 *
 * So a clip merged onto the model as-is drives `pelvis` with values meant for the other
 * frame, and the body arrives face down and a fifth of its height. Copying the clips'
 * rest pose over the model's is what makes the two agree — and the copy is safe because
 * the change is a rigid rotation of the whole skeleton at its root: the skin's bind
 * matrices are unchanged, so the body turns with its bones instead of tearing. The viewer
 * undoes the leftover quarter turn, which it already does for maps. See vrfExport.js.
 */
const alignRestPose = ({ into, from, bones }) => {
  let changed = 0;
  for (const source of from.getRoot().listNodes()) {
    const bone = bones.get(source.getName());
    if (!bone) continue;
    bone
      .setTranslation(source.getTranslation())
      .setRotation(source.getRotation())
      .setScale(source.getScale());
    changed += 1;
  }
  return changed;
};

/**
 * Merge the exported clips into the exported model, and write the result.
 *
 * The model's own two animations go: `tools_preview` holds a single pose and `eye_test`
 * blinks, and both would show up in the viewer's clip list as something to pick.
 */
const mergeClips = async ({ modelGlb, clipGlbs, output, log }) => {
  const io = new NodeIO();
  const model = await io.read(modelGlb);

  for (const animation of model.getRoot().listAnimations()) animation.dispose();

  const bones = new Map(
    model
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  );

  const merged = [];
  let aligned = false;
  for (const [name, path] of clipGlbs) {
    const clip = await io.read(path);
    // Once, off the first clip. Every clip in the folder is exported against the same
    // skeleton, so they all agree with each other and only one has to be asked.
    if (!aligned) {
      log(`aligned ${alignRestPose({ into: model, from: clip, bones })} bones`);
      aligned = true;
    }
    const channels = copyAnimation({
      into: model,
      from: clip,
      name,
      bones,
    });
    if (channels === 0) {
      log(`the clip ${name} drove no bone the model has, so it was dropped`);
      continue;
    }
    merged.push(name);
  }

  await io.write(output, model);
  return merged;
};

const optimizerArgs = (input, output, textureSize) => [
  "optimize",
  input,
  output,
  "--compress",
  "meshopt",
  "--texture-compress",
  "webp",
  "--texture-size",
  String(textureSize),
  // A skinned body is 12k triangles to begin with, so there is nothing to gain here and
  // a moved vertex on a face is a face that no longer reads as one.
  "--simplify",
  "false",
  // Every one of these three rewrites the scene graph, and the scene graph is what the
  // skeleton is. Flattening bakes each node's transform into its mesh and drops the node,
  // which for a skinned mesh leaves the bones addressing a hierarchy that no longer
  // exists: the character came out at about a eightieth of its size, a millimetre-tall
  // smear on the trail. Joining renumbers the skinning joints the clips were just pointed
  // at, and instancing shares one mesh reference between nodes that each need their own
  // skeleton.
  "--flatten",
  "false",
  "--join",
  "false",
  "--instance",
  "false",
];

/**
 * Borrow the CT model out of CS2 and write `ct.glb` for the viewer.
 *
 * @param outputDir where `ct.glb` lands; viewer/public/models in development
 * @returns { path, size, clips } — clips being the ones that made it into the file
 */
export const convertPlayerModel = async ({
  outputDir,
  toolsDir = TOOLS_DIR,
  cs2Dir = CS2_DIR,
  // A character is drawn twice at most and a few metres from the camera, so it needs far
  // less than a map: 512 reads every seam on the vest, and this file is mostly texture.
  textureSize = 512,
  // Delete the raw export afterwards. It is about 25 MB of PNG per run, all of it
  // reproducible from the cache.
  cleanup = true,
  log = () => {},
}) => {
  const cli = join(toolsDir, "Source2Viewer-CLI");
  if (!existsSync(cli)) {
    throw new Error(
      `Source2Viewer-CLI not found at ${cli}. Download the CLI archive for this ` +
        `platform from the ValveResourceFormat releases into tools/.`,
    );
  }
  if (!existsSync(GLTF_TRANSFORM)) {
    throw new Error(
      `gltf-transform not found at ${GLTF_TRANSFORM}. Run npm install first.`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  await syncCs2Index({ cs2Dir, toolsDir, log });

  // 1. Get the bytes. Chunk-level where a depot key is cached, which is about 70 MB for
  // the model and its whole material tree; whole 105 MB archive parts otherwise.
  log("borrowing the CT model and its locomotion clips from CS2…");
  const count = await borrowAssets({
    cs2Dir,
    toolsDir,
    cli,
    roots: [
      `${CT_MODEL}_c`,
      ...CT_CLIPS.map((clip) => `${CLIP_DIR}/${clip}.vnmclip_c`),
    ],
    log,
  });
  log(`${count} CS2 assets are readable locally`);

  const workDir = join(toolsDir, "work", "player-model");
  await rm(workDir, { recursive: true, force: true });

  // 2. The body, its materials and its skeleton. --gltf_export_animations is what makes
  // the exporter write the skeleton at all, so it stays on even though the two clips it
  // brings along are thrown away in step 4.
  log("exporting the body, its materials and its skeleton…");
  const modelDir = join(workDir, "model");
  await exportGlb({
    cli,
    cs2Dir,
    path: CT_MODEL,
    dir: modelDir,
    extra: [
      "--gltf_export_materials",
      "--gltf_textures_adapt",
      "--gltf_export_animations",
      "--gltf_mesh_list",
      CT_MESHES.join(","),
    ],
  });
  const modelGlb = join(modelDir, `${CT_MODEL.replace(/\.vmdl$/, "")}.glb`);
  if (!existsSync(modelGlb)) {
    throw new Error(
      `the exporter produced no glb for ${CT_MODEL}. Looked for ${modelGlb}, found ` +
        `${(await readdir(modelDir).catch(() => [])).join(", ") || "nothing"}`,
    );
  }

  // 3. One glb per clip: a skeleton with no mesh, and the clip on it.
  log(`exporting ${CT_CLIPS.length} locomotion clips…`);
  const clipDir = join(workDir, "clips");
  const clipGlbs = [];
  for (const clip of CT_CLIPS) {
    const path = `${CLIP_DIR}/${clip}.vnmclip`;
    await exportGlb({ cli, cs2Dir, path, dir: clipDir });
    const glb = join(clipDir, `${CLIP_DIR}/${clip}.glb`);
    if (!existsSync(glb)) {
      throw new Error(`the exporter produced no glb for the clip ${clip}`);
    }
    clipGlbs.push([clip, glb]);
  }

  // 4. Point the clips at the body's own bones.
  log("merging the clips onto the model's skeleton…");
  const mergedGlb = join(workDir, "ct.merged.glb");
  const clips = await mergeClips({
    modelGlb,
    clipGlbs,
    output: mergedGlb,
    log,
  });
  log(`${clips.length} clips merged: ${clips.join(", ")}`);

  // 5. Shrink. Nearly all of the size is the body and glove textures, so that is what
  // this is for; the meshes are packed losslessly.
  log("compressing…");
  const packed = join(workDir, "ct.opt.glb");
  await run(
    GLTF_TRANSFORM,
    optimizerArgs(mergedGlb, packed, textureSize),
    BIG_OUTPUT,
  );

  const final = join(outputDir, "ct.glb");
  const temporary = join(outputDir, ".ct.tmp.glb");
  await copyFile(existsSync(packed) ? packed : mergedGlb, temporary);
  await validateGlb(temporary);
  await rename(temporary, final);

  const { size } = await stat(final);
  log(`wrote ${final} at ${(size / 1e6).toFixed(1)} MB`);
  if (cleanup) await rm(workDir, { recursive: true, force: true });

  return { path: final, size, clips };
};
