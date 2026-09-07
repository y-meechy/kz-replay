# CS2 fidelity evidence log

## Scope and baseline

- Base: `faf2c604eeb97913d937c3a22a911184d1bc67d7` (main); PR #7 is merged.
- Working instructions: AGENTS.md delegates to CLAUDE.md; Node 24, plain ES modules,
  unit tests and Prettier required. Initial 30 tests pass (host Node 22; Node 24 being prepared).
- Roles: Astra investigates renderer architecture/shaders and performs final review;
  Sol owns conversion and versioned assets; Luna owns comparison metrics/fixtures/docs;
  primary agent integrates, captures baselines, runs checks, and publishes the PR.
- Found running local deployment and read-only source cache at `/var/lib/kz-replay`.
  Copy representative assets/tools into this isolated checkout; never reconvert production files.
- No actual CS2 reference capture found. Requested access location. Viewer screenshots
  and synthetic fixtures establish regressions only, never CS2 fidelity.
- Host has no `/dev/dri`; software browser measurements cannot establish target GPU parity.
- Workers stopped on account usage limits at 12:18 UTC; primary continues integration.
  Astra contributed material/RGBM/sky implementation and upstream evidence but has NOT performed final review.
- Node 24.18.1 copied from the existing deployment for checks. 44 tests passed before
  subsequent integration; focused HDR/environment regressions now also pass.

## Findings and decisions

| Mismatch                   | Verified cause                                                                                         | Correction/evidence status                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface detail/scenery     | Conversion deletes foliage, tangents, vertex colours; texture caps; file-size-triggered simplification | Retention and audit implemented; representative GPU performance pending                                                                                     |
| Materials                  | Runtime forces roughness=1, metalness=0, FrontSide, flat shading without base texture                  | Material preservation implemented and regression-tested                                                                                                     |
| Opaque foliage/decal cards | VRF fallback maps unknown CS2 shader g_tColor as RGB and discards alpha, despite MASK/BLEND material   | Direct source extraction confirms alpha; conversion restores 37 Grotto materials without changing RGB/cutoff; matched compressed recapture confirms cutouts |
| Compression ordering       | Running texture conversion after meshopt decodes and drops EXT_meshopt_compression                     | Texture encoding moved before final geometry packing                                                                                                        |
| Direct lighting            | Converter treats greyscale direct-light atlas as sun visibility; VRF uses `1-dot(RGBA, assigned mask)` | Remove unsupported inferred sun; preserve source channels                                                                                                   |
| HDR/exposure               | Irradiance and sky separately compressed by exponential curve, then ACES applied in viewer             | Versioned linear lighting contract under investigation                                                                                                      |
| Cache correctness          | GLB and mutable sibling files published separately; failed/missing sidecars can mix generations        | Immutable bundles, manifest published last                                                                                                                  |
| Atlas placement            | Grotto compiled UV scale is 1.14284; VRF 19.2 c722083 does not bake it, current upstream does          | Converter-version-aware UV correction and explicit atlas eligibility                                                                                        |
| Missing real sky           | Grotto packages gc_sky8 locally; old pipeline only searched the base-game cache                        | Resolve Workshop sky first, preserve its EXR and authored exposure bias                                                                                     |
| Silent material changes    | NodeIO lacked extension registration; no-base-texture materials recoloured by filename                 | Preserve glTF extensions and authored solid-colour/emissive factors                                                                                         |

## Measurements so far

- Legacy grotto, 1280×720 DPR1, Chrome/SwiftShader, first-person 8–18s, three
  repeats: medians 414.5 / 420.4 / 441.6 ms; p95 608.6 / 598.7 / 639.4 ms;
  p99 620.8 / 605.9 / 679.9 ms. Only 22–23 frames per run: tail estimates weak.
  Raw samples and fixed captures are in ignored `artifacts/baseline/grotto/`.
- First full-detail grotto conversion: 921 meshes; 536.8 MB GLB, 8192² RGBM atlas
  range 11.914. This intermediate is NOT performance-acceptable; UASTC KTX2 conversion
  and bundled decoder integration underway. Original production files remain untouched.
- Browser legacy lighting fixture and new HDR fixture both pass on SwiftShader:
  shader compilation, linear diffuse response, exclusion of invented ambient,
  correct selected shadow channel, unchanged unrelated channels, no WebGL errors.
- Fresh Workshop grotto downloaded; Victoria Workshop item failed with I/O error
  and current CS2KZ map API returns 404. Historical replay remains downloadable.
- Grotto revision `9c24dfca07f99269312e9e40` loads in Chrome/SwiftShader without
  shader/WebGL errors: 23.45 s until two rendered frames, 18.13 s map ready,
  139 ms compileAsync (driver lacks parallel shader compilation). One trial only.
  Fixed 12 s view: 276 draw calls, 617,969 drawn triangles, 1280×720 DPR1.
  `artifacts/grotto-v2.png` exposed opaque cards; it is a diagnostic, not accepted fidelity.
- That revision's 374.91 MB GLB contains 322.01 MB textures and lacks meshopt after
  the texture pass. Raw full-resolution RGBM PNG is 158.32 MB; HDR sky is 93.57 MB.
  Bundle size, loading, GPU memory, and performance remain unacceptable/unverified.
- 52 unit tests and production build pass after mask restoration and resource cleanup.
  Resizing numeric shadow RGBA now keeps channels independent; regression caught Sharp
  reordering extract/resize and treating the fourth shadow as opacity.
- Benchmark now separates realtime playback from a fixed first-person pose sequence.
  Old software timings traversed different paths because of the player's 250 ms delta
  cap; retain them as diagnostics, not paired performance acceptance evidence.
- Repaired Grotto revision `232dee11f02ebeeca9b82041`: 347.14 MB GLB, final meshopt
  retained; immutable previous bundles preserved. Matched 12 s viewer capture confirms
  opaque foliage cards corrected (`artifacts/grotto-alpha-{before,after}-12.png`).
  Foliage ROI changed as expected; unchanged-rock ROI MAE 0.000444/255, max difference
  1/255. These are regression diagnostics, NOT CS2 fidelity scores.
- Added fixed optical-camera API (explicit Source axes and actual FOV), overlay-free
  captures, shader-cache module pinned to the content depot manifest. Latest 54 unit
  tests include camera axes, opacity preservation, shadow-channel resizing and shader
  archive selection. Full shader-aware export still needs an integration run.
- Software opacity benchmark completed: three before/after repetitions with identical
  first-person poses (8–10 s, 120 samples per repeat). All paired replay-time arrays
  match. Before medians 602.05 / 589.20 / 592.85 ms; after 598.15 / 594.95 / 591.85 ms.
  No clear change beyond noise. Full raw reports and p95/p99 are committed under
  `docs/fidelity/`; this does not establish whole-branch or hardware-GPU parity.
- Shader integration job `kz-fidelity-shaders` exited 1: Steam returned 401 when
  DepotDownloader requested historical manifest `7673916425787288234`. The manifest
  is already cached locally; next safe implementation check is the existing authenticated
  chunk-cache retrieval path, without replacing the pinned version with newer shaders.
- Remote main rechecked: still identical to `faf2c604`. Implementation checkpoint
  committed locally as `8452ebf`. PR publication is BLOCKED: Git HTTPS has no terminal
  credentials, and the GitHub connector rejected its first write because approval is
  required but the session policy is `never`. No remote write or PR was created.
  User must enable an approved publishing path; do not claim the draft is published.
- Next material investigation: upstream TextureDecoders/Common.cs decodes HemiOct RG
  into RGB and moves original B roughness into A. Exported normals may be correct while
  fallback material mapping drops this roughness channel; verify and repair using texture
  compiler metadata, not a blanket normal-map inversion.
- September 6 continuation: publishing retried after explicit user authorization;
  connector still rejects writes with `approval policy is never`. No remote PR exists.
  Checkpoint revalidated locally: all 54 tests pass; production Vite build passes
  (large JS chunk warning remains). Astra, Sol and Luna delegation is available again:
  Astra owns native compressed HDR investigation/implementation, Sol fixes pinned shader
  archive retrieval, Luna prepares the honest draft PR description. Final acceptance
  review is still pending, not implied by these implementation tasks.
- Actual Grotto irradiance VTEX is unsigned BC6H: 8192² base plus authored 4096² mip,
  83,886,080 GPU block bytes versus 268,435,456 RGBM base bytes. Native preservation
  is being tested; no reduced resolution or claimed hardware performance result.
- Native HDR implemented and integrated: pipeline 3, version-1 BC6 container,
  capability-based selection plus full-resolution same-generation RGBM fallback.
  Actual independent CPU/GPU checks cover 512 positions, bilinear/trilinear sampling,
  both authored mips and partial-chain clamping: max error below 3e-8, WebGL error 0.
  This exposed and corrected EXR atlas row reversal. Sky projection intentionally
  retains EXRLoader's reversal. Source/file hashes and results are in `fidelity/native-hdr.md`.
- Diagnostic native bundle `34b747036d3f3bfb7fbf2bcb` preserves old assets. Nine matched
  captures (3/12/18 s, old/native/corrected-fallback) have no shader/page errors.
  Only 1.1% of pixels change at 3 s; 12/18 s are identical. This is NOT a broad
  visible improvement: unmapped lighting/material coverage remains the next major gap.
  Single cold loads: old 23.93 s, native 21.30 s, corrected fallback 22.80 s; not enough
  to claim performance parity or improvement. All 67 tests, build and Prettier pass.
- Sol's fixed shader acquisition retrieved 10 pinned archives (677,350,767 bytes),
  verified all 654 manifest chunk mappings (zero SHA-1 mismatches), and handles
  repeated chunk hashes at different file offsets. Root independently confirmed
  hash-verified cache reuse with no download logs. Shader-aware glTF reexport pending.
- Astra hit a usage limit after native implementation/validation, before its requested
  independent review of integration and Sol's archive changes. Root continues review;
  do not label Astra's final acceptance review complete.
- Astra subsequently resumed and independently reviewed commit `7da90be`. It found
  a real mixed-version risk: shader acquisition is pinned, but content/index selection
  can use a different cached depot manifest. Shared pinned-manifest acquisition and
  chunk verification now correct that path, with seven additional regression tests.
  Full shader-aware reconversion remains pending. No introduced blocker found in native descriptor
  compatibility, cancellation disposal or shader units. Deferred GPU upload failure
  recovery remains unimplemented. This bounded review is not full goal acceptance.
- Lighting coverage still uses a material-name/UV1 heuristic. Pinned upstream instead
  uses explicit lightmap/vertex-stream draw flags and input signatures. Audit actual
  Grotto draw calls next; do not assume every unnamed surface is an unlit prop.
- Publishing checkpoint requested explicitly: 74 unit tests pass. GitHub write retry
  still fails with the session's `approval policy is never`; no remote PR created.
  Package the committed branch as a verified Git bundle with the draft PR description
  for publication from an authenticated checkout. Do not treat this handoff as completion
  of the full visual/performance goal.

- Publication succeeded after the user authenticated GitHub CLI: branch
  `fidelity/source2-assets-and-measurement` pushed at `66426cb`; draft PR
  [#8](https://github.com/y-meechy/kz-replay/pull/8) created. All 74 tests passed
  again before push. Earlier connector-policy failures no longer block publishing
  through the authenticated CLI. The full CS2 visual/performance goal remains open.

Upstream renderer investigation is pinned to ValveResourceFormat
`00c629d321171ad0b9be83994c5e9cb15e8c5bd9`; deployed converter is 19.2.

## Acceptance and outstanding measurements

- Require actual matched CS2 views (version/hash, camera, FOV convention, resolution,
  aspect, settings), several first-person viewpoints plus moving segments, then follow/rival.
- Record named material/lighting/scenery regions and difference images as well as aggregate metrics.
- Repeat cold-load and warmed replay measurements separately on identical hardware/browser/path.
  Report median/p95/p99 frame times, loading/compile stalls, draw calls, triangles, measurable memory.
- No claim of 1:1 appearance, FPS parity, or representative reconversion until measured.
- Pending: sky orientation/sun/fog/probes/3D skybox, directional irradiance, custom blends/decals/water,
  character environment/animation/first-person gaps, representative asset conversions, review.

## Web profile: why revision `4f39a4f85115f8c5f0a5fe89` failed, and the replacement

Live Grotto revision `4f39a4f85115f8c5f0a5fe89` (fidelity profile) is
347,167,204 bytes of GLB beside an 83.9 MB native BC6H atlas, a 158.3 MB RGBM PNG
fallback, a 14.9 MB shadow atlas and a 93.6 MB EXR sky: 539.6 MB on a BPTC device,
614 MB on the fallback path, all uncompressed and all before the first frame. The
GLB is 321.6 MB of textures (221 KTX2 UASTC, no duplicates; 64 textures at 2048²
account for 251 MB: 123 MB normal maps, 193 MB base colour), 23.1 MB of meshopt
geometry (1,797,980 triangles, eight vertex streams) and a 2.3 MB JSON chunk.
UASTC is a fixed 8 bits per pixel, so Zstandard bought nothing.

Loaded from a local server on an M1 Max (Chrome, ANGLE Metal, 1280×720, three
repeats, `docs/fidelity/web-profile/benchmark-fidelity.json`): cold readiness
11,502 / 6,890 / 6,716 ms, asset stage 3.5–3.8 s, first shader compile 2.2 s,
JS heap 723 MB to 1.52 GB (the 94 MB EXR decodes to float in JavaScript). At a
typical 50 Mbit/s that payload is about ninety seconds of download; that is the
stall and the failure the deployed viewer showed. The deployed loading could not
be re-measured from this machine: the production host is not reachable with the
available SSH keys.

The pipeline now defaults to a `web` profile; `fidelity` stays selectable as the
diagnostic reference. Every mesh, material, vertex colour and lightmap UV is kept;
only resolution and encoding change (recorded in `audit.dropped`):

| File                 | legacy  | fidelity `4f39a4f8` | web `204bd8d6`  |
| -------------------- | ------- | ------------------- | --------------- |
| GLB                  | 13.6 MB | 347.2 MB            | 50.5 MB         |
| native BC6H atlas    | —       | 83.9 MB (8192²)     | 16.8 MB (4096²) |
| RGBM fallback        | 0.3 MB† | 158.3 MB PNG        | 23.9 MB WebP    |
| shadow atlas         | —       | 14.9 MB PNG         | 3.5 MB WebP     |
| sky                  | —       | 93.6 MB EXR         | 5.0 MB EXR      |
| downloaded, BPTC     | 13.9 MB | 539.6 MB            | 75.8 MB         |
| downloaded, fallback | 13.9 MB | 614.0 MB            | 82.9 MB         |

† legacy ships one tone-mapped 1024² WebP.

The web GLB is 29.9 MB of textures (138 colour textures as ETC1S at ≤1024: 14.8 MB;
65 normal maps as UASTC at ≤512: 13.8 MB), 18.6 MB of meshopt geometry (tangents,
`TEXCOORD_2` and `_TEXCOORD_4` dropped; the same 1,797,980 triangles) and 1.9 MB
JSON. The native atlas ships the compiler's authored 4096² mip unchanged; RGBM
fallback and shadow atlas are resized to match and stored as lossless WebP (decoded
bytes verified identical to the PNG). UASTC RDO was measured and rejected: 46.07 MB
at lambda 2 and at lambda 8 alike.

Measured on the same machine and settings (`benchmark-web.json`, three repeats,
10 s fixed first-person path, 600 frames each): cold readiness 5,129 / 1,513 /
1,579 ms (first repeat includes a 1,717 ms shader compile; later repeats hit
Chrome's shader cache, as did the legacy and fidelity runs), asset stage 0.8–1.0 s,
JS heap 251–377 MB. Legacy (`benchmark-legacy.json`): 4,605 / 460 / 462 ms, heap
50–53 MB. Warmed frame times are identical for all three bundles and vsync-bound
on this display: median 8.3 ms; p95 9.1–10.1 ms; p99 9.3–11.7 ms. Draw calls and
triangles per frame are the same for fidelity and web (median 214.5 calls and
465,431 triangles, p99 547 and 1,084,609) against legacy's 145.5 / 251,848, because
legacy deleted the foliage. No WebGL or shader errors in any run.

Matched captures (1280×720, four views: first-person foliage at 13 s, and fixed
reference cameras indoors, at a dark brick tower, and a distant cliff) are in
`docs/fidelity/web-profile/`. Against the fidelity bundle, the web packing measures
MAE 13.8 / PSNR 20.5 dB (foliage), 4.8 / 26.5 (indoor), 11.4 / 22.0 (dark),
3.9 / 26.4 (distant); legacy against fidelity measures 32.0 / 15.4, 45.5 / 12.0,
21.1 / 18.8 and 87.4 / 8.5. The visible differences are texture detail on
close-up brick and rock (2048 → 1024) and softer normal maps; no scenery is missing.

Two caveats. The web-profile GLB used for those captures is the live fidelity
export repacked through the identical web texture and geometry steps
(`webrepack`, 50,460,536 bytes), because a conversion on this macOS machine
resolves some borrowed base-game textures differently from the Linux server:
props such as the indoor rug arrive with the exporter's default ORM texture and a
metallic factor of 1, and render black under lightmap-only lighting. The
pipeline-produced web revision `204bd8d6cbc1265d972ca22a` (50,478,000 bytes)
matches the repack in size and load behaviour and must be regenerated on the
server before publication. And the live manifest holds only the fidelity revision,
so the working rollback is the root `kz_grotto.glb`/`kz_grotto.light.webp` legacy
pair: removing or renaming `kz_grotto.assets.json` restores it without deleting
any revision directory.

Also observed: the baked lightmap reaches 135 of 946 surfaces in both fidelity and
web bundles (the `agg_merge` mesh names do not match the world's material table),
and Three r170's `EXRExporter` writes 16-line ZIP blocks its own loader reads back
as zeros, so the downsampled sky uses single-scanline ZIPS.
