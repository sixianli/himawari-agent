#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: codex-wait.sh <repo> <session-uuid> <stop-file> [idle-seconds=1200] [poll-seconds=30]" >&2
  exit 2
}

[ $# -ge 3 ] || usage
repo=$1
id=$2
stop_file=$3
idle_limit=${4:-1200}
poll=${5:-30}

log=$(find "$HOME/.codex/sessions" -name "rollout-*-${id}.jsonl" -print 2>/dev/null | head -1)
[ -n "$log" ] || { echo "no session log for $id" >&2; exit 1; }
start_head=$(git -C "$repo" rev-parse HEAD)
start_lines=$(wc -l < "$log" | tr -d ' ')

codex_question() {
  tail -n +"$((start_lines + 1))" "$log" |
    grep -m1 -oE '"name":"request_user_input(_async)?","arguments":"\{\\"questions\\":\[\{\\"title\\":\\"[^\\]{0,250}' |
    sed 's/.*\\"title\\":\\"//' || true
}

codex_commits_since_start() {
  if ! git -C "$repo" merge-base --is-ancestor "$start_head" HEAD; then
    echo 1
    return
  fi
  git -C "$repo" rev-list --count --invert-grep --grep='Co-Authored-By: Claude' "${start_head}..HEAD"
}

reason=""
while [ -z "$reason" ]; do
  if [ -f "$repo/$stop_file" ]; then
    reason="stop file written: $stop_file"
  elif question=$(codex_question) && [ -n "$question" ]; then
    reason="codex asked a question (answer with codex queue): $question"
  elif [ "$(codex_commits_since_start)" -gt 0 ]; then
    reason="new commit"
  elif [ -z "$(lsof -t "$log" 2>/dev/null || true)" ]; then
    reason="codex process exited"
  elif [ $(( $(date +%s) - $(stat -f %m "$log") )) -gt "$idle_limit" ]; then
    reason="session log idle for more than ${idle_limit}s"
  else
    sleep "$poll"
  fi
done

echo "woke at $(date +%T): $reason"
git -C "$repo" log --oneline "${start_head}~1..HEAD"
git -C "$repo" status --short
