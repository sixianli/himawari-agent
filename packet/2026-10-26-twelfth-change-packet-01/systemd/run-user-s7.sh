#!/bin/bash
set -euo pipefail
umask 077
test "$#" -eq 1
case "$1" in
  S7_DB_STATUS|S7_SWITCH_START) ;;
  *) printf '%s\n' TWELFTH_S7_ACTION_INVALID >&2; exit 1 ;;
esac
exec /bin/bash "$(dirname "$0")/../steps/run-user-step.sh" "$1"
