#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

require_runner_host
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
REMOVE=""
case "$RUNNER_SITE:${1:-}" in
  vps:2 | vps:3 | vps:6 | arm:5) REMOVE=$1 ;;
  *:all) REMOVE=$RUNNER_IDS ;;
esac
[ -n "$REMOVE" ] || { echo "usage: sudo bash uninstall-runner.sh <2|3|6|all>   (2 removes only the second check runner; 3 removes only the gate runner; 6 removes only the third check runner; all removes every runner and the shared files; with RUNNER_SITE=arm on the ARM machine: 5 or all)" >&2; exit 64; }
command -v nft > /dev/null || { echo "missing nft; cannot remove or verify the firewall table" >&2; exit 66; }

SHARED_UNITS=""
for unit in $RUNNER_SLICE_UNITS gh-runner-nft.service gh-runner-clean.service gh-runner-clean.timer; do
  SHARED_UNITS="${SHARED_UNITS:+$SHARED_UNITS }/etc/systemd/system/$unit"
done
SEND_PATHS=""
[ "$RUNNER_SITE" = vps ] || SEND_PATHS="$RUNNER_SEND_HOME ${RUNNER_SEND_SCRIPT%/*} $RUNNER_COMMON_ROOT"
LEFT=""
NAMES=""

for id in $REMOVE; do
  runner_select "$id"
  systemctl disable --now "$RUNNER_UNIT" 2>/dev/null
  pkill -u "$RUNNER_USER" 2>/dev/null
  rm -f "/etc/systemd/system/$RUNNER_UNIT"
  rm -rf "$RUNNER_ROOT"
  id "$RUNNER_USER" > /dev/null 2>&1 && userdel "$RUNNER_USER"
  getent group "$RUNNER_USER" > /dev/null && groupdel "$RUNNER_USER"
  NAMES="$NAMES $RUNNER_NAME"
done

if [ "$1" = all ]; then
  systemctl disable --now gh-runner-clean.timer 2>/dev/null
  systemctl disable --now gh-runner-nft.service 2>/dev/null
  nft delete table inet gh_runner 2>/dev/null
  rm -f $SHARED_UNITS
  rm -f /etc/sudoers.d/91-gh-runner-control
  rm -rf /etc/gh-runner "$RUNNER_SHARE_ROOT"
  if [ -n "$SEND_PATHS" ]; then
    pkill -u "$RUNNER_SEND_USER" 2>/dev/null
    id "$RUNNER_SEND_USER" > /dev/null 2>&1 && userdel "$RUNNER_SEND_USER"
    getent group "$RUNNER_SEND_USER" > /dev/null && groupdel "$RUNNER_SEND_USER"
    rm -rf $SEND_PATHS
    id "$RUNNER_SEND_USER" > /dev/null 2>&1 && LEFT="$LEFT user:$RUNNER_SEND_USER"
  fi
  getent group "$RUNNER_SHARE_GROUP" > /dev/null && groupdel "$RUNNER_SHARE_GROUP"
  for path in $SHARED_UNITS /etc/sudoers.d/91-gh-runner-control /etc/gh-runner "$RUNNER_SHARE_ROOT" $SEND_PATHS; do
    [ -e "$path" ] && LEFT="$LEFT $path"
  done
  getent group "$RUNNER_SHARE_GROUP" > /dev/null 2>&1 && LEFT="$LEFT group:$RUNNER_SHARE_GROUP"
  nft list table inet gh_runner > /dev/null 2>&1 && LEFT="$LEFT nft:inet/gh_runner"
else
  apply_runner_controls || LEFT="$LEFT firewall-and-sudo-rules-not-rewritten"
fi
systemctl daemon-reload

for id in $REMOVE; do
  runner_select "$id"
  for path in "/etc/systemd/system/$RUNNER_UNIT" "$RUNNER_ROOT"; do
    [ -e "$path" ] && LEFT="$LEFT $path"
  done
  id "$RUNNER_USER" > /dev/null 2>&1 && LEFT="$LEFT user:$RUNNER_USER"
  getent group "$RUNNER_USER" > /dev/null 2>&1 && LEFT="$LEFT group:$RUNNER_USER"
done
if [ -n "$LEFT" ]; then
  echo "UNINSTALL_INCOMPLETE still present:$LEFT " >&2
  exit 1
fi

echo "UNINSTALL_OK removed:$NAMES; also remove them on GitHub: gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<runner id>"
