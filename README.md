# kz-replay

Watch CS2KZ runs in the browser. The replay file goes in, WebGL comes out.

**Live at [demo.kzcomp.com](https://demo.kzcomp.com)** — the map list, a
scrollable [world record feed](https://demo.kzcomp.com/wr), and a player that
opens any replay by id and can race two runs against each other.

![watching a run through the runner's eyes, weapon and all](docs/first-person.png)

![the same run in the follow camera, on the CT model](docs/third-person.png)

It reads the CS2KZ `.replay` format directly, rebuilds the run tick by tick, and
plays it back in three.js — through the runner's eyes, from a follow camera, or
free flight — inside the real map geometry with the map's own baked lighting and
real sky.

Map geometry is powered by [Source 2 Viewer](https://s2v.app)
([ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)).
Every converted map in this project was exported with it. The Source 2 file formats
are not documented by Valve — everything here relies on years of reverse
engineering by that project's contributors, and none of it was worked out here.

## Try it

```bash
npm install
node bin/kzreplay.js wrs --limit 6      # download the current world records
node bin/kzreplay.js map kz_victoria    # convert that map's geometry + lighting (optional)
npm run dev                             # http://localhost:5180
```

Keys: `space` play/pause, `←` `→` step (hold shift for a second at a time), `C` camera.

`/` is the map list, `/wr` is the world record feed, `/watch?ids=<id>` is one run —
see [docs/api.md](docs/api.md) for how to link to a replay or compare two by id.

## Commands

| Command                                  | What it does                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `kzreplay wrs --limit 6`                 | Fetch the current world records and build their tracks                              |
| `kzreplay wrfeed`                        | Rebuild the list the world record feed scrolls (4 calls)                            |
| `kzreplay fetch <record_id>`             | Fetch one record by id (also accepts a local file path)                             |
| `kzreplay inspect <record_id>`           | Dump the header, the section table and the timer events                             |
| `kzreplay verify --limit 60`             | Parse many replays and report any that desync                                       |
| `kzreplay map kz_victoria`               | Download and convert one map to a web glb, with its own baked lighting and real sky |
| `kzreplay map kz_victoria --no-textures` | The same without the mapper's surface textures, baked lighting only                 |
| `kzreplay refresh [--no-geometry]`       | Rebuild the map and record catalog the viewer browses                               |
| `kzreplay player-model`                  | Borrow the CT character out of CS2 for the third-person camera                      |
| `kzreplay compare <a> <b>`               | Full stats for two runs, and where the time was lost                                |
| `npm run check`                          | Section and alignment sanity check across four known run pairs                      |

Tracks are written to `viewer/public/tracks/`, which the dev server reads directly.
Downloaded `.replay` files are cached in `samples/` so re-runs need no network.

![kz_grotto with its own baked lighting](docs/grotto.jpeg)

## Documentation

- [docs/api.md](docs/api.md) — linking to a replay, comparing two by id, the HTTP endpoints
- [docs/replay-format.md](docs/replay-format.md) — how a `.replay` file is read, and where the data comes from
- [docs/maps.md](docs/maps.md) — the map pipeline: geometry, textures, baked lighting, the real sky
- [docs/comparison.md](docs/comparison.md) — how two runs are compared, in the viewer and on the CLI
- [docs/viewer.md](docs/viewer.md) — browsing, the world record feed, view counts

## Layout

```
src/          parser + track builder + API client (Node, and the browser for track.js)
bin/          the CLI
viewer/       Vite dev app
viewer/src/player.js   the three.js player — the only file that ports to other sites
server/       the production server: static viewer, replay proxy, views, nightly refresh
```

`viewer/src/player.js` is framework-free on purpose: it takes a canvas and a
decoded track. Embedding it elsewhere is a `createPlayer()` and a `dispose()`.

## License

GPL-3.0 — see [LICENSE](LICENSE). `compression.cpp` is vendored unmodified from
[cs2kz-metamod](https://github.com/KZGlobalTeam/cs2kz-metamod) (also GPL-3.0)
as the reference for the replay format.
