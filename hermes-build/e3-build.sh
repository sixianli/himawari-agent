#!/bin/bash
set -u
umask 022
E=/home/andy/himawari-tests/eleventh
T=/home/andy/himawari-tests/tenth
REV=470b6d30a8664d5f85da2a8b261b59a4f5f18704
PARENT=aa563155f23f783e1fd2e7adb34f252dcddce980
LABEL=cc-build-470b6d30-r1
export PATH=/data/hermes/himawari/tool-audit-round2/r30/tools/bin:/usr/bin:/bin
TOOLS=/data/hermes/himawari/tool-audit-round2/r30/tools
SRC=/home/andy/himawari-tests/r2-u1/source
OUT=/data/hermes/himawari/tool-audit-round2/r2-l13/candidate-470b6d30
echo "start=$(date -Is) free=$(df --output=avail -B1 / | tail -1)"
bash $E/build-cand.sh /home/andy/himawari-tests/eleventh/hotfix12b.bundle claude/eleventh-hotfix $REV $PARENT $LABEL
echo BUILD_EXIT=$?
echo "free-after-build=$(df --output=avail -B1 / | tail -1)"
mkdir -p "$OUT"
cp /data/hermes/himawari/tool-audit-round2/r2-l13/candidate-aa563155/capture-build-source-inputs.template.mjs /data/hermes/himawari/tool-audit-round2/r2-l13/candidate-aa563155/collect-installer-dependencies.mjs "$OUT/"
bash $E/run-cand.sh $REV $LABEL > $E/run-cand-470b6d30.out 2>&1
echo RUNCAND_EXIT=$?
export HIMAWARI_CI_PYTHON=$TOOLS/python/python/bin/python3
R=/data/hermes/himawari/tool-audit-round2/r2-u1/evidence/$LABEL-report/build-linux-x64
PREFIX=/data/hermes/himawari/tool-audit-round2/r2-l13/prefix-470b6d30
ART=$(ls /data/hermes/himawari/tool-audit-round2/r2-u1/artifacts/$LABEL/linux-x64-abi127-470b6d30*-1.tar.gz)
SUM=$(sha256sum "$ART" | cut -d' ' -f1)
(cd / && node --no-global-search-paths $SRC/scripts/install-node-runtime.mjs --artifact "$ART" --context $R/context.json --expected-sha256 "$SUM" --prefix "$PREFIX") > $E/install-prefix-470b6d30.log 2>&1
echo "PREFIX_INSTALL_EXIT=$?"
B=$PREFIX/lib/himawari-agent/pi-tools/bin
mkdir -p "$B"
install -m 755 "$(readlink -f $TOOLS/bin/node)" "$B/node"
for x in fd rg; do install -m 755 "$T/prod-pitools/$x" "$B/$x"; done
install -m 755 /usr/bin/bash "$B/bash"
ls -la "$B"
echo "free-end=$(df --output=avail -B1 / | tail -1)"
echo E3_DONE
