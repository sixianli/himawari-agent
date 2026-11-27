set -Eeuo pipefail
trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR
umask 077
[[ ${1:-} == --approved-s6-signing && $# == 1 ]]
[[ $(id -u) == 0 && $(hostname) == __PKT_HOSTNAME__ ]]
[[ $(id -u himawari-prod) == __PKT_SERVICE_UID__ && $(id -g himawari-prod) == __PKT_SERVICE_GID__ ]]
packet=/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet
qualification=/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__
node=/opt/himawari/node/bin/node
[[ -d $packet && ! -L $packet && $(realpath "$packet") == "$packet" ]]
[[ $(stat -c %u "$packet") == 0 ]]
packet_mode=$(stat -c %a "$packet")
[[ $packet_mode =~ ^[0-7]{3,4}$ ]]
(( (8#$packet_mode & 8#022) == 0 ))
[[ -d $qualification && ! -L $qualification && $(realpath "$qualification") == "$qualification" ]]
[[ $(stat -c %u "$qualification") == 0 && $(stat -c %g "$qualification") == __PKT_SERVICE_GID__ && $(stat -c %a "$qualification") == 750 ]]
[[ $(sha256sum "$node" | cut -d ' ' -f 1) == __PKT_NODE_SHA256__ ]]
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
for name in seal-preflight.json seal-result.json seal-readback.json host-qualification-public-key.pem installation-receipt.json installation-receipt.sig pi-runner.sig search-runner.sig fetch-runner.sig; do
  [[ ! -e $qualification/$name && ! -L $qualification/$name ]]
done
set -C
"$node" --no-global-search-paths "$packet/signing/cloud-seal.mjs" --preflight > "$qualification/seal-preflight.json"
"$node" --no-global-search-paths "$packet/signing/cloud-seal.mjs" > "$qualification/seal-result.json"
"$node" --no-global-search-paths --input-type=module - "$qualification" > "$qualification/seal-readback.json" <<'NODE'
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
const qualification = process.argv[2];
assert.equal(qualification, "/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__");
const file = (name) => qualification + "/" + name;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receiptBytes = await readFile(file("installation-receipt.json"));
const publicKey = createPublicKey(await readFile(file("host-qualification-public-key.pem")));
const oldPublicKey = createPublicKey(await readFile("__PKT_FIRST_SIGNER_KEY_PATH__"));
assert.equal(digest(publicKey.export({ type: "spki", format: "der" })), digest(oldPublicKey.export({ type: "spki", format: "der" })));
assert(verify(null, receiptBytes, publicKey, await readFile(file("installation-receipt.sig"))));
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.runtime, "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent");
assert.equal(receipt.host, "__PKT_HOSTNAME__");
assert.equal(receipt.bindingInputs.schema, "himawari-__PKT_LABEL__-cloud-binding-inputs.v1");
assert.equal(receipt.source.revision, "__PKT_COMMIT__");
for (const binding of receipt.bindings) {
  assert(verify(null, await readFile(binding.binding.runner.path), publicKey, await readFile(file(binding.key + "-runner.sig"))));
}
const outputs = [];
for (const name of ["host-qualification-public-key.pem", "installation-receipt.json", "installation-receipt.sig", "pi-runner.sig", "search-runner.sig", "fetch-runner.sig", "seal-preflight.json", "seal-result.json"]) {
  const info = await lstat(file(name));
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o7777) === 0o600);
  outputs.push({ path: file(name), bytes: info.size, sha256: digest(await readFile(file(name))) });
}
process.stdout.write(JSON.stringify({ passed: true, signatureVerified: true, sameSignerAsFirst: true, signerPublicKeySha256: digest(publicKey.export({ type: "spki", format: "der" })), outputs }) + "\n");
NODE
for name in host-qualification-public-key.pem installation-receipt.json installation-receipt.sig pi-runner.sig search-runner.sig fetch-runner.sig seal-preflight.json seal-result.json seal-readback.json; do
  chown root:himawari-prod "$qualification/$name"
  chmod 0640 "$qualification/$name"
  [[ $(stat -c %u "$qualification/$name") == 0 && $(stat -c %g "$qualification/$name") == __PKT_SERVICE_GID__ && $(stat -c %a "$qualification/$name") == 640 ]]
done
cat -- "$qualification/seal-readback.json"
