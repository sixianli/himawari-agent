#!/bin/bash
set -u

TARGET=${1:-/srv/gh-runner/runner}
LOG=${2:-/srv/gh-runner/logs/disk.log}
FLOOR=$((8 * 1024 * 1024 * 1024))
AVAIL=$(df --output=avail -B1 "$TARGET" 2>/dev/null | tail -1 | tr -d ' ')
printf '%s start run=%s attempt=%s job=%s avail=%s\n' "$(date -Is)" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" "${GITHUB_JOB:-}" "$AVAIL" >> "$LOG"

if ! [[ "$AVAIL" =~ ^[0-9]+$ ]]; then
  echo "::error::could not read free space for ${TARGET}; job refused"
  exit 1
fi
if [ "$AVAIL" -lt "$FLOOR" ]; then
  echo "::error::the Hermes disk holding ${TARGET} has ${AVAIL} bytes free, below the 8 GiB floor; job refused"
  exit 1
fi
