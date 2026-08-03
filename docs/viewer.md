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
