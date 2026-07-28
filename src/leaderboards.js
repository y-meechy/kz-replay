// The four leaderboards a CS2KZ course has, named the way KZ players name them.
//
// A word on naming. The labels are PRO and TP, which is what a KZ player says out
// loud: PRO is a run with no teleports, TP is a run that used them. That maps exactly
// onto the API's `has_teleports` filter, which is the only filter it has.
//
// What is deliberately *not* here is NUB. The game's second table is NUB, meaning
// every run including the clean ones, and `has_teleports=true` is not that set — it
// is only the runs that teleported. Labelling this pair PRO and NUB would therefore
// be wrong, so it is PRO and TP, and `hasTeleports` keeps saying what the filter does.

export const LEADERBOARDS = [
  {
    id: "classic-pro",
    mode: "classic",
    hasTeleports: false,
    label: "Classic PRO",
    short: "Classic PRO",
  },
  {
    id: "classic-tp",
    mode: "classic",
    hasTeleports: true,
    label: "Classic TP",
    short: "Classic TP",
  },
  {
    id: "vanilla-pro",
    mode: "vanilla",
    hasTeleports: false,
    label: "Vanilla PRO",
    short: "Vanilla PRO",
  },
  {
    id: "vanilla-tp",
    mode: "vanilla",
    hasTeleports: true,
    label: "Vanilla TP",
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
