#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
test "$#" -eq 1
case "$1" in
  S9_RAW_RESTORE51) action=S9_RAW_CONTROL51 ;;
  *) printf '%s\n' __PKT_LABEL_UPPER___CONTROL_ROLLBACK_ACTION_INVALID >&2; exit 1 ;;
esac
exec /bin/bash "$(dirname "$0")/../steps/run-user-step.sh" "$action"
