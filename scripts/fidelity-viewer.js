import { decodeTrack } from "../src/track.js";

const params = new URLSearchParams(location.search);
const moduleUrl = params.get("player") ?? "../viewer/src/player.js";
const { createPlayer } = await import(/* @vite-ignore */ moduleUrl);
const nextFrame = () => new Promise(requestAnimationFrame);
let player;
let measurement = null;
const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));

window.fidelity = {
  async load({ trackUrl, mapUrl, mode = "classic", overlays = true }) {
    const start = performance.now();
    const response = await fetch(trackUrl);
    if (!response.ok) throw new Error(`Track returned ${response.status}`);
    const track = decodeTrack(await response.arrayBuffer());
    player = createPlayer({
      canvas: document.querySelector("canvas"),
      track,
      mode,
      onFrame(frame) {
        if (!measurement) return;
        const now = performance.now();
        if (measurement.last !== null) {
          measurement.frames.push(now - measurement.last);
          const { renderer } = player.__internals;
          measurement.calls.push(renderer.info.render.calls);
          measurement.triangles.push(renderer.info.render.triangles);
          measurement.replayTimes.push(frame.time);
        }
        measurement.last = now;
        if (measurement.fixedPath) {
          const next = measurement.frames.length;
          if (next >= measurement.frameCount) measurement.resolve();
          else
            player.seekToSeconds(
              measurement.startSeconds + (next + 1) * measurement.stepSeconds,
            );
        }
      },
    });
    // Install before map loading: compileAsync and the first frames can otherwise
    // fail before the benchmark starts recording shader diagnostics.
    player.__internals.renderer.debug.onShaderError = (gl, program) =>
      errors.push(gl.getProgramInfoLog(program));
    player.pause();
    player.setCameraMode("first-person");
    if (!overlays && !player.setReplayOverlaysVisible)
      throw new Error(
        "This player cannot disable replay overlays; use a matched baseline with overlays enabled for timing",
      );
    player.setReplayOverlaysVisible?.(overlays);
    const loadStart = performance.now();
    const loaded = await player.loadMap(mapUrl);
    // Legacy loadMap resolves before the sky and character. Wait for texture requests
    // to settle externally before warm measurements; retain the cold readiness duration.
    await nextFrame();
    await nextFrame();
    return {
      readyMs: performance.now() - start,
      mapLoadAndCompileMs: performance.now() - loadStart,
      loaded,
      debug: player.debug(),
    };
  },
  async capture({
    seconds,
    cameraMode = "first-person",
    pov = "main",
    camera,
  }) {
    player.pause();
    player.setCameraMode(cameraMode);
    player.setPov(pov);
    player.seekToSeconds(seconds);
    if (camera) {
      if (!player.setReferenceView)
        throw new Error("Player does not support fixed reference views");
      player.setReferenceView(camera);
    }
    await nextFrame();
    await nextFrame();
    return { debug: player.debug(), errors: [...errors] };
  },
  async measure({
    startSeconds = 3,
    seconds = 10,
    cameraMode = "first-person",
    rate = 1,
    workload = "realtime",
    pathFps = 60,
  }) {
    player.pause();
    player.setCameraMode(cameraMode);
    player.setRate(rate);
    player.seekToSeconds(startSeconds);
    await nextFrame();
    await nextFrame();
    measurement = {
      last: null,
      frames: [],
      calls: [],
      triangles: [],
      replayTimes: [],
    };
    if (workload === "fixed-first-person-path") {
      // A repeatable sequence of first-person replay poses. Slow software frames
      // cannot shorten the traversed segment via the player's realtime delta cap.
      // This measures rendering, NOT realtime animation or playback correctness.
      if (
        cameraMode !== "first-person" ||
        !Number.isFinite(pathFps) ||
        pathFps <= 0
      )
        throw new Error(
          "Fixed path requires first-person and a positive pathFps",
        );
      Object.assign(measurement, {
        fixedPath: true,
        frameCount: Math.ceil(seconds * pathFps),
        startSeconds,
        stepSeconds: 1 / pathFps,
      });
      await new Promise((resolve) => {
        measurement.resolve = resolve;
      });
    } else {
      player.play();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    player.pause();
    const result = measurement;
    measurement = null;
    const { renderer } = player.__internals;
    return {
      ...result,
      last: undefined,
      resolve: undefined,
      workload,
      debug: player.debug(),
      memory: {
        ...renderer.info.memory,
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      },
      programs: renderer.info.programs.length,
      errors: [...errors],
      hidden: document.hidden,
    };
  },
  dispose() {
    player?.dispose();
  },
};
