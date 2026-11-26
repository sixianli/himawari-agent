#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
usage: bash install-computers.sh ensure --release <release prefix>
       bash install-computers.sh render --release <release prefix> --image-digest <sha256:...> --group-id <gid> --config <file> --unit <file>
       bash install-computers.sh status
TEXT
  exit 64
}
[[ "$#" -ge 1 ]] || usage
mode="$1"
shift
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
settings="$here/settings.json"
release=""
digest=""
group_id=""
config_out=""
unit_out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --release) release="${2:-}"; shift 2 ;;
    --image-digest) digest="${2:-}"; shift 2 ;;
    --group-id) group_id="${2:-}"; shift 2 ;;
    --config) config_out="${2:-}"; shift 2 ;;
    --unit) unit_out="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

refuse() { echo "COMPUTERS_INSTALL_REFUSED $1: ${2:-}" >&2; exit "${3:-2}"; }
setting() { /usr/bin/python3 -I -c 'import json,sys
value=json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."): value=value[key]
print(value)' "$settings" "$1"; }

render() {
  /usr/bin/python3 -I "$here/render.py" "$settings" "$release" "$digest" "$group_id" "$config_out" "$unit_out"
}

if [[ "$mode" == render ]]; then
  [[ -n "$release" && -n "$digest" && -n "$group_id" && -n "$config_out" && -n "$unit_out" ]] || usage
  render
  exit 0
fi

config_path="$(setting paths.config)"
unit_path="$(setting paths.unit)"
socket_path="$(setting paths.socket)"
docker_bin="$(setting paths.docker)"
node_bin="$(setting paths.node)"
service_group="$(setting serviceGroup)"
repository="$(setting image.repository)"

if [[ "$mode" == status ]]; then
  systemctl is-active himawari-computers.service || true
  [[ -S "$socket_path" ]] && echo "COMPUTERS_SOCKET_PRESENT $socket_path" || echo "COMPUTERS_SOCKET_MISSING $socket_path"
  "$docker_bin" ps --filter "label=io.himawari.computer" --format '{{.Names}} {{.Status}}' 2>/dev/null || true
  exit 0
fi

[[ "$mode" == ensure ]] || usage
[[ "$(id -u)" == 0 ]] || refuse NEEDS_ROOT "run as root" 77
[[ -n "$release" ]] || usage
[[ -d "$release/lib/himawari-agent" ]] || refuse RELEASE_MISSING "$release/lib/himawari-agent" 3
[[ -x "$node_bin" ]] || refuse NODE_MISSING "$node_bin" 3
group_id="$(getent group "$service_group" | cut -d: -f3)"
[[ -n "$group_id" ]] || refuse GROUP_MISSING "$service_group" 3

step() { echo "COMPUTERS_STEP $1"; }

step docker
if [[ ! -x "$docker_bin" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io >/dev/null
fi
systemctl enable --now docker.service >/dev/null

step gvisor
arch="$(uname -m)"
gvisor_release="$(setting gvisor.release)"
gvisor_sha="$(setting "gvisor.sha512.$arch")" || refuse GVISOR_ARCH_UNSUPPORTED "$arch" 3
installed="$(/usr/local/bin/runsc --version 2>/dev/null | sed -n 's/^runsc version release-//p' | head -1 || true)"
if [[ "$installed" != "$gvisor_release" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  url="$(setting gvisor.url)"
  url="${url//\{release\}/$gvisor_release}"
  url="${url//\{arch\}/$arch}"
  curl -fsSL --retry 3 -o "$work/gvisor.tar.bz2" "$url"
  echo "$gvisor_sha  $work/gvisor.tar.bz2" | sha512sum -c - >/dev/null || refuse GVISOR_CHECKSUM "$url" 3
  mkdir -p /opt/gvisor
  tar -xjf "$work/gvisor.tar.bz2" -C /opt/gvisor
  install -m 0755 /opt/gvisor/runsc /usr/local/bin/runsc
  [[ -f /opt/gvisor/containerd-shim-runsc-v1 ]] && install -m 0755 /opt/gvisor/containerd-shim-runsc-v1 /usr/local/bin/containerd-shim-runsc-v1
fi
if ! "$docker_bin" info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  /usr/local/bin/runsc install
  systemctl reload docker.service || systemctl restart docker.service
fi
"$docker_bin" info --format '{{json .Runtimes}}' | grep -q '"runsc"' || refuse GVISOR_NOT_REGISTERED "docker does not list runsc" 3

step image
tag="$repository:$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
"$docker_bin" build -q -t "$tag" "$repo/packages/runtime-sandbox/computer-image" >/dev/null
digest="$("$docker_bin" image inspect --format '{{.Id}}' "$tag")"
"$docker_bin" run --rm --runtime=runsc --network none "$digest" sh -c 'node --version && test -x /usr/local/bin/himawari-browser' >/dev/null || refuse IMAGE_CHECK_FAILED "$tag" 3

step config
staging="$(mktemp -d)"
config_out="$staging/config.json"
unit_out="$staging/himawari-computers.service"
host_main="$(render)"
[[ -f "$host_main" ]] || refuse HOST_MAIN_MISSING "$host_main" 3
mkdir -p "$(dirname "$config_path")" "$(setting paths.stateDirectory)"
chmod 0700 "$(setting paths.stateDirectory)"
changed=0
if ! cmp -s "$config_out" "$config_path"; then
  [[ -f "$config_path" ]] && cp -p "$config_path" "$config_path.previous"
  install -m 0600 -o root -g root "$config_out" "$config_path"
  changed=1
fi
if ! cmp -s "$unit_out" "$unit_path"; then
  install -m 0644 -o root -g root "$unit_out" "$unit_path"
  systemctl daemon-reload
  changed=1
fi
rm -rf "$staging"

step service
systemctl enable himawari-computers.service >/dev/null 2>&1
if [[ "$changed" == 1 ]] || ! systemctl is-active --quiet himawari-computers.service; then
  systemctl restart himawari-computers.service
fi
for _ in $(seq 1 30); do
  [[ -S "$socket_path" ]] && systemctl is-active --quiet himawari-computers.service && break
  sleep 1
done
systemctl is-active --quiet himawari-computers.service || { journalctl -u himawari-computers.service --no-pager -n 30 >&2 || true; refuse SERVICE_NOT_ACTIVE "himawari-computers.service" 4; }
[[ -S "$socket_path" ]] || refuse SOCKET_MISSING "$socket_path" 4
[[ "$(stat -c %g "$socket_path")" == "$group_id" ]] || refuse SOCKET_GROUP "$socket_path" 4

step prune
"$docker_bin" image ls --format '{{.Repository}}:{{.Tag}}' "$repository" | grep -v -x -F "$tag" | xargs -r "$docker_bin" image rm >/dev/null 2>&1 || true

echo "COMPUTERS_READY image=$digest release=$release"
