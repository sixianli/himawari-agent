#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app=""
loads="realistic,plain"
runs=2
max_ratio=""
profile=""
out="${TMPDIR:-/tmp}/himawari-scroll-bench"

usage() {
  echo "usage: clients/apple/scripts/scroll-bench.sh --app PATH/Himawari.app [--loads realistic,plain] [--runs N] [--max-ratio MS_PER_S] [--profile LOAD] [--out DIR]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) [ $# -ge 2 ] || usage; app="$2"; shift 2 ;;
    --loads) [ $# -ge 2 ] || usage; loads="$2"; shift 2 ;;
    --runs) [ $# -ge 2 ] || usage; runs="$2"; shift 2 ;;
    --max-ratio) [ $# -ge 2 ] || usage; max_ratio="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || usage; profile="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -d "$app" ] || { echo "SCROLL_BENCH_FAILED no app at '$app'" >&2; exit 1; }
mkdir -p "$out"

bundle="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"
runtime="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | sed -E 's/.* - (com\.apple\.CoreSimulator\.SimRuntime\.[^ ]+).*/\1/')"
[ -n "$runtime" ] || { echo "SCROLL_BENCH_FAILED no iOS simulator runtime" >&2; exit 1; }
device_type="$(xcrun simctl list devicetypes | grep -Eo 'com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[0-9]+-Pro\)' | tr -d ')' | sort -t- -k2 -n | tail -1)"
[ -n "$device_type" ] || device_type="$(xcrun simctl list devicetypes | grep -Eo 'com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[^)]+' | tail -1)"
udid="$(xcrun simctl create "Himawari Scroll Bench" "$device_type" "$runtime")"
cleanup() {
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "SCROLL_BENCH_DEVICE $device_type $runtime $udid"
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl install "$udid" "$app"
sleep 20

result="$(xcrun simctl get_app_container "$udid" "$bundle" data)/tmp/himawari-scroll-bench.json"

bench() {
  local load="$1" label="$2" trace="$3"
  rm -f "$result"
  local launched pid recorder=""
  launched="$(xcrun simctl launch --terminate-running-process "$udid" "$bundle" -HimawariScrollBench "$load" -AppleLanguages "(zh-Hans)" -AppleLocale zh_CN)"
  pid="${launched##*: }"
  if [ -n "$trace" ]; then
    rm -rf "$trace"
    xcrun xctrace record --template 'Time Profiler' --device "$udid" --attach "$pid" --time-limit 25s --output "$trace" >/dev/null 2>&1 &
    recorder=$!
    ( sleep 60; kill -INT "$recorder" 2>/dev/null; sleep 15; kill -KILL "$recorder" 2>/dev/null ) &
  fi
  local waited=0
  until [ -f "$result" ]; do
    [ "$waited" -lt 120 ] || { echo "SCROLL_BENCH_FAILED $load never wrote its result" >&2; exit 1; }
    sleep 1
    waited=$((waited + 1))
  done
  [ -z "$recorder" ] || wait "$recorder" || true
  cp "$result" "$out/$label.json"
  echo "SCROLL_BENCH_RESULT $label $(cat "$result")"
}

IFS=',' read -r -a chosen <<< "$loads"
for load in "${chosen[@]}"; do
  bench "$load" "$load-warmup" ""
  for run in $(seq 1 "$runs"); do
    bench "$load" "$load-$run" ""
  done
done

if [ -n "$profile" ]; then
  bench "$profile" "$profile-profiled" "$out/$profile.trace"
  if [ -d "$out/$profile.trace" ]; then
    xcrun xctrace export --input "$out/$profile.trace" --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' --output "$out/$profile-time-profile.xml" || true
    [ -f "$out/$profile-time-profile.xml" ] && python3 -I "$root/scripts/time-profile-summary.py" "$out/$profile-time-profile.xml" | tee "$out/$profile-time-profile.txt" || true
  else
    echo "SCROLL_BENCH_PROFILE_MISSING xctrace did not write a trace" >&2
  fi
fi

python3 -I - "$out" "$max_ratio" "${chosen[@]}" <<'PY'
import json, os, sys
out, limit, loads = sys.argv[1], sys.argv[2], sys.argv[3:]
worst = 0.0
for load in loads:
    rows = []
    for name in sorted(os.listdir(out)):
        if name.startswith(load + "-") and name.endswith(".json") and "warmup" not in name and "profiled" not in name:
            with open(os.path.join(out, name)) as handle:
                rows.append(json.load(handle))
    for row in rows:
        if row.get("problem") or not row.get("reachedTop"):
            print(f"SCROLL_BENCH_FAILED {load} did not scroll through: {row.get('problem')}", file=sys.stderr)
            sys.exit(1)
    ratios = sorted(row["all"]["hitchRatioMsPerS"] for row in rows)
    median = ratios[len(ratios) // 2]
    up = sorted(row["up"]["hitchRatioMsPerS"] for row in rows)[len(rows) // 2]
    print(f"SCROLL_BENCH_SUMMARY load={load} runs={len(rows)} hitch_ratio_ms_per_s median={median} up_median={up} all={ratios}")
    worst = max(worst, median)
if limit and worst > float(limit):
    print(f"SCROLL_BENCH_FAILED median hitch ratio {worst} ms/s is above the limit {limit} ms/s", file=sys.stderr)
    sys.exit(1)
PY
