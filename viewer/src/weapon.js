// What the runner is holding.
//
// CS2KZ hands you a knife in vanilla mode and a USP-S in classic, and that is the whole
// list: a KZ run never picks anything up. So the run's own mode decides, and the two models
// come out of the depot the same way the body does — see src/playerModelPipeline.js.
//
// Two quite separate things are drawn, and the reason they are separate is the reason first
// person works at all.
//
//   From outside, the rigid weapon model hangs off the body's `wpn` bone, which every
//   locomotion clip drives, so the clip places it and there is nothing to tune.
//
//   From inside, none of that is used. CS2's first person is not the player seen from a
//   funny angle: it is a second little scene — its own arms model on its own skeleton, posed
//   by its own clips in a space measured from the camera — and `models/vm-pistol.glb` and
//   `models/vm-knife.glb` are exactly that, arms and weapon and idle welded into one file.
//   Hang it off the camera and the pose is the placement; there is nothing to line up.
//
// The route not taken, because it was tried: pose the character's own first-person arms with
// the third-person locomotion clips. Those clips move a body being looked at from outside.
// Inside, the arms swing wide, the gun sweeps up over the shoulder, the open cut above the
// elbow points at the camera, and a run's stride heaves the whole picture.

import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { disposeGlb, loadGlb } from "./glbAsset.js";
import {
  VRF_UNITS_PER_EXPORTED_METRE,
  VRF_YAW_CORRECTION,
} from "./vrfExport.js";

/**
 * The hand models, keyed by stance rather than by weapon name.
 *
 * One mapping from a run's mode, not two. stanceForMode() in character.js already answers
 * "pistol or knife" for the body's pose, and the same answer picks the mesh in the hand and
 * the first-person viewmodel — so everything here is keyed on its output and there is no
 * second place for the two to disagree. The file names stay the weapons' own.
 */
const WEAPON_URLS = {
  pistol: "models/usp.glb",
  knife: "models/knife.glb",
};

/**
 * The bone on the body that says where the weapon goes.
 *
 * Same name and same job as the one in the viewmodel's arms, and it took two wrong answers
 * to find it. `hand_R` is the wrong bone: it is where the hand is, not where the weapon is,
 * and its authored axes point nowhere useful — so a weapon parented to it needs a rotation
 * worked out by hand, and a rotation that fits one pose fits no other. The gun ended up
 * eight units above the hand with the barrel pointing back over the shoulder, which is
 * exactly what a stale hand-tuned constant looks like.
 *
 * `wpn` is the bone CS2 animates for this, and the locomotion clips drive it and its parent
 * `wpnPivot` on every frame. Hang the weapon off it with no transform of its own and the
 * clip does the placing: the right position, the right angle, in every pose, for both
 * weapons, with nothing left to tune.
 */
export const WEAPON_BONE = "wpn";

/** Fetch a whole set of models at once, keeping the names they are asked for by. */
const loadAll = async (urls) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(urls).map(async ([name, url]) => [
        name,
        await loadGlb(url),
      ]),
    ),
  );

/**
 * Give every mesh of a freshly cloned model its own material, lit with the character.
 *
 * Cloned materials because the same asset is drawn twice and only one of the two is tinted,
 * and the clone is the caller's to free. Never culled because the bounding box of a skinned
 * mesh is its bind pose, which for a pair of arms held at the camera is nowhere near where
 * they are drawn.
 *
 * @returns the clones, for dispose()
 */
const dressMeshes = ({ model, layer, tint = null }) => {
  const materials = [];
  model.traverse((child) => {
    if (!child.isMesh) return;
    child.frustumCulled = false;
    child.layers.enable(layer);
    const clone = child.material.clone();
    if (tint) clone.color.set(tint);
    child.material = clone;
    materials.push(clone);
  });
  return materials;
};

/**
 * Fetch both weapons once.
 *
 * A missing file resolves to null, like the character's own: `knife.glb` and `usp.glb` come
 * out of `npm run player-model` and are not in the repository, so a checkout that has not
 * run it shows an empty-handed runner rather than failing.
 *
 * @returns { knife, usp } — gltf or null for each
 */
export const loadWeaponAssets = () => loadAll(WEAPON_URLS);

/**
 * One weapon, placed for one of the two jobs.
 *
 * @param asset what loadWeaponAssets resolved for this weapon
 * @param tint  a colour to multiply by, matching the body it belongs to
 * @param layer the light layer the body is on, so the weapon is lit with it and not
 *              with the map
 * @returns { object, dispose }
 */
export const createWeapon = ({ asset, tint = null, layer }) => {
  // One node, carrying nothing but the two corrections that undo the exporter — the same pair
  // the character itself is wrapped in. Nothing tuned, because `wpn` has already been posed
  // by the clip and there is nothing left to say.
  const object = new THREE.Group();
  object.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE);
  object.rotation.y = VRF_YAW_CORRECTION;

  // A plain clone is enough here, unlike everywhere else in this project: a weapon in the
  // hand is a rigid mesh with no skeleton to rebind.
  const model = asset.scene.clone(true);
  const materials = dressMeshes({ model, layer, tint });
  object.add(model);

  return {
    object,

    dispose: () => {
      for (const material of materials) material.dispose();
      object.removeFromParent();
    },
  };
};

/** Free the shared assets, once no instance points at them. */
export const disposeWeaponAssets = (assets) => {
  for (const asset of Object.values(assets ?? {})) disposeGlb(asset);
};

// --- the first-person viewmodel ---------------------------------------------

/** One file per clip set, holding the arms, the weapon and their shared idle. */
const VIEW_MODEL_URLS = {
  pistol: "models/vm-pistol.glb",
  knife: "models/vm-knife.glb",
};

/**
 * Which way the viewmodel faces once it is hanging off the camera.
 *
 * Two turns about the up axis, and only one of them is guesswork. The first undoes the
 * exporter, as everywhere else in this project. The second is the difference between the
 * space the clip is authored in and the space a three.js camera looks along: a Source model
 * points down its own +x, a camera looks down its own -z, and a quarter turn is what takes
 * one onto the other.
 */
const VIEW_MODEL_YAW = VRF_YAW_CORRECTION + Math.PI / 2;

/**
 * Where each viewmodel sits relative to the eye, in Source units, and how big.
 *
 * The clip already places the hands about a foot ahead of the camera and half that below it,
 * so these are corrections and not placements. They exist for reasons the clip cannot know
 * about:
 *
 *   Down, because the arms end in an open cut above the elbow and a hole is what you see
 *   through it. CS2 keeps that off screen with a viewmodel camera of its own; dropping the
 *   whole assembly does the same job with the camera we have.
 *
 *   Forward and right, because that camera is at a 90° field of view where the clip was
 *   authored for 68. A weapon 30cm from the eye of a 68° camera is most of a 90° one's
 *   screen; pushing it out to about two feet brings it back to the quarter of the picture a
 *   viewmodel is supposed to be, and off to the right is where a right-handed one belongs.
 *
 *   `scale` last, because pushing the assembly out to fix the field of view also shrinks it,
 *   and the two weapons do not want the same compromise: a knife is held closer to the body
 *   than a pistol, so the same push leaves it small. Scaling is not the same as moving —
 *   moving changes how much of the arm is on screen, scaling does not — which is why both are
 *   here.
 *
 * Per weapon, and measured against screenshots at a 90° first-person view, which is the only
 * view this is ever drawn in. Change the field of view and these want revisiting.
 */
const VIEW_MODEL_PLACEMENT = {
  pistol: { right: 3, up: -8, forward: 14, scale: 1 },
  knife: { right: 3, up: -19, forward: 11, scale: 1.45 },
};

/**
 * How much the viewmodel sways with the runner's stride, and how fast.
 *
 * Almost none, on purpose, and slow. The clip is an idle, so this and the idle are the only
 * movement there is, and the alternative to a trace of it is a weapon nailed to the glass
 * while the world rushes past.
 *
 * The rate is the part that had to come down hardest. A KZ runner covers four hundred units a
 * second, so a cycle every sixty units is six or seven a second — a flutter, whatever the
 * amplitude, and unpleasant to watch over a whole run. One every three hundred units is a
 * little over one a second: a sway you would call a sway.
 *
 * A sine of the distance travelled rather than an integrator, so scrubbing the replay or
 * playing it at a quarter speed cannot leave the phase somewhere the position is not.
 */
const SWAY_CYCLES_PER_UNIT = 1 / 300;
const SWAY_UNITS_AT_FULL_SPEED = 0.3;
const SWAY_FULL_SPEED = 400;

/**
 * How fast the idle itself plays.
 *
 * CS2 runs this pose under a graph that blends movement over the top of it, and on its own at
 * full rate it reads as a pair of hands fidgeting. Slowed right down it does the one job it is
 * wanted for here: the weapon is not a photograph.
 */
const IDLE_TIME_SCALE = 0.2;

/**
 * Fetch both viewmodels once. Null for either that is not there, like every other model.
 *
 * @returns { pistol, knife } — gltf or null for each
 */
export const loadViewModelAssets = () => loadAll(VIEW_MODEL_URLS);

/**
 * The arms and the weapon, ready to be parented to a camera.
 *
 * @param asset what loadViewModelAssets resolved for this clip set
 * @param name  "pistol" or "knife", which picks the placement above
 * @param layer the light layer the character is on, so the same two lights reach this and
 *              the map's own dimming does not
 * @returns { object, update, dispose }
 */
export const createViewModel = ({ asset, name, layer }) => {
  const placement = VIEW_MODEL_PLACEMENT[name];

  const object = new THREE.Group();
  object.position.set(placement.right, placement.up, -placement.forward);

  const upright = new THREE.Group();
  upright.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE * placement.scale);
  upright.rotation.y = VIEW_MODEL_YAW;
  object.add(upright);

  // cloneSkinned rather than a plain clone, and not for the usual reason — there is only ever
  // one of these on screen. It is that the file holds two skinned models, and a plain clone
  // leaves both of them bound to the asset's own skeleton.
  const model = cloneSkinned(asset.scene);
  const materials = dressMeshes({ model, layer });
  upright.add(model);

  const mixer = new THREE.AnimationMixer(model);
  for (const clip of asset.animations) {
    mixer.clipAction(clip).setEffectiveTimeScale(IDLE_TIME_SCALE).play();
  }

  const restUp = object.position.y;

  return {
    object,

    /**
     * @param delta     seconds to advance the idle by. Zero while the replay is paused,
     *                  which is the whole of how this freezes with it.
     * @param travelled how far the runner has gone, in Source units
     * @param speed     their horizontal speed, which sets how far the sway reaches
     */
    update: ({ delta, travelled, speed }) => {
      mixer.update(delta);
      const reach =
        Math.min(speed / SWAY_FULL_SPEED, 1) * SWAY_UNITS_AT_FULL_SPEED;
      object.position.y =
        restUp +
        Math.sin(travelled * SWAY_CYCLES_PER_UNIT * Math.PI * 2) * reach;
    },

    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      for (const material of materials) material.dispose();
      object.removeFromParent();
    },
  };
};

/** Free the shared viewmodel assets. */
export const disposeViewModelAssets = disposeWeaponAssets;
