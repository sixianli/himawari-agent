#!/bin/bash
set -uo pipefail

if [ $# -ne 1 ]; then
  echo "usage: DOCKER='docker --context orbstack' sleep-probe.sh <output-dir>" >&2
  exit 2
fi
OUT=$1
DOCKER=${DOCKER:-docker}
IMAGE=${IMAGE:-docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e}
DEADLINE=${DEADLINE:-900}
LIMIT=${LIMIT:-3600}
PREFIX=himawari-p0-sleep-$(date -u +%Y%m%d%H%M%S)
SEC=(--restart=no --network none --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 16 --memory 64m --read-only --user 2001:2001 --label "himawari.probe=$PREFIX")
d() { $DOCKER "$@"; }
stopped() { [ "$(d inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = false ]; }

mkdir -p "$OUT"
start=$(date +%s)
d run -d --name "$PREFIX-monotonic" "${SEC[@]}" "$IMAGE" sleep "$DEADLINE" > /dev/null
d run -d --name "$PREFIX-wallclock" "${SEC[@]}" "$IMAGE" sh -c \
  "end=\$((\$(date +%s) + $DEADLINE)); while [ \$(date +%s) -lt \$end ]; do sleep 1; done" > /dev/null
{
  echo "prefix=$PREFIX deadline=${DEADLINE}s host_start=$start ($(date -u -r "$start" +%FT%TZ 2>/dev/null || date -u -d "@$start" +%FT%TZ))"
  echo "vm_clock_minus_host_at_start=$(( $(d run --rm "${SEC[@]}" "$IMAGE" date +%s) - $(date +%s) ))s"
} > "$OUT/sleep-environment.txt"

mono_end=""; wall_end=""; previous=$start
: > "$OUT/sleep-host-ticks.log"
while :; do
  now=$(date +%s)
  gap=$((now - previous))
  [ "$gap" -gt 5 ] && echo "gap host=$previous..$now seconds=$gap" >> "$OUT/sleep-host-ticks.log"
  previous=$now
  [ -z "$mono_end" ] && stopped "$PREFIX-monotonic" && mono_end=$now
  [ -z "$wall_end" ] && stopped "$PREFIX-wallclock" && wall_end=$now
  [ -n "$mono_end" ] && [ -n "$wall_end" ] && break
  [ $((now - start)) -gt "$LIMIT" ] && break
  sleep 1
done

{
  for c in monotonic wallclock; do
    d inspect "$PREFIX-$c" --format "$c status={{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}"
  done
  echo "monotonic_host_observed_elapsed=$(( ${mono_end:-0} - start ))s"
  echo "wallclock_host_observed_elapsed=$(( ${wall_end:-0} - start ))s"
  echo "vm_clock_minus_host_at_end=$(( $(d run --rm "${SEC[@]}" "$IMAGE" date +%s) - $(date +%s) ))s"
  echo "host_gaps_over_5s:"; cat "$OUT/sleep-host-ticks.log"
  if command -v pmset > /dev/null; then
    echo "pmset_sleep_wake_log:"
    pmset -g log | grep -E '^[0-9-]+ [0-9:]+ [+-][0-9]{4} (Sleep|Wake|DarkWake) ' | awk -v s="$(date -r "$start" '+%Y-%m-%d %H:%M:%S')" '($1" "$2) >= s' | cut -c1-160
  fi
} > "$OUT/sleep-result.txt" 2>&1
d rm -f $(d ps -aq --filter "label=himawari.probe=$PREFIX") > /dev/null 2>&1
d ps -a --filter "label=himawari.probe=$PREFIX" --format '{{.Names}}' > "$OUT/sleep-containers-after-cleanup.txt"
cat "$OUT/sleep-environment.txt" "$OUT/sleep-result.txt"
