# Native HDR and atlas orientation

This is Source-asset/renderer validation, **not a CS2 screenshot comparison**.

Grotto's actual irradiance texture contains unsigned BC6H blocks at 8192² and an
authored 4096² mip. The new version-1 transport preserves those blocks verbatim,
decompressing only their outer LZ4 storage. It uses 83,886,080 GPU block bytes
instead of the RGBM fallback's 268,435,456 base-level bytes. The transport is
83,886,128 bytes; the corrected RGBM PNG is 158,312,065 bytes. Resolution is unchanged.
These are storage counts, not measurements of total GPU memory or FPS.

The orientation investigation found a concrete bug: Three's EXR parser reverses
scanline rows, but the glTF atlas UVs preserve Source's coordinates. Conversion now
restores Source row order before RGBM encoding. Native blocks already use that order.
Sky latlong rows intentionally keep the EXR reversal; their projection differs.

## Independent decoding check

`scripts/verify-bc6h.js` compares actual native WebGL samples with EXR data decoded
independently by the pinned Source2Viewer CLI. It checks 512 fixed sample positions,
texel centers, bilinear filtering, the second authored mip, trilinear filtering,
and clamping beyond the partial mip chain. Non-finite values and mismatches fail.

The [recorded report](native-hdr-validation.json) identifies source hashes,
Chrome/SwiftShader, and both independently decoded mip references. Texel centers
match exactly. Maximum filtered error is below 3e-8 in linear radiance; WebGL reports
no error. The incorrect EXR row order produces maximum error 1.44708 instead.

Reproduce with the same compiled texture and CLI-decoded mip references:

```sh
node scripts/verify-bc6h.js irradiance.vtex_c irradiance.exr \
  artifacts/native-hdr-check mip1.exr --metrics-only
```

Without `--metrics-only`, the tool also writes the native atlas and corrected RGBM
fallback. It does not publish a map bundle. Source references come from
ValveResourceFormat revision `00c629d321171ad0b9be83994c5e9cb15e8c5bd9`;
the actual CLI is `19.2.6339+c72208352f5bf62f1482447ed166c548f303f8fa`.

## Integrated viewer check and limits

Diagnostic Grotto revision `34b747036d3f3bfb7fbf2bcb` retains the geometry, surface
textures, shadow atlas, and sky from `232dee11f02ebeeca9b82041`. Only irradiance
orientation and native storage change. It is a diagnostic repack, not a completed
shader-aware full-pipeline conversion. Previous bundles remain available.

Nine 1280×720 DPR1 screenshots cover replay times 3, 12 and 18 seconds for the
previous atlas, native atlas, and corrected RGBM fallback. Exact camera position,
quaternion, FOV, aspect, drawing buffer and exposure match. No shader/page errors
were reported. Native and corrected RGBM agree closely, but the correction affects
only 10,304 of 921,600 pixels at 3 seconds; the other two views are pixel-identical
to the previous atlas. The [image metrics](native-hdr-image-metrics.json) therefore
do **not** demonstrate a broad visual gain: lighting coverage and unmapped scenery
remain dominant gaps. Flat-colour plants and incorrectly presented materials are
still visible and require source-material export/lighting work.

Single cold-readiness observations were 23.93 s before, 21.30 s native, and 22.80 s
corrected RGBM. These are exploratory observations, not a repeated performance
result. Whole-branch hardware-GPU parity, CS2 matched views, representative map
conversion, and independent final acceptance review remain pending.
