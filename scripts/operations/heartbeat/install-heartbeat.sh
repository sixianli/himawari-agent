#!/bin/bash
set -euo pipefail
usage() {
  echo "usage: bash $0 install [--keep-url] < url-file | remove [--purge] | status" >&2
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
    rm -f "$timer_path" "$service_path" "$script_path"
    [[ "$purge" == 1 ]] && rm -f "$url_path" "$legacy_url_path"
    "$systemctl_command" daemon-reload
    echo "HEARTBEAT_REMOVED"
    exit 0
    ;;
  install) ;;
  *) usage ;;
esac

keep=0
[[ "${1:-}" == --keep-url ]] && keep=1
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
install -m 0600 "$staging/url" "$url_path"
if [[ -z "$prefix" ]]; then chown root:root "$(dirname "$url_path")" "$url_path"; fi
cat > "$service_path" <<'UNIT'
[Unit]
Description=Himawari heartbeat to Healthchecks.io
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat
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
rm -f "$legacy_url_path"
"$systemctl_command" daemon-reload
"$systemctl_command" enable --now himawari-heartbeat.timer
echo "HEARTBEAT_INSTALLED"
