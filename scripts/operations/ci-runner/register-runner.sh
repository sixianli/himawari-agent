#!/bin/bash
set -euo pipefail

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

require_runner_host
command -v python3 > /dev/null || { echo "missing python3" >&2; exit 66; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
case " $RUNNER_IDS " in
  *" ${1:-none} "*) ;;
  *) echo "usage: sudo bash register-runner.sh <1|2|3|6> with the registration token on stdin (4 or 5 with RUNNER_SITE=arm on the ARM machine)" >&2; exit 64 ;;
esac
case "$1" in
  1|2|3|6) runner_select "$1" ;;
  4|5) runner_select "$1" ;;
esac
ACTIONS_RUNNER_INPUT_TOKEN=""
IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN || true
[ -n "$ACTIONS_RUNNER_INPUT_TOKEN" ] || { echo "no registration token on stdin" >&2; exit 64; }
if ! python3 -I -c 'import sys; sys.exit(0 if "ACTIONS_RUNNER_INPUT_".encode("utf-16-le") in open(sys.argv[1], "rb").read() else 1)' "$RUNNER_ROOT/runner/bin/Runner.Listener.dll"; then
  echo "this runner build does not read ACTIONS_RUNNER_INPUT_TOKEN; refusing to pass the token on the command line" >&2
  exit 66
fi
export ACTIONS_RUNNER_INPUT_TOKEN

cd "$RUNNER_ROOT/runner"
sudo -u "$RUNNER_USER" --preserve-env=ACTIONS_RUNNER_INPUT_TOKEN HOME="$RUNNER_ROOT/home" ./config.sh \
  --unattended \
  --url https://github.com/sixianli/himawari-agent \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABEL" \
  --work _work \
  --replace
unset ACTIONS_RUNNER_INPUT_TOKEN

systemctl enable --now "$RUNNER_UNIT"
sleep 5
systemctl is-active "$RUNNER_UNIT"
echo "REGISTER_OK runner=$RUNNER_NAME unit=$RUNNER_UNIT"
