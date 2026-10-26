#!/bin/bash
set -u
umask 022
export PATH=/data/hermes/himawari/tool-audit-round2/r30/tools/bin:/usr/bin:/bin
export HIMAWARI_CI_TOOLS=/data/hermes/himawari/tool-audit-round2/r30/tools
export HIMAWARI_CI_PYTHON=/data/hermes/himawari/tool-audit-round2/r30/tools/python/python/bin/python3
export PLAYWRIGHT_BROWSERS_PATH=/data/hermes/himawari/tool-audit-round2/r30/browsers
[ "$#" -eq 5 ] || { echo "usage: build-cand.sh <bundle> <ref> <revision> <parent> <label>" >&2; exit 64; }
BUNDLE=$1
REF=$2
REV=$3
PARENT=$4
LABEL=$5
SRC=/home/andy/himawari-tests/r2-u1/source
EV=/data/hermes/himawari/tool-audit-round2/r2-u1/evidence
A=/data/hermes/himawari/tool-audit-round2/r2-u1/artifacts/$LABEL
SUM=$EV/$LABEL.summary
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] && [[ "$PARENT" =~ ^[0-9a-f]{40}$ ]] || { echo REVISION_INVALID >&2; exit 64; }
[ -e "$SUM" ] && { echo "LABEL_ALREADY_USED $LABEL" >&2; exit 2; }
[ -e "$A" ] && { echo "ARTIFACT_DIR_EXISTS $A" >&2; exit 2; }
[ "$(hostname)" = hermes-home ] || { echo HOST_UNEXPECTED >&2; exit 66; }
echo "start=$(date -Is) free-before=$(df --output=avail -B1 / | tail -1)" > "$SUM"
sha256sum "$BUNDLE" >> "$SUM"
cd "$SRC" || { echo SOURCE_MISSING >> "$SUM"; exit 3; }
[ -z "$(git status --porcelain --untracked-files=all)" ] || { echo SOURCE_DIRTY >> "$SUM"; exit 3; }
[ "$(git rev-parse HEAD)" = "$PARENT" ] || { echo "SOURCE_HEAD_NOT_PARENT $(git rev-parse HEAD)" >> "$SUM"; exit 3; }
git fetch -q "$BUNDLE" "$REF" || { echo BUNDLE_FETCH_FAILED >> "$SUM"; exit 4; }
[ "$(git rev-parse FETCH_HEAD)" = "$REV" ] || { echo "BUNDLE_HEAD_UNEXPECTED $(git rev-parse FETCH_HEAD)" >> "$SUM"; exit 4; }
git merge-base --is-ancestor "$PARENT" "$REV" || { echo PARENT_NOT_ANCESTOR >> "$SUM"; exit 4; }
git checkout -q --detach "$REV" || { echo CHECKOUT_FAILED >> "$SUM"; exit 4; }
[ "$(git rev-parse HEAD)" = "$REV" ] || { echo HEAD_UNEXPECTED >> "$SUM"; exit 4; }
bash /home/andy/himawari-tests/r2-u1/require-git-modes.sh . >> "$SUM" || { echo GIT_MODES_GATE_FAILED >> "$SUM"; exit 6; }
S=$(mktemp -d /tmp/hXXXX); chmod 700 "$S"
[ "$(stat -c %U:%a "$S")" = "$(id -un):700" ] && [ "$(realpath "$S")" = "$S" ] || { echo SCRATCH_INVALID >> "$SUM"; exit 2; }
export TMPDIR=$S HIMAWARI_TEST_TEMP_ROOT=$S
node scripts/ci/local.mjs --check build --tools "$HIMAWARI_CI_TOOLS" --output ".ci-output/$LABEL" > "$EV/$LABEL.log" 2>&1
RC=$?
echo "build-rc=$RC end=$(date -Is)" >> "$SUM"
mkdir -p "$EV/$LABEL-report"
cp -r ".ci-output/$LABEL/." "$EV/$LABEL-report/" 2>/dev/null
rm -rf "$S" ".ci-output/$LABEL"
ART=$(ls "$EV/$LABEL-report"/build-linux-x64/linux-x64-abi127-"$REV"-*-1.tar.gz 2>/dev/null)
BUILD_STATUS=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["status"])' "$EV/$LABEL-report/build-linux-x64/build/build.json" 2>/dev/null)
VERDICT=$(python3 -I "$(dirname "$BUNDLE")/layer3-verdict.py" "$EV/$LABEL-report/local-summary.json" "$REV" build)
echo "build-status=$BUILD_STATUS artifacts=$(echo "$ART" | grep -c .) verdict=$VERDICT" >> "$SUM"
if [ "$BUILD_STATUS" = passed ] && [ "${VERDICT%% *}" = LAYER3_VERDICT_PASSED ] && [ "$(echo "$ART" | grep -c .)" = 1 ]; then
  mkdir -p "$A"
  cp "$ART" "$A/"
  cp "$EV/$LABEL-report/build-linux-x64/context.json" "$A/context.json"
  [ "$(sha256sum "$A/$(basename "$ART")" | cut -d' ' -f1)" = "$(sha256sum "$ART" | cut -d' ' -f1)" ] || { echo ARTIFACT_COPY_MISMATCH >> "$SUM"; exit 7; }
  find "$EV/$LABEL-report" -name '*.tar.gz' -delete
  echo "free-after=$(df --output=avail -B1 / | tail -1) DONE" >> "$SUM"
  exit 0
fi
echo "free-after=$(df --output=avail -B1 / | tail -1) BUILD_NOT_PASSED" >> "$SUM"
exit 8
