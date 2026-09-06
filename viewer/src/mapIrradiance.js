import { TextureLoader } from "three";
import {
  supportsBc6hLightmap,
  loadBc6hLightmap,
} from "./compressedLightmap.js";

/** Choose one atlas, retaining its actual encoding for shader setup and diagnostics. */
export const loadPublishedIrradiance = async (
  renderer,
  files,
  {
    supportsCompressed = supportsBc6hLightmap,
    loadCompressed = loadBc6hLightmap,
    loadImage = (url) => new TextureLoader().loadAsync(url),
    warn = console.warn,
  } = {},
) => {
  const fallback = files.lightmapIrradiance;
  const compressed = files.lightmapIrradianceCompressed;
  let fallbackReason = null;
  if (compressed) {
    if (
      fallback &&
      (compressed.width !== fallback.width ||
        compressed.height !== fallback.height)
    ) {
      throw new Error("Compressed and fallback irradiance dimensions differ");
    }
    if (supportsCompressed(renderer, compressed)) {
      try {
        return {
          texture: await loadCompressed(compressed, { renderer }),
          descriptor: compressed,
          fallbackReason: null,
        };
      } catch (error) {
        fallbackReason = `compressed-load-failed: ${error.message}`;
        warn(
          `Native HDR atlas unavailable; loading RGBM fallback (${error.message})`,
        );
      }
    } else {
      fallbackReason = "bptc-unavailable";
    }
  }
  if (!fallback) {
    if (compressed)
      throw new Error(`No supported irradiance texture: ${fallbackReason}`);
    return null;
  }
  return {
    texture: await loadImage(fallback.url),
    descriptor: fallback,
    fallbackReason,
  };
};
