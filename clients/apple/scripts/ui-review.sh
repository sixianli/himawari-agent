#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/scripts/xcode-cache.sh"
mode="record"
out="$himawari_apple_cache/ui-review/latest"
snapshots="$root/Tests/Snapshots/iPhone-390"
device_name="Himawari 390pt"
device_type="com.apple.CoreSimulator.SimDeviceType.iPhone-16e"
expected_width=1170
only=""
text_size=""
calm_below=40
calm_patience=600
prompt_wait=5

usage() {
  echo "usage: clients/apple/scripts/ui-review.sh [--check | --approve] [--out DIR] [--only SCENE,SCENE] [--text-size UICTContentSizeCategory...]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode="check"; shift ;;
    --approve) mode="approve"; shift ;;
    --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
    --only) [ $# -ge 2 ] || usage; only=",$2,"; shift 2 ;;
    --text-size) [ $# -ge 2 ] || usage; text_size="$2"; shift 2 ;;
    *) usage ;;
  esac
done

scenes=()
while IFS= read -r scene; do scenes+=("$scene"); done < <(sed -nE 's/^ *case [a-zA-Z]+ = "([^"]+)"$/\1/p' "$root/Sources/HimawariShell/DemoScenes.swift")
[ ${#scenes[@]} -gt 0 ] || { echo "UI_REVIEW_FAILED no demo scenes found" >&2; exit 1; }
warm_up=""
for scene in "${scenes[@]}"; do
  case "$scene" in motion-*) ;; *) warm_up="$scene"; break ;; esac
done
[ -n "$warm_up" ] || { echo "UI_REVIEW_FAILED no still demo scene to warm up with" >&2; exit 1; }
if [ -n "$text_size" ] && [ "$mode" != "record" ]; then
  echo "UI_REVIEW_FAILED --text-size works only when recording; --check and --approve compare against the default size" >&2; exit 1
fi
if [ -n "$only" ]; then
  [ "$mode" = "record" ] || { echo "UI_REVIEW_FAILED --only works only when recording; --check and --approve need every scene" >&2; exit 1; }
  chosen=()
  for scene in "${scenes[@]}"; do
    case "$only" in *",$scene,"*) chosen+=("$scene") ;; esac
  done
  [ "${#chosen[@]}" -gt 0 ] && [ "${#chosen[@]}" -eq "$(printf '%s' "$only" | tr ',' '\n' | grep -c .)" ] || { echo "UI_REVIEW_FAILED --only names a scene that does not exist or names one twice; scenes: ${scenes[*]}" >&2; exit 1; }
  scenes=("${chosen[@]}")
fi
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
  staged="$(dirname "$snapshots")/.approve-$$"
  previous="$(dirname "$snapshots")/.previous-$$"
  rm -rf "$staged" "$previous"
  mkdir -p "$staged"
  cp "$out"/*.png "$staged"/
  missing_in "$staged" || { rm -rf "$staged"; echo "UI_REVIEW_FAILED copying the screenshots into $staged lost some; snapshots left as they were" >&2; exit 1; }
  [ ! -d "$snapshots" ] || mv "$snapshots" "$previous"
  if ! mv "$staged" "$snapshots"; then
    rm -rf "$staged"
    if [ -d "$previous" ] && ! mv "$previous" "$snapshots"; then
      echo "UI_REVIEW_FAILED could not move $staged into $snapshots, and the old snapshots stayed in $previous; move them back by hand" >&2
      exit 1
    fi
    echo "UI_REVIEW_FAILED could not move $staged into $snapshots; the old snapshots were put back" >&2
    exit 1
  fi
  rm -rf "$previous"
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
shutdown_simulator=""
shots=""
cleanup() {
  local status=$?
  [ -z "$shutdown_simulator" ] || xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  if [ "$mode" = "check" ] && [ -n "$shots" ]; then
    if [ "$status" -eq 0 ]; then rm -rf "$shots"; else echo "UI_REVIEW_CHECK_KEPT $shots (screenshots from the failed check, left for diagnosis)" >&2; fi
  fi
  himawari_release_lock
}
trap cleanup EXIT
himawari_lock_derived_data ios
derived="$himawari_locked_derived"
echo "UI_REVIEW_BUILD device=$udid derived=$derived"
taskpolicy -b xcodebuild -project "$root/App/Himawari.xcodeproj" -scheme Himawari -configuration Debug \
  -destination "id=$udid" -derivedDataPath "$derived" -jobs 2 \
  COMPILER_INDEX_STORE_ENABLE=NO build -quiet
app="$derived/Build/Products/Debug-iphonesimulator/Himawari.app"
bundle="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"

if ! xcrun simctl list devices booted | grep -qF "$udid"; then
  shutdown_simulator=1
fi
simulator_launchd=""
boot_device() {
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  simulator_launchd="$(pgrep -f "launchd_sim .*$udid" | head -1 || true)"
  [ -n "$simulator_launchd" ] || { echo "UI_REVIEW_FAILED cannot find the simulator's launchd_sim process for $udid" >&2; exit 1; }
}
boot_device
if [ "$(xcrun simctl spawn "$udid" defaults read -g AppleLanguages 2>/dev/null | tr -d ' \n()"' | cut -d, -f1)" != "zh-Hans" ] \
  || [ "$(xcrun simctl spawn "$udid" defaults read -g AppleICUForce12HourTime 2>/dev/null)" != "1" ]; then
  xcrun simctl spawn "$udid" defaults write -g AppleLanguages -array zh-Hans
  xcrun simctl spawn "$udid" defaults write -g AppleLocale -string zh_CN
  xcrun simctl spawn "$udid" defaults write -g AppleICUForce12HourTime -bool true
  xcrun simctl shutdown "$udid"
  boot_device
fi

simulator_load() {
  ps -A -o ppid=,%cpu= | awk -v parent="$simulator_launchd" '$1 == parent { total += $2 } END { printf "%d", total }'
}

calm() {
  [ "$(simulator_load)" -lt "$calm_below" ]
}

wait_until_calm() {
  local quiet=0 waited=0
  while [ "$quiet" -lt 3 ]; do
    if calm; then quiet=$((quiet + 1)); else quiet=0; fi
    [ "$quiet" -lt 3 ] || return 0
    [ "$waited" -lt "$calm_patience" ] || { echo "UI_REVIEW_FAILED simulator stayed busy for ${calm_patience}s (load $(simulator_load)%, limit ${calm_below}%)" >&2; exit 1; }
    sleep 2
    waited=$((waited + 2))
  done
}

override_status_bar() {
  xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
}

wait_until_calm
override_status_bar
xcrun simctl install "$udid" "$app"

if [ "$mode" = "check" ]; then
  shots="$(mktemp -d)"
else
  shots="$out"
fi
mkdir -p "$shots"
rm -f "$shots"/*.png "$shots"/*.mp4 "$shots"/*.mov

marker=""
launch() {
  [ -z "$marker" ] || rm -f "$marker"
  xcrun simctl launch --terminate-running-process "$udid" "$bundle" \
    -HimawariDemoScene "$1" -AppleLanguages "(zh-Hans)" -AppleLocale zh_CN \
    ${text_size:+-UIPreferredContentSizeCategoryName "$text_size"} >/dev/null
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
  local scene="$1" file="$2" marked="${3:-marked}" previous="" current="" tries=0 launches=1
  while :; do
    if { [ "$marked" = "unmarked" ] || shown "$scene"; } && calm; then
      xcrun simctl io "$udid" screenshot --type=png "$file" >/dev/null
      current="$(shasum -a 256 "$file" | cut -d' ' -f1)"
      if [ "$current" = "$previous" ] && [ "$current" != "$last_shot" ]; then
        last_shot="$current"
        return 0
      fi
      previous="$current"
    else
      previous=""
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 40 ]; then
      [ "$launches" -lt 3 ] || { echo "UI_REVIEW_FAILED $file: scene $scene $(shown "$scene" && echo "kept changing, repeated the previous screen, or the simulator stayed busy (load $(simulator_load)%)" || echo "never reported that it was on screen")" >&2; exit 1; }
      launches=$((launches + 1))
      tries=0
      previous=""
      launch "$scene"
    fi
    sleep 1
  done
}

restart_device() {
  xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
  xcrun simctl shutdown "$udid"
  boot_device
  wait_until_calm
  override_status_bar
  xcrun simctl ui "$udid" appearance "$1"
  sleep 3
  wait_until_calm
}

xcrun simctl spawn "$udid" defaults write com.apple.Preferences DidShowContinuousPathIntroduction -bool true >/dev/null 2>&1 || true
launch "$warm_up"
sleep 8
wait_until_calm

for appearance in light dark; do
  xcrun simctl ui "$udid" appearance "$appearance"
  sleep 3
  wait_until_calm
  for scene in "${scenes[@]}"; do
    case "$scene" in
      motion-*)
        [ "$mode" = "check" ] && continue
        raw="$shots/$scene-$appearance.mov"
        launch "$scene"
        waited=0
        until shown "$scene"; do
          [ "$waited" -lt 40 ] || { echo "UI_REVIEW_FAILED $raw: scene $scene never reported that it was on screen" >&2; exit 1; }
          sleep 1
          waited=$((waited + 1))
        done
        xcrun simctl io "$udid" recordVideo --codec=h264 --force "$raw" >/dev/null 2>&1 &
        recorder=$!
        sleep 13
        kill -INT "$recorder"
        wait "$recorder" || true
        if command -v avconvert >/dev/null; then
          avconvert --preset Preset960x540 --source "$raw" --output "$shots/$scene-$appearance.mp4" --replace >/dev/null 2>&1 && rm -f "$raw"
        fi
        ;;
      *-system-prompt*)
        xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
        xcrun simctl privacy "$udid" reset all "$bundle"
        launch "$scene"
        file="$shots/$scene-$appearance.png"
        sleep "$prompt_wait"
        settle "$scene" "$file" unmarked
        restart_device "$appearance"
        width="$(sips -g pixelWidth "$file" | awk '/pixelWidth/ {print $2}')"
        [ "$width" = "$expected_width" ] || { echo "UI_REVIEW_FAILED $file is $width px wide, expected $expected_width (390 pt at 3x)" >&2; exit 1; }
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
