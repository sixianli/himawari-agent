#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "ACCEPTANCE_COMMAND_FAILED run-question12-downloads line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
test "$#" -eq 1
test "$1" = --approved-s6-reference-downloads
test "$(hostname)" = __PKT_HOSTNAME__
test "$(id -u)" -eq 0
test "$(uname -s)" = Linux
account=$(getent passwd himawari-prod)
IFS=: read -r account_name _ service_uid service_gid _ _ account_shell <<< "$account"
test "$account_name" = himawari-prod
test "$service_uid" -gt 0
test "$service_gid" -gt 0
test "$account_shell" = /usr/sbin/nologin
test "$(id -G himawari-prod)" = "$service_gid"
stage=/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__
base=$stage/packet/acceptance/cloud
parent=$stage/acceptance
target=$parent/question-12-downloads
manifest=$base/cloud-inputs.draft.json
install_evidence=/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence
receipt=$install_evidence/p8-reference-downloads-launch.json
stdout=$install_evidence/p8-reference-downloads.stdout
stderr=$install_evidence/p8-reference-downloads.stderr
for directory in "$stage" "$stage/packet" "$stage/packet/acceptance" "$base"; do
  test -d "$directory"
  test ! -L "$directory"
  test "$(realpath -e -- "$directory")" = "$directory"
  test "$(stat -c '%u:%g:%a' "$directory")" = "0:$service_gid:750"
done
test -d "$parent"
test ! -L "$parent"
test "$(realpath -e -- "$parent")" = "$parent"
test "$(stat -c '%u:%g:%a' "$parent")" = "$service_uid:$service_gid:700"
test -d "$install_evidence"
test ! -L "$install_evidence"
test "$(realpath -e -- "$install_evidence")" = "$install_evidence"
test "$(stat -c '%u:%g:%a' "$install_evidence")" = "$service_uid:$service_gid:700"
for filename in "$target" "$receipt" "$stdout" "$stderr"; do
  test ! -e "$filename"
  test ! -L "$filename"
done
load_state=$(systemctl show himawari-prod.service --property=LoadState --value)
test "$load_state" = not-found || test "$load_state" = loaded
manifest_sha=$(/usr/bin/python3 -I - "$manifest" "$base" "$target" "$service_gid" <<'PY'
import hashlib, json, os, pathlib, stat, sys
manifest_path, base, target = map(pathlib.Path, sys.argv[1:4])
gid = int(sys.argv[4])
info = manifest_path.lstat()
if sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1 or manifest_path.resolve() != manifest_path:
    raise RuntimeError('P8D_DRAFT_MANIFEST_UNSAFE')
data = manifest_path.read_bytes()
manifest = json.loads(data)
if manifest['schema'] != 'himawari-__PKT_LABEL__-cloud-acceptance-inputs.v1' or manifest['profile'] != 'cloud-__PKT_LABEL__-change' or manifest['acceptanceAccount'] != 'himawari-prod' or manifest['question12Downloads']['root'] != str(target) or manifest['productionQualificationIssued'] is not False:
    raise RuntimeError('P8D_FIXED_DRAFT_REQUIRED')
for relative, expected in manifest['files'].items():
    filename = base / relative
    info = filename.lstat()
    if pathlib.Path(relative).is_absolute() or '..' in pathlib.Path(relative).parts or filename.resolve() != filename or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or info.st_mode & 0o022 or info.st_nlink != 1 or hashlib.sha256(filename.read_bytes()).hexdigest() != expected:
        raise RuntimeError('P8D_BOUND_SOURCE_CHANGED:' + relative)
if manifest['question12Downloads']['files'] != {'fd-v10.5.0-__PKT_FD_TRIPLE__.tar.gz': '__PKT_FD_ARCHIVE_SHA256__', 'fd': '__PKT_FD_BINARY_SHA256__', 'is-number-7.0.0.tgz': '7b75c1057198cf97696909a9bee176c9c5e9bcb5b03bf3ecef2f484defadd51e'}:
    raise RuntimeError('P8D_FIXED_REFERENCE_IDENTITIES_REQUIRED')
print(hashlib.sha256(data).hexdigest())
PY
)
as_service() {
  /usr/bin/setpriv --reuid="$service_uid" --regid="$service_gid" --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$parent" "$@"
}
write_receipt() {
  /usr/bin/python3 -I - "$receipt" "$target" "$manifest" "$manifest_sha" "$stdout" "$stderr" "$service_uid" "$service_gid" "$1" "${created_identity:-}" <<'PY'
import datetime, hashlib, json, os, pathlib, stat, sys
receipt, target, manifest_path, stdout, stderr = map(pathlib.Path, [sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[5], sys.argv[6]])
expected_sha, uid, gid, exit_code, created_identity = sys.argv[4], int(sys.argv[7]), int(sys.argv[8]), int(sys.argv[9]), sys.argv[10]
record = {'schema': 'himawari-__PKT_LABEL__-cloud-p8-public-launch.v1', 'operation': 'P8D', 'hostname': '__PKT_HOSTNAME__', 'rootWrapperUid': os.getuid(), 'acceptanceUid': uid, 'productionQualificationIssued': False, 'childExitCode': exit_code, 'inputManifest': {'path': str(manifest_path), 'sha256': expected_sha}, 'command': ['/usr/bin/python3', '-I', str(manifest_path.parent / 'download-question-12.py'), '--approved-question-12-downloads', str(target)], 'readbackErrors': [], 'outputs': [], 'passed': False, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != expected_sha:
        raise RuntimeError('P8D_DRAFT_CHANGED_DURING_RUN')
    if target.exists():
        info = target.lstat()
        record['outputDirectory'] = {'path': str(target), 'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': format(stat.S_IMODE(info.st_mode), '04o')}
        if target.resolve() != target or not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o700 or created_identity != f'{info.st_dev}:{info.st_ino}':
            raise RuntimeError('P8D_OUTPUT_DIRECTORY_CHANGED')
        for filename in sorted(target.iterdir()):
            info = filename.lstat()
            if filename.resolve() != filename or not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_gid != gid or info.st_mode & 0o022 or info.st_nlink != 1:
                raise RuntimeError('P8D_PUBLIC_OUTPUT_UNSAFE')
            record['outputs'].append({'path': str(filename), 'bytes': info.st_size, 'sha256': hashlib.sha256(filename.read_bytes()).hexdigest(), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': format(stat.S_IMODE(info.st_mode), '04o')})
    if exit_code == 0:
        report = json.loads((target / 'download-report.json').read_text())
        manifest = json.loads(manifest_path.read_text())
        hashes = {pathlib.Path(item['path']).name: item['sha256'] for item in record['outputs']}
        if report['passed'] is not True or report['productionQualificationIssued'] is not False or report['inputMode'] != 'explicit-approved-two-source-downloads' or any(hashes.get(name) != expected for name, expected in manifest['question12Downloads']['files'].items()):
            raise RuntimeError('P8D_ORIGINAL_DOWNLOAD_READBACK_FAILED')
        record['passed'] = True
except Exception as error:
    record['readbackErrors'].append({'type': type(error).__name__, 'message': str(error)})
for filename in [stdout, stderr]:
    if filename.is_file():
        info = filename.lstat()
        record['outputs'].append({'path': str(filename), 'bytes': info.st_size, 'sha256': hashlib.sha256(filename.read_bytes()).hexdigest(), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': format(stat.S_IMODE(info.st_mode), '04o')})
payload = (json.dumps(record, indent=2) + '\n').encode()
with receipt.open('xb') as output:
    output.write(payload)
    output.flush()
    os.fsync(output.fileno())
info = receipt.lstat()
if receipt.read_bytes() != payload or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or receipt.resolve() != receipt:
    raise RuntimeError('P8D_ROOT_RECEIPT_READBACK_FAILED')
print(json.dumps({'receipt': {'path': str(receipt), 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': '0600'}, 'readback': record}))
sys.exit(0 if exit_code != 0 or record['passed'] else 1)
PY
}
trap 'outcome=$?; trap - EXIT; write_receipt "$outcome" || exit 1; exit "$outcome"' EXIT
as_service /usr/bin/python3 -I -c 'import os,sys; os.umask(0o077); os.mkdir(sys.argv[1],0o700)' "$target" < /dev/null
created_identity=$(stat -c '%d:%i' "$target")
test "$(stat -c '%u:%g:%a' "$target")" = "$service_uid:$service_gid:700"
set -C
as_service /usr/bin/python3 -I "$base/download-question-12.py" --approved-question-12-downloads "$target" < /dev/null > "$stdout" 2> "$stderr"
