// Mobile replay chrome and crosshair controls for the full watch player only.
// The WR feed owns a separate canvas and is intentionally unaffected.

const MOBILE_QUERY = "(max-width: 900px)";
const TAP_MOVE_TOLERANCE = 12;
const TAP_TIME_LIMIT = 450;

const watch = document.getElementById("watch");
const stage = document.getElementById("stage");
const statsPanel = document.getElementById("stats");

if (watch && stage && statsPanel) {
  const mobileLayout = window.matchMedia(MOBILE_QUERY);
  let press = null;

  const setMinimal = (minimal) => {
    const enabled = Boolean(minimal) && mobileLayout.matches && !watch.hidden;
    watch.classList.toggle("is-minimal-hud", enabled);
    watch.setAttribute("data-mobile-hud", enabled ? "minimal" : "full");
  };

  const toggleMinimal = () => {
    setMinimal(!watch.classList.contains("is-minimal-hud"));
  };

  // Treat a short, still touch as a tap. Camera drags continue to pass through to
  // the player without unexpectedly hiding its controls at the end of the drag.
  stage.addEventListener("pointerdown", (event) => {
    if (!mobileLayout.matches || event.pointerType === "mouse") return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
    };
  });

  stage.addEventListener("pointerup", (event) => {
    if (!press || press.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    const held = performance.now() - press.at;
    press = null;
    if (moved <= TAP_MOVE_TOLERANCE && held <= TAP_TIME_LIMIT) toggleMinimal();
  });

  stage.addEventListener("pointercancel", () => {
    press = null;
  });

  mobileLayout.addEventListener("change", (event) => {
    if (!event.matches) setMinimal(false);
  });

  // A classic, compact Counter-Strike-style crosshair. Off by default and kept as
  // a personal preference between runs and visits.
  const crosshair = document.createElement("div");
  crosshair.className = "replay-crosshair";
  crosshair.setAttribute("aria-hidden", "true");
  crosshair.innerHTML =
    '<i class="replay-crosshair__top"></i>' +
    '<i class="replay-crosshair__right"></i>' +
    '<i class="replay-crosshair__bottom"></i>' +
    '<i class="replay-crosshair__left"></i>';
  watch.append(crosshair);

  const row = document.createElement("label");
  row.className = "toggle replay-crosshair-toggle";
  row.innerHTML =
    '<input type="checkbox" id="crosshair-check" />' +
    "<span>Crosshair</span>" +
    '<span class="toggle__status">small CS style</span>';

  const movementHudRow = statsPanel.querySelector(".toggle--narrow-only");
  if (movementHudRow) movementHudRow.after(row);
  else statsPanel.append(row);

  const check = row.querySelector("input");
  const stored = localStorage.getItem("kz.crosshair");

  const setCrosshair = (visible) => {
    const enabled = Boolean(visible);
    crosshair.classList.toggle("is-visible", enabled);
    check.checked = enabled;
    localStorage.setItem("kz.crosshair", enabled ? "on" : "off");
  };

  check.addEventListener("change", () => setCrosshair(check.checked));
  setCrosshair(stored === "on");
}
