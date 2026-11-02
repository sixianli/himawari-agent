set -euo pipefail
umask 022
[[ ${1:-} == --approved-__PKT_LABEL__-snapshot && $# == 1 ]]
[[ $(hostname) == __PKT_HOSTNAME__ && $(id -u) == 0 ]]
[[ $(id -u himawari-prod) == 999 && $(id -g himawari-prod) == 988 ]]
[[ $(/usr/bin/systemctl show --property=ActiveState --value himawari-prod.service) == inactive ]]
state=/var/lib/himawari/state
deployment=$state/deployment
qualification=/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__
operations=/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__
packet=/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet
node=/opt/himawari/node/bin/node
config=/etc/himawari/config.json
[[ -d $state && ! -L $state && $(realpath "$state") == "$state" ]]
[[ $(stat -c %u "$state") == 999 && $(stat -c %a "$state") == 700 ]]
[[ -d $deployment && ! -L $deployment && $(realpath "$deployment") == "$deployment" ]]
[[ $(stat -c %u "$deployment") == 999 && $(stat -c %a "$deployment") == 700 ]]
[[ -f $operations/runtime-protection.json && ! -L $operations/runtime-protection.json ]]
[[ -x /usr/bin/setpriv && ! -e $config.next && ! -L $config.next ]]
[[ ! -e $deployment/capability-deployment.json.next && ! -L $deployment/capability-deployment.json.next ]]
[[ ! -e $qualification/__PKT_LABEL__-prepare.json && ! -L $qualification/__PKT_LABEL__-prepare.json ]]
set -C
/usr/bin/setpriv --reuid=999 --regid=988 --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all /usr/bin/env -i PATH=/opt/himawari/node/bin:/usr/bin:/bin HOME="$state" LANG=C.UTF-8 HIMAWARI_RUNTIME_PROTECTION_FILE="$operations/runtime-protection.json" "$node" --no-global-search-paths "$operations/cloud-protected-prepare.mjs" --prepare "$config" > "$qualification/__PKT_LABEL__-prepare.json"
chmod 0640 "$qualification/__PKT_LABEL__-prepare.json"
chown root:himawari-prod "$qualification/__PKT_LABEL__-prepare.json"
[[ $(stat -c %u "$qualification/__PKT_LABEL__-prepare.json") == 0 && $(stat -c %g "$qualification/__PKT_LABEL__-prepare.json") == 988 && $(stat -c %a "$qualification/__PKT_LABEL__-prepare.json") == 640 ]]
runtime=/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent
/usr/bin/python3 -I - "$state" "$operations" "$runtime" <<'PYTHON'
import hashlib, json, os, re, secrets, signal, stat, sys
signal.alarm(120)
state, operations, runtime = sys.argv[1:4]
limit = 64 * 1024 * 1024
name = 'runtime-fingerprints-' + hashlib.sha256(runtime.encode()).hexdigest()[:16] + '.json'
target_name = 'runtime-fingerprints.json'
directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
class Refused(RuntimeError):
    pass
def fail(code):
    raise Refused('RUNTIME_FINGERPRINT_CACHE_' + code)
def valid(data):
    parsed = json.loads(data)
    if not isinstance(parsed, dict) or parsed.get('version') != 1 or parsed.get('root') != runtime or not isinstance(parsed.get('files'), dict) or not parsed['files']:
        fail('INVALID')
    for relative, entry in parsed['files'].items():
        if not isinstance(relative, str) or not isinstance(entry, dict):
            fail('INVALID')
        for key in ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs']:
            if not isinstance(entry.get(key), str) or not re.fullmatch(r'[0-9]+', entry[key]):
                fail('INVALID')
        if not isinstance(entry.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', entry['sha256']):
            fail('INVALID')
    return len(parsed['files'])
def read_regular(directory_fd, filename, owner):
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory_fd)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != owner or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > limit:
            fail('SOURCE_UNSAFE')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        identity = lambda value: (value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_ino, value.st_dev, value.st_nlink)
        if len(data) != before.st_size or identity(before) != identity(after):
            fail('SOURCE_CHANGED')
    return data
def main():
    data = None
    state_fd = os.open(state, directory)
    try:
        try:
            cache_fd = os.open('cache', directory, dir_fd=state_fd)
        except FileNotFoundError:
            cache_fd = None
        if cache_fd is not None:
            try:
                info = os.fstat(cache_fd)
                if info.st_uid != 999 or info.st_mode & 0o022:
                    fail('DIRECTORY_UNSAFE')
                try:
                    data = read_regular(cache_fd, name, 999)
                except FileNotFoundError:
                    data = None
            finally:
                os.close(cache_fd)
    finally:
        os.close(state_fd)
    operations_fd = os.open(operations, directory)
    try:
        info = os.fstat(operations_fd)
        if info.st_uid != 0 or info.st_mode & 0o022:
            fail('TARGET_DIRECTORY_UNSAFE')
        if data is None:
            try:
                existing = read_regular(operations_fd, target_name, 0)
            except FileNotFoundError:
                fail('NOT_WRITTEN')
            print('RUNTIME_FINGERPRINT_CACHE_ALREADY_PUBLISHED files=' + str(valid(existing)))
            return
        count = valid(data)
        temporary = target_name + '.' + secrets.token_hex(8) + '.tmp'
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=operations_fd)
        try:
            with os.fdopen(output, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchown(stream.fileno(), 0, 0)
                os.fchmod(stream.fileno(), 0o644)
                os.fsync(stream.fileno())
            os.rename(temporary, target_name, src_dir_fd=operations_fd, dst_dir_fd=operations_fd)
            temporary = None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=operations_fd)
                except FileNotFoundError:
                    pass
        os.fsync(operations_fd)
        if read_regular(operations_fd, target_name, 0) != data:
            fail('PUBLISHED_CHANGED')
    finally:
        os.close(operations_fd)
    print('RUNTIME_FINGERPRINT_CACHE_PUBLISHED files=' + str(count))
try:
    main()
except Refused as error:
    sys.exit(str(error))
except (OSError, ValueError) as error:
    sys.exit('RUNTIME_FINGERPRINT_CACHE_SOURCE_UNSAFE:' + type(error).__name__ + ':' + str(getattr(error, 'filename', None) or error))
PYTHON
[[ $(stat -c %u "$operations/runtime-fingerprints.json") == 0 && $(stat -c %a "$operations/runtime-fingerprints.json") == 644 && ! -L $operations/runtime-fingerprints.json ]]
[[ $(stat -c %u "$config") == 999 && $(stat -c %a "$config") == 600 ]]
[[ $(stat -c %u "$deployment/capability-deployment.json") == 999 && $(stat -c %a "$deployment/capability-deployment.json") == 600 ]]
[[ ! -e $config.next && ! -L $config.next && ! -e $deployment/capability-deployment.json.next && ! -L $deployment/capability-deployment.json.next ]]
/usr/bin/setpriv --reuid=999 --regid=988 --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all /usr/bin/env -i PATH=/opt/himawari/node/bin:/usr/bin:/bin HOME="$state" LANG=C.UTF-8 HIMAWARI_RUNTIME_PROTECTION_FILE="$operations/runtime-protection.json" "$node" --no-global-search-paths --input-type=module - <<'NODE'
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
