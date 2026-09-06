// Diagnostic: node scripts/verify-bc6h.js source.vtex_c source.exr [output-dir] [mip1.exr] [--metrics-only]
// The EXR must be the same texture decoded by pinned Source2Viewer with flags none.
// Compares real native GPU blocks with the independent CPU decoder, including
// row orientation and linear interpolation. Does not publish or rewrite assets.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { HALF_TO_FLOAT } from "../src/tonemap.js";
import { readSource2Bc6h } from "../src/source2Texture.js";
import { encodeBc6hTexture } from "../src/bc6hTexture.js";
import { encodeIrradiance } from "../src/mapLightmap.js";

const [vtexPath, exrPath, artifactsDir, mip1ExrPath] = process.argv
  .slice(2)
  .filter((argument) => argument !== "--metrics-only");
const metricsOnly = process.argv.includes("--metrics-only");
if (!vtexPath || !exrPath)
  throw new Error(
    "Usage: node scripts/verify-bc6h.js <source.vtex_c> <decoded.exr>",
  );
const vtexBytes = await readFile(vtexPath);
const source = readSource2Bc6h(vtexBytes);
const bytes = encodeBc6hTexture(source);
const exrBytes = await readFile(exrPath);
const exr = new EXRLoader().parse(
  exrBytes.buffer.slice(
    exrBytes.byteOffset,
    exrBytes.byteOffset + exrBytes.byteLength,
  ),
);
const references = [exr];
let mip1ExrBytes;
if (mip1ExrPath && mip1ExrPath !== "--metrics-only") {
  mip1ExrBytes = await readFile(mip1ExrPath);
  references.push(
    new EXRLoader().parse(
      mip1ExrBytes.buffer.slice(
        mip1ExrBytes.byteOffset,
        mip1ExrBytes.byteOffset + mip1ExrBytes.byteLength,
      ),
    ),
  );
  if (
    references[1].width !== source.mipmaps[1]?.width ||
    references[1].height !== source.mipmaps[1]?.height
  )
    throw new Error("Mip 1 EXR dimensions differ");
}
if (exr.width !== source.width || exr.height !== source.height)
  throw new Error("EXR dimensions differ");
const points = Array.from({ length: 512 }, (_, i) => [
  (i * 1327 + 541) % (source.width - 1),
  (i * 1783 + 123) % (source.height - 1),
]);
const sample = (reference, x, y, c, flip) => {
  x = Math.max(0, Math.min(reference.width - 1, x));
  y = Math.max(0, Math.min(reference.height - 1, y));
  const value =
    reference.data[
      ((flip ? reference.height - 1 - y : y) * reference.width + x) * 4 + c
    ];
  return reference.data instanceof Float32Array ? value : HALF_TO_FLOAT[value];
};
const cases = [
  { fraction: 0, lod: 0 },
  { fraction: 0.25, lod: 0 },
  ...(references.length > 1
    ? [
        { fraction: 0, lod: 1 },
        { fraction: 0.25, lod: 0.5 },
        { fraction: 0, lod: 8 },
      ]
    : []),
];
const filtered = (reference, x, y, c, flip, fraction) => {
  const px = ((x + 0.5 + fraction) * reference.width) / source.width - 0.5;
  const py = ((y + 0.5 + fraction) * reference.height) / source.height - 0.5;
  const ix = Math.floor(px),
    iy = Math.floor(py),
    fx = px - ix,
    fy = py - iy;
  return (
    (1 - fy) *
      ((1 - fx) * sample(reference, ix, iy, c, flip) +
        fx * sample(reference, ix + 1, iy, c, flip)) +
    fy *
      ((1 - fx) * sample(reference, ix, iy + 1, c, flip) +
        fx * sample(reference, ix + 1, iy + 1, c, flip))
  );
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = `<!doctype html><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
import {createBc6hLightmap} from '/viewer/src/compressedLightmap.js';
window.run = async (points, cases) => {
 const renderer = new THREE.WebGLRenderer({antialias:false});
 if(!renderer.extensions.has('EXT_texture_compression_bptc')) throw new Error('BC6H extension unavailable');
 const texture = createBc6hLightmap(await (await fetch('/atlas.bc6')).arrayBuffer());
 const target = new THREE.WebGLRenderTarget(points.length,1,{type:THREE.FloatType,format:THREE.RGBAFormat,depthBuffer:false});
 const positions = new THREE.DataTexture(new Float32Array(points.flatMap(p=>[...p,0,1])),points.length,1,THREE.RGBAFormat,THREE.FloatType);
 positions.needsUpdate=true;
 const material = new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{atlas:{value:texture},coords:{value:positions},fraction:{value:0},lod:{value:0}},
 vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',
 fragmentShader:'uniform sampler2D atlas; uniform sampler2D coords; uniform float fraction; uniform float lod; out vec4 value; void main(){vec2 p=texelFetch(coords,ivec2(int(gl_FragCoord.x),0),0).xy; value=textureLod(atlas,(p+vec2(0.5+fraction))/vec2(textureSize(atlas,0)),lod);}' });
 const scene=new THREE.Scene();scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),material));
 const camera=new THREE.Camera();renderer.setRenderTarget(target);
 const result=[];
 for(const {fraction,lod} of cases){material.uniforms.fraction.value=fraction;material.uniforms.lod.value=lod;renderer.render(scene,camera);let out=new Float32Array(points.length*4);renderer.readRenderTargetPixels(target,0,0,points.length,1,out);result.push(Array.from(out));}
 const gl=renderer.getContext(), debug=gl.getExtension('WEBGL_debug_renderer_info');
 const identity={userAgent:navigator.userAgent,renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),vendor:gl.getParameter(debug?debug.UNMASKED_VENDOR_WEBGL:gl.VENDOR),version:gl.getParameter(gl.VERSION)};
 const error=gl.getError();
 target.dispose();texture.dispose();positions.dispose();material.dispose();renderer.dispose();
 return {result,error,identity};
};
</script>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
      return;
    }
    if (request.url === "/atlas.bc6") {
      response.end(bytes);
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const path = resolve(root, `.${request.url}`);
    if (!path.startsWith(`${root}/`)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: [
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.run);
  const gpu = await page.evaluate(
    ({ points, cases }) => window.run(points, cases),
    { points, cases },
  );
  const report = {
    source: {
      vtexPath,
      exrPath,
      vtexSha256: createHash("sha256").update(vtexBytes).digest("hex"),
      exrSha256: createHash("sha256").update(exrBytes).digest("hex"),
      ...(mip1ExrBytes
        ? {
            mip1ExrPath,
            mip1ExrSha256: createHash("sha256")
              .update(mip1ExrBytes)
              .digest("hex"),
          }
        : {}),
    },
    width: source.width,
    height: source.height,
    mips: source.mipmaps.length,
    bytes: bytes.length,
    samples: points.length,
    webglError: gpu.error,
    containerSha256: createHash("sha256").update(bytes).digest("hex"),
    browserVersion: browser.version(),
    gpu: gpu.identity,
    independentlyDecodedMips: references.length,
    comparisons: [],
  };
  for (const flip of [false, true])
    for (const [j, { fraction, lod }] of cases.entries()) {
      let max = 0,
        sum = 0,
        aboveWhite = 0;
      for (const [i, [x, y]] of points.entries())
        for (let c = 0; c < 3; c++) {
          const lower = Math.min(references.length - 1, Math.floor(lod));
          const upper = Math.min(references.length - 1, Math.ceil(lod));
          const blend = lod - Math.floor(lod);
          const expected =
            (1 - blend) * filtered(references[lower], x, y, c, flip, fraction) +
            blend * filtered(references[upper], x, y, c, flip, fraction);
          const actual = gpu.result[j][i * 4 + c];
          if (!Number.isFinite(actual) || !Number.isFinite(expected))
            throw new Error("Non-finite GPU/CPU sample");
          const error = Math.abs(actual - expected);
          max = Math.max(max, error);
          sum += error;
          if (expected > 1) aboveWhite++;
        }
      report.comparisons.push({
        reverseExrRows: flip,
        fraction,
        lod,
        maxAbsoluteError: max,
        meanAbsoluteError: sum / (points.length * 3),
        aboveWhite,
      });
    }
  console.log(JSON.stringify(report, null, 2));
  if (
    gpu.error !== 0 ||
    report.comparisons.some(
      (c) => c.reverseExrRows && c.maxAbsoluteError > 0.001,
    )
  )
    throw new Error(
      "Native BC6H samples did not match CPU decode in Source row order",
    );
  if (artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    // A fresh metrics-only run must neither require an older report nor borrow
    // fallback metadata that may describe a different source texture.
    if (!metricsOnly) {
      await writeFile(resolve(artifactsDir, "irradiance.bc6"), bytes);
      const fallback = await encodeIrradiance({
        width: exr.width,
        height: exr.height,
        data: exr.data,
        channels: 4,
        flipRows: true,
        decode:
          exr.data instanceof Float32Array ? (v) => v : (v) => HALF_TO_FLOAT[v],
      });
      await writeFile(resolve(artifactsDir, "irradiance.png"), fallback.png);
      report.rgbmFallback = {
        encoding: fallback.encoding,
        range: fallback.range,
        width: fallback.width,
        height: fallback.height,
        bytes: fallback.png.length,
        sha256: createHash("sha256").update(fallback.png).digest("hex"),
      };
    }
    await writeFile(
      resolve(artifactsDir, "validation.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      `Verified ${metricsOnly ? "metrics" : "assets and metrics"} written to ${artifactsDir}`,
    );
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
