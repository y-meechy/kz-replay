import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { LoadingManager } from "three";
import basisJs from "three/examples/jsm/libs/basis/basis_transcoder.js?url";
import basisWasm from "three/examples/jsm/libs/basis/basis_transcoder.wasm?url";

/** Bundled decoder URLs follow Vite's content hashes in both dev and production. */
export const createMapLoader = (renderer) => {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url === "__kz_basis__/basis_transcoder.js") return basisJs;
    if (url === "__kz_basis__/basis_transcoder.wasm") return basisWasm;
    return url;
  });
  const textures = new KTX2Loader(manager)
    .setTranscoderPath("__kz_basis__/")
    .setWorkerLimit(2)
    .detectSupport(renderer);
  const loader = new GLTFLoader(manager)
    .setMeshoptDecoder(MeshoptDecoder)
    .setKTX2Loader(textures);
  return { loader, dispose: () => textures.dispose() };
};
