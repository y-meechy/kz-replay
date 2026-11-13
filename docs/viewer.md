# The viewer

## Browsing and watching runs

The home screen lists the current CS2KZ maps with their Steam Workshop images.
Filter by name or geometry availability, open a map, then choose a course and mode.
The viewer offers the world record when its replay exists and otherwise falls back
to the fastest available replay on that leaderboard.

This works because the browser-facing subset of `src/` avoids Node APIs: the
parser, track builder, and analysis modules imported by the viewer run in either
place. Other `src/` modules are Node-only pipelines and use `fs`, `path`,
`child_process`, and related APIs. The replay download itself also needs a server:
`replays.cs2kz.org` sends no CORS headers, so the dev server proxies
`/replay/<id>` to it (see `viewer/vite.config.js`). A deployed viewer needs an
equivalent proxy. The records API sends CORS headers and is called directly.

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
nightly refresh and by `node bin/kzreplay.js wrfeed`. Records whose replay file is
gone are left out: browse has something honest to say about a record it cannot play,
a feed does not.

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

The endpoints are listed in [api.md](api.md).

## Source shader corrections

The map export hands three.js every mesh's vertex colour as `COLOR_0` and each source
material's `g_vColorTint` as its glTF base colour, and GLTFLoader multiplies both into the
albedo. That is only right for shaders that use them that way.
`viewer/src/sourceShading.js` corrects two shaders, using the `extras.vmat` already inside
every converted GLB, so **no reconversion is needed**. Both rules come from CS2's own
compiled shaders (`shaders_vulkan_*.vpk` from the pinned content manifest, dumped with
Source2Viewer-CLI `-a`):

- **`csgo_foliage.vfx`**: vertex colour is animation and shading data. The shader's
  parameter groups name the channels: red is "Sway", "Noise 1", "Frond Tip Anim" and "Height
  Gradient"; blue is "Flutter" and "Noise 2"; alpha is "Ambient Occlusion". Green is unused.
  Multiplying that in turned every leaf on kz_bhop_majka magenta (G = 0) and some barks
  black (all zero). The viewer drops it as a tint and keeps only the vertex AO, at the
  material's `g_flVertexAmbientOcclusionAmount`/`Power`. That amount is 0 on nearly every
  material, so the leaves show their own texture. 51 converted maps use this shader.
- **`csgo_water_fancy.vfx`**: the compiled pixel shader binds `g_vWaterFogColor`, the
  decay, foam, debris and caustic colours, but **not** `g_vColorTint`. The red tint on
  kz_bhop_majka's `watercustomm.vmat` is never seen in CS2. The water's opaque surface now
  takes the (sRGB-picked) fog colour instead, still lit by the baked lightmap. 60 converted
  maps use this shader; kz_bhop_majka is the only one whose tint was not white.

- **Converter fallback colours** (`kz_<hex>`, no `extras.vmat`): a surface whose
  material the Workshop item does not ship gets a colour guessed from its name in
  `src/trimMap.js`. Its vertex colour came from a shader that is no longer known; on
  kz_bhop_majka the base-game taro and palm plants by the start (`taro_leaf_plant_1`,
  `palm_plant_1`, `ivy_wall`) carried CS2 foliage vertex data that turned their guessed
  green purple. The viewer ignores it, and new conversions drop it (the next
  `node bin/kzreplay.js map <name>` run). Existing assets need no reconversion.

`csgo_water.vfx` (one map) is not touched: no rule was checked against its compiled
shader. Everything else is unchanged. In particular, kz_bhop_majka's far `ancientneon`
plants (`foliage02`, `acaciajakke`, `csgo_complex.vfx`) stay blue: their per-instance
object tint is baked into the glTF base colour, and `csgo_complex` applies object tint
through `g_flModelTintAmount` (shader default 1, set to 1 here), so CS2 tints them too. They
self-illuminate in CS2 (`g_flSelfIllumBrightness` 2). The viewer now applies that
authored brightness and tint where the Source material uses Majka's shared white
self-illumination mask. It reuses the exported colour texture as emissive albedo
when the mask itself was not exported. Other mask textures are still unsupported;
this is material glow, not bloom or light cast onto nearby geometry.

## Water reflections (`?reflections=on`)

Opt-in and off by default, so every map renders as before unless a link asks for it.
`/watch?ids=<id>&reflections=on` adds screen-space reflections to any surface whose
_source_ material uses a Source 2 water shader (`csgo_water_fancy.vfx`, `csgo_water.vfx`,
`water.vfx`, read from the `extras.vmat` the exporter keeps). Nothing is chosen by colour
or name. Polished concrete with `F_SPECULAR_INDIRECT`, metals and puddle blends are left
alone. The parameter sticks to the URL while you change cameras, and `?reflections=off`
(or leaving it out) gives the matching "before" frame.

How it works (`viewer/src/mapReflections.js`): the water keeps the viewer's ordinary
material, so it keeps everything the "off" frame has: the corrected water colour (above),
the baked lightmap and the sun-shadow mask. Reflections are added on top in an
`onBeforeCompile` hook that chains with the lightmap one. When a water surface is in the
camera frustum, the scene without the water is drawn once into a half-resolution linear
half-float target with a depth texture. The water shader ray-marches that colour and
depth in view space, with binary refinement. It fades hits out at screen edges, at long
range and for rays aimed back at the camera, and falls back to the sky (the scene
background, sampled with its own rotation) wherever the ray misses. The reflection is
Fresnel-weighted with the authored `g_flReflectance`/`g_flFresnelExponent` and not tinted.
The same target supplies the bed under shallow water, seen through `g_vWaterFogColor`,
and the lit water body takes over with depth (`g_flWaterFogStrength` over
`g_flWaterMaxDepth`). The water is still drawn in the normal canvas pass, so native MSAA,
ACES tone mapping and every other surface are unchanged. CS2's own material asks for the
same thing: on majka `F_REFLECTION_TYPE` is 2, which the shader names "SSR over
Environment Cube Map".

A full-screen SSRPass was not used. This renderer is forward-only and draws straight to the
canvas. A post chain would move every map into a float target with its own resolve
and output transform, and it would still have no G-buffer saying which pixels may
reflect.

Limits: the export does not carry the water's normal/foam/caustic textures or the map's
cubemaps, so waves are procedural and the miss fallback is the sky rather than
`env_cubemap`. This is not a port of `csgo_water_fancy`'s shader code. Off-screen
geometry cannot be reflected (inherent to SSR). With the water in view, the pre-pass draws
the map's geometry a second time at half resolution.

On kz_bhop_majka (`materials/water/watercustomm.vmat`) both frames now show blue
water. "Off" is the lit fog colour, and "on" adds reflections, Fresnel and shoreline
depth. Nobody has compared this against camera-matched CS2 screenshots, so it is not a
claim of parity. The CS2 reference is also a darker night scene: Majka's sky is a
`csgo_moondome.vfx` model whose cubemap the export does not carry (`files.sky` is null),
so the viewer still shows its default sky.
