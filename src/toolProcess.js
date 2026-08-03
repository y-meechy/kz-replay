// Run external conversion tools with one shared upper bound.
//
// SteamCMD and the Source 2 exporters occasionally wait forever on a broken
// download or child process. A nightly refresh must eventually release its lock so
// the next refresh and a deployment can proceed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const configuredMinutes = Number(process.env.KZ_TOOL_TIMEOUT_MINUTES ?? 30);
if (
  !Number.isFinite(configuredMinutes) ||
  configuredMinutes < 1 ||
  configuredMinutes > 24 * 60
) {
  throw new Error("KZ_TOOL_TIMEOUT_MINUTES must be between 1 and 1440");
}

export const TOOL_TIMEOUT_MS = configuredMinutes * 60_000;

export const runTool = (file, args, options = {}) =>
  execFileAsync(file, args, {
    ...options,
    timeout: options.timeout ?? TOOL_TIMEOUT_MS,
    killSignal: options.killSignal ?? "SIGTERM",
  });
