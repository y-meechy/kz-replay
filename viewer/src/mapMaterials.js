import * as THREE from "three";
import { configureLightmapEncoding } from "./mapLighting.js";

// Geometry-only exports carry the atlas in the base-colour slot on UV0.
const BAKED_LIGHT_MATERIAL_NAME = /^kz_[0-9a-f]{6}_lit$/;

/** Keep atlas and non-atlas surfaces independent, regardless of traversal order. */
export const createMapMaterials = (lightMapIntensity) => {
  const variants = new Map();

  return {
    adopt(material, canBeLit, candidates, owned, { hasNormals = true } = {}) {
      const key = `${material.uuid}:${canBeLit}:${hasNormals}`;
      let adopted = variants.get(key);
      if (!adopted) {
        // Never mutate the source: a later variant must start without the first
        // variant's lightmap or changes to its base-colour texture.
        adopted = material.clone();
        if (!hasNormals && adopted.isMeshStandardMaterial)
          adopted.flatShading = true;
        if (adopted.map && BAKED_LIGHT_MATERIAL_NAME.test(adopted.name)) {
          adopted.lightMap = adopted.map;
          adopted.lightMap.channel = 0;
          adopted.lightMapIntensity = lightMapIntensity;
          adopted.map = null;
        }
        adopted.needsUpdate = true;
        variants.set(key, adopted);
      }
      if (canBeLit && adopted.isMeshStandardMaterial) candidates.add(adopted);
      owned.add(adopted);
      return adopted;
    },
    release(owned) {
      for (const [key, material] of variants) {
        if (owned.has(material)) variants.delete(key);
      }
    },
  };
};

/** Attach the external atlas to eligible surfaces, including colour fallbacks. */
export const attachBakedLight = (
  texture,
  candidates,
  lightMapIntensity,
  descriptor = null,
) => {
  const hdr = descriptor?.encoding === "rgbm8-linear";
  if (descriptor && !hdr) {
    throw new Error(`Unsupported lightmap encoding: ${descriptor.encoding}`);
  }
  if (hdr && (!Number.isFinite(descriptor.range) || descriptor.range <= 0)) {
    throw new Error("RGBM lightmap range must be finite and positive");
  }
  // RGBM is numeric data. Applying an sRGB transfer function before RGB * M
  // corrupts the recovered radiance and clips its relationship to the sky.
  texture.colorSpace = hdr ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  // TextureLoader defaults to flipping images; GLTFLoader uses unflipped UVs.
  texture.flipY = false;
  texture.channel = 1;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  let attached = 0;
  for (const material of candidates) {
    // An embedded UV0 atlas already supplies this material's lighting.
    if (material.lightMap) continue;
    material.lightMap = texture;
    material.lightMapIntensity = lightMapIntensity;
    if (hdr) configureLightmapEncoding(material, descriptor);
    material.needsUpdate = true;
    attached += 1;
  }
  return attached;
};
