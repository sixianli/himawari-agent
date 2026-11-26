#!/bin/bash
set -uo pipefail
if [[ "$#" -ne 3 ]]; then
  echo "usage: install-dependencies-if-changed.sh <source> <tools> <evidence directory>" >&2
  exit 64
fi
source=$1
tools=$2
evidence=$3
marker=$source/.ci-output/installed-package-lock.sha256
wanted=$(sha256sum "$source/package-lock.json" | cut -d ' ' -f 1) || { echo "DEPENDENCY_LOCK_MISSING" >&2; exit 5; }
if [[ -d "$source/node_modules" && -f "$marker" && "$(cat "$marker")" == "$wanted" ]]; then
  echo "dependencies=unchanged lock=$wanted"
  exit 0
fi
rm -f "$marker"
if [[ -e "$evidence" || -e "$evidence.log" ]]; then
  evidence="$evidence-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
(cd "$source" && node scripts/ci/install-dependencies.mjs --root . --tools "$tools" --evidence "$evidence" --cache .ci-output/npm-cache) > "$evidence.log" 2>&1 || { echo "DEPENDENCY_INSTALL_FAILED $evidence.log" >&2; exit 5; }
mkdir -p "$source/.ci-output"
echo "$wanted" > "$marker"
echo "dependencies=reinstalled lock=$wanted"
