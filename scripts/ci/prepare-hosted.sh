#!/usr/bin/env bash
set -euo pipefail

node_bin=${1:?usage: prepare-hosted.sh <node>}
[ -x "$node_bin" ] || { echo "CI_HOSTED_PREPARE_NODE_MISSING $node_bin" >&2; exit 64; }
[ "$(id -u)" = 0 ] || { echo "CI_HOSTED_PREPARE_NEEDS_ROOT" >&2; exit 65; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends bubblewrap socat ripgrep apparmor-utils

profile=/etc/apparmor.d/bwrap
cat > "$profile" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
PROFILE
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  apparmor_parser -r "$profile"
fi

"$node_bin" node_modules/playwright/cli.js install-deps chromium firefox webkit

printf 'CI_HOSTED_PREPARED bwrap=%s userns_restrict=%s\n' \
  "$(/usr/bin/bwrap --version | awk '{print $2}')" \
  "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo none)"
