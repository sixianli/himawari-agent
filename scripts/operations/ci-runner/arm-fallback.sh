#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/mac-runners.sh"

case "${1:-}" in
  on | off) WANTED=$1 ;;
  *)
    echo "usage: bash arm-fallback.sh <on|off>   (on lets the check runners installed on the CI VPS take $RUNNER_ARM_LABEL jobs while the ARM machine is down; off undoes it)"
    exit 64
    ;;
esac
[ "$RUNNER_SITE" = vps ] || { echo "ARM_FALLBACK_FAILED run it without RUNNER_SITE: it changes the labels of the CI VPS runners"; exit 64; }

take_lock
upload_runner_scripts || { echo "ARM_FALLBACK_FAILED labels untouched"; exit 1; }
NAMES=$(vps "bash $REMOTE/runner-pause.sh --list") || { echo "ARM_FALLBACK_FAILED could not list the runners installed on $RUNNER_HOST; labels untouched"; exit 1; }
TABLE=$(github_runners) || { echo "ARM_FALLBACK_FAILED could not list runners on GitHub; labels untouched"; exit 1; }
CHECKS=""
FALLBACKS=""
NOT_INSTALLED=""
for id in $RUNNER_IDS; do
  runner_select "$id"
  [ "$RUNNER_LABEL" = "$RUNNER_CHECK_LABEL" ] || continue
  CHECKS="$CHECKS $RUNNER_NAME"
  case " $(echo $NAMES) " in
    *" $RUNNER_NAME "*) ;;
    *) NOT_INSTALLED="$NOT_INSTALLED $RUNNER_NAME"; continue ;;
  esac
  COUNT=$(runner_field "$TABLE" "$RUNNER_NAME" 1 | grep -c .)
  [ "$COUNT" = 1 ] || { echo "ARM_FALLBACK_FAILED GitHub has $COUNT runners named $RUNNER_NAME, $RUNNER_HOST has it installed; labels untouched"; exit 1; }
  FALLBACKS="$FALLBACKS $RUNNER_NAME"
done
[ -z "$NOT_INSTALLED" ] || echo "not installed on $RUNNER_HOST, left out:$NOT_INSTALLED"

carrying() {
  local name found=""
  for name in $CHECKS; do
    has_label "$(runner_field "$1" "$name" 5)" "$RUNNER_ARM_LABEL" && found="$found $name"
  done
  echo $found
}

if [ "$WANTED" = on ]; then
  STRAY=""
  for name in $(carrying "$TABLE"); do
    case " $(echo $FALLBACKS) " in
      *" $name "*) ;;
      *) STRAY="$STRAY $name" ;;
    esac
  done
  [ -z "$STRAY" ] || { echo "ARM_FALLBACK_FAILED$STRAY carries $RUNNER_ARM_LABEL but is not installed on $RUNNER_HOST; run arm-fallback.sh off first; labels untouched"; exit 1; }
  [ -n "$FALLBACKS" ] || { echo "ARM_FALLBACK_FAILED $RUNNER_HOST has no check runner installed; labels untouched"; exit 1; }
  for name in $FALLBACKS; do
    has_label "$(runner_field "$TABLE" "$name" 5)" "$RUNNER_CHECK_LABEL" || {
      echo "ARM_FALLBACK_FAILED $name does not carry $RUNNER_CHECK_LABEL, so the CI VPS runners are paused; run resume-runners.sh first; labels untouched"
      exit 1
    }
  done
  ONLINE=""
  for name in $FALLBACKS; do
    [ "$(runner_field "$TABLE" "$name" 3)" = online ] && ONLINE="$ONLINE $name"
  done
  [ -n "$ONLINE" ] || { echo "ARM_FALLBACK_FAILED none of$FALLBACKS is online on GitHub, so they could not take the jobs either; labels untouched"; exit 1; }
  for name in $FALLBACKS; do
    has_label "$(runner_field "$TABLE" "$name" 5)" "$RUNNER_ARM_LABEL" && continue
    add_label "$(runner_field "$TABLE" "$name" 1)" "$RUNNER_ARM_LABEL" || echo "could not add $RUNNER_ARM_LABEL to $name"
  done
  TABLE=$(github_runners) || TABLE=""
  [ "$(carrying "$TABLE")" = "$(echo $FALLBACKS)" ] || {
    echo "ARM_FALLBACK_FAILED $RUNNER_ARM_LABEL is on:$(carrying "$TABLE" | sed 's/^/ /') but should be on:$FALLBACKS; run arm-fallback.sh on again, or off to undo"
    exit 1
  }
  echo "ARM_FALLBACK_ON$FALLBACKS now also take $RUNNER_ARM_LABEL jobs (online:$ONLINE)"
  echo "run arm-fallback.sh off once the ARM machine is back; while it is on, RUNNER_SITE=arm pause-runners.sh and resume-runners.sh refuse to run"
  exit 0
fi

for name in $(carrying "$TABLE"); do
  remove_label "$(runner_field "$TABLE" "$name" 1)" "$RUNNER_ARM_LABEL" || echo "could not remove $RUNNER_ARM_LABEL from $name"
done
TABLE=$(github_runners) || { echo "ARM_FALLBACK_FAILED could not read GitHub back; check the labels of:$CHECKS"; exit 1; }
for name in $FALLBACKS; do
  [ "$(runner_field "$TABLE" "$name" 1 | grep -c .)" = 1 ] || { echo "ARM_FALLBACK_FAILED could not read $name back"; exit 1; }
done
LEFT=$(carrying "$TABLE")
[ -z "$LEFT" ] || { echo "ARM_FALLBACK_FAILED $RUNNER_ARM_LABEL is still on: $LEFT"; exit 1; }
[ -n "$FALLBACKS" ] || { echo "ARM_FALLBACK_OFF no check runner is installed on $RUNNER_HOST and none carries $RUNNER_ARM_LABEL"; exit 0; }
echo "ARM_FALLBACK_OFF$FALLBACKS take only $RUNNER_CHECK_LABEL jobs"
