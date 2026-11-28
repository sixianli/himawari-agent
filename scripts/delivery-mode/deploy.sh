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

cleanup() {
  echo "DEPLOY_CLEANUP_START $1 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  /usr/bin/python3 -I "$here/release-cleanup.py" "$packet" apply "$2"
  code=$?
  if [[ "$code" -eq 3 && "$1" == before ]]; then
    echo "DEPLOY_CLEANUP_TARGET_PATHS_LEFT: paths this release needs are held by the serving release, a running process or the database (see CLEANUP_TARGET_PATH_LEFT above); the running release was not changed" >&2
    result target-paths-left PREFLIGHT 4
  fi
  if [[ "$code" -eq 3 ]]; then
    echo "DEPLOY_CLEANUP_PATHS_KEPT $1: the paths listed as CLEANUP_TARGET_PATH_LEFT above are kept because the serving release, a running process or the database holds them"
  elif [[ "$code" -ne 0 ]]; then
    echo "DEPLOY_CLEANUP_FAILED $1: the deployment result is unchanged; run python3 $here/release-cleanup.py $packet plan to see what is left" >&2
  fi
}

result() {
  if [[ "$1" == passed || "$1" == recovered || "$1" == stopped-before-service-stop ]]; then
    if [[ "$1" == passed ]]; then cleanup after 0; else cleanup after 1; fi
  elif [[ "$1" == recovery-failed ]]; then
    echo "DEPLOY_CLEANUP_SKIPPED: production may be down, every copy on the server is kept for diagnosis" >&2
  elif [[ "$1" == failed-kept ]]; then
    echo "DEPLOY_CLEANUP_SKIPPED: the failed release is kept as it stopped, every copy on the server is kept for diagnosis" >&2
  fi
  echo "DEPLOY_RESULT {\"result\":\"$1\",\"stoppedAt\":\"$2\",\"exit\":$3,\"log\":\"$log\"}"
  exit "$3"
}

lock="$(dirname "$packet")/.$(basename "$packet").deploy.lock"
acquire_lock() {
  if mkdir "$lock" 2>/dev/null; then return 0; fi
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && ! kill -0 "$holder" 2>/dev/null; then
    echo "DEPLOY_LOCK_STALE: the process $holder that held $lock is gone; taking the lock over"
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null && return 0
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
  fi
  echo "DEPLOY_ALREADY_RUNNING pid=${holder:-unknown} started=$(cat "$lock/started" 2>/dev/null || echo unknown) lock=$lock: another deploy of this packet holds the lock; wait for it to finish, or if that process is really gone remove $lock and run again" >&2
  return 1
}
if ! acquire_lock; then
  result already-running LOCK 8
fi
echo "$$" > "$lock/pid"
date -u +%Y-%m-%dT%H:%M:%SZ > "$lock/started"
trap 'rm -rf "$lock"' EXIT

on_failure_source=HIMAWARI_DEPLOY_ON_FAILURE
on_failure="${HIMAWARI_DEPLOY_ON_FAILURE:-}"
if [[ -z "$on_failure" ]]; then
  on_failure_source=packet-parameters.json
  on_failure="$(/usr/bin/python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("ON_DEPLOY_FAILURE", "rollback"))' "$packet/packet-parameters.json" 2>/dev/null || echo rollback)"
fi
if [[ "$on_failure" != rollback && "$on_failure" != keep ]]; then
  echo "DEPLOY_ON_FAILURE_INVALID $on_failure from $on_failure_source: use keep or rollback" >&2
  result invalid-on-failure OPTION 9
fi
echo "DEPLOY_ON_FAILURE $on_failure from $on_failure_source"

if [[ -f "$packet/inputs/check-packet-consistency.py" ]] && ! /usr/bin/python3 -I "$packet/inputs/check-packet-consistency.py" "$packet" > /dev/null; then
  echo "DEPLOY_PACKET_INCONSISTENT: /usr/bin/python3 -I $packet/inputs/check-packet-consistency.py $packet" >&2
  result inconsistent PACKET 3
fi

if ! /usr/bin/python3 -I "$here/generated-packet-gate.py" "$packet"; then
  echo "DEPLOY_PACKET_NOT_GENERATED: build the packet with python3 $here/make-packet.py prepare; do not copy or hand-edit an older packet" >&2
  result not-generated PACKET 6
fi

if ! /usr/bin/python3 -I "$here/script-checkout-gate.py" "$packet"; then
  echo "DEPLOY_SCRIPTS_OLDER_THAN_PACKET: these deploy scripts come from a checkout that does not contain the packet's commit; run deploy.sh from a checkout of that commit (for example a temporary checkout of origin/main)" >&2
  result old-scripts SCRIPTS 7
fi

if ! /usr/bin/python3 -I "$here/browser-acceptance-gate.py" "$packet"; then
  echo "DEPLOY_BROWSER_ACCEPTANCE_MISSING: walk the release checks in a real browser on this exact artifact first (product-path test 'release acceptance'), then copy its browser-acceptance.json to $packet/browser-acceptance/walkthrough.json" >&2
  result no-browser-acceptance ACCEPTANCE 5
fi

from_step="${HIMAWARI_DEPLOY_FROM_STEP:-}"
shadow_rehearsal="${HIMAWARI_DEPLOY_SHADOW_REHEARSAL:-0}"
acceptance_after_stop="${HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP:-0}"
if [[ -n "$from_step" && "$from_step" != S2_STOP ]]; then
  echo "DEPLOY_FROM_STEP_INVALID $from_step: only S2_STOP can be resumed from, after the steps before it passed on this host" >&2
  result invalid-from-step OPTION 9
fi
if [[ "$acceptance_after_stop" == 1 && ( -n "$from_step" || "$shadow_rehearsal" == 1 ) ]]; then
  echo "DEPLOY_OPTIONS_CONFLICT: the shadow rehearsal starts at S2_STOP, so S6_ACCEPTANCE cannot move after the stop" >&2
  result options-conflict OPTION 9
fi

if [[ -z "$from_step" ]]; then
  cleanup before 1
  echo "DEPLOY_PREFLIGHT_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! /usr/bin/python3 -I "$here/deploy-preflight.py" "$packet"; then
    echo "DEPLOY_PREFLIGHT_FAILED: the running release was not changed" >&2
    result preflight-failed PREFLIGHT 4
  fi
  echo "DEPLOY_PREFLIGHT_PASSED"
fi

stopped=0
actions=(S1_TRANSPORT S1_INSTALL S6_ACCEPTANCE S2_STOP S3_COPY51 S6_PUBLISH_MATERIALS S6_FINALIZE_BINDINGS S6_SIGN S6_RUNTIME_PROTECTION S6_READ S7_DB_STATUS S7_CONFIG_APPLY S7_CATALOG_UPGRADE S7_SWITCH_START S8_READBACK)
if [[ "$acceptance_after_stop" == 1 ]]; then
  actions=(S1_TRANSPORT S1_INSTALL S2_STOP S3_COPY51 S6_ACCEPTANCE S6_PUBLISH_MATERIALS S6_FINALIZE_BINDINGS S6_SIGN S6_RUNTIME_PROTECTION S6_READ S7_DB_STATUS S7_CONFIG_APPLY S7_CATALOG_UPGRADE S7_SWITCH_START S8_READBACK)
fi
if [[ -n "$from_step" ]]; then
  echo "DEPLOY_FROM_STEP $from_step"
  actions=("${actions[@]:3}")
fi
for action in "${actions[@]}"; do
  if [[ "$action" == S2_STOP && "$shadow_rehearsal" == 1 ]]; then
    echo "DEPLOY_SHADOW_REHEARSAL_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ! bash "$here/shadow-rehearsal.sh" "$packet"; then
      echo "DEPLOY_STOPPED_AT SHADOW_REHEARSAL: the steps from S2_STOP on failed on a copy of production in an offline shadow machine; see the SHADOW_ lines above" >&2
      echo "DEPLOY_SERVICE_UNTOUCHED: the old release is still running" >&2
      result stopped-before-service-stop SHADOW_REHEARSAL 10
    fi
    echo "DEPLOY_SHADOW_REHEARSAL_PASSED"
  fi
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
    if [[ "$on_failure" == keep ]]; then
      echo "DEPLOY_ROLLBACK_SKIPPED owner-choice: the failed release is kept as it stopped at $action and the old release was not restored; to restore it run bash $here/rollback.sh $packet" >&2
      result failed-kept "$action" "$code"
    fi
    echo "DEPLOY_AUTO_RECOVERY_START bash $here/rollback.sh $packet"
    if bash "$here/rollback.sh" "$packet"; then
      echo "DEPLOY_AUTO_RECOVERY_PASSED: the old release is running again"
      result recovered "$action" "$code"
    fi
    echo "DEPLOY_AUTO_RECOVERY_FAILED: the rollback did not finish; see the ROLLBACK_FALLBACK_ lines for whether the old release is running" >&2
    result recovery-failed "$action" "$code"
  fi
  echo "DEPLOY_STEP_PASSED $action"
done
echo "DEPLOY_PASSED"
if [[ "$(basename "$(dirname "$packet")")" == production ]]; then
  /usr/bin/python3 -I "$here/../disk-hygiene/prune-rebuildable.py" --apply --keep "$packet" "$(dirname "$(dirname "$packet")")" || echo "DEPLOY_PRUNE_FAILED: the deployment result is unchanged" >&2
fi
result passed "" 0
