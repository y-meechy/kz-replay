# Linking and API reference

Everything the viewer shows lives in the URL, so every available run is a link
you can send someone. The live instance is at **https://demo.kzcomp.com** and
serves a shorter linking guide at [/docs](https://demo.kzcomp.com/docs). This
file is the complete URL and HTTP reference.

## Watch a run

```
/watch?ids=<record id>
```

`<record id>` is a CS2KZ record id (a UUID, the same id the API and
`replays.cs2kz.org` use). A valid id does not guarantee that its replay is still
retained; the viewer reports when the replay bucket returns 404.

Example: `https://demo.kzcomp.com/watch?ids=019ee775-a4c7-7b23-9507-ead26ff08f19`

## Compare two runs

```
/watch?ids=<first>,<second>
```

The first id is the run you watch, the second is the rival it is measured
against. Swap them to watch the other side. Two is the limit; extra ids are
dropped with a notice on screen. Both runs must be the same map, course and
mode — a mismatch loads the first run alone and says why.

## Camera

```
/watch?ids=<record id>&view=pov
```

| `view`   | Camera                                                           |
| -------- | ---------------------------------------------------------------- |
| `pov`    | Through the runner's eyes. The default; leave `view` off for it. |
| `follow` | Behind the runner.                                               |
| `free`   | Fly anywhere. `orbit` still works in old links.                  |

## The world record feed

```
/wr
/wr?id=<record id>
```

The newest world records, one screen each, scrolled like a phone feed. The
record on screen is always in the address bar, so a link opens on the run you
were looking at.

## HTTP endpoints

The production server (`server/index.js`) adds two small APIs next to the
static viewer:

```
GET  /replay/<record id>        proxy to replays.cs2kz.org (which sends no CORS headers)
HEAD /replay/<record id>        check replay availability without downloading its body
GET  /api/views?ids=<id>,<id>   view counts for those runs, plus the total
POST /api/views/<id>            count one view
```

A view is counted once the run has actually played for a few seconds, once per
browser per run per six hours.

The replay proxy rejects bodies over `KZ_REPLAY_MAX_BYTES` (67,108,864 bytes by
default). Successful GETs are stored atomically in an on-disk cache because replay
UUIDs are immutable; concurrent misses for the same UUID share one upstream download.
HEAD requests use a cached file when present, but a miss remains an upstream HEAD and
does not populate the cache.

The proxy permits 60 requests per minute per client by default, with at most two
concurrent requests per client and eight overall. GET response bytes use a per-client
token bucket with a 256 MiB burst and 1 GiB/hour refill. The complete file size is
charged before response headers, including for cache hits; HEAD and error responses
cost no bytes. See [self-hosting.md](self-hosting.md) for environment variables and
cache operations. Public deployments should also enforce suitable limits at their
trusted reverse proxy.

## Where the ids come from

- Records: `https://api.cs2kz.org/records` — the `replay_available` field says
  whether a replay file exists.
- Replay files: `https://replays.cs2kz.org/<record_id>` — public, no auth, but
  not retained for every record indefinitely.
