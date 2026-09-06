# Draft PR description

> Draft checkpoint. Actual CS2-reference and hardware-GPU acceptance checks remain
> pending.

## Summary

This branch advances the map-rendering fidelity work from `faf2c60` with source-data
retention, safer conversion/publishing, and reproducible diagnostics. It is an
implementation checkpoint, not a claim of 1:1 CS2 parity or production readiness.

## What changed

- Retain foliage, tangents, vertex colours, secondary UVs, morph targets, and
  authored material properties instead of applying the legacy simplifications.
- Preserve Source 2 material metadata and repair verified opacity loss for the
  supported Grotto foliage/decal materials without changing their RGB, cutoff, or
  double-sided settings. Geometry packing now happens after texture encoding so
  meshopt compression is retained.
- Preserve source lighting channels and add the linear HDR/sky data path,
  versioned lighting contracts, and renderer checks. Preserve supported native BC6H
  irradiance and authored mips, with a full-resolution RGBM fallback; correct the
  EXR atlas row reversal. Retrieve and hash-verify pinned compiled shader archives.
- Pin shared content and shader acquisition to the same depot manifest, verify cached
  index/archive chunks, and reject mixed-version inputs before export.
- Publish map outputs as immutable, versioned bundles with a manifest switched last;
  failed or mixed-generation sidecars cannot silently be combined. Existing legacy
  assets/revisions are preserved. Maps need reconversion to receive the new data.
- Add fixed-camera capture/comparison and benchmark tooling, including named ROIs,
  measurement identity checks, cold-load versus warmed frame measurements, and raw
  JSON reports.

## Committed evidence

The following are diagnostic regression captures, not CS2 reference comparisons:

- [Before: opaque foliage cards](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/grotto-opacity-before.png)
- [After: restored source cutout masks](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/grotto-opacity-after.png)
- [Opacity regression notes and capture metadata](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/opacity-regression.md)

The paired captures use 1280×720 DPR1, Chrome/SwiftShader, the same first-person
camera at 12 seconds, and overlays disabled. The foliage ROI changes as expected;
the unchanged-rock ROI is MAE `0.000444/255`, maximum difference `1/255`.

### Six-run opacity benchmark

These are three paired repetitions before and after the opacity/packing change. Each
run measures 120 warmed frames over the same fixed first-person path (8–10 seconds);
`load` is cold map readiness. Values are milliseconds, from the committed raw JSON
reports.

| revision | run |    p50 |     p95 |     p99 |     load |
| -------- | --: | -----: | ------: | ------: | -------: |
| before   |   1 | 602.05 | 1120.17 | 1216.34 | 24363.30 |
| before   |   2 | 589.20 | 1038.18 | 1169.36 | 23068.20 |
| before   |   3 | 592.85 | 1029.50 | 1176.92 | 22630.00 |
| after    |   1 | 598.15 | 1037.86 | 1196.13 | 23891.30 |
| after    |   2 | 594.95 | 1107.20 | 1186.88 | 23574.30 |
| after    |   3 | 591.85 | 1091.42 | 1170.83 | 23135.20 |

The paired replay-time arrays match exactly, but these software-rendered runs show no
convincing performance change beyond run-to-run variation. Median draw calls are 180
on both sides. This is an isolated diagnostic, not whole-branch or hardware-GPU
parity evidence. See the [before raw report](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/performance-opacity-before.json) and
[after raw report](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/performance-opacity-after.json).

## Verification status

- Current local checkpoint: 74 unit tests pass, including mixed-manifest rejection,
  sparse-cache validation and duplicate chunk-offset regression tests. Production
  build and Prettier pass.
- [Native HDR validation](https://github.com/y-meechy/kz-replay/blob/fidelity/source2-assets-and-measurement/docs/fidelity/native-hdr.md): independent CPU/GPU decoding agrees at
  512 sample positions, including bilinear/trilinear and authored mip checks.
  Atlas block storage is 83.89 MB versus the RGBM fallback's 268.44 MB base level;
  these are storage counts, not whole-scene GPU-memory or FPS measurements.
- Nine matched viewer captures pass without shader/page errors. The atlas correction
  changes only 1.1% of pixels at 3 seconds and none at 12/18 seconds. It does not yet
  produce broad visual agreement; missing lighting/material coverage remains visible.
- No actual CS2 reference captures are available, so no visual parity score is
  reported. No hardware GPU is available on the host (`/dev/dri` is absent); the
  benchmark uses SwiftShader.
- Full-resolution assets remain too large for acceptance and have not passed the
  playback-performance gate. Do not deploy or bulk-reconvert from this checkpoint.
- Shader archive acquisition now succeeds: 10 pinned archives, 654 verified chunk
  mappings, zero SHA-1 mismatches; hash-verified offline reuse also passes.
  Their effect on exported materials still needs a shader-aware glTF reexport.
- Astra implemented and validated native HDR, then independently reviewed checkpoint
  `7da90be`. That review identified the mixed-content/shader-version risk corrected
  here. Final acceptance review of the complete branch remains pending.

## Merge readiness

Not merge-ready. Remaining gates include matched CS2 captures for representative
maps/views, representative reconversions with acceptable bundle/load/GPU cost,
hardware-GPU measurements, and review of sky, probes, fog, water/blends, 3D
skyboxes, characters, and shader/HDR integration. The old assets are intentionally
kept for rollback and comparison while those checks are completed.
