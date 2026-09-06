import * as THREE from "three";

// Decode inside the existing atlas lookup: no extra texture sample or render pass.
// Keep the stock material's BRDF, normal maps, AO and environment response intact.
export const configureLightmapEncoding = (material, descriptor) => {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const rgbm = descriptor.encoding === "rgbm8-linear";
  const excludeSceneLights = descriptor.excludeSceneLights === true;
  const sun = descriptor.sun;
  const shadows = descriptor.shadowTexture;
  const hasSun = Boolean(sun && shadows);
  if (hasSun) material.kzShadowMap = shadows;
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    if (rgbm) shader.uniforms.kzLightmapRange = { value: descriptor.range };
    if (hasSun) {
      Object.assign(shader.uniforms, {
        kzSunShadows: { value: shadows },
        kzSunDirection: { value: new THREE.Vector3(...sun.direction) },
        kzSunColor: { value: new THREE.Color(...sun.color) },
        kzSunShadowMask: { value: new THREE.Vector4(...sun.shadowMask) },
      });
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lightmap_pars_fragment>",
      `#include <lightmap_pars_fragment>\n${rgbm ? "uniform float kzLightmapRange;" : ""}
${hasSun ? "uniform sampler2D kzSunShadows; uniform vec3 kzSunDirection; uniform vec3 kzSunColor; uniform vec4 kzSunShadowMask;" : ""}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_fragment_maps>",
      THREE.ShaderChunk.lights_fragment_maps.replace(
        "lightMapTexel.rgb * lightMapIntensity",
        // Source's baked diffuse factor multiplies albedo directly. Three's
        // indirect Lambert BRDF divides irradiance by PI, so bridge those units.
        // VRF 00c629d: common/lighting.slang:309, csgo_environment.frag.slang:582.
        rgbm
          ? "lightMapTexel.rgb * lightMapTexel.a * kzLightmapRange * PI * lightMapIntensity"
          : "lightMapTexel.rgb * PI * lightMapIntensity",
      ),
    );
    if (excludeSceneLights) {
      // These are the viewer's fallback fixtures. They have no relationship to
      // the map's authored lights and otherwise fill every baked shadow.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_begin>",
        `#include <lights_fragment_begin>
reflectedLight.directDiffuse = vec3( 0.0 );
reflectedLight.directSpecular = vec3( 0.0 );
irradiance = vec3( 0.0 );`,
      );
    }
    if (hasSun) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
float kzVisibility = clamp(1.0 - dot(texture2D(kzSunShadows, vLightMapUv), kzSunShadowMask), 0.0, 1.0);
IncidentLight kzSun;
kzSun.visible = true;
kzSun.color = kzSunColor * kzVisibility * PI;
kzSun.direction = normalize(mat3(viewMatrix) * kzSunDirection);
vec3 kzPreviousDiffuse = reflectedLight.directDiffuse;
vec3 kzPreviousSpecular = reflectedLight.directSpecular;
RE_Direct(kzSun, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
${sun.renderDiffuse === false ? "reflectedLight.directDiffuse = kzPreviousDiffuse;" : ""}
${sun.renderSpecular === false ? "reflectedLight.directSpecular = kzPreviousSpecular;" : ""}`,
      );
    }
  };
  // Range is a uniform, so maps with different ranges share the same program.
  material.customProgramCacheKey = () =>
    `${previousKey}:kz-hdr-lightmap-v3:${descriptor.encoding}:${excludeSceneLights}:${hasSun}:${sun?.renderDiffuse}:${sun?.renderSpecular}`;
  material.userData.kzLightmapEncoding = descriptor.encoding;
  material.needsUpdate = true;
};
