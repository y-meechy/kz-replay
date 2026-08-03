# Comparing two runs

![the full comparison view](analysis.png)

## In the viewer

Open a run and paste another replay id into **Compare with replay ID**, or build
the link directly — see [api.md](api.md). Compatible runs load immediately;
mismatched maps, courses, or modes are rejected with a clear message instead of
producing a misleading comparison.

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

## On the command line

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
