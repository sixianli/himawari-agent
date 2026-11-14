#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

take_lock
JOB_SECONDS=$(longest_job_seconds) || { echo "RUNNER_PAUSE_FAILED could not read timeoutMinutes from ci/policy.json"; exit 1; }
DEADLINE=$(($(date +%s) + JOB_SECONDS + 300))

upload_runner_scripts || { echo "RUNNER_PAUSE_FAILED labels and services untouched"; exit 1; }
NAMES=$(vps "bash $REMOTE/runner-pause.sh --list") || { echo "RUNNER_PAUSE_FAILED could not list the runners installed on $RUNNER_HOST; labels and services untouched"; exit 1; }
TABLE=$(github_runners) || { echo "RUNNER_PAUSE_FAILED could not list runners on GitHub; labels and services untouched"; exit 1; }
REASON=$(reconcile_runners "$NAMES" "$TABLE") || { echo "RUNNER_PAUSE_FAILED $REASON; labels and services untouched"; exit 1; }
if [ "$RUNNER_SITE" = vps ]; then
  for name in $NAMES; do
    has_label "$(runner_field "$TABLE" "$name" 5)" "$RUNNER_ARM_LABEL" && { echo "RUNNER_PAUSE_FAILED $name also carries $RUNNER_ARM_LABEL (arm-fallback.sh on), so GitHub would keep sending it jobs; run arm-fallback.sh off first; labels and services untouched"; exit 1; }
  done
fi

put_labels_back() {
  RESTORED=""
  for entry in $REMOVED; do
    add_label "${entry%%:*}" "${entry#*:}" && RESTORED="$RESTORED ${entry%%:*}" || echo "could not put ${entry#*:} back on runner ${entry%%:*}"
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
FAILED_REMOVAL=""
for name in $NAMES; do
  id=$(runner_field "$TABLE" "$name" 1)
  for label in $(managed_labels_on "$(runner_field "$TABLE" "$name" 5)"); do
    REMOVED="$REMOVED $id:$label"
    remove_label "$id" "$label" || { echo "could not remove $label from $name"; FAILED_REMOVAL=yes; break; }
  done
  [ -z "$FAILED_REMOVAL" ] || break
done

TABLE=$(github_runners) || TABLE=""
LEFT=""
for state in $(label_states "$NAMES" "$TABLE"); do
  case $state in
    *=off) ;;
    *=unread) LEFT="$LEFT ${state%=*}(could not read)" ;;
    *) LEFT="$LEFT ${state%=*}" ;;
  esac
done
if [ -n "$LEFT" ]; then
  put_labels_back
  echo "RUNNER_PAUSE_FAILED a runner label is still on:$LEFT; put back on:${RESTORED:- none}; services untouched"
  exit 1
fi
trap interrupted_while_waiting INT TERM HUP
echo "RUNNER_LABELS_REMOVED runners=$(echo $NAMES); GitHub sends them no new job, queued jobs wait"

while :; do
  BUSY=""
  if TABLE=$(github_runners); then
    for name in $NAMES; do
      [ "$(runner_field "$TABLE" "$name" 4)" = false ] || BUSY="$BUSY $name"
    done
  else
    BUSY=" (could not read GitHub)"
  fi
  if [ -z "$BUSY" ]; then
    OUTPUT=$(vps "bash $REMOTE/runner-pause.sh --labels-removed 90")
    STATUS=$?
    printf '%s\n' "$OUTPUT"
    [ "$STATUS" = 0 ] && break
    if [ "$STATUS" != 2 ]; then
      echo "RUNNER_PAUSE_INCOMPLETE labels=removed services=$(service_states); run pause-runners.sh again, or resume-runners.sh to undo"
      exit 1
    fi
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "RUNNER_PAUSE_INCOMPLETE labels=removed services=$(service_states) busy:${BUSY:- none}; run pause-runners.sh again, or resume-runners.sh to undo"
    exit 2
  fi
  WAITING=${BUSY:- a job the VPS still sees}
  if [ "$WAITING" != "${REPORTED:-}" ]; then
    echo "RUNNER_PAUSE_WAITING for:$WAITING; jobs already running finish first, up to $(((DEADLINE - $(date +%s)) / 60)) more minutes; Ctrl-C keeps the labels removed"
    REPORTED=$WAITING
  fi
  sleep "$POLL"
done

echo "RUNNER_PAUSED labels=removed services=stopped runners=$(echo $NAMES)"
echo "Jobs queued for more than 24 hours fail on GitHub; run resume-runners.sh before then"
