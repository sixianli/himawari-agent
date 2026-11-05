#!/bin/bash
set -u

[ "$(hostname)" = hermes-home ] || { echo "this script only runs on hermes-home, not $(hostname)" >&2; exit 68; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }

UNITS="/etc/systemd/system/gh-runner.service /etc/systemd/system/gh-runner-nft.service /etc/systemd/system/gh-runner-clean.service /etc/systemd/system/gh-runner-clean.timer"

systemctl disable --now gh-runner.service gh-runner-clean.timer 2>/dev/null
systemctl disable --now gh-runner-nft.service 2>/dev/null
nft delete table inet gh_runner 2>/dev/null
rm -f $UNITS
rm -f /etc/sudoers.d/91-gh-runner-control
rm -rf /etc/gh-runner
systemctl daemon-reload
pkill -u gh-runner 2>/dev/null
rm -rf /srv/gh-runner
id gh-runner > /dev/null 2>&1 && userdel gh-runner
getent group gh-runner > /dev/null && groupdel gh-runner

LEFT=""
for path in $UNITS /etc/sudoers.d/91-gh-runner-control /etc/gh-runner /srv/gh-runner; do
  [ -e "$path" ] && LEFT="$LEFT $path"
done
nft list table inet gh_runner > /dev/null 2>&1 && LEFT="$LEFT nft:inet/gh_runner"
id gh-runner > /dev/null 2>&1 && LEFT="$LEFT user:gh-runner"
getent group gh-runner > /dev/null 2>&1 && LEFT="$LEFT group:gh-runner"
if [ -n "$LEFT" ]; then
  echo "UNINSTALL_INCOMPLETE still present:$LEFT" >&2
  exit 1
fi

echo "UNINSTALL_OK; also remove the runner on GitHub: gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<runner id>"
