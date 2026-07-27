// Formatting shared by the browse page and the viewer.

/**
 * A run time the way KZ writes it.
 *
 * Most runs are seconds, so `37.81` is right. But a teleport run on a long map can
 * be half an hour (kz_angina_x has a 2091 second record), and `2091.32` is not a
 * time anyone reads. Past a minute it switches to m:ss.
 */
export const formatRunTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
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
