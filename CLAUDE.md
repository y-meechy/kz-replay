# kz-replay

Parse CS2KZ `.replay` files and play runs back in the browser with three.js.
No game install needed. Node.js 24 LTS.

## Commands

```bash
npm run dev                          # viewer at http://localhost:5180
npm test                             # unit tests — must pass before pushing
npm run check                        # alignment check across known run pairs
npm run format                       # prettier (run before committing)
node bin/kzreplay.js verify --limit 60   # parse real replays; key parser integration check
node bin/kzreplay.js wrs --limit 6   # download classic world records
node bin/kzreplay.js map <name>      # convert a map (local tools, docs/maps.md)
npm run build && npm start           # production build + server
```

Real replay fixtures live in `samples/`. Run `npm run hooks:install` once to
enable the repo's git hooks.

`verify` catches format/alignment regressions (decoder throws unless it lands
on each section's last byte) but does not replace the unit tests.

## Layout

- `src/` — parser, track builder, map pipeline, API client. Only the browser-imported
  module graph (`track.js` + deps) must stay browser-compatible; the rest may use Node APIs.
- `bin/kzreplay.js` — CLI: one `commands` object, hand-parsed flags.
- `viewer/` — Vite app. `viewer/src/player.js` is framework-free (canvas + decoded track);
  it imports viewer modules, shared `src/`, and Three.js — port its module graph, not the file alone.
- `server/index.js` — production server: static viewer, replay proxy, view counter, nightly refresh.
- `docs/` — deeper docs.

## Conventions

- Plain ES modules, no TypeScript, no viewer framework. Prettier only.
- Commits: short imperative sentences, no conventional-commit prefixes.
- Comments explain _why_ (format quirks, bug that forced a check), not what.
- Format version 5 is the max supported; parser refuses newer versions.
- Replay format source of truth: AGPL-3.0 cs2kz-metamod plugin; `src/ticks.js` ports its
  tick decoder. Keep the pinned upstream link and attribution in `docs/replay-format.md`
  and `docs/third-party-notices.md`.
