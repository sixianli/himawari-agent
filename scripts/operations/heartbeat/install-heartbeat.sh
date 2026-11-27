#!/bin/bash
set -euo pipefail
usage() {
  echo "usage: bash $0 install [--keep-url] [--instance instance.json] [--alert-after N] < url-file | remove [--purge] | status" >&2
  exit 64
}
[[ "$#" -ge 1 ]] || usage
mode="$1"
shift
here="$(cd "$(dirname "$0")" && pwd)"
prefix="${HEARTBEAT_ROOT:-}"
systemctl_command="${HEARTBEAT_SYSTEMCTL:-systemctl}"
script_path="$prefix/usr/local/sbin/himawari-heartbeat"
url_path="$prefix/etc/himawari-heartbeat/healthcheck-url"
legacy_url_path="$prefix/etc/himawari/healthcheck-url"
service_path="$prefix/etc/systemd/system/himawari-heartbeat.service"
timer_path="$prefix/etc/systemd/system/himawari-heartbeat.timer"
push_script_path="$prefix/usr/local/sbin/himawari-outage-push"
push_service_path="$prefix/etc/systemd/system/himawari-outage-push.service"
push_path_path="$prefix/etc/systemd/system/himawari-outage-push.path"
state_directory="/var/lib/himawari-heartbeat"

if [[ -z "$prefix" && "$(id -u)" != 0 ]]; then
  echo "HEARTBEAT_NEEDS_ROOT" >&2
  exit 77
fi

case "$mode" in
  status)
    "$systemctl_command" is-active himawari-heartbeat.timer || true
    "$systemctl_command" list-timers himawari-heartbeat.timer --no-pager || true
    exit 0
    ;;
  remove)
    purge=0
    [[ "${1:-}" == --purge ]] && purge=1
    "$systemctl_command" disable --now himawari-heartbeat.timer 2>/dev/null || true
    "$systemctl_command" disable --now himawari-outage-push.path 2>/dev/null || true
    rm -f "$timer_path" "$service_path" "$script_path" "$push_path_path" "$push_service_path" "$push_script_path"
    [[ "$purge" == 1 ]] && rm -f "$url_path" "$legacy_url_path"
    "$systemctl_command" daemon-reload
    echo "HEARTBEAT_REMOVED"
    exit 0
    ;;
  install) ;;
  *) usage ;;
esac

keep=0
instance=""
alert_after=5
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --keep-url) keep=1; shift ;;
    --instance) [[ "$#" -ge 2 ]] || usage; instance="$2"; shift 2 ;;
    --alert-after) [[ "$#" -ge 2 ]] || usage; alert_after="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$alert_after" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "HEARTBEAT_ALERT_AFTER_INVALID" >&2; exit 64; }
push_values=""
if [[ -n "$instance" ]]; then
  push_values="$(/usr/bin/python3 -I - "$instance" <<'PY'
import json, re, sys
try:
    fixed = json.load(open(sys.argv[1]))["fixedByTemplate"]
    values = [fixed[key] for key in ("serviceAccount", "unitPath", "releasesRoot", "config", "stateRoot")]
except (OSError, ValueError, KeyError, TypeError):
    sys.exit("HEARTBEAT_INSTANCE_INVALID")
if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", values[0]) or not all(isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9._/-]+", value) for value in values[1:]):
    sys.exit("HEARTBEAT_INSTANCE_INVALID")
print(" ".join(values))
PY
)" || exit 2
fi
umask 077
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
if [[ "$keep" == 1 ]]; then
  keep_source="$url_path"
  [[ -f "$keep_source" ]] || keep_source="$legacy_url_path"
  [[ -f "$keep_source" ]] || { echo "HEARTBEAT_URL_MISSING" >&2; exit 2; }
  cp "$keep_source" "$staging/url"
else
  head -c 600 > "$staging/url"
  [[ -s "$staging/url" ]] || { echo "HEARTBEAT_URL_MISSING" >&2; exit 2; }
fi
/usr/bin/python3 -I "$here/himawari-heartbeat.py" --check-url-file --url-file "$staging/url" > /dev/null

umask 022
mkdir -p "$(dirname "$script_path")" "$(dirname "$service_path")"
mkdir -p "$(dirname "$url_path")"
chmod 0700 "$(dirname "$url_path")"
install -m 0755 "$here/himawari-heartbeat.py" "$script_path"
heartbeat_command="/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat"
state_lines=""
if [[ -n "$push_values" ]]; then
  heartbeat_command="$heartbeat_command --state-dir $state_directory --alert-after $alert_after"
  state_lines=$'StateDirectory=himawari-heartbeat\nStateDirectoryMode=0755'
fi
install -m 0600 "$staging/url" "$url_path"
if [[ -z "$prefix" ]]; then chown root:root "$(dirname "$url_path")" "$url_path"; fi
cat > "$service_path" <<UNIT
[Unit]
Description=Himawari heartbeat to Healthchecks.io
After=network-online.target

[Service]
Type=oneshot
ExecStart=$heartbeat_command
${state_lines}
TimeoutStartSec=30
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6
SyslogIdentifier=himawari-heartbeat
UNIT
cat > "$timer_path" <<'UNIT'
[Unit]
Description=Himawari heartbeat every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
chmod 0644 "$service_path" "$timer_path"
if [[ -n "$push_values" ]]; then
  read -r push_account push_unit_path push_releases push_config push_state_root <<< "$push_values"
  install -m 0755 "$here/himawari-outage-push.py" "$push_script_path"
  cat > "$push_service_path" <<UNIT
[Unit]
Description=Tell the owner's iPhone when the Himawari heartbeat finds an outage or a recovery
StartLimitIntervalSec=1h
StartLimitBurst=5

[Service]
Type=oneshot
User=$push_account
ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-outage-push --unit-path $push_unit_path --releases-root $push_releases --config $push_config --secret-dir $push_state_root/secrets --event-file $state_directory/outage.json
Restart=on-failure
RestartSec=60
TimeoutStartSec=120
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
SyslogIdentifier=himawari-outage-push
UNIT
  cat > "$push_path_path" <<UNIT
[Unit]
Description=Watch the Himawari heartbeat for outage changes

[Path]
PathChanged=$state_directory/outage.json
Unit=himawari-outage-push.service

[Install]
WantedBy=paths.target
UNIT
  chmod 0644 "$push_service_path" "$push_path_path"
elif [[ -f "$push_path_path" ]]; then
  "$systemctl_command" disable --now himawari-outage-push.path 2>/dev/null || true
  rm -f "$push_path_path" "$push_service_path" "$push_script_path"
fi
rm -f "$legacy_url_path"
"$systemctl_command" daemon-reload
"$systemctl_command" enable --now himawari-heartbeat.timer
if [[ -n "$push_values" ]]; then
  "$systemctl_command" enable --now himawari-outage-push.path
  echo "HEARTBEAT_OUTAGE_PUSH_INSTALLED alert-after=$alert_after"
fi
echo "HEARTBEAT_INSTALLED"
