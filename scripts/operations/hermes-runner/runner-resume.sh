#!/bin/bash
set -u

source "${BASH_SOURCE[0]%/*}/runners.sh"

UNITS=""
for id in $(installed_runner_ids); do
  runner_select "$id"
  systemctl is-enabled --quiet "$RUNNER_UNIT" && UNITS="$UNITS $RUNNER_UNIT"
done
[ -n "$UNITS" ] || { echo "RUNNER_RESUME_FAILED no registered runner"; exit 1; }

for unit in $UNITS; do
  sudo -n /usr/bin/systemctl start "$unit" || { echo "RUNNER_RESUME_FAILED systemctl start $unit"; exit 1; }
done
for unit in $UNITS; do
  for attempt in 1 2 3 4 5 6 7; do
    systemctl is-active --quiet "$unit" && break
    [ "$attempt" -eq 7 ] && { echo "RUNNER_RESUME_FAILED $unit not active after 30s"; exit 1; }
    sleep 5
  done
done
echo "RUNNER_RESUMED $(date -Is) units=${UNITS# }"
