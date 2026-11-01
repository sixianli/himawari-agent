import base64
import datetime
import fcntl
import json
import os
import pwd
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys

STAGE_NAME = re.compile(r'himawari-[a-z]+-[0-9]{8}(\..+)?')
UPLOAD_NAME = re.compile(r'[a-z]+-packet-upload(\..+)?')
SCRATCH_NAME = re.compile(r'h[A-Za-z0-9]{4}')
SCRATCH_OWNER = 'himawari-prod'
PACKET_COPY_NAME = re.compile(r'.+-change-packet-[0-9]+')
DATABASE_COPY = re.compile(r'/[^/]*-raw-schema[0-9]+[^/]*/data/')
STATE_COPY_NAMES = (('data', re.compile(r'pre-migration-[A-Za-z0-9]+')), ('.', re.compile(r'\.raw-restore-.+-original')))
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
    return Path(plan['unitPath']).read_text() + '\n' + Path(plan['config']).read_text(errors='replace')


def database_releases(plan):
    pattern = re.compile(re.escape(plan['releasesRoot']) + r'/([A-Za-z0-9._-]+)')
    found = {}
    database = sqlite3.connect('file:' + plan['database'] + '?mode=ro', uri=True)
    try:
        tables = [row[0] for row in database.execute("select name from sqlite_master where type = 'table'")]
        for table in tables:
            columns = [row[0] for row in database.execute('select name from pragma_table_info(?)', (table,))]
            if not columns:
                continue
            values = ['cast("' + column.replace('"', '""') + '" as text)' for column in columns]
            query = 'select ' + ', '.join(values) + ' from "' + table.replace('"', '""') + '" where ' + ' or '.join('instr(' + value + ', ?) > 0' for value in values)
            try:
                rows = database.execute(query, [plan['releasesRoot'] + '/'] * len(values)).fetchall()
            except sqlite3.OperationalError:
                found.setdefault('unreadableTables', []).append(table)
                continue
            for row in rows:
                for column, value in zip(columns, row):
                    for match in pattern.finditer(value or ''):
                        found.setdefault(plan['releasesRoot'] + '/' + match.group(1), table + '.' + column)
    finally:
        database.close()
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


def preserve_failed_acceptance(stage, destination, apply):
    source = Path(stage) / 'acceptance'
    kept = []
    if not source.is_dir() or source.is_symlink():
        return kept
    for parent, directories, files in os.walk(source):
        directories[:] = [name for name in directories if name not in REBUILDABLE_SUBTREES]
        for name in files:
            path = Path(parent) / name
            if not stat.S_ISREG(os.lstat(path).st_mode):
                continue
            target = Path(destination) / path.relative_to(source)
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
    result['unreadableTables'] = named_by_database.pop('unreadableTables', [])
    for path in children(plan['releasesRoot']):
        if path in (current['prefix'], current['rollbackPrefix']):
            keep(path, 'serving' if path == current['prefix'] else 'rollback-target')
        elif os.path.islink(path):
            keep(path, 'symbolic-link')
        elif in_use(path):
            keep(path, in_use(path))
        elif path in named_by_database:
            keep(path, 'named-by-database:' + named_by_database[path])
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
        preserved = [] if path != plan.get('currentStage') else preserve_failed_acceptance(path, plan['archiveRoot'] + '/failed-acceptance/' + stamp + '-' + Path(path).name, apply)
        for item in preserved:
            result['kept'].append({'path': item, 'reason': 'failed-acceptance-evidence'})
        remove(path, 'release-transport-copy')

    owners = plan.get('scratchOwnerUids', [])
    scenes = []
    for path in children(plan['scratchRoot'], SCRATCH_NAME):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or stat.S_IMODE(info.st_mode) != 0o700:
            keep(path, 'not-a-failure-scene')
        elif in_use(path):
            keep(path, in_use(path))
        else:
            scenes.append((info.st_mtime, path))
    for index, (mtime, path) in enumerate(sorted(scenes, reverse=True)):
        if index < plan['keepFailureScenes']:
            keep(path, 'newest-failure-scene')
        else:
            remove(path, 'failure-scene')

    target = plan['qualificationTarget']
    if Path(target).parent != Path(plan['evidenceParent']) / 'qualification' or Path(target).name in ('', '.', '..'):
        fail('CLEANUP_QUALIFICATION_PATH_INVALID')
    if os.path.lexists(target):
        if os.path.islink(target) or not os.path.isdir(target):
            keep(target, 'not-a-directory')
        elif in_use(target):
            keep(target, in_use(target))
        elif os.listdir(target):
            keep(target, 'qualification-not-empty')
        else:
            remove(target, 'empty-qualification-leftover')
    preserved_root = Path(plan['archiveRoot']) / 'failed-acceptance'
    for path in children(preserved_root)[:-plan.get('keepFailedAcceptance', 2)]:
        remove(path, 'old-failed-acceptance')

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

    for subdirectory, pattern in STATE_COPY_NAMES:
        folder = Path(plan['stateRoot']) / subdirectory
        dated = []
        for path in children(folder, pattern):
            database = Path(path) / 'product.sqlite'
            dated.append((os.lstat(database if database.exists() else path).st_mtime, path))
        for position, (mtime, path) in enumerate(sorted(dated, reverse=True)):
            reason = in_use(path)
            if os.path.islink(path) or not os.path.isdir(path):
                keep(path, 'not-a-directory')
            elif position < plan['keepStateCopies']:
                keep(path, 'recent-state-copy')
            elif reason:
                keep(path, reason)
            else:
                remove(path, 'old-state-copy')

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
        plan['scratchOwnerUids'] = [0, pwd.getpwnam(SCRATCH_OWNER).pw_uid]
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
