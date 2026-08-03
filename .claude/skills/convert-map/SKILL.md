---
name: convert-map
description: Convert a CS2KZ workshop map into the web-ready glb the viewer loads, with baked lighting and the real sky. Use when asked to convert, add, rebuild, or fix a map, or when a run plays in empty space because its map is missing.
---

# Convert a map

One command does the whole job — workshop download, geometry export, trim,
lighting, sky, compression:

```bash
node bin/kzreplay.js map <map_name>              # e.g. kz_victoria
node bin/kzreplay.js map <map_name> --textures   # surface textures instead of baked lighting
node bin/kzreplay.js map <map_name> --no-sky     # skip the sky (no DepotDownloader needed)
```

Output lands in `viewer/public/maps/<map>.glb` plus `<map>.sky.webp`. The dev
server picks it up immediately.

## Prerequisites (all local, none are npm packages)

- `steamcmd` — `brew install steamcmd`, anonymous login is enough
- `tools/Source2Viewer-CLI` — from the ValveResourceFormat releases
- `tools/DepotDownloader` — only the sky needs it; `--no-sky` skips it
- optional: `python3 scripts/cs2-depot-key.py tools/cs2` once, so a sky costs
  ~1 MB of chunks instead of a whole 105 MB archive part

If a tool is missing, the CLI says which one. Don't try to replicate the
pipeline by hand.

## Judging the result

- Shipped size should be a few MB. If it is tens of MB, the trim pass failed —
  check `src/trimMap.js`, don't ship the file.
- After converting, load a run on that map and confirm the floor is under the
  player: the README documents `probeGround()` medians of ~0.4 units. A run
  floating or buried means trimming deleted structure.
- Foliage matching is whole-word only and never touches meshes under 150
  triangles. Never "fix" a size problem by loosening that rule.
