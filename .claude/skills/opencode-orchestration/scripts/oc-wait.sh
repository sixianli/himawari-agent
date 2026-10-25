#!/usr/bin/env bash
set -u

usage() {
  echo "usage: oc-wait.sh <run prefix> <stop file> [quiet minutes, default 20]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
prefix=$1
stop_file=$2
quiet_minutes=${3:-20}
log="$prefix.jsonl"
pid_file="$prefix.pid"
rc_file="$prefix.rc"
[ -f "$pid_file" ] || { echo "missing $pid_file" >&2; exit 2; }
pid=$(cat "$pid_file")
start_stop_mtime=""
[ -e "$stop_file" ] && start_stop_mtime=$(stat -f %m "$stop_file" 2>/dev/null || stat -c %Y "$stop_file")
start_errors=$(grep -c -E '"type": ?"error"' "$log" 2>/dev/null || true)

mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"
}

gate="$(cd "$(dirname "$0")" && pwd)/evidence-gate.sh"
handoff_dir=$(dirname "$prefix")
since=$(mtime "$pid_file")

wake() {
  echo "WAKE $1"
  bash "$gate" "$handoff_dir" "$since"
  exit $?
}

while true; do
  if [ -e "$stop_file" ]; then
    current=$(mtime "$stop_file")
    if [ "$current" != "$start_stop_mtime" ]; then
      wake "stop-file $stop_file"
    fi
  fi
  errors=$(grep -c -E '"type": ?"error"' "$log" 2>/dev/null || true)
  if [ "${errors:-0}" -gt "${start_errors:-0}" ]; then
    wake "error-event $(grep -E '"type": ?"error"' "$log" | tail -1 | cut -c1-400)"
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rc="unknown"
    [ -f "$rc_file" ] && rc=$(cat "$rc_file")
    wake "exited rc=$rc"
  fi
  if [ -f "$log" ]; then
    age=$(( $(date +%s) - $(mtime "$log") ))
    if [ "$age" -ge $(( quiet_minutes * 60 )) ]; then
      wake "quiet ${age}s without new events (pid $pid still alive)"
    fi
  fi
  sleep 15
done
