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
read -r python_url python_sha python_version < <(python3 -I - "$lock" "$platform" <<'PYTHON'
import json, sys
lock = json.load(open(sys.argv[1]))['python']
artifact = lock['artifacts'][sys.argv[2]]
print(artifact['url'], artifact['sha256'], lock['version'])
PYTHON
)
python_material=$builder_root/materials/python-$python_version.tar.gz
if [[ ! -f "$python_material" || "$(sha256sum "$python_material" | cut -d ' ' -f 1)" != "$python_sha" ]]; then
  curl -fsSL "$python_url" -o "$python_material.part"
  [[ "$(sha256sum "$python_material.part" | cut -d ' ' -f 1)" == "$python_sha" ]] || { rm -f "$python_material.part"; echo "PREPARE_HOST_PYTHON_DIGEST_MISMATCH" >&2; exit 1; }
  mv "$python_material.part" "$python_material"
  chown "$build_user:$build_user" "$python_material"
fi
echo "PREPARE_HOST_PYTHON sha256=$python_sha"

step builder-tools
tools_dir=$builder_root/tools
if [[ ! -x "$tools_dir/bin/node" ]]; then
  read -r node_url node_sha node_version < <(python3 -I - "$lock" "$platform" <<'PYTHON'
import json, sys
node = json.load(open(sys.argv[1]))['node']
version = node['baseline']
artifact = node['releases'][version]['artifacts'][sys.argv[2]]
print(artifact['url'], artifact['sha256'], version)
PYTHON
)
  bootstrap=$(mktemp -d)
  curl -fsSL "$node_url" -o "$bootstrap/node.tar.gz"
  [[ "$(sha256sum "$bootstrap/node.tar.gz" | cut -d ' ' -f 1)" == "$node_sha" ]] || { rm -rf "$bootstrap"; echo "PREPARE_HOST_NODE_DIGEST_MISMATCH" >&2; exit 1; }
  tar -xzf "$bootstrap/node.tar.gz" -C "$bootstrap" --no-same-owner
  chmod -R a+rX "$bootstrap"
  bootstrap_node=$(echo "$bootstrap"/node-v*/bin/node)
  rm -rf "$tools_dir"
  runuser -u "$build_user" -- env -i HOME="$build_home" PATH=/usr/bin:/bin bash -c 'cd "$1" && "$2" scripts/ci/install-tools.mjs --directory "$3"' _ "$source_dir" "$bootstrap_node" "$tools_dir" >/dev/null
  rm -rf "$bootstrap"
fi
tools_node_version=$("$tools_dir/bin/node" --version)
echo "PREPARE_HOST_TOOLS node=$tools_node_version"

step builder-fd
toolbin=$builder_root/pi-tools-bin
python3 -I - "$source_dir/scripts/delivery-mode/fd-pins.json" "$platform" "$toolbin" <<'PYTHON'
import hashlib, io, json, os, shutil, sys, tarfile, urllib.request
pins = json.load(open(sys.argv[1]))
arch = sys.argv[2].split('-', 1)[1]
pin = pins['platforms'][arch]
target = os.path.join(sys.argv[3], 'fd')
def sha(data): return hashlib.sha256(data).hexdigest()
if os.path.isfile(target) and sha(open(target, 'rb').read()) == pin['binarySha256']:
    print('PREPARE_HOST_FD already=' + pin['binarySha256'])
    raise SystemExit(0)
name = 'fd-v%s-%s' % (pins['version'], pin['triple'])
archive = urllib.request.urlopen(pins['source'] + name + '.tar.gz', timeout=120).read()
if sha(archive) != pin['archiveSha256']:
    sys.exit('PREPARE_HOST_FD_ARCHIVE_DIGEST_MISMATCH')
with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
    binary = bundle.extractfile(name + '/fd').read()
if sha(binary) != pin['binarySha256']:
    sys.exit('PREPARE_HOST_FD_BINARY_DIGEST_MISMATCH')
with open(target + '.part', 'wb') as out:
    out.write(binary)
os.chmod(target + '.part', 0o755)
os.replace(target + '.part', target)
print('PREPARE_HOST_FD sha256=' + pin['binarySha256'])
PYTHON
chown "$build_user:$build_user" "$toolbin/fd"

step builder-browsers
runuser -u "$build_user" -- env -i HOME="$build_home" PATH="$tools_dir/bin:/usr/bin:/bin" bash -c 'cd "$1" && bash scripts/delivery-mode/hermes/install-dependencies-if-changed.sh "$1" "$2" "$3/prepare-dependencies-$4"' _ "$source_dir" "$tools_dir" "$builder_root/evidence" "$(date +%s)"
"$tools_dir/bin/node" "$source_dir/node_modules/playwright/cli.js" install-deps chromium >/dev/null
runuser -u "$build_user" -- env -i HOME="$build_home" PATH="$tools_dir/bin:/usr/bin:/bin" PLAYWRIGHT_BROWSERS_PATH="$builder_root/browsers" "$tools_dir/bin/node" "$source_dir/node_modules/playwright/cli.js" install chromium >/dev/null
echo "PREPARE_HOST_BROWSERS chromium=$(ls "$builder_root/browsers" | grep -c '^chromium')"

step signing-key
qualification_root=/var/lib/himawari/qualification
signing_dir=$qualification_root/signing
signing_key=$signing_dir/host-qualification-signing-key.pem
first_dir=$qualification_root/first-install
first_public=$first_dir/host-qualification-public-key.pem
install -d -m 0755 -o root -g root "$qualification_root"
install -d -m 0700 -o root -g root "$signing_dir"
install -d -m 0755 -o root -g root "$first_dir"
if [[ ! -f "$signing_key" ]]; then
  (umask 077 && openssl genpkey -algorithm ed25519 -out "$signing_key")
  chown root:root "$signing_key"
  chmod 0600 "$signing_key"
fi
openssl pkey -in "$signing_key" -pubout -out "$first_public.part"
if [[ -f "$first_public" ]] && ! cmp -s "$first_public.part" "$first_public"; then
  rm -f "$first_public.part"
  echo "PREPARE_HOST_SIGNING_KEY_PUBLIC_MISMATCH $first_public" >&2
  exit 1
fi
mv -f "$first_public.part" "$first_public"
chown root:root "$first_public"
chmod 0644 "$first_public"
echo "PREPARE_HOST_SIGNING_KEY public=$first_public sha256=$(openssl pkey -in "$signing_key" -pubout -outform DER | sha256sum | cut -d ' ' -f 1)"
echo "PREPARE_HOST_OK platform=$platform"
