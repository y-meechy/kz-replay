import * as THREE from "three";

// Screen-space reflections for authored Source 2 water, and nothing else.
//
// Why not a full-screen SSRPass: the player draws straight to the canvas so it gets the
// browser's native MSAA and three's ACES output transform for free. A post-processing
// chain would have to move the whole frame into a multisampled float target, resolve it,
// and re-implement tone mapping in an output pass, which risks changing every other map
// to get a mirror on one material. It would also need a normal/roughness G-buffer that
// this forward renderer does not have, so it could not know *which* pixels may reflect.
//
// Instead, when a water surface is in view, the scene minus the water is drawn once into
// a reduced-resolution linear HDR target with a depth texture. The water keeps the
// viewer's ordinary lit material and gains a ray-march of that colour and depth in view
// space, faded towards the sky at screen edges, at long distances and for rays heading
// back at the camera. It is still drawn in the normal canvas pass, so it is multisampled
// and tone-mapped exactly like every other surface. Maps without water pay nothing.

/** `?reflections=on` opts in. Anything else keeps the established renderer. */
export const parseReflectionMode = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase() === "on"
    ? "on"
    : "off";

// csgo_water_fancy.vfx, csgo_water.vfx, water.vfx. Not csgo_waterfall.vfx: a falling
// sheet is not a flat mirror, and screen-space marching on it would be nonsense.
const WATER_SHADER = /(^|[/_])water(_[a-z0-9]+)?\.vfx$/i;

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const colour = (value, fallback) =>
  Array.isArray(value) && value.slice(0, 3).every(Number.isFinite)
    ? value.slice(0, 3)
    : fallback;

/**
 * Which surfaces may reflect, decided by the source material and never by colour.
 *
 * GLTFLoader puts the exporter's `extras.vmat` in `material.userData.vmat`. Only parameters
 * whose meaning is unambiguous are carried over; the SSR step/thickness numbers are kept
 * for the audit but not applied, because their units in CS2's shader are not documented.
 *
 * @returns null for anything that is not authored water.
 */
export const reflectiveSurfaceOf = (userData) => {
  const vmat = userData?.vmat;
  if (!vmat || typeof vmat.ShaderName !== "string") return null;
  if (!WATER_SHADER.test(vmat.ShaderName)) return null;
  const ints = vmat.IntParams ?? {};
  const floats = vmat.FloatParams ?? {};
  const vectors = vmat.VectorParams ?? {};
  return {
    kind: "water",
    material: vmat.Name ?? null,
    shader: vmat.ShaderName,
    reflectionType: ints.F_REFLECTION_TYPE ?? null,
    // Source's specular reflectance at normal incidence and its Schlick exponent.
    reflectance: THREE.MathUtils.clamp(
      finite(floats.g_flReflectance, 0.02),
      0,
      1,
    ),
    fresnelExponent: THREE.MathUtils.clamp(
      finite(floats.g_flFresnelExponent, 5),
      1,
      8,
    ),
    ssrBrightness: Math.max(0, finite(floats.g_flSSRBrightness, 1)),
    // The surface colour CS2 shows for this water; the exporter also wrote it to the
    // glTF base colour, which is why the "off" frame is already this colour.
    tint: colour(vectors.g_vColorTint, [1, 1, 1]),
    fogColor: colour(vectors.g_vWaterFogColor, [0.2, 0.45, 0.55]),
    fogStrength: Math.max(0, finite(floats.g_flWaterFogStrength, 0.5)),
    maxDepth: Math.max(1, finite(floats.g_flWaterMaxDepth, 100)),
    specularPower: THREE.MathUtils.clamp(
      finite(floats.g_flSpecularPower, 200),
      1,
      2048,
    ),
    waveDirection: finite(floats.g_flWaterInitialDirection, 0),
    waveSpeed: Math.max(0, finite(floats.g_flWavesSpeed, 0.1)),
    waveNormalStrength: Math.max(
      0,
      finite(floats.g_flWavesNormalStrength, 0.2),
    ),
    waveIterations: THREE.MathUtils.clamp(
      Math.round(finite(ints.g_nWaveIterations, 4)),
      1,
      6,
    ),
    sourceSsr: {
      maxForwardSteps: ints.g_nSSRMaxForwardSteps ?? null,
      stepSize: floats.g_flSSRStepSize ?? null,
      maxThickness: floats.g_flSSRMaxThickness ?? null,
    },
  };
};

const MAX_STEPS = 48;
const REFINE_STEPS = 6;

// Declarations spliced in front of MeshStandardMaterial's main().
const fragmentHeader = /* glsl */ `
uniform sampler2D kzSceneColor;
uniform sampler2D kzSceneDepth;
uniform bool kzSsrEnabled;
uniform mat4 kzProjection;
uniform mat4 kzViewInverse;
uniform float kzNear;
uniform float kzFar;
uniform vec2 kzViewport;
uniform sampler2D kzEnv;
uniform bool kzHasEnv;
uniform mat3 kzEnvRotation;
uniform vec3 kzEnvFallback;
uniform float kzTime;
uniform vec3 kzTint;
uniform float kzReflectance;
uniform float kzFresnelExponent;
uniform float kzSsrBrightness;
uniform float kzFogStrength;
uniform float kzMaxDepth;
uniform float kzSpecularPower;
uniform vec3 kzWaterSunDirection;
uniform vec3 kzWaterSunColor;
uniform float kzWaveDirection;
uniform float kzWaveSpeed;
uniform float kzWaveStrength;
uniform int kzWaveIterations;
uniform float kzEdgeFade;
uniform float kzMaxDistance;

vec2 kzProject(vec3 p) {
  vec4 clip = kzProjection * vec4(p, 1.0);
  return clip.xy / clip.w * 0.5 + 0.5;
}

float kzViewZ(vec2 uv, out float depth) {
  depth = texture2D(kzSceneDepth, uv).x;
  return perspectiveDepthToViewZ(depth, kzNear, kzFar);
}

vec3 kzSky(vec3 worldDir) {
  if (!kzHasEnv) return kzEnvFallback;
  vec3 d = normalize(kzEnvRotation * worldDir);
  vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5,
                 asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
  return texture2D(kzEnv, uv).rgb;
}

// A stand-in for g_tWavesNormalHeight, which the export does not carry: a few
// directional slopes in world units, rotated from the authored initial direction.
vec3 kzWaveNormal(vec3 n, vec2 p) {
  vec2 slope = vec2(0.0);
  float amplitude = 1.0;
  // World units covered by one pixel. An octave shorter than a few pixels aliases into
  // regular stripes on distant water, so it fades out before that.
  float footprint = length(fwidth(p));
  float wavelength = 260.0;
  for (int i = 0; i < 6; i++) {
    if (i >= kzWaveIterations) break;
    float angle = kzWaveDirection + float(i) * 2.39996;
    vec2 dir = vec2(cos(angle), sin(angle));
    float k = 2.0 * PI / wavelength;
    float phase = dot(dir, p) * k + kzTime * kzWaveSpeed * 40.0 * sqrt(k * 50.0);
    float resolved = 1.0 - smoothstep(0.12, 0.35, footprint / wavelength);
    slope += dir * cos(phase) * amplitude * resolved;
    amplitude *= 0.55;
    wavelength *= 0.53;
  }
  return normalize(n + vec3(-slope.x, 0.0, -slope.y) * kzWaveStrength);
}

// Returns rgb reflection and confidence in alpha; zero confidence means "use the sky".
vec4 kzTrace(vec3 origin, vec3 dir) {
  if (!kzSsrEnabled) return vec4(0.0);
  float stepLength = max(6.0, -origin.z * 0.012);
  float travelled = 0.0;
  vec3 previous = origin;
  vec3 point = origin;
  for (int i = 0; i < ${MAX_STEPS}; i++) {
    previous = point;
    point += dir * stepLength;
    travelled += stepLength;
    if (travelled > kzMaxDistance || point.z > -kzNear) break;
    vec2 uv = kzProject(point);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float depth;
    float sceneZ = kzViewZ(uv, depth);
    float behind = sceneZ - point.z;
    if (depth < 0.99999 && behind > 0.0) {
      // Behind something much thicker than this step: the ray passed under an
      // occluder, so whatever it would hit is not on screen. Keep marching.
      if (behind > stepLength * 1.5 + 8.0) {
        stepLength *= 1.09;
        continue;
      }
      vec3 lo = previous;
      vec3 hi = point;
      for (int j = 0; j < ${REFINE_STEPS}; j++) {
        vec3 mid = 0.5 * (lo + hi);
        float midDepth;
        if (kzViewZ(kzProject(mid), midDepth) - mid.z > 0.0) hi = mid;
        else lo = mid;
      }
      vec2 hitUv = kzProject(hi);
      vec2 edge = smoothstep(vec2(0.0), vec2(kzEdgeFade), hitUv) *
                  smoothstep(vec2(0.0), vec2(kzEdgeFade), 1.0 - hitUv);
      float confidence = edge.x * edge.y;
      confidence *= 1.0 - smoothstep(0.6 * kzMaxDistance, kzMaxDistance, travelled);
      // Rays aimed back at the camera can only find surfaces facing away from it.
      confidence *= 1.0 - smoothstep(0.05, 0.5, dir.z);
      return vec4(texture2D(kzSceneColor, hitUv).rgb, confidence);
    }
    stepLength *= 1.09;
  }
  return vec4(0.0);
}
`;

// Runs after <opaque_fragment>, so gl_FragColor already holds the unchanged "off"
// surface: g_vColorTint as albedo, lit by the baked lightmap and sun-shadow mask.
const fragmentBody = /* glsl */ `
{
  vec3 kzViewPos = -vViewPosition;
  vec3 kzWorldPos = (kzViewInverse * vec4(kzViewPos, 1.0)).xyz;
  vec3 kzPlaneNormal = inverseTransformDirection(nonPerturbedNormal, viewMatrix);
  vec3 kzNormal = kzWaveNormal(kzPlaneNormal, kzWorldPos.xz);
  vec3 kzViewNormal = normalize((viewMatrix * vec4(kzNormal, 0.0)).xyz);
  vec3 kzWorldView = normalize(cameraPosition - kzWorldPos);
  float kzNDotV = clamp(dot(kzNormal, kzWorldView), 0.0, 1.0);
  float kzFresnel = kzReflectance +
    (1.0 - kzReflectance) * pow(1.0 - kzNDotV, kzFresnelExponent);

  vec3 kzWorldReflected = reflect(-kzWorldView, kzNormal);
  // Never reflect below the water plane: a wave normal can tilt the ray downward.
  kzWorldReflected.y = abs(kzWorldReflected.y);
  vec3 kzViewReflected = normalize((viewMatrix * vec4(kzWorldReflected, 0.0)).xyz);
  vec4 kzTraced = kzTrace(kzViewPos, kzViewReflected);
  vec3 kzReflection = mix(kzSky(kzWorldReflected), kzTraced.rgb * kzSsrBrightness, kzTraced.a);

  vec3 kzSurface = gl_FragColor.rgb;
  if (kzSsrEnabled) {
    // Shallow water shows its bed, coloured by the water's own tint; with depth the
    // authored surface takes over (g_flWaterFogStrength over g_flWaterMaxDepth).
    // g_vWaterFogColor is not used as the colour here: on majka it is cyan under a red
    // surface, and mixing it in drew cyan fringes along every shoreline.
    vec2 kzScreenUv = gl_FragCoord.xy / kzViewport;
    vec2 kzRefractedUv = clamp(kzScreenUv + kzViewNormal.xy * 0.03, 0.001, 0.999);
    float kzDepth;
    float kzSceneZ = kzViewZ(kzRefractedUv, kzDepth);
    // Something in front of the water at the offset pixel would bleed in; undo it.
    if (kzSceneZ > kzViewPos.z) {
      kzRefractedUv = kzScreenUv;
      kzSceneZ = kzViewZ(kzRefractedUv, kzDepth);
    }
    float kzThickness = kzDepth >= 0.99999 ? 1e6 : max(kzViewPos.z - kzSceneZ, 0.0);
    float kzAbsorbed = 1.0 - exp(-kzThickness * kzFogStrength * 3.0 / kzMaxDepth);
    vec3 kzBed = texture2D(kzSceneColor, kzRefractedUv).rgb * kzTint;
    kzSurface = mix(kzBed, kzSurface, kzAbsorbed);
  }

  vec3 kzHalf = normalize(kzWaterSunDirection + kzWorldView);
  float kzSpecular = pow(max(dot(kzNormal, kzHalf), 0.0), kzSpecularPower)
    * step(0.0, kzWaterSunDirection.y) * KZ_SUN_VISIBILITY;
  // The reflection is tinted by g_vColorTint as well, so the authored red surface stays
  // red at grazing angles instead of turning into a sky-coloured mirror.
  gl_FragColor.rgb = mix(kzSurface, kzReflection * kzTint, kzFresnel)
    + kzWaterSunColor * kzSpecular;
}
`;

const uniformsFor = (surface, sunDirection, sun) => ({
  kzSceneColor: { value: null },
  kzSceneDepth: { value: null },
  kzSsrEnabled: { value: false },
  kzProjection: { value: new THREE.Matrix4() },
  kzViewInverse: { value: new THREE.Matrix4() },
  kzNear: { value: 1 },
  kzFar: { value: 1000 },
  kzViewport: { value: new THREE.Vector2(1, 1) },
  kzEnv: { value: null },
  kzHasEnv: { value: false },
  kzEnvRotation: { value: new THREE.Matrix3() },
  kzEnvFallback: { value: new THREE.Color(0.18, 0.26, 0.36) },
  kzTime: { value: 0 },
  kzTint: { value: new THREE.Color(...surface.tint) },
  kzReflectance: { value: surface.reflectance },
  kzFresnelExponent: { value: surface.fresnelExponent },
  kzSsrBrightness: { value: surface.ssrBrightness },
  kzFogStrength: { value: surface.fogStrength },
  kzMaxDepth: { value: surface.maxDepth },
  kzSpecularPower: { value: surface.specularPower },
  // GLB space; rotated into the map group's world frame by the pass.
  kzWaterSunDirection: { value: sunDirection.clone() },
  kzWaterSunColor: {
    value: new THREE.Color(...(sun?.color ?? [1, 1, 1])).multiplyScalar(
      sun ? 4 : 0,
    ),
  },
  kzWaveDirection: { value: surface.waveDirection },
  kzWaveSpeed: { value: surface.waveSpeed },
  kzWaveStrength: { value: surface.waveNormalStrength * 0.35 },
  kzWaveIterations: { value: surface.waveIterations },
  kzEdgeFade: { value: 0.1 },
  kzMaxDistance: { value: 16000 },
});

/**
 * Add reflections to the viewer's own material for authored water, in place.
 *
 * Decorating rather than replacing keeps everything the "off" frame has — the exporter's
 * base colour (g_vColorTint), the baked lightmap and the sun-shadow mask attached later by
 * configureLightmapEncoding, which chains onto this hook — and only adds to it.
 */
export const decorateWaterMaterial = (
  material,
  surface,
  { sun = null } = {},
) => {
  if (material.userData.kzSsrUniforms) return material;
  const sunDirection = new THREE.Vector3(...(sun?.direction ?? [0, 1, 0]));
  if (sunDirection.lengthSq() === 0) sunDirection.set(0, 1, 0);
  sunDirection.normalize();
  const uniforms = uniformsFor(surface, sunDirection, sun);
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    // configureLightmapEncoding runs after this hook and declares the baked sun-shadow
    // visibility it computes; a glint must not shine out of a baked shadow.
    const visibility = this.kzShadowMap ? "kzVisibility" : "1.0";
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `${fragmentHeader}\n#define KZ_SUN_VISIBILITY ${visibility}\nvoid main() {`,
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>\n${fragmentBody}`,
      );
  };
  material.customProgramCacheKey = () => `${previousKey}:kz-ssr-water-v2`;
  material.userData.kzSsrUniforms = uniforms;
  material.userData.kzReflectiveSurface = surface;
  material.userData.kzWaterSunDirectionLocal = sunDirection;
  material.needsUpdate = true;
  return material;
};

const skyRotation = (scene, target) => {
  // Mirrors WebGLBackground: an equirect background is drawn through a cube render
  // target, whose convention is the Euler with every component negated.
  const euler = new THREE.Euler(
    -scene.backgroundRotation.x,
    -scene.backgroundRotation.y,
    -scene.backgroundRotation.z,
    scene.backgroundRotation.order,
  );
  return target.setFromMatrix4(
    new THREE.Matrix4().makeRotationFromEuler(euler),
  );
};

/**
 * The reflection source: scene colour and depth without the water, at `scale` of the
 * drawing buffer. Created lazily, so a map with no water allocates nothing.
 */
export const createScreenSpaceReflections = (
  renderer,
  { scale = 0.5 } = {},
) => {
  const surfaces = new Set();
  let target = null;
  const size = new THREE.Vector2();
  const frustum = new THREE.Frustum();
  const projectionView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const sunWorld = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  let lastActive = false;

  const ensureTarget = () => {
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x * scale));
    const height = Math.max(1, Math.round(size.y * scale));
    if (!target) {
      const depthTexture = new THREE.DepthTexture(width, height);
      depthTexture.type = THREE.UnsignedIntType;
      target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.LinearSRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
        depthTexture,
      });
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
    }
    return target;
  };

  const anyVisible = (camera) => {
    projectionView.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projectionView);
    for (const mesh of surfaces) {
      // Drawn only if every ancestor is visible and the chain reaches a scene: a map
      // generation still loading is parentless and must not trigger the pass.
      let node = mesh;
      while (node.visible && node.parent) node = node.parent;
      if (!node.visible || !node.isScene) continue;
      mesh.geometry.boundingSphere ?? mesh.geometry.computeBoundingSphere();
      sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      if (frustum.intersectsSphere(sphere)) return true;
    }
    return false;
  };

  const feed = (mesh, camera, scene, time, ssrOn) => {
    const uniforms = mesh.material.userData.kzSsrUniforms;
    uniforms.kzSsrEnabled.value = ssrOn;
    uniforms.kzSceneColor.value = ssrOn ? target.texture : null;
    uniforms.kzSceneDepth.value = ssrOn ? target.depthTexture : null;
    uniforms.kzProjection.value.copy(camera.projectionMatrix);
    uniforms.kzViewInverse.value.copy(camera.matrixWorld);
    uniforms.kzNear.value = camera.near;
    uniforms.kzFar.value = camera.far;
    renderer.getDrawingBufferSize(uniforms.kzViewport.value);
    uniforms.kzTime.value = time;
    const background = scene.background;
    const equirect =
      background?.isTexture &&
      background.mapping === THREE.EquirectangularReflectionMapping;
    uniforms.kzEnv.value = equirect ? background : null;
    uniforms.kzHasEnv.value = Boolean(equirect);
    if (equirect) skyRotation(scene, uniforms.kzEnvRotation.value);
    else if (background?.isColor) uniforms.kzEnvFallback.value.copy(background);
    // The authored sun is in the GLB's root space; the map group turns that root.
    (mesh.userData.kzReflectionRoot ?? mesh.parent)?.getWorldQuaternion(
      quaternion,
    );
    sunWorld
      .copy(mesh.material.userData.kzWaterSunDirectionLocal)
      .applyQuaternion(quaternion)
      .normalize();
    uniforms.kzWaterSunDirection.value.copy(sunWorld);
  };

  return {
    /**
     * Give authored water reflections. `material` is the viewer's adopted material for
     * the mesh; anything that is not a water source material is left untouched.
     */
    decorate(mesh, sourceMaterial, material, { root = null, ...options } = {}) {
      const surface = reflectiveSurfaceOf(sourceMaterial?.userData);
      if (!surface || !material?.isMeshStandardMaterial) return false;
      decorateWaterMaterial(material, surface, options);
      if (root) mesh.userData.kzReflectionRoot = root;
      surfaces.add(mesh);
      return true;
    },
    /** Forget meshes that were removed with a map generation. */
    retain(predicate) {
      for (const mesh of surfaces) if (!predicate(mesh)) surfaces.delete(mesh);
    },
    get count() {
      return surfaces.size;
    },
    get active() {
      return lastActive;
    },
    get targetSize() {
      return target ? [target.width, target.height] : null;
    },
    /** Must run before the canvas render that draws the water, every frame. */
    update(scene, camera, time) {
      lastActive = false;
      if (!surfaces.size) return false;
      camera.updateMatrixWorld();
      if (!anyVisible(camera)) return false;
      ensureTarget();
      const hidden = [];
      for (const mesh of surfaces) {
        if (mesh.visible) hidden.push(mesh);
        mesh.visible = false;
      }
      const previous = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      try {
        renderer.autoClear = true;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(previous);
        renderer.autoClear = autoClear;
        for (const mesh of hidden) mesh.visible = true;
      }
      for (const mesh of surfaces) feed(mesh, camera, scene, time, true);
      lastActive = true;
      return true;
    },
    /**
     * Compile the render-target variants of the map's programs up front. Three picks a
     * different program for a linear float target than for the canvas (no tone mapping,
     * no sRGB encode), so the first reflected frame would otherwise stall on ~70 shaders.
     */
    compileAsync(object, camera, scene) {
      if (!surfaces.size || !renderer.compileAsync) return Promise.resolve();
      ensureTarget();
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      try {
        // compile() picks programs synchronously; only the wait for the driver is async.
        return renderer.compileAsync(object, camera, scene);
      } finally {
        renderer.setRenderTarget(previous);
      }
    },
    dispose() {
      surfaces.clear();
      target?.depthTexture?.dispose();
      target?.dispose();
      target = null;
      lastActive = false;
    },
  };
};
