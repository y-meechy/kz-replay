// Upload each new .replay a CS2KZ server writes, and print the review link.
//
// Runs next to the game server with its kzreplays/ folder mounted read-only, so
// the game process loads nothing of ours. Node standard library only: the deploy
// is this one file in a stock node image (deploy/replay-watcher.compose.yml).
//
//   KZ_WATCH_DIR        the server's kzreplays/ folder
//   KZ_API_URL          where kz-replay runs, e.g. https://demo.kzcomp.com
//   KZ_ANALYSIS_TOKEN   the token that server was started with
//   KZ_WATCH_STATE      file remembering what was already sent (default ./uploaded.json)

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One watcher. `poll()` looks at the folder once; the caller decides how often.
 *
 * A file is sent once it has stopped changing between two polls: the plugin writes
 * replays in pieces, and a half-written one would just fail to parse.
 */
export const createWatcher = ({
  dir,
  apiUrl,
  token,
  statePath,
  fetchImpl = fetch,
  log = console.log,
}) => {
  let done = null;
  const lastSeen = new Map();

  const load = async () => {
    const saved = await readFile(statePath, "utf8").catch(() => null);
    if (saved) return new Set(JSON.parse(saved));
    // First start: everything already there is history, not a new run.
    const names = await readdir(dir).catch(() => []);
    const seen = new Set(names.filter((name) => name.endsWith(".replay")));
    await writeFile(statePath, JSON.stringify([...seen]));
    log(`first start, skipping ${seen.size} existing replays`);
    return seen;
  };

  const upload = async (name) => {
    const body = await readFile(join(dir, name));
    const response = await fetchImpl(`${apiUrl}/api/analyses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
      },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 201) {
      const delta = result.comparison?.finalDelta;
      log(
        `${name}: ${result.run.player} ${result.run.map} ${result.run.reportedTime}s` +
          `${delta === undefined ? "" : ` (${delta > 0 ? "+" : ""}${delta}s vs WR)`}` +
          ` ${apiUrl}${result.watch}`,
      );
      return true;
    }
    // 422 is the replay itself (not a run, unreadable): sending it again won't help.
    if (response.status === 422) {
      log(`${name}: skipped, ${result.error}`);
      return true;
    }
    log(`${name}: upload failed with ${response.status}, retrying later`);
    return false;
  };

  const poll = async () => {
    done ??= await load();
    const names = await readdir(dir).catch(() => []);
    let changed = false;
    for (const name of names) {
      if (!name.endsWith(".replay") || done.has(name)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info) continue;
      const signature = `${info.size}:${info.mtimeMs}`;
      if (lastSeen.get(name) !== signature) {
        lastSeen.set(name, signature);
        continue;
      }
      const sent = await upload(name).catch((error) => {
        log(`${name}: ${error.message}, retrying later`);
        return false;
      });
      if (sent) {
        done.add(name);
        lastSeen.delete(name);
        changed = true;
      }
    }
    if (changed) await writeFile(statePath, JSON.stringify([...done]));
  };

  return { poll };
};

if (import.meta.main) {
  const { KZ_WATCH_DIR, KZ_API_URL, KZ_ANALYSIS_TOKEN } = process.env;
  if (!KZ_WATCH_DIR || !KZ_API_URL || !KZ_ANALYSIS_TOKEN) {
    console.error(
      "KZ_WATCH_DIR, KZ_API_URL and KZ_ANALYSIS_TOKEN are required",
    );
    process.exit(1);
  }
  const watcher = createWatcher({
    dir: KZ_WATCH_DIR,
    apiUrl: KZ_API_URL.replace(/\/+$/, ""),
    token: KZ_ANALYSIS_TOKEN,
    statePath: process.env.KZ_WATCH_STATE ?? "uploaded.json",
    log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  });
  console.log(`watching ${KZ_WATCH_DIR}, sending to ${KZ_API_URL}`);
  // Polling, not fs.watch: inotify events do not cross a Docker bind mount
  // reliably, and a few seconds of delay after a run costs nothing.
  for (;;) {
    await watcher.poll().catch((error) => console.error(error));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
