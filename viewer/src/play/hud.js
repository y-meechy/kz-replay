// The play page's HUD overlay.
//
// Unlike mhud.js (which reads a replay's recorded button mask), this HUD
// reads the live CKZ movement state once per rendered frame: the speed a
// KZ player watches, the prestrafe/ground/duck/tick debug line, the last
// jump's takeoff speed and perf flag, and the controls needed to get
// started — a click-to-play prompt, a key legend, and the sensitivity
// slider input.js reads from localStorage.

import { length2D } from "./vec.js";

const SENS_KEY = "kz-play-sensitivity";
const SENS_MIN = 0.5;
const SENS_MAX = 6.0;
const SENS_DEFAULT = 2.0;

const duckLabel = (state) => {
  if (state.ducked) return "ducked";
  if (state.ducking) return "ducking";
  return "standing";
};

/**
 * Builds the HUD's DOM inside `root` and returns update()/prompt helpers.
 *
 * @param root       an empty container element (e.g. #play-hud)
 * @param onSensitivityChange  called with the new sensitivity when the slider moves
 */
export const createHud = (root, { onSensitivityChange } = {}) => {
  root.innerHTML = `
    <div class="play-hud__lock-prompt" data-hud="lock-prompt">
      <div class="play-hud__lock-title">Click to play</div>
      <ul class="play-hud__legend">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</li>
        <li><kbd>Space</kbd> / scroll jump</li>
        <li><kbd>Ctrl</kbd> duck</li>
        <li><kbd>R</kbd> respawn</li>
        <li><kbd>Esc</kbd> release mouse</li>
      </ul>
      <label class="play-hud__sens">
        Sensitivity
        <input type="range" data-hud="sens-slider" min="${SENS_MIN}" max="${SENS_MAX}" step="0.1" />
        <span data-hud="sens-value"></span>
      </label>
    </div>
    <div class="play-hud__speed">
      <span class="play-hud__speed-value" data-hud="speed">0</span>
      <span class="play-hud__speed-unit">u/s</span>
    </div>
    <div class="play-hud__debug">
      <span data-hud="prestrafe"></span>
      <span data-hud="ground"></span>
      <span data-hud="duck"></span>
      <span data-hud="tick"></span>
    </div>
    <div class="play-hud__jump" data-hud="jump"></div>`;

  const lockPrompt = root.querySelector("[data-hud=lock-prompt]");
  const speedValue = root.querySelector("[data-hud=speed]");
  const prestrafeValue = root.querySelector("[data-hud=prestrafe]");
  const groundValue = root.querySelector("[data-hud=ground]");
  const duckValue = root.querySelector("[data-hud=duck]");
  const tickValue = root.querySelector("[data-hud=tick]");
  const jumpValue = root.querySelector("[data-hud=jump]");
  const sensSlider = root.querySelector("[data-hud=sens-slider]");
  const sensValue = root.querySelector("[data-hud=sens-value]");

  const storedSens = Number(localStorage.getItem(SENS_KEY));
  const sensitivity = Number.isFinite(storedSens) && storedSens > 0 ? storedSens : SENS_DEFAULT;
  sensSlider.value = String(sensitivity);
  sensValue.textContent = sensitivity.toFixed(1);

  sensSlider.addEventListener("input", () => {
    const value = Number(sensSlider.value);
    sensValue.textContent = value.toFixed(1);
    localStorage.setItem(SENS_KEY, String(value));
    onSensitivityChange?.(value);
  });

  const showLockPrompt = (visible) => {
    lockPrompt.classList.toggle("play-hud__lock-prompt--visible", visible);
  };

  // Starts visible: the pointer is never locked before the first click.
  showLockPrompt(true);

  const update = (state) => {
    const speed = length2D(state.velocity);
    speedValue.textContent = String(Math.round(speed));

    const prestrafeGain = state.prestrafeGain ?? 0;
    prestrafeValue.textContent = `prestrafe +${prestrafeGain.toFixed(1)}`;
    groundValue.textContent = state.onGround ? "ground" : "air";
    duckValue.textContent = duckLabel(state);
    tickValue.textContent = `tick ${state.tick}`;

    const lastJump = state.lastJump;
    jumpValue.textContent = lastJump
      ? `takeoff ${Math.round(lastJump.speed)} u/s${lastJump.perf ? " · PERF" : ""}`
      : "";
  };

  return {
    update,
    showLockPrompt,
  };
};
