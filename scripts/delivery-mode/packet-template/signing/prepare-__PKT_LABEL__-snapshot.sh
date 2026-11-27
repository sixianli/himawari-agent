set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 022
[[ ${1:-} == --approved-__PKT_LABEL__-snapshot && $# == 1 ]]
[[ $(hostname) == __PKT_HOSTNAME__ && $(id -u) == 0 ]]
[[ $(id -u himawari-prod) == __PKT_SERVICE_UID__ && $(id -g himawari-prod) == __PKT_SERVICE_GID__ ]]
[[ $(/usr/bin/systemctl show --property=ActiveState --value himawari-prod.service) == inactive ]]
state=/var/lib/himawari/state
deployment=$state/deployment
qualification=/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__
operations=/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__
packet=/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet
node=/opt/himawari/node/bin/node
config=/etc/himawari/config.json
[[ -d $state && ! -L $state && $(realpath "$state") == "$state" ]]
[[ $(stat -c %u "$state") == __PKT_SERVICE_UID__ && $(stat -c %a "$state") == 700 ]]
[[ -d $deployment && ! -L $deployment && $(realpath "$deployment") == "$deployment" ]]
[[ $(stat -c %u "$deployment") == __PKT_SERVICE_UID__ && $(stat -c %a "$deployment") == 700 ]]
[[ -f $operations/runtime-protection.json && ! -L $operations/runtime-protection.json ]]
[[ -x /usr/bin/setpriv && ! -e $config.next && ! -L $config.next ]]
[[ ! -e $deployment/capability-deployment.json.next && ! -L $deployment/capability-deployment.json.next ]]
[[ ! -e $qualification/__PKT_LABEL__-prepare.json && ! -L $qualification/__PKT_LABEL__-prepare.json ]]
/usr/bin/python3 -I - "$packet" <<'PYTHON'
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
packet = Path(sys.argv[1])
if packet != Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet') or packet.resolve() != packet or packet.is_symlink():
    raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_PATH_UNSAFE')
def read(filename):
    info = filename.lstat()
    if not stat.S_ISREG(info.st_mode) or filename.resolve() != filename or filename.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
        raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_FILE_UNSAFE')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            data = stream.read()
        after = os.fstat(descriptor)
        current = filename.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(info) != identity(after) or identity(after) != identity(current):
            raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_FILE_CHANGED')
        return data
    finally:
        os.close(descriptor)
manifest = json.loads(read(packet / 'freeze-manifest.json'))
bindings = json.loads(read(packet / 'inputs/bindings.json'))
if manifest['schemaVersion'] != 'himawari.__PKT_LABEL__-change-freeze.v1' or manifest['status'] != 'frozen-approved' or bindings['status'] != 'frozen-approved' or not manifest['approvalRef'] or manifest['approvalRef'] != bindings['approvals']['packageRef']:
    raise RuntimeError('APPROVED___PKT_LABEL_UPPER___PACKET_FREEZE_REQUIRED')
seen = set()
for entry in manifest['files']:
    relative = Path(entry['path'])
    if relative.is_absolute() or '..' in relative.parts or str(relative) != entry['path'] or entry['path'] in seen:
        raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_MEMBER_INVALID')
    seen.add(entry['path'])
    data = read(packet / relative)
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_BYTES_CHANGED:' + entry['path'])
if 'inputs/bindings.json' not in seen or 'inputs/s0-db-readback.json' not in seen or 'inputs/system-tools-observed.json' not in seen:
    raise RuntimeError('FROZEN___PKT_LABEL_UPPER___PACKET_OBSERVATIONS_REQUIRED')
PYTHON
set -C
/usr/bin/setpriv --reuid=__PKT_SERVICE_UID__ --regid=__PKT_SERVICE_GID__ --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all /usr/bin/env -i PATH=/opt/himawari/node/bin:/usr/bin:/bin HOME="$state" LANG=C.UTF-8 HIMAWARI_RUNTIME_PROTECTION_FILE="$operations/runtime-protection.json" "$node" --no-global-search-paths "$operations/cloud-protected-prepare.mjs" --prepare "$config" > "$qualification/__PKT_LABEL__-prepare.json"
chmod 0640 "$qualification/__PKT_LABEL__-prepare.json"
chown root:himawari-prod "$qualification/__PKT_LABEL__-prepare.json"
[[ $(stat -c %u "$qualification/__PKT_LABEL__-prepare.json") == 0 && $(stat -c %g "$qualification/__PKT_LABEL__-prepare.json") == __PKT_SERVICE_GID__ && $(stat -c %a "$qualification/__PKT_LABEL__-prepare.json") == 640 ]]
[[ $(stat -c %u "$config") == __PKT_SERVICE_UID__ && $(stat -c %a "$config") == 600 ]]
[[ $(stat -c %u "$deployment/capability-deployment.json") == __PKT_SERVICE_UID__ && $(stat -c %a "$deployment/capability-deployment.json") == 600 ]]
[[ ! -e $config.next && ! -L $config.next && ! -e $deployment/capability-deployment.json.next && ! -L $deployment/capability-deployment.json.next ]]
/usr/bin/setpriv --reuid=__PKT_SERVICE_UID__ --regid=__PKT_SERVICE_GID__ --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all /usr/bin/env -i PATH=/opt/himawari/node/bin:/usr/bin:/bin HOME="$state" LANG=C.UTF-8 HIMAWARI_RUNTIME_PROTECTION_FILE="$operations/runtime-protection.json" "$node" --no-global-search-paths --input-type=module - <<'NODE'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const config = JSON.parse(await readFile("/etc/himawari/config.json", "utf8"));
const snapshot = await readFile("/var/lib/himawari/state/deployment/capability-deployment.json");
const attestation = JSON.parse(await readFile("/var/lib/himawari/state/deployment/startup-attestation.json", "utf8"));
const result = JSON.parse(await readFile("/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__/third-prepare.json", "utf8"));
assert.equal(config.capabilityDeployment.sha256, "sha256:" + hash(snapshot));
assert.equal(attestation.snapshotDigest, hash(snapshot));
assert.equal(attestation.liveHostVerified, true);
assert.equal(attestation.signatureVerified, true);
assert.equal(result.event, "installation-verified");
assert.equal(result.preparing, true);
assert.equal(result.snapshotDigest, hash(snapshot));
assert.equal(result.runtimeDigest, attestation.runtimeDigest);
process.stdout.write(JSON.stringify({ passed: true, snapshotSha256: hash(snapshot), runtimeDigest: result.runtimeDigest, receiptDigest: attestation.receiptDigest, liveHostVerified: true, signatureVerified: true }) + "\n");
NODE
