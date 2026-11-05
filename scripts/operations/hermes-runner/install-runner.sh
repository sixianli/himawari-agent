#!/bin/bash
set -euo pipefail

VERSION=2.338.2
SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
URL=https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz
ROOT=/srv/gh-runner
SRC=$(cd "$(dirname "$0")" && pwd)

[ "$(hostname)" = hermes-home ] || { echo "this script only runs on hermes-home, not $(hostname)" >&2; exit 68; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 65; }
for tool in nft visudo useradd sha256sum curl ss python3; do
  command -v "$tool" > /dev/null || { echo "missing $tool" >&2; exit 66; }
done

if id gh-runner > /dev/null 2>&1; then
  [ -d $ROOT/runner ] || { echo "a gh-runner user exists but $ROOT/runner does not; refusing to take over an account this script did not create" >&2; exit 69; }
else
  useradd --system --user-group --home-dir $ROOT/home --no-create-home --shell /usr/sbin/nologin gh-runner
fi
if [ -n "$(id -nG gh-runner | tr ' ' '\n' | grep -vx gh-runner)" ]; then
  echo "gh-runner belongs to extra groups: $(id -nG gh-runner)" >&2
  exit 67
fi

install -d -m 0755 -o root -g root $ROOT $ROOT/hooks $ROOT/bin /etc/gh-runner
install -d -m 0750 -o gh-runner -g gh-runner $ROOT/runner $ROOT/home $ROOT/logs

if [ ! -x $ROOT/runner/config.sh ]; then
  DOWNLOAD=$(mktemp -d)
  curl -fsSL --max-time 240 -o "$DOWNLOAD/runner.tar.gz" "$URL"
  echo "$SHA256  $DOWNLOAD/runner.tar.gz" | sha256sum -c -
  chmod 0755 "$DOWNLOAD"
  chmod 0644 "$DOWNLOAD/runner.tar.gz"
  sudo -u gh-runner tar -xzf "$DOWNLOAD/runner.tar.gz" -C $ROOT/runner
  rm -rf "$DOWNLOAD"
fi

install -m 0755 -o root -g root "$SRC/job-started.sh" "$SRC/job-completed.sh" "$SRC/clean-old.sh" $ROOT/hooks/
install -m 0755 -o root -g root "$SRC/runner-pause.sh" "$SRC/runner-resume.sh" $ROOT/bin/
install -m 0644 -o root -g root "$SRC/gh-runner.service" "$SRC/gh-runner-nft.service" "$SRC/gh-runner-clean.service" "$SRC/gh-runner-clean.timer" /etc/systemd/system/

RUNNER_UID=$(id -u gh-runner)
PORTS=$(ss -ltnH | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vx 53 | paste -sd, -)
RULES=$(mktemp)
cat > "$RULES" <<EOF
table inet gh_runner
delete table inet gh_runner
table inet gh_runner {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid $RUNNER_UID ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject
    meta skuid $RUNNER_UID ip6 daddr { fc00::/7, fe80::/10 } reject
    meta skuid $RUNNER_UID ip daddr 127.0.0.0/8 tcp dport { $PORTS } reject
    meta skuid $RUNNER_UID ip6 daddr ::1 tcp dport { $PORTS } reject
  }
}
EOF
nft -c -f "$RULES"
install -m 0644 -o root -g root "$RULES" /etc/gh-runner/nft.rules
rm -f "$RULES"

SUDOERS=$(mktemp)
printf 'andy ALL=(root) NOPASSWD: /usr/bin/systemctl start gh-runner.service, /usr/bin/systemctl stop gh-runner.service, /usr/bin/systemctl restart gh-runner.service\n' > "$SUDOERS"
visudo -cf "$SUDOERS" > /dev/null
install -m 0440 -o root -g root "$SUDOERS" /etc/sudoers.d/91-gh-runner-control
rm -f "$SUDOERS"

systemctl daemon-reload
systemctl enable --now gh-runner-nft.service gh-runner-clean.timer
nft -f /etc/gh-runner/nft.rules
nft list table inet gh_runner > /dev/null

echo "INSTALL_OK version=$VERSION uid=$RUNNER_UID blocked_local_ports=$PORTS"
