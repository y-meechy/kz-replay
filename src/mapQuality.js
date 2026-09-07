// Named conversion profiles make every lossy choice deliberate and auditable.
//
// `web` is the default a browser actually downloads. Grotto at `fidelity` was a
// 347 MB GLB (322 MB of source-resolution UASTC textures) beside an 84 MB native
// atlas, a 158 MB RGBM fallback, a 15 MB shadow atlas and a 94 MB EXR sky: over
// half a gigabyte before the first frame, and the KTX2 transcode alone took
// minutes. `fidelity` stays available as the diagnostic reference.

const PROFILES = {
  web: {
    dropFoliage: false,
    attributePolicy: "web",
    preserveMorphTargets: true,
    textureSize: 1024,
    // ETC1S for colour: ~1 bit per pixel and it transcodes to every GPU. Normal,
    // roughness and occlusion data keep UASTC, which ETC1S would visibly quantise,
    // at half the colour resolution: UASTC is a fixed 8 bits per pixel, so the 65
    // Grotto normal maps were 46 MB at 1024 and are 14 MB at 512.
    dataTextureSize: 512,
    textureEncoding: "etc1s-color",
    lightmapSize: 4096,
    skySize: 2048,
  },
  fidelity: {
    dropFoliage: false,
    attributePolicy: "all",
    preserveMorphTargets: true,
    textureSize: null,
    dataTextureSize: null,
    textureEncoding: "uastc",
    lightmapSize: null,
    skySize: null,
  },
  legacy: {
    dropFoliage: true,
    attributePolicy: "legacy",
    preserveMorphTargets: false,
    textureSize: 256,
    dataTextureSize: null,
    textureEncoding: "uastc",
    lightmapSize: 1024,
    skySize: 1024,
  },
};

export const DEFAULT_MAP_PROFILE = "web";

export const resolveMapQuality = ({
  profile = DEFAULT_MAP_PROFILE,
  dropFoliage,
  textureSize,
  lightmapSize,
  skySize,
  simplifyError = null,
} = {}) => {
  const defaults = PROFILES[profile];
  if (!defaults) {
    throw new TypeError(
      `unknown map quality profile ${profile}; expected ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  if (
    simplifyError !== null &&
    (!Number.isFinite(simplifyError) || simplifyError <= 0)
  ) {
    throw new TypeError("simplifyError must be a positive finite number");
  }
  for (const [name, value] of [
    ["textureSize", textureSize],
    ["lightmapSize", lightmapSize],
    ["skySize", skySize],
  ]) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  return {
    profile,
    ...defaults,
    ...(dropFoliage === undefined ? {} : { dropFoliage }),
    ...(textureSize === undefined ? {} : { textureSize }),
    ...(lightmapSize === undefined ? {} : { lightmapSize }),
    ...(skySize === undefined ? {} : { skySize }),
    simplifyError,
  };
};

export const qualityReductions = (settings) => [
  ...(settings.dropFoliage ? ["foliage-meshes"] : []),
  ...(settings.attributePolicy !== "all" ? ["vertex-attributes"] : []),
  ...(!settings.preserveMorphTargets ? ["morph-targets"] : []),
  ...(settings.textureSize ? [`textures-max-${settings.textureSize}`] : []),
  ...(settings.textureEncoding === "etc1s-color"
    ? ["textures-etc1s-color"]
    : []),
  ...(settings.dataTextureSize
    ? [`data-textures-max-${settings.dataTextureSize}`]
    : []),
  ...(settings.lightmapSize ? [`lightmap-${settings.lightmapSize}`] : []),
  ...(settings.skySize ? [`sky-${settings.skySize}`] : []),
  ...(settings.simplifyError !== null
    ? [`geometry-simplify-error-${settings.simplifyError}`]
    : []),
];
