# kz-replay

Watch CS2KZ runs in the browser. No game installed anywhere, no video rendering,
no upload to YouTube. The replay file goes in, WebGL comes out.

Stage 1 (done): the run as a path in empty space, with a live HUD.
Stage 2 (done): real map geometry, baked lighting and the real sky around the run.
Stage 3: ghost racing, embedded in the kz-tournament site.

![watching a run through the runner's eyes, weapon and all](docs/first-person.png)

![the same run in the follow camera, on the CT model](docs/third-person.png)

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

`/` is the map list, `/wr` is the world record feed, `/watch?ids=<id>` is one run.

**Or convert a map without leaving the page.** When a run's map has not been
converted, the viewer shows a **Convert this map** button. Pressing it asks the dev
server to do the whole job — workshop download, geometry export, lighting, compression — and
then loads the result. It takes a minute or two, mostly the download. The endpoint
only exists on the dev server, because the conversion needs local tools; there is no
way for a browser to do it alone.

The map step needs three tools that are not npm packages:

- `steamcmd` (`brew install steamcmd`) — downloads the workshop map. No Steam account and no CS2 install: anonymous login is enough.
- `tools/Source2Viewer-CLI` — download `cli-macos-arm64.zip` (or your platform) from the [ValveResourceFormat releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases) and unzip it into `tools/`.
- `tools/DepotDownloader` — download the build for your platform from the [DepotDownloader releases](https://github.com/SteamRE/DepotDownloader/releases) and unzip it into `tools/`. Only the sky needs this, and only anonymously; `--no-sky` skips it.
- `xz`, for the LZMA half of the depot's chunks. Already on macOS and in the image.

For chunk-level fetching, which makes a sky cost 1 MB instead of 105, run
`pip install 'steam[client]'` and `python3 scripts/cs2-depot-key.py tools/cs2` once. Without
it everything still works, one whole 105 MB archive part at a time.

Runs whose map has not been converted still work; they play in empty space with a grid.

### Why the map files are small

The raw exports are enormous — kz_victoria 27 MB, kz_grotto 175 MB, kz_moss **251 MB**
— and almost none of it is the level. Two passes in `src/trimMap.js` take care of that
before anything is compressed, and neither moves a single vertex:

- **Attributes nobody reads.** The exporter writes POSITION, NORMAL, TANGENT,
  TEXCOORD_0, TEXCOORD_1, COLOR_0 and more for every vertex. The viewer needs
  POSITION, plus the lightmap UV when the map ships baked lighting: six or seven
  streams get dropped, roughly 70 bytes per vertex down to 12 or 16.
- **Foliage.** The ten biggest meshes in kz_moss are poplar branches, dogwood
  branches and cypress trees. Leaves are millions of triangles a KZ player runs
  straight through, and they hide the level behind them.

| map         | raw export | shipped, flat | shipped, lit | triangles dropped |
| ----------- | ---------- | ------------- | ------------ | ----------------- |
| kz_victoria | 27 MB      | 0.8 MB        | 2.6 MB       | 31%               |
| kz_grotto   | 175 MB     | 2.6 MB        | 6.9 MB       | 46%               |
| kz_moss     | 251 MB     | 0.4 MB        |              | 94%               |

"Lit" is with the map's own baked lighting, which is the default. Almost all of the
difference is the lightmap UV: it is one more stream per vertex, and it stops the
compressor welding vertices that differ only in where they sit in the atlas.

Mesh simplification is still in the pipeline as a fallback for anything still over
~15 MB after trimming, but no map has needed it since.

**Foliage is matched between separators, never as a substring.** A plain
`name.includes("fern")` matched every `inferno_stone_floor` mesh in kz_grotto, deleted
the floors the run stands on, and left the run with nothing underneath it —
`probeGround()` went from finding a floor under 25 of 29 standing ticks to 0 of 29.
Meshes under 150 triangles are also never dropped, so a structural mesh survives even
if its name matches by accident. "grass" is deliberately not in the word list: a grass
blend is as likely to be the ground as a tuft.

After trimming, `probeGround()` puts the floor a median of **0.42 units** below the
player's feet on kz_victoria and **0.39** on kz_grotto. kz_moss sits at 2.3, which is
the map's own terrain, not something the trimming did.

In the overview camera the map is drawn semi-transparent. Caves and indoor maps would
otherwise bury the camera in solid rock; the inside cameras keep it opaque.

![kz_grotto with its own baked lighting](docs/grotto.jpeg)

### The textures are in the map. So is the lighting. The sky is not.

**The surface textures were the wrong conclusion, twice.** A workshop item is a VPK
holding another VPK: `maps/<map>.vpk` is the level, and beside it sit the mapper's own
`materials/` and `models/`. Reading only the inner one says a map has no textures at
all — it does, and for kz_victoria it is most of them: 44 of the 55 materials the world
names, with 123 textures, are right there in the download.

Getting them out needs one more thing. The exporter only resolves a path if it believes
it has found a game, and what it looks for is `gameinfo.gi`. So the workshop item is
unpacked into a tree shaped like an install — `game/csgo/maps/<map>.vpk` with
`materials/` and `models/` as siblings — and `gameinfo.gi` dropped at the top of it.
Without that file the export comes back with zero materials and zero textures, which is
exactly what "the textures are not in the workshop item" looked like.

| build                    | kz_victoria |
| ------------------------ | ----------- |
| shapes only              | 0.8 MB      |
| real textures at 128 px  | 2.8 MB      |
| the map's baked lighting | 2.6 MB      |

Texture pixels are nearly free: 64 px and 128 px differ by 90 KB, because the cost is
the extra vertex streams a texture needs, not the images. Both builds pay that once, and
for now they are alternatives rather than a pair — the trim pass keeps one texture
coordinate set, and `--textures` takes it.

**Surfaces with nothing to draw fall back to a colour.** Two kinds of surface come out
of a textured export with no material: the shaders glTF has no room for, like water, and
the ones whose material is a base game asset the workshop item does not carry. glTF says
a materialless primitive is white, and white is the brightest thing on screen, so they
read as holes cut in the level — 52 primitives and 47k triangles of them on kz_victoria.
They get the colour `mapColours.js` guesses from their name, which is what an untextured
map would have used anyway.

**The baked lighting is also right there.** A compiled Source 2 world ships its lightmap
set under `maps/<map>/lightmaps/`, and the meshes still carry the atlas UVs that address
it. Two of the set are worth having: `irradiance`, which is the sky colour in the open,
the bounced wall colour indoors and the soft darkening in every corner; and
`direct_light_shadows`, which is where the sun reaches. `src/mapLightmap.js` adds them in
linear light, tone maps once, and shrinks the result — 4096² (8192² on kz_grotto) down to
1024², about 250 KB of WebP for a whole map.

**The HDR has to be decoded as HDR.** The atlas is BC6H, and on kz_victoria its values
run to 5.5 with an eighth of the image brighter than white. Asking the decompiler for 8
bit output (`--texture_decode_flags ForceLDR`) does not clamp that, it wraps it, so every
sunlit patch comes back as a hard-edged dark blue block and the whole thing reads as
corruption. Reading the `.exr` and rolling the top off with `1 - exp(-light × exposure)`
is the difference between a lit level and a broken one.

**Neither the exposure nor the sun can be a fixed number.** Baked light is real
radiance, and mappers light at wildly different levels, so the exposure is measured per
map: the 98th percentile of the indirect light is put just short of white. And the sun's
own strength is not in the map at all — the shadow map is a visibility test, nothing more
— so it is invented, but as a _share of the tone curve_ rather than an amount of light.
Adding a fixed amount instead is what broke kz_grotto: its sun mask is lit almost
everywhere, so the same large number landed on nearly every pixel and the atlas came out
86% white, with every baked shadow gone.

**The baked light is added to the scene's lights, not swapped for them.** It goes in
three.js's `lightMap` slot, and the four scene lights are turned down to 40% rather than
off. Off looks better where the mapper baked light: no double lighting, no washed-out
shadows. But anywhere they baked none the surface goes to pure black, and a black
silhouette says nothing about the shape of a wall you are about to jump off — half of
kz_grotto's garden is that dark.

### The real sky, for 3 KB

Every map names its sky outright. The entity lump is plain text and says

```
skyname   "materials/skybox/sky_de_annubis.vmat"
```

and that material's one texture is a 2048×1024 HDR image in equirectangular projection —
the same projection three.js wants for a scene background, and the same one the viewer's
own gradient was already faking. So it is a straight swap of a guess for the real thing,
and at 1024×512 it is **3 KB** of WebP, written beside the map as `<map>.sky.webp`
because glTF has no slot for a background.

The material carries the map's real sun as well, `SolarPosition` and `SolarIrradiance`,
which is the one number in all of this lighting that is currently invented.

**Skies are the one thing that needs the game.** They are base game assets, and the CS2
content depot is 52 GB to download and 61 GB on disk, so `src/cs2Content.js` borrows
instead of installing:

- the depot is 479 archive parts of ~105 MB plus a 7.4 MB index, `pak01_dir.vpk`, and
  DepotDownloader can fetch files from a depot by name — so the index costs 3 MB
- the index says which part holds each of CS2's 132,585 assets, so the parts an asset
  needs are known before anything is downloaded
- ValveResourceFormat reads a partial install happily: given `gameinfo.gi`, the index and
  the parts an asset happens to live in, it resolves that asset and ignores the rest

kz_victoria's sky is in part 286, so its real sky costs one 105 MB download, once. All 58
CS2 skies together are 88 MB of asset spread over 27 parts, so every sky for every map is
a one-off 2.5 GB and then nothing. The cache lives in `tools/cs2` and only grows.

### Borrowing 1 MB instead of 105

Whole archive parts are too coarse to go further. `materials/` is spread over 323 of the
479 parts, so kz_victoria's eleven missing base game materials would be 945 MB, and every
sky 2.5 GB. But a depot is not _stored_ as those parts. Steam stores it as
content-addressed chunks of about 1 MB, the manifest says which chunks cover which bytes
of which file, and the VPK index says which bytes of which part hold a given asset. Put
the two together and an asset costs the chunks it actually overlaps.

Measured, not estimated:

| fetching                 | whole parts | chunks  |
| ------------------------ | ----------- | ------- |
| kz_victoria's sky        | 105 MB      | 1.16 MB |
| three more skies         | 105 MB      | 0.85 MB |
| all 28 CS2 sky materials | 2.5 GB      | ~15 MB  |

`src/cs2Manifest.js` answers the "which chunks" question with no network at all:
DepotDownloader already caches the manifest, and it is an eight byte header followed by
repeated protobuf FileMapping messages, each listing its chunks with offsets. It parses
2,947 files whose chunk lengths sum to exactly their file sizes. Note the 73 bytes
DepotDownloader appends after the list — walking into those with a protobuf reader raises
"unsupported wire type" on what is really the end of the data.

`src/cs2Chunks.js` fetches them. A chunk is a plain HTTPS GET by hash — the CDN serves it
to anyone who knows it — then AES, then one of two containers:

- `VSZa`: 4 byte magic, 4 byte id, a **zstd** stream, and a 15 byte trailer ending "zsv"
- `VZa`: `VZ` and a version, a crc, 5 bytes of LZMA properties, a raw LZMA1 stream, and a
  10 byte trailer ending "zv"

A depot mixes them: of pak01_286.vpk's 111 chunks, one was zstd and the rest LZMA. Any
tool written before the zstd container assumes zip and dies on `BadZipFile`, which is what
made this look undocumented rather than merely undescribed. zstd is `fzstd`, already a
dependency for the replay sections; LZMA goes through `xz`, because Node has zlib, brotli
and zstd built in and no LZMA, and the ".lzma alone" container it reads is exactly the
five property bytes and the length the chunk trailer already carries.

Every chunk is verified: its name **is** the SHA-1 of its decrypted, decompressed bytes,
so one comparison checks the key, the container and the decompressor at once. A wrong
depot key cannot quietly corrupt a VPK.

The bytes are written into a **sparse** file at their real offsets and the gaps left as
holes, which is why kz_victoria's sky leaves a 105 MB pak01_286.vpk using 1.1 MB of disk.
Nothing reads the holes: ValveResourceFormat seeks to an asset's offset and reads its
length, and the index it seeks by is a file fetched in full.

**One thing is not reachable from Node: the depot key.** It comes over Steam's own
protocol, which is days of work to implement and two calls through Python's `steam`
package. Keys rotate rarely, so `scripts/cs2-depot-key.py` fetches it once into
`<cs2Dir>/depot-access.json` and everything after that is Node. Production never needs
Python — copy that one file onto the volume.

Materials come with their textures, because a compiled texture is named after the material
that owns it: `sky_de_annubis.vmat_c` draws nothing without
`sky_de_annubis_exr_2c5e0b53.vtex_c`. So everything sharing the name is fetched together.
That over-matches when one name is a prefix of another, which costs a few extra chunks.

The map also ships its own **3D skybox** as a whole second world,
`maps/<map>_skybox.vpk`, with its own lightmaps. That is the distant scenery past the
level edge, it needs no download at all, and nothing reads it yet.

## Commands

| Command                               | What it does                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `kzreplay wrs --limit 6`              | Fetch the current world records and build their tracks                              |
| `kzreplay wrfeed`                     | Rebuild the list the world record feed scrolls (4 calls)                            |
| `kzreplay fetch <record_id>`          | Fetch one record by id (also accepts a local file path)                             |
| `kzreplay inspect <record_id>`        | Dump the header, the section table and the timer events                             |
| `kzreplay verify --limit 60`          | Parse many replays and report any that desync                                       |
| `kzreplay map kz_victoria`            | Download and convert one map to a web glb, with its own baked lighting and real sky |
| `kzreplay map kz_victoria --textures` | The same, with the mapper's own surface textures instead of the baked lighting      |
| `kzreplay refresh [--no-geometry]`    | Rebuild the map and record catalog the viewer browses                               |
| `kzreplay player-model`               | Borrow the CT character out of CS2 for the third-person camera                      |
| `kzreplay compare <a> <b>`            | Full stats for two runs, and where the time was lost                                |
| `npm run check`                       | Section and alignment sanity check across four known run pairs                      |

Tracks are written to `viewer/public/tracks/`, which the dev server reads directly.
Downloaded `.replay` files are cached in `samples/` so re-runs need no network.

## The world record feed

`/wr` is the newest world records in the game, one screen each, scrolled like a
phone feed. No map to pick, no course, no mode: it opens on the record that was set
most recently and plays it through the runner's eyes, on loop, in the real map. Scroll
for the one before it. **Open in player** hands the run to `/watch` with everything
else — cameras, the timeline, the comparison.

There are no controls on a feed card on purpose. A feed is for deciding whether a run
is worth your attention, and every knob it could grow already exists one button away.

Two things make sixty records affordable on a phone:

- **One canvas and one renderer, not sixty.** The canvas sits under the cards and
  draws whichever card is on screen. Every other card covers it with the map's Steam
  picture, which is also what hides the previous run while you scroll past it.
- **Nothing loads until the scroll settles**, and the _next_ run is fetched in the
  background while you watch the current one, so a swipe usually has nothing to wait
  for. A replay is a few hundred kilobytes and the browser caches it.

The list itself is `viewer/public/data/wrs.json`, four API requests, rebuilt by the
nightly refresh and by `kzreplay wrfeed`. Records whose replay file is gone are left
out: browse has something honest to say about a record it cannot play, a feed does
not.

**Where the dates come from.** The API sorts records by submission date but never
returns one. Record ids are UUIDv7, whose first 48 bits are the millisecond the id was
made, so the date is in the id — and the ids come back in exactly the order the API's
own sort puts them, which is the check that it is the right number rather than a
plausible one.

## Views

Every run shows how many people have watched it: on a feed card, on the watch page,
and in a map's sheet on the front page.

A view is not a page load. It is counted once the run has actually played for a few
seconds, and once per browser per run per six hours — so a reload, a mis-click, a link
preview and scrolling back up the feed all add nothing. The browser keeps a random id
of its own making so the server can tell a repeat from a new person without knowing
anything about either, and the server keeps its own six hour memory of the same thing
plus a generous per-address cap, which is what stops a loop in a console from being a
free counter.

The counts are one JSON file of integers in `KZ_STATE_DIR`, written a second after the
last change. That is deliberately not `KZ_DATA_DIR`: everything in there is generated,
replaceable, and reseeded from the image on first boot, and the one number visitors
wrote must survive all three.

    GET  /api/views?ids=<id>,<id>   counts for those runs, plus the total
    POST /api/views/<id>            count one view

## Browsing and watching runs

The home screen lists the current CS2KZ maps with their Steam Workshop images.
Filter by name or geometry availability, open a map, then choose a course and mode.
The viewer offers the world record when its replay exists and otherwise falls back
to the fastest available replay on that leaderboard.

This works because nothing in `src/` uses a Node API: the same parser, track builder
and analysis run in either place. The one exception is the download itself —
`replays.cs2kz.org` sends no CORS headers, so the dev server proxies `/replay/<id>`
to it (see `viewer/vite.config.js`). A deployed viewer needs the same one line of
proxying somewhere server side. The API itself does send CORS headers and is called
directly.

## Comparing two runs in the viewer

![the full comparison view](docs/analysis.png)

Open a map and paste another replay id into **Compare with replay ID**. Compatible
runs load immediately; mismatched maps, courses, or modes are rejected with a clear
message instead of producing a misleading comparison.

**Analysis** opens one focused, clickable time-gap chart, the section table, and
side-by-side run statistics. Shaded bands keep the important gains and losses
visible, and clicking anywhere on the graph seeks both replays to that point on the
course.

**The section table is where the time actually went.** The course is cut at the
places both runs touched the ground: in KZ a run is airborne about 90% of the time,
so a touchdown is a rare, deliberate event, and two runs landing within a block's
width of each other were standing on the same thing. Each section is then timed on
each run's own clock, in whole ticks, which has two consequences worth knowing:

- A section time owes nothing to how well the two lines were matched up. It is a
  tick count between two events that really happened in both runs.
- The section deltas telescope, so they add up to the finishing gap exactly. The
  table can never tell a story the scoreboard disagrees with.

Landings come in bursts, so boundaries are thinned until every section lasts at least
1.5s, and a stretch with no landing at all — a slide, a ladder, a long run-up — is cut
by distance instead and marked as such. Anything under two ticks is left uncoloured:
section times are exact, so a difference nobody could feel should not be dressed up as
a mistake.

**The most useful number in there** is the split between _a longer line_ and _less
speed_. Time is distance over speed, so a gap can only come from covering more
ground or moving slower. Splitting it exactly:

```
Δt = (challengerDistance − referenceDistance) / referenceSpeed      ← the line
   + challengerDistance · (1/challengerSpeed − 1/referenceSpeed)    ← the speed
```

turns "you lost 0.58s here" into "0.12s of that was a wider line, 0.46s was less
speed", which is the difference between a routing mistake and a movement mistake.

- Both runs play on one clock, so one visibly pulls ahead. Cyan is the run you
  selected, amber is the rival.
- **Gap now** is the time difference _at this point on the course_, not at this
  moment in time. **Apart** is how far apart the two players are in world units.
- The chart along the bottom is the gap over the whole course. Above the centre
  line the rival is behind, below it they are ahead. Where the line slopes upwards,
  the rival is losing time right there. The playhead marks where the run is now.
- The alignment runs in the browser from the two track files, so any pair works
  with no extra build step. It takes a few hundred milliseconds.

The chart's y axis is scaled to the 98th percentile of the gap, not the maximum:
where the two lines cross, the projection can throw one spiky sample, and scaling
to that would flatten everything worth looking at.

## Comparing two runs on the command line

```bash
node bin/kzreplay.js compare <faster_id> <slower_id> [--seconds 1.5] [--json out.json]
```

The point of the comparison is that **the two runs are never compared at the same
moment in time, only at the same point on the course.** "0.3s behind at the finish"
says nothing about where those 0.3s went, and the two runs take different lines, so
distance travelled is not comparable either: a wider line is longer, not further
along.

So one run is the reference, and every tick of the other is projected onto the
reference's path to answer "how far along the course was this?". That gives both
runs a shared axis, and the time difference along it is the racing delta everyone
already understands from F1 or Trackmania.

The section table then cuts that axis at the landings both runs share, as above, and
`--seconds` sets the shortest section worth a row.

The report covers the section-by-section delta with a chart, the biggest gains and
losses, speed, route length and efficiency, air and ground time, every jump with
takeoff speed, airtime, distance, strafe count and sync, perfect bhop rate, aim
movement, key hold times, how far apart the two lines are, and a jump by jump table
matched by position on the course.

`--json` writes the whole thing, including the delta curve, for charting later.

## How a replay is read

```
u32               headerSize
byte[headerSize]  protobuf ReplayHeader     -> src/header.js
section           TickData                  -> src/ticks.js   (delta encoded, zstd)
section           SubtickData               (skipped: not needed at 64 Hz)
section           Weapons, Jumps            (skipped)
section           Events                    -> src/events.js  (timer start/end, teleports)
section           CmdData, CmdSubtickData    (skipped)
```

Each section is `u32 compressedSize, u32 uncompressedSize, u32 elementCount` and
one zstd frame.

Tick data is delta encoded: every tick starts with a `u64` change-flag mask, then
carries only the fields that changed. Unchanged fields inherit from the previous
tick, `pre` from the previous tick's `post`, and `post` from this tick's `pre`.

**A replay usually holds more than one attempt.** The player starts, resets, starts
again, and only the last attempt is the run that was submitted. So the run is the
stretch from the last timer start _before_ the finish. Measuring from the first start
silently swallows the failed attempts: on one kz_grotto run that made the duration
16.5s instead of 14.97s and quietly corrupted every statistic derived from it, and it
made two runs on kz_topsecret look like they were on different routes entirely.

**The decoder must land exactly on the last byte of the section.** It throws if it
does not, because a single wrong field size shifts everything after it and the
output would still look plausible. That check is the test suite. `kzreplay verify`
runs it across many real replays.

Source of truth for the format is the plugin itself:
`cs2kz-metamod/src/kz/replays/{kz_replay.h,data.cpp,compression.cpp}` and
`protobuf/kz_replay.proto`. `compression.cpp` is vendored here for reference.
Format version 5 is current; the parser refuses anything newer instead of guessing.

## Where the data comes from

- Records: `https://api.cs2kz.org/records` — the `replay_available` field says whether a replay exists.
- Replay files: `https://replays.cs2kz.org/<record_id>` — public, no auth. This URL is not in the OpenAPI spec; it comes from the plugin source.

**Retention matters.** The API deletes replays older than about 24 hours unless the
record is a world record, a top 10 on a ranked course, or on a tier 8 course. World
records are safe forever. Anything else has to be archived the day it is set.

## Layout

```
src/          parser + track builder + API client (Node, and the browser for track.js)
bin/          the CLI
viewer/       Vite dev app
viewer/src/player.js   the three.js player — the only file that ports to the website
samples/      cached .replay downloads
```

`viewer/src/player.js` is framework-free on purpose: it takes a canvas and a
decoded track. Moving it into `kz-tournament` later is a React `useEffect` that
calls `createPlayer()` and `dispose()`, plus a Tailwind pass on the HUD.

## License

GPL-3.0 — see [LICENSE](LICENSE). `compression.cpp` is vendored unmodified from
[cs2kz-metamod](https://github.com/KZGlobalTeam/cs2kz-metamod) (also GPL-3.0)
as the reference for the replay format.
