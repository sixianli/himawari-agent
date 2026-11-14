#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/ui-review/mac-latest"
derived="$root/ui-review/DerivedData-mac"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "usage: clients/apple/scripts/mac-ui-review.sh [--out DIR]" >&2; exit 2; }; out="$2"; shift 2 ;;
    *) echo "usage: clients/apple/scripts/mac-ui-review.sh [--out DIR]" >&2; exit 2 ;;
  esac
done

xcodebuild -project "$root/App/Himawari.xcodeproj" -scheme HimawariMac -configuration Debug -destination "platform=macOS" -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO build >"$root/ui-review/mac-build.log" 2>&1 || {
  tail -40 "$root/ui-review/mac-build.log" >&2
  echo "MAC_UI_REVIEW_FAILED build; full log: $root/ui-review/mac-build.log" >&2
  exit 1
}
app="$derived/Build/Products/Debug/HimawariMac.app/Contents/MacOS/HimawariMac"
rm -rf "$out"
mkdir -p "$out"
"$app" -HimawariMacDemo "$out" -AppleLanguages "(zh-Hans)" -AppleLocale zh_CN
scenes=$(sed -nE 's/^ *case [a-zA-Z]+ = "([^"]+)"$/\1/p' "$root/Sources/HimawariMacUI/MacDemoScenes.swift")
missing=0
for appearance in light dark; do
  for scene in $scenes; do
    [ -s "$out/$scene-$appearance.png" ] || { echo "MAC_UI_REVIEW_MISSING $scene-$appearance.png" >&2; missing=1; }
  done
done
[ "$missing" -eq 0 ] || exit 1
echo "MAC_UI_REVIEW_DONE $out"
