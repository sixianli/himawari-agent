#!/usr/bin/env bash
set -euo pipefail

runs="${1:-100}"
if ! [[ "$runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 <runs>" >&2
  exit 2
fi

cd "$(dirname "$0")/../.."
report_dir="${PROACTIVE_REPEAT_REPORT_DIR:-.ci-output/proactive-repeat}"
mkdir -p "$report_dir"

tests=(
  test/integration/proactive-mail-check.test.ts
  test/integration/proactive-production.test.ts
  packages/platform-node/test/gmail-source.unit.test.ts
)

started=$(date +%s)
for run in $(seq 1 "$runs"); do
  if ! npx vitest run "${tests[@]}" --reporter=dot --reporter=json \
    --outputFile.json="$report_dir/run-$run.json" >"$report_dir/run-$run.log" 2>&1; then
    echo "run $run of $runs failed; see $report_dir/run-$run.log" >&2
    exit 1
  fi
  rm -f "$report_dir/run-$run.log"
  if [ "$run" -lt "$runs" ]; then rm -f "$report_dir/run-$run.json"; fi
done
echo "proactive acceptance passed $runs of $runs runs in $(( $(date +%s) - started ))s"
