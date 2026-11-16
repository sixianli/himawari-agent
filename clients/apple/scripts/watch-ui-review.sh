#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/ui-review/watch-latest"
derived="$root/ui-review/DerivedDataWatch"
device_name="Himawari Watch"
lang="zh-Hans"
bundle="${HIMAWARI_BUNDLE_PREFIX:-win.siyi.himawari.app}.watchkitapp"

usage() {
  echo "usage: clients/apple/scripts/watch-ui-review.sh [--out DIR] [--lang zh-Hans|en|ja]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
    --lang) [ $# -ge 2 ] || usage; lang="$2"; shift 2 ;;
    *) usage ;;
  esac
done

command -v xcrun >/dev/null && xcodebuild -version >/dev/null 2>&1 || { echo "WATCH_UI_REVIEW_FAILED needs Xcode on a Mac" >&2; exit 1; }

case "$lang" in
  zh-Hans) locale="zh_CN" ;;
  en) locale="en_US" ;;
  ja) locale="ja_JP" ;;
  *) usage ;;
esac

scenes=()
while IFS= read -r scene; do scenes+=("$scene"); done < <(sed -nE 's/^ *case [a-zA-Z]+ = "([^"]+)"$/\1/p' "$root/Sources/HimawariWatchUI/WatchDemo.swift")
[ ${#scenes[@]} -gt 0 ] || { echo "WATCH_UI_REVIEW_FAILED no demo scenes found" >&2; exit 1; }

if ! runtime="$(xcrun simctl list runtimes available | grep -E '^watchOS ' | tail -1 | sed -E 's/.* - (com\.apple\.CoreSimulator\.SimRuntime\.[^ ]+).*/\1/')" || [ -z "$runtime" ]; then
  echo "WATCH_UI_REVIEW_FAILED no watchOS simulator runtime installed; add one in Xcode > Settings > Components" >&2
  exit 1
fi
device_type="$(xcrun simctl list devicetypes | grep -E 'Apple Watch' | grep -E '46mm|45mm' | tail -1 | sed -E 's/.*\((com\.apple\.CoreSimulator\.SimDeviceType\.[^)]+)\).*/\1/')"
[ -n "$device_type" ] || { echo "WATCH_UI_REVIEW_FAILED no 45/46 mm Apple Watch simulator type" >&2; exit 1; }

udid="$(xcrun simctl list devices available | grep -F "$device_name (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' || true)"
[ -n "$udid" ] || udid="$(xcrun simctl create "$device_name" "$device_type" "$runtime")"

echo "WATCH_UI_REVIEW_BUILD device=$udid"
taskpolicy -b xcodebuild -project "$root/App/Himawari.xcodeproj" -scheme HimawariWatch -configuration Debug \
  -destination "id=$udid" -derivedDataPath "$derived" -jobs 2 \
  COMPILER_INDEX_STORE_ENABLE=NO build -quiet
app="$derived/Build/Products/Debug-watchsimulator/HimawariWatch.app"
[ -d "$app" ] || { echo "WATCH_UI_REVIEW_FAILED built app not found at $app" >&2; exit 1; }

if ! xcrun simctl list devices booted | grep -qF "$udid"; then
  trap 'xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true' EXIT
fi
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl install "$udid" "$app"

mkdir -p "$out"
rm -f "$out"/*.png
for scene in "${scenes[@]}"; do
  xcrun simctl launch --terminate-running-process "$udid" "$bundle" -HimawariWatchDemoScene "$scene" -AppleLanguages "($lang)" -AppleLocale "$locale" >/dev/null
  sleep 2
  xcrun simctl io "$udid" screenshot "$out/$scene.png" >/dev/null
  echo "WATCH_UI_REVIEW_SHOT $scene"
done
missing=0
for scene in "${scenes[@]}"; do
  [ -s "$out/$scene.png" ] || { echo "WATCH_UI_REVIEW_MISSING $scene" >&2; missing=1; }
done
[ "$missing" = 0 ] || exit 1
echo "WATCH_UI_REVIEW_DONE ${#scenes[@]} scenes -> $out"
