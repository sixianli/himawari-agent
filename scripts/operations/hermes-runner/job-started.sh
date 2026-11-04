#!/bin/bash
set -u

FLOOR=$((8 * 1024 * 1024 * 1024))
AVAIL=$(df --output=avail -B1 / | tail -1 | tr -d ' ')
printf '%s start run=%s attempt=%s job=%s avail=%s\n' "$(date -Is)" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" "${GITHUB_JOB:-}" "$AVAIL" >> /srv/gh-runner/logs/disk.log

if [ "$AVAIL" -lt "$FLOOR" ]; then
  echo "::error::Hermes root disk has ${AVAIL} bytes free, below the 8 GiB floor; job refused"
  exit 1
fi
