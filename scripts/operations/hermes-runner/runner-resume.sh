#!/bin/bash
set -u

sudo -n /usr/bin/systemctl start gh-runner.service || { echo "RUNNER_RESUME_FAILED systemctl start"; exit 1; }
for _ in 1 2 3 4 5 6; do
  if systemctl is-active --quiet gh-runner.service; then
    echo "RUNNER_RESUMED $(date -Is)"
    exit 0
  fi
  sleep 5
done
echo "RUNNER_RESUME_FAILED service not active after 30s"
exit 1
