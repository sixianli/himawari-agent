#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
project="$repo/clients/apple/App/Himawari.xcodeproj"
work="${HIMAWARI_E2E_WORK:-${RUNNER_TEMP:-$repo/.ios-e2e}}/ios-e2e"
derived="$work/DerivedData"
result="$work/EndToEnd.xcresult"
ready="$work/backend.json"
stop="$work/backend.stop"
log="$work/backend.log"
only="${HIMAWARI_E2E_ONLY:-HimawariUITests/EndToEndTests}"

rm -rf "$work"
mkdir -p "$work"

udid="${HIMAWARI_E2E_SIMULATOR:-}"
if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices available --json | python3 -c '
import json, re, sys
runtimes = json.load(sys.stdin)["devices"]
def version(key):
    return [int(part) for part in re.findall(r"\d+", key.rsplit(".", 1)[-1])]
ios = sorted((key for key in runtimes if ".SimRuntime.iOS-" in key), key=version)
phones = [device for device in runtimes[ios[-1]] if device["name"].startswith("iPhone")]
print(phones[0]["udid"])
')"
fi
echo "IOS_E2E_SIMULATOR $udid"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b

signing=(
  CODE_SIGN_STYLE=Manual
  CODE_SIGN_IDENTITY=-
  AD_HOC_CODE_SIGNING_ALLOWED=YES
  DEVELOPMENT_TEAM=
  PROVISIONING_PROFILE_SPECIFIER=
  HIMAWARI_APP_GROUP=
  HIMAWARI_ENTITLEMENTS_SUFFIX=.keychain-only
)

if ! xcodebuild build-for-testing \
  -project "$project" \
  -scheme Himawari \
  -configuration Debug \
  -destination "id=$udid" \
  -derivedDataPath "$derived" \
  "${signing[@]}" >"$work/build.log" 2>&1; then
  grep -E 'error:' "$work/build.log" | head -50 || tail -50 "$work/build.log"
  echo "IOS_E2E_BUILD_FAILED"
  exit 1
fi

cleanup() {
  touch "$stop"
  if [ -n "${backend_pid:-}" ]; then
    for _ in $(seq 1 20); do kill -0 "$backend_pid" 2>/dev/null || break; sleep 0.5; done
    kill "$backend_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

(
  cd "$repo"
  HIMAWARI_IOS_E2E_READY="$ready" HIMAWARI_IOS_E2E_STOP="$stop" \
    node node_modules/vitest/vitest.mjs run --config test/ios-e2e/vitest.config.ts
) >"$log" 2>&1 &
backend_pid=$!

for _ in $(seq 1 240); do
  [ -s "$ready" ] && break
  kill -0 "$backend_pid" 2>/dev/null || { cat "$log"; echo "IOS_E2E_BACKEND_EXITED"; exit 1; }
  sleep 0.5
done
[ -s "$ready" ] || { cat "$log"; echo "IOS_E2E_BACKEND_NOT_READY"; exit 1; }
control="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["control"])' "$ready")"
ca="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ca"])' "$ready")"
xcrun simctl keychain "$udid" add-root-cert "$ca"
echo "IOS_E2E_BACKEND $control"

set +e
TEST_RUNNER_HIMAWARI_E2E_CONTROL="$control" xcodebuild test-without-building \
  -project "$project" \
  -scheme Himawari \
  -configuration Debug \
  -destination "id=$udid" \
  -derivedDataPath "$derived" \
  -only-testing:"$only" \
  -resultBundlePath "$result" \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 300 \
  >"$work/test.log" 2>&1
status=$?
grep -E 'error:|Test Case .* (passed|failed|skipped)|\*\* TEST' "$work/test.log"
xcrun simctl spawn "$udid" log show --last 60m --style compact \
  --predicate 'process == "Himawari" AND (messageType == error OR messageType == fault OR eventMessage CONTAINS[c] "error" OR eventMessage CONTAINS[c] "fail")' \
  >"$work/app.log" 2>&1
set -e
echo "IOS_E2E_BACKEND_LOG"
grep -E 'IOS_E2E_|Error|error' "$log" | grep -vE 'IOS_E2E_(REQUEST|LIVE_TEXT) ' | head -80 || true
echo "IOS_E2E_LIVE_TEXT_EVENTS $(grep -c 'IOS_E2E_LIVE_TEXT ' "$log" || true)"
echo "IOS_E2E_APP_LOG"
tail -40 "$work/app.log" || true
if grep -q "skipped" "$work/test.log" && ! grep -q "passed" "$work/test.log"; then
  echo "IOS_E2E_ALL_SKIPPED the end-to-end tests did not find the backend"
  exit 1
fi
exit "$status"
