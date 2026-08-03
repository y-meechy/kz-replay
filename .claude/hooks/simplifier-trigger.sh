#!/usr/bin/env bash
# Stop hook: if code files were edited this turn, instruct Claude to invoke
# the code-simplifier subagent before finishing. Uses a one-shot cooldown
# sentinel so the *next* Stop event (after the simplifier returns) skips,
# preventing infinite loops.
set -u
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // "default"')
touched="/tmp/claude-simplifier-touched-${session}.txt"
cooldown="/tmp/claude-simplifier-cooldown-${session}"

# Stop hook just fired the simplifier last time — clear state and skip.
if [ -f "$cooldown" ]; then
  rm -f "$cooldown" "$touched"
  exit 0
fi

# No edits tracked this turn.
[ -s "$touched" ] || exit 0

# Only fire for code files. Skip docs, configs, lockfiles, etc.
code_files=$(sort -u "$touched" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|m|mm|c|cc|cpp|h|hpp|cs|php|vue|svelte|astro|sql|sh|bash|zsh|lua|ex|exs|elm|clj|cljs|fs|fsx|hs|ml|scala|dart|r)$' || true)

if [ -z "$code_files" ]; then
  rm -f "$touched"
  exit 0
fi

# Arm cooldown so the next Stop (after the simplifier subagent returns) is a no-op.
touch "$cooldown"
rm -f "$touched"

file_list=$(printf '%s\n' "$code_files" | head -20)

jq -n --arg files "$file_list" '{
  decision: "block",
  reason: ("Code files were edited this turn:\n" + $files + "\n\nBefore finishing, invoke the code-simplifier subagent (Agent tool with subagent_type=\"code-simplifier:code-simplifier\") and pass these file paths so it can refine the recent edits for clarity, consistency, and maintainability while preserving exact functionality. Apply only refinements that are clear wins under project standards — push back on noise and never change behavior. Then finish the turn normally; the cooldown prevents this from re-firing.")
}'
exit 0
