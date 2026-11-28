#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
test "$#" -eq 1
case "$1" in
  S7_DB_STATUS|S7_SWITCH_START) ;;
  *) printf '%s\n' __PKT_LABEL_UPPER___S7_ACTION_INVALID >&2; exit 1 ;;
esac
exec /bin/bash "$(dirname "$0")/../steps/run-user-step.sh" "$1"
