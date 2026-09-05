import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { summarizeFrameDurations } from "../src/fidelityMetrics.js";

// Each repeat uses a new browser context (cold HTTP cache), then repeats the same
// replay segment once to warm shaders/textures and once for measured playback.
const [configPath, outputDir] = process.argv.slice(2);
if (!configPath || !outputDir)
  throw new Error(
    "Usage: node scripts/benchmark-viewer.js config.json output-directory",
  );
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes);
const output = resolve(outputDir);
await mkdir(output, { recursive: true });
const summary = (values) =>
  values.length ? summarizeFrameDurations(values) : null;
const countSummary = (values) => {
  if (!values.length) return null;
  // Durations must be strictly positive; draw counts may legitimately be zero.
  const stats = summarizeFrameDurations(values.map((value) => value + 1));
  return Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [
      key,
      key === "sampleCount" ? value : value - 1,
    ]),
  );
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: config.headless ?? true,
  args: [
    "--no-sandbox",
    ...(config.software
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : []),
  ],
});
const results = {
  schemaVersion: 1,
  config,
  configSha256: createHash("sha256").update(configBytes).digest("hex"),
  browser: browser.version(),
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
  },
  runs: [],
};
try {
  for (let repeat = 0; repeat < (config.repeats ?? 3); repeat++) {
    const context = await browser.newContext({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: config.pixelRatio,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      config.url ?? "http://127.0.0.1:5181/scripts/fidelity-viewer.html",
    );
    await page.waitForFunction(() => Boolean(window.fidelity));
    const cold = await page.evaluate((c) => window.fidelity.load(c), config);
    await page.waitForLoadState("networkidle");
    for (const point of config.viewpoints ?? []) {
      const capture = await page.evaluate(
        (point) => window.fidelity.capture(point),
        point,
      );
      const stem = `${repeat}-${point.id}`;
      // The harness canvas fills the viewport. Avoid element-stability polling,
      // which can starve on a software GPU's long frames.
      await page.screenshot({ path: join(output, `${stem}.png`) });
      await writeFile(
        join(output, `${stem}.json`),
        JSON.stringify({ source: "viewer", ...point, ...capture }, null, 2),
      );
    }
    const segment = {
      startSeconds: config.startSeconds ?? 3,
      seconds: config.seconds ?? 10,
      cameraMode: config.cameraMode ?? "first-person",
      rate: config.rate ?? 1,
      workload: config.workload ?? "realtime",
      pathFps: config.pathFps ?? 60,
    };
    const warming = await page.evaluate(
      (c) => window.fidelity.measure(c),
      segment,
    );
    const warmed = await page.evaluate(
      (c) => window.fidelity.measure(c),
      segment,
    );
    if (
      warmed.hidden ||
      warmed.frames.length < 2 ||
      errors.length ||
      warmed.errors.length
    )
      throw new Error(
        `Invalid benchmark: ${errors.concat(warmed.errors).join("; ")}`,
      );
    results.runs.push({
      repeat,
      cold,
      warming: { frameMs: summary(warming.frames) },
      warmed: {
        ...warmed,
        frameMs: summary(warmed.frames),
        drawCalls: countSummary(warmed.calls),
        drawnTriangles: countSummary(warmed.triangles),
      },
    });
    await writeFile(
      join(output, "benchmark.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      JSON.stringify({
        repeat,
        coldMs: cold.readyMs,
        frameMs: summary(warmed.frames),
        gpu: warmed.debug.gpu,
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
}
