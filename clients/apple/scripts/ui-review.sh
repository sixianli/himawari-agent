#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="record"
out="$root/ui-review/latest"
snapshots="$root/Tests/Snapshots/iPhone-390"
device_name="Himawari 390pt"
device_type="com.apple.CoreSimulator.SimDeviceType.iPhone-16e"
expected_width=1170
derived="$root/ui-review/DerivedData"

usage() {
  echo "usage: clients/apple/scripts/ui-review.sh [--check | --approve] [--out DIR]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode="check"; shift ;;
    --approve) mode="approve"; shift ;;
    --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
    *) usage ;;
  esac
done

scenes=()
while IFS= read -r scene; do scenes+=("$scene"); done < <(sed -nE 's/^ *case [a-zA-Z]+ = "([^"]+)"$/\1/p' "$root/Sources/HimawariShell/DemoScenes.swift")
[ ${#scenes[@]} -gt 0 ] || { echo "UI_REVIEW_FAILED no demo scenes found" >&2; exit 1; }
still=()
for appearance in light dark; do
  for scene in "${scenes[@]}"; do
    case "$scene" in motion-*) ;; *) still+=("$scene-$appearance.png") ;; esac
  done
done

missing_in() {
  local dir="$1" name gaps=0
  for name in "${still[@]}"; do
    [ -f "$dir/$name" ] || { echo "UI_REVIEW_MISSING $dir/$name" >&2; gaps=1; }
  done
  return "$gaps"
}

if [ "$mode" = "approve" ]; then
  missing_in "$out" || { echo "UI_REVIEW_FAILED $out does not hold every scene in light and dark; run the screenshots again" >&2; exit 1; }
  mkdir -p "$snapshots"
  rm -f "$snapshots"/*.png
  cp "$out"/*.png "$snapshots"/
  echo "UI_REVIEW_APPROVED $(ls "$snapshots"/*.png | wc -l | tr -d ' ') snapshots -> $snapshots"
  exit 0
fi

command -v xcrun >/dev/null && xcodebuild -version >/dev/null 2>&1 || { echo "UI_REVIEW_FAILED needs Xcode on a Mac (xcodebuild -version failed)" >&2; exit 1; }


xcrun simctl list devicetypes | grep -q "iPhone-16e" || { echo "UI_REVIEW_FAILED iPhone 16e simulator (390 pt wide) is not installed; add it in Xcode > Settings > Components" >&2; exit 1; }
if ! runtime="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | sed -E 's/.* - (com\.apple\.CoreSimulator\.SimRuntime\.[^ ]+).*/\1/')" || [ -z "$runtime" ]; then
  echo "UI_REVIEW_FAILED no iOS simulator runtime installed; add one in Xcode > Settings > Components" >&2
  exit 1
fi

udid="$(xcrun simctl list devices available | grep -F "$device_name (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' || true)"
if [ -z "$udid" ]; then
  udid="$(xcrun simctl create "$device_name" "$device_type" "$runtime")"
fi
echo "UI_REVIEW_BUILD device=$udid"
taskpolicy -b xcodebuild -project "$root/App/Himawari.xcodeproj" -scheme Himawari -configuration Debug \
  -destination "id=$udid" -derivedDataPath "$derived" -jobs 2 \
  COMPILER_INDEX_STORE_ENABLE=NO build -quiet
app="$derived/Build/Products/Debug-iphonesimulator/Himawari.app"
bundle="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"

if ! xcrun simctl list devices booted | grep -qF "$udid"; then
  trap 'xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true' EXIT
fi
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
xcrun simctl install "$udid" "$app"

shots="$out"
if [ "$mode" = "check" ]; then
  shots="$(mktemp -d)"
fi
mkdir -p "$shots"
rm -f "$shots"/*.png "$shots"/*.mp4 "$shots"/*.mov

marker=""
launch() {
  [ -z "$marker" ] || rm -f "$marker"
  xcrun simctl launch --terminate-running-process "$udid" "$bundle" \
    -HimawariDemoScene "$1" -AppleLanguages "(zh-Hans)" -AppleLocale zh_CN >/dev/null
}

shown() {
  [ -f "$marker" ] && [ "$(cat "$marker")" = "$1" ]
}

last_shot=""
inspector="$derived/compare-snapshots"
xcrun swiftc -O "$root/scripts/compare-snapshots.swift" -o "$inspector"
marker="$(xcrun simctl get_app_container "$udid" "$bundle" data)/tmp/$(sed -nE 's/^ *static let shownMarker = "([^"]+)"$/\1/p' "$root/Sources/HimawariShell/DemoScenes.swift")"
case "$marker" in */tmp/?*) ;; *) echo "UI_REVIEW_FAILED cannot locate the scene marker" >&2; exit 1 ;; esac

settle() {
  local scene="$1" file="$2" previous="" current="" tries=0 launches=1
  while :; do
    if shown "$scene"; then
      xcrun simctl io "$udid" screenshot --type=png "$file" >/dev/null
      current="$(shasum -a 256 "$file" | cut -d' ' -f1)"
      if [ "$current" = "$previous" ] && [ "$current" != "$last_shot" ]; then
        last_shot="$current"
        return 0
      fi
      previous="$current"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then
      [ "$launches" -lt 3 ] || { echo "UI_REVIEW_FAILED $file: scene $scene $(shown "$scene" && echo "kept changing or repeated the previous screen" || echo "never reported that it was on screen")" >&2; exit 1; }
      launches=$((launches + 1))
      tries=0
      previous=""
      launch "$scene"
    fi
    sleep 1
  done
}

xcrun simctl spawn "$udid" defaults write com.apple.Preferences DidShowContinuousPathIntroduction -bool true >/dev/null 2>&1 || true
launch "${scenes[0]}"
sleep 8

for appearance in light dark; do
  xcrun simctl ui "$udid" appearance "$appearance"
  sleep 3
  for scene in "${scenes[@]}"; do
    case "$scene" in
      motion-*)
        [ "$mode" = "check" ] && continue
        raw="$shots/$scene-$appearance.mov"
        xcrun simctl io "$udid" recordVideo --codec=h264 --force "$raw" >/dev/null 2>&1 &
        recorder=$!
        sleep 1
        launch "$scene"
        sleep 7
        kill -INT "$recorder"
        wait "$recorder" || true
        if command -v avconvert >/dev/null; then
          avconvert --preset Preset960x540 --source "$raw" --output "$shots/$scene-$appearance.mp4" --replace >/dev/null 2>&1 && rm -f "$raw"
        fi
        ;;
      *)
        launch "$scene"
        file="$shots/$scene-$appearance.png"
        settle "$scene" "$file"
        width="$(sips -g pixelWidth "$file" | awk '/pixelWidth/ {print $2}')"
        [ "$width" = "$expected_width" ] || { echo "UI_REVIEW_FAILED $file is $width px wide, expected $expected_width (390 pt at 3x)" >&2; exit 1; }
        ;;
    esac
  done
done
xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true

if [ "$mode" = "check" ]; then
  missing_in "$snapshots" || { echo "UI_REVIEW_FAILED approved snapshots are missing scenes; review them and run --approve" >&2; exit 1; }
  "$inspector" "$snapshots" "$shots"
  exit $?
fi

echo "UI_REVIEW_DONE $(ls "$shots"/*.png | wc -l | tr -d ' ') screenshots, $(ls "$shots"/*.mp4 "$shots"/*.mov 2>/dev/null | wc -l | tr -d ' ') clips -> $shots"
