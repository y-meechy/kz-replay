import * as THREE from "three";

// What a Source 2 shader actually does with the data the glTF export hands three.js.
//
// The exporter writes every mesh's vertex colour as COLOR_0 and the material's
// g_vColorTint as its base colour, and GLTFLoader then treats both as albedo. That is
// only right for shaders that use them that way. These two were checked against CS2's
// own compiled shader metadata (shaders_vulkan_*.vpk from the pinned content manifest,
// dumped with Source2Viewer-CLI); see docs/viewer.md, "Source shader corrections".
//
// csgo_foliage.vfx: vertex colour is packed animation and shading data, never a tint.
//   The shader's parameter groups name the channels: red drives "Sway", "Noise 1",
//   "Frond Tip Anim" and "Height Gradient"; blue drives "Flutter" and "Noise 2"; alpha is
//   "Ambient Occlusion". Green is unused, which is why multiplying it in turned every
//   leaf on kz_bhop_majka magenta (R and B kept, G zeroed) and some barks black.
//   Only the vertex AO reaches the pixel, scaled by g_flVertexAmbientOcclusionAmount
//   (default 0) and shaped by ...Power (default 1).
//
// Converter fallback colours (kz_<hex>, no vmat): never multiplied by vertex colour.
//
// csgo_water_fancy.vfx: the compiled pixel shader binds g_vWaterFogColor, the decay,
//   foam, debris and caustic colours, and never g_vColorTint. A red tint on the source
//   material therefore has no effect in CS2. The colour of the water body is the fog
//   colour, so that is what the opaque fallback surface gets.

// The converter's own stand-in for a surface whose source material could not be loaded
// (src/trimMap.js colourMaterial): a colour guessed from the mesh name. Not the "_lit"
// atlas carriers, which mapMaterials.js handles.
const FALLBACK_PALETTE = /^kz_[0-9a-f]{6}$/;

const FOLIAGE = "csgo_foliage.vfx";
const WATER_FANCY = "csgo_water_fancy.vfx";

const shaderOf = (vmat) =>
  typeof vmat?.ShaderName === "string"
    ? vmat.ShaderName.split("/").pop().toLowerCase()
    : null;

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * The corrections a source material needs, as data. Pure, so it can be tested and
 * audited without a renderer.
 *
 * @returns {null | { shader, ignoreVertexColor?, vertexAo?, baseColor? }}
 */
export const sourceShadingOf = (vmat, materialName = "") => {
  // The source shader is unknown, so any vertex colour left on the mesh is data of
  // unknown meaning. On kz_bhop_majka it turned the green taro and palm plants purple.
  // Maps converted after src/trimMap.js stopped keeping it carry none.
  if (!vmat && FALLBACK_PALETTE.test(materialName))
    return {
      shader: null,
      fallback: true,
      ignoreVertexColor: true,
      vertexAo: null,
    };
  const shader = shaderOf(vmat);
  const floats = vmat?.FloatParams ?? {};
  if (shader === FOLIAGE) {
    const amount = THREE.MathUtils.clamp(
      finite(floats.g_flVertexAmbientOcclusionAmount, 0),
      0,
      1,
    );
    const power = Math.max(
      0,
      finite(floats.g_flVertexAmbientOcclusionPower, 1),
    );
    return {
      shader,
      ignoreVertexColor: true,
      vertexAo: amount > 0 ? { amount, power } : null,
    };
  }
  if (shader === WATER_FANCY) {
    const fog = vmat.VectorParams?.g_vWaterFogColor;
    if (!Array.isArray(fog) || !fog.slice(0, 3).every(Number.isFinite))
      return null;
    // Material-editor colours are picked in sRGB (0.262745 is 67/255).
    const baseColor = new THREE.Color().setRGB(
      ...fog.slice(0, 3).map((v) => THREE.MathUtils.clamp(v, 0, 1)),
      THREE.SRGBColorSpace,
    );
    return { shader, baseColor: baseColor.toArray() };
  }
  return null;
};

/**
 * Apply sourceShadingOf() to an adopted (already cloned) material in place.
 *
 * @returns the corrections applied, or null when the material needed none.
 */
export const correctSourceMaterial = (material) => {
  const shading = sourceShadingOf(material?.userData?.vmat, material?.name);
  if (!shading || !material.isMeshStandardMaterial) return null;
  if (shading.baseColor) material.color.fromArray(shading.baseColor);
  if (shading.ignoreVertexColor && material.vertexColors) {
    if (shading.vertexAo) {
      // Keep the attribute bound so its alpha can be read, but never as a tint.
      const { amount, power } = shading.vertexAo;
      const previousCompile = material.onBeforeCompile;
      const previousKey = material.customProgramCacheKey();
      material.onBeforeCompile = function (shader, renderer) {
        previousCompile.call(this, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#ifdef USE_COLOR_ALPHA
diffuseColor.rgb *= mix(1.0, pow(max(vColor.a, 0.0), ${power.toFixed(4)}), ${amount.toFixed(4)});
#endif`,
        );
      };
      material.customProgramCacheKey = () =>
        `${previousKey}:kz-foliage-vertex-ao:${amount}:${power}`;
    } else {
      material.vertexColors = false;
    }
  }
  material.userData.kzSourceShading = shading;
  material.needsUpdate = true;
  return shading;
};
