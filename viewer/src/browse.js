// The front page: every CS2KZ map, filter by name, pick a course and a mode, watch.
//
// It runs entirely off three files the nightly refresh writes, so opening the page
// costs three static requests and no API calls at all. That matters: working out the
// record for every leaderboard takes about 620 API requests, which is fine once a
// night and absurd once per visitor.
//
// The awkward truth this page has to tell honestly: the world record often has no
// replay file. Retention keeps world records, ranked top 10s and tier 8 runs and
// deletes the rest within a day, and "world record" is evaluated per leaderboard, so
// plenty of records are simply not watchable. When that happens the page offers the
// fastest run that IS watchable and says which rank it is, instead of showing a
// button that fails.

import { LEADERBOARDS, leaderboardKey } from "../../src/leaderboards.js";
import { loadRunById, parseRecordIds } from "./loadRun.js";
import { escapeHtml, formatRunTime, tierLabel, tierStyle } from "./format.js";
import { fetchViews, viewsLabel } from "./views.js";

const fetchJson = async (url, fallback) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    return fallback;
  }
};

export const createBrowse = ({ root, onWatch, onFeed, onPlay }) => {
  let maps = [];
  let entries = {};
  let geometry = {};
  let filter = "";
  let geometryOnly = false;
  let selected = null;
  let resolvingReplay = false;

  const dom = {};

  const boardsForCourse = (mapName, courseName) =>
    LEADERBOARDS.map((board) => ({
      board,
      entry: entries[leaderboardKey(mapName, courseName, board.id)] ?? null,
    }));

  /** Does any leaderboard on this map have a run at all? */
  const runCount = (map) =>
    map.courses.reduce(
      (total, course) =>
        total +
        boardsForCourse(map.name, course.name).filter(
          (option) => option.entry?.watchable,
        ).length,
      0,
    );

  const visibleMaps = () => {
    const needle = filter.trim().toLowerCase();
    return maps.filter((map) => {
      if (needle && !map.name.toLowerCase().includes(needle)) return false;
      if (geometryOnly && !geometry[map.name]) return false;
      return true;
    });
  };

  // --- the grid -------------------------------------------------------------

  const cardHtml = (map) => {
    // The first course is "Main" on essentially every map, and its classic tier is
    // the number players actually recognise a map by.
    const main = map.courses[0];
    const tier = main?.tiers?.classic?.pro ?? main?.tiers?.classic?.nub ?? null;
    const watchable = runCount(map);
    const glb = geometry[map.name];

    return `
      <button class="card-map" type="button" data-map="${escapeHtml(map.name)}">
        <div class="card-map__shot">
          ${
            map.image
              ? `<img src="${escapeHtml(map.image)}" alt="" loading="lazy" decoding="async" />`
              : '<div class="card-map__noshot">no picture</div>'
          }
          ${glb ? `<span class="badge badge--glb" title="3D geometry ready, ${glb.megabytes} MB">3D</span>` : ""}
        </div>
        <div class="card-map__body">
          <div class="card-map__name">${escapeHtml(map.name)}</div>
          <div class="card-map__meta">
            ${tier ? `<span class="chip" style="${tierStyle(tier)}">${escapeHtml(tierLabel(tier))}</span>` : ""}
            <span class="card-map__courses">${map.courses.length} course${map.courses.length === 1 ? "" : "s"}</span>
            <span class="card-map__runs ${watchable ? "" : "is-empty"}">${watchable ? `${watchable} to watch` : "no replays"}</span>
          </div>
          ${glb ? `<span class="card-map__play" role="button" data-play="${escapeHtml(map.name)}">▶ Play</span>` : ""}
        </div>
      </button>`;
  };

  const renderGrid = () => {
    const shown = visibleMaps();
    dom.count.textContent =
      shown.length === maps.length
        ? `${maps.length} maps`
        : `${shown.length} of ${maps.length} maps`;
    dom.grid.innerHTML =
      shown.length === 0
        ? '<div class="browse__empty">No map matches that name.</div>'
        : shown.map(cardHtml).join("");
  };

  // --- the map sheet --------------------------------------------------------

  const currentSelection = () => {
    const map = maps.find((candidate) => candidate.name === selected);
    if (!map) return null;
    const courseName = dom.course.value || map.courses[0]?.name;
    const board =
      LEADERBOARDS.find((option) => option.id === dom.mode.value) ??
      LEADERBOARDS[0];
    return {
      map,
      courseName,
      board,
      entry: entries[leaderboardKey(map.name, courseName, board.id)] ?? null,
    };
  };

  /**
   * How many people have watched the run this leaderboard offers.
   *
   * Fetched per selection rather than for the whole grid: the front page shows 82
   * maps and about 420 leaderboards, and nobody needs a count for a run they have not
   * looked at yet.
   */
  const renderViews = (recordId) => {
    dom.views.textContent = "";
    if (!recordId) return;
    fetchViews([recordId]).then(({ views }) => {
      // A different course or mode may have been picked while this was in flight.
      if (currentSelection()?.entry?.watchable?.id !== recordId) return;
      dom.views.textContent = `${viewsLabel(views[recordId] ?? 0)} of this replay`;
    });
  };

  /**
   * The record, and what can actually be watched.
   *
   * Three cases, and each of them has to read differently, because "the record has
   * no replay" is not the same message as "nobody has run this".
   */
  const renderResult = () => {
    const selection = currentSelection();
    if (!selection) return;
    const { entry } = selection;
    dom.watch.disabled = !entry?.watchable;
    dom.compareButton.disabled = !entry?.watchable;
    renderViews(entry?.watchable?.id ?? null);

    if (!entry) {
      dom.result.innerHTML =
        '<div class="sheet__empty">No run on this leaderboard yet.</div>';
      return;
    }

    const { record, watchable, watchableRank } = entry;
    const isRecord = watchable && watchable.id === record.id;

    dom.result.innerHTML = `
      <div class="record">
        <div class="record__label">World record</div>
        <div class="record__time">${formatRunTime(record.time)}</div>
        <div class="record__player">${escapeHtml(record.player ?? "unknown")}</div>
        ${record.teleports ? `<div class="record__extra">${record.teleports} teleports</div>` : ""}
      </div>
      ${
        isRecord
          ? '<div class="sheet__note good">The record has a replay. This is what you will watch.</div>'
          : watchable
            ? `<div class="sheet__note">The record has no replay stored, so this plays rank ${watchableRank}:
                 <strong>${escapeHtml(watchable.player ?? "unknown")} ${formatRunTime(watchable.time)}</strong>.</div>`
            : `<div class="sheet__note bad">None of the top ${Math.min(entry.total, 25)} runs still has a replay.
                 Replays are deleted after about a day unless the run is a record, a ranked top 10, or on a tier 8 course.</div>`
      }
      <div class="sheet__stat">${entry.total} run${entry.total === 1 ? "" : "s"} on this leaderboard</div>`;
  };

  const renderSheet = () => {
    const map = maps.find((candidate) => candidate.name === selected);
    if (!map) {
      dom.sheet.hidden = true;
      return;
    }

    const glb = geometry[map.name];
    dom.sheetShot.innerHTML = map.image
      ? `<img src="${escapeHtml(map.image)}" alt="" />`
      : "";
    dom.sheetName.textContent = map.name;
    dom.sheetBy.textContent = map.mappers.length
      ? `by ${map.mappers.join(", ")}`
      : "";
    dom.sheetGeometry.textContent = glb
      ? `3D geometry ready · ${glb.megabytes} MB`
      : "no 3D geometry yet — the run plays over a grid";
    dom.sheetGeometry.className = `sheet__geometry ${glb ? "good" : ""}`;

    dom.course.innerHTML = map.courses
      .map(
        (course) =>
          `<option value="${escapeHtml(course.name)}">${escapeHtml(course.name)}</option>`,
      )
      .join("");

    renderModeOptions();
    renderResult();
    dom.sheet.hidden = false;
  };

  /**
   * Mode options, each showing whether it has anything to watch.
   *
   * Vanilla leaderboards are often empty while classic is busy, and finding that out
   * by picking one and reading "no run yet" is a wasted click.
   */
  const renderModeOptions = () => {
    const map = maps.find((candidate) => candidate.name === selected);
    const courseName = dom.course.value || map?.courses[0]?.name;
    const previous = dom.mode.value;

    dom.mode.innerHTML = boardsForCourse(map.name, courseName)
      .map(
        ({ board, entry }) =>
          `<option value="${board.id}">${board.label}${
            entry?.watchable
              ? ` — ${formatRunTime(entry.watchable.time)}`
              : entry
                ? " — no replay"
                : " — empty"
          }</option>`,
      )
      .join("");

    // Keep the mode across course changes when it still has a run there; otherwise
    // land on the first one that does, so the sheet opens on something watchable.
    const options = boardsForCourse(map.name, courseName);
    const keep = options.find(
      (option) => option.board.id === previous && option.entry?.watchable,
    );
    const best = keep ?? options.find((option) => option.entry?.watchable);
    dom.mode.value = (best ?? options[0]).board.id;
  };

  const watch = (rivalId = null) => {
    const selection = currentSelection();
    if (!selection?.entry?.watchable) return;
    dom.sheet.hidden = true;
    onWatch({
      recordId: selection.entry.watchable.id,
      rivalId,
      map: selection.map.name,
      course: selection.courseName,
      board: selection.board.id,
    });
  };

  const compare = () => {
    const ids = parseRecordIds(dom.compareInput.value);
    if (ids.length !== 1) {
      dom.compareError.textContent =
        "That is not a record id. It looks like 019ee7e7-c989-7a82-aa78-abaa88813a2f.";
      return;
    }
    dom.compareError.textContent = "";
    watch(ids[0]);
  };

  /**
   * Resolve a pasted replay to its catalog leaderboard, without making the user
   * already know its map, course or mode.
   */
  const resolveReplay = async () => {
    if (resolvingReplay) return;

    const ids = parseRecordIds(dom.replayInput.value);
    if (ids.length !== 1) {
      dom.replayError.textContent =
        ids.length > 1
          ? "Paste one replay ID at a time."
          : "Enter a replay ID, for example 019ee7e7-c989-7a82-aa78-abaa88813a2f.";
      return;
    }

    resolvingReplay = true;
    dom.replayError.textContent = "";
    dom.replayButton.disabled = true;
    dom.replayButton.textContent = "Finding run…";

    try {
      const pastedId = ids[0];
      const run = await loadRunById(pastedId);
      const mode = String(run.meta.mode ?? "").toLowerCase();
      const hasTeleports = run.meta.teleports > 0;
      const board = LEADERBOARDS.find(
        (option) =>
          option.mode === mode && option.hasTeleports === hasTeleports,
      );

      const entry = board
        ? entries[leaderboardKey(run.meta.map, run.meta.course, board.id)]
        : null;
      const pastedIsWr = entry?.record?.id?.toLowerCase() === pastedId;
      const exactWrIsWatchable =
        entry?.record?.id &&
        entry.watchable?.id?.toLowerCase() === entry.record.id.toLowerCase();
      const referenceId = exactWrIsWatchable
        ? entry.record.id.toLowerCase()
        : pastedId;
      const isComparison = referenceId !== pastedId;

      onWatch({
        recordId: referenceId,
        rivalId: isComparison ? pastedId : null,
        map: run.meta.map,
        course: run.meta.course,
        board: board?.id ?? null,
        startEyes: !isComparison,
        notice: isComparison
          ? null
          : pastedIsWr
            ? "current-wr"
            : "wr-unavailable",
      });
    } catch (error) {
      dom.replayError.textContent = `Could not open that replay: ${error.message}.`;
    } finally {
      resolvingReplay = false;
      dom.replayButton.disabled = false;
      dom.replayButton.textContent = "Compare with WR";
    }
  };

  // --- markup ---------------------------------------------------------------

  root.innerHTML = `
    <header class="browse__head">
      <div class="browse__brand">
        <span class="browse__logo">kz</span>
        <div>
          <div class="browse__title">CS2KZ replay viewer</div>
          <div class="browse__subtitle" id="browse-count">loading…</div>
        </div>
      </div>
      <div class="browse__tools">
        <button id="browse-feed" class="button button--primary button--feed" type="button">
          ▶ Latest world records
        </button>
        <button id="browse-play" class="button button--feed" type="button">
          ▶ Play kz_victoria
        </button>
        <input id="browse-filter" class="input" type="search" placeholder="filter by map name" spellcheck="false" />
        <label class="checkbox"><input type="checkbox" id="browse-glb" /><span>only maps with 3D geometry</span></label>
      </div>
    </header>
    <section class="replay-entry">
      <div class="replay-entry__copy">
        <div class="replay-entry__title">Compare your replay</div>
        <div class="replay-entry__hint">Paste one replay ID. Its map, course and leaderboard are detected automatically.</div>
      </div>
      <div class="replay-entry__form">
        <input id="replay-id" class="input" placeholder="replay ID" spellcheck="false" />
        <button id="replay-open" class="button button--primary" type="button" disabled>Compare with WR</button>
      </div>
      <div class="replay-entry__error" id="replay-error" aria-live="polite"></div>
    </section>
    <div class="browse__grid" id="browse-grid"></div>
    <footer class="browse__foot" id="browse-foot"></footer>

    <div class="sheet" id="map-sheet" hidden>
      <div class="sheet__backdrop" data-close="1"></div>
      <section class="sheet__box">
        <div class="sheet__shot" id="sheet-shot"></div>
        <button class="sheet__close" type="button" data-close="1" aria-label="Close">×</button>
        <div class="sheet__body">
          <div class="sheet__name" id="sheet-name"></div>
          <div class="sheet__by" id="sheet-by"></div>
          <div class="sheet__geometry" id="sheet-geometry"></div>

          <div class="sheet__picks">
            <label class="field">
              <span class="field__label">Course</span>
              <select class="select" id="sheet-course"></select>
            </label>
            <label class="field">
              <span class="field__label">Mode</span>
              <select class="select" id="sheet-mode"></select>
            </label>
          </div>

          <div class="sheet__result" id="sheet-result"></div>
          <div class="sheet__views" id="sheet-views"></div>

          <button class="button button--primary button--wide" id="sheet-watch" type="button">Watch this run</button>

          <div class="sheet__compare">
            <div class="field__label">Compare with another run</div>
            <div class="sheet__compare-row">
              <input class="input" id="sheet-compare-id" placeholder="paste a record id" spellcheck="false" />
              <button class="button" id="sheet-compare" type="button">Compare</button>
            </div>
            <div class="sheet__error" id="sheet-compare-error"></div>
            <div class="hint">Both runs play on one clock, with a chart of where the time went.</div>
          </div>
        </div>
      </section>
    </div>`;

  Object.assign(dom, {
    grid: root.querySelector("#browse-grid"),
    count: root.querySelector("#browse-count"),
    foot: root.querySelector("#browse-foot"),
    filter: root.querySelector("#browse-filter"),
    geometryOnly: root.querySelector("#browse-glb"),
    replayInput: root.querySelector("#replay-id"),
    replayButton: root.querySelector("#replay-open"),
    replayError: root.querySelector("#replay-error"),
    sheet: root.querySelector("#map-sheet"),
    sheetShot: root.querySelector("#sheet-shot"),
    sheetName: root.querySelector("#sheet-name"),
    sheetBy: root.querySelector("#sheet-by"),
    sheetGeometry: root.querySelector("#sheet-geometry"),
    course: root.querySelector("#sheet-course"),
    mode: root.querySelector("#sheet-mode"),
    result: root.querySelector("#sheet-result"),
    views: root.querySelector("#sheet-views"),
    watch: root.querySelector("#sheet-watch"),
    feed: root.querySelector("#browse-feed"),
    play: root.querySelector("#browse-play"),
    compareInput: root.querySelector("#sheet-compare-id"),
    compareButton: root.querySelector("#sheet-compare"),
    compareError: root.querySelector("#sheet-compare-error"),
  });

  // --- events ---------------------------------------------------------------

  dom.filter.addEventListener("input", (event) => {
    filter = event.target.value;
    renderGrid();
  });
  dom.geometryOnly.addEventListener("change", (event) => {
    geometryOnly = event.target.checked;
    renderGrid();
  });
  dom.feed.addEventListener("click", () => onFeed?.());
  dom.play.addEventListener("click", () => onPlay?.("kz_victoria"));
  dom.replayButton.addEventListener("click", resolveReplay);
  dom.replayInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") resolveReplay();
  });
  dom.grid.addEventListener("click", (event) => {
    const playName = event.target.closest("[data-play]")?.dataset.play;
    if (playName) {
      event.stopPropagation();
      onPlay?.(playName);
      return;
    }
    const name = event.target.closest("[data-map]")?.dataset.map;
    if (!name) return;
    selected = name;
    dom.compareInput.value = "";
    dom.compareError.textContent = "";
    renderSheet();
  });
  dom.sheet.addEventListener("click", (event) => {
    if (event.target.dataset.close) dom.sheet.hidden = true;
  });
  dom.course.addEventListener("change", () => {
    renderModeOptions();
    renderResult();
  });
  dom.mode.addEventListener("change", renderResult);
  dom.watch.addEventListener("click", () => watch(null));
  dom.compareButton.addEventListener("click", () => compare());
  dom.compareInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") compare();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dom.sheet.hidden) dom.sheet.hidden = true;
  });

  return {
    async load() {
      const [catalog, boards, manifest] = await Promise.all([
        fetchJson("/data/maps.json", null),
        fetchJson("/data/leaderboards.json", { entries: {} }),
        fetchJson("/data/geometry.json", { maps: {} }),
      ]);
      entries = boards.entries ?? {};
      dom.replayButton.disabled = false;

      // Same rule as the feed's empty state: a visitor gets told what is happening,
      // and the command to fix it is a dev-only note. A page on the internet must
      // never read like a terminal prompt.
      if (!catalog?.maps?.length) {
        dom.count.textContent = "loading the map list";
        dom.grid.innerHTML = `
          <div class="browse__empty">
            The map list is not ready yet. It is rebuilt every night and again
            whenever the site is updated, so this should fill itself in shortly.
            ${
              import.meta.env.DEV
                ? "<br /><br />Dev: <code>node bin/kzreplay.js refresh --no-geometry</code>"
                : ""
            }
          </div>`;
        return;
      }

      maps = catalog.maps;
      // Errors are recorded in the same manifest as successes, so a map that failed
      // to convert must not be advertised as having geometry.
      geometry = Object.fromEntries(
        Object.entries(manifest.maps ?? {}).filter(
          ([, entry]) => entry && !entry.error,
        ),
      );

      renderGrid();
      const watchable = Object.values(entries).filter(
        (entry) => entry.watchable,
      ).length;
      // The Source 2 Viewer credit belongs on the page, not only in the readme.
      // Every map here was exported with it, and the layout of the Source 2 formats
      // it reads is not documented by Valve — it is years of reverse engineering by
      // other people. Nothing in this project worked that out.
      dom.foot.innerHTML = `
        ${watchable} watchable runs across ${Object.keys(entries).length} leaderboards ·
        ${Object.keys(geometry).length} maps converted to 3D ·
        records updated ${new Date(boards.updatedAt ?? Date.now()).toLocaleString()}
        <br />
        Map geometry powered by
        <a href="https://s2v.app" target="_blank" rel="noopener">Source 2 Viewer</a>
        (<a
          href="https://github.com/ValveResourceFormat/ValveResourceFormat"
          target="_blank"
          rel="noopener"
          >ValveResourceFormat</a
        >). Maps belong to their mappers.`;
    },
    show() {
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
      dom.sheet.hidden = true;
    },
  };
};
