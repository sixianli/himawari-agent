#!/bin/bash
set -euo pipefail
umask 077
exec /usr/bin/python3 -I "$(dirname "$0")/rollback.py" "$@"
