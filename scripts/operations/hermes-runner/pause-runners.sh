#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

take_lock
JOB_SECONDS=$(longest_job_seconds) || { echo "RUNNER_PAUSE_FAILED could not read timeoutMinutes from ci/policy.json"; exit 1; }
DEADLINE=$(($(date +%s) + JOB_SECONDS + 300))

upload_runner_scripts || { echo "RUNNER_PAUSE_FAILED labels and services untouched"; exit 1; }
NAMES=$(hermes "bash $REMOTE/runner-pause.sh --list") || { echo "RUNNER_PAUSE_FAILED could not list the runners installed on Hermes; labels and services untouched"; exit 1; }
TABLE=$(github_runners) || { echo "RUNNER_PAUSE_FAILED could not list runners on GitHub; labels and services untouched"; exit 1; }
REASON=$(reconcile_runners "$NAMES" "$TABLE") || { echo "RUNNER_PAUSE_FAILED $REASON; labels and services untouched"; exit 1; }

put_labels_back() {
  RESTORED=""
  for id in $REMOVED; do
    add_label "$id" && RESTORED="$RESTORED $id" || echo "could not put $LABEL back on runner $id"
  done
}

interrupted_while_removing() {
  put_labels_back
  echo "RUNNER_PAUSE_FAILED interrupted while removing labels; put back on:${RESTORED:- none}; services untouched"
  exit 130
}

interrupted_while_waiting() {
  echo "RUNNER_PAUSE_INCOMPLETE interrupted labels=removed services=$(service_states); run pause-runners.sh again, or resume-runners.sh to undo"
  exit 130
}

REMOVED=""
trap interrupted_while_removing INT TERM HUP
for name in $NAMES; do
  id=$(runner_field "$TABLE" "$name" 1)
  has_label "$(runner_field "$TABLE" "$name" 5)" || continue
  if remove_label "$id"; then
    REMOVED="$REMOVED $id"
  else
    echo "could not remove $LABEL from $name"
    break
  fi
done

TABLE=$(github_runners)
LEFT=""
for name in $NAMES; do
  has_label "$(runner_field "$TABLE" "$name" 5)" && LEFT="$LEFT $name"
done
if [ -n "$LEFT" ] || [ -z "$TABLE" ]; then
  put_labels_back
  echo "RUNNER_PAUSE_FAILED $LABEL still on:${LEFT:- unknown}; put back on:${RESTORED:- none}; services untouched"
  exit 1
fi
trap interrupted_while_waiting INT TERM HUP
echo "RUNNER_LABELS_REMOVED runners=$(echo $NAMES); GitHub sends them no new job, queued jobs wait"

while :; do
  TABLE=$(github_runners) || TABLE=""
  BUSY=""
  for name in $NAMES; do
    [ "$(runner_field "$TABLE" "$name" 4)" = false ] || BUSY="$BUSY $name"
  done
  if [ -z "$BUSY" ]; then
    OUTPUT=$(hermes "bash $REMOTE/runner-pause.sh --labels-removed 90")
    STATUS=$?
    printf '%s\n' "$OUTPUT"
    [ "$STATUS" = 0 ] && break
    if [ "$STATUS" != 2 ]; then
      echo "RUNNER_PAUSE_INCOMPLETE labels=removed services=$(service_states); run pause-runners.sh again, or resume-runners.sh to undo"
      exit 1
    fi
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "RUNNER_PAUSE_INCOMPLETE labels=removed services=running busy:${BUSY:- none}; run pause-runners.sh again, or resume-runners.sh to undo"
    exit 2
  fi
  sleep "$POLL"
done

echo "RUNNER_PAUSED labels=removed services=stopped runners=$(echo $NAMES)"
echo "Jobs queued for more than 24 hours fail on GitHub; run resume-runners.sh before then"
