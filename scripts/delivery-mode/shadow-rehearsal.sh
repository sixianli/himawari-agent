#!/bin/bash
set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077

here="$(cd "$(dirname "$0")" && pwd)"
packet="${1:?usage: shadow-rehearsal.sh <frozen packet directory>}"
state_data="${HIMAWARI_SHADOW_STATE_DATA:-/var/lib/himawari/state/data}"
shadow_parent="${HIMAWARI_SHADOW_PARENT:-/var/lib}"
unit="${HIMAWARI_SHADOW_UNIT:-himawari-prod.service}"
memory_max="${HIMAWARI_SHADOW_MEMORY_MAX:-6G}"
tools="${HIMAWARI_SHADOW_TOOLS:-/usr/bin}"
nspawn="$tools/systemd-nspawn"
systemd_run="$tools/systemd-run"
machinectl="$tools/machinectl"
systemctl="$tools/systemctl"
unshare="$tools/unshare"
mount="$tools/mount"
mkfs="${HIMAWARI_SHADOW_SBIN:-/usr/sbin}/mkfs.ext4"
upper_size="${HIMAWARI_SHADOW_UPPER_SIZE:-32G}"
machine="himawari-shadow"
boot_wait="${HIMAWARI_SHADOW_BOOT_WAIT:-180}"
service_wait="${HIMAWARI_SHADOW_SERVICE_WAIT:-120}"
shadow=""
booted=0
launcher=""

fail() {
  echo "SHADOW_REHEARSAL_FAILED $1: $2" >&2
  exit 1
}

finish() {
  if [[ "$booted" -eq 1 ]]; then
    "$machinectl" terminate "$machine" > /dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      "$machinectl" show "$machine" > /dev/null 2>&1 || break
      sleep 1
    done
    for _ in $(seq 1 60); do
      [[ -n "$launcher" ]] && kill -0 "$launcher" 2> /dev/null || break
      sleep 1
    done
  fi
  if [[ -n "$shadow" && -d "$shadow" ]]; then
    rm -rf --one-file-system "$shadow" || echo "SHADOW_CLEANUP_INCOMPLETE $shadow" >&2
  fi
}
trap finish EXIT

[[ -d "$packet" ]] || fail PACKET_MISSING "$packet"
[[ -d "$state_data" ]] || fail STATE_MISSING "$state_data"
if [[ ! -x "$nspawn" || ! -x "$machinectl" ]]; then
  echo "SHADOW_INSTALL systemd-container"
  /usr/bin/apt-get install -y -qq --no-install-recommends systemd-container > /dev/null || fail TOOLS_MISSING "could not install systemd-container"
fi
"$machinectl" show "$machine" > /dev/null 2>&1 && "$machinectl" terminate "$machine" > /dev/null 2>&1 || true

needed=$(( $(du -sb "$state_data" | cut -f1) * 2 + 1073741824 ))
available=$(df --output=avail -B1 "$shadow_parent" | tail -1 | tr -d ' ')
[[ "$available" -ge "$needed" ]] || fail DISK_LOW "need $needed bytes under $shadow_parent, have $available"

shadow="$(mktemp -d "$shadow_parent/himawari-shadow.XXXXXX")"
mkdir "$shadow/data"
echo "SHADOW_COPY_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
/usr/bin/python3 -I "$here/shadow-copy.py" "$state_data" "$shadow/data" || fail COPY_FAILED "could not copy $state_data"
echo "SHADOW_COPY_DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir "$shadow/layer" "$shadow/root"
truncate -s "$upper_size" "$shadow/upper.img"
"$mkfs" -q -F -m 0 "$shadow/upper.img" > /dev/null || fail UPPER_LAYER_FAILED "could not make the throwaway layer file $shadow/upper.img"

echo "SHADOW_BOOT_START"
"$unshare" --mount --propagation private /bin/bash -c '
set -e
"$1" -o loop "$2/upper.img" "$2/layer"
mkdir "$2/layer/upper" "$2/layer/work"
"$1" -t overlay overlay -o "lowerdir=/,upperdir=$2/layer/upper,workdir=$2/layer/work" "$2/root"
shift 2
exec "$@"
' shadow-root "$mount" "$shadow" "$nspawn" --quiet --directory="$shadow/root" --private-network --link-journal=no --machine="$machine" --hostname="$(hostname)" --console=passive --bind="$shadow/data:$state_data" --property="MemoryMax=$memory_max" --boot > "$shadow/boot.log" 2>&1 &
launcher=$!
booted=1
inside() {
  "$systemd_run" --machine="$machine" --quiet --wait --pipe --collect "$@"
}
ready=0
for _ in $(seq 1 "$boot_wait"); do
  if state="$(inside "$systemctl" is-system-running 2>/dev/null)" || [[ "$state" == degraded ]]; then
    ready=1
    break
  fi
  kill -0 "$launcher" 2> /dev/null || fail BOOT_EXITED "the shadow machine exited while booting: $(tail -5 "$shadow/boot.log" | tr '\n' ' ')"
  sleep 1
done
[[ "$ready" -eq 1 ]] || fail BOOT_TIMEOUT "the shadow machine did not finish booting in $boot_wait seconds: $(tail -5 "$shadow/boot.log" | tr '\n' ' ')"
active=0
for _ in $(seq 1 "$service_wait"); do
  if [[ "$(inside "$systemctl" is-active "$unit" 2>/dev/null)" == active ]]; then
    active=1
    break
  fi
  sleep 1
done
[[ "$active" -eq 1 ]] || fail OLD_SERVICE_NOT_ACTIVE "$unit did not start on the copied data: $(inside /usr/bin/journalctl -u "$unit" -n 20 --no-pager 2>&1 | tr '\n' ' ' | cut -c1-2000)"
echo "SHADOW_BOOTED"

echo "SHADOW_DEPLOY_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
inside --setenv=HIMAWARI_DEPLOY_ON_FAILURE=keep /bin/bash "$here/deploy.sh" "$packet" > "$shadow/deploy.log" 2>&1
code=$?
set -e
sed 's/^/SHADOW| /' "$shadow/deploy.log" | tail -200
if [[ "$code" -ne 0 ]]; then
  stopped_at="$(sed -n 's/^DEPLOY_STOPPED_AT \([A-Z0-9_]*\).*/\1/p' "$shadow/deploy.log" | tail -1)"
  fail "DEPLOY_${stopped_at:-UNKNOWN}" "the deploy failed on a copy of production; production was not touched (exit $code)"
fi
grep -q '^DEPLOY_PASSED$' "$shadow/deploy.log" || fail DEPLOY_UNFINISHED "the deploy on the copy did not print DEPLOY_PASSED"
echo "SHADOW_REHEARSAL_PASSED $(date -u +%Y-%m-%dT%H:%M:%SZ)"
