# kz-replay

Read CS2KZ `.replay` files and play the runs back in the browser with three.js.
Playback needs no game install or video rendering; optional map and character
conversion fetches selected game assets. The README and `docs/` explain the how
and why in depth; this file is the working knowledge you need to change the code
safely.

Use Node.js 24 LTS and the npm version bundled with it.

## Commands

```bash
npm run dev                          # viewer at http://localhost:5180
npm test                             # node --test src/*.test.js — must pass before pushing
npm run check                        # alignment sanity check across known run pairs
npm run format                       # prettier over src, bin, viewer, scripts
node bin/kzreplay.js wrs --limit 6   # download retained classic world records
node bin/kzreplay.js verify --limit 60   # parse retained real replays, report desyncs
node bin/kzreplay.js map kz_victoria # convert a map (needs local tools, see docs/maps.md)
```

`node bin/kzreplay.js verify` is an important integration check for the parser:
the decoder throws unless it lands exactly on the last byte of each section, so
parsing many real replays catches format and alignment regressions. It is not a
proof of every version, section, or semantic rule and does not replace the unit
tests.

## Layout

- `src/` — replay parser, track builder, map pipeline, API client. Many pipeline
  modules use Node APIs such as `fs`, `path`, and `child_process`. Only the module
  graph imported by the browser must remain browser-compatible; `track.js` and
  its current dependencies run in both places.
- `bin/kzreplay.js` — the CLI. One `commands` object, flags parsed by hand.
- `viewer/` — Vite app. `viewer/src/player.js` is deliberately framework-free:
  it takes a canvas and a decoded track, but imports adjacent viewer modules,
  shared `src/` modules, and Three.js. Port its module graph, not that file alone.
- `server/index.js` — the production server: static viewer, replay proxy,
  view counter, nightly refresh.
- `docs/` — the deeper documentation the README links to.

## Rules that exist because they were broken once

- **Never let the parser guess.** A wrong field size produces plausible-looking
  garbage, not an error, so every reader checks it consumed exactly what the
  header promised and throws otherwise. Keep that property in any new reader.
- **A replay holds many attempts.** The run is the stretch from the _last_
  timer start before the finish. Measuring from the first start silently
  corrupts every derived statistic.
- **Foliage trimming matches whole words between separators**, never
  substrings, and never deletes meshes under 150 triangles. A substring match
  once deleted the floors of kz_grotto.
- **Generated data is not hand-edited source.** `viewer/public/maps/`,
  `viewer/public/tracks/`, `samples/`, and `tools/` are ignored caches and build
  outputs. Four generated JSON snapshots under `viewer/public/data/` are committed
  as development data and Docker seeds; rebuild them with the CLI rather than
  editing them by hand.
- **View counts live in `KZ_STATE_DIR`, not `KZ_DATA_DIR`.** Everything in the
  data dir is replaceable and reseeded on boot; the view counter is the one
  file visitors wrote and must survive a redeploy.

## Conventions

- Plain ES modules, no TypeScript, no framework in the viewer.
- Prettier is the only formatter; run `npm run format` before committing.
- Commit messages are short imperative sentences describing the change
  ("Hang the follow camera on a gimbal…"), not conventional-commit prefixes.
- Comments explain _why_ (the format quirk, the bug that forced the check),
  not what the next line does. Match the density that is already there.
- Format version 5 is the newest supported version; the parser refuses newer
  versions instead of guessing. Source of truth for the replay format is the
  AGPL-3.0-licensed cs2kz-metamod plugin, and `src/ticks.js` is a port of its tick
  decoder. Keep the pinned upstream link and attribution in `docs/replay-format.md`
  and `docs/third-party-notices.md`.
