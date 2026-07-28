// Four pages, one document: browse the maps, scroll the world record feed, watch a
// run, or read the docs.
//
// The url is the whole state. That means every run is a link you can send someone,
// the back button works, and a reload lands where you were, none of which is true
// if the view lives in a variable.
//
//   /                                          the map list
//   /wr[?id=<id>]                              the world record feed
//   /watch?ids=<id>[,<id>]&view=pov|follow|orbit
//   /docs                                      how to build those links
//
// Query parameters rather than path segments because the links are built by other
// sites, not just by this one, and `ids=a,b` is something you can put together with
// string concatenation and no knowledge of our routing. viewer/index.html has the
// page a linker actually reads.

import { decodeTrack } from "../src/track.js";
import { timeAtDistance } from "../src/compare.js";
import { createPlayer } from "./src/player.js";
import { loadRunById, parseRecordIds } from "./src/loadRun.js";
import { buildInsights } from "./src/insights.js";
import { createAnalysisPanel } from "./src/analysisPanel.js";
import { createBrowse } from "./src/browse.js";
import { createWrFeed } from "./src/wrFeed.js";
import { createMhud } from "./src/mhud.js";
import { findMapFile } from "./src/mapFile.js";
import { formatDelta, formatRunTime } from "./src/format.js";
import { createViewTicker, fetchViews, viewsLabel } from "./src/views.js";

const el = (id) => document.getElementById(id);

// --- urls -------------------------------------------------------------------

/**
 * `view` in a link, to a camera in the player.
 *
 * Three short words rather than the player's own names, because "pov" is what a KZ
 * player calls the first person camera and the link is written by people, not by us.
 */
const VIEWS = {
  pov: "first-person",
  follow: "follow",
  orbit: "orbit",
};
const VIEW_NAMES = Object.fromEntries(
  Object.entries(VIEWS).map(([name, mode]) => [mode, name]),
);
const DEFAULT_VIEW = "pov";

/**
 * How many record ids one link may carry.
 *
 * Two, because that is what the player can draw: one run, and one rival to measure
 * it against. Extra ids are dropped with a notice rather than ignored in silence,
 * so whoever built the link finds out.
 */
const MAX_RUNS = 2;

const watchUrl = (ids, view = DEFAULT_VIEW, notice = null) => {
  const params = new URLSearchParams({ ids: ids.join(",") });
  // Left out when it is the default, so the common link stays short.
  if (view !== DEFAULT_VIEW) params.set("view", view);
  if (notice) params.set("notice", notice);
  // URLSearchParams escapes the separator to %2C. A comma is legal unescaped in a
  // query string, and `ids=a,b` is the shape the docs promise and the shape someone
  // reads back off their address bar, so put it back.
  return `/watch?${params.toString().replace(/%2C/g, ",")}`;
};

/**
 * The new url for an old link, or null if it is not one.
 *
 * Links of the old shape are already out there in Discord messages, so they are
 * translated instead of dropped:
 *
 *   #/watch/<a>                  -> /watch?ids=<a>
 *   #/watch/<a>/vs/<b>           -> /watch?ids=<b>,<a>   (it opened on b)
 *   #/watch/<a>/vs/<b>/pov/main  -> /watch?ids=<a>,<b>
 *   #/watch/<a>/eyes/<notice>    -> /watch?ids=<a>&notice=<notice>
 */
const legacyUrl = () => {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash.startsWith("watch")) return null;
  const [, reference, keyword, other, , which] = hash.split("/");
  if (!reference) return "/";
  if (keyword === "vs" && other) {
    // An old comparison opened on the rival unless the url said otherwise, and the
    // run being watched is the first id now.
    return watchUrl(which === "main" ? [reference, other] : [other, reference]);
  }
  if (keyword === "eyes") return watchUrl([reference], DEFAULT_VIEW, other);
  return watchUrl([reference]);
};

/**
 * What the current url is asking for.
 *
 * @returns { page, ids, dropped, view, notice } — `dropped` is how many ids were
 *          over the limit, and `ids` is empty when the link named none we could read.
 */
const readRoute = () => {
  const path = window.location.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams(window.location.search);

  if (path === "/docs") return { page: "docs", ids: [], dropped: 0 };
  if (path === "/wr") {
    // The feed's own id parameter: which record it is scrolled to.
    return { page: "wr", ids: [], dropped: 0, feedId: params.get("id") };
  }
  if (path !== "/watch") return { page: "browse", ids: [], dropped: 0 };

  const requested = params.get("view");
  const ids = parseRecordIds(params.get("ids") ?? "");
  return {
    page: "watch",
    ids: ids.slice(0, MAX_RUNS),
    dropped: Math.max(0, ids.length - MAX_RUNS),
    view: requested in VIEWS ? requested : DEFAULT_VIEW,
    notice: params.get("notice"),
  };
};

const navigate = (url, { replace = false } = {}) => {
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route();
};

// Looked up once. updateHud() runs on every rendered frame, so it must not go
// hunting through the document sixty times a second.
const browseRoot = el("browse");
const feedRoot = el("wr");
const watchRoot = el("watch");
const docsRoot = el("docs");
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
const watchViews = el("watch-views");
const controls = document.querySelector(".controls");
const mhudToggle = el("mhud-toggle");
const mhudCheck = el("mhud-check");

let player = null;
let scrubbing = false;
let activeId = null;
let activeRival = null;
let activeLaunchIntent = null;
// The camera the url is currently claiming, as a `view` name rather than the
// player's own. Kept so that changing camera can rewrite the link.
let activeView = DEFAULT_VIEW;
let activeRun = null;
let activeRivalRun = null;
let activeTrack = null;
let activeMeta = null;
let activeRivalMeta = null;
let insights = null;
let selectedPov = "main";
let statsOpen = false;
// Watches the frames of the run being played and counts a view once it has really
// been watched. One per loaded run.
let viewTicker = null;
// Set while a rival is loaded: the shared distance axis both runs are measured on.
let alignment = null;
// Clicking through runs faster than they load would otherwise leave two players
// rendering into the same canvas, so late arrivals are dropped.
let loadToken = 0;

/**
 * The view count for the run being watched.
 *
 * Shown even when it is zero: someone has to be the first person to watch a run, and
 * "0 views" is a true thing to say about it. Only an unknown count is hidden.
 */
const showWatchViews = (count) => {
  watchViews.textContent = viewsLabel(count);
  watchViews.hidden = false;
};

const setStatsOpen = (open) => {
  statsOpen = open;
  statsPanel.classList.toggle("is-collapsed", !open);
  statsToggle.setAttribute("aria-expanded", String(open));
  statsToggle.setAttribute("aria-label", open ? "Close stats" : "Open stats");
  statsToggle.textContent = open ? "Close stats" : "Stats";
};

// --- the movement hud --------------------------------------------------------

const mhud = createMhud({ root: el("mhud") });

// The HUD sits above the controls, and the controls are one row on a desktop and
// two on a phone. What it needs is how much room the bar takes off the bottom of
// the screen, which is its own offset plus its height, so measuring the gap up to
// its top edge covers both in one number and needs no per-breakpoint arithmetic.
// The bar is anchored to the bottom, so this survives a change of window height
// and only has to be redone when the bar itself resizes.
new ResizeObserver(() => {
  const space = window.innerHeight - controls.getBoundingClientRect().top;
  watchRoot.style.setProperty("--controls-space", `${Math.round(space)}px`);
}).observe(controls);

const storedMhudPreference = localStorage.getItem("kz.mhud");
// On by default: it is what a KZ player expects to be looking at. Once someone
// uses the toggle, keep that choice between runs and visits.
let mhudOn = storedMhudPreference !== "off";

const setMhud = (on) => {
  mhudOn = Boolean(on);
  localStorage.setItem("kz.mhud", mhudOn ? "on" : "off");
  mhudToggle.setAttribute("aria-pressed", String(mhudOn));
  mhudCheck.checked = mhudOn;
  mhud.setVisible(mhudOn);
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
    fetchOk(`/tracks/${recordId}.kztrack`).then((response) =>
      response.arrayBuffer(),
    ),
    fetchOk(`/tracks/${recordId}.json`).then((response) => response.json()),
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
 * Marks on the timeline, one per highlighted section, so the stretches that decided
 * the run are visible and reachable without opening anything.
 *
 * A mark sits at the start of its section, which is a landing both runs made, so
 * clicking it drops you in just before the stretch plays out rather than in the
 * middle of it.
 */
const renderScrubMarks = (data, duration) => {
  scrubMarks.innerHTML = "";
  if (!data || !duration) return;

  for (const section of data.highlights) {
    const start =
      selectedPov === "rival" ? section.challengerTime : section.referenceTime;
    if (start > duration) continue;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = section.secondsLost > 0 ? "is-loss" : "is-gain";
    mark.style.left = `${(start / duration) * 100}%`;
    mark.title =
      `${start.toFixed(2)}s · ` +
      `${section.secondsLost > 0 ? "lost" : "gained"} ` +
      `${Math.abs(section.secondsLost).toFixed(3)}s here · ${section.blame}`;
    mark.addEventListener("click", () => jumpTo(Math.max(0, start - 0.6)));
    scrubMarks.append(mark);
  }
};

/**
 * Write a readout only when it says something new.
 *
 * updateHud() runs on every rendered frame, up to a hundred and twenty times a
 * second, and putting the same string back into a text node still makes the browser
 * redo layout for it. Most of these readouts are two decimal places of a number that
 * changes far more slowly than that.
 */
const shownText = new WeakMap();
const setText = (node, value) => {
  if (shownText.get(node) === value) return;
  shownText.set(node, value);
  node.textContent = value;
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
  setText(
    statDelta,
    (viewingRival ? frame.rivalFinished : frame.referenceFinished)
      ? formatDelta(alignment.finalDelta)
      : formatDelta(delta),
  );
  setText(statGap, frame.gapToRival === null ? "—" : `${frame.gapToRival} u`);
  analysisPanel.setPlayheadDistance(distance);
};

const updateHud = (frame) => {
  // The stats panel is collapsed most of the time. Nothing needs writing into a
  // panel nobody can see, and the next frame fills it in the moment it opens.
  if (statsOpen) {
    setText(statTime, `${frame.time.toFixed(2)}s`);
    setText(statSpeed, `${frame.speed} u/s`);
    setText(statTeleports, `${frame.teleports} / ${frame.totalTeleports}`);
  }

  setText(elapsed, frame.time.toFixed(2));
  const scrubValue = String(Math.round(frame.progress * 1000));
  if (!scrubbing && scrub.value !== scrubValue) {
    scrub.value = scrubValue;
  }

  mhud.update(frame);
  updateCompareReadout(frame);
  viewTicker?.frame(frame);
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
  const file = await findMapFile(`/maps/${meta.map}.glb`);
  if (!file) {
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

  mapStatus.textContent = `loading ${file.megabytes.toFixed(1)} MB…`;
  try {
    const { triangles } = await player.loadMap(file.url);
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

  if (persist) rewriteUrl();
  return selected;
};

/**
 * Put the current view back into the address bar, without adding history.
 *
 * The run being watched is the first id, so switching POV swaps the pair over
 * rather than needing a parameter of its own. Replace, not push: flicking between
 * cameras should not fill the back button with steps.
 */
const rewriteUrl = () => {
  if (!activeId) return;
  const ids =
    selectedPov === "rival" && activeRival
      ? [activeRival, activeId]
      : [activeId, activeRival].filter(Boolean);
  history.replaceState(null, "", watchUrl(ids, activeView));
};

/** Point both the player and the url at a camera. */
const applyView = (name, { persist = true } = {}) => {
  const view = name in VIEWS ? name : DEFAULT_VIEW;
  activeView = view;
  const mode = player?.setCameraMode(VIEWS[view]) ?? VIEWS[view];
  setActiveButton(cameras, "camera", mode);
  if (persist) rewriteUrl();
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

/**
 * Show the runs a link asked for.
 *
 * The first id is the run being watched; a second is the one it is measured
 * against. Nothing else is positional, so a link is easy to write by hand.
 */
const openRun = async (
  ids,
  { view = DEFAULT_VIEW, notice = null, dropped = 0 } = {},
) => {
  const [recordId, rivalId = null] = ids;
  const launchIntent = `${notice ?? ""}:${dropped}`;
  if (
    recordId === activeId &&
    rivalId === activeRival &&
    launchIntent === activeLaunchIntent
  ) {
    // Same runs, so only the camera can have changed.
    if (view !== activeView) applyView(view, { persist: false });
    return;
  }
  setStatsOpen(false);
  const token = ++loadToken;
  viewTicker?.stop();
  viewTicker = null;
  watchViews.hidden = true;
  loading.classList.remove("is-hidden");
  loading.textContent = "loading run…";
  compareError.hidden = true;
  compareError.textContent = "";
  watchCompareError.textContent = "";
  watchCompareInput.value = "";
  const noticeText = dropped
    ? `This link named ${dropped + MAX_RUNS} runs. Only ${MAX_RUNS} can be shown at once, so the rest were left out.`
    : notice === "current-wr"
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

    // The count is for the run the link opened, which is the one the timeline and the
    // clock belong to as well.
    fetchViews([recordId]).then(({ views }) => {
      if (token === loadToken) showWatchViews(views[recordId] ?? 0);
    });
    viewTicker = createViewTicker({
      recordId,
      duration: run.meta.reportedTime ?? run.track.durationSeconds,
      onCounted: (count) => {
        if (token === loadToken) showWatchViews(count);
      },
    });

    showPlaying(true);
    setActiveButton(rates, "rate", "1");
    // Replays are meant to be watched through the runner's eyes, so a link that says
    // nothing about the camera gets first person. Orbit and Follow stay available
    // from the controls and from ?view=.
    applyView(view, { persist: false });
    loadMapFor(run.meta, token);
    loading.classList.add("is-hidden");

    if (rivalId) {
      loading.classList.remove("is-hidden");
      loading.textContent = "loading the run to compare against…";
      try {
        // The first id is the run being watched, which is this one, not the rival.
        await loadRival(rivalId, token, "main");
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
  viewTicker?.stop();
  viewTicker = null;
  watchViews.hidden = true;
  activeId = null;
  activeRival = null;
  activeLaunchIntent = null;
  watchNotice.hidden = true;
  clearRival();
  analysisPanel.close();
};

// --- controls ---------------------------------------------------------------

backButton.addEventListener("click", () => {
  navigate("/");
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
  applyView(VIEW_NAMES[camera] ?? DEFAULT_VIEW);
});

mhudToggle.addEventListener("click", () => setMhud(!mhudOn));
mhudCheck.addEventListener("change", () => setMhud(mhudCheck.checked));

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
  navigate(watchUrl([activeId, ids[0]], activeView));
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
    const order = Object.keys(VIEWS);
    applyView(order[(order.indexOf(activeView) + 1) % order.length]);
  } else if (event.key.toLowerCase() === "m") {
    setMhud(!mhudOn);
  }
});

// --- routing ----------------------------------------------------------------

const browse = createBrowse({
  root: browseRoot,
  onWatch: ({ recordId, rivalId, notice = null }) =>
    navigate(
      watchUrl(
        // The run you clicked is the one you watch, so it goes first.
        [recordId, rivalId].filter(Boolean),
        DEFAULT_VIEW,
        rivalId ? null : notice,
      ),
    ),
  onFeed: () => navigate("/wr"),
});

const feed = createWrFeed({
  root: feedRoot,
  // The feed shares the run cache with the player, so opening the run you were just
  // watching in the feed costs nothing: the replay is already parsed.
  getRun,
  onOpenInPlayer: ({ recordId, view }) => navigate(watchUrl([recordId], view)),
  onBack: () => navigate("/"),
});

const route = () => {
  // An old hash link is turned into the current shape and re-routed, so nothing
  // below has to know the old format existed.
  const legacy = legacyUrl();
  if (legacy) {
    navigate(legacy, { replace: true });
    return;
  }

  const { page, ids, view, notice, dropped, feedId } = readRoute();

  if (page === "wr") {
    docsRoot.hidden = true;
    watchRoot.hidden = true;
    leaveWatch();
    browse.hide();
    feed.show(feedId);
    return;
  }
  feed.hide();

  if (page === "watch") {
    docsRoot.hidden = true;
    browse.hide();
    watchRoot.hidden = false;
    if (ids.length) {
      openRun(ids, { view, notice, dropped });
      return;
    }
    // A /watch link naming nothing we could read. Whoever built it needs to hear
    // that, not be dropped on the map list as if they had asked for nothing.
    leaveWatch();
    loading.classList.remove("is-hidden");
    loading.textContent =
      "This link has no readable replay id. It should look like /watch?ids=<record id> — see /docs.";
    return;
  }

  watchRoot.hidden = true;
  leaveWatch();
  docsRoot.hidden = page !== "docs";
  if (page === "docs") {
    browse.hide();
    return;
  }
  browse.show();
};

// pushState does not fire an event, so navigate() calls route() itself. These two
// cover the back button and any old link that still arrives as a hash.
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

setMhud(mhudOn);
// Both lists are static files, so they load together and neither waits for the other.
await Promise.all([browse.load(), feed.load()]);
route();
