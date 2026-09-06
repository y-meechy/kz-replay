# Reproducible CS2 fidelity captures

This is a paired visual and frame-time check between the viewer and Counter-Strike
2 (CS2). A screenshot is evidence only when both sides describe the same map,
camera, display, and graphics setup. The synthetic PNG tests in
`src/fidelityMetrics.test.js` check the comparator; they do not establish that
the viewer agrees with CS2.

## Capture request

The smallest useful first delivery is **three CS2 PNGs from kz_grotto**: an outdoor
view with leaves, an indoor view, and a dark/reflective view. Include the actual
eye-camera position/angles, FOV convention, resolution and graphics settings,
CS2 build, and Workshop VPK checksum. We capture the corresponding viewer views;
you do not need to prepare viewer screenshots. The locally tested Workshop VPK
SHA-256 is `b1e14165856d7740acab667935e0dae494755533513ca01c144629ae56a7dccc`.
If your version differs, supply that VPK or its exact Workshop version before comparing.

The complete acceptance set then expands to `kz_victoria`, `kz_grotto`, `kz_dojo`,
and foliage-heavy `kz_moss`:

- One representative outdoor view, one indoor view, one dark or reflective
  surface, and one distant fixed point (a landmark, sign, or platform edge).
- The same replay segment and the same camera position and angles in first-person,
  follow, and rival views. Include a 10-second moving first-person segment, then
  repeat that segment in follow and rival.
- A lossless PNG for every pair, plus the JSON manifest described below. Do not
  resize, recompress, colour-correct, or crop one side differently.
- At least three repeated warm runs per path for timing, with a separate cold
  startup measurement. Keep the run, hardware, browser, and path IDs identical
  between paired measurements.

The map checksum and version must identify the exact map data rendered. If a
workshop item or conversion is involved, record its item/version and the
conversion/exporter version rather than relying on the map name alone.

## Manifest contract

The comparator accepts the strict schema below. The complete examples are in
`scripts/fidelity/capture-reference.json` and
`scripts/fidelity/capture-candidate.json`; `rois.json` contains example named
regions. `source` identifies the file being captured. `reference.source` must
remain `cs2` in both manifests: a viewer image is a candidate, never the CS2
reference.

```json
{
  "schema": "kz-replay-fidelity-capture",
  "schemaVersion": 1,
  "source": "cs2",
  "captureId": "victoria-outdoor-cs2-01",
  "map": {
    "name": "kz_victoria",
    "checksum": "sha256:...",
    "version": "workshop-item-or-build-version"
  },
  "reference": {
    "source": "cs2",
    "build": "exact-cs2-build-id"
  },
  "camera": {
    "position": [100.0, 200.0, 300.0],
    "angles": [0.0, 90.0, 0.0],
    "fov": 90,
    "fovConvention": "horizontal",
    "aspect": 1.7777777777777777,
    "resolution": { "width": 1920, "height": 1080 },
    "dpr": 1
  },
  "graphics": {
    "settings": {
      "all-settings-must-be-recorded": "including values that look default"
    }
  }
}
```

`position` is the optical/eye position (not feet); `angles` are `[pitch, yaw, roll]`
in Source coordinates. The fixed-reference viewer currently rejects nonzero roll.
State the **actual** FOV convention explicitly; do not assume a
vertical FOV is interchangeable with a horizontal FOV. `aspect` must equal
`width / height`, and DPR is the effective device-pixel ratio used to produce
the PNG. Graphics settings must include every setting that can affect pixels
(tone mapping, antialiasing, shadows, texture filtering, reflections, colour
space, and so on). The resolution is the PNG's physical pixel size. `graphics.settings`
records the target CS2 setup in both manifests; retain the viewer's actual renderer
debug record alongside it. Equal target metadata does not prove equal implementations.

The validator compares map, CS2 reference, camera, display, and graphics fields
exactly (object key order does not matter). `captureId` and `source` may differ
between the two files. A mismatch is a failed setup, not a low-fidelity result.

## Image comparison

Run this from the repository root with explicit paths:

```sh
node scripts/compare-captures.js \
  --reference captures/victoria-cs2.png \
  --candidate captures/victoria-viewer.png \
  --reference-meta captures/victoria-cs2.json \
  --candidate-meta captures/victoria-viewer.json \
  --diff captures/victoria-difference.png \
  --roi hud=0,0,1920,120 \
  --roi landmark=700,300,500,400
```

The JSON report contains overall and every named ROI separately. Each has sample
count, MAE, RMSE, PSNR, maximum absolute channel difference, and differing pixel
count. RGB is compared by default; pass `--include-alpha` when alpha is part of
the contract. The difference PNG is the per-channel absolute RGB difference
(alpha is opaque for visibility unless alpha comparison is requested).

## Timing contract

Start the isolated capture server and run the browser harness with Node 24:

```sh
node node_modules/vite/bin/vite.js --config scripts/fidelity.config.js
node scripts/benchmark-viewer.js scripts/fidelity/benchmark-grotto.json artifacts/grotto
```

Install Chrome separately; `CHROME_PATH` overrides its executable. The server disables
file watching: restart it between source revisions. `mapUrl` can pin an immutable
revision GLB, or resolve the current published manifest. `viewpoints[].camera` can
contain the manifest's `position`, `angles`, `fov`, `fovConvention`, and `aspect` for
a fixed CS2 reference view. Without it, `seconds` selects an interpolated replay view.
Use `overlays:false` for visual comparisons; old-main timing baselines need overlays
enabled on **both** sides because old main cannot disable them.

The example uses `fixed-first-person-path`: identical replay poses are rendered at
each repeat even on very slow hardware. It measures scene rendering, not animation
or real-time playback. Also run `workload:"realtime"` for playback; inspect recorded
`replayTimes` before accepting comparisons. The player's real-time delta cap means
software runs can cover different portions of a nominal ten-second segment.

Each repeat uses a new browser context (cold browser HTTP cache, **not** cold OS disk
cache), loads the map, renders the warm-up segment, then measures the same segment.
Keep raw samples and the generated hardware/browser/config records. The report's
`compileMs` is the explicit compile stage; texture upload, first-use driver work and
other stalls can occur later and remain visible in cold readiness and frame samples.
GPU allocations are reported as object counts where byte counts are unavailable;
JS heap size is not GPU memory usage. No GPU hardware is available in the current
container: its SwiftShader measurements are diagnostics, not FPS acceptance.

`summarizeFrameDurations(samples)` rejects empty, zero, negative, non-finite, or
non-numeric samples and reports `sampleCount`, median, p95, and p99 (plus min and
max). Durations are milliseconds. `summarizeFramePhases({ cold, warm })` keeps
cold startup and warmed-up rendering as separate report objects; never merge
them into one percentile.

Every paired timing record must carry `runId`, `hardwareId`, `browserId`, and
`pathId`; repeated trials also carry a non-negative `repetition`. Use
`validateMatchedMeasurementIdentity` before comparing records. Do not compare
timings across different GPUs/drivers, browser versions, camera paths, or
unpaired repetitions.

## CS2 operator checklist

The exact console command set is build- and permission-dependent. The Valve
Developer Community's [console-variable index](https://developer.valvesoftware.com/wiki/Category:Console_variables)
lists `cl_drawhud`; verify every command in the target CS2 build and record the
observed value in the manifest. The following are candidates to check, not
universal assertions:

```text
cl_drawhud 0          // verify in the target build
r_drawviewmodel 0     // verify name, permissions, and effect
fov_cs_debug 90       // verify availability and horizontal/vertical meaning
```

If a command requires cheats, changes the camera, or is unavailable, do not
silently substitute it. Record the actual command/value or mark the setting
`requires-verification` and treat the capture as provisional. Disable overlays,
notifications, and OS colour-management changes, and capture the same viewport
without UI cropping on both sides.
