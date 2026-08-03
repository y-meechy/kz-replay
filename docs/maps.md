# The map pipeline

`kzreplay map <name>` turns a Steam Workshop map into a small `.glb` the viewer
can draw, with the map's own baked lighting and its real sky. Everything here is
powered by [Source 2 Viewer](https://s2v.app)
([ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)) —
the Source 2 file formats are not documented by Valve, and everything this
project knows about them comes from that project's reverse engineering.

## Tools it needs

The map step needs three tools that are not npm packages:

- `steamcmd` (`brew install steamcmd`) — downloads the workshop map. No Steam account and no CS2 install: anonymous login is enough.
- `tools/Source2Viewer-CLI` — download `cli-macos-arm64.zip` (or your platform) from the [ValveResourceFormat releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases) and unzip it into `tools/`.
- `tools/DepotDownloader` — download the build for your platform from the [DepotDownloader releases](https://github.com/SteamRE/DepotDownloader/releases) and unzip it into `tools/`. Only the sky needs this, and only anonymously; `--no-sky` skips it.
- `xz`, for the LZMA half of the depot's chunks. Already on macOS and in the image.

For chunk-level fetching, which makes a sky cost 1 MB instead of 105, run
`pip install 'steam[client]'` and `python3 scripts/cs2-depot-key.py tools/cs2` once. Without
it everything still works, one whole 105 MB archive part at a time.

Runs whose map has not been converted still work; they play in empty space with a grid.

**Or convert a map without leaving the page.** When a run's map has not been
converted, the dev viewer shows a **Convert this map** button. Pressing it asks the
dev server to do the whole job — workshop download, geometry export, lighting,
compression — and then loads the result. The endpoint only exists on the dev server,
because the conversion needs local tools; there is no way for a browser to do it alone.

## Why the map files are small

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

## The textures are in the map. So is the lighting. The sky is not.

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
coordinate set. Textures are the default; `--no-textures` gives the surface
coordinate set back to the baked lighting.

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

## The real sky, for 3 KB

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

## Borrowing 1 MB instead of 105

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
