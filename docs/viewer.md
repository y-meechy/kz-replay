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

## Water reflections (`?reflections=on`)

Opt-in and off by default, so every map renders as before unless a link asks for it.
`/watch?ids=<id>&reflections=on` adds screen-space reflections to any surface whose
_source_ material uses a Source 2 water shader (`csgo_water_fancy.vfx`, `csgo_water.vfx`,
`water.vfx`, read from the `extras.vmat` the exporter keeps). Nothing is chosen by colour
or name. Polished concrete with `F_SPECULAR_INDIRECT`, metals and puddle blends are left
alone. The parameter sticks to the URL while you change cameras, and `?reflections=off`
(or leaving it out) gives the matching "before" frame.

How it works (`viewer/src/mapReflections.js`): the water keeps the viewer's ordinary
material, so it keeps everything the "off" frame has: the authored `g_vColorTint` as its
colour, the baked lightmap and the sun-shadow mask. Reflections are added on top in
an `onBeforeCompile` hook that chains with the lightmap one. When a water surface is in
the camera frustum, the scene without the water is drawn once into a half-resolution
linear half-float target with a depth texture. The water shader ray-marches that colour
and depth in view space, with binary refinement. It fades hits out at screen edges, at
long range and for rays aimed back at the camera, and falls back to the sky (the scene
background, sampled with its own rotation) wherever the ray misses. The reflection is
Fresnel-weighted with the authored `g_flReflectance`/`g_flFresnelExponent` and multiplied
by `g_vColorTint`, so red water stays red at grazing angles. The same target supplies the
bed under shallow water, seen through `g_vWaterFogColor`, and the authored surface colour
takes over with depth (`g_flWaterFogStrength` over `g_flWaterMaxDepth`). The water is still
drawn in the normal canvas pass, so native MSAA, ACES tone mapping and every other
surface are unchanged.

A full-screen SSRPass was not used. This renderer is forward-only and draws straight to the
canvas. A post chain would move every map into a float target with its own resolve
and output transform, and it would still have no G-buffer saying which pixels may
reflect.

Limits: the export does not carry the water's normal/foam/caustic textures or the map's
cubemaps, so waves are procedural and the miss fallback is the sky rather than
`env_cubemap`. Tinting the reflection by `g_vColorTint` is an interpretation chosen to
match the red water seen in CS2, not a port of `csgo_water_fancy`'s shader code. Off-screen
geometry cannot be reflected (inherent to SSR). With the water in view, the pre-pass draws
the map's geometry a second time at half resolution.

On kz_bhop_majka (`materials/water/watercustomm.vmat`, `g_vColorTint` = red) the lake is
red in CS2. It is red in both frames here: "off" is a flat lit red surface, and "on" is the
same surface with reflections, Fresnel and shoreline depth. Nobody has compared this
against camera-matched CS2 screenshots, so it is not a claim of parity.
