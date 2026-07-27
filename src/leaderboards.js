// The four leaderboards a CS2KZ course has, named the way the API filters them.
//
// A word on naming. The game calls the two tables PRO and NUB: PRO is runs with no
// teleports, NUB is every run. The API has no "nub" filter — it has
// `has_teleports`, which selects runs that DID use teleports. That is not the same
// set, so calling it NUB here would be a lie. The labels say what the filter does.

export const LEADERBOARDS = [
  {
    id: "classic-pro",
    mode: "classic",
    hasTeleports: false,
    label: "Classic · no teleports",
    short: "Classic",
  },
  {
    id: "classic-tp",
    mode: "classic",
    hasTeleports: true,
    label: "Classic · with teleports",
    short: "Classic TP",
  },
  {
    id: "vanilla-pro",
    mode: "vanilla",
    hasTeleports: false,
    label: "Vanilla · no teleports",
    short: "Vanilla",
  },
  {
    id: "vanilla-tp",
    mode: "vanilla",
    hasTeleports: true,
    label: "Vanilla · with teleports",
    short: "Vanilla TP",
  },
];

export const leaderboardById = (id) =>
  LEADERBOARDS.find((board) => board.id === id) ?? LEADERBOARDS[0];

/**
 * Key for one leaderboard of one course.
 *
 * Course names contain spaces, apostrophes and mixed case ("word's backyard"), so
 * the separator has to be a character a name cannot contain. A pipe is safe and
 * stays readable in the JSON.
 */
export const leaderboardKey = (mapName, courseName, boardId) =>
  `${mapName}|${courseName}|${boardId}`;
