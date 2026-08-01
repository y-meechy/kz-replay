// Formatting shared by the browse page and the viewer.

/**
 * A run time in minutes, seconds and milliseconds.
 *
 * The clock always keeps the same shape so live playback, record cards and
 * comparisons can be read at a glance: 5.2 seconds is `0:05.200`, and 61.234
 * seconds is `1:01.234`.
 */
export const formatRunTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const remainder = totalMilliseconds - minutes * 60_000;
  const wholeSeconds = Math.floor(remainder / 1000);
  const milliseconds = remainder - wholeSeconds * 1000;
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
};

/** Signed, always three decimals: a gap of exactly zero still shows its sign slot. */
export const formatDelta = (seconds) =>
  `${seconds > 0 ? "+" : seconds < 0 ? "−" : ""}${Math.abs(seconds).toFixed(3)}s`;

export const TIER_ORDER = [
  "very-easy",
  "easy",
  "medium",
  "advanced",
  "hard",
  "very-hard",
  "extreme",
  "death",
  "unfeasible",
  "impossible",
];

export const tierLabel = (tier) => (tier ?? "?").replace(/-/g, " ");

/** 0 for the easiest tier, 1 for the hardest, for colouring a chip. */
export const tierFraction = (tier) => {
  const index = TIER_ORDER.indexOf(tier);
  return index < 0 ? 0 : index / (TIER_ORDER.length - 1);
};

/**
 * Colour a tier chip from green to red across the tier list.
 *
 * Written as inline style rather than a class per tier because the hue is computed
 * from the tier's position, and there are ten of them.
 *
 * The defaults are the map cards on the front page. The feed's slides sit on top of a
 * full screen photo and need slightly more of everything to stay readable, which is
 * the only reason this takes numbers at all.
 */
export const tierStyle = (
  tier,
  { fill = 0.18, text = 72, edge = 0.35 } = {},
) => {
  const hue = 140 - tierFraction(tier) * 140;
  return `background: hsl(${hue} 70% 45% / ${fill}); color: hsl(${hue} 80% ${text}%); border-color: hsl(${hue} 60% 50% / ${edge})`;
};

/**
 * Text going into a template literal that ends up as innerHTML.
 *
 * Map and player names come from the API, so they are not ours and never go into the
 * document unescaped.
 */
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
