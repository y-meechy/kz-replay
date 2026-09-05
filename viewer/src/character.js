// The runner, as a body rather than a white ball.
//
// One glb, `models/ct.glb`, holding CS2's SAS counter-terrorist and eight of the game's
// own locomotion clips. See src/playerModelPipeline.js for where it comes from. Loaded
// once and cloned per run, so showing a run against its world record costs one download.
//
// Everything this module needs, a replay already records per tick: position, view angles,
// horizontal speed, whether the player was ducking, whether they were on the ground and
// how fast they were moving up or down. So there is no physics and no guessing here —
// pickClip() is a lookup table over facts, and the mixer does the rest.
//
// Getting the body into the replay's space needs the same two corrections a map does —
// see vrfExport.js, and note the skeleton root node in the export literally carries a
// 0.0254 scale and a quarter turn. Without them the character is two units tall, a smear
// on the trail rather than a person, and facing ninety degrees off.
//
// On top of those, one thing of its own: facing. Source models face +X and the replay's
// yaw is measured from the same axis, so once the quarter turn is undone the yaw the
// track recorded is the yaw the node wants, with nothing added.

import * as THREE from "three";
// Not a plain Object3D.clone: that copies the bones and the skinned meshes separately and
// leaves both clones' meshes pointing at the original skeleton, so two bodies share one
// pose. This is the addon that rebuilds the bindings.
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { disposeGlb, loadGlb } from "./glbAsset.js";
import { applyCharacterLighting } from "./characterLighting.js";
import {
  VRF_UNITS_PER_EXPORTED_METRE,
  VRF_YAW_CORRECTION,
} from "./vrfExport.js";

export const CHARACTER_URL = "models/ct.glb";

/**
 * Below this, a player is standing still rather than walking.
 *
 * Source units a second. A tick of drift or a landing wobble is a handful of units; real
 * movement is a hundred or more, so anything in between can go either way and this only
 * has to stay out of both.
 */
const STILL_SPEED = 25;

/** Above this, running rather than walking. CS2's own walk tops out around 130. */
const RUN_SPEED = 140;

/**
 * The speed each cycle was authored at, so it can be played at the speed actually run.
 *
 * A KZ player is regularly doing 400 units a second, well past anything CS2's own
 * movement allows, and a run cycle played at its authored rate under a body moving that
 * fast is a pair of feet skating along the floor. Dividing the real speed by these gives
 * the mixer's timeScale, so the feet keep up.
 *
 * Ceilinged in update(), because a bhop at 600 would otherwise blur the legs.
 */
const AUTHORED_SPEED = { walk_n: 130, run_n: 250, crouch_n: 85 };

/**
 * Which set of locomotion clips a run's mode calls for.
 *
 * CS2 authors a whole locomotion set per weapon class and the arms are what differ between
 * them: a pistol set holds the hands out in front of the chest, a knife set carries them low
 * and to the side. CS2KZ hands you a USP in classic and a knife in vanilla, so the mode is
 * the whole of the answer.
 *
 * Deliberately a function of the mode and nothing else. It is a fact about the run, not about
 * what the viewer has been asked to draw: a runner in vanilla stands like someone holding a
 * knife whether or not anything is drawn in their hand.
 *
 * Lowercased, because the mode arrives from the replay header as the name a human reads —
 * "Classic", capital C — rather than as the identifier the rest of the codebase uses. Anything
 * unrecognised gets the knife, which is what CS2KZ's own default mode gives you.
 */
export const stanceForMode = (mode) =>
  String(mode ?? "").toLowerCase() === "classic" ? "pistol" : "knife";

/**
 * How much of the export's metalness and roughness to keep. See where they are applied.
 *
 * Measured with sampleBrightness() on a lit map, not picked: at 1 the body sat at a mean
 * luminance a viewer reads as a silhouette, and these two are where it stops looking like
 * a cut-out and starts looking like a person in dark clothing — which is what an SAS
 * operator in fact is.
 */
const METALNESS_SHARE = 0.15;
const ROUGHNESS_SHARE = 0.75;

/**
 * How much of a tinted body's colour comes from the tint itself rather than the light.
 *
 * Low: enough that the rival reads amber wherever the map is dark, not enough to turn them
 * into a glowing cutout that outshines the run's own speed colours.
 */
const RIVAL_EMISSION = 0.3;

/** How long a change of clip takes to blend. Long enough to read, short enough to keep up. */
const CROSSFADE = 0.15;

/** Fastest and slowest a cycle may be played, whatever the speed says. */
const MIN_TIME_SCALE = 0.55;
const MAX_TIME_SCALE = 2.2;

/**
 * Which clip a tick calls for.
 *
 * In the air the vertical speed decides: rising is the takeoff pose, falling is the
 * in-air one, and the two are distinct enough that a jump reads as a jump. On the ground
 * it is duck state and speed. Nothing here needs the previous frame, which is what keeps
 * the whole state machine to one expression.
 *
 * Returns the state, not a clip name: the .glb holds each of these once per stance, and which
 * stance a run uses is settled when the body is built rather than tick by tick.
 */
const pickClip = ({ speed, ducking, onGround, verticalSpeed }) => {
  if (!onGround) {
    if (ducking) return "inair_crouch_stand";
    return verticalSpeed > 0 ? "jump_stand" : "inair_stand";
  }
  if (ducking) return speed < STILL_SPEED ? "idle_crouch" : "crouch_n";
  if (speed < STILL_SPEED) return "idle";
  return speed < RUN_SPEED ? "walk_n" : "run_n";
};

/** Fetch the character once. Null when `ct.glb` is not there — see loadGlb. */
export const loadCharacterAsset = (url = CHARACTER_URL) => loadGlb(url);

/**
 * One body, ready to be put somewhere and told what it is doing.
 *
 * @param asset      what loadCharacterAsset resolved to
 * @param tint       a colour to multiply the skin by, or null for the real one. Used to
 *                   tell a rival's body from the main run's at a glance, the same way
 *                   their trail is already amber.
 * @param stance     which set of locomotion clips to pose with, from stanceForMode(). Fixed
 *                   for the life of the body, because the mode of a run is.
 * @returns { object, stance, update, dispose } — `object` to add to the scene, `update` to be
 *          called once a frame with the tick's facts.
 */
export const createCharacter = ({ asset, tint = null, stance = "pistol" }) => {
  // Two nested nodes on purpose. The outer one carries the position and the yaw, which
  // are the only things the replay drives; the inner one holds the fixed corrections that
  // undo what the exporter did. Both rotations are about the same axis and would compose
  // onto one node, but then every frame would be writing a number with a constant added
  // to it, and the day one of the two changes is the day both are wrong.
  const object = new THREE.Group();
  const upright = new THREE.Group();
  upright.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE);
  upright.rotation.y = VRF_YAW_CORRECTION;
  object.add(upright);

  const body = cloneSkinned(asset.scene);
  upright.add(body);

  // Cloned materials, not shared ones: two characters are on screen at once and the
  // rival's is tinted. Kept for dispose(), because a clone is this instance's to free.
  const materials = [];
  body.traverse((child) => {
    if (!child.isMesh) return;
    // A skinned body is always partly facing away from the light, and its own limbs
    // shadow nothing, so backface culling on a one-sided export leaves gaps at the
    // cuffs and collar. Cheap to keep both sides on a 12k-triangle mesh.
    child.frustumCulled = false;
    const clone = child.material.clone();
    applyCharacterLighting(clone);

    // A metal surface has no diffuse response: all it can show is what it reflects, and
    // this scene has three lights and no environment to reflect. So the export's own
    // metalness — CS2 marks most of a soldier's kit as metal, and the exporter writes the
    // factor as 1 and lets the texture decide — arrives as a body that is very nearly
    // black whatever the lights are doing. The factor multiplies the map, so turning it
    // down keeps the buckles brighter than the cloth without letting anything go dark.
    // Roughness the same way: fully rough spreads the one highlight there is to nothing.
    clone.metalness *= METALNESS_SHARE;
    clone.roughness *= ROUGHNESS_SHARE;
    if (tint) {
      // Both, because either alone fails. The colour factor multiplies the texture, and
      // the texture is a dark blue uniform, so amber times it comes out a muddy brown that
      // nobody would call amber. A little of the same colour as emission is what carries
      // the tint through the dark parts, and it is exactly the trick the rival's trail
      // already relies on: the second run has to be tellable from the first at a glance,
      // from any distance, in any lighting the map happens to have.
      clone.color.set(tint);
      clone.emissive.set(tint);
      clone.emissiveIntensity = RIVAL_EMISSION;
    }
    child.material = clone;
    materials.push(clone);
  });

  const mixer = new THREE.AnimationMixer(body);
  const actions = new Map();
  for (const clip of asset.animations) {
    const action = mixer.clipAction(clip);
    // A single-pose clip — CS2 authors both idles as one frame, and blends the breathing
    // in as a separate additive layer the exporter cannot follow — has nothing to loop.
    if (clip.duration === 0) action.setLoop(THREE.LoopOnce, 1);
    actions.set(clip.name, action);
  }

  let current = null;

  const play = (name) => {
    const next = actions.get(name);
    if (!next || next === current) return;
    next.reset().play();
    if (current) {
      next.crossFadeFrom(current, CROSSFADE, false);
    } else {
      next.fadeIn(0);
    }
    current = next;
  };

  return {
    object,
    // Read back for the alignment checks in player.js's debug hooks, and so that what the
    // body is posed as is answerable without inferring it from a clip name.
    stance,

    /**
     * Put the body where the replay says it was, facing where it was looking, doing what
     * it was doing.
     *
     * @param position world-space feet position, already converted by toWorld
     * @param yaw      radians, the replay's own yaw. Pitch is deliberately ignored: a
     *                 KZ player spends a run looking at their feet and then at the sky,
     *                 and a body that leaned with it would spend the run on its face.
     */
    update: ({
      position,
      yaw,
      speed,
      ducking,
      onGround,
      verticalSpeed,
      delta,
    }) => {
      object.position.copy(position);
      object.rotation.y = yaw;

      const state = pickClip({ speed, ducking, onGround, verticalSpeed });
      play(`${state}_${stance}`);

      const authored = AUTHORED_SPEED[state];
      if (current) {
        current.timeScale = authored
          ? THREE.MathUtils.clamp(
              speed / authored,
              MIN_TIME_SCALE,
              MAX_TIME_SCALE,
            )
          : 1;
      }

      mixer.update(delta);
    },

    setVisible: (visible) => {
      object.visible = visible;
    },

    /**
     * Free what this instance owns and nothing else.
     *
     * The geometry and the textures belong to the loaded asset, which every instance
     * shares — freeing those here would blank the other body on screen. The cloned
     * materials are this instance's, and the mixer holds a reference to the clone's
     * whole node tree, so it has to be told to let go.
     */
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
      for (const material of materials) material.dispose();
      object.removeFromParent();
    },
  };
};

/**
 * Free the shared asset itself, once no instance is left.
 *
 * The counterpart to createCharacter().dispose(): this is the geometry and the textures
 * that every clone pointed at.
 */
export const disposeCharacterAsset = (asset) => disposeGlb(asset);
