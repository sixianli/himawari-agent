#!/usr/bin/env bash
set -euo pipefail
umask 022

NEEDRESTART_CFG=/etc/needrestart/conf.d/50ci-arm-gh-runner.conf
MIN_FREE_GIB=40
NODE_VERSION=22.22.3
NODE_SHA256=cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3
PLAYWRIGHT_VERSION=1.62.1

fail() { printf 'CI_ARM_PREPARE_FAILED %s\n' "$1" >&2; exit "${2:-1}"; }

[ "$(id -u)" -eq 0 ] || fail "must run as root" 64
[ "$(uname -s)-$(uname -m)" = Linux-aarch64 ] || fail "only runs on the Linux ARM machine, this is $(uname -s)-$(uname -m)" 68
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = "24.04" ] || fail "needs Ubuntu 24.04, this is $ID $VERSION_ID" 69

free_gib=$(($(df --output=avail -B1 / | tail -1 | tr -d ' ') / 1024 / 1024 / 1024))
memory_mib=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
printf 'CI_ARM_PROBE hostname=%s os=%s-%s kernel=%s cpus=%s memory_mib=%s root_free_gib=%s\n' \
  "$(hostname)" "$ID" "$VERSION_ID" "$(uname -r)" "$(nproc)" "$memory_mib" "$free_gib"
printf 'CI_ARM_PROBE home_modes=%s\n' "$(stat -c '%n:%a' /home/* 2> /dev/null | tr '\n' ' ')"
printf 'CI_ARM_PROBE other_directories=%s\n' "$(ls -d /srv/* /opt/* 2> /dev/null | tr '\n' ' ')"
printf 'CI_ARM_PROBE docker=%s nft=%s\n' "$(command -v docker || echo none)" "$(command -v nft || echo none)"
ss -ltnH 2> /dev/null | awk '{ print "CI_ARM_PROBE listening=" $4 }'

[ "$free_gib" -ge "$MIN_FREE_GIB" ] || fail "the root disk has $free_gib GiB free, below $MIN_FREE_GIB GiB" 70
[ "$memory_mib" -ge 20000 ] || fail "the machine has $memory_mib MiB of memory, the runner limits assume 24 GiB" 71
for home in /home/*; do
  [ -d "$home" ] || continue
  [ "$(($(stat -c '%a' "$home") % 10))" = 0 ] || fail "$home is readable by every account; run chmod o-rwx $home first" 72
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nftables build-essential python3 unzip xz-utils curl git libicu74 libkrb5-3 zlib1g libssl3t64

install -d -m 0755 "${NEEDRESTART_CFG%/*}"
printf '%s\n' '$nrconf{override_rc}{qr(^gh-runner)} = 0;' > "$NEEDRESTART_CFG"

work=$(mktemp -d /tmp/ci-arm-prepare.XXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.gz"
printf '%s  %s\n' "$NODE_SHA256" "$work/node.tar.gz" | sha256sum -c --quiet - || fail "node checksum mismatch" 74
tar -xzf "$work/node.tar.gz" -C "$work"
node_bin="$work/node-v$NODE_VERSION-linux-arm64/bin"
mkdir "$work/pw"
(cd "$work/pw" && PATH="$node_bin:$PATH" npm install --no-save --ignore-scripts --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION" > /dev/null)
PATH="$node_bin:$PATH" node "$work/pw/node_modules/playwright/cli.js" install-deps chromium

for tool in nft visudo useradd groupadd getent sha256sum curl ss python3 sshd git; do
  command -v "$tool" > /dev/null || fail "missing $tool after installing packages" 73
done
printf 'CI_ARM_PREPARED hostname=%s nft=%s gcc=%s python=%s playwright_deps=%s\n' \
  "$(hostname)" "$(nft --version | awk '{print $2}')" "$(gcc -dumpversion)" "$(python3 -I -c 'import platform; print(platform.python_version())')" "$PLAYWRIGHT_VERSION"
