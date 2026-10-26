#!/bin/bash
set -uo pipefail
umask 022
if [[ "$#" -ne 1 ]]; then
  echo "usage: run-release-walkthrough.sh <run id>" >&2
  exit 64
fi
run=$1
here="$(cd "$(dirname "$0")" && pwd)"
setting() { /usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$here/builder.json" "$1"; }
fail() { echo "HERMES_WALKTHROUGH_FAILED $1" >&2; exit "${2:-1}"; }
[[ "$run" =~ ^[a-z0-9-]+$ ]] || fail RUN_ID_INVALID 64
[[ "$(hostname)" == "$(setting hostname)" ]] || fail HOST_UNEXPECTED 66
tools=$(setting tools)
source=$(setting source)
out=$(setting workRoot)/$run
mapfile -t artifacts < <(ls "$out"/materials/linux-x64-abi127-*-1.tar.gz 2>/dev/null)
[[ "${#artifacts[@]}" -eq 1 ]] || fail "ARTIFACT_COUNT ${#artifacts[@]}" 2
revision=$(/usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["testedSha"])' "$out/materials/context.json")
cd "$source" || fail SOURCE_MISSING 3
[[ "$(git rev-parse HEAD)" == "$revision" ]] || fail "SOURCE_NOT_AT_CANDIDATE $(git rev-parse HEAD)" 3
walk=$out/walkthrough
[[ ! -e "$walk" ]] || fail WALKTHROUGH_ALREADY_RUN 2
mkdir -p "$walk"
scratch=$(mktemp -d /tmp/hXXXX)
chmod 700 "$scratch"
export PATH=$tools/bin:/usr/bin:/bin HIMAWARI_CI_TOOLS=$tools HIMAWARI_CI_PYTHON=$tools/python/python/bin/python3 PLAYWRIGHT_BROWSERS_PATH=$(setting browsers)
TMPDIR=$scratch HIMAWARI_TEST_TEMP_ROOT=$scratch HIMAWARI_PRODUCT_PATH_E2E=1 HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL=chromium \
  HIMAWARI_PRODUCT_PATH_OUTPUT="$walk/product-path" HIMAWARI_TEST_ARTIFACT="${artifacts[0]}" HIMAWARI_TEST_CONTEXT="$out/materials/context.json" \
  node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts --project qualification-product-path test/integration/product-path-browser.test.ts \
  -t 'release acceptance in a real browser' --reporter=default --reporter=json --outputFile="$walk/vitest.json" > "$walk/vitest.log" 2>&1
code=$?
rm -rf "$scratch"
[[ -f "$walk/product-path/browser-acceptance.json" ]] || fail "NO_ACCEPTANCE_RECORD vitest-exit=$code" 4
cp "$walk/product-path/browser-acceptance.json" "$walk/browser-acceptance.json"
[[ "$code" -eq 0 ]] || fail "VITEST_EXIT $code" 4
echo "HERMES_WALKTHROUGH_OK $walk/browser-acceptance.json"
