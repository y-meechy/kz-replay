// Two views, one page: browse the maps, or watch a run.
//
// The url is the whole state. #/ is the map list, #/watch/<id> plays one run, and
// #/watch/<id>/vs/<other> plays two against each other. That means every run is a
// link you can send someone, the back button works, and a reload lands where you
// were, none of which is true if the view lives in a variable.

import { decodeTrack } from "../src/track.js";
import { timeAtDistance } from "../src/compare.js";
import { createPlayer } from "./src/player.js";
import { loadRunById, parseRecordIds } from "./src/loadRun.js";
import { buildInsights } from "./src/insights.js";
import { createAnalysisPanel } from "./src/analysisPanel.js";
import { createBrowse } from "./src/browse.js";
import { formatDelta, formatRunTime } from "./src/format.js";

const el = (id) => document.getElementById(id);

// Looked up once. updateHud() runs on every rendered frame, so it must not go
// hunting through the document sixty times a second.
const browseRoot = el("browse");
const watchRoot = el("watch");
const stage = el("stage");
const loading = el("loading");
const backButton = el("back");
const playButton = el("play");
const scrub = el("scrub");
const elapsed = el("elapsed");
const total = el("total");
const rates = el("rates");
const cameras = el("cameras");
const statRun = el("stat-run");
const statTime = el("stat-time");
const statSpeed = el("stat-speed");
const statTeleports = el("stat-teleports");
const mapToggle = el("map-toggle");
const mapStatus = el("map-status");
const compareLive = el("compare-live");
const compareError = el("compare-error");
const watchNotice = el("watch-notice");
const statDelta = el("stat-delta");
const statGap = el("stat-gap");
const legendYou = el("legend-you");
const legendRival = el("legend-rival");
const povs = el("povs");
const povMain = el("pov-main");
const povRival = el("pov-rival");
const activePov = el("active-pov");
const scrubMarks = el("scrub-marks");
const mapConvert = el("map-convert");
const watchCompare = el("watch-compare");
const watchCompareInput = el("watch-compare-id");
const watchCompareButton = el("watch-compare-button");
const watchCompareError = el("watch-compare-error");
const statsPanel = el("stats");
const statsToggle = el("stats-toggle");

let player = null;
let scrubbing = false;
let activeId = null;
let activeRival = null;
let activeLaunchIntent = null;
let activeRun = null;
let activeRivalRun = null;
let activeTrack = null;
let activeMeta = null;
let activeRivalMeta = null;
let insights = null;
let selectedPov = "main";
let statsOpen = false;
// Set while a rival is loaded: the shared distance axis both runs are measured on.
let alignment = null;
// Clicking through runs faster than they load would otherwise leave two players
// rendering into the same canvas, so late arrivals are dropped.
let loadToken = 0;

const setStatsOpen = (open) => {
  statsOpen = open;
  statsPanel.classList.toggle("is-collapsed", !open);
  statsToggle.setAttribute("aria-expanded", String(open));
  statsToggle.setAttribute("aria-label", open ? "Close stats" : "Open stats");
  statsToggle.textContent = open ? "Close stats" : "Stats";
};

/** Seek the playback to a moment, and let it run so the moment plays out. */
const jumpTo = (seconds) => {
  if (!player) return;
  player.seekToSeconds(seconds);
  player.play();
  showPlaying(true);
};

/** Where on the selected run's clock a course distance is. */
const selectedTimeAt = (distance) => {
  if (!insights) return 0;
  const progress =
    selectedPov === "rival"
      ? insights.challengerProgress
      : insights.referenceProgress;
  return timeAtDistance(progress, distance, insights.tickRate);
};

/** The plotted (smoothed) gap at a course distance, by nearest sample. */
const deltaAt = (distance) => {
  if (!insights) return 0;
  const { distance: xs, delta } = insights.traces;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const gap = Math.abs(xs[i] - distance);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return delta[best] ?? 0;
};

const analysisPanel = createAnalysisPanel({
  overlay: el("analysis-overlay"),
  openButton: el("analysis-open"),
  // The chart's x axis is distance, so a click arrives as a distance and gets turned
  // into a moment on the clock here, where the alignment lives.
  onJumpDistance: (distance) =>
    jumpTo(Math.max(0, selectedTimeAt(distance) - 0.6)),
  timeAtDistance: selectedTimeAt,
  deltaAtDistance: deltaAt,
});

// --- loading runs -----------------------------------------------------------

// Parsing a replay costs a moment and a comparison wants the same runs again, so
// nothing is parsed twice.
const runCache = new Map();

const fetchOk = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
};

/** A run prepared earlier by the CLI. No analysis: that needs the replay itself. */
const loadPreparedTrack = async (recordId) => {
  const [buffer, meta] = await Promise.all([
    fetchOk(`./tracks/${recordId}.kztrack`).then((response) =>
      response.arrayBuffer(),
    ),
    fetchOk(`./tracks/${recordId}.json`).then((response) => response.json()),
  ]);
  return { recordId, track: decodeTrack(buffer), meta, analysis: null };
};

/**
 * Get a run, parsing the replay when possible.
 *
 * The replay is the better source: it carries the jump, strafe and input data the
 * prepared track drops, which is what the full analysis is made of. A prepared file
 * is the fallback for when the replay is gone or the proxy is not running.
 */
const getRun = async (recordId) => {
  const cached = runCache.get(recordId);
  if (cached) return cached;

  let run;
  try {
    run = await loadRunById(recordId);
  } catch (replayError) {
    try {
      run = await loadPreparedTrack(recordId);
    } catch {
      // The replay is the real failure worth reporting.
      throw replayError;
    }
  }
  runCache.set(recordId, run);
  return run;
};

// --- hud --------------------------------------------------------------------

const setActiveButton = (container, key, value) => {
  for (const button of container.querySelectorAll("button")) {
    button.classList.toggle("is-active", button.dataset[key] === value);
  }
};

const showPlaying = (playing) => {
  playButton.textContent = playing ? "Pause" : "Play";
};

/**
 * Marks on the timeline, one per highlight, so the moments that decided the run are
 * visible and reachable without opening anything.
 */
const renderScrubMarks = (data, duration) => {
  scrubMarks.innerHTML = "";
  if (!data || !duration) return;

  for (const moment of data.swings) {
    const momentTime =
      selectedPov === "rival" ? moment.challengerTime : moment.referenceTime;
    if (momentTime > duration) continue;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = moment.secondsLost > 0 ? "is-loss" : "is-gain";
    mark.style.left = `${(momentTime / duration) * 100}%`;
    mark.title = `${momentTime.toFixed(2)}s · ${moment.secondsLost > 0 ? "lost" : "gained"} ${Math.abs(moment.secondsLost).toFixed(3)}s`;
    mark.addEventListener("click", () => jumpTo(Math.max(0, momentTime - 0.6)));
    scrubMarks.append(mark);
  }
};

const updateCompareReadout = (frame) => {
  if (!alignment) return;
  const viewingRival = selectedPov === "rival";
  const distance = viewingRival
    ? (alignment.rivalProgress[frame.rivalIndex] ?? 0)
    : (alignment.referenceProgress[frame.index] ?? 0);
  const otherTime = timeAtDistance(
    viewingRival ? alignment.referenceProgress : alignment.rivalProgress,
    distance,
    alignment.tickRate,
  );
  // Positive: at this point on the course, the rival got here later.
  const delta = viewingRival
    ? frame.time - otherTime
    : otherTime - frame.referenceTime;
  statDelta.textContent = (
    viewingRival ? frame.rivalFinished : frame.referenceFinished
  )
    ? formatDelta(alignment.finalDelta)
    : formatDelta(delta);
  statGap.textContent =
    frame.gapToRival === null ? "—" : `${frame.gapToRival} u`;
  analysisPanel.setPlayheadDistance(distance);
};

const updateHud = (frame) => {
  statTime.textContent = `${frame.time.toFixed(2)}s`;
  statSpeed.textContent = `${frame.speed} u/s`;
  statTeleports.textContent = `${frame.teleports} / ${frame.totalTeleports}`;

  elapsed.textContent = frame.time.toFixed(2);
  if (!scrubbing) {
    scrub.value = String(Math.round(frame.progress * 1000));
  }

  updateCompareReadout(frame);
};

// --- map geometry -----------------------------------------------------------

const loadMapFor = async (meta, token) => {
  mapToggle.disabled = true;
  mapToggle.checked = false;
  mapConvert.hidden = true;

  if (!meta.map) {
    mapStatus.textContent = "no map name";
    return;
  }

  mapStatus.textContent = "checking…";
  const url = `./maps/${meta.map}.glb`;
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!head?.ok) {
    mapStatus.textContent = "not converted yet";
    // Only the dev server can convert: it needs steamcmd and the Valve tools.
    if (import.meta.env.DEV) {
      mapConvert.hidden = false;
      mapConvert.disabled = false;
      mapConvert.textContent = "Convert this map";
      mapConvert.dataset.map = meta.map;
    }
    return;
  }

  const megabytes = Number(head.headers.get("content-length") ?? 0) / 1e6;
  mapStatus.textContent = `loading ${megabytes.toFixed(1)} MB…`;
  try {
    const { triangles } = await player.loadMap(url);
    if (token !== loadToken) return;
    mapToggle.disabled = false;
    mapToggle.checked = true;
    mapStatus.textContent = `${(triangles / 1000).toFixed(0)}k triangles`;
  } catch (error) {
    if (token === loadToken) {
      mapStatus.textContent = `failed: ${error.message}`;
    }
  }
};

// --- the watch view ---------------------------------------------------------

const selectedRunDuration = () => {
  const run = selectedPov === "rival" ? activeRivalRun : activeRun;
  return run ? (run.track.count - 1) / run.track.tickRate : 0;
};

const selectPov = (next, { persist = false } = {}) => {
  const selected = player?.setPov(next);
  if (!selected) return null;

  selectedPov = selected;
  setActiveButton(povs, "pov", selected);
  const meta = selected === "rival" ? activeRivalMeta : activeMeta;
  const run = selected === "rival" ? activeRivalRun : activeRun;
  const name =
    selected === "rival"
      ? (meta?.player?.name ?? "rival")
      : (meta?.player?.name ?? "this run");
  activePov.textContent = `POV · ${name}`;
  total.textContent = (
    meta?.reportedTime ??
    run?.track.durationSeconds ??
    0
  ).toFixed(2);
  renderScrubMarks(insights, selectedRunDuration());
  analysisPanel.refresh();

  if (persist && activeId && activeRival) {
    const hash = `#/watch/${activeId}/vs/${activeRival}/pov/${selected}`;
    history.replaceState(null, "", hash);
  }
  return selected;
};

const clearRival = () => {
  alignment = null;
  insights = null;
  activeRivalRun = null;
  activeRivalMeta = null;
  selectedPov = "main";
  player?.setRival(null);
  compareLive.hidden = true;
  activePov.hidden = true;
  watchCompare.hidden = false;
  analysisPanel.setInsights(null);
  renderScrubMarks(null, 0);
};

const loadRival = async (recordId, token, initialPov = "rival") => {
  const rival = await getRun(recordId);
  if (token !== loadToken) return;

  const sameCourse =
    activeMeta.map === rival.meta.map &&
    activeMeta.course === rival.meta.course;
  if (!sameCourse) {
    throw new Error(
      `these runs are on different courses (${activeMeta.map}/${activeMeta.course} vs ${rival.meta.map}/${rival.meta.course})`,
    );
  }
  if (activeMeta.mode !== rival.meta.mode) {
    throw new Error(
      `these runs use different modes (${activeMeta.mode} vs ${rival.meta.mode})`,
    );
  }

  // One pass produces everything: the alignment, the delta curve and the traces.
  insights = buildInsights(activeRun, rival, { samples: 240 });
  alignment = {
    referenceProgress: insights.referenceProgress,
    rivalProgress: insights.challengerProgress,
    tickRate: insights.tickRate,
    finalDelta: insights.finalDelta,
  };

  player.setRival(rival.track);
  activeRivalRun = rival;
  activeRivalMeta = rival.meta;
  povMain.textContent = activeMeta.player?.name ?? "this run";
  povRival.textContent = rival.meta.player?.name ?? "rival";
  activePov.hidden = false;
  compareLive.hidden = false;
  watchCompare.hidden = true;
  analysisPanel.setInsights(insights);
  legendYou.textContent = `${activeMeta.player?.name ?? "this run"} · ${formatRunTime(activeMeta.reportedTime ?? 0)}`;
  legendRival.textContent = `${rival.meta.player?.name ?? "rival"} · ${formatRunTime(rival.meta.reportedTime ?? 0)}`;
  selectPov(initialPov);
};

const openRun = async (
  recordId,
  rivalId,
  { startEyes = false, notice = null, initialPov = "rival" } = {},
) => {
  const launchIntent = `${startEyes}:${notice ?? ""}:${initialPov}`;
  if (
    recordId === activeId &&
    rivalId === activeRival &&
    launchIntent === activeLaunchIntent
  ) {
    return;
  }
  setStatsOpen(false);
  const token = ++loadToken;
  loading.classList.remove("is-hidden");
  loading.textContent = "loading run…";
  compareError.hidden = true;
  compareError.textContent = "";
  watchCompareError.textContent = "";
  watchCompareInput.value = "";
  const noticeText =
    notice === "current-wr"
      ? "This replay is the current WR, so it is shown on its own."
      : notice === "wr-unavailable"
        ? "The exact current WR replay is unavailable, so this replay is shown on its own."
        : "";
  watchNotice.hidden = !noticeText;
  watchNotice.textContent = noticeText;

  try {
    const run = await getRun(recordId);
    if (token !== loadToken) return;

    player?.dispose();
    activeId = recordId;
    activeRival = rivalId;
    activeLaunchIntent = launchIntent;
    activeRun = run;
    activeTrack = run.track;
    activeMeta = run.meta;
    clearRival();

    statRun.textContent = `${run.meta.map} · ${run.meta.course} · ${run.meta.mode}`;
    total.textContent = (
      run.meta.reportedTime ?? run.track.durationSeconds
    ).toFixed(2);

    player = createPlayer({
      canvas: stage,
      track: run.track,
      onFrame: updateHud,
    });
    if (import.meta.env.DEV) window.__kzPlayer = player;

    showPlaying(true);
    setActiveButton(rates, "rate", "1");
    // Replays are meant to be watched through the runner's eyes. Orbit and Follow
    // remain available, but every entry path — including a WR opened from a map
    // card — starts in first person.
    const initialCamera = "first-person";
    player.setCameraMode(initialCamera);
    setActiveButton(cameras, "camera", initialCamera);
    loadMapFor(run.meta, token);
    loading.classList.add("is-hidden");

    if (rivalId) {
      loading.classList.remove("is-hidden");
      loading.textContent = "loading the run to compare against…";
      try {
        await loadRival(rivalId, token, initialPov);
      } catch (error) {
        if (token !== loadToken) return;
        clearRival();
        compareError.textContent = `Could not compare: ${error.message}.`;
        compareError.hidden = false;
      }
      if (token === loadToken) loading.classList.add("is-hidden");
    }
  } catch (error) {
    if (token === loadToken) {
      console.error("could not load run", error);
      loading.classList.remove("is-hidden");
      loading.textContent = `could not load run: ${error.message}`;
    }
  }
};

const leaveWatch = () => {
  loadToken += 1;
  player?.dispose();
  player = null;
  activeId = null;
  activeRival = null;
  activeLaunchIntent = null;
  watchNotice.hidden = true;
  clearRival();
  analysisPanel.close();
};

// --- controls ---------------------------------------------------------------

backButton.addEventListener("click", () => {
  window.location.hash = "#/";
});

statsToggle.addEventListener("click", () => {
  setStatsOpen(!statsOpen);
});

playButton.addEventListener("click", () => {
  showPlaying(player?.togglePlay());
});

scrub.addEventListener("pointerdown", () => {
  scrubbing = true;
});
scrub.addEventListener("pointerup", () => {
  scrubbing = false;
});
scrub.addEventListener("input", (event) => {
  player?.seekToProgress(Number(event.target.value) / 1000);
});

rates.addEventListener("click", (event) => {
  const rate = event.target.dataset.rate;
  if (!rate) return;
  player?.setRate(Number(rate));
  setActiveButton(rates, "rate", rate);
});

cameras.addEventListener("click", (event) => {
  const camera = event.target.dataset.camera;
  if (!camera) return;
  player?.setCameraMode(camera);
  setActiveButton(cameras, "camera", camera);
});

povs.addEventListener("click", (event) => {
  const pov = event.target.dataset.pov;
  if (!pov) return;
  selectPov(pov, { persist: true });
});

const compareFromWatch = () => {
  const ids = parseRecordIds(watchCompareInput.value);
  if (ids.length !== 1) {
    watchCompareError.textContent =
      "Enter one replay ID, for example 019ee7e7-c989-7a82-aa78-abaa88813a2f.";
    return;
  }
  if (ids[0] === activeId) {
    watchCompareError.textContent = "Choose a different replay to compare.";
    return;
  }

  watchCompareError.textContent = "";
  window.location.hash = `#/watch/${activeId}/vs/${ids[0]}/pov/main`;
};

watchCompareButton.addEventListener("click", () => compareFromWatch());
watchCompareInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") compareFromWatch();
});

mapToggle.addEventListener("change", (event) => {
  player?.setMapVisible(event.target.checked);
});

/**
 * Ask the dev server to download and convert the current map, then load it.
 *
 * Dev only. The work needs steamcmd and the Valve resource tools, and on a deployed
 * server the nightly refresh does it instead.
 */
mapConvert.addEventListener("click", async () => {
  const name = mapConvert.dataset.map;
  if (!name) return;

  mapConvert.disabled = true;
  mapConvert.textContent = "Converting…";
  mapStatus.textContent = "downloading the map, this takes a minute";

  try {
    const response = await fetch(
      `/api/convert-map?name=${encodeURIComponent(name)}`,
      { method: "POST" },
    );
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? `failed with ${response.status}`);
    }
    mapConvert.hidden = true;
    mapStatus.textContent = `converted, ${result.megabytes} MB — loading`;
    await loadMapFor(activeMeta, loadToken);
  } catch (error) {
    mapStatus.textContent = `conversion failed: ${error.message}`;
    mapConvert.disabled = false;
    mapConvert.textContent = "Try again";
  }
});

window.addEventListener("keydown", (event) => {
  if (!player || watchRoot.hidden) return;
  if (event.target.matches("textarea, input, select")) return;
  if (event.code === "Space") {
    event.preventDefault();
    showPlaying(player.togglePlay());
  } else if (event.code === "ArrowRight") {
    player.nudge(event.shiftKey ? 64 : 8);
  } else if (event.code === "ArrowLeft") {
    player.nudge(event.shiftKey ? -64 : -8);
  } else if (event.key.toLowerCase() === "c") {
    setActiveButton(cameras, "camera", player.cycleCamera());
  }
});

// --- routing ----------------------------------------------------------------

const browse = createBrowse({
  root: browseRoot,
  onWatch: ({ recordId, rivalId, startEyes = false, notice = null }) => {
    if (rivalId) {
      window.location.hash = `#/watch/${recordId}/vs/${rivalId}`;
      return;
    }
    window.location.hash = startEyes
      ? `#/watch/${recordId}/eyes/${notice ?? "pasted"}`
      : `#/watch/${recordId}`;
  },
});

const route = () => {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");

  if (parts[0] === "watch" && parts[1]) {
    browse.hide();
    watchRoot.hidden = false;
    const isComparison = parts[2] === "vs";
    const startEyes = parts[2] === "eyes";
    const requestedPov =
      parts[4] === "pov" && ["main", "rival"].includes(parts[5])
        ? parts[5]
        : "rival";
    openRun(parts[1], isComparison ? (parts[3] ?? null) : null, {
      startEyes,
      notice: startEyes ? (parts[3] ?? null) : null,
      initialPov: requestedPov,
    });
    return;
  }

  watchRoot.hidden = true;
  leaveWatch();
  browse.show();
};

window.addEventListener("hashchange", route);

await browse.load();
route();
