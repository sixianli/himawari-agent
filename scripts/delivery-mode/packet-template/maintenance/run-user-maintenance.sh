#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
test "$#" -eq 1
case "$1" in
  S3_COPY51|S7_DB_STATUS|S7_CONFIG_APPLY|S7_CATALOG_UPGRADE|S8_READBACK|S9_SIDECAR_TIDY|S9_RAW_RESTORE51) ;;
  *) printf '%s\n' __PKT_LABEL_UPPER___MAINTENANCE_ACTION_INVALID >&2; exit 1 ;;
esac
exec /bin/bash "$(dirname "$0")/../steps/run-user-step.sh" "$1"
