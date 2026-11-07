#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

[ "$(hostname)" = hermes-home ] || { echo "this script only runs on hermes-home, not $(hostname)" >&2; exit 68; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
case "${1:-}" in
  2) REMOVE="2" ;;
  all) REMOVE="$RUNNER_IDS" ;;
  *) echo "usage: sudo bash uninstall-runner.sh <2|all>   (2 removes only the second runner; all removes both and the shared files)" >&2; exit 64 ;;
esac
command -v nft > /dev/null || { echo "missing nft; cannot remove or verify the firewall table" >&2; exit 66; }

SHARED_UNITS="/etc/systemd/system/gh-runners.slice /etc/systemd/system/gh-runner-nft.service /etc/systemd/system/gh-runner-clean.service /etc/systemd/system/gh-runner-clean.timer"
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
  rm -rf /etc/gh-runner
  for path in $SHARED_UNITS /etc/sudoers.d/91-gh-runner-control /etc/gh-runner; do
    [ -e "$path" ] && LEFT="$LEFT $path"
  done
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
