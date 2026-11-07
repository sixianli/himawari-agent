#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
ROOT=$(cd "$HERE/.." && pwd)
TARGET=${1:-$ROOT/runner}
LOG=${2:-$ROOT/logs/disk.log}
FLOOR=$((16 * 1024 * 1024 * 1024))
AVAIL=$(df --output=avail -B1 "$TARGET" 2>/dev/null | tail -1 | tr -d ' ')
printf '%s start run=%s attempt=%s job=%s avail=%s\n' "$(date -Is)" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" "${GITHUB_JOB:-}" "$AVAIL" >> "$LOG"

if ! [[ "$AVAIL" =~ ^[0-9]+$ ]]; then
  echo "::error::could not read free space for ${TARGET}; job refused"
  exit 1
fi
if [ "$AVAIL" -lt "$FLOOR" ]; then
  echo "::error::the disk holding ${TARGET} has ${AVAIL} bytes free, below the 16 GiB floor; job refused"
  exit 1
fi
