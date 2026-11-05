#!/bin/bash
set -euo pipefail

ROOT=/srv/gh-runner

[ "$(hostname)" = hermes-home ] || { echo "this script only runs on hermes-home, not $(hostname)" >&2; exit 68; }
command -v python3 > /dev/null || { echo "missing python3" >&2; exit 66; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
[ -n "$ACTIONS_RUNNER_INPUT_TOKEN" ] || { echo "no registration token on stdin" >&2; exit 64; }
if ! python3 -I -c 'import sys; sys.exit(0 if "ACTIONS_RUNNER_INPUT_".encode("utf-16-le") in open(sys.argv[1], "rb").read() else 1)' $ROOT/runner/bin/Runner.Listener.dll; then
  echo "this runner build does not read ACTIONS_RUNNER_INPUT_TOKEN; refusing to pass the token on the command line" >&2
  exit 66
fi
export ACTIONS_RUNNER_INPUT_TOKEN

cd $ROOT/runner
sudo -u gh-runner --preserve-env=ACTIONS_RUNNER_INPUT_TOKEN HOME=$ROOT/home ./config.sh \
  --unattended \
  --url https://github.com/sixianli/himawari-agent \
  --name hermes-home \
  --labels hermes-home \
  --work _work \
  --replace
unset ACTIONS_RUNNER_INPUT_TOKEN

systemctl enable --now gh-runner.service
sleep 5
systemctl is-active gh-runner.service
echo "REGISTER_OK"
