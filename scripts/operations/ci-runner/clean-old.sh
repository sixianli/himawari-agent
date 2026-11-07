#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

STATUS=0
for id in $(installed_runner_ids); do
  runner_select "$id"
  runner_has_job "$RUNNER_USER"
  case $? in
    0) continue ;;
    1) ;;
    *)
      echo "CLEAN_SKIPPED could not check whether $RUNNER_USER is running a job" >&2
      STATUS=1
      continue
      ;;
  esac
  [ -d "$RUNNER_ROOT/runner/_work" ] && find "$RUNNER_ROOT/runner/_work" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf -- {} +
  [ -d "$RUNNER_ROOT/runner/_diag" ] && find "$RUNNER_ROOT/runner/_diag" -type f -mtime +14 -delete
done
exit $STATUS
