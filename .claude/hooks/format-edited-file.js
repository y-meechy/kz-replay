// Auto-format files edited through Claude Code without requiring a plugin or jq.
// Missing dependencies and formatter failures are deliberately non-blocking.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const input = await new Promise((resolveInput) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => resolveInput(text));
});

let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}

const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const suppliedPath = event.tool_input?.file_path;
if (typeof suppliedPath !== "string" || suppliedPath.length === 0)
  process.exit(0);

const file = resolve(
  isAbsolute(suppliedPath) ? suppliedPath : join(projectDir, suppliedPath),
);
const projectPath = relative(projectDir, file);
if (projectPath.startsWith("..") || isAbsolute(projectPath)) process.exit(0);
if (
  projectPath.startsWith("node_modules/") ||
  projectPath.startsWith("viewer/public/")
) {
  process.exit(0);
}
if (![".js", ".html", ".css"].includes(extname(file)) || !existsSync(file)) {
  process.exit(0);
}

const prettier = join(
  projectDir,
  "node_modules",
  "prettier",
  "bin",
  "prettier.cjs",
);
if (!existsSync(prettier)) process.exit(0);

const result = spawnSync(process.execPath, [prettier, "--write", file], {
  cwd: projectDir,
  stdio: "ignore",
  timeout: 10_000,
});

if (result.error || result.status !== 0) {
  console.error(`Claude hook: Prettier could not format ${projectPath}`);
}

process.exit(0);
