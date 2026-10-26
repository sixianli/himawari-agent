import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys

packet = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet')
source = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/acceptance/run-01')
destination = Path('/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__')
operations = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
account = pwd.getpwnam('himawari-prod')
if sys.platform != 'linux' or socket.gethostname() != '__PKT_HOSTNAME__' or os.geteuid() != 0 or sys.argv[1:] != ['--approved-s6-material-publication'] or account.pw_uid <= 0:
    raise RuntimeError('EXPLICIT_ROOT_PUBLICATION_APPROVAL_REQUIRED')
os.umask(0o022)

def safe_directory(directory, uid, mode=None):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or directory.is_symlink() or directory.resolve() != directory or info.st_uid != uid or info.st_mode & 0o022:
        raise RuntimeError('DIRECTORY_UNSAFE:' + str(directory))
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('DIRECTORY_MODE_UNSAFE:' + str(directory))

def read_safe(file, uid):
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or file.is_symlink() or file.resolve() != file or before.st_uid != uid or before.st_nlink != 1:
        raise RuntimeError('SOURCE_FILE_UNSAFE:' + str(file))
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as input_file:
            opened = os.fstat(descriptor)
            if (before.st_dev, before.st_ino, before.st_uid, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns):
                raise RuntimeError('SOURCE_CHANGED_DURING_OPEN')
            data = input_file.read()
            after = os.fstat(descriptor)
            current = file.lstat()
            if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (current.st_dev, current.st_ino, current.st_uid, current.st_size, current.st_mtime_ns, current.st_ctime_ns) or after.st_size != opened.st_size or after.st_mtime_ns != opened.st_mtime_ns or after.st_ctime_ns != opened.st_ctime_ns:
                raise RuntimeError('SOURCE_CHANGED_DURING_COPY')
            return data
    finally:
        os.close(descriptor)

def publish(file, data, mode=0o640, gid=None):
    with file.open('xb') as output:
        output.write(data)
    os.chown(file, 0, account.pw_gid if gid is None else gid, follow_symlinks=False)
    file.chmod(mode)
    if hashlib.sha256(file.read_bytes()).digest() != hashlib.sha256(data).digest():
        raise RuntimeError('PUBLISHED_BYTES_CHANGED')

safe_directory(source, account.pw_uid, 0o700)
safe_directory(destination, 0)
run = json.loads(read_safe(source / 'run-report.json', account.pw_uid))
if not run['passed'] or not run['scratchDeleted'] or run['scratchCleanupPending'] or run['runnerErrors']:
    raise RuntimeError('FULL_ACCEPTANCE_AND_CLEANUP_REQUIRED')
evidence = destination / 'acceptance-evidence'
evidence.mkdir(mode=0o750)
os.chown(evidence, 0, account.pw_gid)
records = []

def copy_evidence(original, target):
    safe_directory(original, account.pw_uid)
    for item in sorted(original.iterdir()):
        info = item.lstat()
        if stat.S_ISDIR(info.st_mode) and not item.is_symlink():
            child = target / item.name
            child.mkdir(mode=0o750)
            os.chown(child, 0, account.pw_gid)
            copy_evidence(item, child)
        else:
            data = read_safe(item, account.pw_uid)
            publish(target / item.name, data)
            records.append({'path': str(target / item.name), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

copy_evidence(source, evidence)
for name in ['pi-installed', 'composition-installed', 'network-installed', 'boundary-installed', 'worker-loss-installed', 'web-search-installed', 'r2l6-installed']:
    data = read_safe(source / (name + '.json'), account.pw_uid)
    publish(destination / (name + '.json'), data)
    if (evidence / (name + '.json')).read_bytes() != data:
        raise RuntimeError('TOP_LEVEL_OBSERVATION_COPY_CHANGED')
if not operations.exists():
    operations.mkdir(mode=0o755, parents=True)
for parent in [operations, *operations.parents]:
    safe_directory(parent, 0)
for name in ['cloud-protected-prepare.mjs', 'validate-r2l6-installed.mjs', 'cloud-system-tool-bindings.mjs', 'cloud-capability-manifest.mjs']:
    data = read_safe(packet / 'signing' / name, 0)
    target = operations / name
    if target.exists():
        if read_safe(target, 0) != data:
            raise RuntimeError('EXISTING_HELPER_HASH_MISMATCH:' + name)
    else:
        publish(target, data, 0o644, 0)
    if stat.S_IMODE(target.lstat().st_mode) != 0o644 or target.lstat().st_gid != 0:
        raise RuntimeError('PUBLISHED_HELPER_MODE_MISMATCH:' + name)
    records.append({'path': str(target), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
workspace = Path('/var/lib/himawari/qualification-workspace-__PKT_LABEL__-__PKT_DATE_COMPACT__')
if not workspace.exists():
    workspace.mkdir(mode=0o700)
    os.chown(workspace, account.pw_uid, account.pw_gid)
safe_directory(workspace, account.pw_uid, 0o700)
print(json.dumps({'passed': True, 'published': records, 'workspace': {'path': str(workspace), 'device': str(workspace.stat().st_dev), 'inode': str(workspace.stat().st_ino)}}))
