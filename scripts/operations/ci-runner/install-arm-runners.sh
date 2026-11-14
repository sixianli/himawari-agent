#!/bin/bash
set -u

HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
source "$HERE/runners.sh"

[ "$RUNNER_SITE" = vps ] || { echo "ARM_INSTALL_FAILED run it without RUNNER_SITE; it sets the site for each machine itself"; exit 64; }
REPO=${HIMAWARI_REPO:-sixianli/himawari-agent}
VPS=${CI_VPS_SSH:-ubuntu@158.69.191.249}
ARM=${CI_ARM_SSH:-ubuntu@138.2.31.252}
REMOTE=${CI_RUNNER_DIR:-/home/ubuntu/ci-runner}
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
ARM_FILES="runners.sh prepare-arm.sh install-runner.sh register-runner.sh uninstall-runner.sh runner-pause.sh runner-resume.sh clean-old.sh job-started.sh job-completed.sh send-reports.py gh-runner.service.in gh-arm-runners.slice gh-runner-nft.service gh-runner-clean.service gh-runner-clean.timer"
VPS_FILES="runners.sh install-gate-remote.sh"
KEY_PATTERN='^ssh-ed25519 [A-Za-z0-9+/=]{60,100}$'

failed() {
  echo "ARM_INSTALL_FAILED step=$1: $2"
  echo "nothing on GitHub or on the CI VPS runners was changed by a failed step; fix the cause and run install-arm-runners.sh again, finished steps are repeated safely"
  exit 1
}

on_vps() {
  ssh "${SSH_OPTIONS[@]}" "$VPS" "[ \"\$(hostname)\" = $RUNNER_HOST ] || { echo \"not $RUNNER_HOST\" >&2; exit 68; }; $1"
}

on_arm() {
  ssh "${SSH_OPTIONS[@]}" "$ARM" "[ \"\$(uname -s)-\$(uname -m)\" = Linux-aarch64 ] || { echo \"not the ARM machine\" >&2; exit 68; }; export RUNNER_SITE=arm; $1"
}

upload() {
  local target=$1 name
  shift
  ssh "${SSH_OPTIONS[@]}" "$target" "mkdir -p $REMOTE" || return 1
  for name in "$@"; do
    scp -q "${SSH_OPTIONS[@]}" "$HERE/$name" "$target:$REMOTE/$name" > /dev/null || { echo "upload of $name to $target failed"; return 1; }
  done
}

echo "ARM_INSTALL_STEP 1/8 checking that both machines answer and sudo needs no password"
on_vps "sudo -n true" || failed 1 "could not run sudo on the CI VPS ($VPS)"
on_arm "sudo -n true" || failed 1 "could not run sudo on the ARM machine ($ARM)"
VPS_ADDRESS=${VPS#*@}
[[ "$VPS_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || failed 1 "CI_VPS_SSH must end in the IPv4 address of the CI VPS, the ARM machine only accepts the report key from that address"

echo "ARM_INSTALL_STEP 2/8 uploading the scripts"
upload "$ARM" $ARM_FILES || failed 2 "upload to the ARM machine"
upload "$VPS" $VPS_FILES || failed 2 "upload to the CI VPS"

echo "ARM_INSTALL_STEP 3/8 preparing the ARM machine (packages, facts about the machine)"
on_arm "sudo bash $REMOTE/prepare-arm.sh" || failed 3 "prepare-arm.sh refused or failed; its CI_ARM_PREPARE_FAILED line says why"

echo "ARM_INSTALL_STEP 4/8 creating the key the gate runner fetches reports with"
KEY_LINE=$(on_vps "sudo bash $REMOTE/install-gate-remote.sh key") || failed 4 "install-gate-remote.sh key"
SEND_KEY=$(printf '%s\n' "$KEY_LINE" | sed -n 's/^GATE_REMOTE_KEY //p')
[[ "$SEND_KEY" =~ $KEY_PATTERN ]] || failed 4 "the CI VPS did not print a public key"

echo "ARM_INSTALL_STEP 5/8 installing two runners and the report account on the ARM machine"
if on_arm "systemctl is-active --quiet gh-runner-arm-1.service || systemctl is-active --quiet gh-runner-arm-2.service"; then
  echo "a runner service is already running on the ARM machine, so the install is not repeated; to reinstall run RUNNER_SITE=arm bash pause-runners.sh first"
else
  on_arm "sudo RUNNER_SITE=arm RUNNER_SEND_PUBLIC_KEY='$SEND_KEY' RUNNER_SEND_FROM=$VPS_ADDRESS bash $REMOTE/install-runner.sh" || failed 5 "install-runner.sh; it puts back what it changed when it fails"
fi

echo "ARM_INSTALL_STEP 6/8 telling the gate runner where the ARM machine is and checking the fetch"
HOST_KEY=$(on_arm "cat /etc/ssh/ssh_host_ed25519_key.pub" | awk '{print $1 " " $2; exit}')
[[ "$HOST_KEY" =~ $KEY_PATTERN ]] || failed 6 "could not read the host key of the ARM machine"
on_vps "sudo bash $REMOTE/install-gate-remote.sh trust $RUNNER_SEND_USER@${ARM#*@} '$HOST_KEY'" || failed 6 "install-gate-remote.sh trust"
on_vps "sudo bash $REMOTE/install-gate-remote.sh check" || failed 6 "the gate runner could not fetch from the ARM machine; the GATE_REMOTE_FAILED line says what ssh answered"

echo "ARM_INSTALL_STEP 7/8 registering the runners on GitHub"
for entry in 4:gh-runner-arm-1.service 5:gh-runner-arm-2.service; do
  id=${entry%%:*}
  unit=${entry#*:}
  if on_arm "systemctl is-enabled --quiet $unit && systemctl is-active --quiet $unit"; then
    echo "runner $id is already registered and running"
    continue
  fi
  TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token) || failed 7 "could not get a registration token from GitHub"
  [ -n "$TOKEN" ] || failed 7 "GitHub returned an empty registration token"
  printf '%s\n' "$TOKEN" | on_arm "sudo RUNNER_SITE=arm bash $REMOTE/register-runner.sh $id" || failed 7 "register-runner.sh $id"
done
unset TOKEN

echo "ARM_INSTALL_STEP 8/8 waiting for GitHub to show both runners online"
DEADLINE=$(($(date +%s) + 180))
while :; do
  TABLE=$(gh api "repos/$REPO/actions/runners" --paginate --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv') || TABLE=""
  MISSING=""
  for name in ci-arm-1 ci-arm-2; do
    printf '%s\n' "$TABLE" | awk -F'\t' -v name="$name" -v label="$RUNNER_ARM_LABEL" '$1 == name && $2 == "online" && ("," $3 ",") ~ ("," label ",") { found = 1 } END { exit !found }' || MISSING="$MISSING $name"
  done
  [ -z "$MISSING" ] && break
  [ "$(date +%s)" -lt "$DEADLINE" ] || failed 8 "not online with the $RUNNER_ARM_LABEL label after 3 minutes:$MISSING"
  sleep "${RUNNER_POLL_SECONDS:-15}"
done
echo "ARM_INSTALL_OK runners=ci-arm-1 ci-arm-2 label=$RUNNER_ARM_LABEL report_account=$RUNNER_SEND_USER@${ARM#*@}; .github/workflows/ci.yml runs policy, static and security on it"
