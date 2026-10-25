#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: codex-resume-context.sh <repo> <state-file-relative-path> [max-lines=60]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
repo=$1
state=$2
max_lines=${3:-60}
here=$(cd "$(dirname "$0")" && pwd)

cd "$repo"
[ -f "$state" ] || { echo "state file not found: $state" >&2; exit 1; }

lines=$(wc -l < "$state" | tr -d ' ')
echo "## state file: $state ($lines lines)"
if [ "$lines" -gt "$max_lines" ]; then
  echo "WARNING: over $max_lines lines; move history to reply files, decisions to docs, procedure to the skill"
fi
cat "$state"

echo
echo "## git"
git log --oneline -5
git status --short

longtask="$here/../../long-task-planning/scripts/longtask.py"
if [ -d .agents/tasks ] && [ -f "$longtask" ]; then
  echo
  echo "## long task status"
  python3 "$longtask" status --no-save || true
fi

uuid=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$state" | head -1 || true)
echo
echo "## codex session ${uuid:-<none in state file>}"
if [ -n "$uuid" ]; then
  bash "$here/codex-session.sh" status "$uuid" || true
fi

handoff_dir=$(dirname "$state")
echo
echo "## newest stop and reply files in $handoff_dir"
ls -t "$handoff_dir" | grep -E 'stop-[0-9]+\.md$' | head -1 || true
ls -t "$handoff_dir" | grep -E 'reply-[0-9]+\.md$' | head -1 || true

next_stop=$(grep -oE '[^` ]*stop-[0-9]+\.md' "$state" | tail -1 || true)
if [ -n "$next_stop" ]; then
  if [ -f "$next_stop" ]; then
    echo "next stop file EXISTS: $next_stop (handle it first)"
  else
    echo "next stop file not written yet: $next_stop"
  fi
fi
