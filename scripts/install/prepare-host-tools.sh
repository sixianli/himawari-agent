#!/bin/bash
set -euo pipefail
umask 022

usage() {
  echo "usage: prepare-host-tools.sh <git revision>" >&2
  echo "  Run as root on the target host after first-install.sh. Installs the sandbox system tools and the build account's materials." >&2
  exit 64
}
[[ $# -eq 1 ]] || usage
revision=$1
[[ $(id -u) -eq 0 ]] || { echo "PREPARE_HOST_NEEDS_ROOT" >&2; exit 1; }

build_user=himawari-build
build_home=/home/$build_user
source_dir=$build_home/src
bwrap_version=0.11.2
bwrap_sha256=69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6
bwrap_url=https://github.com/containers/bubblewrap/releases/download/v$bwrap_version/bubblewrap-$bwrap_version.tar.xz
bwrap_program_dir=/usr/local/libexec/bubblewrap-$bwrap_version

machine=$(uname -m)
case "$machine" in
  aarch64 | arm64) platform=linux-arm64 ;;
  x86_64 | amd64) platform=linux-x64 ;;
  *) echo "PREPARE_HOST_ARCH_UNSUPPORTED $machine" >&2; exit 1 ;;
esac
echo "PREPARE_HOST_TARGET host=$(hostname) arch=$machine platform=$platform"

step() { echo "PREPARE_HOST_STEP $1"; }

step packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends bubblewrap socat ripgrep apparmor-utils meson ninja-build pkg-config libcap-dev xz-utils curl ca-certificates >/dev/null

step source
id "$build_user" >/dev/null 2>&1 || { echo "PREPARE_HOST_BUILD_ACCOUNT_MISSING run first-install.sh first" >&2; exit 1; }
[[ -d "$source_dir/.git" ]] || { echo "PREPARE_HOST_SOURCE_MISSING $source_dir run first-install.sh first" >&2; exit 1; }
runuser -u "$build_user" -- git -C "$source_dir" fetch -q origin "$revision" || runuser -u "$build_user" -- git -C "$source_dir" fetch -q origin
runuser -u "$build_user" -- git -C "$source_dir" checkout -q --force --detach "$revision"
lock=$source_dir/ci/toolchain-lock.json

step apparmor
write_profile() {
  local profile=$1 executable=$2
  cat > "$profile" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile $(basename "$profile") $executable flags=(unconfined) {
  userns,
  include if exists <local/$(basename "$profile")>
}
PROFILE
}
bwrap_system=$(command -v bwrap)
[[ "$bwrap_system" == /usr/bin/bwrap ]] || { echo "PREPARE_HOST_BWRAP_PATH_UNEXPECTED $bwrap_system" >&2; exit 1; }
write_profile /etc/apparmor.d/bwrap /usr/bin/bwrap
write_profile /etc/apparmor.d/bwrap-$bwrap_version $bwrap_program_dir/bwrap
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]]; then
  apparmor_parser -r /etc/apparmor.d/bwrap
  apparmor_parser -r /etc/apparmor.d/bwrap-$bwrap_version
fi

step bubblewrap
if [[ ! -x "$bwrap_program_dir/bwrap" || "$("$bwrap_program_dir/bwrap" --version | awk '{print $2}')" != "$bwrap_version" ]]; then
  work=$(mktemp -d /tmp/bwrap-build-XXXXXX)
  curl -fsSL "$bwrap_url" -o "$work/bubblewrap.tar.xz"
  [[ "$(sha256sum "$work/bubblewrap.tar.xz" | cut -d ' ' -f 1)" == "$bwrap_sha256" ]] || { echo "PREPARE_HOST_BWRAP_DIGEST_MISMATCH" >&2; exit 1; }
  tar -xJf "$work/bubblewrap.tar.xz" -C "$work"
  (cd "$work/bubblewrap-$bwrap_version" && meson setup _build -Dman=disabled -Dselinux=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled >/dev/null && ninja -C _build >/dev/null)
  install -d -m 0755 -o root -g root "$bwrap_program_dir"
  install -m 0755 -o root -g root "$work/bubblewrap-$bwrap_version/_build/bwrap" "$bwrap_program_dir/bwrap"
  rm -rf "$work"
fi
echo "PREPARE_HOST_BWRAP system=$(/usr/bin/bwrap --version | awk '{print $2}') program=$("$bwrap_program_dir/bwrap" --version | awk '{print $2}')"

step builder-layout
builder_root=$build_home/packet-builder
for directory in work scripts source evidence tools browsers pi-tools-bin materials; do
  install -d -m 0755 -o "$build_user" -g "$build_user" "$builder_root/$directory"
done

step builder-python
read -r python_url python_sha < <(python3 -I - "$lock" "$platform" <<'PYTHON'
import json, sys
artifact = json.load(open(sys.argv[1]))['python']['artifacts'][sys.argv[2]]
print(artifact['url'], artifact['sha256'])
PYTHON
)
python_material=$builder_root/materials/python-3.12.10.tar.gz
if [[ ! -f "$python_material" || "$(sha256sum "$python_material" | cut -d ' ' -f 1)" != "$python_sha" ]]; then
  curl -fsSL "$python_url" -o "$python_material.part"
  [[ "$(sha256sum "$python_material.part" | cut -d ' ' -f 1)" == "$python_sha" ]] || { rm -f "$python_material.part"; echo "PREPARE_HOST_PYTHON_DIGEST_MISMATCH" >&2; exit 1; }
  mv "$python_material.part" "$python_material"
  chown "$build_user:$build_user" "$python_material"
fi
echo "PREPARE_HOST_PYTHON sha256=$python_sha"
echo "PREPARE_HOST_OK platform=$platform"
