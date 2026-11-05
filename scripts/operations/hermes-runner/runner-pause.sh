#!/bin/bash
set -u

source "${BASH_SOURCE[0]%/*}/runners.sh"

LIMIT=${1:-3600}
if ! [[ "$LIMIT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$LIMIT" -gt 86400 ]; then
  echo "RUNNER_PAUSE_FAILED wait limit must be 1-86400 seconds, got: ${LIMIT}" >&2
  exit 64
fi
IDS=$(installed_runner_ids)
[ -n "$IDS" ] || { echo "RUNNER_PAUSE_FAILED no runner account exists"; exit 1; }

busy_runner() {
  local id
  for id in $IDS; do
    runner_select "$id"
    runner_has_job "$RUNNER_USER"
    case $? in
      0) return 0 ;;
      1) ;;
      *) return 2 ;;
    esac
  done
  return 1
}

WAITED=0
while :; do
  busy_runner
  case $? in
    1) break ;;
    2)
      echo "RUNNER_PAUSE_FAILED could not check whether $RUNNER_USER is running a job; runners left running"
      exit 1
      ;;
  esac
  if [ "$WAITED" -ge "$LIMIT" ]; then
    echo "RUNNER_BUSY_TIMEOUT $RUNNER_USER is still running a job after ${LIMIT}s; runners left running"
    exit 2
  fi
  sleep 10
  WAITED=$((WAITED + 10))
done

for id in $IDS; do
  runner_select "$id"
  sudo -n /usr/bin/systemctl stop "$RUNNER_UNIT" || { echo "RUNNER_PAUSE_FAILED systemctl stop $RUNNER_UNIT"; exit 1; }
done
for id in $IDS; do
  runner_select "$id"
  if systemctl is-active --quiet "$RUNNER_UNIT"; then
    echo "RUNNER_PAUSE_FAILED $RUNNER_UNIT still active"
    exit 1
  fi
done
echo "RUNNER_PAUSED $(date -Is) waited=${WAITED}s runners=$(echo $IDS)"
