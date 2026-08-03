# Linking and API reference

Everything the viewer shows lives in the URL, so every run is a link you can
send someone. The live instance is at **https://demo.kzcomp.com** and serves
this same reference at [/docs](https://demo.kzcomp.com/docs).

## Watch a run

```
/watch?ids=<record id>
```

`<record id>` is a CS2KZ record id (a UUID, the same id the API and
`replays.cs2kz.org` use).

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
GET  /api/views?ids=<id>,<id>   view counts for those runs, plus the total
POST /api/views/<id>            count one view
```

A view is counted once the run has actually played for a few seconds, once per
browser per run per six hours.

## Where the ids come from

- Records: `https://api.cs2kz.org/records` — the `replay_available` field says
  whether a replay file exists.
- Replay files: `https://replays.cs2kz.org/<record_id>` — public, no auth.
