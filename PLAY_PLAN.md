# PLAY_PLAN.md — Playable CKZ mode in the browser

Goal: a new `/play` subpage in `viewer/` where the user plays real CS2 KZ movement
(cs2kz-metamod **CKZ / Classic** mode) on already-converted maps, starting with
`kz_victoria`. Acceptance bar is a working demo: pointer lock, WASD + mouse, jump,
duck, collision against the real map geometry, bhop that gains speed, and a speed HUD.

This plan is prescriptive. Implementers execute it verbatim. Where something was
ambiguous it has already been decided here — do not re-open the decision, and do not
substitute a physics library. Everything is hand-written on top of `three@0.170.0`.

---

## 0. Facts established by research (do not re-derive)

### 0.1 The existing viewer

- `viewer/` is a **single-page app**, one `index.html`, one `main.js`. Routing is a
  hand-rolled `readRoute()` / `route()` / `navigate()` trio in `viewer/main.js`
  (`readRoute` at line 105, `navigate` at 127, `route` at ~1076). Pages are
  `<main id="...">` elements toggled with `.hidden`.
- Existing routes: `/` (browse), `/wr`, `/watch?ids=…`, `/docs`.
- Maps are **`.glb` files**, not JSON triangle soup:
  `viewer/public/maps/kz_victoria.glb` (4.1 MB). `viewer/public/data/geometry.json`
  is only a *conversion manifest* (checksum, megabytes, convertedAt, adopted,
  attempts, error) — it contains **no geometry**. Ignore it for collision.
- `viewer/src/player.js` loads maps with `GLTFLoader` + `MeshoptDecoder` into a
  `THREE.Group` (`mapGroup`) that carries two corrections from
  `viewer/src/vrfExport.js`:
  - `VRF_UNITS_PER_EXPORTED_METRE = 39.37` → `mapGroup.scale.setScalar(39.37)`
  - `VRF_YAW_CORRECTION = Math.PI / 2` → `mapGroup.rotation.y = Math.PI / 2`
- Source space → render space conversion in `player.js` line 33:
  `toWorld(x, y, z) => [x, z, -y]`. Source is **Z-up**, three.js is **Y-up**.
- First person camera uses **vertical FOV 73.74°** (CS2's `fov 90` horizontal at 4:3
  base: `2*atan(tan(45°)*3/4)`), eye heights **64** standing / **46** ducked.
- No collision code exists anywhere in the repo. `three-mesh-bvh` is **not** a
  dependency and we will **not** add it — we write our own BVH (~150 lines) because we
  need a swept-AABB query, which `three-mesh-bvh` does not provide.
- `three` is `^0.170.0`, available as a root dependency.

### 0.2 Coordinate spaces (critical — get this wrong and nothing works)

Three spaces exist. Physics runs entirely in **Source space**.

| Space | Up | Units | Used by |
|---|---|---|---|
| Source | +Z | Source units | physics, replay positions, spawn point |
| Render (three.js world) | +Y | Source units | camera, scene |
| GLB local | +Y | ~inches | raw mesh attributes before `mapGroup`'s transform |

- Source → Render: `(x, y, z) → (x, z, -y)`
- Render → Source: `(X, Y, Z) → (X, -Z, Y)`  ← **inverse, needed to build collision**
- GLB local → Render: apply `object.matrixWorld` after the mesh is parented under a
  group carrying `scale 39.37` and `rotation.y = π/2`.

**Therefore**: to get collision triangles in Source space, take every mesh's vertex,
transform by `mesh.matrixWorld` (with the mesh under a group configured exactly like
`mapGroup`), then apply Render → Source. Do **not** try to reason about the GLB node
matrices by hand.

### 0.3 kz_victoria facts

- Player-path bounding box in Source units: X ∈ [-1918.6, 1540.4], Y ∈ [-1524.2,
  2508.2], Z ∈ [52.6, 722.9].
- Tick 0 of a real replay (`019ee7e7-c989-7a82-aa78-abaa88813a2f`) is at
  **(1540.39, -1300.77, 52.60)** — this is the start-zone floor and is our spawn.
  The replay's tick-1 position implies the runner was already moving toward −X/−Y,
  so **spawn yaw is 232°** (`atan2(-3.44, -2.69)` in degrees ≈ −128° ≡ 232°).
- There is **no zone/trigger data** anywhere in `public/data`. No timer, no start/end
  zones. Out of scope for this plan.

### 0.4 CKZ constants (cs2kz-metamod, `dev` branch)

From `src/kz/mode/kz_mode_ckz.h` `modeCvarValues[]`
(https://raw.githubusercontent.com/KZGlobalTeam/cs2kz-metamod/dev/src/kz/mode/kz_mode_ckz.h):

| Cvar | CKZ value |
|---|---|
| `sv_accelerate` | **6.5** |
| `sv_airaccelerate` | **100.0** |
| `sv_air_max_wishspeed` | **30.0** |
| `sv_friction` | **5.2** |
| `sv_gravity` | **800.0** |
| `sv_jump_impulse` | **302.0** (CKZ pins this; stock CS2 is 301.993377) |
| `sv_maxspeed` | **320.0** |
| `sv_maxvelocity` | **3500.0** |
| `sv_enablebunnyhopping` | **true** |
| `sv_autobunnyhopping` | **false** |
| `sv_staminajumpcost` / `landcost` / `max` | **0.0** (stamina fully off) |
| `sv_standable_normal` / `sv_walkable_normal` | **0.7** |
| `sv_step_move_vel_min` | **64.0** |
| `sv_bounce` | **0.0** |
| `sv_ladder_scale_speed` | 1.0, `sv_ladder_dampen` 1.0, `sv_ladder_angle` −0.707 |
| `sv_timebetweenducks` | **0.0** |

CKZ `#define`s from the same header:

```
SPEED_NORMAL              250.0     // ground wish-speed reference (NOT sv_maxspeed)
MAX_BUMPS                 4
PS_SPEED_MAX              26.0      // max prestrafe bonus on top of 250
PS_MIN_REWARD_RATE        2.0
PS_MAX_REWARD_RATE        15.5
PS_MAX_PS_TIME            0.50
PS_TURN_RATE_WINDOW       0.02
PS_DECREMENT_RATIO        3.0
PS_RATIO_TO_SPEED         0.5       // sqrt curve
PS_LANDING_GRACE_PERIOD   0.25
BH_PERF_WINDOW            0.02      // <= 1 tick on ground == perf
BH_BASE_MULTIPLIER        51.5
BH_LANDING_DECREMENT_MULTIPLIER 75.0
BH_NORMALIZE_FACTOR       = 51.5 * ln(250 + 26) - (250 + 26)
DUCK_SPEED_NORMAL         8.0
DUCK_SPEED_MINIMUM        6.0234375
```

Stock Source values CKZ does not override, which we still need:
`sv_stopspeed = 80`, `sv_stepsize = 18`, `NON_JUMP_VELOCITY = 140`,
`MAX_CLIP_PLANES = 5`, `DIST_EPSILON = 0.03125`.

### 0.5 CKZ mechanics we implement (from `kz_mode_ckz.cpp`)

1. **Prestrafe** — rolling 0.02 s turn-rate history on the ground builds
   `leftPreRatio`/`rightPreRatio` in [0, 0.5]; bonus =
   `26 * (maxRatio / 0.5) ** 0.5`, added to max ground speed (so ground cap is
   250…276). Reset to plain 250 inside air-move so it never inflates the air
   wishspeed cap.
2. **Perf (perfect bhop)** — if `takeoffTime - landingTime <= 0.02 s`, new speed =
   `max(landingSpeed, takeoffSpeed)`; if that exceeds `250 + prestrafeGain`, compress
   it: `newSpeed = (51.5 - timeOnGround*75) * ln(newSpeed) - BH_NORMALIZE_FACTOR`,
   floored at `250 + prestrafeGain`. Direction from the landing velocity's XY.
3. **Slope fix** — on landing, trace 2 units down; if the hit normal's z is in
   (0.7, 1.0), re-`ClipVelocity` the landing velocity against that normal and keep the
   result **only if 2D speed did not decrease**. Never removes speed.
4. **Duck-slowdown floor** — duck speed decays but is floored at 6.0234375 instead of
   decaying without bound on duck spam.
5. **Crouch-jump bind removal** — if grounded, duck was not held last tick, and jump
   was just pressed, strip the duck bit for that tick.
6. **No stamina, autobhop off, `sv_enablebunnyhopping` on** — meaning: holding space
   does *not* auto-jump; you must release and re-press (or scroll). This is the CKZ
   feel and we honour it.

Air acceleration is **not** algorithmically modified by CKZ. It is stock Source
`AirAccelerate` fed `sv_airaccelerate = 100` and `sv_air_max_wishspeed = 30`.

### 0.6 Base Source movement (source-sdk-2013 `gamemovement.cpp`)

We port these verbatim (pseudocode reproduced in §4 where the implementer needs it):
`CategorizePosition`, `Friction`, `Accelerate`, `AirAccelerate`, `WalkMove`,
`AirMove`, `TryPlayerMove` (4 bumps, plane list, crease case), `ClipVelocity`
(overbounce 1), `StepMove` (stepsize 18), `StayOnGround`, `CheckJumpButton`, `Duck`.

Hulls (CS family, origin at the feet, `mins.z = 0` for both):

```
standing  mins (-16,-16, 0)  maxs (16,16,72)   eye 64
ducked    mins (-16,-16, 0)  maxs (16,16,54)   eye 46
```

Because both hulls have `mins.z = 0`, ducking **never moves the origin** — the feet
stay, the head comes down. This is what the SDK does; do not add an origin shift.

---

## 1. Deliverable file layout

Everything new lives under `viewer/src/play/`. Nothing in `viewer/src/player.js`
is modified; the play page builds its own small scene so replay playback stays
untouched and cannot regress.

```
viewer/src/play/
  constants.js     CKZ + Source constants, hull dimensions, spawns
  vec.js           tiny plain-array/object vec3 math (no THREE in physics)
  bvh.js           triangle soup + BVH build + swept-AABB query
  collision.js     buildCollisionFromGltf(), TraceHull implementation
  movement.js      the CKZ movement tick — the heart of this feature
  input.js         keyboard/mouse/pointer-lock/scroll → per-tick usercmd
  scene.js         three.js scene, map load, first-person camera
  hud.js           speed / jump / prespeed overlay
  index.js         createPlay() — page controller, fixed-timestep loop
```

Touched existing files:

```
viewer/index.html   add <main id="play-page" hidden> markup
viewer/main.js      add "/play" to readRoute() and route(); link from browse
viewer/style.css    styles for #play-page (append, do not restructure)
```

---

## 2. Module specs

### 2.1 `viewer/src/play/vec.js`

Plain `{x, y, z}` objects, **Source space**, all functions mutate a `out` argument or
return a new object. No three.js — physics must be testable in node.

```js
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (out, a) => { out.x = a.x; out.y = a.y; out.z = a.z; return out; };
export const set = (out, x, y, z) => { out.x = x; out.y = y; out.z = z; return out; };
export const add = (out, a, b) => …;
export const sub = (out, a, b) => …;
export const scale = (out, a, s) => …;
export const addScaled = (out, a, b, s) => …;   // out = a + b*s
export const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
export const cross = (out, a, b) => …;
export const length = (a) => Math.hypot(a.x, a.y, a.z);
export const length2D = (a) => Math.hypot(a.x, a.y);
export const normalize = (out, a) => …;         // returns the original length
export const distance2DSq = (a, b) => …;
```

Also the two space conversions live here so nothing else guesses:

```js
export const sourceToRender = (out, s) => out.set(s.x, s.z, -s.y);   // out is THREE.Vector3
export const renderToSource = (out, X, Y, Z) => set(out, X, -Z, Y);
```

`sourceToRender` takes a `THREE.Vector3` for `out` — it is the only three.js touch
point, and it is a one-liner, so it is acceptable here.

### 2.2 `viewer/src/play/constants.js`

Every number from §0.4/§0.6, exported as named consts, each with a one-line comment
naming its source (`kz_mode_ckz.h` or `gamemovement.cpp`). Plus:

```js
export const TICK_RATE = 64;
export const TICK_INTERVAL = 1 / 64;            // 0.015625

export const HULL_MINS       = { x: -16, y: -16, z: 0 };
export const HULL_MAXS       = { x:  16, y:  16, z: 72 };
export const DUCK_HULL_MAXS  = { x:  16, y:  16, z: 54 };
export const EYE_STANDING = 64;
export const EYE_DUCKED   = 46;

// Crouch transition rate, not a timer — see the Duck routine in §2.6.
export const DUCK_SPEED_NORMAL  = 8.0;        // kz_mode_ckz.h
export const DUCK_SPEED_MINIMUM = 6.0234375;  // kz_mode_ckz.h

export const FOV_VERTICAL_DEG = 73.74;  // matches player.js first-person

export const SPAWNS = {
  kz_victoria: { origin: { x: 1576, y: -1300.77, z: 56 }, yaw: 232, pitch: 0 },
};
export const DEFAULT_MAP = "kz_victoria";
```

**Why not the replay's tick-0 position.** The replay starts at
(1540.39, −1300.77, 52.60), but the shipped GLB has **no surface at z = 52.6 in that
column** — the real floor there is the wooden deck at **z = 48.00**, and the 4.6-unit
gap is a clip/physics brush that the render export does not contain (§7 risk #1,
landing squarely on the acceptance column). The column is also a deck *edge*: sampling
the 32×32 hull footprint there gives corner heights of 48.00, 39.56, 48.00, 42.42 — an
8.4-unit spread, so the player would spawn half on the deck and half over terrain.

Spawn was therefore moved **36 units along +X to (1576, −1300.77)**, still on the same
start deck. Verified by ray-sampling all four hull corners plus the four edge midpoints
plus the centre: **every one hits `wood_trim_dirty_02` at exactly z = 48.00, spread
0.00, normal.z = 1.000**, with open sky overhead. Spawn z is 48 + 8 = **56**, so the
player drops the last 8 units and settles rather than starting embedded.

### 2.3 `viewer/src/play/bvh.js`

**Data layout.** Triangles are stored in flat `Float32Array`s for cache friendliness:

```js
// positions: Float32Array, 9 floats per triangle (v0,v1,v2), Source space
// normals:   Float32Array, 3 floats per triangle (unit face normal, Source space)
// bounds:    Float32Array, 6 floats per triangle (minx,miny,minz,maxx,maxy,maxz)
```

**Build.** Median-split BVH over triangle centroids, split on the longest axis of the
node's bounds, leaf when `count <= 8` or depth > 40. Nodes stored as a flat array of
objects `{ min: [3], max: [3], left, right, start, count }` — object nodes are fine,
the tree is a few thousand nodes.

```js
export const buildBvh = (positions) => ({ positions, normals, bounds, nodes, order });
```

`order` is a `Uint32Array` of triangle indices reordered by the build so leaves are
contiguous ranges.

**Query.** One entry point, used by the trace:

```js
// Calls visit(triIndex) for every triangle whose AABB overlaps the query box.
export const queryBox = (bvh, min, max, visit) => { … };
```

Iterative stack-based descent, no recursion, reusable `Int32Array` stack allocated
once per BVH.

### 2.4 `viewer/src/play/collision.js`

#### `buildCollisionFromGltf(gltfScene)`

1. Create `const root = new THREE.Group()`, set
   `root.scale.setScalar(VRF_UNITS_PER_EXPORTED_METRE)` and
   `root.rotation.y = VRF_YAW_CORRECTION` (import both from `../vrfExport.js`), add
   `gltfScene`, then `root.updateMatrixWorld(true)`.
2. Traverse. For every `THREE.Mesh` with a non-null geometry:
   - **Skip non-solid meshes by MATERIAL name, never by mesh name** (see §2.4.1).
   - Read `geometry.attributes.position` and `geometry.index` (handle non-indexed by
     synthesising `0..n-1`).
   - For each vertex: apply `mesh.matrixWorld`, then `renderToSource`.
   - Push the three Source-space vertices into a growing array.
3. Compute face normals with `cross(v1-v0, v2-v0)` normalised. **Drop degenerate
   triangles** whose cross-product length is `< 1e-6`.
4. Call `buildBvh`.
5. Return `{ bvh, triangleCount, bounds }`.

#### 2.4.1 Which meshes are solid — measured, not guessed

Measured on the shipped `kz_victoria.glb`: **629 meshes, 253 912 triangles**.

**Do not filter by mesh name.** The regex `/_cb_|nomerge/i` matches **563 of the 629
meshes** — `nomerge`, `_cb_`, `agg`, `meshset` are just Source2Viewer's aggregate
naming, not clip-brush markers. A name-based skip would delete most of the map.

Filter by **material name** instead. Three material families in this export are
visual-only and must not be solid:

| Material | What it is | Why it must not collide |
|---|---|---|
| `gradient` | 4 meshes, 100 % vertical quads forming 256×256 rings (one at z = [48, 79] directly over the start area) | A fog/gradient overlay card. Solid, it is an invisible box wall around spawn, and its top edge is a ledge you land on at z = 79. |
| `anubis_water_coast`, `water_stain_1` | one 8192×9472 flat plane at z ≈ 0 | You would walk on water. |
| `grass01`, `mall_trees_branches01/03`, `hr_aztec_decal_plaster_debris_01` | foliage and decal cards | Thin billboards you would stand on, several units above the real floor. |

The rule, applied to `material.name` (use `material[0].name` for multi-material
meshes):

```js
const NON_SOLID_MATERIAL =
  /^gradient|water|^grass\d|branch|leaf|leaves|foliage|overlay|_decal|skybox|^sky_/i;
const TERRAIN_KEEP = /^blend_/i;      // blend_grass_sand IS the real terrain — never skip it

const isNonSolid = (name) => !TERRAIN_KEEP.test(name) && NON_SOLID_MATERIAL.test(name);
```

The `TERRAIN_KEEP` escape is load-bearing: kz_victoria's ground is
`blend_grass_sand`, which a bare `/grass/` match would delete. The `^grass\d` anchor
targets the `grass01` prop specifically.

Measured effect on kz_victoria: **180 meshes / 219 396 triangles kept, 449 meshes /
34 516 triangles skipped**, and the skipped set is exactly the seven materials in the
table above. Log the skipped material names once on load so a future map with a
different naming scheme is obvious rather than silent.

Report `triangleCount` and build time to the console once. If the count exceeds
400 000, the implementer should still proceed — the BVH handles it — but note the
build time in the HUD's debug line.

#### `createTracer(collision)` → `traceHull(start, end, mins, maxs, out)`

The single primitive the whole movement system stands on. Signature and result shape
mirror Source's `trace_t` closely enough that the ported pseudocode reads naturally:

```js
/**
 * Sweeps the AABB [mins,maxs] (relative to the origin point) from start to end.
 * Writes into `out` and returns it.
 *
 * out = {
 *   fraction,   // 0..1 along the sweep
 *   endpos,     // {x,y,z} origin at the moment of contact
 *   plane: { normal: {x,y,z}, dist },
 *   startSolid, // the box already overlapped something at t=0
 *   allSolid,   // startSolid and no escape direction
 *   hit,        // fraction < 1
 * }
 */
```

**Algorithm — swept AABB vs triangle by 13-axis SAT (exact, closed form).**

For a convex box B and a triangle T translating relative to each other, the set of
box-centre positions that overlap T is exactly the Minkowski sum `T ⊕ (−B)`, and that
sum is exactly the intersection of the 13 SAT slabs. So the sweep reduces to a **ray
vs 13 half-space slabs** (the standard slab ray/convex test), which gives both the
entry time and the binding axis (= the contact normal) in one pass with no iteration.

The 13 axes:

- 3 box face normals: `(1,0,0)`, `(0,1,0)`, `(0,0,1)`
- 1 triangle face normal `n`
- 9 edge cross-products `cross(boxAxis_i, triEdge_j)` for i ∈ {x,y,z}, j ∈ {e0,e1,e2}

Per triangle:

```
c0 = start + (mins+maxs)/2          // box centre at t=0
h  = (maxs-mins)/2                  // box half-extents
d  = end - start                    // sweep displacement (the "ray")

tEnter = 0, tExit = 1, hitAxis = null
for each axis a in the 13:
    if |a|^2 < 1e-12: continue                     // degenerate, carries no info
    r    = |a.x|*h.x + |a.y|*h.y + |a.z|*h.z       // box radius along a
    lo   = min(dot(a,v0), dot(a,v1), dot(a,v2)) - r
    hi   = max(dot(a,v0), dot(a,v1), dot(a,v2)) + r
    p    = dot(a, c0)
    s    = dot(a, d)
    if |s| < 1e-9:
        if p < lo or p > hi: return MISS            // separated and not closing
        continue
    t0 = (lo - p)/s ; t1 = (hi - p)/s
    if t0 > t1: swap(t0, t1)
    if t0 > tEnter: tEnter = t0 ; hitAxis = a (signed so it opposes d)
    if t1 < tExit:  tExit  = t1
    if tEnter > tExit: return MISS
if tEnter > 1: return MISS
return { t: tEnter, axis: hitAxis, startSolid: tEnter <= 0 }
```

Contact normal rules, in this order:

1. If the binding axis is (numerically) the **triangle face normal**, the normal is
   the triangle's stored face normal, flipped to oppose `d` — a floor must yield
   `normal.z ≈ 1`.
2. Otherwise use the binding axis, normalised and flipped to oppose `d`.
3. **Back-face rejection**: if `dot(triNormal, d) > 0` and the sweep starts on the
   back side (`dot(triNormal, c0) - dot(triNormal, v0) < 0`), skip the triangle
   entirely. This stops the player being caught by the underside of world brushes.

Wrapper `traceHull`:

```
1. Build the query AABB = union of the box at t=0 and at t=1, padded by 1 unit.
2. queryBox(bvh, qmin, qmax, visit) — for each candidate run the SAT sweep.
3. Keep the smallest tEnter and its normal.
4. startSolid = any candidate reported tEnter <= 0 with tExit > 0.
5. fraction = clamp(bestT, 0, 1); nudge it back by DIST_EPSILON/|d| so the box never
   ends exactly touching:  fraction = max(0, bestT - 0.03125 / max(|d|, 1e-6)).
6. endpos = start + d * fraction.
7. If nothing hit: fraction = 1, endpos = end, normal = (0,0,0), hit = false.
```

**Unstuck.** `traceHull` reporting `startSolid` is normal at map seams. Add:

```js
export const unstuck = (tracer, origin, mins, maxs) => { … }
```

Try, in order, offsets of ±1, ±2, ±4, ±8, ±16 units along +z, then ±x, ±y, then the
8 diagonal xy directions, and take the first offset where a zero-length trace reports
no `startSolid`. Call it once per tick before movement if the previous tick ended
solid. Never search further than 16 units.

**Performance target.** A tick performs ~10–20 `traceHull` calls (TryPlayerMove
bumps + StepMove + CategorizePosition). At 64 tps that is ~1 200 traces/second. With
the BVH each trace should visit a few dozen triangles. Budget: **under 2 ms per tick**
on kz_victoria. If it is slower, the fix is fewer candidate triangles (tighten the
query AABB padding), not a coarser hull.

### 2.5 `viewer/src/play/input.js`

```js
export const createInput = (canvas) => ({
  attach(), detach(),
  /** Consumes buffered edges and returns the usercmd for one tick. */
  sample(): { forwardMove, sideMove, buttons, viewAngles: { yaw, pitch } },
  viewAngles,          // live, read by the renderer between ticks
  isLocked,
});
```

- Pointer lock is requested on canvas click; `pointerlockchange` drives `isLocked`.
- Mouse: `movementX/movementY` accumulate into `yaw -= movementX * sens`,
  `pitch -= movementY * sens` with `sens = 0.022 * 2.0` degrees per count
  (CS2's `m_yaw 0.022` at sensitivity 2.0 — expose sensitivity as a HUD slider,
  default 2.0). Clamp pitch to [−89, 89]. Wrap yaw to (−180, 180].
- Keys → `forwardMove` / `sideMove` in **±450** (Source's `cl_forwardspeed`); the
  movement code clamps to maxspeed anyway.
  `W`/`ArrowUp` +forward, `S` −forward, `A` −side, `D` +side.
  (Source's `right` vector points right and `sidemove` is positive right, so `D` is
  positive. Verify by walking and correcting the sign if strafes are mirrored.)
- Buttons bitfield: `IN_JUMP = 1 << 1`, `IN_DUCK = 1 << 2` (values only need to be
  self-consistent). Space and mouse-wheel both set `IN_JUMP`; Ctrl and Shift set
  `IN_DUCK`.
- **Scroll jump**: a `wheel` event queues one "jump pressed for exactly one tick"
  token. `sample()` pops at most one token per tick and ORs `IN_JUMP` in for that tick
  only. This is what makes scroll-bhop work, and it must be a queue, not a flag, or
  fast scrolling loses inputs.
- Because CKZ has `sv_autobunnyhopping false` / `sv_enablebunnyhopping true`, holding
  space does **not** re-jump. The movement code tracks `oldButtons` and only jumps on
  a rising edge. Scroll tokens naturally produce rising edges.
- `R` = respawn (handled by `index.js`, not by movement). `Escape` releases pointer lock
  (the browser does this itself).

### 2.6 `viewer/src/play/movement.js`

The core. Exports:

```js
export const createPlayerState = (spawn) => ({
  origin: v3(…), velocity: v3(0,0,0),
  viewAngles: { yaw, pitch },
  onGround: false, groundNormal: v3(0,0,1),
  ducking: false, ducked: false, duckTime: 0, duckSpeed: 8.0,
  oldButtons: 0, buttons: 0,
  // CKZ prestrafe / perf bookkeeping
  leftPreRatio: 0, rightPreRatio: 0, angleHistory: [],
  landingTime: -1, landingVelocity: v3(), takeoffTime: -1,
  curTime: 0, tick: 0,
  surfaceFriction: 1,
  lastTickStuck: false,
});

export const movementTick = (state, cmd, tracer) => { … };
```

`movementTick` runs **one 1/64 s tick**. `frametime = TICK_INTERVAL` everywhere; no
variable timestep, no subtick. Order inside the tick, mirroring
`CGameMovement::PlayerMove` + `FullWalkMove`:

```
1.  state.curTime += TICK_INTERVAL; state.tick++
2.  state.viewAngles = cmd.viewAngles
3.  forward/right/up = AngleVectors(viewAngles)
4.  if (state.lastTickStuck) unstuck(...)
5.  ckzRemoveCrouchJumpBind(state, cmd)          // CKZ §0.5.5
6.  CategorizePosition(state, tracer)
7.  ckzUpdatePrestrafe(state, cmd)               // CKZ §0.5.1 (ground only)
8.  Duck(state, cmd, tracer)                     // hull swap + ckzReduceDuckSlowdown
9.  FullWalkMove(state, cmd, tracer)             // CheckJumpButton lives INSIDE this
10. state.oldButtons = cmd.buttons
```

`FullWalkMove`:

```
StartGravity()                     // velocity.z -= gravity * 0.5 * frametime
if (onGround) { velocity.z = 0; Friction(); }
CheckVelocity()                    // clamp each component to ±sv_maxvelocity (3500)
CheckJumpButton()                  // <- HERE, after Friction, before the move branch
if (onGround) WalkMove() else AirMove()
CategorizePosition()
CheckVelocity()
FinishGravity()                    // velocity.z -= gravity * 0.5 * frametime
if (onGround) velocity.z = 0
```

**Why `CheckJumpButton` sits inside `FullWalkMove` and not before it.** Jumping clears
`onGround`. If the jump ran before `Friction`, then on every jump tick the
`if (onGround)` guard would be false and friction would be skipped entirely — the
player would keep speed they should have lost, and *non-perf* bhops would gain speed
they do not gain in real CKZ. Running it after `Friction`/`CheckVelocity` and before
the `WalkMove`/`AirMove` branch is the SDK order: friction is charged for the tick you
were still on the ground, and the very same tick then takes the `AirMove` branch.

Ported routines — implement these exactly as written:

**`CategorizePosition`**

```
if (velocity.z > 140) { setGround(null); return }
end = origin - (0,0,2)
tr = traceHull(origin, end, mins, maxs)
if (!tr.hit || tr.plane.normal.z < 0.7) {
    setGround(null)
    if (velocity.z > 0) surfaceFriction = 0.25   // CS "deadstrafe"; keep it, CKZ does not remove it
} else {
    if (!onGround) onLand(tr)                    // fires the CKZ slope fix + landing bookkeeping
    setGround(tr.plane.normal)
    surfaceFriction = 1
    if (tr.fraction < 1) origin = tr.endpos      // snap down to the floor
}
```

Skip Source's `TryTouchGroundInQuadrants` fallback — the swept-AABB trace already
catches corner-on-ledge cases that the SDK's point-ish traces missed.

**`Friction`** (`sv_stopspeed = 80`, `sv_friction = 5.2`)

```
speed = |velocity|; if (speed < 0.1) return
if (onGround) {
    friction = 5.2 * surfaceFriction
    control  = speed < 80 ? 80 : speed
    drop     = control * friction * frametime
}
newspeed = max(speed - drop, 0)
if (newspeed != speed) velocity *= newspeed / speed
```

**`Accelerate(wishdir, wishspeed, accel)`**

```
currentspeed = dot(velocity, wishdir)
addspeed = wishspeed - currentspeed
if (addspeed <= 0) return
accelspeed = min(accel * frametime * wishspeed * surfaceFriction, addspeed)
velocity += wishdir * accelspeed
```

**`AirAccelerate(wishdir, wishspeed, accel)`** — note the asymmetry: the cap applies
to `addspeed`, the *unclamped* wishspeed drives `accelspeed`. This is the whole reason
strafing gains speed. Do not "fix" it.

```
wishspd = min(wishspeed, 30)                     // sv_air_max_wishspeed
currentspeed = dot(velocity, wishdir)
addspeed = wishspd - currentspeed
if (addspeed <= 0) return
accelspeed = min(accel * wishspeed * frametime * surfaceFriction, addspeed)
velocity += wishdir * accelspeed
```

**`WalkMove`**

```
maxspeed = SPEED_NORMAL + ckzPrestrafeGain(state)     // 250 .. 276
wishvel = forward*cmd.forwardMove + right*cmd.sideMove
wishvel.z = 0
wishspeed = |wishvel|; wishdir = normalize(wishvel)
if (wishspeed > maxspeed) { wishvel *= maxspeed/wishspeed; wishspeed = maxspeed }
wishspeed = min(wishspeed, ckzDuckSpeedCap(state))    // duck slows you
velocity.z = 0
Accelerate(wishdir, wishspeed, 6.5)
velocity.z = 0
if (|velocity| < 1) { velocity = 0; return }
dest = origin + velocity*frametime; dest.z = origin.z
tr = traceHull(origin, dest, mins, maxs)
if (tr.fraction == 1) { origin = tr.endpos; StayOnGround(); return }
StepMove(dest, tr)
StayOnGround()
```

**`AirMove`** — same wishvel construction, but `maxspeed = SPEED_NORMAL` (250) with
**no prestrafe bonus** (CKZ explicitly resets it here), then
`AirAccelerate(wishdir, wishspeed, 100)`, then `TryPlayerMove()`.

**`TryPlayerMove`** — the 4-bump loop with the plane list and the crease case, exactly
as in `gamemovement.cpp`. Reproduce the version in this plan's research verbatim:
4 bumps; `allSolid` → zero velocity and bail; on a clean `fraction == 1` re-check the
destination is not solid; accumulate `planes[]`; single-plane-in-air case clips once;
otherwise search for a plane whose clip does not re-penetrate any other plane; if none
and `numplanes == 2`, slide along `normalize(cross(planes[0], planes[1])) * dot(dir,
velocity)`; if `dot(velocity, primalVelocity) <= 0` zero the velocity and break; if
`allFraction == 0` zero the velocity.

Use `MAX_CLIP_PLANES = 5`, `MAX_BUMPS = 4`.

**`ClipVelocity(in, normal, overbounce = 1)`**

```
backoff = dot(in, normal) * overbounce
out = in - normal * backoff
adjust = dot(out, normal)
if (adjust < 0) out -= normal * adjust
```

CKZ's own reimplementation adds a `+0.03125` push-off; we get the same effect from the
`DIST_EPSILON` pull-back inside `traceHull`, so use the plain SDK form here and do not
double-apply the epsilon.

**`StepMove` / `StayOnGround`** — SDK form with `sv_stepsize = 18`: try the flat move,
save its result, then rewind, trace up 18+ε, `TryPlayerMove` at the raised height,
trace back down 18+ε, reject if the landing normal `z < 0.7`, and finally keep whichever
of the two attempts travelled further horizontally (keeping the flat move's `velocity.z`
when the stepped one wins). `StayOnGround` traces 2 units up then `sv_stepsize + 2`
down and snaps the origin if the surface is standable and the move is under 0.5 units.

`sv_step_move_vel_min` (64.0) is listed in §0.4 for completeness but is **intentionally
unused**: CKZ pins it to the CS2 default rather than changing it, and the SDK
`StepMove` we port has no velocity gate. Do not add one.

**`CheckJumpButton`**

```
if (!onGround) return
if (!(buttons & IN_JUMP)) return
if (oldButtons & IN_JUMP) return          // sv_autobunnyhopping false: rising edge only
velocity.z = 302.0                        // CKZ sv_jump_impulse
setGround(null)
ckzOnTakeoff(state)                       // perf handling, §0.5.2
```

**`Duck`** — CS2/CKZ drive the crouch transition from `m_flDuckSpeed`
(`DUCK_SPEED_NORMAL 8.0`, floored at `DUCK_SPEED_MINIMUM 6.0234375`), not from a fixed
timer. Model it that way so `ckzReduceDuckSlowdown` actually does something:

```
duckAmount += (ducking ? +1 : -1) * state.duckSpeed * frametime   // clamped to [0, 1]
```

`duckAmount` 0 = standing, 1 = fully ducked. At `duckSpeed` 8.0 a full duck takes
0.125 s, which is the CS2 feel. `TIME_TO_DUCK 0.4` / `TIME_TO_UNDUCK 0.2` from the
SDK are **not** used — delete them from `constants.js` and keep the two duck-speed
constants instead. `ckzReduceDuckSlowdown` then has an observable effect: spamming duck
decays `duckSpeed` toward the 6.0234375 floor, making each subsequent crouch visibly
slower to complete, exactly as CKZ intends.

Otherwise: track `duckAmount`, swap
`maxs.z` between 72 and 54 when `duckAmount` crosses 1 / returns to 0 (and **immediately** when airborne,
which is what makes crouch-jumping over gaps work), and refuse to unduck if a
`traceHull` with the standing hull at the current origin reports `startSolid`. Eye
height lerps 64 ↔ 46 over the same transition for the camera only. Ducked ground
speed cap is `SPEED_NORMAL * 0.34` (Source's `DUCK_SPEED_MULTIPLIER`), further reduced
by the CKZ duck-speed floor (§0.5.4).

**CKZ helpers** in the same module, one function each, each with a comment naming the
`kz_mode_ckz.cpp` routine it ports:

```js
const ckzUpdatePrestrafe   = (state, cmd) => { … }       // UpdateAngleHistory + CalcPrestrafe
const ckzPrestrafeGain     = (state) => 26 * Math.sqrt(maxRatio / 0.5)   // GetPrestrafeGain
const ckzOnTakeoff         = (state) => { … }            // OnStopTouchGround, perf log curve
const ckzOnLand            = (state, tr, tracer) => { … } // OnStartTouchGround + SlopeFix
const ckzReduceDuckSlowdown= (state) => { … }            // ReduceDuckSlowdown
const ckzRemoveCrouchJumpBind = (state, cmd) => { … }    // RemoveCrouchJumpBind
```

`ckzUpdatePrestrafe` takes `(state, cmd)`, **not** a wish direction: it is driven by
the per-tick **yaw turn rate** (`cmd.viewAngles.yaw` versus the previous tick's yaw,
averaged over the 0.02 s `PS_TURN_RATE_WINDOW`) combined with which strafe key is held,
which is why it needs the raw command rather than a derived vector.

Perf formula, spelled out so it cannot be mistranscribed:

```js
const BH_NORMALIZE_FACTOR = 51.5 * Math.log(250 + 26) - (250 + 26);

// inside ckzOnTakeoff, when curTime - landingTime <= 0.02
const timeOnGround = state.curTime - state.landingTime;
let speed = Math.max(length2D(state.landingVelocity), length2D(state.velocity));
const floorSpeed = 250 + ckzPrestrafeGain(state);
if (speed > floorSpeed) {
  speed = (51.5 - timeOnGround * 75.0) * Math.log(speed) - BH_NORMALIZE_FACTOR;
  speed = Math.max(speed, floorSpeed);
}
// direction from the landing velocity's XY
```

### 2.7 `viewer/src/play/scene.js`

A deliberately small renderer — **do not** reuse `createPlayer()` from
`viewer/src/player.js`; it is built around a replay track and dragging it into an
interactive game would couple two things that should stay apart.

```js
export const createPlayScene = ({ canvas }) => ({
  loadMap(url),          // GLTFLoader + MeshoptDecoder, same mapGroup transform as player.js
  collision,             // set by loadMap, from buildCollisionFromGltf
  setView(originSource, eyeHeight, yawDeg, pitchDeg),
  render(),
  resize(),
  dispose(),
});
```

- Copy the lighting/sky/tone-mapping setup from `player.js` (ACESFilmic, exposure 1.15,
  the sky texture, the fog) so the play page looks like the viewer. Copy, do not import
  private internals.
- Camera: `new THREE.PerspectiveCamera(FOV_VERTICAL_DEG, aspect, 1, 40000)`.
- `setView`: `camera.position.set(...sourceToRender(origin + (0,0,eyeHeight)))`, then
  `camera.rotation.set(0,0,0)` and apply yaw/pitch as a quaternion built from the
  Source forward vector, matching `player.js`'s `viewDirection` math
  (`forward = [cos(pitch)cos(yaw), cos(pitch)sin(yaw), -sin(pitch)]`, then `toWorld`).
  Use `camera.lookAt(camera.position + renderForward)` with `camera.up = (0,1,0)` —
  simplest and correct as long as pitch stays clamped to ±89°.
- Reuse `viewer/src/mapFile.js`'s `findMapFile` to give a clear "map not converted yet"
  message instead of a GLTF parse error.

### 2.8 `viewer/src/play/hud.js`

A DOM overlay inside `#play-page`. Shows, updated once per rendered frame:

- **Speed** (2D, `Math.round(length2D(velocity))`) — large, centre-bottom. This is the
  number KZ players actually watch.
- Prestrafe gain, on/off ground, ducking, current tick.
- Jump readout: takeoff speed and whether the last jump was a perf.
- A small "click to play" prompt while pointer lock is off, and a key legend
  (WASD, Space/scroll jump, Ctrl duck, R respawn, Esc release).
- A sensitivity slider (0.5–6.0, default 2.0) persisted in `localStorage`.

### 2.9 `viewer/src/play/index.js`

```js
export const createPlay = ({ root, canvas }) => ({ show(mapName), hide(), dispose() });
```

**Fixed-timestep loop** — this is the part most likely to be got wrong, so it is
specified exactly:

```js
let accumulator = 0;
let last = performance.now();
const MAX_CATCHUP_TICKS = 8;   // after a stall, drop time rather than spiral

const frame = (now) => {
  raf = requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  accumulator += dt;

  let ticks = 0;
  while (accumulator >= TICK_INTERVAL && ticks < MAX_CATCHUP_TICKS) {
    const cmd = input.sample();          // consumes exactly one scroll-jump token
    movementTick(state, cmd, tracer);
    accumulator -= TICK_INTERVAL;
    ticks++;
  }
  if (ticks === MAX_CATCHUP_TICKS) accumulator = 0;   // give up on the backlog

  // Render at the live mouse angles (not the tick's) so aiming feels 1:1,
  // and interpolate the origin by accumulator/TICK_INTERVAL against the
  // previous tick's origin so motion is smooth above 64 fps.
  scene.setView(interpolatedOrigin, currentEyeHeight, input.viewAngles.yaw, input.viewAngles.pitch);
  scene.render();
  hud.update(state);
};
```

Keep `prevOrigin` from before the last tick for that interpolation. Do **not**
interpolate view angles — they are already live.

Pause the loop when pointer lock is lost: keep rendering, stop ticking (zero the
input so the player does not walk off a ledge while the user reads a Slack message).

Respawn (`R`, and on falling below the map's `bounds.min.z - 512`) resets `state` to
`createPlayerState(SPAWNS[mapName])`.

---

## 3. Integration with the existing app

### 3.1 `viewer/index.html`

Add, as a sibling of the existing `<main id="docs">`:

```html
<main id="play-page" hidden>
  <canvas id="play-canvas"></canvas>
  <div id="play-hud"><!-- built by hud.js --></div>
</main>
```

**The id must be `play-page`, not `play`.** `viewer/index.html:165` already has
`<button id="play">` (the watch page's play/pause button, read via `el("play")` at
`viewer/main.js:142`). Reusing `play` would break replay playback. CSS selector is
`#play-page`; `play-canvas` and `play-hud` are free and used as written.

### 3.2 `viewer/main.js`

In `readRoute()`, **before the `if (path !== "/watch")` browse fall-through at
`viewer/main.js:118`** — that line returns the browse page for every unrecognised path,
so a `/play` branch placed after it is dead code and `/play` silently shows the map
list. Put it next to the `/docs` and `/wr` checks:

```js
if (path === "/play") {
  return { page: "play", ids: [], dropped: 0, map: params.get("map") ?? DEFAULT_MAP };
}
```

In `route()`, alongside the other page branches: hide `browse`/`feed`/`watch`/`docs`,
call `leaveWatch()`, then lazily construct the play page on first visit
(`const play = await import("./src/play/index.js")` — code-split so the browse page
does not pay for the physics bundle) and call `play.show(map)`. Every other branch of
`route()` must call `play.hide()` if the page was ever created.

Add a "Play" link to the browse page header (`viewer/src/browse.js`) pointing at
`/play?map=kz_victoria`, and a per-map "Play" button on each map card that navigates to
`/play?map=<name>`.

### 3.3 Vite

No config change. `viewer/vite.config.js` already serves the SPA; the dev server
returns `index.html` for `/play`, which is what we want. Production hosting already
has to rewrite unknown paths to `index.html` for `/watch` to work, so `/play` inherits
that.

---

## 4. Execution order

Steps 1–3 can run **in parallel** (three implementers, disjoint files). Steps 4+ are
sequential because each needs the one before it.

| # | Work | Files (exclusive) | Parallel with |
|---|---|---|---|
| 1 | `vec.js`, `constants.js` | those two | 2, 3 |
| 2 | `bvh.js` | that file | 1, 3 |
| 3 | `input.js`, `hud.js` | those two | 1, 2 |
| 4 | `collision.js` (needs 1, 2) | that file | — |
| 5 | `movement.js` (needs 1, 4) | that file | — |
| 6 | `scene.js` (needs 1) | that file | can start after 1 |
| 7 | `index.js` + `main.js`/`index.html`/`style.css` wiring | those | — |
| 8 | Tuning pass against the manual test script | movement.js | — |

### Acceptance criteria per step

1. **vec/constants** — `node -e` import works; every CKZ constant from §0.4 present
   with its source named in a comment.
2. **bvh** — a node script builds a BVH over 10 000 random triangles and `queryBox`
   returns the same set as a brute-force AABB scan for 100 random boxes.
3. **input/hud** — pointer lock engages on click; a temporary debug page prints
   yaw/pitch/forwardMove/sideMove/buttons; scrolling produces exactly one `IN_JUMP`
   tick per wheel event, verified by counting.
4. **collision** — after applying the §2.4.1 material filter, loading
   `kz_victoria.glb` yields **≈ 219 000 triangles** (assert `> 100 000`), and a
   downward `traceHull` from `(1576, −1300.77, 200)` hits a surface with
   `normal.z > 0.99` at `endpos.z` within **0.5 units of 48.00**.

   The tolerance is tight on purpose: that column is a verified dead-flat deck, so
   anything other than 48.0 is a real bug, not map noise. This single assertion proves
   the whole coordinate-space chain (GLB local → `matrixWorld` → render → Source).
   **Do not proceed past this until it passes.**

   Second assertion, guarding the material filter: a downward trace from
   `(1576, −1300.77, 200)` **without** the filter lands at z ≈ 79.00 on the `gradient`
   overlay. If the filtered and unfiltered traces agree, the filter is not wired in.

   The existing scratch harness at
   `…/scratchpad/test-collision.mjs` already loads the GLB in node; update its
   expectations to the numbers above rather than writing a new one.
5. **movement** — headless node test: drop a player from `(1576, −1300.77, 200)`, run
   200 ticks with no input, assert they come to rest with `onGround === true`,
   `|velocity| < 1`, and `origin.z` within 0.5 units of **48.0**.
6. **scene** — the map renders, first-person camera at the spawn looks down the start
   corridor, no console errors.
7. **wiring** — `/play` loads from a cold page load and from an in-app navigation, and
   navigating away and back does not leak a second render loop (check with a counter).
8. **tuning** — the manual script below passes.

---

## 5. Manual test script — kz_victoria

Run `npm run dev` in `viewer/`, open `http://localhost:5180/play?map=kz_victoria`,
click to lock the pointer.

1. **Spawn.** You drop a few units and stand on the wooden start deck at
   **(1576, −1301, 48.0)**, facing roughly 232°, HUD speed 0. You are not falling, not
   inside geometry, and there is no invisible wall boxing you in — if there is, the
   `gradient` material filter (§2.4.1) is not working.
2. **Walk.** Hold W. Speed climbs and settles at **250**. Never above 250 while walking
   in a straight line with no prior strafing.
3. **Prestrafe.** From a standstill, hold W+A and swing the mouse left smoothly. Speed
   climbs past 250 toward **276** and no further. Release and it decays back to 250.
4. **Jump.** Press space. You rise about 57 units and land. Ground speed on landing is
   close to takeoff speed (no stamina loss).
5. **Bhop.** Press space repeatedly, timing each press for the tick you land, while
   strafing left/right in sync with the mouse. Speed **increases** jump over jump.
   Perfs (HUD flags them) preserve speed; a mistimed press loses it to friction.
   Reaching 350–450 within a handful of jumps means the air-accel port is right.
6. **Scroll bhop.** Bind nothing, just scroll the wheel while airborne on landing —
   each notch produces one jump attempt, and fast scrolling reliably perfs.
7. **Duck.** Hold Ctrl standing: the camera drops from eye 64 to 46 over ~0.125 s and
   ground speed drops to ≈85. Release under a low ceiling and you stay ducked.
8. **Crouch-jump.** Jump and hold Ctrl at the apex: the hull shortens immediately and
   you clear a low overhang you cannot clear standing.
9. **Stairs.** Walk into the start area's steps. You go up them without jumping and
   without stuttering — this exercises `StepMove` and `sv_stepsize 18`.
10. **Slope.** Land on any of kz_victoria's ramps while moving fast. You slide down and
    **gain** 2D speed, never lose it — this is the CKZ slope fix.
11. **Walls.** Run into a wall at 400 u/s. You slide along it, you do not stop dead and
    you do not tunnel through. Run into a corner: you stop, you do not jitter.
12. **No falling through the world.** Sprint and bhop around the first third of the
    course for 60 seconds. You never end up outside the map. If you do, the trace's
    `DIST_EPSILON` pull-back or the back-face rejection is wrong — fix those, do not
    add a "teleport back" band-aid.
13. **Respawn.** Press R anywhere: you return to the spawn with zero velocity.
14. **Performance.** The HUD's frame-time line stays under 16 ms on the reference
    machine, with the physics portion under 2 ms.

---

## 6. Explicit non-goals

Out of scope for this plan — do not build them, do not leave stubs for them:

- Timer, start/end zones, checkpoints, saveloc/teleports. There is **no zone data**
  in the repo (§0.3), so a timer would be invented, not real.
- Ladders, water, and triggers. CKZ tunes ladders only via cvars and we have no
  surface flags in the GLB to identify a ladder. If a map has one, the player simply
  cannot climb it. Acceptable for the demo.
- Surf. It falls out of the ramp/`ClipVelocity` code for free if the port is right, but
  it is not an acceptance criterion.
- Multiplayer, ghosts, replay recording of play sessions.
- Mobile controls.
- Subtick movement. CKZ sets `sv_subtick_movement_view_angles false` anyway; we run
  clean 64 tps.

## 7. Known risks, and the decided mitigation for each

| Risk | Mitigation (decided) |
|---|---|
| The GLB is render geometry, so collision includes decorative meshes and misses player-clip brushes | **Confirmed real, and already bit us at the spawn** (see §2.3). Mitigation is two-part: the §2.4.1 material filter removes the visual-only meshes that are actively harmful, and floor heights are taken from the render mesh rather than from replay data. Accept the residual difference — the demo only needs physics that is internally consistent with what the player can see. Revisit only if a specific spot in kz_victoria proves unplayable. |
| Replay positions do not sit on render-mesh surfaces | Do not use replay data as ground truth for heights anywhere. It is authoritative for *where the course goes*, not for *where the floor is*. |
| Coordinate-space error makes the player float or sink | Step 4's acceptance test isolates it to a single assertion before any movement code is written. |
| Swept-SAT normals at triangle edges cause jitter on flat floors made of many triangles | The face-normal preference rule in §2.4 handles the common case; if jitter remains, snap a normal to the triangle face normal whenever `dot(axisNormal, faceNormal) > 0.99`. |
| BVH build blocks the main thread on load | 4 MB / a few hundred thousand triangles builds in well under a second. Show the existing loading indicator. Do not reach for a worker unless measured over 1 s. |
| Air accel feels wrong | Almost always a `frametime` or a degrees/radians mistake, not a constant. Check `sv_airaccelerate = 100` (not 12 — CKZ overrides it) and that `accelspeed` uses the **unclamped** wishspeed. |
