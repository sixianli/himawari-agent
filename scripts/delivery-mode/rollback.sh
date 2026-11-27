#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
if [[ "$#" -eq 1 && -d "$1" ]]; then
  mkdir -p "$1/run-logs"
  log="$1/run-logs/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
  echo "ROLLBACK_LOG $log"
  /usr/bin/python3 -I "$(dirname "$0")/rollback.py" "$@" 2>&1 | tee -a "$log"
  exit "${PIPESTATUS[0]}"
fi
exec /usr/bin/python3 -I "$(dirname "$0")/rollback.py" "$@"
