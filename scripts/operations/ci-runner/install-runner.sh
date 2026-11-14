#!/bin/bash
set -Eeuo pipefail

VERSION=2.338.2
HERE=.
[[ ${BASH_SOURCE[0]} == */* ]] && HERE=${BASH_SOURCE[0]%/*}
SRC=$(cd "$HERE" && pwd)
UNIT_DIR=/etc/systemd/system
SUDOERS_FILE=/etc/sudoers.d/91-gh-runner-control

source "$SRC/runners.sh"
SHARED=$RUNNER_COMMON_ROOT
SHA256=$RUNNER_PACKAGE_SHA256
URL=https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-$RUNNER_PACKAGE_ARCH-$VERSION.tar.gz
SEND_KEYS=$RUNNER_SEND_HOME/.ssh/authorized_keys

require_runner_host
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
for tool in nft visudo useradd groupadd getent sha256sum curl ss python3; do
  command -v "$tool" > /dev/null || { echo "missing $tool" >&2; exit 66; }
done


SEND_KEY=""
if [ "$RUNNER_SITE" = arm ]; then
  command -v sshd > /dev/null || { echo "missing sshd" >&2; exit 66; }
  SEND_KEY=${RUNNER_SEND_PUBLIC_KEY:-}
  SEND_FROM=${RUNNER_SEND_FROM:-}
  [[ "$SEND_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]{60,100}$ ]] || { echo "RUNNER_SEND_PUBLIC_KEY must be the ssh-ed25519 public key printed by install-gate-remote.sh on the CI VPS (type and key only, no comment)" >&2; exit 64; }
  [[ "$SEND_FROM" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "RUNNER_SEND_FROM must be the IPv4 address of the CI VPS" >&2; exit 64; }
fi

for id in $RUNNER_IDS; do
  runner_select "$id"
  if systemctl is-active --quiet "$RUNNER_UNIT"; then
    echo "$RUNNER_UNIT is running; run scripts/operations/ci-runner/pause-runners.sh on the Mac first so no job is cut off" >&2
    exit 70
  fi
done

INSTALL_PATHS="$UNIT_DIR/gh-runner-nft.service $UNIT_DIR/gh-runner-clean.service $UNIT_DIR/gh-runner-clean.timer /etc/gh-runner $SUDOERS_FILE $SHARED/bin"
for unit in $RUNNER_SLICE_UNITS; do
  INSTALL_PATHS="$INSTALL_PATHS $UNIT_DIR/$unit"
done
for id in $RUNNER_IDS; do
  runner_select "$id"
  INSTALL_PATHS="$INSTALL_PATHS $UNIT_DIR/$RUNNER_UNIT $RUNNER_ROOT/hooks"
done
[ -z "$SEND_KEY" ] || INSTALL_PATHS="$INSTALL_PATHS $RUNNER_SEND_SCRIPT $SEND_KEYS"

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

install_runner_share() {
  if ! getent group "$RUNNER_SHARE_GROUP" > /dev/null; then
    if [ -e "$RUNNER_SHARE_ROOT" ] || [ -L "$RUNNER_SHARE_ROOT" ]; then
      echo "$RUNNER_SHARE_ROOT exists but group $RUNNER_SHARE_GROUP does not; refusing to take over a directory this script did not create" >&2
      return 71
    fi
    record_created_group "$BACKUP" "$RUNNER_SHARE_GROUP"
    groupadd --system "$RUNNER_SHARE_GROUP"
  fi
  record_created_paths "$BACKUP" "$RUNNER_SHARE_ROOT"
  install -d -m 2770 -o root -g "$RUNNER_SHARE_GROUP" "$RUNNER_SHARE_ROOT"
}

install_report_sender() {
  if id "$RUNNER_SEND_USER" > /dev/null 2>&1; then
    [ -d "$RUNNER_SEND_HOME" ] || { echo "a $RUNNER_SEND_USER user exists but $RUNNER_SEND_HOME does not; refusing to take over an account this script did not create" >&2; return 69; }
  else
    record_created_account "$BACKUP" "$RUNNER_SEND_USER"
    useradd --system --user-group --groups "$RUNNER_SHARE_GROUP" --home-dir "$RUNNER_SEND_HOME" --no-create-home --shell /bin/sh "$RUNNER_SEND_USER"
  fi
  record_created_paths "$BACKUP" "$RUNNER_SEND_HOME" "${RUNNER_SEND_SCRIPT%/*}"
  install -d -m 0755 -o root -g root "$RUNNER_SEND_HOME" "$RUNNER_SEND_HOME/.ssh" "${RUNNER_SEND_SCRIPT%/*}"
  local rendered
  rendered=$(mktemp)
  sed -e "s|@SHARE@|$RUNNER_SHARE_ROOT|g" "$SRC/send-reports.py" > "$rendered"
  install -m 0755 -o root -g root "$rendered" "$RUNNER_SEND_SCRIPT"
  printf 'restrict,from="%s",command="%s" %s\n' "$SEND_FROM" "$RUNNER_SEND_SCRIPT" "$SEND_KEY" > "$rendered"
  install -m 0644 -o root -g root "$rendered" "$SEND_KEYS"
  rm -f "$rendered"
}

install_runner_share
[ -z "$SEND_KEY" ] || install_report_sender
record_created_paths "$BACKUP" "$SHARED/hooks" "$SHARED"
install -d -m 0755 -o root -g root "$SHARED" "$SHARED/hooks"
for id in $RUNNER_IDS; do
  runner_select "$id"
  install_runner_account
done

rm -f -- "$SHARED/bin/runner-pause.sh" "$SHARED/bin/runner-resume.sh" "$SHARED/bin/runners.sh"
[ ! -d "$SHARED/bin" ] || rmdir --ignore-fail-on-non-empty -- "$SHARED/bin"
install -m 0755 -o root -g root "$SRC/clean-old.sh" "$SRC/runners.sh" "$SHARED/hooks/"
for unit in $RUNNER_SLICE_UNITS; do
  install -m 0644 -o root -g root "$SRC/$unit" "$UNIT_DIR/"
done
install -m 0644 -o root -g root "$SRC/gh-runner-nft.service" "$SRC/gh-runner-clean.service" "$SRC/gh-runner-clean.timer" "$UNIT_DIR/"
[ "$RUNNER_SITE" = vps ] || sed -i "s|^ExecStart=|Environment=RUNNER_SITE=$RUNNER_SITE\nExecStart=|" "$UNIT_DIR/gh-runner-clean.service"

apply_runner_controls

systemctl daemon-reload
record_newly_enabled_units "$BACKUP" gh-runner-nft.service gh-runner-clean.timer
systemctl enable --now gh-runner-nft.service gh-runner-clean.timer
nft list table inet gh_runner > /dev/null
trap - ERR INT TERM HUP

echo "INSTALL_OK site=$RUNNER_SITE version=$VERSION share=$RUNNER_SHARE_ROOT runner_uids=$RUNNER_CONTROL_UIDS blocked_local_ports=$RUNNER_CONTROL_PORTS backup=$BACKUP"
