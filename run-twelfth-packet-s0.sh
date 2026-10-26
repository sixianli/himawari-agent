#!/bin/bash
set -euo pipefail
umask 077
if [[ "$#" -ne 0 ]]; then
  echo "usage: bash $0" >&2
  exit 64
fi
cd "$(dirname "$0")/../.."
packet=.ci-output/production/2026-10-26-twelfth-change-packet-01
inputs=$packet/inputs
log=.ci-output/production/2026-10-26-twelfth-change-execution-01
if [[ -e "$packet/freeze-manifest.json" || -L "$packet/freeze-manifest.json" ]]; then
  echo "TWELFTH_S0_PACKET_FROZEN" >&2
  exit 1
fi
mkdir -p "$log"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
host=root@84.247.157.41

require_json_output() {
  if ! /usr/bin/python3 -I -c '
import json, os, sys
if os.path.getsize(sys.argv[1]) == 0:
    sys.exit(1)
try:
    json.load(open(sys.argv[1], "rb"))
except ValueError:
    sys.exit(1)
' "$1"; then
    echo "TWELFTH_S0_OUTPUT_INVALID:$2" >&2
    exit 1
  fi
}

for name in s0-db-readback system-tools-observed npm-observed; do
  if [[ -e "$inputs/$name.json" || -L "$inputs/$name.json" || -e "$inputs/$name.json.partial" ]]; then
    echo "TWELFTH_S0_TARGET_EXISTS:$name" >&2
    exit 1
  fi
done

if ! /usr/bin/python3 -I -c '
import hashlib, re, sys
collector = open(sys.argv[2], "rb").read()
pinned = re.findall(b"verifierSha256: \"([0-9a-f]{64})\"", collector)
sys.exit(0 if len(pinned) == 1 and pinned[0].decode() == hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest() else 1)
' "$packet/signing/cloud-system-tool-bindings.mjs" "$packet/signing/collect-system-tools.mjs"; then
  echo "TWELFTH_S0_VERIFIER_CHANGED" >&2
  exit 1
fi

shasum -a 256 "$packet/s0-db/read-s0-db.mjs" "$packet/signing/collect-system-tools.mjs" "$packet/signing/cloud-system-tool-bindings.mjs" "$packet/acceptance/helpers/observe-production-npm.py" | tee "$log/S0.$stamp.script-sha256.txt"

echo "S0-DB: read-only database readback as himawari-prod"
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$host" 'test "$(hostname)" = vmi3618928 && umask 022 && runuser -u himawari-prod -- env -i HOME=/var/lib/himawari/state PATH=/opt/himawari/node/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/himawari/node/bin/node --no-global-search-paths --input-type=module -' < "$packet/s0-db/read-s0-db.mjs" > "$inputs/s0-db-readback.json.partial" 2> "$log/S0-DB.$stamp.stderr"
require_json_output "$inputs/s0-db-readback.json.partial" s0-db-readback
mv -- "$inputs/s0-db-readback.json.partial" "$inputs/s0-db-readback.json"

echo "S0-TOOLS: read-only system tool identities"
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$host" 'test "$(hostname)" = vmi3618928 && /opt/himawari/node/bin/node --no-global-search-paths --input-type=module -' < "$packet/signing/collect-system-tools.mjs" > "$inputs/system-tools-observed.json.partial" 2> "$log/S0-TOOLS.$stamp.stderr"
require_json_output "$inputs/system-tools-observed.json.partial" system-tools-observed
mv -- "$inputs/system-tools-observed.json.partial" "$inputs/system-tools-observed.json"

echo "S0-NPM: read-only npm observation"
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$host" 'test "$(hostname)" = vmi3618928 && /usr/bin/python3 -I - --approved-twelfth-production-npm-readonly-observation' < "$packet/acceptance/helpers/observe-production-npm.py" > "$inputs/npm-observed.json.partial" 2> "$log/S0-NPM.$stamp.stderr"
require_json_output "$inputs/npm-observed.json.partial" npm-observed
mv -- "$inputs/npm-observed.json.partial" "$inputs/npm-observed.json"

shasum -a 256 "$inputs/s0-db-readback.json" "$inputs/system-tools-observed.json" "$inputs/npm-observed.json" | tee "$log/S0.$stamp.output-sha256.txt"
echo "exit=0"
