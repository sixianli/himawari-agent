#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

case "${1:-}" in
  on | off) WANTED=$1 ;;
  *)
    echo "usage: bash gate-fallback.sh <on|off>   (on lets the first check runner take $RUNNER_GATE_LABEL jobs while the gate runner is down; off undoes it)"
    exit 64
    ;;
esac

take_lock
runner_select 1
FALLBACK=$RUNNER_NAME
runner_select 3
GATE=$RUNNER_NAME
TABLE=$(github_runners) || { echo "GATE_FALLBACK_FAILED could not list runners on GitHub; labels untouched"; exit 1; }
COUNT=$(runner_field "$TABLE" "$FALLBACK" 1 | grep -c .)
[ "$COUNT" = 1 ] || { echo "GATE_FALLBACK_FAILED GitHub has $COUNT runners named $FALLBACK; labels untouched"; exit 1; }
ID=$(runner_field "$TABLE" "$FALLBACK" 1)

carries_gate_label() {
  has_label "$(runner_field "$1" "$FALLBACK" 5)" "$RUNNER_GATE_LABEL"
}

if [ "$WANTED" = on ]; then
  has_label "$(runner_field "$TABLE" "$FALLBACK" 5)" "$RUNNER_CHECK_LABEL" || {
    echo "GATE_FALLBACK_FAILED $FALLBACK does not carry $RUNNER_CHECK_LABEL, so the runners are paused; run resume-runners.sh first"
    exit 1
  }
  [ "$(runner_field "$TABLE" "$FALLBACK" 3)" = online ] || {
    echo "GATE_FALLBACK_FAILED $FALLBACK is $(runner_field "$TABLE" "$FALLBACK" 3) on GitHub, so it could not take the jobs either; labels untouched"
    exit 1
  }
  carries_gate_label "$TABLE" || add_label "$ID" "$RUNNER_GATE_LABEL" || echo "could not add $RUNNER_GATE_LABEL to $FALLBACK"
  TABLE=$(github_runners) || TABLE=""
  carries_gate_label "$TABLE" || { echo "GATE_FALLBACK_FAILED $RUNNER_GATE_LABEL is not on $FALLBACK"; exit 1; }
  echo "GATE_FALLBACK_ON $FALLBACK now also takes $RUNNER_GATE_LABEL jobs (status=$(runner_field "$TABLE" "$FALLBACK" 3))"
  [ "$(runner_field "$TABLE" "$GATE" 3)" != online ] || echo "note: $GATE is online on GitHub, so both runners now take these jobs; run gate-fallback.sh off unless it is stuck"
  echo "pause-runners.sh removes this label; after resume-runners.sh run gate-fallback.sh on again if the gate runner is still down"
  exit 0
fi

if carries_gate_label "$TABLE"; then
  remove_label "$ID" "$RUNNER_GATE_LABEL" || echo "could not remove $RUNNER_GATE_LABEL from $FALLBACK"
fi
TABLE=$(github_runners) || { echo "GATE_FALLBACK_FAILED could not read GitHub back; check the labels of $FALLBACK"; exit 1; }
[ "$(runner_field "$TABLE" "$FALLBACK" 1 | grep -c .)" = 1 ] || { echo "GATE_FALLBACK_FAILED could not read $FALLBACK back"; exit 1; }
carries_gate_label "$TABLE" && { echo "GATE_FALLBACK_FAILED $RUNNER_GATE_LABEL is still on $FALLBACK"; exit 1; }
echo "GATE_FALLBACK_OFF $FALLBACK takes only $RUNNER_CHECK_LABEL jobs"
