#!/usr/bin/env bash
set -u

usage() {
  echo "usage: grok-wait.sh <run id> <stop file> <handoff dir> <since epoch seconds>" >&2
  echo "run it from the directory the Grok run was launched from" >&2
  exit 2
}

[ $# -eq 4 ] || usage
run_id=$1
stop_file=$2
handoff_dir=$3
since=$4
poll=${GROK_WAIT_POLL_SECONDS:-30}
gate="$(cd "$(dirname "$0")" && pwd)/evidence-gate.sh"

if [ -n "${GROK_BRIDGE_COMMAND:-}" ]; then
  read -r -a bridge <<< "$GROK_BRIDGE_COMMAND"
else
  script=$(ls -d "$HOME"/.claude/plugins/cache/xai-grok-build/grok-build/*/scripts/grok-bridge.mjs 2>/dev/null | sort -V | tail -1)
  [ -n "$script" ] || { echo "grok-bridge.mjs not found under ~/.claude/plugins/cache" >&2; exit 2; }
  bridge=(node "$script")
fi

mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"
}

start_stop_mtime=""
[ -e "$stop_file" ] && start_stop_mtime=$(mtime "$stop_file")

wake() {
  echo "WAKE $1"
  bash "$gate" "$handoff_dir" "$since"
  exit $?
}

while true; do
  if [ -e "$stop_file" ] && [ "$(mtime "$stop_file")" != "$start_stop_mtime" ]; then
    wake "stop-file $stop_file"
  fi
  status=$("${bridge[@]}" runs "$run_id" < /dev/null 2>&1)
  phase=$(printf '%s\n' "$status" | grep -E 'Phase:' | head -1)
  if [ -z "$phase" ]; then
    echo "run $run_id not found by the bridge from $(pwd); run grok-wait.sh from the directory the run was launched from" >&2
    printf '%s\n' "$status" | head -5 >&2
    exit 2
  fi
  case "$phase" in
    *done*|*complete*|*fail*|*cancel*|*error*) wake "run-phase ${phase#*Phase: }" ;;
  esac
  sleep "$poll"
done
