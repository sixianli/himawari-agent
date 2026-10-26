#!/bin/bash
set -u
umask 022
[ "$#" -eq 1 ] || { echo "usage: run-packet-checks.sh <packet tar>" >&2; exit 64; }
[ "$(hostname)" = hermes-home ] || { echo HOST_UNEXPECTED >&2; exit 66; }
NODE_DIR=/data/hermes/himawari/tool-audit-round2/r30/tools/bin
export PATH=$NODE_DIR:/usr/bin:/bin
SRC=/home/andy/himawari-tests/r2-u1/source
work=$(mktemp -d /home/andy/himawari-tests/twelfth/check-XXXXXX)
tar -xzf "$1" -C "$work"
packet=$work/2026-10-26-twelfth-change-packet-01
temp_root=$work/temp
mkdir -m 700 "$temp_root"
export HIMAWARI_TEST_TEMP_ROOT=$temp_root
run() {
  local name=$1; shift
  ( "$@" > "$work/$name.log" 2>&1; echo "CHECK $name rc=$?" > "$work/$name.rc" ) &
}
scratch() { local d; d=$(mktemp -d /tmp/hXXXX); chmod 700 "$d"; echo "$d"; }
for f in maintenance/verify-fixtures.mjs maintenance/verify-raw-copy-fixtures.mjs maintenance/verify-sidecar-tidy-fixtures.mjs s0-db/verify-catalog-runtime-switch.mjs signing/verify-capability-manifest.mjs; do
  run "$(echo "$f" | tr / _)" bash -c "cd '$SRC' && node '$packet/$f'"
done
run systemd_fixtures_verify-doctor.test.mjs bash -c "cd '$SRC' && node --test '$packet/systemd/fixtures/verify-doctor.test.mjs'"
run systemd_verify-switch-config-fixtures.py bash -c "cd '$SRC' && /usr/bin/python3 -I '$packet/systemd/verify-switch-config-fixtures.py' '$NODE_DIR/node'"
for f in maintenance/verify-s9-control-fixtures.py maintenance/verify-s9-raw-tree-fixtures.py install/verify-s9-clean-transport-fixtures.py acceptance/cloud/verify-failure-scene-fixtures.py signing/verify-finalize-capability-check.py; do
  run "$(echo "$f" | tr / _)" /usr/bin/python3 -I "$packet/$f"
done
s1=$(scratch); run steps_verify-steps.py /usr/bin/python3 -I "$packet/steps/verify-steps.py" "$s1"
s2=$(scratch); run inputs_verify-finalize-bindings.py /usr/bin/python3 -I "$packet/inputs/verify-finalize-bindings.py" "$NODE_DIR/node" "$s2"
s3=$(scratch); run inputs_verify-packet-consistency.py /usr/bin/python3 -I "$packet/inputs/verify-packet-consistency.py" "$s3"
run inputs_check-packet-consistency.py /usr/bin/python3 -I "$packet/inputs/check-packet-consistency.py" "$packet"
wait
cat "$work"/*.rc
rm -rf "$s1" "$s2" "$s3"
for log in "$work"/*.log; do echo "== $(basename "$log")"; tail -6 "$log" | cut -c1-400; done
echo "WORK $work"
