import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";

// Films one run to an MP4 with no game install: the viewer is opened with
// ?record=<fps>, which stops its clock, and every frame is stepped, screenshotted
// and piped to ffmpeg. A slow machine makes the render slow, never the video choppy.
//
//   node scripts/record-run.js [recordId] --seconds 30 --out clip.mp4
//
// No record id films the newest world record. --assets fetches maps and data from
// another viewer, because a dev checkout only holds the maps it converted itself:
//   --base http://localhost:5180 --assets https://demo.kzcomp.com
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "https://demo.kzcomp.com" },
    assets: { type: "string" },
    seconds: { type: "string", default: "30" },
    fps: { type: "string", default: "60" },
    size: { type: "string", default: "1920x1080" },
    view: { type: "string", default: "pov" },
    out: { type: "string" },
  },
});
const base = new URL(values.base);
const fps = Number(values.fps);
const frames = Math.round(Number(values.seconds) * fps);
const [width, height] = values.size.split("x").map(Number);

const id =
  positionals[0] ??
  (await fetch(new URL("/data/wrs.json", values.assets ?? base))
    .then((response) => response.json())
    .then((feed) => feed.records[0].recordId));
const out = values.out ?? `${id}.mp4`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => console.error(error.message));
  if (values.assets)
    await page.route(
      (url) =>
        url.origin === base.origin && /^\/(maps|data)\//.test(url.pathname),
      async (route) => {
        const { pathname, search } = new URL(route.request().url());
        const url = new URL(pathname + search, values.assets).href;
        await route.fulfill({ response: await route.fetch({ url }) });
      },
    );

  const watch = new URL("/watch", base);
  watch.search = new URLSearchParams({
    ids: id,
    view: values.view,
    record: fps,
  });
  await page.goto(watch.href);
  // The map toggle ticks itself once the geometry is in. A map that was never
  // converted never gets there, and a runner floating in a void is not a video.
  await page.waitForFunction(
    () => document.getElementById("map-toggle")?.checked,
    null,
    { timeout: 180_000 },
  );

  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", `${fps}`]
      .concat(["-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-crf", "18"])
      .concat(["-pix_fmt", "yuv420p", "-movflags", "+faststart", out]),
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const started = Date.now();
  for (let frame = 0; frame < frames; frame++) {
    await page.evaluate(() => window.__kzPlayer.renderFrame());
    const jpeg = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!ffmpeg.stdin.write(jpeg)) await once(ffmpeg.stdin, "drain");
    if (frame % fps === 0)
      process.stdout.write(`\r${frame / fps}s of ${values.seconds}s`);
  }
  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, "close");
  if (code) throw new Error(`ffmpeg exited with ${code}`);
  const took = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\r${out}: ${frames} frames in ${took}s`);
} finally {
  await browser.close();
}
