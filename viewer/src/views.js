// The browser half of the view counter.
//
// Two jobs: read counts to show them, and decide when a run has actually been
// watched. The second one is the one worth being careful about. "Watched" here means
// the run played for a few seconds — not that a page loaded, not that a card scrolled
// past. A number that goes up when nobody watched anything is not worth showing.
//
// The browser also remembers what it has already counted, so scrolling back up the
// feed to the same run, or reloading a watch link, does not count twice. The server
// keeps its own six hour memory of the same thing; this side exists so the request is
// not made at all.

/** Play this long before it counts. Short runs count at half their length instead. */
const WATCHED_SECONDS = 3;

/** How long before the same browser may count the same run again. */
const RECOUNT_AFTER_MS = 6 * 60 * 60 * 1000;

const VISITOR_KEY = "kz.visitor";
const COUNTED_KEY = "kz.counted";

/** Never remember more than this many runs locally, oldest dropped first. */
const MAX_REMEMBERED = 500;

/**
 * A random id for this browser, made here and never sent anywhere else.
 *
 * It exists so the server can tell "the same person watched this again" from "someone
 * else watched it", without the server needing to know anything about either. If
 * localStorage is unavailable (private mode, storage disabled) everything still
 * works: the id is null, the server falls back to the address, and nothing breaks.
 */
const visitorId = () => {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    return null;
  }
};

const readCounted = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(COUNTED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeCounted = (counted) => {
  try {
    const entries = Object.entries(counted)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REMEMBERED);
    localStorage.setItem(
      COUNTED_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Storage full or blocked. The server's own dedupe covers it.
  }
};

const countedRecently = (recordId) =>
  Date.now() - (readCounted()[recordId] ?? 0) < RECOUNT_AFTER_MS;

const rememberCounted = (recordId) => {
  const counted = readCounted();
  counted[recordId] = Date.now();
  writeCounted(counted);
};

/**
 * Counts for a set of runs.
 *
 * One request for the whole feed page. A failure is not worth reporting to anyone: no
 * view counter is a missing decoration, so it resolves to no counts and the callers
 * show nothing rather than an error.
 */
export const fetchViews = async (recordIds) => {
  const ids = [...new Set(recordIds.filter(Boolean))];
  if (ids.length === 0) return { views: {}, total: 0 };
  try {
    const response = await fetch(`/api/views?ids=${ids.join(",")}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    return { views: body.views ?? {}, total: body.total ?? 0 };
  } catch {
    return { views: {}, total: 0 };
  }
};

/**
 * Count a view, once.
 *
 * @returns the new count, or null if it was not counted (already counted here, or
 *          the request failed).
 */
export const countView = async (recordId) => {
  if (!recordId || countedRecently(recordId)) return null;
  // Remembered before the request, not after: a double call in the same moment must
  // not become two views, and the count is a decoration either way.
  rememberCounted(recordId);
  try {
    const response = await fetch(`/api/views/${recordId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitor: visitorId() }),
      // The feed sends this while the page may be scrolling away from the run.
      keepalive: true,
    });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    return Number.isFinite(body.views) ? body.views : null;
  } catch {
    return null;
  }
};

/**
 * Watch one run's playback and count a view once it has really been watched.
 *
 * Fed the player's own frames, so it measures playback and not wall-clock time: a
 * paused run, a background tab (no frames are rendered) and a run nobody scrolled to
 * all correctly add up to nothing. Time is accumulated from the frame clock rather
 * than from the run's own position, so scrubbing back and forth cannot fake it.
 *
 * @param onCounted called with the new count when one is recorded
 */
export const createViewTicker = ({ recordId, duration, onCounted }) => {
  // A 1.5 second bhop record cannot be watched for three seconds, so the threshold
  // for a short run is half of it.
  const needed = Math.min(WATCHED_SECONDS, Math.max(0.5, (duration ?? 0) / 2));
  let watched = 0;
  let lastTime = null;
  let done = false;

  return {
    /** Call from the player's onFrame. */
    frame(frame) {
      if (done) return;
      const time = frame.time;
      // Only forward progress on the same pass counts. A loop back to zero, a seek
      // and a pause all show up here as a jump, and a jump adds nothing.
      const step = lastTime === null ? 0 : time - lastTime;
      lastTime = time;
      if (step > 0 && step < 0.5 && frame.playing) watched += step;
      if (watched < needed) return;

      done = true;
      countView(recordId).then((count) => {
        if (count !== null) onCounted?.(count);
      });
    },
    stop() {
      done = true;
    },
  };
};

/** 0, 1, 12, 1.2k, 340k, 1.2m — a count nobody has to count digits in. */
const formatViews = (count) => {
  const value = Number(count) || 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}m`;
};

/**
 * "1 view", "12 views", "1.2k views" — the phrase all three pages show.
 *
 * One place, because "view" is the only word in the app that has to be counted for,
 * and three copies of the same `count === 1` check is three chances to get it wrong.
 */
export const viewsLabel = (count) =>
  `${formatViews(count)} view${count === 1 ? "" : "s"}`;
