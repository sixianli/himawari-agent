#!/bin/bash
set -u

ROOT=$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)
WORK=$ROOT/runner/_work
USED=$(du -sb "$WORK" 2>/dev/null | cut -f1)
AVAIL=$(df --output=avail -B1 / | tail -1 | tr -d ' ')
printf '%s end run=%s attempt=%s job=%s work_bytes=%s avail=%s\n' "$(date -Is)" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" "${GITHUB_JOB:-}" "${USED:-}" "$AVAIL" >> "$ROOT/logs/disk.log"

case "${GITHUB_WORKSPACE:-}" in
  "$WORK"/*/*) rm -rf -- "$(dirname "$GITHUB_WORKSPACE")" ;;
esac
[ -d "$WORK/_temp" ] && find "$WORK/_temp" -mindepth 1 -delete 2>/dev/null
exit 0
