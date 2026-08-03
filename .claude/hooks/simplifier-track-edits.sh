#!/usr/bin/env bash
# PostToolUse hook for Edit|Write|NotebookEdit.
# Appends the edited file path to a per-session "touched" file.
# The Stop hook reads this to decide whether to invoke the code-simplifier.
set -u
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // "default"')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -n "$file" ] && printf '%s\n' "$file" >> "/tmp/claude-simplifier-touched-${session}.txt"
exit 0
