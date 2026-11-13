#!/usr/bin/env bash
set -euo pipefail
umask 022

CI_HOSTNAME=ci-vps
ORIGINAL_HOSTNAME=vps-482b8c36
NODE_VERSION=22.22.3
NODE_SHA256=c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8
PLAYWRIGHT_VERSION=1.62.1
APPARMOR_PROFILE=/etc/apparmor.d/bwrap
HOSTNAME_CFG=/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg
NO_REBOOT_CFG=/etc/apt/apt.conf.d/52ci-vps-no-auto-reboot
NEEDRESTART_CFG=/etc/needrestart/conf.d/50ci-vps-gh-runner.conf

fail() { printf 'CI_VPS_PREPARE_FAILED %s\n' "$*" >&2; exit "${2:-1}"; }

[ "$(id -u)" -eq 0 ] || fail "must run as root" 64
current_hostname=$(hostname)
[ "$current_hostname" = "$CI_HOSTNAME" ] || [ "$current_hostname" = "$ORIGINAL_HOSTNAME" ] || fail "only runs on $CI_HOSTNAME" 68
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = "24.04" ] || fail "needs Ubuntu 24.04" 69

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q build-essential unzip xz-utils bubblewrap socat ripgrep apparmor-utils

printf 'preserve_hostname: true\n' > "$HOSTNAME_CFG"
hostnamectl set-hostname "$CI_HOSTNAME"
if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1 $CI_HOSTNAME/" /etc/hosts
else
  printf '127.0.1.1 %s\n' "$CI_HOSTNAME" >> /etc/hosts
fi

printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > "$NO_REBOOT_CFG"

printf '%s\n' '$nrconf{override_rc}{qr(^gh-runner)} = 0;' > "$NEEDRESTART_CFG"
perl -e 'our %nrconf; do "/etc/needrestart/needrestart.conf"; die $@ if $@;
  for my $unit (qw(gh-runner.service gh-runner-2.service gh-runner-3.service gh-runner-gate.service)) {
    my $restart = 1;
    for my $re (keys %{$nrconf{override_rc}}) { next unless $unit =~ /$re/; $restart = $nrconf{override_rc}{$re}; last }
    exit 1 if $restart;
  }' || fail "needrestart would still restart the runner services" 73

profile_text='abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}'
if [ -e "$APPARMOR_PROFILE" ]; then
  [ "$(cat "$APPARMOR_PROFILE")" = "$profile_text" ] || fail "$APPARMOR_PROFILE exists with other content" 70
else
  printf '%s\n' "$profile_text" > "$APPARMOR_PROFILE"
fi
apparmor_parser -r "$APPARMOR_PROFILE"
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = 1 ] || fail "userns restriction switch is not 1" 71

work=$(mktemp -d /tmp/ci-vps-prepare.XXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz"
printf '%s  %s\n' "$NODE_SHA256" "$work/node.tar.gz" | sha256sum -c --quiet - || fail "node checksum mismatch" 72
tar -xzf "$work/node.tar.gz" -C "$work"
node_bin="$work/node-v$NODE_VERSION-linux-x64/bin"
mkdir "$work/pw"
(cd "$work/pw" && PATH="$node_bin:$PATH" npm install --no-save --ignore-scripts --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION" >/dev/null)
PATH="$node_bin:$PATH" node "$work/pw/node_modules/playwright/cli.js" install-deps chromium firefox webkit

printf 'CI_VPS_PREPARED hostname=%s bwrap=%s userns_restrict=%s gcc=%s playwright_deps=%s\n' \
  "$(hostname)" "$(/usr/bin/bwrap --version | awk '{print $2}')" \
  "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" \
  "$(gcc -dumpversion)" "$PLAYWRIGHT_VERSION"
