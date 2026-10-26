#!/bin/bash
set -u
umask 022
[ "$#" -eq 2 ] || { echo "usage: run-finalize-checks.sh <packet tar> <old config sha>" >&2; exit 64; }
[ "$(hostname)" = hermes-home ] || { echo HOST_UNEXPECTED >&2; exit 66; }
NODE_DIR=/data/hermes/himawari/tool-audit-round2/r30/tools/bin
export PATH=$NODE_DIR:/usr/bin:/bin
work=$(mktemp -d /home/andy/himawari-tests/twelfth/finalize-XXXXXX)
tar -xzf "$1" -C "$work"
packet=$work/2026-10-26-twelfth-change-packet-01
for f in systemd/S2-stop-and-inspect.py maintenance/S9-control-files.py; do
  [ "$(grep -c "^OLD_CONFIG_SHA = '$2'\$" "$packet/$f")" = 1 ] || { echo "FILLED_VALUE_MISSING $f"; exit 1; }
  sed -i "s/^OLD_CONFIG_SHA = '$2'\$/OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'/" "$packet/$f"
done
mkdir -m 700 "$work/temp"
export HIMAWARI_TEST_TEMP_ROOT=$work/temp
/usr/bin/python3 -I "$packet/signing/verify-finalize-capability-check.py" > "$work/cap.log" 2>&1; echo "CHECK verify-finalize-capability-check rc=$?"
d=$(mktemp -d /tmp/hXXXX); chmod 700 "$d"
/usr/bin/python3 -I "$packet/inputs/verify-finalize-bindings.py" "$NODE_DIR/node" "$d" > "$work/fb.log" 2>&1; echo "CHECK verify-finalize-bindings rc=$?"
rm -rf "$d"
tail -8 "$work/cap.log" | cut -c1-300; tail -15 "$work/fb.log" | cut -c1-400
echo "WORK $work"
