# How a replay is read

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
output would still look plausible. That check is one important parser invariant.
`node bin/kzreplay.js verify` runs it across many retained real replays. Passing
the check gives strong alignment evidence, but does not prove every format
version, skipped section, or semantic rule is correct.

Source of truth for the format is the plugin itself. The relevant
[`src/kz/replays` files](https://github.com/KZGlobalTeam/cs2kz-metamod/tree/7bf63fd18f588bd69e91c9236eb44392be57ec11/src/kz/replays)
and [`protobuf/kz_replay.proto`](https://github.com/KZGlobalTeam/cs2kz-metamod/blob/7bf63fd18f588bd69e91c9236eb44392be57ec11/protobuf/kz_replay.proto)
are linked at an immutable upstream revision. The tick decoder is a JavaScript port
of that AGPL-3.0-licensed implementation; the original C++ file is not vendored
here. Format version 5 is the newest version this parser supports;
the parser refuses anything newer instead of guessing.

## Where the data comes from

- Records: `https://api.cs2kz.org/records` — the `replay_available` field says whether a replay exists.
- Replay files: `https://replays.cs2kz.org/<record_id>` — public, no auth. This URL is not in the OpenAPI spec; it comes from the plugin source.

**Retention matters.** The API deletes replays older than about 24 hours unless the
record is a world record, a top 10 on a ranked course, or on a tier 8 course. World
records are safe forever. Anything else has to be archived the day it is set.
