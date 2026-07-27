# kz-replay — Stage 1 Plan

> **Status: Stage 1 is built and Stage 2 works.**
>
> Stage 1: parser, track builder, CLI and viewer all work on real world records.
> `kzreplay verify --limit 60` parsed **57/57** replays with exact byte sync and
> timer times matching the API within one tick.
>
> Stage 2: `kzreplay map <name>` downloads a workshop map with steamcmd logged in
> anonymously (no Steam account, no CS2 install), exports its geometry with
> Source2Viewer-CLI and compresses it. kz_victoria: 26.5 MB to 5.9 MB, 368k
> triangles. Alignment is verified by `probeGround()`, which casts rays down from
> the player's feet: the floor sits a median of **0.2 units** below them.
>
> Stage 2 leftovers, in priority order:
>
> 1. **File size.** kz_grotto came out at 27 MB (1.8M triangles), far too heavy for
>    the web. Needs mesh simplification, dropping unused UVs and normals, and
>    probably discarding small props.
> 2. Three things bit hard and are worth remembering, all documented in
>    viewer/src/player.js: the exporter's 39.37 unit scale, an extra quarter turn,
>    and the map's own sun light arriving at intensity 2732 (it has to be stripped
>    or every surface clips to white).
> 3. Some ticks still find no floor. Likely ladders, boosts on props, and the one
>    prop model the exporter could not resolve.

Goal of the whole project: watch CS2KZ runs in the browser, with no game and no
video rendering anywhere. Replay file in, WebGL playback out.

Stage 1 scope: **read a replay and play the run back as a path in empty space,
with a HUD.** No map geometry. Map geometry is Stage 2.

---

## What the research established (all verified, not assumed)

### Replays are public and free to download

```
GET https://replays.cs2kz.org/<record_id>
```

- No auth, no key, CORS-unknown (server-side fetch anyway). Cloudflare R2 behind it.
- `GET https://api.cs2kz.org/records?...` already tells us which records have one:
  the field is `replay_available: true`.
- Verified: record `019f9fa9-bb00-7ca2-b435-0877bf8de90a` → 441 206 bytes,
  `content-type: application/octet-stream`.

### Retention: only good runs are kept

`cs2kz-api/crates/cs2kz/src/replays/cleaner.rs` runs every 24 h and deletes replays
older than ~24 h **unless** the record is:

- a world record, or
- top 10 on a ranked course (nub or pro), or
- on a tier 8 course.

Consequence for us: WRs and top 10s are permanently available, so the weekly
"current WR" job is safe. Anything else must be archived within a day of being set.

### File format — fully decoded

Sources: `cs2kz-metamod/protobuf/kz_replay.proto`,
`src/kz/replays/{kz_replay.h,data.cpp,compression.cpp}`.

Container:

```
u32                headerSize
byte[headerSize]   protobuf  cs2kz.replay.ReplayHeader   (proto2)
section            TickData        <- delta encoded, then zstd
section            SubtickData     <- raw structs, zstd
section            Weapons
section            Jumps
section            Events          <- timer start/end/split, teleports, mode changes
section            CmdData         (v5)
```

Every section is:

```
u32 compressedSize
u32 uncompressedSize
u32 elementCount
byte[compressedSize]   zstd frame (level 3, no dictionary)
```

TickData delta encoding, per tick:

- `u64` change-flag bitmask (bit table in `compression.cpp`, `TickDataChangeFlags`).
- Then only the changed fields, in fixed flag order, as plain little-endian values.
- Unchanged fields inherit: top-level from the previous tick, `pre` from the
  previous tick's `post`, `post` from this tick's `pre`. `serverTick` defaults to
  previous + 1.
- Sizes: `Vector`/`QAngle` = 12 B, `f32`/`u32`/`i32` = 4 B, `u64` = 8 B,
  `bool` = 1 B, `RpFlags` bitfield = 1 B, **`MoveType_t` = 1 B** (confirmed
  empirically, see below).
- Current version is `5`. The C++ read path supports 2–5 with shifted flag bits
  for v2. Reject anything above 5 loudly.

### Proof it works

`spike_parse.py` in this folder decodes a real WR replay end to end:

```
replay version : 5
player         : V 76561198882243816
map            : kz_victoria
course         : Main   mode: Classic   time: 106.664   teleports: 4
ticks          : 7402  (407286 bytes delta-encoded, 241913 compressed)
movetype size 1: consumed 407286 / 407286 -> EXACT MATCH
7402 ticks carry an origin; bbox x[-1939,1760] y[-1503,2489] z[43,723]
```

"EXACT MATCH" is the important line: the decoder ends on the last byte of the
buffer, which is only possible if every field size and every flag bit is right.
Positions and speeds are sane map coordinates.

---

## Where the code lives

**New repo `kz-replay`, sibling to `kz-tournament`.** Not inside the website.

Why:

- The parser is Node tooling with binary/zstd work. It does not belong in a
  Create React App `src/`.
- The website's build stays fast and untouched while this is unstable.
- Iteration on a three.js viewer is much faster in Vite than in CRA.

The viewer is written as a self-contained React component from day one, so
Stage 3 is a copy into `kz-tournament/src/components/Public/ReplayViewer/`
plus a Tailwind pass. The website will fetch prebuilt track files; it never
parses a `.replay`.

---

## Stage 1 build steps

1. **Scaffold** `kz-replay/` — Node 22, ESM, plain JS, Prettier. Two workspaces:
   `packages/parser` (Node lib + CLI) and `viewer` (Vite + React + three.js).

2. **`parser/src/container.js`** — walk the container: header size, protobuf
   header blob, then the section list. One function per section header read.
   Uses `fzstd` (pure JS, works in Node and browser, no native build).

3. **`parser/src/header.js`** — decode `ReplayHeader` with `protobufjs` and a
   vendored copy of `kz_replay.proto`. Vendored, not fetched, so a proto change
   upstream cannot silently change our output.

4. **`parser/src/ticks.js`** — port `DecodeTickDataBuffer`. One flag table, one
   loop, ~200 lines. Hard assert `readPtr === endPtr` at the end and throw with
   the byte delta if not. This assert is the whole test strategy.

5. **`parser/src/events.js`** — decode the Events section. `RpEvent` is a trivial
   fixed-size struct, so entry size = `uncompressedSize / elementCount`. We need
   timer start, timer end, splits and teleports.

6. **`parser/src/track.js`** — build the small file the browser gets:
   - trim to timer start → timer end using the events,
   - per tick: position, view angles, horizontal speed, movement input
     (`forward`/`left` floats, which are easier than button bits), duck state,
     on-ground flag,
   - quantise position to `int16` against the run's bounding box, angles to
     `int16`, inputs to one byte,
   - output `<record_id>.kztrack` (binary) + `<record_id>.json` (metadata:
     player, map, course, mode, time, teleports, bbox, tick rate, splits).
   - Budget: ~10 bytes per tick. A 2 minute run is about 75 KB, ~30 KB gzipped.

7. **`parser/bin/kzreplay.js`** — CLI:
   - `kzreplay fetch <record_id>` — download, parse, write track + json.
   - `kzreplay wrs --mode classic --limit N` — resolve current WRs from the API
     and fetch each. Reuses the existing query logic style from
     `kz-tournament/src/lib/cs2kz.js`.
   - `kzreplay inspect <file>` — dump header and section table for debugging.

8. **`viewer/`** — three.js:
   - path as a tube/line coloured by speed, drawn once,
   - a marker travelling the path, orbit camera and a first-person camera using
     the recorded view angles,
   - timeline scrubber, play/pause, speed control, jump-to-split,
   - HUD: run time, live speed, WASD indicator, teleport count, player and map.
   - Grid and axis helper stand in for the map. Deliberately a data-viz look.

9. **Validation pass** — run the CLI over ~50 recent records that have
   `replay_available`, plus the current WRs of 10 popular maps. Success = every
   file parses with exact byte sync, and the time computed from timer events
   matches the header time within one tick.

## Definition of done for Stage 1

- `kzreplay fetch <id>` produces a track file for any current WR.
- The viewer plays that file at 64 ticks per second with a working scrubber.
- 50+ real replays parse with zero desyncs.
- A short README documenting the format, so this is not lost knowledge.

## Known risks

- **Format version bumps.** v6 would break the tick decoder. Mitigation: the
  version is in the header, we reject unknown versions loudly rather than
  producing garbage, and the flag table lives in one file.
- **Subtick moves are ignored in Stage 1.** Playback at tick resolution will be
  very slightly smoother in game than in our viewer. Not visible at 64 Hz.
- **Non-top-10 runs expire in 24 h.** If we ever want more than WRs, archiving
  has to run daily.
- **`replays.cs2kz.org` CORS is unknown.** Irrelevant while we parse server side;
  it matters only if we ever want browser-side parsing of raw replays.
