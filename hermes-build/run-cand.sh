#!/bin/bash
set -euo pipefail
umask 022
export PATH=/data/hermes/himawari/tool-audit-round2/r30/tools/bin:/usr/bin:/bin
[ "$#" -eq 2 ] || { echo "usage: run-cand.sh <revision> <l3-label>" >&2; exit 64; }
REV=$1
L=$2
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || { echo REVISION_INVALID; exit 64; }
S=$HOME/himawari-tests/r2-u1/source
EV=/data/hermes/himawari/tool-audit-round2/r2-u1/evidence
A=/data/hermes/himawari/tool-audit-round2/r2-u1/artifacts/$L
B=$EV/$L-report/build-linux-x64
OUT=/data/hermes/himawari/tool-audit-round2/r2-l13/candidate-${REV:0:8}
CAP=$EV/sixth-source-inputs-${REV:0:8}
NPM=/data/hermes/himawari/tool-audit-round2/r30/tools/npm/package/bin/npm-cli.js
PY=/data/hermes/himawari/tool-audit-round2/r30/evidence/cloud-transfer/formal-materials-01/python-3.12.10.tar.gz

[ -f "$OUT/capture-build-source-inputs.template.mjs" ] && [ -f "$OUT/collect-installer-dependencies.mjs" ] || { echo TEMPLATES_MISSING; exit 2; }
cd "$S"
[ "$(git rev-parse HEAD)" = "$REV" ] || { echo SOURCE_HEAD_DIFFERENT; exit 2; }
[ -z "$(git status --porcelain --untracked-files=all)" ] || { echo SOURCE_DIRTY; exit 2; }
ART=$(ls "$A"/linux-x64-abi127-$REV-*-1.tar.gz)
[ "$(echo "$ART" | wc -l)" = 1 ]
cmp "$A/context.json" "$B/context.json"

python3 -I - "$B/build/build.json" "$ART" "$B/context.json" "$REV" > "$OUT/candidate-build.json" <<'EOF'
import hashlib, json, os, sys
build = json.load(open(sys.argv[1]))
art, ctx = sys.argv[2], sys.argv[3]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
assert build["status"] == "passed"
assert build["archiveSha256"] == sha(art) and build["archiveBytes"] == os.path.getsize(art)
assert build["manifest"]["context"]["testedSha"] == sys.argv[4]
print(json.dumps({
    "artifactName": os.path.basename(art), "artifactSha256": build["archiveSha256"], "artifactBytes": build["archiveBytes"],
    "contextSha256": sha(ctx), "contextBytes": os.path.getsize(ctx),
    "sourceTreeSha256": build["manifest"]["sourceTreeSha256"], "manifestFiles": len(build["manifest"]["files"]),
}, indent=2))
EOF
DIGEST=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["sourceTreeSha256"])' "$OUT/candidate-build.json")

rm -rf "$OUT/runtime-sandbox-dist"
mkdir -p "$OUT/runtime-sandbox-dist"
for f in job-host-main.js sandbox-sdk.js sandbox-sdk-worker.js; do
  M=$(tar -tzf "$ART" | grep -E "(^|/)runtime-sandbox/dist/$f\$")
  [ "$(echo "$M" | wc -l)" = 1 ] || { echo "DIST_MEMBER_AMBIGUOUS $f"; exit 2; }
  tar -xzf "$ART" -O "$M" > "$OUT/runtime-sandbox-dist/$f"
  echo "$M $(sha256sum "$OUT/runtime-sandbox-dist/$f" | cut -d' ' -f1)" >> "$OUT/runtime-sandbox-dist/members.txt"
done

[ ! -e "$CAP" ]
mkdir -m 700 "$CAP"
sed -e "s/__EXPECTED_DIGEST__/$DIGEST/" -e "s/__REVISION__/$REV/" -e "s|/evidence/sixth-source-inputs-01|/evidence/sixth-source-inputs-${REV:0:8}|g" "$OUT/capture-build-source-inputs.template.mjs" > "$CAP/capture-build-source-inputs.mjs"
! grep -q "sixth-source-inputs-01" "$CAP/capture-build-source-inputs.mjs" || { echo CAPTURE_PATH_LEFT; exit 2; }
grep -q "const tool = \"$CAP/capture-build-source-inputs.mjs\";" "$CAP/capture-build-source-inputs.mjs" || { echo CAPTURE_TOOL_PATH_MISMATCH; exit 2; }
sed "s/__REVISION__/$REV/" "$OUT/collect-installer-dependencies.mjs" > "$OUT/collect-installer-dependencies.run.mjs"
! grep -q "__REVISION__\|__EXPECTED_DIGEST__" "$CAP/capture-build-source-inputs.mjs" "$OUT/collect-installer-dependencies.run.mjs" || { echo PLACEHOLDER_LEFT; exit 2; }
(cd / && node "$CAP/capture-build-source-inputs.mjs" > "$CAP/capture.stdout" 2> "$CAP/capture.stderr") || { echo CAPTURE_FAILED; tail -5 "$CAP/capture.stderr"; exit 3; }
python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["passed"] is True;print("capture records",len(d["records"]),sorted({r["mode"] for r in d["records"]}))' "$CAP/source-build-inputs.json"

[ ! -e "$OUT/installer-dependencies" ]
node "$OUT/collect-installer-dependencies.run.mjs" --source-root "$S" --modules-root "$S/node_modules" --output "$OUT/installer-dependencies" --npm-cli "$NPM" > "$OUT/collect.stdout" 2> "$OUT/collect.stderr" || { echo COLLECT_FAILED; tail -5 "$OUT/collect.stderr"; exit 4; }
du -sb "$OUT/installer-dependencies/payload" "$OUT/installer-dependencies/npm-cache" 2>/dev/null > "$OUT/installer-dependencies-removed.txt" || true
rm -rf "$OUT/installer-dependencies/payload" "$OUT/installer-dependencies/npm-cache"
cp "$PY" "$OUT/python-3.12.10.tar.gz"
cd "$OUT"
sha256sum "$ART" "$B/context.json" "$CAP/source-build-inputs.json" installer-dependencies/node-modules.tar.gz installer-dependencies/node-modules.json installer-dependencies/npm-ls.json python-3.12.10.tar.gz runtime-sandbox-dist/*.js > SHA256SUMS
stat -c '%s %n' "$ART" "$B/context.json" "$CAP/source-build-inputs.json" installer-dependencies/node-modules.tar.gz installer-dependencies/node-modules.json installer-dependencies/npm-ls.json python-3.12.10.tar.gz > BYTES
cat candidate-build.json SHA256SUMS BYTES
echo CAND_OK
