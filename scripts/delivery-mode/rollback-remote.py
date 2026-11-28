import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTHORITY_COLUMNS = (('id', 'id'), ('ownerId', 'owner_id'), ('agentId', 'agent_id'), ('revision', 'revision'), ('status', 'status'), ('authorityEpoch', 'authority_epoch'), ('fencingToken', 'fencing_token'), ('transferId', 'transfer_id'))
SYSTEM_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}


def fail(code):
    raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def service(unit):
    output = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '--no-pager', '--property=ActiveState,SubState,MainPID,NRestarts'], text=True, timeout=30, env=SYSTEM_ENV)
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def stopped(state):
    return state.get('ActiveState') in ('inactive', 'failed') and state.get('MainPID') == '0'


def stop_service(unit, timeout=300):
    subprocess.run(['/usr/bin/systemctl', 'stop', unit], check=True, timeout=timeout, env=SYSTEM_ENV)
    deadline = time.monotonic() + 60
    while not stopped(service(unit)):
        if time.monotonic() > deadline:
            fail('ROLLBACK_SERVICE_DID_NOT_STOP')
        time.sleep(1)
    if service(unit).get('ActiveState') == 'failed':
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', unit], check=True, timeout=30, env=SYSTEM_ENV)
    return service(unit)


def write_exclusive(path, data, uid, gid, mode):
    with Path(path).open('xb') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), uid, gid)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def replace_atomically(path, data, uid, gid, mode):
    path = Path(path)
    temporary = path.parent / ('.rollback-' + str(os.getpid()) + '-' + path.name + '.tmp')
    write_exclusive(temporary, data, uid, gid, mode)
    os.rename(temporary, path)
    sync_directory(path.parent)


def recovery_deployment(database, deployment_id):
    connection = sqlite3.connect('file:' + str(database) + '?mode=ro&immutable=1', uri=True)
    try:
        rows = connection.execute('SELECT ' + ','.join(column for _, column in AUTHORITY_COLUMNS) + ' FROM deployments WHERE id=?', [deployment_id]).fetchall()
    finally:
        connection.close()
    if len(rows) != 1:
        fail('ROLLBACK_RECOVERY_DEPLOYMENT_MISSING')
    return dict(zip((key for key, _ in AUTHORITY_COLUMNS), rows[0]))


def mirror_bytes(current, deployment):
    merged = dict(current)
    merged.update(deployment)
    return (json.dumps(merged, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def align_authority_mirror(mirror_path, recovery_database, deployment_id, evidence_root, uid, gid, suffix, evidence_owner=(0, 0)):
    original = Path(mirror_path).read_bytes()
    current = json.loads(original)
    deployment = recovery_deployment(recovery_database, deployment_id)
    if all(current.get(key) == value for key, value in deployment.items()):
        return {'changed': False, 'sha256': sha(original)}
    saved = Path(evidence_root) / ('authority-before-rollback-' + suffix + '.json')
    write_exclusive(saved, original, *evidence_owner, 0o600)
    updated = mirror_bytes(current, deployment)
    replace_atomically(mirror_path, updated, uid, gid, 0o600)
    return {'changed': True, 'savedOriginal': str(saved), 'originalSha256': sha(original), 'sha256': sha(updated), 'fencingTokenBefore': current.get('fencingToken'), 'fencingTokenAfter': deployment['fencingToken']}


def approval_document(plan, digest, suffix):
    return {
        'schemaVersion': plan['approvalSchema'],
        'action': plan['restoreAction'],
        'recoveryId': plan['recoveryId'],
        'recoveryDigest': digest,
        'targetStateRoot': plan['stateRoot'],
        'targetPrefix': plan['oldPrefix'],
        'discardsPostRecoveryPointHistory': True,
        'discardsCapabilityUpgrade': True,
        'requiresIndependentAccountRecovery': True,
        'controlFilesApproved': True,
        'preservedCurrentRecoveryId': plan['recoveryId'] + '-before-rollback-' + suffix,
        'approvalRef': 'user-ran-delivery-mode-rollback:' + suffix,
    }


def write_approval(plan, digest, suffix):
    path = Path(plan['evidenceRoot']) / 'rollback-approval.json'
    if path.exists():
        os.rename(path, path.with_name('rollback-approval.superseded-' + suffix + '.json'))
    write_exclusive(path, (json.dumps(approval_document(plan, digest, suffix), indent=2) + '\n').encode(), 0, plan['gid'], 0o640)
    return str(path)


def untouched(plan):
    config = sha(Path(plan['config']).read_bytes()) == plan['oldConfigSha256']
    unit = sha(Path(plan['unitPath']).read_bytes()) == plan['oldUnitSha256']
    names = os.listdir(plan['evidenceRoot']) if os.path.isdir(plan['evidenceRoot']) else []
    changed_database = any(name.startswith(prefix) for name in names for prefix in plan['databaseChangingReports'])
    return config and unit and not changed_database


def prepare(plan):
    suffix = stamp()
    result = {'serviceBefore': service(plan['unit'])}
    result['serviceAfterStop'] = stop_service(plan['unit'])
    if untouched(plan):
        result['route'] = 'start-only'
        return result
    s3 = json.loads((Path(plan['evidenceRoot']) / plan['recoveryReport']).read_text())
    if s3.get('passed') is not True or s3.get('recovery', {}).get('recoveryId') != plan['recoveryId']:
        fail('ROLLBACK_RECOVERY_POINT_NOT_VERIFIED')
    result['route'] = 'restore'
    result['approval'] = write_approval(plan, s3['recovery']['digest'], suffix)
    recovery_database = Path(plan['evidenceRoot']) / plan['recoveryId'] / 'data' / 'product.sqlite'
    result['authorityMirror'] = align_authority_mirror(Path(plan['stateRoot']) / 'authority.json', recovery_database, plan['deploymentId'], plan['evidenceRoot'], plan['uid'], plan['gid'], suffix)
    result['sidecars'] = [name for name in ('-wal', '-shm') if os.path.lexists(plan['database'] + name)]
    return result


def homepage_target(config_path):
    configuration = json.loads(Path(config_path).read_text())
    http = configuration['http']
    return {'url': 'http://' + http['listenHost'] + ':' + str(http['listenPort']) + '/', 'host': urllib.parse.urlsplit(configuration['publicOrigin']).netloc}


def homepage_status(target):
    try:
        with urllib.request.urlopen(urllib.request.Request(target['url'], headers={'Host': target['host']}), timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError):
        return None


def wait_for_homepage(target, timeout_seconds=180, interval_seconds=2):
    deadline = time.monotonic() + timeout_seconds
    while True:
        status = homepage_status(target)
        if status == 200:
            return status
        if time.monotonic() > deadline:
            fail('ROLLBACK_HOMEPAGE_NOT_READY:' + str(status))
        time.sleep(interval_seconds)


def start(plan, settle_seconds=20, homepage_timeout_seconds=180):
    before = service(plan['unit'])
    if not stopped(before):
        fail('ROLLBACK_SERVICE_NOT_STOPPED_BEFORE_START')
    subprocess.run(['/usr/bin/systemctl', 'start', plan['unit']], check=True, timeout=300, env=SYSTEM_ENV)
    deadline = time.monotonic() + 120
    while service(plan['unit']).get('SubState') != 'running':
        if time.monotonic() > deadline:
            fail('ROLLBACK_SERVICE_DID_NOT_START')
        time.sleep(1)
    first = service(plan['unit'])
    target = homepage_target(plan['config'])
    wait_for_homepage(target, homepage_timeout_seconds)
    time.sleep(settle_seconds)
    settled = service(plan['unit'])
    if settled.get('SubState') != 'running' or settled.get('MainPID') != first.get('MainPID') or settled.get('NRestarts') != first.get('NRestarts'):
        fail('ROLLBACK_SERVICE_NOT_STABLE')
    homepage = homepage_status(target)
    if homepage != 200:
        fail('ROLLBACK_HOMEPAGE_NOT_STABLE:' + str(homepage))
    return {'serviceBefore': before, 'serviceAfter': settled, 'homepage': {**target, 'status': homepage}}


def fallback(plan, start_release=None):
    state = service(plan['unit'])
    if state.get('SubState') == 'running':
        return {'serviceBefore': state, 'started': False}
    if sha(Path(plan['unitPath']).read_bytes()) != plan['oldUnitSha256']:
        fail('ROLLBACK_FALLBACK_UNIT_NOT_OLD')
    if state.get('ActiveState') == 'failed':
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', plan['unit']], check=True, timeout=30, env=SYSTEM_ENV)
    return {'serviceBefore': state, 'started': True, **(start_release or start)(plan)}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('prepare', 'start', 'fallback'):
        fail('ROLLBACK_USAGE')
    plan = json.loads(base64.b64decode(sys.argv[2]))
    if os.getuid() != 0 or socket.gethostname() != plan['hostname']:
        fail('ROLLBACK_PRODUCTION_ROOT_REQUIRED')
    result = {'prepare': prepare, 'start': start, 'fallback': fallback}[sys.argv[1]](plan)
    print('ROLLBACK_REMOTE_RESULT ' + json.dumps({'mode': sys.argv[1], 'passed': True, **result}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('ROLLBACK_REMOTE_FAILED ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__ + ': ' + str(error)), file=sys.stderr)
        sys.exit(1)
