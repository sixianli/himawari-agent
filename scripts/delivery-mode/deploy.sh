#!/bin/bash
set -uo pipefail
umask 077
if [[ "$#" -ne 1 ]]; then
  echo "usage: bash $0 <frozen operation packet directory>" >&2
  exit 64
fi
packet="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$packet/inputs/check-packet-consistency.py" ]] && ! /usr/bin/python3 -I "$packet/inputs/check-packet-consistency.py" "$packet" > /dev/null; then
  echo "DEPLOY_PACKET_INCONSISTENT: /usr/bin/python3 -I $packet/inputs/check-packet-consistency.py $packet" >&2
  exit 3
fi
for action in S1_TRANSPORT S1_INSTALL S2_STOP S3_COPY51 S6_ACCEPTANCE S6_PUBLISH_MATERIALS S6_FINALIZE_BINDINGS S6_SIGN S6_RUNTIME_PROTECTION S6_READ S7_DB_STATUS S7_CONFIG_APPLY S7_CATALOG_UPGRADE S7_SWITCH_START S8_READBACK; do
  echo "DEPLOY_STEP_START $action $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  /bin/bash "$packet/steps/run-user-step.sh" "$action"
  code=$?
  if [[ "$code" -ne 0 ]]; then
    echo "DEPLOY_STOPPED_AT $action exit=$code" >&2
    echo "To go back to the previous release: bash $here/rollback.sh $packet" >&2
    exit "$code"
  fi
  echo "DEPLOY_STEP_PASSED $action"
done
echo "DEPLOY_PASSED"
