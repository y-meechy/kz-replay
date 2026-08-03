---
name: verify-parser
description: Verify the replay parser against real replays after touching anything in src/ that reads bytes (container, ticks, events, header, protobuf, track, sections). Use before committing parser changes or when runs desync.
---

# Verify the parser

The unit tests are thin on purpose; the real correctness proof is parsing many
real replays, because every reader throws unless it consumes exactly the bytes
the section header promised.

```bash
npm test                                 # fast unit tests
node bin/kzreplay.js verify --limit 60   # parse 60 real replays, report desyncs
npm run check                            # alignment sanity check across known run pairs
```

`verify` downloads replays it doesn't have and caches them in `samples/`, so
the first run needs network and later runs don't.

## Reading a failure

- A throw inside `verify` is good behavior surfacing a bad change: a reader
  stopped landing on the last byte of its section. Compare against the format
  source of truth: cs2kz-metamod's `kz_replay.h`, `data.cpp`, and the vendored
  `compression.cpp`.
- Silent success with wrong numbers is the failure mode to fear. If durations
  or section times look off, check the last-timer-start rule: the run is the
  stretch from the last timer start before the finish, never the first.
- The parser refuses format versions newer than 5. If replays start failing
  with a version error, the plugin updated — extend the parser deliberately,
  never by guessing field sizes.
