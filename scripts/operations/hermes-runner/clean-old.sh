#!/bin/bash
set -u

if pgrep -u gh-runner -x Runner.Worker > /dev/null; then
  exit 0
fi
[ -d /srv/gh-runner/runner/_work ] && find /srv/gh-runner/runner/_work -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf -- {} +
[ -d /srv/gh-runner/runner/_diag ] && find /srv/gh-runner/runner/_diag -type f -mtime +14 -delete
exit 0
