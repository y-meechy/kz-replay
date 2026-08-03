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
