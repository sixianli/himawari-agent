#!/bin/bash
set -uo pipefail
umask 022
if [[ "$#" -ne 3 ]]; then
  echo "usage: build-candidate.sh <source bundle> <revision> <run id>" >&2
  exit 64
fi
bundle=$1
revision=$2
run=$3
here="$(cd "$(dirname "$0")" && pwd)"
setting() { /usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$here/builder.json" "$1"; }
fail() { echo "HERMES_BUILD_FAILED $1" >&2; exit "${2:-1}"; }
helper() { echo "$here/$(setting "$1")"; }
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail REVISION_INVALID 64
[[ "$run" =~ ^[a-z0-9-]+$ ]] || fail RUN_ID_INVALID 64
[[ "$(hostname)" == "$(setting hostname)" ]] || fail HOST_UNEXPECTED 66
exec 9> "$(setting lockFile)"
/usr/bin/flock -n 9 || fail BUILDER_BUSY 75
tools=$(setting tools)
source=$(setting source)
out=$(setting workRoot)/$run
capture=$(setting evidenceRoot)/sixth-source-inputs-$run
export PATH=$tools/bin:/usr/bin:/bin HIMAWARI_CI_TOOLS=$tools HIMAWARI_CI_PYTHON=$tools/python/python/bin/python3 PLAYWRIGHT_BROWSERS_PATH=$(setting browsers)
for required in "$here/install-dependencies-if-changed.sh" "$(helper gitModesCheck)" "$(helper captureTemplate)" "$(helper installerDependencyCollector)" "$(setting pythonMaterial)"; do
  [[ -f "$required" ]] || fail "HELPER_MISSING $required" 2
done
[[ ! -e "$out" && ! -e "$capture" ]] || fail "RUN_ID_ALREADY_USED $run" 2
mkdir -p "$out/report" "$out/materials"
echo "start=$(date -Is) free-data=$(df --output=avail -B1 "$out" | tail -n 1) free-root=$(df --output=avail -B1 / | tail -n 1)" > "$out/summary"
cd "$source" || fail SOURCE_MISSING 3
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || fail SOURCE_DIRTY 3
git fetch -q "$bundle" HEAD || fail BUNDLE_FETCH_FAILED 4
[[ "$(git rev-parse FETCH_HEAD)" == "$revision" ]] || fail "BUNDLE_HEAD_UNEXPECTED $(git rev-parse FETCH_HEAD)" 4
git checkout -q --detach "$revision" || fail CHECKOUT_FAILED 4
bash "$(helper gitModesCheck)" . >> "$out/summary" || fail GIT_MODES_GATE_FAILED 6
bash "$here/install-dependencies-if-changed.sh" "$source" "$tools" "$(setting evidenceRoot)/install-$run" >> "$out/summary" || fail DEPENDENCY_INSTALL_FAILED 5
scratch=$(mktemp -d /tmp/hXXXX)
chmod 700 "$scratch"
TMPDIR=$scratch HIMAWARI_TEST_TEMP_ROOT=$scratch node scripts/ci/local.mjs --check build --tools "$tools" --output ".ci-output/$run" > "$out/build.log" 2>&1
echo "build-rc=$? end=$(date -Is)" >> "$out/summary"
cp -r ".ci-output/$run/." "$out/report/"
rm -rf "$scratch" ".ci-output/$run"
arch=$(setting arch)
report=$out/report/build-linux-$arch
/usr/bin/python3 -I "$here/layer3-verdict.py" "$out/report/local-summary.json" "$revision" build >> "$out/summary" || fail BUILD_NOT_PASSED 8
mapfile -t artifacts < <(ls "$report"/linux-"$arch"-abi[0-9]*-"$revision"-*-1.tar.gz 2>/dev/null)
[[ "${#artifacts[@]}" -eq 1 ]] || fail "ARTIFACT_COUNT ${#artifacts[@]}" 8
artifact=$out/materials/$(basename "${artifacts[0]}")
cp "${artifacts[0]}" "$artifact"
cp "$report/context.json" "$out/materials/context.json"
digest=$(/usr/bin/python3 -I - "$report/build/build.json" "$artifact" "$out/materials/context.json" "$revision" <<'EOF'
import hashlib, json, os, sys
build = json.load(open(sys.argv[1]))
artifact, context = sys.argv[2], sys.argv[3]
assert build["status"] == "passed"
assert build["archiveSha256"] == hashlib.sha256(open(artifact, "rb").read()).hexdigest()
assert build["archiveBytes"] == os.path.getsize(artifact)
assert build["manifest"]["context"]["testedSha"] == sys.argv[4]
assert json.load(open(context))["testedSha"] == sys.argv[4]
print(build["manifest"]["sourceTreeSha256"])
EOF
) || fail BUILD_RECORD_MISMATCH 8
mkdir -m 700 "$capture"
sed -e "s/__EXPECTED_DIGEST__/$digest/" -e "s/__REVISION__/$revision/" -e "s|/sixth-source-inputs-01|/sixth-source-inputs-$run|g" -e "s|__BUILDER_SOURCE__|$source|g" -e "s|__BUILDER_EVIDENCE_ROOT__|$(setting evidenceRoot)|g" -e "s|__BUILDER_HOME__|$HOME|g" -e "s/__BUILDER_UID__/$(id -u)/g" -e "s/__BUILDER_ARCH__/$arch/g" -e "s/__BUILDER_HOSTNAME__/$(setting hostname)/g" "$(helper captureTemplate)" > "$capture/capture-build-source-inputs.mjs"
grep -q "const tool = \"$capture/capture-build-source-inputs.mjs\";" "$capture/capture-build-source-inputs.mjs" || fail CAPTURE_TOOL_PATH_MISMATCH 2
sed -e "s/__PKT_COMMIT__/$revision/" -e "s/__PKT_NODE_ARCH__/$arch/" "$(helper installerDependencyCollector)" > "$out/collect-installer-dependencies.mjs"
! grep -q "__REVISION__\|__EXPECTED_DIGEST__\|__BUILDER_\|__PKT_\|sixth-source-inputs-01" "$capture/capture-build-source-inputs.mjs" "$out/collect-installer-dependencies.mjs" || fail HELPER_PLACEHOLDER_LEFT 2
(cd / && node "$capture/capture-build-source-inputs.mjs" > "$capture/capture.stdout" 2> "$capture/capture.stderr") || fail CAPTURE_FAILED 3
cp "$capture/source-build-inputs.json" "$out/materials/source-build-inputs.json"
node "$out/collect-installer-dependencies.mjs" --source-root "$source" --modules-root "$source/node_modules" --output "$out/installer-dependencies" --npm-cli "$tools/npm/package/bin/npm-cli.js" > "$out/collect.stdout" 2> "$out/collect.stderr" || fail COLLECT_FAILED 4
for name in node-modules.tar.gz node-modules.json npm-ls.json; do
  cp "$out/installer-dependencies/$name" "$out/materials/$name"
done
rm -rf "$out/installer-dependencies"
cp "$(setting pythonMaterial)" "$out/materials/python-3.12.10.tar.gz"
find "$out/report" -name '*.tar.gz' -delete
(cd "$out/materials" && sha256sum -- * > ../SHA256SUMS)
echo "end=$(date -Is) free-data=$(df --output=avail -B1 "$out" | tail -n 1) free-root=$(df --output=avail -B1 / | tail -n 1)" >> "$out/summary"
echo "HERMES_BUILD_OK $out"
