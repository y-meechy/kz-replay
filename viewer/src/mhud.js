// The movement HUD, as KZ players know it from CS:GO.
//
// Bottom centre, deliberately small: the speed the runner is carrying and the keys
// they are holding, and nothing else. It sits over the run, so anything that is not
// worth reading sixty times a second belongs in the stats panel instead.

import { JUMP_IMPULSE } from "./jumps.js";

/**
 * A movement key counts as held above this.
 *
 * The move axes are not a clean 0/1: measured against the replay's real button
 * mask they sit around 0.88 while a key is held, and dip through smaller values on
 * the tick a key is pressed or released.
 */
const KEY_HELD = 0.25;

/**
 * The HUD.
 *
 * Renders its own markup, because it lives on two pages — the watch page and the
 * WR feed — and two hand-maintained copies of the same six keys would drift.
 *
 * @param root  an empty .mhud element
 */
export const createMhud = ({ root }) => {
  root.innerHTML = `
    <div class="mhud__live">
      <div class="mhud__speed">
        <span class="mhud__speed-value" data-mhud="speed">0</span>
        <span class="mhud__speed-unit">u/s</span>
      </div>
      <!-- The takeoff speed of the last jump, in brackets under the live
           speed: the number a KZ player is actually chasing. -->
      <div class="mhud__prespeed" data-mhud="prespeed"></div>
      <!-- The KZTimer arrangement: crouch and jump flanking W on the top row,
           A S D underneath. A key that is not held shows as a bar, so the
           block keeps its shape and only the pressed keys read as letters. -->
      <div class="mhud__keys">
        <span class="mhud__key" data-key="duck">C</span>
        <span class="mhud__key" data-key="w">W</span>
        <span class="mhud__key" data-key="jump">J</span>
        <span class="mhud__key" data-key="a">A</span>
        <span class="mhud__key" data-key="s">S</span>
        <span class="mhud__key" data-key="d">D</span>
      </div>
    </div>`;

  const live = root.querySelector(".mhud__live");
  const speedValue = root.querySelector("[data-mhud=speed]");
  const prespeedValue = root.querySelector("[data-mhud=prespeed]");
  // Read off the markup above rather than listing the six keys a second time.
  const keyBoxes = Object.fromEntries(
    [...root.querySelectorAll("[data-key]")].map((box) => [
      box.dataset.key,
      box,
    ]),
  );

  let visible = false;
  // The DOM is only touched when a value actually changes. This would otherwise
  // write the same seven strings sixty times a second.
  let shown = {};

  const setSpeed = (speed) => {
    const text = String(Math.round(speed));
    if (shown.speed === text) return;
    shown.speed = text;
    speedValue.textContent = text;
  };

  // Before the first jump of a run there is no takeoff speed to show, and an
  // empty line reads better there than a zero the runner never had.
  const setPrespeed = (prespeed) => {
    const text = prespeed === null ? "" : `(${Math.round(prespeed)})`;
    if (shown.prespeed === text) return;
    shown.prespeed = text;
    prespeedValue.textContent = text;
  };

  const setPerf = (perf) => {
    if (shown.perf === perf) return;
    shown.perf = perf;
    live.classList.toggle("is-perf", perf);
  };

  const setKey = (key, held) => {
    if (shown[key] === held) return;
    shown[key] = held;
    keyBoxes[key].classList.toggle("is-held", held);
  };

  const setVisible = (on) => {
    visible = Boolean(on);
    root.hidden = !visible;
    // A hidden HUD keeps no state, so the first frame back always redraws.
    if (!visible) shown = {};
  };

  const update = (frame) => {
    if (!visible) return;
    setSpeed(frame.speed);
    setPrespeed(frame.prespeed ?? null);
    setPerf(Boolean(frame.perf));
    setKey("w", frame.forward > KEY_HELD);
    setKey("s", frame.forward < -KEY_HELD);
    setKey("a", frame.left > KEY_HELD);
    setKey("d", frame.left < -KEY_HELD);
    setKey("duck", frame.ducking);
    setKey("jump", frame.jumping || frame.verticalSpeed > JUMP_IMPULSE);
  };

  return { update, setVisible };
};
