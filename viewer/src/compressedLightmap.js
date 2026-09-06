import * as THREE from "three";
import { BC6H_ENCODING, parseBc6hTexture } from "../../src/bc6hTexture.js";

export const supportsBc6hLightmap = (renderer, descriptor) =>
  descriptor?.encoding === BC6H_ENCODING &&
  Number.isInteger(descriptor.width) &&
  descriptor.width > 0 &&
  Number.isInteger(descriptor.height) &&
  descriptor.height > 0 &&
  descriptor.width <= renderer.capabilities.maxTextureSize &&
  descriptor.height <= renderer.capabilities.maxTextureSize &&
  renderer.extensions.has("EXT_texture_compression_bptc");

export const createBc6hLightmap = (input, descriptor) => {
  const parsed = parseBc6hTexture(input);
  if (
    descriptor &&
    (descriptor.encoding !== parsed.encoding ||
      descriptor.width !== parsed.width ||
      descriptor.height !== parsed.height ||
      descriptor.mipCount !== parsed.mipmaps.length)
  )
    throw new Error("BC6H lightmap does not match its published descriptor");
  const texture = new THREE.CompressedTexture(
    parsed.mipmaps,
    parsed.width,
    parsed.height,
    THREE.RGB_BPTC_UNSIGNED_Format,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.channel = 1;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  // Immutable storage in Three's WebGL2 renderer allocates exactly the authored
  // mip count, so partial chains (e.g. Grotto's two levels) remain complete.
  texture.minFilter =
    parsed.mipmaps.length > 1
      ? THREE.LinearMipmapLinearFilter
      : THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
};

export const loadBc6hLightmap = async (
  descriptor,
  { renderer, fetchImpl = fetch },
) => {
  if (!supportsBc6hLightmap(renderer, descriptor))
    throw new Error("Native BC6H lightmaps are unsupported on this renderer");
  const response = await fetchImpl(descriptor.url);
  if (!response.ok)
    throw new Error(`BC6H lightmap fetch failed (${response.status})`);
  return createBc6hLightmap(await response.arrayBuffer(), descriptor);
};
