#!/bin/bash
set -uo pipefail
umask 077
if [[ "$#" -ne 1 ]]; then
  echo "usage: bash $0 <frozen operation packet directory>" >&2
  exit 64
fi
packet="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$packet/run-logs"
log="$packet/run-logs/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log") 2>&1

result() {
  echo "DEPLOY_RESULT {\"result\":\"$1\",\"stoppedAt\":\"$2\",\"exit\":$3,\"log\":\"$log\"}"
  exit "$3"
}

if [[ -f "$packet/inputs/check-packet-consistency.py" ]] && ! /usr/bin/python3 -I "$packet/inputs/check-packet-consistency.py" "$packet" > /dev/null; then
  echo "DEPLOY_PACKET_INCONSISTENT: /usr/bin/python3 -I $packet/inputs/check-packet-consistency.py $packet" >&2
  result inconsistent PACKET 3
fi

echo "DEPLOY_PREFLIGHT_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! /usr/bin/python3 -I "$here/deploy-preflight.py" "$packet"; then
  echo "DEPLOY_PREFLIGHT_FAILED: nothing on the production server was changed" >&2
  result preflight-failed PREFLIGHT 4
fi
echo "DEPLOY_PREFLIGHT_PASSED"

stopped=0
for action in S1_TRANSPORT S1_INSTALL S2_STOP S3_COPY51 S6_ACCEPTANCE S6_PUBLISH_MATERIALS S6_FINALIZE_BINDINGS S6_SIGN S6_RUNTIME_PROTECTION S6_READ S7_DB_STATUS S7_CONFIG_APPLY S7_CATALOG_UPGRADE S7_SWITCH_START S8_READBACK; do
  [[ "$action" == S2_STOP ]] && stopped=1
  echo "DEPLOY_STEP_START $action $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  /bin/bash "$packet/steps/run-user-step.sh" "$action"
  code=$?
  if [[ "$code" -ne 0 ]]; then
    echo "DEPLOY_STOPPED_AT $action exit=$code" >&2
    if [[ "$stopped" -eq 0 ]]; then
      echo "DEPLOY_SERVICE_UNTOUCHED: the old release is still running" >&2
      result stopped-before-service-stop "$action" "$code"
    fi
    echo "DEPLOY_AUTO_RECOVERY_START bash $here/rollback.sh $packet"
    if bash "$here/rollback.sh" "$packet"; then
      echo "DEPLOY_AUTO_RECOVERY_PASSED: the old release is running again"
      result recovered "$action" "$code"
    fi
    echo "DEPLOY_AUTO_RECOVERY_FAILED: production may be down" >&2
    result recovery-failed "$action" "$code"
  fi
  echo "DEPLOY_STEP_PASSED $action"
done
echo "DEPLOY_PASSED"
if [[ "$(basename "$(dirname "$packet")")" == production ]]; then
  /usr/bin/python3 -I "$here/../disk-hygiene/prune-rebuildable.py" --apply --keep "$packet" "$(dirname "$(dirname "$packet")")" || echo "DEPLOY_PRUNE_FAILED: the deployment result is unchanged" >&2
fi
result passed "" 0
