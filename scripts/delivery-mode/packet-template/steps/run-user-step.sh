#!/bin/bash
set -euo pipefail
umask 077
test "$#" -eq 1
exec /usr/bin/python3 -I "$(dirname "$0")/run-local-step.py" "$1"
