# Map guessr

`/guessr` is a five-round "which map is this?" minigame. Each round shows a small,
disconnected slab of real map geometry with a real run's route drawn through it —
no sky, no textures, no map name — and asks which map and course it came from.
`node bin/kzreplay.js guessr --limit 40` builds the rounds; the game itself is
`viewer/src/guessr.js` and `viewer/src/guessrScene.js`.

## Data contract

Two kinds of file, both static and both served from `viewer/public/data/`:

- **`guessr.json`**, the manifest. One entry per playable round: `id`, `file`
  (the chunk's path), and `triangles` (used only to size the loading state).
  Nothing else — a browser network tab is never allowed to read off the answer
  before a round is played, so map name, course, position and record id are all
  absent here on purpose.
- **`guessr/<id>.json`**, one per round. `id` is a 12-character hex hash of
  `map|course|board|candidateIndex`, opaque so the filename itself leaks nothing.
  Its fields:
  - `size` — the cube's edge length (512 units by default).
  - `triangles` — triangle count in this chunk.
  - `positions` — flat `[x, y, z, ...]` triples, one per triangle vertex, rounded
    to two decimals, centred on the chunk's own origin (not world space).
  - `route` — flat `[x, y, z, ...]` pairs (each consecutive pair is one drawn
    segment) for the run's path through the chunk, in the same local space.
  - `answer` — `map`, `course`, `mode` (leaderboard board, e.g. `classic-pro`),
    `recordId`, `player`, `time`. This is the one file that does carry the
    answer — see "no backend" below for why that's fine.

The chunk file is the only place the game learns the truth, and it downloads
before the round is guessed. That's a deliberate trade, not an oversight: see
the note at the end.

## The coordinate transform

Three separate spaces get flattened into one before a chunk is built:

1. **GLB local → world.** Each mesh primitive's `POSITION` accessor is
   multiplied by its node's world matrix (`toViewerSpace()` in
   `src/guessrChunk.js`, using `node.getWorldMatrix()` from `@gltf-transform/core`).
   Positions are normalized int16 (`KHR_mesh_quantization`), so they are read
   through `accessor.getElement()`, which divides by 32767 — the raw array is
   32767× too big, and three.js does the same denormalization in the shader.
2. **Exported metres → viewer units.** The result is scaled by
   `VRF_UNITS_PER_EXPORTED_METRE` (39.37, i.e. `× 100 / 2.54` — Source 2 Viewer
   exports in metres, the game and this project work in inches).
3. **Yaw correction.** Source 2 Viewer's export sits 90° off from the game's own
   axes, so every point is rotated `VRF_YAW_CORRECTION` (π/2) about Y.

Both constants live in `viewer/src/vrfExport.js`, next to the viewer's own map
loader, because they only make sense paired with how that loader interprets the
same GLB.

The replay side needs one more conversion: a `.replay`'s tick positions are
game-space `(x, y, z)`, and the viewer's world is Y-up. `toWorld(x, y, z) =
[x, z, -y]` (see `routeWorldPoints()` in `src/guessrChunk.js`) turns a tick into
the same space the map geometry now lives in. Once both are in that space, all
of the chunk-building work — candidate centres, triangle clipping, route
clipping — happens entirely in viewer Y-up units.

## Candidate selection

For each map/course, `guessrBuild.js` picks the best watchable leaderboard entry
in board order (`classic-pro`, `classic-tp`, `vanilla-pro`, `vanilla-tp` — classic
is what most runs and viewers know, pro is the fuller run) and downloads its
replay if it isn't already cached in `samples/`.

The run's tick positions become a polyline in world space, with lead-in and
lead-out ticks dropped — those idle at spawn and finish, and would bias every
candidate toward a motionless, boring chunk. `routeCandidateCentres()` then
walks the polyline by arc length and tries these fractions of total distance,
in this order, stopping at the first one that produces a good chunk:

```
0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9
```

Starting from the middle and working outward keeps the chunk near the run's most
representative section instead of near its ends, where courses tend to look most
like each other (a spawn box, a finish trigger). Each candidate centre is also
lowered by `size × 0.15` on the vertical axis — un-lowered, the box would be
centred on head height, and its floor would sit just below the box's own
midline instead of inside it.

A candidate qualifies once its chunk has at least 60 triangles and geometry
from at least 3 separate mesh nodes ("about 3 brushes" — enough that the chunk
reads as a piece of level, not one lone floor slab that happens to clear a
triangle count); among the qualifying candidates, the one closest to 1500
triangles wins — chunks ship as committed JSON, so the densest spot would be a
megabyte of prop clutter without being any more guessable. A winner over 4000
triangles is trimmed to its 4000 largest faces, which drops small prop detail
and keeps the structure. If none
of the seven candidates qualify, the builder retries the whole selection with a
1.5× and then 2× box (sparse open maps often have no dense spot at the default
size, but a bigger box brings the surrounding structure into view). Only when
that fails too is the map/course skipped and reported — `kz_avalon`,
`kz_cherry`, and `kz_kuutio`, among others, currently have too little geometry
within reach of their routes to ever pass.

## Scoring

Five rounds per game (`ROUNDS_PER_GAME` in `viewer/src/guessr.js`). Each round is
scored independently and summed:

| Result                          | Points |
| -------------------------------- | ------ |
| Correct map                      | 100    |
| Correct map + correct course      | +50    |
| Answered in under 30 seconds      | +25    |
| Answered in 30–60 seconds         | +10    |
| Wrong map                        | 0      |

Maximum is 175 per round, 875 for a five-round game. Course credit only applies
on top of a correct map guess; a wrong map scores 0 regardless of course or
speed.

## No backend, no session — on purpose

The chunk file's `answer` field ships to the browser before the round is
guessed, which means anyone with dev tools open can read the correct map before
clicking anything. That's accepted, not missed: this project has no game server
to hold a session or check a guess server-side, and building one just for this
minigame isn't worth it. The manifest is the one file kept answer-free, which
stops the *list of rounds* from being a spoiler; the honor system covers the
rest, the same way it would for a physical trivia card face-down on a table.
