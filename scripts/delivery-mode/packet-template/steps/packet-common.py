import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
APPROVED_REF = 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'
OPERATIONS_DIRECTORIES = {'install', 'systemd', 'maintenance', 's0-db', 'inputs', 'signing', 'measurement', 'acceptance', 'steps'}
FLAT_HELPERS = {'cloud-protected-prepare.mjs', 'validate-r2l6-installed.mjs', 'cloud-system-tool-bindings.mjs', 'cloud-capability-manifest.mjs'}
STAGE = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet')
OPERATIONS = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
EVIDENCE = Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
UPLOAD = Path('/var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01')
MATERIAL_CACHE = Path('/opt/himawari/material-cache')


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def directory(path, uid, mode=None):
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o022 and (mode is None or stat.S_IMODE(info.st_mode) == mode), '__PKT_LABEL_UPPER___PACKET_DIRECTORY_UNSAFE:' + str(path))
    return info


def read(path, uid):
    before = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and not before.st_mode & 0o022, '__PKT_LABEL_UPPER___PACKET_FILE_UNSAFE:' + str(path))
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            data = stream.read()
        require(identity(before) == identity(os.fstat(descriptor)) == identity(path.lstat()) and len(data) == before.st_size, '__PKT_LABEL_UPPER___PACKET_FILE_CHANGED_DURING_READ')
        return data
    finally:
        os.close(descriptor)


def record(path, uid):
    data = read(path, uid)
    return {'bytes': len(data), 'sha256': sha(data)}


DEPLOY_LOGS = 'run-logs'


def verify_frozen(root, reference, uid, exact=True):
    directory(root, uid)
    manifest_bytes = read(root / 'freeze-manifest.json', uid)
    binding_bytes = read(root / 'inputs/bindings.json', uid)
    try:
        manifest = json.loads(manifest_bytes)
        binding = json.loads(binding_bytes)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError('__PKT_LABEL_UPPER___PACKET_JSON_INVALID') from None
    require(isinstance(manifest, dict) and isinstance(binding, dict), '__PKT_LABEL_UPPER___PACKET_JSON_OBJECT_REQUIRED')
    require(set(manifest) == {'schemaVersion', 'status', 'approvalRef', 'files'} and manifest['schemaVersion'] == 'himawari.__PKT_LABEL__-change-freeze.v1' and manifest['status'] == binding.get('status') == 'frozen-approved' and binding.get('schemaVersion') == 'himawari.__PKT_LABEL__-change-bindings.v1' and manifest['approvalRef'] == binding.get('approvals', {}).get('packageRef') == reference and isinstance(manifest['files'], list) and manifest['files'], '__PKT_LABEL_UPPER___PACKET_APPROVAL_INVALID')
    members = {}
    for item in manifest['files']:
        require(isinstance(item, dict) and set(item) == {'path', 'bytes', 'sha256'} and isinstance(item['path'], str) and type(item['bytes']) is int and item['bytes'] >= 0 and isinstance(item['sha256'], str) and re.fullmatch('[a-f0-9]{64}', item['sha256']), '__PKT_LABEL_UPPER___PACKET_MANIFEST_ENTRY_INVALID')
        relative = Path(item['path'])
        require(not relative.is_absolute() and str(relative) == item['path'] and all(part not in ('', '.', '..') for part in item['path'].split('/')) and item['path'] != 'freeze-manifest.json' and item['path'] not in members, '__PKT_LABEL_UPPER___PACKET_MANIFEST_PATH_INVALID')
        require(record(root / relative, uid) == {key: item[key] for key in ('bytes', 'sha256')}, '__PKT_LABEL_UPPER___PACKET_FROZEN_BYTES_CHANGED:' + item['path'])
        members[item['path']] = item
    actual = set()
    for parent, directories, filenames in os.walk(root, followlinks=False):
        if Path(parent) == root and DEPLOY_LOGS in directories:
            directories.remove(DEPLOY_LOGS)
        for name in directories:
            directory(Path(parent) / name, uid)
        for name in filenames:
            path = Path(parent) / name
            read(path, uid)
            if path != root / 'freeze-manifest.json':
                actual.add(str(path.relative_to(root)))
    require(not exact or actual == set(members), '__PKT_LABEL_UPPER___PACKET_FROZEN_MEMBER_SET_CHANGED')
    require('inputs/bindings.json' in members, '__PKT_LABEL_UPPER___PACKET_BINDINGS_NOT_FROZEN')
    return {'manifest': manifest, 'binding': binding, 'members': members, 'freezeSha256': sha(manifest_bytes), 'bindingsSha256': sha(binding_bytes)}


def operations_members(members):
    return {name: item for name, item in members.items() if Path(name).parts[0] in OPERATIONS_DIRECTORIES or name == 'materials/source-build-inputs.json'}


def publish(path, data, uid, gid, mode):
    with path.open('xb') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), uid, gid)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    require(read(path, uid) == data, '__PKT_LABEL_UPPER___PACKET_PUBLICATION_READBACK_FAILED')


def make_parents(path, stop, uid, gid, mode):
    require(stop == path or stop in path.parents, '__PKT_LABEL_UPPER___PACKET_WRITE_OUTSIDE_TARGET')
    pending = []
    while path != stop and not os.path.lexists(path):
        pending.append(path)
        path = path.parent
    directory(path, uid)
    for current in reversed(pending):
        current.mkdir(mode=mode)
        os.chown(current, uid, gid)
        os.chmod(current, mode)
    for current in [path, *pending]:
        directory(current, uid)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def service_state():
    output = subprocess.check_output(['/usr/bin/systemctl', 'show', 'himawari-prod.service', '--no-pager', '--property=ActiveState,MainPID'], text=True, timeout=15, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    state = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    require(state == {'MainPID': '0', 'ActiveState': 'inactive'}, '__PKT_LABEL_UPPER___PACKET_SERVICE_MUST_REMAIN_STOPPED')
    return state
