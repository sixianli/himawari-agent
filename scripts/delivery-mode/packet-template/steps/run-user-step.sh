#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
test "$#" -eq 1
exec /usr/bin/python3 -I "$(dirname "$0")/run-local-step.py" "$1"
