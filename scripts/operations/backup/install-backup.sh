#!/bin/bash
set -euo pipefail
usage() {
  cat >&2 <<'TEXT'
usage: bash install-backup.sh install --namespace <object storage namespace> --bucket <bucket> [--instance andy-production] [--healthcheck-url-file <file>] [--extra-path <path>]...
       bash install-backup.sh refresh
       bash install-backup.sh status
TEXT
  exit 64
}
[[ "$#" -ge 1 ]] || usage
mode="$1"
shift
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
prefix="${BACKUP_ROOT:-}"
systemctl_command="${BACKUP_SYSTEMCTL:-systemctl}"
metadata_url="${BACKUP_METADATA_URL:-http://169.254.169.254/opc/v2/instance/}"
script_path="$prefix/usr/local/sbin/himawari-backup"
settings_directory="$prefix/etc/himawari-backup"
settings_path="$settings_directory/settings.json"
password_path="$settings_directory/restic-password"
rclone_config="$settings_directory/rclone.conf"
work_root="$prefix/var/lib/himawari-backup"
unit_directory="$prefix/etc/systemd/system"
rclone_path="$prefix/usr/local/bin/rclone"
pins="$here/pins.json"

refuse() { echo "BACKUP_INSTALL_REFUSED $1: ${2:-}" >&2; exit "${3:-2}"; }
if [[ -z "$prefix" && "$(id -u)" != 0 ]]; then refuse NEEDS_ROOT "run as root" 77; fi
pin() { /usr/bin/python3 -I -c 'import json,sys
value=json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."): value=value[key]
print(value)' "$pins" "$1"; }

install_script() {
  mkdir -p "$(dirname "$script_path")"
  install -m 0755 "$here/himawari-backup.py" "$script_path"
}

case "$mode" in
  status)
    "$systemctl_command" list-timers 'himawari-backup*' --no-pager || true
    [[ -f "$settings_path" ]] && /usr/bin/python3 -I "$script_path" status || echo "BACKUP_NOT_INSTALLED"
    exit 0
    ;;
  refresh)
    [[ -f "$settings_path" ]] || refuse NOT_INSTALLED "run install first"
    install_script
    echo "BACKUP_REFRESHED"
    exit 0
    ;;
  install) ;;
  *) usage ;;
esac

namespace=""
bucket=""
instance=andy-production
healthcheck_file=""
extra_paths=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    --bucket) bucket="${2:-}"; shift 2 ;;
    --instance) instance="${2:-}"; shift 2 ;;
    --healthcheck-url-file) healthcheck_file="${2:-}"; shift 2 ;;
    --extra-path) extra_paths+=("${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done
[[ "$namespace" =~ ^[a-z0-9]{1,64}$ ]] || refuse NAMESPACE_INVALID "$namespace"
[[ "$bucket" =~ ^[A-Za-z0-9_.-]{1,256}$ ]] || refuse BUCKET_INVALID "$bucket"
instance_file="$repo/scripts/delivery-mode/instances/$instance.json"
[[ -f "$instance_file" ]] || refuse INSTANCE_UNKNOWN "$instance_file"

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) refuse ARCH_UNSUPPORTED "$(uname -m)" ;;
esac

metadata="$(curl -fsS --max-time 10 -H 'Authorization: Bearer Oracle' "$metadata_url")" || refuse METADATA_UNREADABLE "$metadata_url"
region="$(printf '%s' "$metadata" | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["canonicalRegionName"])')"
compartment="$(printf '%s' "$metadata" | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["compartmentId"])')"
[[ "$region" =~ ^[a-z0-9-]+$ ]] || refuse REGION_INVALID "$region"
[[ "$compartment" =~ ^ocid1\.[a-z]+\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9]+$ ]] || refuse COMPARTMENT_INVALID "$compartment"

if [[ -z "$prefix" ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$(pin restic.aptPackage)" unzip >/dev/null
fi
restic_version="$(/usr/bin/restic version 2>/dev/null | awk '{print $2}')" || true
/usr/bin/python3 -I -c 'import sys
have=[int(x) for x in sys.argv[1].split(".")[:3]]; need=[int(x) for x in sys.argv[2].split(".")[:3]]
sys.exit(0 if have>=need else 1)' "${restic_version:-0.0.0}" "$(pin restic.minimumVersion)" || refuse RESTIC_TOO_OLD "${restic_version:-missing}"

rclone_version="$(pin rclone.version)"
rclone_sha="$(pin "rclone.sha256.$arch")"
if [[ ! -x "$rclone_path" ]] || ! "$rclone_path" version 2>/dev/null | head -1 | grep -qx "rclone $rclone_version"; then
  download="$(mktemp -d)"
  trap 'rm -rf "$download"' EXIT
  url="$(pin rclone.url | sed "s/{version}/$rclone_version/g; s/{arch}/$arch/g")"
  curl -fsSL --max-time 300 -o "$download/rclone.zip" "$url" || refuse RCLONE_DOWNLOAD_FAILED "$url"
  echo "$rclone_sha  $download/rclone.zip" | sha256sum -c --quiet - || refuse RCLONE_DIGEST_MISMATCH "$url"
  unzip -q -j "$download/rclone.zip" "rclone-$rclone_version-linux-$arch/rclone" -d "$download"
  mkdir -p "$(dirname "$rclone_path")"
  install -m 0755 "$download/rclone" "$rclone_path"
fi

umask 077
mkdir -p "$settings_directory" "$work_root"
chmod 0700 "$settings_directory" "$work_root"
if [[ ! -s "$password_path" ]]; then
  head -c 48 /dev/urandom | base64 -w0 > "$password_path"
  echo "BACKUP_PASSWORD_CREATED $password_path"
fi
chmod 0600 "$password_path"
cat > "$rclone_config" <<CONF
[himawari-oci]
type = oracleobjectstorage
provider = instance_principal_auth
namespace = $namespace
compartment = $compartment
region = $region
CONF
chmod 0600 "$rclone_config"

healthcheck_url=""
if [[ -n "$healthcheck_file" ]]; then
  healthcheck_url="$(head -c 600 "$healthcheck_file" | tr -d '\n')"
  [[ "$healthcheck_url" =~ ^https://hc-ping\.com/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})?$ ]] || refuse HEALTHCHECK_URL_INVALID "the file must hold one https://hc-ping.com/... URL"
fi

/usr/bin/python3 -I - "$instance_file" "$settings_path" "rclone:himawari-oci:$bucket/restic" "$password_path" "$rclone_config" "${work_root#$prefix}" "$healthcheck_url" "$pins" "$rclone_path" "${extra_paths[@]}" <<'PY'
import json, sys
instance_file, settings_path, repository, password, rclone_config, work_root, healthcheck, pins, rclone_path, *extras = sys.argv[1:]
fixed = json.load(open(instance_file))["fixedByTemplate"]
retention = json.load(open(pins))["retention"]
settings = {
    "repository": repository,
    "serviceAccount": fixed["serviceAccount"],
    "config": fixed["config"],
    "stateRoot": fixed["stateRoot"],
    "unitPath": fixed["unitPath"],
    "releasesRoot": fixed["releasesRoot"],
    "workRoot": work_root,
    "passwordFile": password,
    "rcloneConfig": rclone_config,
    "retention": {key: retention[key] for key in ("daily", "weekly", "preDeploy", "drill")},
    "keepLocal": retention["keepLocal"],
    "extraPaths": extras,
}
if healthcheck:
    settings["healthcheckUrl"] = healthcheck
with open(settings_path, "w") as handle:
    json.dump(settings, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
chmod 0600 "$settings_path"
/usr/bin/python3 -I - "$settings_path" "$prefix" <<'PY'
import json, os, pwd, secrets, sys
settings_path, prefix = sys.argv[1:]
settings = json.load(open(settings_path))
config_path = prefix + settings["config"]
secret_dir = prefix + (settings.get("secretDirectory") or os.path.join(settings["stateRoot"], "secrets"))
config = json.load(open(config_path))
references = config.get("secretReferences", [])
if any(entry.get("purpose") == "backup-encryption" for entry in references):
    sys.exit(0)
payload = [entry for entry in references if entry.get("purpose") == "payload-encryption"]
if len(payload) != 1:
    print("BACKUP_INSTALL_REFUSED PAYLOAD_KEY_UNKNOWN: the config must declare exactly one payload-encryption secret", file=sys.stderr)
    sys.exit(2)
names = {entry.get("ref") for entry in references}
ref = "backup-key"
if ref in names:
    print("BACKUP_INSTALL_REFUSED BACKUP_KEY_NAME_TAKEN: " + ref, file=sys.stderr)
    sys.exit(2)
key_path = os.path.join(secret_dir, ref + ".v1")
payload_stat = os.stat(os.path.join(secret_dir, payload[0]["ref"] + "." + payload[0]["version"]))
if not os.path.exists(key_path):
    descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(secrets.token_hex(32))
        handle.flush()
        os.fsync(handle.fileno())
    os.chown(key_path, payload_stat.st_uid, payload_stat.st_gid)
entry = {"ref": ref, "version": "v1", "purpose": "backup-encryption"}
if "scope" in payload[0]:
    entry["scope"] = payload[0]["scope"]
references.append(entry)
config["secretReferences"] = references
config_stat = os.stat(config_path)
staged = config_path + ".backup-key.new"
with open(staged, "w") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(staged, config_stat.st_mode & 0o7777)
os.chown(staged, config_stat.st_uid, config_stat.st_gid)
os.replace(staged, config_path)
print("BACKUP_KEY_CREATED " + ref + ".v1 in " + secret_dir.removeprefix(prefix) + " (owner " + pwd.getpwuid(payload_stat.st_uid).pw_name + ")")
PY
install_script

backup_schedule="$(pin schedule.backup)"
drill_schedule="$(pin schedule.drill)"
mkdir -p "$unit_directory"
umask 022
write_unit() {
  local name="$1" description="$2" command="$3" schedule="$4"
  cat > "$unit_directory/$name.service" <<UNIT
[Unit]
Description=$description
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-backup $command
TimeoutStartSec=3h
Nice=10
IOSchedulingClass=idle
SyslogIdentifier=$name
UNIT
  cat > "$unit_directory/$name.timer" <<UNIT
[Unit]
Description=$description schedule

[Timer]
OnCalendar=$schedule
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT
  chmod 0644 "$unit_directory/$name.service" "$unit_directory/$name.timer"
}
write_unit himawari-backup "Himawari daily encrypted off-site backup" "run --reason daily" "$backup_schedule"
write_unit himawari-backup-drill "Himawari weekly restore drill" "drill" "$drill_schedule"
"$systemctl_command" daemon-reload
"$systemctl_command" enable --now himawari-backup.timer himawari-backup-drill.timer
echo "BACKUP_INSTALLED repository=rclone:himawari-oci:$bucket/restic region=$region rclone=$rclone_version restic=$restic_version"
