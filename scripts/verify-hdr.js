import * as THREE from "three";
import { attachBakedLight } from "../viewer/src/mapMaterials.js";

const status = document.querySelector('[role="status"]');
const checks = [];
const check = (condition, label) => {
  if (!condition) throw new Error(label);
  checks.push(`PASS: ${label}`);
};
try {
  const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector("canvas"),
    antialias: false,
  });
  renderer.setSize(32, 32);
  renderer.toneMapping = THREE.NoToneMapping;
  const errors = [];
  renderer.debug.onShaderError = (gl, program) =>
    errors.push(gl.getProgramInfoLog(program));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 100));
  const geometry = new THREE.PlaneGeometry(2, 2);
  geometry.setAttribute("uv1", geometry.getAttribute("uv").clone());
  const makeTexture = (bytes) => {
    const t = new THREE.DataTexture(new Uint8Array(bytes), 1, 1);
    t.needsUpdate = true;
    return t;
  };
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.25, 0.25, 0.25),
      roughness: 1,
      metalness: 0,
    }),
  );
  scene.add(mesh);
  const sample = () => {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[0];
  };
  attachBakedLight(
    makeTexture([128, 128, 128, 255]),
    new Set([mesh.material]),
    1,
    { encoding: "rgbm8-linear", range: 1, excludeSceneLights: true },
  );
  const indirect = sample();
  check(
    indirect > 90 && indirect < 110,
    `RGBM decodes to linear diffuse and excludes guessed ambient (${indirect})`,
  );
  const skyLight = scene.children.find((o) => o.isLight);
  skyLight.intensity = 0;
  check(
    Math.abs(sample() - indirect) <= 1,
    "Changing scene fill cannot wash out HDR baked shading",
  );
  const shadow = makeTexture([255, 0, 0, 0]);
  const sun = {
    direction: [0, 0, 1],
    color: [0.5, 0.5, 0.5],
    shadowMask: [1, 0, 0, 0],
    renderDiffuse: true,
    renderSpecular: false,
  };
  mesh.material.dispose();
  mesh.material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  attachBakedLight(makeTexture([0, 0, 0, 255]), new Set([mesh.material]), 1, {
    encoding: "rgbm8-linear",
    range: 1,
    excludeSceneLights: true,
    sun,
    shadowTexture: shadow,
  });
  check(
    sample() === 0,
    "A full selected shadow channel blocks the authored sun",
  );
  shadow.image.data.set([0, 255, 0, 0]);
  shadow.needsUpdate = true;
  check(sample() > 150, "Other lights' shadow channels do not block this sun");
  check(errors.length === 0, `No shader errors: ${errors.join("; ")}`);
  check(renderer.getContext().getError() === 0, "No WebGL errors");
  renderer.dispose();
  status.textContent = checks.join("\n") + "\nAll HDR checks passed.";
} catch (error) {
  status.textContent = checks.join("\n") + `\nFAIL: ${error.stack}`;
  console.error(error);
}
