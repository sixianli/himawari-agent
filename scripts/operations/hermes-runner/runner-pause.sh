#!/bin/bash
set -u

LIMIT=${1:-3600}
if ! [[ "$LIMIT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$LIMIT" -gt 86400 ]; then
  echo "RUNNER_PAUSE_FAILED wait limit must be 1-86400 seconds, got: ${LIMIT}" >&2
  exit 64
fi
WAITED=0
while pgrep -u gh-runner -x Runner.Worker > /dev/null; do
  if [ "$WAITED" -ge "$LIMIT" ]; then
    echo "RUNNER_BUSY_TIMEOUT a job is still running after ${LIMIT}s; runner left running"
    exit 2
  fi
  sleep 10
  WAITED=$((WAITED + 10))
done

sudo -n /usr/bin/systemctl stop gh-runner.service || { echo "RUNNER_PAUSE_FAILED systemctl stop"; exit 1; }
if systemctl is-active --quiet gh-runner.service; then
  echo "RUNNER_PAUSE_FAILED service still active"
  exit 1
fi
echo "RUNNER_PAUSED $(date -Is) waited=${WAITED}s"
