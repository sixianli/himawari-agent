#!/bin/bash
set -uo pipefail
umask 022
if [[ "$#" -ne 1 ]]; then
  echo "usage: run-release-walkthrough.sh <run id> | --preflight" >&2
  exit 64
fi
here="$(cd "$(dirname "$0")" && pwd)"
setting() { /usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$here/builder.json" "$1"; }
fail() { echo "HERMES_WALKTHROUGH_FAILED $1" >&2; exit "${2:-1}"; }
[[ "$(hostname)" == "$(setting hostname)" ]] || fail HOST_UNEXPECTED 66
tools=$(setting tools)
source=$(setting source)
browsers=$(setting browsers)
toolbin=$(setting piToolBin)
python=$tools/python/python/bin/python3
[[ -x "$tools/bin/node" ]] || fail "NODE_MISSING $tools/bin/node" 5
locked_python=$(/usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["python"]["version"])' "$(setting source)/ci/toolchain-lock.json")
[[ "$("$python" --version 2>&1)" == "Python $locked_python" ]] || fail "LOCKED_PYTHON_MISSING $python" 5
[[ -d "$browsers" ]] || fail "BROWSERS_MISSING $browsers" 5
[[ -x "$toolbin/fd" ]] || fail "PI_TOOL_MISSING $toolbin/fd" 5
PATH="$toolbin:/usr/bin:/bin" command -v rg > /dev/null || fail "PI_TOOL_MISSING rg" 5
git -C "$source" rev-parse HEAD > /dev/null 2>&1 || fail "SOURCE_MISSING $source" 3
[[ -f "$source/package.json" ]] || fail "SOURCE_TREE_EMPTY $source" 3
if [[ "$1" == "--preflight" ]]; then
  echo "HERMES_WALKTHROUGH_PREFLIGHT_OK"
  exit 0
fi
run=$1
[[ "$run" =~ ^[a-z0-9-]+$ ]] || fail RUN_ID_INVALID 64
out=$(setting workRoot)/$run
mapfile -t artifacts < <(ls "$out"/materials/linux-"$(setting arch)"-abi[0-9]*-*-1.tar.gz 2>/dev/null)
[[ "${#artifacts[@]}" -eq 1 ]] || fail "ARTIFACT_COUNT ${#artifacts[@]}" 2
revision=$(/usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["testedSha"])' "$out/materials/context.json")
cd "$source" || fail SOURCE_MISSING 3
[[ "$(git rev-parse HEAD)" == "$revision" ]] || fail "SOURCE_NOT_AT_CANDIDATE $(git rev-parse HEAD)" 3
walk=$out/walkthrough
[[ ! -e "$walk" ]] || fail WALKTHROUGH_ALREADY_RUN 2
mkdir -p "$walk"
scratch=$(mktemp -d /tmp/hXXXX)
chmod 700 "$scratch"
export PATH=$tools/bin:/usr/bin:/bin HIMAWARI_CI_TOOLS=$tools HIMAWARI_CI_PYTHON=$python PLAYWRIGHT_BROWSERS_PATH=$browsers HIMAWARI_TEST_PI_TOOLBIN=$toolbin
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
