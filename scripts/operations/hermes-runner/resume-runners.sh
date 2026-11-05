#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

take_lock
upload_runner_scripts || { echo "RUNNER_RESUME_FAILED nothing changed"; exit 1; }
NAMES=$(hermes "bash $REMOTE/runner-pause.sh --list") || { echo "RUNNER_RESUME_FAILED could not list the runners installed on Hermes"; exit 1; }
OUTPUT=$(hermes "bash $REMOTE/runner-resume.sh")
STATUS=$?
printf '%s\n' "$OUTPUT"
[ "$STATUS" = 0 ] || { echo "RUNNER_RESUME_FAILED services did not start; labels untouched, queued jobs keep waiting"; exit 1; }

DEADLINE=$(($(date +%s) + 300))
while :; do
  TABLE=$(github_runners) || TABLE=""
  OFFLINE=""
  for name in $NAMES; do
    [ "$(runner_field "$TABLE" "$name" 3)" = online ] || OFFLINE="$OFFLINE $name"
  done
  [ -z "$OFFLINE" ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "RUNNER_RESUME_INCOMPLETE services=running labels=removed offline:$OFFLINE; run resume-runners.sh again once they are online"
    exit 2
  fi
  sleep "$POLL"
done

for name in $NAMES; do
  has_label "$(runner_field "$TABLE" "$name" 5)" && continue
  add_label "$(runner_field "$TABLE" "$name" 1)" || echo "could not add $LABEL to $name"
done
TABLE=$(github_runners) || TABLE=""
MISSING=""
for name in $NAMES; do
  has_label "$(runner_field "$TABLE" "$name" 5)" || MISSING="$MISSING $name"
done
if [ -n "$MISSING" ]; then
  echo "RUNNER_RESUME_INCOMPLETE services=running $LABEL missing on:$MISSING; queued jobs keep waiting, run resume-runners.sh again"
  exit 1
fi
echo "RUNNER_RESUMED labels=restored runners=$(echo $NAMES)"
