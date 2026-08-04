// The minigame: five rounds of "which map is this?", played over one clipped
// chunk of geometry at a time. It owns its own canvas and three.js scene the
// same way the WR feed owns its player — a game and a video feed are both a
// single view that needs a render loop, and nothing here has to share one
// with the rest of the app.

import { createGuessrScene } from "./guessrScene.js";
import { escapeHtml, formatRunTime } from "./format.js";

/** Rounds per game. Fewer only when the manifest itself has fewer chunks. */
const ROUNDS_PER_GAME = 5;

// --- scoring ------------------------------------------------------------

/** Correct map, correct course (only counted with the map right), and speed. */
const SCORE = { map: 100, course: 50, fast: 25, ok: 10 };
const FAST_SECONDS = 30;
const OK_SECONDS = 60;

const scoreRound = ({ mapCorrect, courseCorrect, elapsedSeconds }) => {
  if (!mapCorrect) return 0;
  let points = SCORE.map;
  if (courseCorrect) points += SCORE.course;
  if (elapsedSeconds < FAST_SECONDS) points += SCORE.fast;
  else if (elapsedSeconds <= OK_SECONDS) points += SCORE.ok;
  return points;
};

// --- seeded shuffle -------------------------------------------------------

/** mulberry32: a tiny, deterministic PRNG — good enough to shuffle five
 * rounds and small enough to not need a dependency for it. */
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = (items, rng) => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
};

export const createGuessr = ({ root, maps, onExit }) => {
  let manifest = { rounds: [] };
  let scene = null;

  // One game in progress.
  let activeSeed = null;
  let order = [];
  let roundIndex = 0;
  let results = [];

  // The round currently on screen.
  let chunk = null;
  let roundStart = 0;
  let pickedMap = null;

  const mapByName = (name) => maps.find((map) => map.name === name) ?? null;

  // --- markup ---------------------------------------------------------------

  root.innerHTML = `
    <canvas class="guessr__stage" id="guessr-stage"></canvas>

    <header class="guessr__head">
      <button class="button button--small button--ghost" id="guessr-exit" type="button">← All maps</button>
      <div class="guessr__round" id="guessr-round"></div>
    </header>

    <div class="guessr__empty panel" id="guessr-empty" hidden>
      No rounds built yet. Run <code>npm run guessr</code>.
    </div>

    <section class="guessr__panel panel" id="guessr-guess" hidden>
      <div class="field__label">Which map is this?</div>
      <input class="input" id="guessr-filter" placeholder="type a map name" spellcheck="false" autocomplete="off" />
      <div class="guessr__matches" id="guessr-matches"></div>
      <label class="field" id="guessr-course-field" hidden>
        <span class="field__label">Course</span>
        <select class="select" id="guessr-course"></select>
      </label>
      <button class="button button--primary button--wide" id="guessr-submit" type="button" disabled>
        Submit guess
      </button>
    </section>

    <section class="guessr__panel panel" id="guessr-reveal" hidden>
      <div class="guessr__verdict" id="guessr-verdict"></div>
      <div class="guessr__truth">
        <img class="guessr__thumb" id="guessr-thumb" alt="" />
        <div>
          <div class="guessr__truth-map" id="guessr-truth-map"></div>
          <div class="guessr__truth-who" id="guessr-truth-who"></div>
        </div>
      </div>
      <div class="guessr__points" id="guessr-points"></div>
      <a class="button" id="guessr-watch" target="_blank" rel="noopener">Watch this run</a>
      <button class="button button--primary button--wide" id="guessr-next" type="button"></button>
    </section>

    <section class="guessr__panel panel" id="guessr-summary" hidden>
      <div class="guessr__total" id="guessr-total"></div>
      <div class="guessr__breakdown" id="guessr-breakdown"></div>
      <button class="button button--primary button--wide" id="guessr-again" type="button">Play again</button>
    </section>`;

  const dom = {
    round: root.querySelector("#guessr-round"),
    empty: root.querySelector("#guessr-empty"),
    canvas: root.querySelector("#guessr-stage"),
    exit: root.querySelector("#guessr-exit"),
    guessPanel: root.querySelector("#guessr-guess"),
    filter: root.querySelector("#guessr-filter"),
    matches: root.querySelector("#guessr-matches"),
    courseField: root.querySelector("#guessr-course-field"),
    course: root.querySelector("#guessr-course"),
    submit: root.querySelector("#guessr-submit"),
    revealPanel: root.querySelector("#guessr-reveal"),
    verdict: root.querySelector("#guessr-verdict"),
    thumb: root.querySelector("#guessr-thumb"),
    truthMap: root.querySelector("#guessr-truth-map"),
    truthWho: root.querySelector("#guessr-truth-who"),
    points: root.querySelector("#guessr-points"),
    watch: root.querySelector("#guessr-watch"),
    next: root.querySelector("#guessr-next"),
    summaryPanel: root.querySelector("#guessr-summary"),
    total: root.querySelector("#guessr-total"),
    breakdown: root.querySelector("#guessr-breakdown"),
    again: root.querySelector("#guessr-again"),
  };

  const showPanel = (which) => {
    dom.guessPanel.hidden = which !== "guess";
    dom.revealPanel.hidden = which !== "reveal";
    dom.summaryPanel.hidden = which !== "summary";
  };

  // --- the guess panel --------------------------------------------------

  const renderMatches = () => {
    const needle = dom.filter.value.trim().toLowerCase();
    const matches = needle
      ? maps.filter((map) => map.name.toLowerCase().includes(needle))
      : [];
    dom.matches.innerHTML = matches
      .slice(0, 8)
      .map(
        (map) =>
          `<button class="guessr__match" type="button" data-map="${escapeHtml(map.name)}">${escapeHtml(map.name)}</button>`,
      )
      .join("");
  };

  const renderCourses = () => {
    const map = mapByName(pickedMap);
    dom.courseField.hidden = !map;
    if (!map) return;
    dom.course.innerHTML = map.courses
      .map(
        (course) =>
          `<option value="${escapeHtml(course.name)}">${escapeHtml(course.name)}</option>`,
      )
      .join("");
  };

  const pickMap = (name) => {
    pickedMap = name;
    dom.filter.value = name;
    dom.matches.innerHTML = "";
    renderCourses();
    dom.submit.disabled = false;
  };

  const resetGuessPanel = () => {
    pickedMap = null;
    dom.filter.value = "";
    dom.matches.innerHTML = "";
    dom.courseField.hidden = true;
    dom.submit.disabled = true;
  };

  // --- rounds -------------------------------------------------------------

  const setRoundHud = () => {
    dom.round.textContent = `Round ${roundIndex + 1} / ${order.length}`;
  };

  const loadRound = async () => {
    setRoundHud();
    showPanel("guess");
    resetGuessPanel();

    scene ??= createGuessrScene({ canvas: dom.canvas });
    chunk = await fetchJson(order[roundIndex].file);
    scene.setChunk({ positions: chunk.positions, size: chunk.size });
    roundStart = performance.now();
  };

  const submitGuess = () => {
    if (!pickedMap) return;
    const elapsedSeconds = (performance.now() - roundStart) / 1000;
    const guessCourse = dom.course.value;
    const truth = chunk.answer;
    const mapCorrect = pickedMap === truth.map;
    const courseCorrect = mapCorrect && guessCourse === truth.course;
    const points = scoreRound({ mapCorrect, courseCorrect, elapsedSeconds });

    results.push({
      guessMap: pickedMap,
      guessCourse,
      truthMap: truth.map,
      truthCourse: truth.course,
      mapCorrect,
      points,
    });

    // The payoff shot: the route is only revealed once a guess is locked in,
    // never before, so seeing it can't be part of how someone guesses.
    scene.showRoute(chunk.route);
    renderReveal({ mapCorrect, points, truth });
  };

  const renderReveal = ({ mapCorrect, points, truth }) => {
    const map = mapByName(truth.map);
    dom.verdict.textContent = mapCorrect ? "Correct map!" : "Wrong map";
    dom.verdict.className = `guessr__verdict ${mapCorrect ? "good" : "bad"}`;
    dom.thumb.src = map?.image ?? "";
    dom.thumb.hidden = !map?.image;
    dom.truthMap.textContent = `${truth.map} · ${truth.course}`;
    dom.truthWho.textContent = `${truth.player ?? "unknown"} · ${formatRunTime(truth.time ?? 0)}`;
    dom.points.textContent = `+${points} points`;
    dom.watch.href = `/watch?ids=${encodeURIComponent(truth.recordId)}&view=pov`;
    dom.watch.hidden = !truth.recordId;
    dom.next.textContent =
      roundIndex + 1 < order.length ? "Next round" : "See results";
    showPanel("reveal");
  };

  const renderSummary = () => {
    const total = results.reduce((sum, result) => sum + result.points, 0);
    dom.total.textContent = `${total} points`;
    dom.breakdown.innerHTML = results
      .map((result, index) => {
        const guessed = result.mapCorrect
          ? `${escapeHtml(result.guessMap)} · ${escapeHtml(result.guessCourse)}`
          : `${escapeHtml(result.guessMap)} (was ${escapeHtml(result.truthMap)})`;
        return `
          <div class="guessr__row">
            <span>Round ${index + 1}</span>
            <span>${guessed}</span>
            <span>${result.points} pts</span>
          </div>`;
      })
      .join("");
    showPanel("summary");
  };

  const nextRound = () => {
    roundIndex += 1;
    if (roundIndex < order.length) loadRound();
    else renderSummary();
  };

  // --- starting and restarting a game --------------------------------------

  /** The seed is the whole state of a game, so a link to it has to carry it. */
  const writeSeedToUrl = (seed) => {
    const url = new URL(window.location.href);
    url.searchParams.set("seed", String(seed));
    history.replaceState(
      null,
      "",
      `${url.pathname}?${url.searchParams.toString()}`,
    );
  };

  const startGame = (seed) => {
    activeSeed = seed;
    writeSeedToUrl(seed);
    const count = Math.min(ROUNDS_PER_GAME, manifest.rounds.length);
    order = shuffled(manifest.rounds, mulberry32(seed)).slice(0, count);
    roundIndex = 0;
    results = [];
    loadRound();
  };

  // --- events ---------------------------------------------------------------

  dom.exit.addEventListener("click", () => onExit?.());
  dom.filter.addEventListener("input", renderMatches);
  dom.filter.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !dom.submit.disabled) submitGuess();
  });
  dom.matches.addEventListener("click", (event) => {
    const name = event.target.closest("[data-map]")?.dataset.map;
    if (name) pickMap(name);
  });
  dom.submit.addEventListener("click", submitGuess);
  dom.next.addEventListener("click", nextRound);
  dom.again.addEventListener("click", () => startGame(Date.now() >>> 0));

  return {
    async load() {
      // Same stance as the map list and the WR feed: the manifest is written by
      // a build step (`npm run guessr`) and may simply not exist yet. A visitor
      // gets told plainly; the command to fix it is a dev-only note.
      try {
        manifest = await fetchJson("/data/guessr.json");
      } catch {
        manifest = { rounds: [] };
      }
      if (!manifest.rounds?.length) {
        dom.empty.hidden = false;
        dom.canvas.hidden = true;
        dom.round.hidden = true;
      }
    },

    show(seed = null) {
      root.hidden = false;
      if (!manifest.rounds?.length) return;

      const requested = seed != null ? Number(seed) : null;
      if (requested !== null && requested !== activeSeed) {
        startGame(requested);
      } else if (activeSeed === null) {
        startGame(Date.now() >>> 0);
      }
    },

    hide() {
      root.hidden = true;
    },
  };
};
