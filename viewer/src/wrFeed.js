// The WR feed: the newest world records, one screen each, scrolled like a phone.
//
// The idea is that watching KZ should not start with a decision. The browse page asks
// you to pick a map, a course and a mode before anything moves; this page asks for
// nothing and plays the most recent record in the game, then the one before it.
//
// How it is built, and why it is not sixty players:
//
//   * One canvas, one player. A three.js renderer per slide would mean sixty WebGL
//     contexts, which no browser allows and no phone would survive. The canvas sits
//     under the slides and the slide that is on screen is the one being drawn.
//   * Each slide covers the canvas with the map's Steam picture until it is the slide
//     being played. That is what makes one canvas look like sixty: the picture hides
//     the run belonging to the previous slide while you scroll past it, and fades out
//     when this slide's run is ready.
//   * Loading is debounced. Flicking through ten records must download one run, not
//     ten, so nothing starts until the scroll has settled on something.
//   * The run after the current one is fetched in the background while you watch, so
//     the next swipe usually has nothing to wait for.
//
// There are no controls. No camera picker, no pause, no scrubber: a feed is for
// watching one record after another, and everything you might want to do to a
// single run already exists on the watch page, one button away. Runs play through
// the runner's eyes, which is the camera a replay is meant to be seen in.
//
// The replay itself is a few hundred kilobytes and the map geometry a couple of
// megabytes, both cached by the browser, so a scroll back up costs nothing.

import { LEADERBOARDS } from "../../src/leaderboards.js";
import { escapeHtml, formatRunTime, tierLabel, tierStyle } from "./format.js";
import { createViewTicker, fetchViews, viewsLabel } from "./views.js";
import { findMapFile } from "./mapFile.js";
import { createMhud } from "./mhud.js";
import { createPlayer } from "./player.js";

/** The camera every run in the feed is watched in, as a /watch `view` name. */
const FEED_VIEW = "pov";

/**
 * What to call a record's leaderboard.
 *
 * Looked up by id even though wrs.json carries a label of its own, because that label
 * is display text: it used to read "Classic · no teleports" and now reads "Classic
 * PRO", and a data file written before the change must not keep the old wording on
 * screen until the next nightly run. The stored label is the fallback for a board id
 * this build has never heard of.
 */
const boardLabel = (record) =>
  LEADERBOARDS.find((board) => board.id === record.board)?.label ??
  record.boardLabel ??
  record.board;

/** Wait for the scroll to settle before downloading anything. */
const SETTLE_MS = 220;

/** The map cards' tier colours, turned up for a chip sitting on a full screen photo. */
const SLIDE_TIER_COLOURS = { fill: 0.2, text: 74, edge: 0.4 };

/**
 * "3 days ago", for a date that is the point of the page.
 *
 * Deliberately vague past a week and exact below a day: "set 40 minutes ago" is the
 * interesting fact about a fresh record, and "set on 12 June" is the interesting fact
 * about an old one. Nobody wants "set 37 days ago".
 */
const relativeTime = (isoDate) => {
  if (!isoDate) return "";
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year:
      then.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
};

export const createWrFeed = ({ root, getRun, onOpenInPlayer, onBack }) => {
  let records = [];
  let visible = false;
  let activeIndex = -1;
  /** Which record the player currently holds, so a re-entry does not reload it. */
  let playingId = null;
  let player = null;
  let ticker = null;
  let settleTimer = null;
  // Same trick the watch page uses: scrolling faster than runs load would otherwise
  // let a late arrival draw over a newer one.
  let loadToken = 0;

  /** index -> the parts of a slide that get written to while it plays. */
  const slides = new Map();

  root.innerHTML = `
    <canvas class="reel__stage" id="reel-stage"></canvas>
    <header class="reel__head">
      <button class="button button--small button--ghost" id="reel-back" type="button">← All maps</button>
      <div class="reel__heading">
        <div class="reel__title">Latest world records</div>
        <div class="reel__subtitle" id="reel-subtitle">loading…</div>
      </div>
    </header>
    <div class="reel__scroll" id="reel-scroll"></div>
    <div class="mhud" id="reel-mhud" hidden></div>`;

  const dom = {
    canvas: root.querySelector("#reel-stage"),
    back: root.querySelector("#reel-back"),
    subtitle: root.querySelector("#reel-subtitle"),
    scroll: root.querySelector("#reel-scroll"),
  };

  // The feed has no toggle for it: a HUD is part of watching a KZ run, so it is
  // simply on whenever a run is playing.
  const mhud = createMhud({ root: root.querySelector("#reel-mhud") });

  // --- markup ---------------------------------------------------------------

  const slideHtml = (record, index) => `
    <article class="slide" data-index="${index}" data-record="${escapeHtml(record.recordId)}">
      <div class="slide__poster" data-poster>
        ${
          record.image
            ? `<img src="${escapeHtml(record.image)}" alt="" loading="lazy" decoding="async" />`
            : ""
        }
      </div>
      <div class="slide__body">
        <div class="slide__badges">
          <span class="chip chip--wr">World record</span>
          <span class="chip">${escapeHtml(boardLabel(record))}</span>
          ${
            record.tier
              ? `<span class="chip" style="${tierStyle(record.tier, SLIDE_TIER_COLOURS)}">${escapeHtml(tierLabel(record.tier))}</span>`
              : ""
          }
        </div>
        <div class="slide__time">${formatRunTime(record.time)}</div>
        <div class="slide__who">${escapeHtml(record.player ?? "unknown")}</div>
        <div class="slide__where">${escapeHtml(record.map ?? "")} · ${escapeHtml(record.course ?? "")}</div>
        <div class="slide__meta">
          <span data-views title="Counted once per browser, after the run has played for a few seconds">— views</span>
          <span>${escapeHtml(relativeTime(record.setAt))}</span>
          ${record.teleports ? `<span>${record.teleports} teleports</span>` : ""}
          <span class="slide__status" data-status></span>
        </div>
        <div class="slide__actions">
          <button class="button button--primary" type="button" data-open>Open in player</button>
        </div>
      </div>
      <div class="slide__progress"><i data-bar></i></div>
    </article>`;

  const collectSlide = (element) => {
    const index = Number(element.dataset.index);
    slides.set(index, {
      element,
      poster: element.querySelector("[data-poster]"),
      status: element.querySelector("[data-status]"),
      views: element.querySelector("[data-views]"),
      bar: element.querySelector("[data-bar]"),
    });
  };

  const setStatus = (index, text) => {
    const slide = slides.get(index);
    if (slide) slide.status.textContent = text;
  };

  /** Reveal the canvas for one slide and hide it for every other. */
  const showStageOn = (index) => {
    for (const [other, slide] of slides) {
      slide.element.classList.toggle("is-playing", other === index);
    }
  };

  // --- views ----------------------------------------------------------------

  const showViews = (index, count) => {
    const slide = slides.get(index);
    if (slide) slide.views.textContent = viewsLabel(count);
  };

  const loadViewCounts = async () => {
    const { views } = await fetchViews(
      records.map((record) => record.recordId),
    );
    records.forEach((record, index) => {
      showViews(index, views[record.recordId] ?? 0);
    });
  };

  // --- playing the active slide ---------------------------------------------

  const stopPlayer = () => {
    ticker?.stop();
    ticker = null;
    player?.dispose();
    player = null;
    playingId = null;
    mhud.setVisible(false);
    showStageOn(-1);
  };

  const loadMapFor = async (record, index, token) => {
    if (!record.map) return;
    setStatus(index, "checking the map…");
    const file = await findMapFile(`/maps/${record.map}.glb`);
    if (token !== loadToken) return;
    if (!file) {
      setStatus(index, "no 3D map yet — playing over a grid");
      return;
    }

    setStatus(index, `loading the map, ${file.megabytes.toFixed(1)} MB…`);
    try {
      await player.loadMap(file.url);
      if (token !== loadToken) return;
      player.setMapVisible(true);
      setStatus(index, "");
    } catch (error) {
      if (token === loadToken) setStatus(index, `map failed: ${error.message}`);
    }
  };

  /** Quietly warm the next run's replay, so the next swipe has nothing to wait for. */
  const prefetchNext = (index) => {
    const next = records[index + 1];
    if (next) getRun(next.recordId).catch(() => {});
  };

  const playSlide = async (index) => {
    const record = records[index];
    if (!record) return;
    if (record.recordId === playingId) {
      showStageOn(index);
      return;
    }

    const token = ++loadToken;
    stopPlayer();
    setStatus(index, "loading the replay…");

    let run;
    try {
      run = await getRun(record.recordId);
    } catch (error) {
      if (token === loadToken) {
        // Replays are deleted about a day after a record unless it is a world
        // record — but the record can also have been beaten since the nightly job
        // wrote this list, and then its file is on the way out.
        setStatus(index, `this replay is gone: ${error.message}`);
      }
      return;
    }
    if (token !== loadToken || !visible) return;

    player = createPlayer({
      canvas: dom.canvas,
      track: run.track,
      onFrame: (frame) => {
        const slide = slides.get(index);
        if (!slide) return;
        slide.bar.style.transform = `scaleX(${frame.progress})`;
        mhud.update(frame);
        ticker?.frame(frame);
      },
    });
    player.setCameraMode("first-person");
    player.play();
    // Same escape hatch the watch page has: the feed draws map geometry too, so the
    // alignment checks have to be reachable from here as well.
    if (import.meta.env.DEV) window.__kzReelPlayer = player;
    playingId = record.recordId;
    mhud.setVisible(true);
    showStageOn(index);
    setStatus(index, "");

    ticker = createViewTicker({
      recordId: record.recordId,
      duration: run.meta.reportedTime ?? run.track.durationSeconds,
      onCounted: (count) => showViews(index, count),
    });

    loadMapFor(record, index, token);
    prefetchNext(index);
  };

  /**
   * A slide became the one on screen.
   *
   * The url follows, so the address bar always names the record you are looking at
   * and a reload lands on it. Replace, not push: a scroll should not fill the back
   * button with sixty steps.
   */
  const setActive = (index, { settle = true } = {}) => {
    if (index === activeIndex) return;
    activeIndex = index;
    const record = records[index];
    if (record) {
      history.replaceState(null, "", `/wr?id=${record.recordId}`);
    }

    clearTimeout(settleTimer);
    if (!settle) {
      playSlide(index);
      return;
    }
    settleTimer = setTimeout(() => {
      if (visible && activeIndex === index) playSlide(index);
    }, SETTLE_MS);
  };

  // --- events ---------------------------------------------------------------

  // A slide is only "on screen" once most of it is, which with full height slides and
  // scroll snapping means exactly one at a time.
  const observer = new IntersectionObserver(
    (entries) => {
      if (!visible) return;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setActive(Number(entry.target.dataset.index));
        }
      }
    },
    { root: dom.scroll, threshold: 0.6 },
  );

  dom.back.addEventListener("click", () => onBack?.());

  // One listener for sixty cards rather than one each.
  dom.scroll.addEventListener("click", (event) => {
    if (!event.target.closest("[data-open]")) return;
    const record = records[activeIndex];
    if (record)
      onOpenInPlayer?.({ recordId: record.recordId, view: FEED_VIEW });
  });

  const scrollToIndex = (index) => {
    const slide = slides.get(index);
    if (!slide) return;
    slide.element.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Moving between records, and opening one. Nothing that changes how a run plays:
  // that is the watch page's job.
  window.addEventListener("keydown", (event) => {
    if (!visible) return;
    if (event.target.matches("textarea, input, select")) return;
    if (event.code === "ArrowDown" || event.key.toLowerCase() === "j") {
      event.preventDefault();
      scrollToIndex(activeIndex + 1);
    } else if (event.code === "ArrowUp" || event.key.toLowerCase() === "k") {
      event.preventDefault();
      scrollToIndex(Math.max(0, activeIndex - 1));
    } else if (event.key === "Enter") {
      const record = records[activeIndex];
      if (record) {
        onOpenInPlayer?.({ recordId: record.recordId, view: FEED_VIEW });
      }
    }
  });

  // --- the module -----------------------------------------------------------

  return {
    async load() {
      const feed = await fetch("/data/wrs.json")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      records = (feed?.records ?? []).filter((record) => record.recordId);

      // A visitor is told what is happening in their own terms. What to type to fix
      // it is a note to whoever is running the thing, so it is only shown on a dev
      // server — a page on the internet must never read like a terminal prompt.
      if (records.length === 0) {
        dom.subtitle.textContent = "nothing to show yet";
        dom.scroll.innerHTML = `
          <div class="reel__empty">
            <p>No world records to show just yet.</p>
            <p>The list is rebuilt every night and again whenever the site is
            updated, so this should fill itself in shortly.</p>
            ${
              import.meta.env.DEV
                ? '<p class="hint">Dev: <code>node bin/kzreplay.js wrfeed</code></p>'
                : ""
            }
          </div>`;
        return;
      }

      dom.subtitle.textContent = `${records.length} runs · scroll for the next one`;
      dom.scroll.innerHTML = records.map(slideHtml).join("");
      slides.clear();
      for (const element of dom.scroll.querySelectorAll(".slide")) {
        collectSlide(element);
        observer.observe(element);
      }
      loadViewCounts();
    },

    /**
     * Show the feed, starting at a record if the link named one.
     *
     * @param recordId from /wr?id=… — a link someone shared while scrolling
     */
    show(recordId = null) {
      root.hidden = false;
      visible = true;
      const wanted = records.findIndex(
        (record) => record.recordId === recordId,
      );
      if (wanted >= 0) {
        // Jumped to instantly, with no smooth scroll: this is where the page opens,
        // not somewhere it travels to.
        slides.get(wanted)?.element.scrollIntoView({ block: "start" });
        activeIndex = wanted;
        playSlide(wanted);
        return;
      }
      // Coming back to the feed resumes where it was left, which is what the scroll
      // position already is. Only a first visit needs starting off.
      if (activeIndex < 0 && records.length) {
        setActive(0, { settle: false });
      } else if (activeIndex >= 0) {
        playSlide(activeIndex);
      }
    },

    hide() {
      visible = false;
      root.hidden = true;
      clearTimeout(settleTimer);
      // The renderer, the loaded map and the animation loop all go: a feed nobody is
      // looking at must not keep a GPU busy.
      loadToken += 1;
      stopPlayer();
    },
  };
};
