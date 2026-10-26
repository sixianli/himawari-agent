import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import sys

sys.dont_write_bytecode = True
packet = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet')
if sys.argv[1:] != ['--approved-__PKT_LABEL__-frozen-packet-readback'] or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or sys.platform != 'linux' or os.getuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__':
    raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_PACKET_ROOT_READBACK_REQUIRED')

def stable(filename):
    before = filename.lstat()
    if filename.resolve() != filename or not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_nlink != 1:
        raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_FILE_UNSAFE')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            opened = os.fstat(descriptor)
            data = stream.read()
            after = os.fstat(descriptor)
        current = filename.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(opened) or identity(opened) != identity(after) or identity(after) != identity(current) or len(data) != before.st_size:
            raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_FILE_CHANGED_DURING_READ')
        return data
    finally:
        os.close(descriptor)

info = packet.lstat()
if packet.resolve() != packet or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
    raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_PACKET_UNSAFE')
manifest_bytes = stable(packet / 'freeze-manifest.json')
manifest = json.loads(manifest_bytes)
binding_bytes = stable(packet / 'inputs/bindings.json')
binding = json.loads(binding_bytes)
if set(manifest) != {'schemaVersion', 'status', 'approvalRef', 'files'} or manifest['schemaVersion'] != 'himawari.__PKT_LABEL__-change-freeze.v1' or manifest['status'] != 'frozen-approved' or binding['schemaVersion'] != 'himawari.__PKT_LABEL__-change-bindings.v1' or binding['status'] != 'frozen-approved' or not manifest['approvalRef'] or manifest['approvalRef'] != binding['approvals']['packageRef'] or not isinstance(manifest['files'], list) or not manifest['files']:
    raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_APPROVAL_INVALID')
seen = set()
for item in manifest['files']:
    if not isinstance(item, dict) or set(item) != {'path', 'bytes', 'sha256'} or not isinstance(item['path'], str) or not isinstance(item['bytes'], int) or isinstance(item['bytes'], bool) or item['bytes'] < 0 or not isinstance(item['sha256'], str) or len(item['sha256']) != 64 or any(character not in '0123456789abcdef' for character in item['sha256']):
        raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_ENTRY_INVALID')
    relative = Path(item['path'])
    if relative.is_absolute() or str(relative) != item['path'] or any(part in ['', '.', '..'] for part in item['path'].split('/')) or item['path'] in seen or item['path'] == 'freeze-manifest.json':
        raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_PATH_OR_DUPLICATE_INVALID')
    seen.add(item['path'])
    data = stable(packet / relative)
    if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
        raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_BYTES_CHANGED:' + item['path'])
if 'inputs/bindings.json' not in seen or 'acceptance/helpers/verify-frozen-packet.py' not in seen:
    raise RuntimeError('__PKT_LABEL_UPPER___FROZEN_BINDING_OR_VERIFIER_MISSING')
print(json.dumps({'schemaVersion': 'himawari.__PKT_LABEL__-change-frozen-packet-readback.v1', 'passed': True, 'approvalRef': manifest['approvalRef'], 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'bindingsSha256': hashlib.sha256(binding_bytes).hexdigest(), 'filesVerified': len(seen), 'laterGeneratedFilesPermitted': True}))
