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
nsenter="$tools/nsenter"
machinectl="$tools/machinectl"
systemctl="$tools/systemctl"
unshare="$tools/unshare"
mount="$tools/mount"
mkfs="${HIMAWARI_SHADOW_SBIN:-/usr/sbin}/mkfs.ext4"
findmnt="$tools/findmnt"
proc_filesystems="${HIMAWARI_SHADOW_PROC_FILESYSTEMS:-/proc/filesystems}"
loop_control="${HIMAWARI_SHADOW_LOOP_CONTROL:-/dev/loop-control}"
upper_size="${HIMAWARI_SHADOW_UPPER_SIZE:-8G}"
machine="himawari-shadow"
boot_wait="${HIMAWARI_SHADOW_BOOT_WAIT:-300}"
service_wait="${HIMAWARI_SHADOW_SERVICE_WAIT:-120}"
service_settle="${HIMAWARI_SHADOW_SERVICE_SETTLE:-30}"
probe_timeout="${HIMAWARI_SHADOW_PROBE_TIMEOUT:-15}"
masked_units="${HIMAWARI_SHADOW_MASKED_UNITS:-oracle-keepalive.service cloudflared.service}"
shadow=""
booted=0
launcher=""

fail() {
  echo "SHADOW_REHEARSAL_FAILED $1: $2" >&2
  exit 1
}

launcher_alive() {
  [[ -n "$launcher" && -r "/proc/$launcher/stat" && "$(cut -d' ' -f3 "/proc/$launcher/stat" 2> /dev/null)" != Z ]]
}

finish() {
  if [[ "$booted" -eq 1 ]]; then
    "$machinectl" terminate "$machine" > /dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      "$machinectl" show "$machine" > /dev/null 2>&1 || break
      sleep 1
    done
    for _ in $(seq 1 60); do
      launcher_alive || break
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
if "$machinectl" show "$machine" > /dev/null 2>&1; then
  echo "SHADOW_LEFTOVER_MACHINE $machine"
  "$machinectl" terminate "$machine" > /dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    "$machinectl" show "$machine" > /dev/null 2>&1 || break
    sleep 1
  done
fi
for leftover in "$shadow_parent"/himawari-shadow.*; do
  [[ -d "$leftover" ]] || continue
  echo "SHADOW_LEFTOVER_REMOVED $leftover"
  rm -rf --one-file-system "$leftover" || fail LEFTOVER_STUCK "could not remove $leftover from an earlier rehearsal"
done

/usr/sbin/modprobe overlay > /dev/null 2>&1 || true
/usr/sbin/modprobe loop > /dev/null 2>&1 || true
echo "SHADOW_HOST arch=$(uname -m) kernel=$(uname -r) overlay=$(grep -qw overlay "$proc_filesystems" && echo yes || echo no) loop=$([[ -e "$loop_control" ]] && echo yes || echo no) memAvailableKiB=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo) nspawn=$("$nspawn" --version 2>/dev/null | head -1 | tr ' ' '_')"
grep -qw overlay "$proc_filesystems" || fail OVERLAY_UNSUPPORTED "this kernel has no overlay filesystem"
[[ -e "$loop_control" ]] || fail LOOP_UNSUPPORTED "this kernel has no loop devices"
not_copied="$("$findmnt" -rn -o TARGET,FSTYPE | awk '$1 != "/" && $1 !~ "^/boot(/|$)" && $2 ~ /^(ext[234]|xfs|btrfs|f2fs|zfs)$/ {print $1}' | tr '\n' ' ')"
[[ -z "$not_copied" ]] || fail SUBMOUNTS_NOT_COPIED "these filesystems are mounted under / and would be missing from the shadow machine: $not_copied"

upper_bytes="$(numfmt --from=iec "$upper_size")"
needed=$(( $(du -sb "$state_data" | cut -f1) * 2 + upper_bytes + 1073741824 ))
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

boot_started="$(date +%s)"
echo "SHADOW_BOOT_START"
"$unshare" --mount --propagation private /bin/bash -c '
set -e
"$1" -o loop "$2/upper.img" "$2/layer"
mkdir "$2/layer/upper" "$2/layer/work"
[ "$(id -u)" -ne 0 ] || chown --reference=/ "$2/layer/upper"
chmod --reference=/ "$2/layer/upper"
"$1" -t overlay overlay -o "lowerdir=/,upperdir=$2/layer/upper,workdir=$2/layer/work" "$2/root"
if [ -f "$2/root/etc/fstab" ]; then
  grep -vE "^[[:space:]]*(#|$)" "$2/root/etc/fstab" | sed "s/^/SHADOW_FSTAB_DROPPED /" || true
  : > "$2/root/etc/fstab"
fi
if [ -d "$2/root/etc/cloud" ]; then
  : > "$2/root/etc/cloud/cloud-init.disabled"
fi
for masked in $3; do
  ln -sfn /dev/null "$2/root/etc/systemd/system/$masked"
  echo "SHADOW_UNIT_MASKED $masked"
done
shift 3
exec "$@"
' shadow-root "$mount" "$shadow" "$masked_units" "$nspawn" --quiet --directory="$shadow/root" --private-network --link-journal=no --machine="$machine" --hostname="$(hostname)" --console=passive --bind="$shadow/data:$state_data" --property="MemoryMax=$memory_max" --boot > "$shadow/boot.log" 2>&1 9>&- &
launcher=$!
booted=1
leader=""
find_leader() {
  [[ -n "$leader" ]] && return 0
  leader="$("$machinectl" show "$machine" -p Leader --value 2> /dev/null || true)"
  [[ "$leader" =~ ^[1-9][0-9]*$ ]] || { leader=""; return 1; }
}
probe() {
  find_leader || return 1
  timeout "$probe_timeout" "$nsenter" --target="$leader" --mount --uts --ipc --net --pid -- "$systemctl" "$@"
}
look() {
  find_leader || return 1
  timeout "$probe_timeout" "$nsenter" --target="$leader" --mount --uts --ipc --net --pid -- "$@"
}
stuck_units() {
  find_leader || true
  echo "leader: ${leader:-unknown}"
  echo "jobs: $(probe list-jobs --no-pager --no-legend 2>&1 | head -20 | tr -s ' \n' ' ')"
  echo "failed: $(probe --failed --no-pager --no-legend 2>&1 | head -20 | tr -s ' \n' ' ')"
  echo "processes: $(look /bin/ps -eo pid,stat,etimes,args --no-headers 2>&1 | head -40 | cut -c1-160 | tr -s ' \n' ' ')"
  echo "journal: $(look /usr/bin/journalctl -b --no-pager -q -o short-monotonic -n 60 2>&1 | cut -c1-240 | tr '\n' '|')"
  echo "console: $(console_tail)"
}
console_tail() {
  sed 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/\r//g' "$shadow/boot.log" | grep -v '^[[:space:]]*$' | tail -40 | cut -c1-200 | tr '\n' '|'
}
boot_exit() {
  local status=0
  wait "$launcher" 2> /dev/null || status=$?
  launcher=""
  echo "nspawn exit=$status"
  echo "host journal: $(timeout "$probe_timeout" /usr/bin/journalctl --no-pager -q -o short-monotonic --since "@$boot_started" -k -t systemd -t systemd-machined -t systemd-nspawn -n 40 2>&1 | grep -iE 'shadow|nspawn|machine|oom|killed|memory' | tail -20 | cut -c1-240 | tr '\n' '|')"
  echo "console: $(console_tail)"
}
service_report() {
  echo "service: $(probe show "$unit" --no-pager -p ActiveState -p SubState -p Result -p MainPID -p NRestarts -p ExecMainStatus 2>&1 | tr '\n' ' ')"
  echo "service journal: $(look /usr/bin/journalctl -u "$unit" -n 40 --no-pager -q -o short-monotonic 2>&1 | cut -c1-300 | tr '\n' '|')"
}
deadline=$(( SECONDS + boot_wait ))
state=""
while (( SECONDS < deadline )); do
  launcher_alive || fail BOOT_EXITED "the shadow machine exited while booting; $(boot_exit)"
  state="$(probe is-system-running 2> /dev/null || true)"
  [[ "$state" == running || "$state" == degraded ]] && break
  [[ "$state" == maintenance ]] && fail BOOT_EMERGENCY "the shadow machine fell into emergency mode while booting; $(stuck_units)"
  sleep 2
done
grep -E '^SHADOW_(FSTAB_DROPPED|UNIT_MASKED) ' "$shadow/boot.log" || true
[[ "$state" == running || "$state" == degraded ]] || fail BOOT_TIMEOUT "the shadow machine did not finish booting in $boot_wait seconds (state ${state:-unreachable}); $(stuck_units)"
echo "SHADOW_SYSTEM_STATE $state"
deadline=$(( SECONDS + service_wait ))
active=""
while (( SECONDS < deadline )); do
  active="$(probe is-active "$unit" 2> /dev/null || true)"
  [[ "$active" == active ]] && break
  sleep 2
done
[[ "$active" == active ]] || fail OLD_SERVICE_NOT_ACTIVE "$unit did not start on the copied data (${active:-unreachable}); $(service_report); $(stuck_units)"
restarts="$(probe show "$unit" -p NRestarts --value 2> /dev/null || true)"
sleep "$service_settle"
active="$(probe is-active "$unit" 2> /dev/null || true)"
[[ "$active" == active && "$(probe show "$unit" -p NRestarts --value 2> /dev/null || true)" == "$restarts" ]] || fail OLD_SERVICE_NOT_STABLE "$unit started on the copied data but did not stay up for $service_settle seconds (${active:-unreachable}); $(service_report)"
echo "SHADOW_OLD_SERVICE_STABLE ${service_settle}s restarts=${restarts:-unknown}"
find_leader || fail LEADER_MISSING "machinectl does not name the shadow machine's first process"
echo "SHADOW_BOOTED leader=$leader"

echo "SHADOW_DEPLOY_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
passed_environment=("PATH=$PATH" "HIMAWARI_DEPLOY_ON_FAILURE=keep" "HIMAWARI_DEPLOY_FROM_STEP=S2_STOP")
while IFS= read -r name; do
  passed_environment+=("$name=${!name}")
done < <(compgen -e | grep -E '^HIMAWARI_' | grep -vE '^HIMAWARI_(SHADOW_|DEPLOY_SHADOW_REHEARSAL$|DEPLOY_ON_FAILURE$|DEPLOY_FROM_STEP$)' | sort)
timeout 60 "$nsenter" --target="$leader" --mount --uts --ipc --net --pid -- /bin/rm -rf -- "$(dirname "$packet")/.$(basename "$packet").deploy.lock"
timeout 2700 "$nsenter" --target="$leader" --mount --uts --ipc --net --pid -- /usr/bin/env -i "${passed_environment[@]}" /bin/bash "$here/deploy.sh" "$packet" < /dev/null > "$shadow/deploy.log" 2>&1
code=$?
set -e
sed 's/^/SHADOW| /' "$shadow/deploy.log" | tail -200
if [[ "$code" -ne 0 ]]; then
  stopped_at="$(sed -n 's/^DEPLOY_STOPPED_AT \([A-Z0-9_]*\).*/\1/p' "$shadow/deploy.log" | tail -1)"
  while IFS= read -r report; do
    echo "SHADOW_STEP_REPORT $report $(look /bin/cat -- "$report" 2>&1 | head -c 4000 | tr '\n' ' ')"
  done < <(sed -n 's/^STEP_FAILURE_REPORT \([^ ]*\).*/\1/p' "$shadow/deploy.log" | sort -u)
  service_report | sed 's/^/SHADOW_AFTER_FAILURE /'
  fail "DEPLOY_${stopped_at:-UNKNOWN}" "the deploy failed on a copy of production; production was not touched (exit $code)"
fi
grep -q '^DEPLOY_PASSED$' "$shadow/deploy.log" || fail DEPLOY_UNFINISHED "the deploy on the copy did not print DEPLOY_PASSED"
echo "SHADOW_REHEARSAL_PASSED $(date -u +%Y-%m-%dT%H:%M:%SZ)"
