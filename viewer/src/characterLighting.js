import * as THREE from "three";

const uniforms = {
  kzSkyColor: { value: new THREE.Color("#b9d2f0").multiplyScalar(1.6) },
  kzGroundColor: { value: new THREE.Color("#1a2233").multiplyScalar(1.6) },
  kzSunColor: { value: new THREE.Color("#ffffff").multiplyScalar(1.4) },
  kzFillColor: { value: new THREE.Color("#e6f0ff").multiplyScalar(1.6) },
};

/**
 * Three.js layers filter lights through the camera, not through each mesh.
 * Add the runner's fill to its own material so the map keeps its baked shadows.
 * This uses the existing PBR equations in the same draw, with no extra textures,
 * render passes, or per-frame uniform updates.
 */
export const applyCharacterLighting = (material) => {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 kzSkyColor;
uniform vec3 kzGroundColor;
uniform vec3 kzSunColor;
uniform vec3 kzFillColor;`,
      )
      .replace(
        "#include <lights_fragment_begin>",
        `#include <lights_fragment_begin>
#if defined( RE_IndirectDiffuse )
  vec3 kzWorldNormal = inverseTransformDirection( geometryNormal, viewMatrix );
  irradiance += mix( kzGroundColor, kzSkyColor, kzWorldNormal.y * 0.5 + 0.5 );
#endif
#if defined( RE_Direct )
  IncidentLight kzLight;
  kzLight.visible = true;
  kzLight.color = kzSunColor;
  kzLight.direction = normalize( mat3( viewMatrix ) * vec3( 0.4, 1.0, 0.5 ) );
  RE_Direct( kzLight, geometryPosition, geometryNormal, geometryViewDir,
    geometryClearcoatNormal, material, reflectedLight );
  kzLight.color = kzFillColor;
  // Camera-space direction keeps the runner readable from behind.
  kzLight.direction = normalize( vec3( 0.0, 0.3, 1.0 ) );
  RE_Direct( kzLight, geometryPosition, geometryNormal, geometryViewDir,
    geometryClearcoatNormal, material, reflectedLight );
#endif`,
      );
  };
  material.customProgramCacheKey = () => "kz-character-lighting-v1";
  material.needsUpdate = true;
};
