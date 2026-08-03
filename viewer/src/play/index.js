// The play page's controller. Owns the fixed-timestep loop that ties input,
// movement and rendering together. See PLAY_PLAN.md §2.9.

import { createInput } from "./input.js";
import { createHud } from "./hud.js";
import { createPlayScene } from "./scene.js";
import { createPlayerState, movementTick, eyeHeight } from "./movement.js";
import { createTracer } from "./collision.js";
import { SPAWNS, DEFAULT_MAP, TICK_INTERVAL } from "./constants.js";

const MAX_CATCHUP_TICKS = 8;
const FALL_RESPAWN_MARGIN = 512;

export const createPlay = ({ root, canvas }) => {
  const hudRoot = root.querySelector("#play-hud");
  const input = createInput(canvas);
  const hud = createHud(hudRoot, {
    onSensitivityChange: (value) => input.setSensitivity(value),
  });
  const scene = createPlayScene({ canvas });

  let mapName = DEFAULT_MAP;
  let state = null;
  let tracer = null;
  let raf = null;
  let attached = false;

  let accumulator = 0;
  let last = 0;
  const prevOrigin = { x: 0, y: 0, z: 0 };

  // Interpolation only makes sense between two consecutive ticks, so any jump
  // in position has to reset the previous origin as well.
  const syncPrevOrigin = () => {
    prevOrigin.x = state.origin.x;
    prevOrigin.y = state.origin.y;
    prevOrigin.z = state.origin.z;
  };

  const respawn = () => {
    const spawn = SPAWNS[mapName] ?? SPAWNS[DEFAULT_MAP];
    state = createPlayerState(spawn);
    input.setViewAngles(spawn.yaw, spawn.pitch);
    syncPrevOrigin();
    accumulator = 0;
  };

  const onKeyDown = (event) => {
    if (event.code === "KeyR") respawn();
  };

  const onResize = () => scene.resize();

  const tickOnce = (cmd) => {
    syncPrevOrigin();
    movementTick(state, cmd, tracer);

    const floor = (scene.collision?.bounds.min[2] ?? -Infinity) - FALL_RESPAWN_MARGIN;
    if (state.origin.z < floor) respawn();
  };

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    if (input.isLocked) {
      accumulator += dt;
      let ticks = 0;
      while (accumulator >= TICK_INTERVAL && ticks < MAX_CATCHUP_TICKS) {
        const cmd = input.sample();
        tickOnce(cmd);
        accumulator -= TICK_INTERVAL;
        ticks++;
      }
      if (ticks === MAX_CATCHUP_TICKS) accumulator = 0;
    } else {
      // Pointer lock lost: keep rendering, but stop ticking so the player
      // does not walk off a ledge while the user is looking elsewhere.
      accumulator = 0;
    }

    const alpha = Math.min(1, accumulator / TICK_INTERVAL);
    const interpolatedOrigin = {
      x: prevOrigin.x + (state.origin.x - prevOrigin.x) * alpha,
      y: prevOrigin.y + (state.origin.y - prevOrigin.y) * alpha,
      z: prevOrigin.z + (state.origin.z - prevOrigin.z) * alpha,
    };

    scene.setView(
      interpolatedOrigin,
      eyeHeight(state),
      input.viewAngles.yaw,
      input.viewAngles.pitch,
    );
    scene.render();
    hud.update(state);
    hud.showLockPrompt(!input.isLocked);
  };

  const startLoop = () => {
    if (raf !== null) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const stopLoop = () => {
    if (raf === null) return;
    cancelAnimationFrame(raf);
    raf = null;
  };

  const show = async (name) => {
    mapName = name ?? DEFAULT_MAP;
    root.hidden = false;

    if (!attached) {
      input.attach();
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onResize);
      attached = true;
    }

    respawn();
    scene.resize();

    await scene.loadMap(`/maps/${mapName}.glb`);
    tracer = createTracer(scene.collision);
    // Re-spawn now that the collision mesh (and its bounds) is known.
    respawn();

    startLoop();
  };

  const hide = () => {
    stopLoop();
    root.hidden = true;
  };

  const dispose = () => {
    stopLoop();
    if (attached) {
      input.detach();
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      attached = false;
    }
    scene.dispose();
  };

  return { show, hide, dispose };
};
