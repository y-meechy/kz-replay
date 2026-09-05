# Validating map and character lighting

Run `npm test` for the material regressions. They cover both traversal orders for
meshes sharing a material with and without atlas UVs, colour-only fallbacks,
embedded UV0 atlases, abandoned material variants, and character-only shader setup.

## Browser regression fixture

From the repository root, run:

```sh
npx vite --host 127.0.0.1 --port 5181
```

Open `http://127.0.0.1:5181/scripts/verify-renderer.html`. This fixture uses small,
synthetic assets and requires no CS2 install, map conversion, or replay download.
It checks:

- Pixel agreement between an atlas loaded through GLTFLoader on UV0 and the same
  atlas loaded through TextureLoader on UV1, including its vertical orientation.
- Lighting on a skinned, normal-mapped character with no scene lights.
- Unchanged map pixels when character lighting is enabled.
- Unchanged draw-call and triangle counts, and no shader or WebGL errors.

The fixture finishes with a black map sphere on the left and a lit character
sphere on the right. Its status must say that all graphics checks passed.
This is a correctness check, not a frame-rate benchmark.

## Real-map checks before merging

Use converted maps such as kz_victoria, kz_grotto, and kz_dojo, with the same
replay segments, camera positions, viewport, device pixel ratio, and hardware
on the base branch and PR branch. Include first-person, follow, and rival views.

Check textured and colour-only lightmapped surfaces, atlas seams, the CT model
from front and behind, and switching cameras after a seek. Compare lightmap
orientation against the matching CS2 view; the synthetic fixture establishes
glTF consistency but cannot establish the exporter conventions of every map.

After shaders and textures have warmed up, record median, p95, and p99 frame
times, draw calls, and triangles. Measure initial loading separately. The
character lighting adds two directional contributions and one hemisphere term
only to character fragments in the existing pass. It adds no textures, shadow
maps, or full-scene render pass, but its fragment cost still needs measurement
on target hardware. Do not infer unchanged FPS from unchanged draw calls.

Higher-resolution textures, environment reflections, changes to tone mapping,
and additional scenery need their own matched visual and performance baselines.
