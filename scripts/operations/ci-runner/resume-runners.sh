#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

take_lock
upload_runner_scripts || { echo "RUNNER_RESUME_FAILED labels and services untouched"; exit 1; }
NAMES=$(vps "bash $REMOTE/runner-pause.sh --list") || { echo "RUNNER_RESUME_FAILED could not list the runners installed on $RUNNER_HOST; labels and services untouched"; exit 1; }
TABLE=$(github_runners) || { echo "RUNNER_RESUME_FAILED could not list runners on GitHub; labels and services untouched"; exit 1; }
REASON=$(reconcile_runners "$NAMES" "$TABLE") || { echo "RUNNER_RESUME_FAILED $REASON; labels and services untouched"; exit 1; }

interrupted() {
  echo "RUNNER_RESUME_INCOMPLETE interrupted services=$(service_states) labels: $(label_states "$NAMES" "$(github_runners)"); run resume-runners.sh again"
  exit 130
}

trap interrupted INT TERM HUP
for name in $NAMES; do
  OWN=$(own_label "$name") || continue
  has_label "$(runner_field "$TABLE" "$name" 5)" "$OWN" && continue
  add_label "$(runner_field "$TABLE" "$name" 1)" "$OWN" || echo "could not add $OWN to $name"
done
TABLE=$(github_runners) || TABLE=""
STATES=$(label_states "$NAMES" "$TABLE")
case " $STATES " in
  *=mixed\ *)
    echo "RUNNER_RESUME_INCOMPLETE labels: $STATES; a runner carries a label that belongs to another runner, services not started; remove that label on GitHub, then run resume-runners.sh again"
    exit 1
    ;;
  *=off\ * | *=unread\ * | *=foreign\ *)
    echo "RUNNER_RESUME_INCOMPLETE labels: $STATES; services not started, queued jobs keep waiting, run resume-runners.sh again"
    exit 1
    ;;
esac

OUTPUT=$(vps "bash $REMOTE/runner-resume.sh")
STATUS=$?
printf '%s\n' "$OUTPUT"
[ "$STATUS" = 0 ] || { echo "RUNNER_RESUME_FAILED services=$(service_states) labels=restored; queued jobs keep waiting until the services start"; exit 1; }

DEADLINE=$(($(date +%s) + 300))
while :; do
  OFFLINE=""
  if TABLE=$(github_runners); then
    for name in $NAMES; do
      [ "$(runner_field "$TABLE" "$name" 3)" = online ] || OFFLINE="$OFFLINE $name"
    done
  else
    OFFLINE=" (could not read GitHub)"
  fi
  [ -z "$OFFLINE" ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "RUNNER_RESUME_INCOMPLETE services=$(service_states) labels=restored offline:$OFFLINE; run resume-runners.sh again once they are online"
    exit 2
  fi
  sleep "$POLL"
done
echo "RUNNER_RESUMED labels=restored runners=$(echo $NAMES)"
