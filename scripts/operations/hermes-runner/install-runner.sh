#!/bin/bash
set -Eeuo pipefail

VERSION=2.338.2
SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
URL=https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz
HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
SRC=$(cd "$HERE" && pwd)
SHARED=/srv/gh-runner
UNIT_DIR=/etc/systemd/system
SUDOERS_FILE=/etc/sudoers.d/91-gh-runner-control

source "$SRC/runners.sh"

[ "$(hostname)" = hermes-home ] || { echo "this script only runs on hermes-home, not $(hostname)" >&2; exit 68; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
for tool in nft visudo useradd sha256sum curl ss python3; do
  command -v "$tool" > /dev/null || { echo "missing $tool" >&2; exit 66; }
done

for id in $RUNNER_IDS; do
  runner_select "$id"
  if systemctl is-active --quiet "$RUNNER_UNIT"; then
    echo "$RUNNER_UNIT is running; run scripts/operations/hermes-runner/pause-runners.sh on the Mac first so no job is cut off" >&2
    exit 70
  fi
done

INSTALL_PATHS="$UNIT_DIR/gh-runners.slice $UNIT_DIR/gh-runner-nft.service $UNIT_DIR/gh-runner-clean.service $UNIT_DIR/gh-runner-clean.timer /etc/gh-runner $SUDOERS_FILE $SHARED/bin"
for id in $RUNNER_IDS; do
  runner_select "$id"
  INSTALL_PATHS="$INSTALL_PATHS $UNIT_DIR/$RUNNER_UNIT $RUNNER_ROOT/hooks"
done

BACKUP=/var/backups/gh-runner/$(date +%Y%m%dT%H%M%S)
install -d -m 0700 -o root -g root "$BACKUP"
backup_install_paths "$BACKUP" $INSTALL_PATHS

restore_backup() {
  trap - ERR
  trap '' INT TERM HUP PIPE
  set +e
  [ -z "${1:-}" ] || echo "INSTALL_STEP_FAILED $1" >&2
  echo "INSTALL_FAILED putting back units, firewall rules, sudo rules, scripts and new accounts from $BACKUP" >&2
  restore_install_paths "$BACKUP"
  systemctl daemon-reload
  if [ -e /etc/gh-runner/nft.rules ]; then
    nft -f /etc/gh-runner/nft.rules
  else
    nft delete table inet gh_runner 2> /dev/null
  fi
}
trap 'status=$?; restore_backup "line $LINENO exit $status: $BASH_COMMAND"; exit "$status"' ERR
trap 'restore_backup; exit 130' INT TERM HUP

install_runner_account() {
  if id "$RUNNER_USER" > /dev/null 2>&1; then
    [ -d "$RUNNER_ROOT/runner" ] || { echo "a $RUNNER_USER user exists but $RUNNER_ROOT/runner does not; refusing to take over an account this script did not create" >&2; return 69; }
  else
    record_created_account "$BACKUP" "$RUNNER_USER"
    useradd --system --user-group --home-dir "$RUNNER_ROOT/home" --no-create-home --shell /usr/sbin/nologin "$RUNNER_USER"
  fi
  if [ -n "$(id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -vx "$RUNNER_USER")" ]; then
    echo "$RUNNER_USER belongs to extra groups: $(id -nG "$RUNNER_USER")" >&2
    return 67
  fi

  record_created_paths "$BACKUP" "$RUNNER_ROOT/runner" "$RUNNER_ROOT/home" "$RUNNER_ROOT/logs" "$RUNNER_ROOT"
  install -d -m 0755 -o root -g root "$RUNNER_ROOT" "$RUNNER_ROOT/hooks"
  install -d -m 0750 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_ROOT/runner" "$RUNNER_ROOT/home" "$RUNNER_ROOT/logs"

  if [ ! -x "$RUNNER_ROOT/runner/config.sh" ]; then
    local download
    download=$(mktemp -d)
    curl -fsSL --max-time 240 -o "$download/runner.tar.gz" "$URL"
    echo "$SHA256  $download/runner.tar.gz" | sha256sum -c -
    chmod 0755 "$download"
    chmod 0644 "$download/runner.tar.gz"
    sudo -u "$RUNNER_USER" tar -xzf "$download/runner.tar.gz" -C "$RUNNER_ROOT/runner"
    rm -rf "$download"
  fi

  install -m 0755 -o root -g root "$SRC/job-started.sh" "$SRC/job-completed.sh" "$RUNNER_ROOT/hooks/"
  render_runner_unit "$id" "$SRC/gh-runner.service.in" > "$UNIT_DIR/$RUNNER_UNIT"
  chmod 0644 "$UNIT_DIR/$RUNNER_UNIT"
}

for id in $RUNNER_IDS; do
  runner_select "$id"
  install_runner_account
done

rm -f -- "$SHARED/bin/runner-pause.sh" "$SHARED/bin/runner-resume.sh" "$SHARED/bin/runners.sh"
[ ! -d "$SHARED/bin" ] || rmdir --ignore-fail-on-non-empty -- "$SHARED/bin"
install -m 0755 -o root -g root "$SRC/clean-old.sh" "$SRC/runners.sh" "$SHARED/hooks/"
install -m 0644 -o root -g root "$SRC/gh-runners.slice" "$SRC/gh-runner-nft.service" "$SRC/gh-runner-clean.service" "$SRC/gh-runner-clean.timer" "$UNIT_DIR/"

apply_runner_controls

systemctl daemon-reload
record_newly_enabled_units "$BACKUP" gh-runner-nft.service gh-runner-clean.timer
systemctl enable --now gh-runner-nft.service gh-runner-clean.timer
nft list table inet gh_runner > /dev/null
trap - ERR INT TERM HUP

echo "INSTALL_OK version=$VERSION runner_uids=$RUNNER_CONTROL_UIDS blocked_local_ports=$RUNNER_CONTROL_PORTS backup=$BACKUP"
