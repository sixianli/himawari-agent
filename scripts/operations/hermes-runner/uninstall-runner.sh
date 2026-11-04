#!/bin/bash
set -u

[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }

systemctl disable --now gh-runner.service gh-runner-clean.timer 2>/dev/null
systemctl disable --now gh-runner-nft.service 2>/dev/null
nft delete table inet gh_runner 2>/dev/null
rm -f /etc/systemd/system/gh-runner.service /etc/systemd/system/gh-runner-nft.service /etc/systemd/system/gh-runner-clean.service /etc/systemd/system/gh-runner-clean.timer
rm -f /etc/sudoers.d/91-gh-runner-control
rm -rf /etc/gh-runner
systemctl daemon-reload
pkill -u gh-runner 2>/dev/null
rm -rf /srv/gh-runner
id gh-runner > /dev/null 2>&1 && userdel gh-runner
getent group gh-runner > /dev/null && groupdel gh-runner

echo "UNINSTALL_OK; also remove the runner on GitHub: gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<runner id>"
