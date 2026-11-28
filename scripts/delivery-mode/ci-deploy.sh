#!/bin/bash
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
instance_name="${HIMAWARI_DEPLOY_INSTANCE:-andy-production}"
host="${HIMAWARI_PACKET_HOST:-}"
commit="${HIMAWARI_DEPLOY_COMMIT:-}"
since="${HIMAWARI_DEPLOY_SINCE:-}"
ssh_bin="${HIMAWARI_PACKET_SSH:-ssh}"
output_root="${HIMAWARI_DEPLOY_OUTPUT_ROOT:-$repo/.ci-output/production}"

refuse() {
  echo "CI_DEPLOY_REFUSED $1: $2" >&2
  exit "${3:-2}"
}

[[ -n "$host" ]] || refuse HOST_MISSING "set HIMAWARI_PACKET_HOST to the production machine address"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || refuse HOST_UNSAFE "$host"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || refuse COMMIT_INVALID "HIMAWARI_DEPLOY_COMMIT must be a full 40-character commit hash"
[[ -z "$since" || "$since" =~ ^[0-9a-f]{40}$ ]] || refuse SINCE_INVALID "HIMAWARI_DEPLOY_SINCE must be a full 40-character commit hash"
[[ "$(git -C "$repo" rev-parse HEAD)" == "$commit" ]] || refuse CHECKOUT_MISMATCH "the checkout must be exactly $commit"

entry_source="$repo/scripts/install/deploy-entry"
entry_library="${HIMAWARI_DEPLOY_ENTRY_LIBRARY:-/usr/local/lib/himawari-deploy}"
if [[ -d "$entry_source" && -d "$entry_library" ]] && ! diff -r -q "$entry_source" "$entry_library" > /dev/null 2>&1; then
  entry_staging="$(mktemp -d "$entry_library.new.XXXXXX")"
  if cp -R "$entry_source/." "$entry_staging/" && chmod -R u=rwX,go=rX "$entry_staging" && { [[ "$(id -u)" -ne 0 ]] || chown -R root:root "$entry_staging"; } && rm -rf "$entry_library.old" && mv "$entry_library" "$entry_library.old"; then
    if mv "$entry_staging" "$entry_library"; then
      rm -rf "$entry_library.old"
      echo "CI_DEPLOY_ENTRY_UPDATED $entry_library from $commit"
    else
      mv "$entry_library.old" "$entry_library"
      echo "CI_DEPLOY_ENTRY_UPDATE_FAILED: kept the installed deploy entry in $entry_library" >&2
    fi
  else
    rm -rf "$entry_staging"
    echo "CI_DEPLOY_ENTRY_UPDATE_FAILED: kept the installed deploy entry in $entry_library" >&2
  fi
fi

remote() {
  "$ssh_bin" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "root@$host" "$@"
}

instance_value() {
  /usr/bin/python3 -I - "$repo/scripts/delivery-mode/instances/$instance_name.json" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    value = value[key]
print(value)
PY
}

unit_path="$(instance_value fixedByTemplate.unitPath)" || refuse INSTANCE_UNREADABLE "$instance_name"
releases_root="$(instance_value fixedByTemplate.releasesRoot)" || refuse INSTANCE_UNREADABLE "$instance_name"
unit_name="$(instance_value fixedByTemplate.unit)" || refuse INSTANCE_UNREADABLE "$instance_name"

if [[ -z "$since" ]]; then
  running_dir="$(remote "grep -o -m1 -E '$releases_root/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,40}' '$unit_path'")" || refuse RUNNING_UNREADABLE "cannot read the running release from $unit_path on $host"
  short="${running_dir##*-}"
  since="$(git -C "$repo" rev-parse --verify --quiet "$short^{commit}")" || refuse RUNNING_COMMIT_UNKNOWN "running release $running_dir is not a commit in this checkout; pass HIMAWARI_DEPLOY_SINCE"
fi
echo "CI_DEPLOY_RUNNING $since"

if [[ "$since" == "$commit" ]]; then
  echo "CI_DEPLOY_SKIPPED already-running"
  exit 0
fi
if git -C "$repo" merge-base --is-ancestor "$commit" "$since"; then
  echo "CI_DEPLOY_SKIPPED running-is-newer"
  exit 0
fi
git -C "$repo" merge-base --is-ancestor "$since" "$commit" || refuse SINCE_NOT_ANCESTOR "$since is not an ancestor of $commit"

if [[ "${HIMAWARI_DEPLOY_FORCE:-0}" != 1 ]]; then
  deployable="$(git -C "$repo" diff --name-only "$since" "$commit" | grep -v -E '^(docs/|clients/|test/|\.agents/|\.claude/|\.github/|[^/]+\.md$)' || true)"
  if [[ -z "$deployable" ]]; then
    echo "CI_DEPLOY_SKIPPED no-deployable-files-changed"
    exit 0
  fi
fi

previous_packet="$(find "$output_root" -mindepth 1 -maxdepth 1 -type d -name '*-change-packet-*' 2>/dev/null | sort | tail -1)"
echo "CI_DEPLOY_LAST_FAILURE_REPORT ${previous_packet:-none}"
remote "/usr/bin/python3 -I - ${previous_packet:+'$previous_packet'}" < "$here/last-failure-report.py" || echo "CI_DEPLOY_LAST_FAILURE_REPORT_UNAVAILABLE" >&2

if remote "test -f /etc/himawari-backup/settings.json"; then
  remote "cat > /usr/local/sbin/himawari-backup.new && chmod 0755 /usr/local/sbin/himawari-backup.new && mv /usr/local/sbin/himawari-backup.new /usr/local/sbin/himawari-backup" < "$repo/scripts/operations/backup/himawari-backup.py" || refuse BACKUP_REFRESH_FAILED "could not update /usr/local/sbin/himawari-backup on $host" 6
  echo "CI_DEPLOY_BACKUP_START"
  remote "/usr/bin/python3 -I /usr/local/sbin/himawari-backup run --reason pre-deploy" || refuse BACKUP_FAILED "the backup before deploying failed, so nothing was deployed; see journalctl -t himawari-backup or run himawari-backup run --reason pre-deploy on $host" 6
else
  echo "CI_DEPLOY_BACKUP_NOT_INSTALLED: no /etc/himawari-backup/settings.json on $host; install it with scripts/operations/backup/install-backup.sh" >&2
fi

if remote "test -f /etc/himawari-heartbeat/healthcheck-url"; then
  echo "CI_DEPLOY_HEARTBEAT_REFRESH"
  remote "bash '$repo/scripts/operations/heartbeat/install-heartbeat.sh' install --keep-url --instance '$repo/scripts/delivery-mode/instances/$instance_name.json'" || refuse HEARTBEAT_REFRESH_FAILED "could not reinstall the heartbeat and its outage push on $host; see the HEARTBEAT_ line above" 3
else
  echo "CI_DEPLOY_HEARTBEAT_NOT_INSTALLED: no /etc/himawari-heartbeat/healthcheck-url on $host; install it with scripts/operations/heartbeat/install-heartbeat.sh" >&2
fi

echo "CI_DEPLOY_DB_PERMISSIONS"
remote "cd /var/lib/himawari/state/data && for f in product.sqlite product.sqlite-wal product.sqlite-shm; do [ -e \"\$f\" ] && chmod 600 \"\$f\"; done; true" || refuse DB_PERMISSIONS_FAILED "cannot tighten the product database file modes on $host" 3

echo "CI_DEPLOY_BUILDER_HOME_OWNERSHIP"
remote 'tools="$(getent passwd himawari-build | cut -d: -f6)/packet-builder/tools"; for d in "$tools/home" "$tools/tmp"; do [ -d "$d" ] && chown -R himawari-build:himawari-build "$d"; done; true' || refuse BUILDER_HOME_OWNERSHIP_FAILED "cannot give the packet builder its own tool home back on $host" 3

echo "CI_DEPLOY_NODE_OWNERSHIP"
remote "chown -R root:root /opt/himawari/node && chmod -R go-w /opt/himawari/node" || refuse NODE_OWNERSHIP_FAILED "cannot make /opt/himawari/node root-owned on $host" 3

echo "CI_DEPLOY_HOST_SYSTEM"
/usr/bin/python3 -I "$here/host-system.py" | remote "/usr/bin/python3 -I -" || refuse HOST_SYSTEM_FAILED "could not install the document tools or pin the next boot to the running kernel on $host; see the HOST_SYSTEM_FAILED line above" 3

if [[ -n "$previous_packet" && -f "$previous_packet/inputs/bindings.json" && -f "$previous_packet/freeze-manifest.json" ]]; then
  echo "CI_DEPLOY_PREVIOUS_CLEANUP $previous_packet"
  /usr/bin/python3 -I "$here/release-cleanup.py" "$previous_packet" apply || echo "CI_DEPLOY_PREVIOUS_CLEANUP_INCOMPLETE: leftovers of the last attempt may still block this one; see the CLEANUP_ lines above" >&2
fi

echo "CI_DEPLOY_PREPARE $commit"
prepare_log="$(mktemp)"
trap 'rm -f "$prepare_log"' EXIT
/usr/bin/python3 -I "$here/make-packet.py" prepare --instance "$instance_name" --host "$host" --commit "$commit" --since "$since" --output-root "$output_root" 2>&1 | tee "$prepare_log"
[[ "${PIPESTATUS[0]}" -eq 0 ]] || refuse PREPARE_FAILED "make-packet.py prepare did not produce a packet" 3
packet="$(sed -n 's/^PACKET_READY //p' "$prepare_log" | tail -1 | /usr/bin/python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read())["packet"])')"
[[ -d "$packet" ]] || refuse PACKET_MISSING "no PACKET_READY line" 3

echo "CI_DEPLOY_START $packet"
HIMAWARI_DEPLOY_SHADOW_REHEARSAL=1 HIMAWARI_DEPLOY_ON_FAILURE="${HIMAWARI_DEPLOY_ON_FAILURE:-rollback}" bash "$here/deploy.sh" "$packet"
deploy_code=$?
if [[ "$deploy_code" -ne 0 ]]; then
  echo "CI_DEPLOY_FAILED exit=$deploy_code" >&2
  exit 4
fi

echo "CI_DEPLOY_READBACK"
for attempt in $(seq 1 24); do
  if [[ "$(remote "/usr/bin/systemctl is-active '$unit_name'" 2>/dev/null)" == active ]] && remote "curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8400/health/ready" 2>/dev/null; then
    echo "CI_DEPLOY_READY $commit"
    running_release="$(remote "grep -o -m1 -E '$releases_root/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,40}' '$unit_path'")" || refuse COMPUTERS_RELEASE_UNREADABLE "cannot read the running release from $unit_path on $host" 7
    echo "CI_DEPLOY_COMPUTERS $running_release"
    remote "bash '$repo/scripts/operations/computers/install-computers.sh' ensure --release '$running_release'" || refuse COMPUTERS_FAILED "the service is up, but each user's computer service did not install or start; see journalctl -u himawari-computers on $host" 7
    exit 0
  fi
  sleep 5
done
echo "CI_DEPLOY_NOT_READY: $unit_name is not active or /health/ready did not answer within 120 seconds" >&2
exit 5
