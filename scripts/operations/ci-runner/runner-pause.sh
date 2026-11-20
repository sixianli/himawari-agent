#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

if [ "${1:-}" = --list ]; then
  for id in $(installed_runner_ids); do
    runner_select "$id"
    systemctl is-enabled --quiet "$RUNNER_UNIT" && printf '%s\n' "$RUNNER_NAME"
  done
  exit 0
fi

if [ "${1:-}" = --status ]; then
  for id in $(installed_runner_ids); do
    runner_select "$id"
    printf '%s=%s\n' "$RUNNER_UNIT" "$(systemctl is-active "$RUNNER_UNIT")"
  done
  exit 0
fi

if [ "${1:-}" != --labels-removed ]; then
  echo "RUNNER_PAUSE_REFUSED run pause-runners.sh on the Mac: it removes the $RUNNER_LABELS labels first so GitHub sends no new job" >&2
  exit 64
fi
QUIET=${2:-90}
if ! [[ "$QUIET" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$QUIET" -gt 180 ]; then
  echo "RUNNER_PAUSE_REFUSED quiet window must be 1-180 seconds, got: ${QUIET}" >&2
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

WATCHED=0
while :; do
  busy_runner
  case $? in
    0)
      echo "RUNNER_STILL_BUSY $RUNNER_USER is running a job; runners left running"
      exit 2
      ;;
    2)
      echo "RUNNER_PAUSE_FAILED could not check whether $RUNNER_USER is running a job; runners left running"
      exit 1
      ;;
  esac
  [ "$WATCHED" -ge "$QUIET" ] && break
  sleep 10
  WATCHED=$((WATCHED + 10))
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
echo "RUNNER_PAUSED $(date -Is) quiet=${WATCHED}s runners=$(echo $IDS)"
