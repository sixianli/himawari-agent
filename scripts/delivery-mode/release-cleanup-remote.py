import base64
import datetime
import fcntl
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys

STAGE_NAME = re.compile(r'himawari-[a-z]+-[0-9]{8}(\..+)?')
UPLOAD_NAME = re.compile(r'[a-z]+-packet-upload(\..+)?')
PACKET_COPY_NAME = re.compile(r'.+-change-packet-[0-9]+')
DATABASE_COPY = re.compile(r'/[^/]*-raw-schema[0-9]+[^/]*/data/')
EVIDENCE_NAME = re.compile(r'[a-z]+-[0-9]{8}-evidence(\..+)?')
SERVING_UNIT = re.compile(r'ExecStart=\S+ --no-global-search-paths (/\S+)/pair-supervisor\.mjs --prefix (/\S+) ')
REBUILDABLE_SUBTREES = {'packet', 'validation', 'input', 'materials', 'runtime-tools', 'question-12-downloads', 'node_modules'}
KEPT_SUFFIXES = {'.json', '.log', '.txt', '.stdout', '.stderr', '.md', '.diff', '.csv'}
BUSY_MARKERS = ('/steps/run-step.py', 'transport-packet', 'S1-publish-and-install', 'run-maintenance.mjs', 'S6-limited-host-acceptance')
SYSTEM_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}


def fail(code):
    raise RuntimeError(code)


def mentions(text, path):
    return re.search(re.escape(path) + r'(?![^/"\'\s:;,=)\]])', text) is not None


def allocated(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode):
        return info.st_blocks * 512
    total = info.st_blocks * 512
    for parent, directories, files in os.walk(path):
        for name in directories + files:
            total += os.lstat(os.path.join(parent, name)).st_blocks * 512
    return total


def process_references(own_pid):
    references = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == own_pid:
            continue
        base = Path('/proc') / pid
        for link in ('cwd', 'exe', 'root'):
            try:
                references.append(os.readlink(base / link))
            except OSError:
                pass
        try:
            references.extend(os.readlink(base / 'fd' / fd) for fd in os.listdir(base / 'fd'))
        except OSError:
            pass
        try:
            references.extend(line.split(None, 5)[5] for line in (base / 'maps').read_text().splitlines() if len(line.split(None, 5)) == 6)
        except OSError:
            pass
        try:
            references.append((base / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace'))
        except OSError:
            pass
    return references


def serving(plan):
    match = SERVING_UNIT.search(Path(plan['unitPath']).read_text())
    if not match:
        fail('CLEANUP_SERVING_RELEASE_UNKNOWN')
    operations, prefix = match.group(1), match.group(2)
    binding = json.loads((Path(operations) / 'inputs' / 'bindings.json').read_text())
    paths = binding['paths']
    if paths['newPrefix'] != prefix or paths['newOperations'] != operations:
        fail('CLEANUP_SERVING_BINDING_MISMATCH')
    return {'prefix': prefix, 'operations': operations, 'rollbackPrefix': paths['oldPrefix'], 'stage': str(Path(paths['transportRoot']).parent), 'evidence': paths['evidenceRoot']}


def configuration_text(plan):
    texts = [Path(plan['unitPath']).read_text()]
    for parent, directories, files in os.walk(plan['configDirectory']):
        for name in files:
            try:
                texts.append(Path(parent, name).read_text(errors='replace'))
            except OSError:
                pass
    return '\n'.join(texts)


def database_releases(plan):
    pattern = re.compile(re.escape(plan['releasesRoot'].encode()) + rb'/([A-Za-z0-9._-]+)')
    found = set()
    for name in (plan['database'], plan['database'] + '-wal'):
        if not os.path.isfile(name) or os.path.getsize(name) == 0:
            continue
        with open(name, 'rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
            found.update(plan['releasesRoot'] + '/' + match.group(1).decode() for match in pattern.finditer(data))
    return found


def children(root, pattern=None):
    root = Path(root)
    if not root.is_dir():
        return []
    return sorted(str(root / name) for name in os.listdir(root) if pattern is None or pattern.fullmatch(name))


def archive_small_files(source, destination, limit, apply):
    kept = []
    if Path(source).name in REBUILDABLE_SUBTREES:
        return kept
    for parent, directories, files in os.walk(source):
        directories[:] = [name for name in directories if name not in REBUILDABLE_SUBTREES and not PACKET_COPY_NAME.fullmatch(name)]
        for name in files:
            path = Path(parent) / name
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit or path.suffix not in KEPT_SUFFIXES:
                continue
            target = Path(destination) / path.relative_to(Path(source).parent)
            kept.append(str(target))
            if apply:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(path, target)
                os.chmod(target, 0o600)
    return kept


def cleanup(plan, apply, references, stamp):
    current = serving(plan)
    for reference in references:
        if any(marker in reference for marker in BUSY_MARKERS):
            fail('CLEANUP_RELEASE_STEP_RUNNING')
    configuration = configuration_text(plan)
    archive = str(Path(plan['archiveRoot']) / stamp)
    result = {'serving': current, 'deleted': [], 'trimmed': [], 'renamed': [], 'kept': [], 'archived': []}

    def in_use(path):
        if mentions(configuration, path):
            return 'named-by-unit-or-config'
        if any(reference == path or reference.startswith(path + '/') or mentions(reference, path) for reference in references):
            return 'used-by-a-process'
        return None

    def remove(path, reason):
        size = allocated(path)
        result['deleted'].append({'path': path, 'bytes': size, 'reason': reason})
        if apply:
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.unlink(path)

    def keep(path, reason):
        result['kept'].append({'path': path, 'reason': reason})

    named_by_database = database_releases(plan)
    for path in children(plan['releasesRoot']):
        if path in (current['prefix'], current['rollbackPrefix']):
            keep(path, 'serving' if path == current['prefix'] else 'rollback-target')
        elif os.path.islink(path):
            keep(path, 'symbolic-link')
        elif in_use(path) or path in named_by_database:
            keep(path, in_use(path) or 'named-by-database')
        else:
            remove(path, 'old-release')

    for path in children(plan['tmpRoot'], STAGE_NAME) + children(plan['tmpRoot'], UPLOAD_NAME):
        if os.path.islink(path) or not os.path.isdir(path):
            keep(path, 'not-a-directory')
            continue
        reason = in_use(path)
        if reason:
            keep(path, reason)
            continue
        if path == current['stage']:
            keep(path + '/packet', 'rollback-packet')
            for member in children(path):
                if Path(member).name != 'packet':
                    result['archived'] += archive_small_files(member, archive + '/' + Path(path).name, plan['smallFileBytes'], apply)
                    remove(member, 'release-transport-copy')
            continue
        result['archived'] += archive_small_files(path, archive, plan['smallFileBytes'], apply)
        remove(path, 'release-transport-copy')

    if os.path.isdir(plan['currentOperations']) and plan['currentOperations'] != current['operations'] and not in_use(plan['currentOperations']):
        remove(plan['currentOperations'], 'failed-attempt-operations')
    for path in children(plan['operationsRoot']):
        if '.attempt' in Path(path).name and not in_use(path):
            remove(path, 'failed-attempt-operations')

    evidence_roots = children(plan['evidenceParent'], EVIDENCE_NAME)
    database_copies = []
    for root in evidence_roots:
        for parent, directories, files in os.walk(root):
            for name in files:
                filename = os.path.join(parent, name)
                info = os.lstat(filename)
                if stat.S_ISREG(info.st_mode) and info.st_size > plan['largeFileBytes'] and DATABASE_COPY.search(filename):
                    database_copies.append((info.st_mtime, filename))
    recent_copies = {filename for mtime, filename in sorted(database_copies, reverse=True)[:plan['keepDatabaseCopies']]}
    for filename in sorted(recent_copies):
        keep(filename, 'recent-database-copy')

    for path in evidence_roots:
        if path == current['evidence']:
            keep(path, 'serving-evidence')
            continue
        for parent, directories, files in os.walk(path):
            for name in files:
                filename = os.path.join(parent, name)
                info = os.lstat(filename)
                if stat.S_ISREG(info.st_mode) and info.st_size > plan['largeFileBytes'] and filename not in recent_copies and not in_use(filename):
                    result['trimmed'].append({'path': filename, 'bytes': info.st_blocks * 512})
                    if apply:
                        os.unlink(filename)
        if path == plan['currentEvidence']:
            target = path + '.attempt-failed-' + stamp
            result['renamed'].append({'from': path, 'to': target})
            if apply:
                os.rename(path, target)

    result['freedBytes'] = sum(item['bytes'] for item in result['deleted'] + result['trimmed'])
    return result


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('plan', 'apply'):
        fail('CLEANUP_USAGE')
    plan = json.loads(base64.b64decode(sys.argv[2]))
    if os.getuid() != 0 or socket.gethostname() != plan['hostname']:
        fail('CLEANUP_PRODUCTION_ROOT_REQUIRED')
    active = subprocess.run(['/usr/bin/systemctl', 'is-active', plan['unit']], stdout=subprocess.PIPE, text=True, timeout=30, env=SYSTEM_ENV, check=False).stdout.strip()
    if active != 'active':
        fail('CLEANUP_SERVICE_NOT_ACTIVE')
    os.makedirs(os.path.dirname(plan['lockPath']), exist_ok=True)
    with open(plan['lockPath'], 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('CLEANUP_ALREADY_RUNNING')
        before = shutil.disk_usage('/').free
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        result = cleanup(plan, sys.argv[1] == 'apply', process_references(os.getpid()), stamp)
        result.update({'mode': sys.argv[1], 'rootFreeBeforeBytes': before, 'rootFreeAfterBytes': shutil.disk_usage('/').free})
        if sys.argv[1] == 'apply':
            report = Path(plan['archiveRoot']) / stamp / 'cleanup-report.json'
            report.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            report.write_text(json.dumps(result, indent=2) + '\n')
            os.chmod(report, 0o600)
            result['report'] = str(report)
    print('CLEANUP_REMOTE_RESULT ' + json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('CLEANUP_REMOTE_FAILED ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__ + ': ' + str(error)), file=sys.stderr)
        sys.exit(1)
