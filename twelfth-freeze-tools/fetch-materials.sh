#!/bin/bash
set -euo pipefail
REV=$1
L3=$2
ROOT=$(git rev-parse --show-toplevel)
H=$ROOT/.ci-output/handoff/scripts/hermes-ssh.sh
P=$ROOT/.ci-output/production/2026-10-26-twelfth-change-packet-01
A=/data/hermes/himawari/tool-audit-round2/r2-u1/artifacts/$L3
C=/data/hermes/himawari/tool-audit-round2/r2-l13/candidate-${REV:0:8}
ART=linux-x64-abi127-$REV-
name=$("$H" "ls $A") 
art=$(echo "$name" | grep "^$ART.*-1.tar.gz$")
[ "$(echo "$art" | wc -l | tr -d ' ')" = 1 ] || { echo ARTIFACT_AMBIGUOUS; exit 2; }
proof=$("$H" "grep /source-build-inputs.json\$ $C/SHA256SUMS")
proof_path=${proof#*  }
fetch() { "$H" "cat $1" > "$P/materials/$2.part"; mv "$P/materials/$2.part" "$P/materials/$2"; }
fetch "$A/$art" "$art"
fetch "$A/context.json" context.json
for f in node-modules.tar.gz node-modules.json npm-ls.json; do fetch "$C/installer-dependencies/$f" "$f"; done
fetch "$proof_path" source-build-inputs.json
shasum -a 256 "$P"/materials/*
