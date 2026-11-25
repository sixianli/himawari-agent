#!/bin/bash
set -euo pipefail
umask 022

usage() {
  echo "usage: first-install.sh <git revision> <seed directory> [--public-origin <url>]" >&2
  echo "  seed directory: a tree holding etc/himawari/config.json and var/lib/himawari/state/secrets from the previous host" >&2
  exit 64
}
[[ $# -ge 2 ]] || usage
revision=$1
seed=$2
shift 2
public_origin=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-origin) public_origin=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { echo "FIRST_INSTALL_NEEDS_ROOT" >&2; exit 1; }
[[ -f "$seed/etc/himawari/config.json" ]] || { echo "FIRST_INSTALL_SEED_CONFIG_MISSING" >&2; exit 1; }

repo_url=${HIMAWARI_REPO_URL:-https://github.com/sixianli/himawari-agent}
service_user=himawari-prod
build_user=himawari-build
install_root=/opt/himawari
state_parent=/var/lib/himawari
config_dir=/etc/himawari
build_home=/home/$build_user

machine=$(uname -m)
case "$machine" in
  aarch64 | arm64) platform=linux-arm64 ;;
  x86_64 | amd64) platform=linux-x64 ;;
  *) echo "FIRST_INSTALL_ARCH_UNSUPPORTED $machine" >&2; exit 1 ;;
esac
echo "FIRST_INSTALL_TARGET host=$(hostname) arch=$machine platform=$platform"

step() { echo "FIRST_INSTALL_STEP $1"; }

step packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git build-essential python3 curl ca-certificates bubblewrap >/dev/null

step accounts
id "$build_user" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$build_home" --shell /bin/bash "$build_user"
id "$service_user" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$state_parent" --shell /usr/sbin/nologin "$service_user"
service_uid=$(id -u "$service_user")
service_gid=$(id -g "$service_user")
echo "FIRST_INSTALL_ACCOUNTS service=$service_user uid=$service_uid gid=$service_gid build=$build_user"

step source
source_dir=$build_home/src
if [[ ! -d "$source_dir/.git" ]]; then
  runuser -u "$build_user" -- git clone -q "$repo_url" "$source_dir"
fi
runuser -u "$build_user" -- git -C "$source_dir" fetch -q origin "$revision" || runuser -u "$build_user" -- git -C "$source_dir" fetch -q origin
runuser -u "$build_user" -- git -C "$source_dir" checkout -q --force --detach "$revision"
full_revision=$(runuser -u "$build_user" -- git -C "$source_dir" rev-parse HEAD)
short_revision=${full_revision:0:8}
echo "FIRST_INSTALL_REVISION $full_revision"

step node
mkdir -p "$install_root"
node_prefix=$install_root/node
lock=$source_dir/ci/toolchain-lock.json
read -r node_version node_url node_sha < <(python3 -I - "$lock" "$platform" <<'PYTHON'
import json, sys
lock = json.load(open(sys.argv[1]))
version = lock['node']['baseline']
artifact = lock['node']['releases'][version]['artifacts'][sys.argv[2]]
print(version, artifact['url'], artifact['sha256'])
PYTHON
)
if [[ ! -x "$node_prefix/bin/node" || "$("$node_prefix/bin/node" --version)" != "v$node_version" ]]; then
  tarball=$(mktemp /tmp/node-XXXXXX.tar.gz)
  curl -fsSL "$node_url" -o "$tarball"
  [[ "$(sha256sum "$tarball" | cut -d ' ' -f 1)" == "$node_sha" ]] || { echo "FIRST_INSTALL_NODE_DIGEST_MISMATCH" >&2; exit 1; }
  rm -rf "$node_prefix"
  mkdir -p "$node_prefix"
  tar -xzf "$tarball" -C "$node_prefix" --strip-components 1
  rm -f "$tarball"
fi
node_sha_installed=$(sha256sum "$node_prefix/bin/node" | cut -d ' ' -f 1)
echo "FIRST_INSTALL_NODE $("$node_prefix/bin/node" --version) sha256=$node_sha_installed"

step build
build_env=(env -i HOME="$build_home" PATH="$node_prefix/bin:/usr/bin:/bin" LANG=C.UTF-8)
runuser -u "$build_user" -- "${build_env[@]}" bash -c "cd '$source_dir' && npm ci --ignore-scripts && npm rebuild better-sqlite3 && npm run build:node && npm run build:browser"

step install
date_stamp=$(date -u +%Y-%m-%d)
prefix=$install_root/releases/$date_stamp-$short_revision
if [[ ! -d "$prefix/lib" ]]; then
  mkdir -p "$install_root/releases"
  (cd "$source_dir" && env PATH="$node_prefix/bin:/usr/bin:/bin" node scripts/install-node-runtime.mjs --prefix "$prefix")
fi
[[ -d "$prefix/share/control-center" ]] || { echo "FIRST_INSTALL_CONTROL_CENTER_MISSING $prefix" >&2; exit 1; }
operations=$install_root/operations/first-install
mkdir -p "$operations"
install -m 0644 "$source_dir/scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs" "$operations/pair-supervisor.mjs"

step config
mkdir -p "$state_parent" "$config_dir"
chown "$service_user:$service_user" "$state_parent"
chmod 0755 "$state_parent"
config=$config_dir/config.json
python3 -I - "$seed/etc/himawari/config.json" "$config" "$prefix" "$public_origin" <<'PYTHON'
import json, sys
source, target, prefix, origin = sys.argv[1:5]
config = json.load(open(source))
policy = config.get('runPolicy', {})
policy.pop('ownerProposals', None)
policy.pop('deliveryTiming', None)
if 'thinkInbox' in policy:
    inbox = policy.pop('thinkInbox')
    if isinstance(inbox, dict):
        inbox.pop('worth', None)
    policy.setdefault('inbox', inbox)
if isinstance(policy.get('inbox'), dict):
    policy['inbox'].pop('worth', None)
config.pop('capabilityDeployment', None)
config['http']['staticRoot'] = prefix + '/share/control-center'
if origin:
    config['publicOrigin'] = origin
with open(target, 'w') as handle:
    json.dump(config, handle, indent=2)
    handle.write('\n')
PYTHON
chown "$service_user:$service_user" "$config"
chmod 0600 "$config"
state_root=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["stateRoot"])' "$config")

step initialize
cli=$prefix/bin/himawari
if [[ ! -e "$state_root" ]]; then
  runuser -u "$service_user" -- env -i HOME="$state_root" PATH="$node_prefix/bin:/usr/bin:/bin" LANG=C.UTF-8 "$cli" init --config "$config"
else
  echo "FIRST_INSTALL_STATE_ROOT_EXISTS $state_root"
fi

step secrets
secrets_target=$state_root/secrets
secrets_source=$seed/$state_root/secrets
[[ -d "$secrets_source" ]] || { echo "FIRST_INSTALL_SEED_SECRETS_MISSING" >&2; exit 1; }
install -d -m 0700 -o "$service_user" -g "$service_user" "$secrets_target"
for entry in "$secrets_source"/*; do
  name=$(basename "$entry")
  [[ "$name" == worker-token.json ]] && continue
  install -m 0600 -o "$service_user" -g "$service_user" "$entry" "$secrets_target/$name"
done
token=$(python3 -I -c 'import secrets; print(secrets.token_hex(32))')
printf '{"tokenRef":"worker-token:first-install","tokenValue":"%s"}\n' "$token" > "$secrets_target/worker-token.json"
chown "$service_user:$service_user" "$secrets_target/worker-token.json"
chmod 0600 "$secrets_target/worker-token.json"
echo "FIRST_INSTALL_SECRET_NAMES $(ls "$secrets_target" | tr '\n' ' ')"

step identity
old_database=$seed/$state_root/data/product.sqlite
if [[ -f "$old_database" ]]; then
  python3 -I - "$old_database" "$state_root/data/product.sqlite" "$service_uid" "$service_gid" <<'PYTHON'
import os, sqlite3, sys
old_path, new_path, uid, gid = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
old = sqlite3.connect('file:' + old_path + '?mode=ro', uri=True)
rows = old.execute("SELECT owner_id, external_subject_ref, bound_at, status FROM owner_identity_bindings WHERE status = 'active'").fetchall()
old.close()
if len(rows) != 1:
    print('FIRST_INSTALL_IDENTITY_BINDING_NOT_UNIQUE count=%d' % len(rows))
    sys.exit(0)
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
new = sqlite3.connect(new_path)
existing = new.execute('SELECT COUNT(*) FROM owner_identity_bindings').fetchone()[0]
if existing == 0:
    owner = new.execute('SELECT id FROM owners').fetchall()
    if len(owner) == 1 and owner[0][0] == rows[0][0]:
        new.execute('INSERT INTO owner_identity_bindings (owner_id, external_subject_ref, bound_at, status) VALUES (?, ?, ?, ?)', rows[0])
        new.commit()
        print('FIRST_INSTALL_IDENTITY_BOUND owner=%s' % rows[0][0])
    else:
        print('FIRST_INSTALL_IDENTITY_OWNER_MISMATCH')
else:
    print('FIRST_INSTALL_IDENTITY_ALREADY_BOUND')
new.close()
PYTHON
else
  echo "FIRST_INSTALL_IDENTITY_NOT_BOUND no seed database; bind the owner login after install"
fi

step service
unit=/etc/systemd/system/himawari-prod.service
cat > "$unit" <<UNIT
[Unit]
Description=Himawari production Agent and Worker pair
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60s
StartLimitBurst=10

[Service]
Type=exec
User=$service_user
Group=$service_user
UMask=0022
WorkingDirectory=$state_root
Environment=PATH=$node_prefix/bin:/usr/bin:/bin
Environment=HOME=$state_root
Environment=LANG=C.UTF-8
UnsetEnvironment=TMPDIR
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ExecStart=$node_prefix/bin/node --no-global-search-paths $operations/pair-supervisor.mjs --prefix $prefix --config $config --worker-token-file $secrets_target/worker-token.json
Restart=on-failure
RestartSec=10s
KillMode=mixed
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=35s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=himawari-prod

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable himawari-prod.service >/dev/null 2>&1
systemctl restart himawari-prod.service

step health
origin=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["publicOrigin"])' "$config")
host=${origin#*://}
host=${host%%/*}
port=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["http"]["listenPort"])' "$config")
for attempt in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" "http://127.0.0.1:$port/" || true)
  if [[ "$code" == 200 ]]; then
    echo "FIRST_INSTALL_OK revision=$full_revision prefix=$prefix"
    exit 0
  fi
  sleep 2
done
echo "FIRST_INSTALL_HEALTH_FAILED last_http=$code" >&2
journalctl -u himawari-prod.service --no-pager -n 40 >&2 || true
exit 1
