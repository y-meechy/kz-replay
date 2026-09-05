import * as THREE from "three";

// Geometry-only exports carry the atlas in the base-colour slot on UV0.
const BAKED_LIGHT_MATERIAL_NAME = /^kz_[0-9a-f]{6}_lit$/;

/** Keep atlas and non-atlas surfaces independent, regardless of traversal order. */
export const createMapMaterials = (lightMapIntensity) => {
  const variants = new Map();

  return {
    adopt(material, canBeLit, candidates, owned) {
      const key = `${material.uuid}:${canBeLit}`;
      let adopted = variants.get(key);
      if (!adopted) {
        // Never mutate the source: a later variant must start without the first
        // variant's lightmap or changes to its base-colour texture.
        adopted = material.clone();
        adopted.side = THREE.FrontSide;
        adopted.roughness = 1;
        adopted.metalness = 0;
        if (adopted.map && BAKED_LIGHT_MATERIAL_NAME.test(adopted.name)) {
          adopted.lightMap = adopted.map;
          adopted.lightMap.channel = 0;
          adopted.lightMapIntensity = lightMapIntensity;
          adopted.map = null;
        }
        adopted.flatShading = !adopted.map;
        adopted.needsUpdate = true;
        variants.set(key, adopted);
      }
      if (canBeLit) candidates.add(adopted);
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
export const attachBakedLight = (texture, candidates, lightMapIntensity) => {
  texture.colorSpace = THREE.SRGBColorSpace;
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
    material.needsUpdate = true;
    attached += 1;
  }
  return attached;
};
