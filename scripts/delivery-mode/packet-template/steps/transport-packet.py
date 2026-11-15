import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import time

sys.dont_write_bytecode = True
CHUNK = 1048576


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def safe_relative(name):
    return isinstance(name, str) and name == str(Path(name)) and not Path(name).is_absolute() and all(part not in ('', '.', '..') for part in name.split('/'))


def next_member(archive, name=None):
    member = archive.next()
    require(member is not None and member.isfile() and safe_relative(member.name) and (name is None or member.name == name), '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_INVALID')
    return member


def write_member(archive, member, filename, expected, uid, gid, common):
    require(member.size == expected['bytes'], '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_SIZE_CHANGED')
    stream = archive.extractfile(member)
    require(stream is not None, '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_UNREADABLE')
    digest = hashlib.sha256()
    written = 0
    with filename.open('xb') as output:
        os.fchmod(output.fileno(), 0o640)
        os.fchown(output.fileno(), uid, gid)
        while True:
            chunk = stream.read(min(CHUNK, member.size - written + 1))
            if not chunk:
                break
            written += len(chunk)
            require(written <= member.size, '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_TOO_LONG')
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    require(written == expected['bytes'] and digest.hexdigest() == expected['sha256'], '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_BYTES_CHANGED:' + member.name)
    require(common.record(filename, uid) == {key: expected[key] for key in ('bytes', 'sha256')}, '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_READBACK_CHANGED:' + member.name)


def cache_spec(encoded):
    try:
        spec = json.loads(base64.b64decode(encoded, validate=True))
    except ValueError:
        raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_SPEC_INVALID') from None
    require(isinstance(spec, dict) and set(spec) == {'fill', 'minBytes', 'maxBytes'} and isinstance(spec['fill'], list) and all(safe_relative(name) for name in spec['fill']) and len(set(spec['fill'])) == len(spec['fill']) and type(spec['minBytes']) is int and spec['minBytes'] > 0 and type(spec['maxBytes']) is int and spec['maxBytes'] > 0, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_SPEC_INVALID')
    return spec


def cache_directories(root, uid, gid):
    entries = root / 'sha256'
    for directory in (root, entries):
        if not os.path.lexists(directory):
            directory.mkdir(mode=0o700)
            os.chown(directory, uid, gid)
            os.chmod(directory, 0o700)
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700 and directory.resolve() == directory, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNSAFE')
    return entries


def copy_verified(source_descriptor, filename, expected, uid, gid, mode):
    digest = hashlib.sha256()
    written = 0
    with filename.open('xb') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), uid, gid)
        while True:
            chunk = os.read(source_descriptor, CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > expected['bytes']:
                break
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return written == expected['bytes'] and digest.hexdigest() == expected['sha256']


def fill_from_cache(entries, expected, filename, uid, gid, common):
    source = entries / expected['sha256']
    try:
        before = source.lstat()
    except FileNotFoundError:
        raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_MISS_AFTER_QUERY:' + expected['path']) from None
    if not (stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and not stat.S_IMODE(before.st_mode) & 0o077 and before.st_size == expected['bytes']):
        os.unlink(source)
        raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID:' + expected['path'])
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(common.identity(os.fstat(descriptor)) == common.identity(before), '__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_CHANGED:' + expected['path'])
        matched = copy_verified(descriptor, filename, expected, uid, gid, 0o640)
    finally:
        os.close(descriptor)
    if not matched:
        os.unlink(source)
        raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID:' + expected['path'])
    require(common.record(filename, uid) == {key: expected[key] for key in ('bytes', 'sha256')}, '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_READBACK_CHANGED:' + expected['path'])


def discard(path):
    if stat.S_ISDIR(path.lstat().st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def store_in_cache(entries, target, members, spec, uid, gid):
    kept = set()
    for name, expected in sorted(members.items()):
        if expected['bytes'] < spec['minBytes']:
            continue
        kept.add(expected['sha256'])
        final = entries / expected['sha256']
        if os.path.lexists(final):
            info = final.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and not stat.S_IMODE(info.st_mode) & 0o077 and info.st_size == expected['bytes']:
                os.utime(final, follow_symlinks=False)
                continue
            discard(final)
        temporary = entries / ('.incoming-' + expected['sha256'] + '-' + str(os.getpid()))
        descriptor = os.open(target / name, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            matched = copy_verified(descriptor, temporary, expected, uid, gid, 0o600)
        finally:
            os.close(descriptor)
        if not matched:
            os.unlink(temporary)
            raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_CACHE_STORE_CHANGED:' + name)
        os.replace(temporary, final)
    for name in os.listdir(entries):
        if name.startswith('.incoming-'):
            discard(entries / name)
    present = []
    for name in os.listdir(entries):
        info = (entries / name).lstat()
        present.append((info.st_mtime_ns, name, info.st_size))
    total = sum(size for mtime, name, size in present)
    removed = []
    for mtime, name, size in sorted(present):
        if total <= spec['maxBytes']:
            break
        if name in kept:
            continue
        discard(entries / name)
        total -= size
        removed.append(name)
    descriptor = os.open(entries, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {'stored': sorted(kept), 'removed': removed, 'bytes': total}


def receive_members(stream, target, expected_freeze, uid, gid, common, entries, fill):
    require(not os.path.lexists(target), '__PKT_LABEL_UPPER___TRANSPORT_TARGET_NOT_EXCLUSIVE')
    common.directory(target.parent, uid, 0o700)
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        member = next_member(archive, 'freeze-manifest.json')
        require(0 < member.size <= 16777216, '__PKT_LABEL_UPPER___TRANSPORT_MANIFEST_SIZE_INVALID')
        manifest_stream = archive.extractfile(member)
        require(manifest_stream is not None, '__PKT_LABEL_UPPER___TRANSPORT_MANIFEST_UNREADABLE')
        manifest_bytes = manifest_stream.read(member.size + 1)
        require(len(manifest_bytes) == member.size and common.sha(manifest_bytes) == expected_freeze, '__PKT_LABEL_UPPER___TRANSPORT_EXPECTED_FREEZE_CHANGED')
        try:
            manifest = json.loads(manifest_bytes)
        except ValueError:
            raise RuntimeError('__PKT_LABEL_UPPER___TRANSPORT_MANIFEST_JSON_INVALID') from None
        require(isinstance(manifest, dict) and set(manifest) == {'schemaVersion', 'status', 'approvalRef', 'files'} and manifest['schemaVersion'] == 'himawari.__PKT_LABEL__-change-freeze.v1' and manifest['status'] == 'frozen-approved' and manifest['approvalRef'] == common.APPROVED_REF and isinstance(manifest['files'], list), '__PKT_LABEL_UPPER___TRANSPORT_MANIFEST_INVALID')
        members = {}
        for entry in manifest['files']:
            require(isinstance(entry, dict) and set(entry) == {'path', 'bytes', 'sha256'} and safe_relative(entry['path']) and entry['path'] != 'freeze-manifest.json' and entry['path'] not in members and type(entry['bytes']) is int and entry['bytes'] >= 0 and isinstance(entry['sha256'], str) and re.fullmatch('[a-f0-9]{64}', entry['sha256']), '__PKT_LABEL_UPPER___TRANSPORT_MANIFEST_ENTRY_INVALID')
            members[entry['path']] = entry
        require('inputs/bindings.json' in members, '__PKT_LABEL_UPPER___TRANSPORT_BINDINGS_MISSING')
        target.mkdir(mode=0o700)
        os.chown(target, uid, gid)
        os.chmod(target, 0o700)
        common.publish(target / 'freeze-manifest.json', manifest_bytes, uid, gid, 0o640)
        seen = set()
        for name in fill:
            require(name in members, '__PKT_LABEL_UPPER___TRANSPORT_CACHE_FILL_NOT_FROZEN')
            filename = target / name
            common.make_parents(filename.parent, target, uid, gid, 0o750)
            fill_from_cache(entries, {**members[name], 'path': name}, filename, uid, gid, common)
            seen.add(name)
        while True:
            member = archive.next()
            if member is None:
                break
            require(member.isfile() and member.name in members and member.name not in seen, '__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_MEMBER')
            filename = target / member.name
            common.make_parents(filename.parent, target, uid, gid, 0o750)
            write_member(archive, member, filename, members[member.name], uid, gid, common)
            seen.add(member.name)
        require(seen == set(members), '__PKT_LABEL_UPPER___TRANSPORT_MEMBERS_INCOMPLETE')
    verified = common.verify_frozen(target, common.APPROVED_REF, uid, exact=True)
    require(verified['freezeSha256'] == expected_freeze, '__PKT_LABEL_UPPER___TRANSPORT_FINAL_FREEZE_CHANGED')
    for parent, directories, filenames in os.walk(target):
        common.sync_directory(Path(parent))
    common.sync_directory(target.parent)
    return {'passed': True, 'target': str(target), 'approvalRef': common.APPROVED_REF, 'freezeSha256': verified['freezeSha256'], 'bindingsSha256': verified['bindingsSha256'], 'members': len(members)}, members


def receive_archive(stream, target, expected_freeze, uid, gid, common, cache=None, spec=None):
    if spec is None:
        return receive_members(stream, target, expected_freeze, uid, gid, common, None, [])[0]
    try:
        entries = cache_directories(cache, uid, gid)
        if os.path.lexists(cache / 'lock') and not stat.S_ISREG((cache / 'lock').lstat().st_mode):
            discard(cache / 'lock')
        lock = os.open(cache / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except (RuntimeError, OSError) as error:
        message = str(error) if isinstance(error, RuntimeError) else '__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNUSABLE:' + type(error).__name__
        require(not spec['fill'], message)
        result = receive_members(stream, target, expected_freeze, uid, gid, common, None, [])[0]
        result['cacheStoreError'] = message
        return result
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result, members = receive_members(stream, target, expected_freeze, uid, gid, common, entries, spec['fill'])
        result['cacheFilled'] = sorted(spec['fill'])
        try:
            result['cache'] = store_in_cache(entries, target, members, spec, uid, gid)
        except Exception as error:
            result['cacheStoreError'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        return result
    finally:
        os.close(lock)

def production_main(expected_freeze, common):
    import pwd
    import shutil
    import socket
    os.umask(0o077)
    require(sys.argv[1:3] == ['--approved-r2l13-__PKT_LABEL__-transport', expected_freeze] and len(sys.argv) in (3, 4) and re.fullmatch('[a-f0-9]{64}', expected_freeze) and sys.executable == '/usr/bin/python3' and sys.flags.isolated == 1 and sys.platform == 'linux' and os.getuid() == 0 and socket.gethostname() == '__PKT_HOSTNAME__', '__PKT_LABEL_UPPER___TRANSPORT_EXPLICIT_APPROVAL_REQUIRED')
    account = pwd.getpwnam('himawari-prod')
    require((account.pw_uid, account.pw_gid) == (999, 988), '__PKT_LABEL_UPPER___TRANSPORT_SERVICE_ACCOUNT_CHANGED')
    parent = common.UPLOAD.parent
    if not os.path.lexists(parent):
        parent.mkdir(mode=0o700)
        os.chown(parent, 0, 0)
        os.chmod(parent, 0o700)
    common.directory(parent, 0, 0o700)
    report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-transport.v1', 'passed': False, 'actor': {'uid': 0, 'hostname': socket.gethostname()}, 'target': str(common.UPLOAD), 'expectedFreezeSha256': expected_freeze, 'rootFreeBeforeBytes': shutil.disk_usage('/').free, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    prefix = parent / ('transport-' + str(time.time_ns()))
    common.publish(Path(str(prefix) + '-started.json'), (json.dumps(report, indent=2) + '\n').encode(), 0, 0, 0o600)
    try:
        report.update(receive_archive(sys.stdin.buffer, common.UPLOAD, expected_freeze, 0, 0, common, common.MATERIAL_CACHE, cache_spec(sys.argv[3]) if len(sys.argv) == 4 else None))
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['failureCode'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        report['partialTargetRetained'] = os.path.lexists(common.UPLOAD)
    report['rootFreeAfterBytes'] = shutil.disk_usage('/').free
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output = Path(str(prefix) + '-result.json')
    common.publish(output, (json.dumps(report, indent=2) + '\n').encode(), 0, 0, 0o600)
    print(json.dumps({'passed': report['passed'], 'report': str(output), 'sha256': common.sha(common.read(output, 0)), 'failureCode': report.get('failureCode')}))
    return 0 if report['passed'] else 1
