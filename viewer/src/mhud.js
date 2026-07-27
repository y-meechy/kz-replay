// The movement HUD, as KZ players know it from CS:GO.
//
// Bottom centre, deliberately small: the speed the runner is carrying and the keys
// they are holding, and nothing else. It sits over the run, so anything that is not
// worth reading sixty times a second belongs in the stats panel instead.

/**
 * A movement key counts as held above this.
 *
 * The move axes are not a clean 0/1: measured against the replay's real button
 * mask they sit around 0.88 while a key is held, and dip through smaller values on
 * the tick a key is pressed or released.
 */
const KEY_HELD = 0.25;

/**
 * Upward speed that means the runner has just jumped.
 *
 * The jump button alone cannot answer this. CS2 takes jump input between ticks, so
 * a scroll-wheel hop never shows the button held in the per-tick mask at all:
 * measured across the sample replays the mask misses two thirds of the real jumps,
 * including every perf. The impulse is unambiguous, always 286-296 against 100 or
 * less for a runner who simply walked off an edge, and gravity bleeds it away
 * within a few ticks, so testing for it lights the key for a moment on every real
 * jump however it was bound.
 */
const JUMP_IMPULSE = 250; // units per second, upward

/**
 * The HUD.
 *
 * @param root  the .mhud element from index.html
 */
export const createMhud = ({ root }) => {
  const speedValue = root.querySelector("[data-mhud=speed]");
  const keyBoxes = Object.fromEntries(
    ["w", "a", "s", "d", "duck", "jump"].map((key) => [
      key,
      root.querySelector(`[data-key=${key}]`),
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
    setKey("w", frame.forward > KEY_HELD);
    setKey("s", frame.forward < -KEY_HELD);
    setKey("a", frame.left > KEY_HELD);
    setKey("d", frame.left < -KEY_HELD);
    setKey("duck", frame.ducking);
    setKey("jump", frame.jumping || frame.verticalSpeed > JUMP_IMPULSE);
  };

  return { update, setVisible };
};
