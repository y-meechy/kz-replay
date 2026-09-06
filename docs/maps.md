# The map pipeline

`node bin/kzreplay.js map <name>` converts a Workshop map into a versioned bundle:
geometry and surface textures, linear HDR irradiance, independent direct-shadow
channels, and an HDR sky when available. Conversion uses
[ValveResourceFormat / Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat).

The fidelity branch is under validation. Full-resolution bundles are currently large
and have **not** met the playback-performance acceptance gate. Do not bulk reconvert
or deploy based on unit tests alone. See [the evidence log](fidelity-log.md) and
[the capture/benchmark instructions](fidelity-capture.md).

## Tools

- Node 24 and `npm ci`.
- SteamCMD for anonymous Workshop downloads, unless `--workshop-dir` points at an
  already downloaded Workshop item.
- `tools/Source2Viewer-CLI`: tested converter 19.2, revision
  `c72208352f5bf62f1482447ed166c548f303f8fa`.
- `tools/DepotDownloader` and `xz` for missing base-game assets.
- KTX-Software 4.4.2 for GPU textures. The Dockerfile pins the Linux archive checksum.
  Default installation: `tools/KTX-Software-4.4.2-Linux-x86_64`. Set `KTX_TOKTX`
  to your platform's `toktx` executable, with `ktx` beside it, to override.

For chunk-level retrieval, `scripts/cs2-depot-key.py` prepares the local depot access
cache. Never commit that cache. Without chunk access, the existing downloader can
fetch whole archive parts. Asset rights remain with their authors; see
[third-party notices](third-party-notices.md).

## Conversion and publication

```sh
node bin/kzreplay.js map kz_grotto --workshop-id 3121168339 --keep-work
node bin/kzreplay.js map kz_grotto --workshop-id 3121168339 \
  --workshop-dir /path/to/workshop/content/730/3121168339 --keep-work
```

The fidelity profile retains foliage, tangents, vertex colours, secondary UVs,
morph targets and source material properties. File size does not trigger automatic
simplification. `--profile legacy` explicitly selects the old geometry/texture
reductions; it does **not** recreate the old tone-mapping pipeline.
`--texture-compression source` retains source PNGs for compression comparisons.

1. Extract Workshop content, read world material references, and borrow missing
   base-game materials and texture dependencies.
2. Export glTF with Source 2 material metadata retained in `extras.vmat`.
3. Extract compiled lighting metadata, light entities and the actual sky material.
4. Repair verified exporter losses: source opacity for supported shaders, material
   extensions, and atlas UV scale for exporter revisions known not to bake it.
   Unknown exporters with non-unit scale require an explicit
   `--exporter-lightmap-uvs source|baked` choice.
5. Encode surface textures to UASTC KTX2 with mipmaps, then pack geometry using
   meshopt. A later texture transform would decode meshopt again.
6. Publish a complete immutable revision directory, then atomically switch
   `<map>.assets.json`. Existing revisions and root legacy assets remain untouched.

Manifests record source VPK SHA-256, tool fingerprints/settings, file hashes,
dimensions/encodings, retention and unresolved gaps. The viewer resolves one revision
once: a broken published file must not borrow a sidecar from another revision.
An immutable revision GLB URL uses its sibling manifest for comparison or rollback.

## Lighting contract and known gaps

Pipeline 3 preserves supported unsigned BC6H irradiance blocks and authored mips in
a version-1 `.bc6` container, without decoding/recompressing their radiance. On
WebGL devices with BPTC support, the viewer loads this native atlas. Other devices
retain the full-resolution, explicitly ranged RGBM8 PNG fallback. A failed native
download also uses that same-generation fallback and records the reason in debug
output. No resolution reduction is hidden behind capability selection.

EXR decoding reverses rows for Three's ordinary texture convention. Atlas conversion
now reverses those rows back because exported Source atlas UVs are unchanged.
This correction does not apply to equirectangular skies, whose north pole maps to
v=1 in Three. See [native-HDR validation](fidelity/native-hdr.md).

Neither path tone-maps during conversion. Native BC6H preserves the original engine
quantization and filters linear radiance. PNG losslessness does not make RGBM
quantization or interpolation lossless; fallback filtering remains a known gap.

Direct-shadow RGBA contains four independent shadow amounts, not colour plus opacity.
For supported v8.2–v8.4 maps, the sun's assigned channel gives visibility as
`1 - dot(shadows, oneHotMask)`. Direction, colour and brightness come from
`light_environment`, not atlas statistics. Unsupported versions are recorded gaps.
Source baked diffuse and Three's Lambert irradiance use different units; the shader
bridges those units with PI.

Versioned lightmapped surfaces exclude invented scene lights. Unmapped props still
lack Source lighting probes and use fallback lighting: this remains a visual error.
Directional irradiance, probes, local lights, fog, water/blends, 3D skyboxes and
character lighting remain under review.

Sky extraction searches Workshop content before the base-game cache, retaining EXR
radiance and authored material tint/exposure bias. Display tone mapping occurs after
surfaces and sky. Actual CS2 exposure and orientation need matched references;
synthetic shader tests cannot establish them.

## Compatibility and caching

New corrections require reconversion. Legacy assets remain supported but cannot
recover channels already discarded from their textures. The stable manifest uses
`no-cache`; revision assets use immutable caching. Preserve representative old/new
bundles until visual and performance results are convincing, then expand conversion
deliberately. Do not replace production assets with an unmeasured batch.
