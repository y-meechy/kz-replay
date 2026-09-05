// Named conversion profiles make every lossy choice deliberate and auditable.

const PROFILES = {
  fidelity: {
    dropFoliage: false,
    attributePolicy: "all",
    preserveMorphTargets: true,
    textureSize: null,
    lightmapSize: null,
  },
  legacy: {
    dropFoliage: true,
    attributePolicy: "legacy",
    preserveMorphTargets: false,
    textureSize: 256,
    lightmapSize: 1024,
  },
};

export const resolveMapQuality = ({
  profile = "fidelity",
  dropFoliage,
  textureSize,
  lightmapSize,
  simplifyError = null,
} = {}) => {
  const defaults = PROFILES[profile];
  if (!defaults) {
    throw new TypeError(
      `unknown map quality profile ${profile}; expected fidelity or legacy`,
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
    simplifyError,
  };
};

export const qualityReductions = (settings) => [
  ...(settings.dropFoliage ? ["foliage-meshes"] : []),
  ...(settings.attributePolicy !== "all" ? ["vertex-attributes"] : []),
  ...(!settings.preserveMorphTargets ? ["morph-targets"] : []),
  ...(settings.textureSize ? [`textures-max-${settings.textureSize}`] : []),
  ...(settings.lightmapSize ? [`lightmap-${settings.lightmapSize}`] : []),
  ...(settings.simplifyError !== null
    ? [`geometry-simplify-error-${settings.simplifyError}`]
    : []),
];
