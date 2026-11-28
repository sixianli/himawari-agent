#!/bin/bash
set -euo pipefail
log="${1:?usage: open-ops-diagnostics.sh <ops log> <private key>}"
private_key="${2:?usage: open-ops-diagnostics.sh <ops log> <private key>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sed -E 's/^[0-9T:.Z-]+ //' "$log" > "$work/log"
sed -n 's/^OPS_SEALED_KEY //p' "$work/log" | tail -1 | base64 -d > "$work/key.sealed"
sed -n '/^OPS_SEALED_BEGIN$/,/^OPS_SEALED_END/p' "$work/log" | sed '1d;$d' | base64 -d | gunzip > "$work/body"
openssl pkeyutl -decrypt -inkey "$private_key" -pkeyopt rsa_padding_mode:oaep -in "$work/key.sealed" -out "$work/key"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$work/key" -in "$work/body"
