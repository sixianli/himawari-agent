#!/bin/bash
set -euo pipefail
umask 022

usage() {
  echo "usage: authorize-workspace.sh <expires-at ISO time> [--workspace <directory>]" >&2
  echo "  Run as root on the target host after first-install.sh. Creates the workspace directories and the directory grant named in the config." >&2
  exit 64
}
[[ $# -ge 1 ]] || usage
expires_at=$1
shift
workspace=/var/lib/himawari/workspace
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) workspace=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { echo "AUTHORIZE_WORKSPACE_NEEDS_ROOT" >&2; exit 1; }

service_user=himawari-prod
unit=himawari-prod.service
config=/etc/himawari/config.json
install_root=/opt/himawari
node=$install_root/node/bin/node
[[ -f "$config" ]] || { echo "AUTHORIZE_WORKSPACE_CONFIG_MISSING" >&2; exit 1; }

read -r host_id grant_id < <(python3 -I - "$config" <<'PYTHON'
import json, sys
coding = json.load(open(sys.argv[1])).get('runPolicy', {}).get('coding') or {}
if not isinstance(coding.get('hostId'), str) or not isinstance(coding.get('grantId'), str):
    sys.exit('AUTHORIZE_WORKSPACE_ROUTE_MISSING runPolicy.coding needs hostId and grantId')
print(coding['hostId'], coding['grantId'])
PYTHON
)
cli=$(systemctl show -p ExecStart --value "$unit" | python3 -I -c 'import re,sys; m=re.search(r"--prefix (\S+)", sys.stdin.read()); print(m.group(1) + "/bin/himawari" if m else "")')
[[ -x "$cli" ]] || { echo "AUTHORIZE_WORKSPACE_CLI_NOT_FOUND" >&2; exit 1; }
echo "AUTHORIZE_WORKSPACE_TARGET host_id=$host_id grant_id=$grant_id workspace=$workspace"

echo "AUTHORIZE_WORKSPACE_STEP stop"
systemctl stop "$unit"

echo "AUTHORIZE_WORKSPACE_STEP directories"
if [[ -e "$workspace" ]]; then
  echo "AUTHORIZE_WORKSPACE_DIRECTORY_EXISTS $workspace" >&2
  systemctl start "$unit"
  exit 1
fi
install -d -m 0700 -o "$service_user" -g "$service_user" "$workspace" "$workspace/files" "$workspace/repos"

echo "AUTHORIZE_WORKSPACE_STEP grant"
runuser -u "$service_user" -- env -i HOME=/var/lib/himawari PATH="$(dirname "$node"):/usr/bin:/bin" LANG=C.UTF-8 \
  "$cli" workspace grant --config "$config" --directory "$workspace" --host-id "$host_id" --id "$grant_id" --expires-at "$expires_at" --confirm "$workspace"

echo "AUTHORIZE_WORKSPACE_STEP start"
systemctl start "$unit"
echo "AUTHORIZE_WORKSPACE_OK grant_id=$grant_id"
