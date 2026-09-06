import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

/** Apply authored sky-material multipliers without an image exposure curve. */
export const configureHdrSky = (texture, descriptor) => {
  if (
    descriptor.encoding !== "exr-linear" ||
    descriptor.projection !== "vrf-latlong"
  ) {
    throw new Error("Unsupported HDR sky encoding or projection");
  }
  const { data, width, height } = texture.image;
  if (
    width !== height * 2 ||
    width !== descriptor.width ||
    height !== descriptor.height
  ) {
    throw new Error("HDR sky dimensions do not match the manifest");
  }
  const material = descriptor.material ?? {};
  const tint = material.tint ?? [1, 1, 1];
  const bias =
    (material.brightnessExposureBias ?? 0) +
    (material.renderOnlyExposureBias ?? 0);
  if (
    !Array.isArray(tint) ||
    tint.length !== 3 ||
    !tint.every((v) => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(bias)
  ) {
    throw new Error("Invalid authored HDR sky multiplier");
  }
  const factors = tint.map((channel) => channel * 2 ** bias);
  if (!factors.every(Number.isFinite))
    throw new Error("HDR sky multiplier overflow");
  if (factors.some((factor) => factor !== 1)) {
    const half = texture.type === THREE.HalfFloatType;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const index = pixel * 4 + channel;
        const linear = half
          ? THREE.DataUtils.fromHalfFloat(data[index])
          : data[index];
        const value = Math.max(0, linear * factors[channel]);
        data[index] = half ? THREE.DataUtils.toHalfFloat(value) : value;
      }
    }
  }
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  // VRF TextureExtract.CreateLatLongFromCubemapFaces begins longitude at +X.
  // Three's equirectUv places +X at u=.5. Both use +Y up after VRF's face remap.
  return {
    texture,
    rotation: new THREE.Euler(0, Math.PI, 0),
    dispose: () => texture.dispose(),
  };
};

export const loadHdrSky = async (url, descriptor) => {
  // Keep EXRLoader's row reversal here: VRF latlong row zero points north,
  // while Three's equirectUv maps north to v=1. This differs from the lightmap
  // atlas, whose exported UVs retain Source's row-zero convention.
  const texture = await new EXRLoader().loadAsync(url);
  try {
    return configureHdrSky(texture, descriptor);
  } catch (error) {
    texture.dispose();
    throw error;
  }
};
