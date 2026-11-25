#!/usr/bin/python3
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import socket
import sqlite3
import stat
import subprocess
import sys
import time

OPS = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
EVIDENCE = Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
STATE = Path('/var/lib/himawari/state')
CONFIG = Path('/etc/himawari/config.json')
UNIT = Path('/etc/systemd/system/himawari-prod.service')
OLD_PREFIX = Path('__PKT_OLD_PREFIX__')
NODE = Path('/opt/himawari/node/bin/node')
SNAPSHOT = STATE / 'deployment/capability-deployment.json'
ATTESTATION = STATE / 'deployment/startup-attestation.json'
OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'
UNRESOLVED_QUERY = "SELECT count(*) FROM sandbox_execution_records reservation WHERE json_extract(reservation.plan_json,'$.backendRef')='srt' AND reservation.preparation_state='reserved' AND reservation.started_at IS NULL AND NOT EXISTS (SELECT 1 FROM sandbox_reservation_release_receipts released WHERE released.job_id=reservation.job_id AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id AND json_extract(released.verification_json,'$.stopRequestedAt')=reservation.reservation_stopped_at) AND NOT EXISTS (SELECT 1 FROM sandbox_release_receipts released WHERE released.job_id=reservation.job_id AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id)"


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def safe_path(filename, uid=0, mode=None):
    filename = Path(filename)
    info = filename.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and not info.st_mode & 0o022 and filename.resolve(strict=True) == filename, '__PKT_LABEL_UPPER___S9_FILE_UNSAFE')
    require(mode is None or stat.S_IMODE(info.st_mode) == mode, '__PKT_LABEL_UPPER___S9_FILE_MODE_CHANGED')
    return filename


def safe_file(filename, uid=0, mode=None):
    return safe_path(filename, uid, mode).read_bytes()


def load(filename, uid=0, mode=None):
    return json.loads(safe_file(filename, uid, mode))


def validate_restore_proof(action, binding, approval, approval_sha, restored):
    schema = __PKT_CURRENT_SCHEMA__
    prefix = OLD_PREFIX
    recovery_id = binding['maintenance']['recovery__PKT_CURRENT_SCHEMA__Id']
    require(binding['maintenance']['recoveryMethod'] == 'stopped-raw-copy-v1', '__PKT_LABEL_UPPER___S9_RECOVERY_METHOD_CHANGED')
    require(action == 'S9_RAW_RESTORE51' and approval['schemaVersion'] == 'himawari.__PKT_LABEL__-change-rollback-approval.v1' and approval['action'] == action, '__PKT_LABEL_UPPER___S9_EXPLICIT_ROUTE_REQUIRED')
    require(approval['recoveryId'] == recovery_id and re.fullmatch('sha256:[a-f0-9]{64}', approval['recoveryDigest']) and approval['targetStateRoot'] == str(STATE) and approval['targetPrefix'] == str(prefix), '__PKT_LABEL_UPPER___S9_APPROVED_TARGET_CHANGED')
    require(all(approval.get(key) is True for key in ('discardsPostRecoveryPointHistory', 'discardsCapabilityUpgrade', 'requiresIndependentAccountRecovery', 'controlFilesApproved')), '__PKT_LABEL_UPPER___S9_ROLLBACK_EFFECTS_NOT_APPROVED')
    require(isinstance(approval['approvalRef'], str) and approval['approvalRef'] and not approval['approvalRef'].startswith(('PENDING:', 'S0_DB:', 'EXECUTION_OUTPUT:')), '__PKT_LABEL_UPPER___S9_CONCRETE_APPROVAL_REQUIRED')
    require(restored['schemaVersion'] == 'himawari.__PKT_LABEL__-change-maintenance.v1' and restored['action'] == action and restored['passed'] is True and restored['approvalSha256'] == approval_sha and restored['approvalRef'] == approval['approvalRef'], '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_PROOF_CHANGED')
    result = restored['restoredResult']
    require(result['recoveryId'] == recovery_id and result['digest'] == approval['recoveryDigest'] and result['schemaVersion'] == str(schema), '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_ROUTE_CHANGED')
    preserved = restored['preservedCurrent']
    require(preserved['method'] == 'stopped-raw-copy-v1' and preserved['recoveryId'] == approval['preservedCurrentRecoveryId'] and preserved['recoveryId'] != recovery_id and preserved['schema'] in (__PKT_CURRENT_SCHEMA__, __PKT_TARGET_SCHEMA__), '__PKT_LABEL_UPPER___S9_CURRENT_STATE_NOT_PRESERVED')
    for proof in (result, preserved['verifiedResult']):
        require(proof['method'] == 'stopped-raw-copy-v1' and proof['fullIntegrityCheck'] == 'ok' and proof['foreignKeys'] == 'ok', '__PKT_LABEL_UPPER___S9_BACKUP_INTEGRITY_UNVERIFIED')
        for key in ('deploymentId', 'ownerId', 'agentId'):
            require(proof[key] == binding['identity'][key], '__PKT_LABEL_UPPER___S9_BACKUP_IDENTITY_CHANGED')
    require(preserved['verifiedResult']['recoveryId'] == preserved['recoveryId'] and preserved['verifiedResult']['schemaVersion'] == str(preserved['schema']) and re.fullmatch('sha256:[a-f0-9]{64}', preserved['verifiedResult']['digest']), '__PKT_LABEL_UPPER___S9_CURRENT_BACKUP_PROOF_CHANGED')
    require(restored['accountRecoveryRequired'] is True and restored['serviceStartAuthorized'] is False, '__PKT_LABEL_UPPER___S9_ACCOUNT_RECOVERY_BOUNDARY_CHANGED')
    return schema


def workspace_plan(binding):
    expected = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
    actual = binding.get('workspace')
    require(isinstance(actual, dict) and actual == expected, '__PKT_LABEL_UPPER___S9_WORKSPACE_PLAN_CHANGED')
    return expected


def old_unit_sha(binding):
    value = binding['service']['oldUnitSha256']
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None and binding['service']['oldConfigSha256'] == OLD_CONFIG_SHA, '__PKT_LABEL_UPPER___S9_ORIGINAL_SERVICE_BINDING_CHANGED')
    return value


def validate_restored_catalog(binding, frozen_authorization, grant_row, capability_rows, first_tools=False, registered_count=None):
    plan = workspace_plan(binding)
    grants = [grant for grant in frozen_authorization.get('directoryGrants', []) if grant.get('routeKey') == plan['routeKey']]
    require(len(grants) == 1 and grants[0].get('grantId') == plan['grantId'] and type(grants[0].get('stateRevision')) is int and grants[0]['stateRevision'] > 0 and re.fullmatch('[a-f0-9]{64}', grants[0].get('metadataSha256', '')) is not None, '__PKT_LABEL_UPPER___S9_FROZEN_GRANT_INVALID')
    require(isinstance(grant_row, dict) and type(grant_row.get('revision')) is int and grant_row['revision'] == grants[0]['stateRevision'] and isinstance(grant_row.get('value_json'), str) and sha(grant_row['value_json'].encode()) == grants[0]['metadataSha256'], '__PKT_LABEL_UPPER___S9_RESTORED_GRANT_CHANGED')
    capabilities = frozen_authorization.get('capabilities')
    if first_tools:
        require(capabilities == [] and capability_rows == {} and registered_count == 0, '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0')
        return {'capabilityUpgradeDiscarded': True, 'grantRecordUnchanged': True, 'accountRecoveryRequired': True, 'serviceStartAuthorized': False}
    require(isinstance(capabilities, list) and len(capabilities) > 0 and len({capability.get('capabilityRef') for capability in capabilities}) == len(capabilities) and all(re.fullmatch('[a-f0-9]{64}', capability.get('registryRecordSha256', '')) is not None and type(capability.get('revision')) is int for capability in capabilities), '__PKT_LABEL_UPPER___S9_FROZEN_CATALOG_INVALID')
    require(isinstance(capability_rows, dict) and sorted(capability_rows) == sorted(capability['capabilityRef'] for capability in capabilities), '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0')
    for capability in capabilities:
        row = capability_rows[capability['capabilityRef']]
        require(isinstance(row, dict) and row.get('id') == capability['capabilityRef'] and row.get('version') == capability['version'] and row.get('status') == capability['status'] and row.get('revision') == capability['revision'] and row.get('integrity') == capability['storedIntegrity'] and isinstance(row.get('record_json'), str) and sha(row['record_json'].encode()) == capability['registryRecordSha256'], '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0')
    return {'capabilityUpgradeDiscarded': True, 'grantRecordUnchanged': True, 'accountRecoveryRequired': True, 'serviceStartAuthorized': False}


def first_tools_restore(frozen_authorization):
    original = safe_file(EVIDENCE / 'original-config.json', __PKT_SERVICE_UID__, 0o600)
    require(sha(original) == OLD_CONFIG_SHA, '__PKT_LABEL_UPPER___S9_ORIGINAL_CONTROL_BYTES_CHANGED')
    first = 'capabilityDeployment' not in json.loads(original)
    require(first == (len(frozen_authorization.get('capabilities', [])) == 0), '__PKT_LABEL_UPPER___S9_FIRST_TOOLS_STATE_INCONSISTENT')
    return first


def control_files(first_tools):
    entries = [(CONFIG, 'config.json', __PKT_SERVICE_UID__), (UNIT, 'unit.service', 0), (SNAPSHOT, 'capability-deployment.json', __PKT_SERVICE_UID__), (ATTESTATION, 'startup-attestation.json', __PKT_SERVICE_UID__)]
    return [entry for entry in entries if not first_tools or os.path.lexists(entry[0])]


def remove_exact(filename, uid):
    safe_file(filename, uid)
    os.unlink(filename)
    directory_fd = os.open(filename.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    require(not os.path.lexists(filename), '__PKT_LABEL_UPPER___S9_REMOVED_FILE_REMAINS')


def retain(name, data, uid=0, mode=0o600):
    filename = EVIDENCE / name
    with filename.open('xb') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), uid, __PKT_SERVICE_GID__)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    require(safe_file(filename, uid, mode) == data, '__PKT_LABEL_UPPER___S9_RETAINED_BYTES_CHANGED')
    return {'path': str(filename), 'sha256': sha(data), 'bytes': len(data), 'uid': uid, 'mode': format(mode, '04o')}


def retain_json(name, value):
    return retain(name, (json.dumps(value, indent=2) + '\n').encode(), mode=0o640)


def command(argv, label, report, service_actor=False):
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'SYSTEMD_PAGER': 'cat'}
    if service_actor:
        argv = ['/usr/bin/setpriv', '--reuid=__PKT_SERVICE_UID__', '--regid=__PKT_SERVICE_GID__', '--init-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '/usr/bin/env', '-i', 'HOME=' + str(STATE), 'PATH=/opt/himawari/node/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'HIMAWARI_RUNTIME_PROTECTION_FILE=' + str(OPS / 'runtime-protection.json'), *argv]
    result = subprocess.run(list(map(str, argv)), stdin=subprocess.DEVNULL, capture_output=True, env=environment, cwd='/', timeout=180, preexec_fn=lambda: os.umask(0o022 if service_actor else 0o077))
    report['commands'].append({'command': list(map(str, argv)), 'exitCode': result.returncode, 'stdout': retain(label + '.stdout', result.stdout), 'stderr': retain(label + '.stderr', result.stderr)})
    require(result.returncode == 0, '__PKT_LABEL_UPPER___S9_COMMAND_FAILED')
    return result.stdout


def service():
    output = subprocess.check_output(['/usr/bin/systemctl', 'show', 'himawari-prod.service', '--no-pager', '--property=ActiveState,MainPID,FragmentPath,User,Group,UMask,NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities,ExecStartPre,ExecStart,Environment'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, text=True, timeout=15)
    result = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    require(result['ActiveState'] == 'inactive' and result['MainPID'] == '0' and result['FragmentPath'] == str(UNIT), '__PKT_LABEL_UPPER___S9_SERVICE_NOT_STOPPED')
    require(result['User'] == 'himawari-prod' and result['Group'] == 'himawari-prod' and result['UMask'] == '0022' and result['NoNewPrivileges'] == 'yes' and result['CapabilityBoundingSet'] == '' and result['AmbientCapabilities'] == '', '__PKT_LABEL_UPPER___S9_SERVICE_BOUNDARY_CHANGED')
    return result


def stopped_proof(proof):
    require(proof.get('passed') is True and proof.get('serviceStopped') is True, '__PKT_LABEL_UPPER___S9_STOP_PROOF_FAILED')
    report_path = Path(proof['report']['path'])
    require(report_path.parent == EVIDENCE and report_path.name.startswith('s2-inspection-'), '__PKT_LABEL_UPPER___S9_STOP_PROOF_PATH_CHANGED')
    report_bytes = safe_file(report_path, 0, 0o640)
    require(sha(report_bytes) == proof['report']['sha256'], '__PKT_LABEL_UPPER___S9_STOP_PROOF_CHANGED')
    report = json.loads(report_bytes)
    require(report['mode'] == 'inspect-only' and report['passed'] is True and report['processesAbsent']['confirmed'] is True and report['serviceAfter']['ActiveState'] == 'inactive' and report['serviceAfter']['MainPID'] == '0', '__PKT_LABEL_UPPER___S9_PROCESSES_NOT_ABSENT')
    return {'inspection': proof['report'], 'processesAbsent': True}


def read_data_members(directory, uid):
    directory = Path(directory)
    before_root = directory.lstat()
    require(directory.resolve(strict=True) == directory and stat.S_ISDIR(before_root.st_mode) and before_root.st_uid == uid and not before_root.st_mode & 0o022, '__PKT_LABEL_UPPER___S9_DATA_ROOT_UNSAFE')
    require(not os.path.lexists(directory / 'product.sqlite-wal') and not os.path.lexists(directory / 'product.sqlite-shm'), '__PKT_LABEL_UPPER___S9_DATABASE_SIDECAR_PRESENT')
    result = []
    def visit(relative):
        filename = directory / relative
        before = filename.lstat()
        require(filename.resolve(strict=True) == filename and before.st_uid == uid and not before.st_mode & 0o022, '__PKT_LABEL_UPPER___S9_DATA_MEMBER_UNSAFE')
        require(before.st_dev == before_root.st_dev, '__PKT_LABEL_UPPER___S9_DATA_FILESYSTEM_ESCAPE')
        if stat.S_ISDIR(before.st_mode):
            result.append({'path': relative, 'kind': 'directory'})
            names = sorted(entry.name for entry in filename.iterdir())
            for name in names:
                visit(relative + '/' + name)
            require(sorted(entry.name for entry in filename.iterdir()) == names, '__PKT_LABEL_UPPER___S9_DATA_DIRECTORY_CHANGED')
        else:
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, '__PKT_LABEL_UPPER___S9_DATA_MEMBER_UNSAFE')
            descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                require(os.fstat(descriptor) == before, '__PKT_LABEL_UPPER___S9_DATA_MEMBER_CHANGED')
                digest = hashlib.sha256()
                count = 0
                while True:
                    data = os.read(descriptor, 65536)
                    if not data:
                        break
                    count += len(data)
                    digest.update(data)
                after_descriptor = os.fstat(descriptor)
                require((after_descriptor.st_dev, after_descriptor.st_ino, after_descriptor.st_size, after_descriptor.st_mtime_ns, after_descriptor.st_ctime_ns) == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) and count == before.st_size, '__PKT_LABEL_UPPER___S9_DATA_MEMBER_CHANGED')
            finally:
                os.close(descriptor)
            result.append({'path': relative, 'kind': 'file', 'bytes': count, 'sha256': digest.hexdigest()})
        after = filename.lstat()
        require((after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns), '__PKT_LABEL_UPPER___S9_DATA_MEMBER_CHANGED')
    visit('product.sqlite')
    visit('payload-ciphertext')
    after_root = directory.lstat()
    require((after_root.st_dev, after_root.st_ino, after_root.st_mtime_ns, after_root.st_ctime_ns) == (before_root.st_dev, before_root.st_ino, before_root.st_mtime_ns, before_root.st_ctime_ns), '__PKT_LABEL_UPPER___S9_DATA_ROOT_CHANGED')
    return sorted(result, key=lambda item: item['path'])


def independent_data_tree(binding, restored):
    result = restored['restoredResult']
    recovery_id = result['recoveryId']
    point = EVIDENCE / recovery_id
    require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', recovery_id) and result['pointPath'] == str(point) and result['manifest']['path'] == str(point / 'manifest.json'), '__PKT_LABEL_UPPER___S9_RECOVERY_POINT_PATH_CHANGED')
    info = point.lstat()
    require(point.resolve(strict=True) == point and stat.S_ISDIR(info.st_mode) and info.st_uid == __PKT_SERVICE_UID__ and stat.S_IMODE(info.st_mode) == 0o700 and sorted(entry.name for entry in point.iterdir()) == ['data', 'manifest.json'], '__PKT_LABEL_UPPER___S9_RECOVERY_POINT_UNSAFE')
    manifest_bytes = safe_file(point / 'manifest.json', __PKT_SERVICE_UID__, 0o600)
    digest = sha(manifest_bytes)
    require(result['digest'] == 'sha256:' + digest and result['manifest']['sha256'] == digest and result['manifest']['bytes'] == len(manifest_bytes), '__PKT_LABEL_UPPER___S9_RECOVERY_MANIFEST_CHANGED')
    manifest = json.loads(manifest_bytes)
    require(manifest['schemaVersion'] == 'himawari.stopped-raw-copy.v1' and manifest['method'] == binding['maintenance']['recoveryMethod'] and manifest['recoveryId'] == recovery_id and manifest['schema'] == int(result['schemaVersion']) and manifest['identity'] == {key: binding['identity'][key] for key in ('ownerId', 'agentId', 'deploymentId')}, '__PKT_LABEL_UPPER___S9_RECOVERY_MANIFEST_BINDING_CHANGED')
    copied = read_data_members(point / 'data', __PKT_SERVICE_UID__)
    current = read_data_members(STATE / 'data', __PKT_SERVICE_UID__)
    require(copied == manifest['members'] and current == copied and restored['restoredDataReadback']['members'] == current, '__PKT_LABEL_UPPER___S9_WHOLE_DATA_TREE_CHANGED')
    require(manifest['sourceDatabaseBeforeSha256'] == manifest['sourceDatabaseAfterSha256'] == next(item['sha256'] for item in current if item['path'] == 'product.sqlite'), '__PKT_LABEL_UPPER___S9_DATABASE_BYTES_CHANGED')
    return {'manifestSha256': digest, 'fileCount': sum(item['kind'] == 'file' for item in current), 'payloadCount': sum(item['kind'] == 'file' and item['path'].startswith('payload-ciphertext/') for item in current), 'wholeTreeBytesAndDigestsMatch': True}


def independent_database(binding, schema, restored):
    after_path = EVIDENCE / (restored['action'].lower() + '-after.json')
    require(restored['after']['path'] == str(after_path), '__PKT_LABEL_UPPER___S9_AFTER_PATH_CHANGED')
    after_bytes = safe_file(after_path, __PKT_SERVICE_UID__, 0o600)
    require(sha(after_bytes) == restored['after']['sha256'], '__PKT_LABEL_UPPER___S9_AFTER_READBACK_CHANGED')
    after = json.loads(after_bytes)
    plan = workspace_plan(binding)
    s0_bytes = safe_file(OPS / 'inputs/s0-db-readback.json')
    require(sha(s0_bytes) == binding['inputReadbacks']['inputs/s0-db-readback.json'], '__PKT_LABEL_UPPER___S9_S0_AUTHORIZATION_CHANGED')
    frozen_authorization = json.loads(s0_bytes)['authorization']
    first_tools = first_tools_restore(frozen_authorization)
    safe_path(STATE / 'data/product.sqlite', __PKT_SERVICE_UID__, 0o600)
    tree_proof = independent_data_tree(binding, restored)
    db = sqlite3.connect('file:' + str(STATE / 'data/product.sqlite') + '?mode=ro&immutable=1', uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        current = int(db.execute("SELECT value FROM schema_metadata WHERE key='current_sequence'").fetchone()[0])
        minimum = int(db.execute("SELECT value FROM schema_metadata WHERE key='minimum_writer_sequence'").fetchone()[0])
        require(current == schema and minimum == schema, '__PKT_LABEL_UPPER___S9_INDEPENDENT_SCHEMA_CHANGED')
        ledger = db.execute('SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence').fetchall()
        require([row[0] for row in ledger] == list(range(1, schema + 1)) and [list(row) for row in ledger] == [[row[key] for key in ('sequence', 'name', 'phase', 'digest', 'applied_at')] for row in after['ledger']], '__PKT_LABEL_UPPER___S9_INDEPENDENT_LEDGER_CHANGED')
        require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)] and db.execute('PRAGMA foreign_key_check').fetchall() == [], '__PKT_LABEL_UPPER___S9_INDEPENDENT_DATABASE_INTEGRITY_FAILED')
        identity = binding['identity']
        unresolved = db.execute(UNRESOLVED_QUERY).fetchone()[0]
        require(unresolved == 0, '__PKT_LABEL_UPPER___S9_RESTORED_UNRESOLVED_RESERVATION')
        grant_rows = db.execute('SELECT revision,value_json FROM product_state_records WHERE key=? AND owner_id=? AND agent_id=?', ['host-workspace:directory-grant:' + plan['grantId'], identity['ownerId'], identity['agentId']]).fetchall()
        require(len(grant_rows) == 1, '__PKT_LABEL_UPPER___S9_RESTORED_GRANT_CHANGED')
        capability_rows = {}
        for capability in frozen_authorization['capabilities']:
            for row in db.execute('SELECT id,version,status,revision,integrity,record_json FROM capability_declarations WHERE id=? AND owner_id=? AND agent_id=?', [capability['capabilityRef'], identity['ownerId'], identity['agentId']]).fetchall():
                require(row[0] not in capability_rows, '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0')
                capability_rows[row[0]] = dict(zip(('id', 'version', 'status', 'revision', 'integrity', 'record_json'), row))
        registered_count = db.execute('SELECT count(*) FROM capability_declarations WHERE owner_id=? AND agent_id=?', [identity['ownerId'], identity['agentId']]).fetchone()[0]
        grant_boundary = validate_restored_catalog(binding, frozen_authorization, dict(zip(('revision', 'value_json'), grant_rows[0])), capability_rows, first_tools, registered_count)
        db.execute('COMMIT')
        mirror = load(STATE / 'authority.json', __PKT_SERVICE_UID__, 0o600)
        authority_rows = db.execute('SELECT id,owner_id,agent_id,revision,status,authority_epoch,fencing_token,transfer_id FROM deployments WHERE id=?', [identity['deploymentId']]).fetchall()
        require(len(authority_rows) == 1 and all(mirror.get(key) == value for key, value in zip(('id', 'ownerId', 'agentId', 'revision', 'status', 'authorityEpoch', 'fencingToken', 'transferId'), authority_rows[0])), '__PKT_LABEL_UPPER___S9_RESTORED_AUTHORITY_MIRROR_INCOMPATIBLE')
        require(independent_data_tree(binding, restored) == tree_proof, '__PKT_LABEL_UPPER___S9_DATA_TREE_CHANGED_DURING_READBACK')
        return {'dataTree': tree_proof, 'authorityMirrorCompatible': True, 'schema': current, 'minimumWriter': minimum, 'ledgerCount': len(ledger), 'integrity': 'ok', 'foreignKeys': 'ok', 'unresolvedReservedCount': 0, **grant_boundary}
    finally:
        db.close()


def replace_exact(filename, data, uid, mode, suffix):
    safe_file(filename, uid)
    next_file = filename.with_name(filename.name + '.s9-next-' + suffix)
    require(not os.path.lexists(next_file), '__PKT_LABEL_UPPER___S9_ATOMIC_DESTINATION_EXISTS')
    with next_file.open('xb') as output:
        os.fchmod(output.fileno(), mode)
        os.fchown(output.fileno(), uid, __PKT_SERVICE_GID__ if uid == __PKT_SERVICE_UID__ else 0)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.replace(next_file, filename)
    directory_fd = os.open(filename.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    require(safe_file(filename, uid, mode) == data, '__PKT_LABEL_UPPER___S9_REPLACED_BYTES_CHANGED')


def clear_prepare_leftovers(suffix):
    cleared = []
    for filename in (CONFIG.with_name(CONFIG.name + '.next'), SNAPSHOT.with_name(SNAPSHOT.name + '.next')):
        if not os.path.lexists(filename):
            continue
        entry = retain('s9-control-leftover-' + suffix + '-' + filename.name, safe_file(filename, __PKT_SERVICE_UID__, 0o600), __PKT_SERVICE_UID__)
        os.unlink(filename)
        directory_fd = os.open(filename.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        require(not os.path.lexists(filename), '__PKT_LABEL_UPPER___S9_PREPARE_LEFTOVER_REMAINS')
        cleared.append({'path': str(filename), 'retained': entry})
    return cleared


def main():
    require(len(sys.argv) == 2 and sys.argv[1] == 'S9_RAW_RESTORE51' and sys.executable == '/usr/bin/python3' and sys.flags.isolated == 1 and sys.platform == 'linux' and os.geteuid() == 0 and socket.gethostname() == '__PKT_HOSTNAME__', '__PKT_LABEL_UPPER___S9_EXPLICIT_ROOT_TARGET_REQUIRED')
    require(Path(__file__).resolve() == OPS / 'maintenance/S9-control-files.py', '__PKT_LABEL_UPPER___S9_EXECUTION_PATH_CHANGED')
    account = pwd.getpwnam('himawari-prod')
    require((account.pw_uid, account.pw_gid) == (__PKT_SERVICE_UID__, __PKT_SERVICE_GID__), '__PKT_LABEL_UPPER___S9_SERVICE_ACCOUNT_CHANGED')
    info = EVIDENCE.lstat()
    require(stat.S_ISDIR(info.st_mode) and EVIDENCE.resolve() == EVIDENCE and info.st_uid == __PKT_SERVICE_UID__ and info.st_gid == __PKT_SERVICE_GID__ and stat.S_IMODE(info.st_mode) == 0o700, '__PKT_LABEL_UPPER___S9_EVIDENCE_UNSAFE')
    suffix = str(time.time_ns())
    action = sys.argv[1]
    report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-control-restore.v1', 'action': action, 'startedAt': utc(), 'passed': False, 'commands': [], 'serviceStartAuthorized': False, 'accountRecoveryRequired': True}
    retain_json('s9-control-started-' + suffix + '.json', report)
    try:
        require(sha(safe_file(NODE)) == '__PKT_NODE_SHA256__', '__PKT_LABEL_UPPER___S9_NODE_CHANGED')
        for line in safe_file(OPS / 'maintenance/OWNED-SHA256SUMS').decode().splitlines():
            expected, relative = line.split('  ', 1)
            require(re.fullmatch('[a-f0-9]{64}', expected) and not Path(relative).is_absolute() and '..' not in Path(relative).parts and sha(safe_file(OPS / relative)) == expected, '__PKT_LABEL_UPPER___S9_APPROVED_HELPER_CHANGED')
        binding = load(OPS / 'inputs/bindings.json')
        require(binding['status'] == 'frozen-approved' and binding['approvals']['packageRef'], '__PKT_LABEL_UPPER___S9_FROZEN_BINDING_REQUIRED')
        approval_bytes = safe_file(EVIDENCE / 'rollback-approval.json', 0, 0o640)
        require((EVIDENCE / 'rollback-approval.json').stat().st_gid == __PKT_SERVICE_GID__, '__PKT_LABEL_UPPER___S9_APPROVAL_GID_CHANGED')
        approval = json.loads(approval_bytes)
        restored = load(EVIDENCE / (action.lower() + '-result.json'), __PKT_SERVICE_UID__, 0o600)
        schema = validate_restore_proof(action, binding, approval, sha(approval_bytes), restored)
        report['approvalSha256'] = sha(approval_bytes)
        report['databaseProof'] = independent_database(binding, schema, restored)
        original_unit_sha = old_unit_sha(binding)
        require(sha(safe_file(UNIT)) in (original_unit_sha, binding['service']['newUnitSha256']), '__PKT_LABEL_UPPER___S9_CURRENT_UNIT_UNKNOWN')
        report['serviceBefore'] = service()
        proof = json.loads(command(['/usr/bin/python3', '-I', OPS / 'systemd/S2-stop-and-inspect.py', '--inspect-only'], 's9-control-site-' + suffix, report))
        report['stopProof'] = stopped_proof(proof)
        original = load(EVIDENCE / 's2-stop-result.json', 0, 0o640)
        require(original['passed'] is True, '__PKT_LABEL_UPPER___S9_ORIGINAL_S2_PROOF_REQUIRED')
        preserved = {entry['source']: entry for entry in original['preserved']}
        for entry in original['preserved'] + original['preservedQualification']:
            data = safe_file(entry['path'], entry.get('ownerUid', 0), 0o600)
            require(sha(data) == entry['sha256'], '__PKT_LABEL_UPPER___S9_ORIGINAL_BACKUP_CHANGED')
        for filename in (Path('__PKT_OLD_OPERATIONS__/runtime-protection.json'), Path('__PKT_OLD_OPERATIONS__/cloud-protected-prepare.mjs'), Path('__PKT_OLD_OPERATIONS__/pair-supervisor.mjs')):
            require(sha(safe_file(filename)) == preserved[str(filename)]['sha256'], '__PKT_LABEL_UPPER___S9_SECOND_ROOT_PROTECTION_CHANGED')
        for entry in original['preservedQualification']:
            require(sha(safe_file(entry['source'])) == entry['sha256'], '__PKT_LABEL_UPPER___S9_SECOND_QUALIFICATION_CHANGED')
        original_config = safe_file(EVIDENCE / 'original-config.json', __PKT_SERVICE_UID__, 0o600)
        original_unit = safe_file(EVIDENCE / 'original-unit.service', 0, 0o600)
        require(sha(original_config) == OLD_CONFIG_SHA and sha(original_unit) == original_unit_sha, '__PKT_LABEL_UPPER___S9_ORIGINAL_CONTROL_BYTES_CHANGED')
        require(json.loads(original_config).get('runPolicy', {}).get('coding', {}).get('grantId') == workspace_plan(binding)['grantId'], '__PKT_LABEL_UPPER___S9_ORIGINAL_GRANT_CHANGED')
        first_tools = first_tools_restore(json.loads(safe_file(OPS / 'inputs/s0-db-readback.json'))['authorization'])
        report['preservedCurrentControlFiles'] = [retain('s9-control-current-' + suffix + '-' + name, safe_file(filename, uid), uid) for filename, name, uid in control_files(first_tools)]
        retain_json('s9-control-before-change-' + suffix + '.json', report)
        service()
        if first_tools:
            for filename in (SNAPSHOT, ATTESTATION):
                if os.path.lexists(filename):
                    remove_exact(filename, __PKT_SERVICE_UID__)
        else:
            snapshot_bytes = safe_file(EVIDENCE / 'original-capability-deployment.json', __PKT_SERVICE_UID__, 0o600)
            require(json.loads(original_config)['capabilityDeployment'] == {'snapshotPath': str(SNAPSHOT), 'sha256': 'sha256:' + sha(snapshot_bytes)}, '__PKT_LABEL_UPPER___S9_SECOND_SNAPSHOT_BINDING_CHANGED')
            replace_exact(SNAPSHOT, snapshot_bytes, __PKT_SERVICE_UID__, 0o600, suffix)
            replace_exact(ATTESTATION, safe_file(EVIDENCE / 'original-startup-attestation.json', __PKT_SERVICE_UID__, 0o600), __PKT_SERVICE_UID__, 0o600, suffix)
        replace_exact(CONFIG, original_config, __PKT_SERVICE_UID__, 0o600, suffix)
        replace_exact(UNIT, original_unit, 0, 0o644, suffix)
        report['clearedPrepareLeftovers'] = clear_prepare_leftovers(suffix)
        report['targetPrefix'] = str(OLD_PREFIX)
        command(['/usr/bin/systemctl', 'daemon-reload'], 's9-control-daemon-reload-' + suffix, report)
        after_service = service()
        require(report['targetPrefix'] in after_service['ExecStart'] and str(CONFIG) in after_service['ExecStart'], '__PKT_LABEL_UPPER___S9_RELOADED_PREFIX_CHANGED')
        expected_helper = '__PKT_OLD_OPERATIONS__/cloud-protected-prepare.mjs'
        require(expected_helper in after_service['ExecStartPre'], '__PKT_LABEL_UPPER___S9_RELOADED_PREPARE_CHANGED')
        expected_protection = '__PKT_OLD_OPERATIONS__/runtime-protection.json'
        require('HIMAWARI_RUNTIME_PROTECTION_FILE=' + expected_protection in after_service['Environment'], '__PKT_LABEL_UPPER___S9_RELOADED_PROTECTION_CHANGED')
        report['serviceAfter'] = after_service
        report['databaseAfterControlRestore'] = independent_database(binding, schema, restored)
        report['capabilityUpgradeDiscarded'] = report['databaseAfterControlRestore']['capabilityUpgradeDiscarded']
        report['grantRecordUnchanged'] = report['databaseAfterControlRestore']['grantRecordUnchanged']
        require(not first_tools or not any(os.path.lexists(filename) for filename in (SNAPSHOT, ATTESTATION)), '__PKT_LABEL_UPPER___S9_REMOVED_FILE_REMAINS')
        report['controlReadback'] = [{'path': str(filename), 'sha256': sha(safe_file(filename, uid))} for filename, name, uid in control_files(False) if not first_tools or filename in (CONFIG, UNIT)]
        report['passed'] = True
        report['finishedAt'] = utc()
        retained = retain_json('s9-control-result-' + suffix + '.json', report)
        print(json.dumps({'passed': True, 'action': action, 'report': retained, 'serviceStopped': True, 'capabilityUpgradeDiscarded': True, 'grantRecordUnchanged': True, 'serviceStartAuthorized': False, 'accountRecoveryRequired': True}))
        return 0
    except Exception as error:
        report['finishedAt'] = utc()
        text = str(error)
        report['failureCode'] = text if re.fullmatch('__PKT_LABEL_UPPER___S9_[A-Z_]+', text) else '__PKT_LABEL_UPPER___S9_UNEXPECTED_FAILURE'
        retained = retain_json('s9-control-failure-' + suffix + '.json', report)
        print(json.dumps({'passed': False, 'report': retained, 'automaticRollbackOrStart': False}))
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    os.umask(0o077)
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({'passed': False, 'failureCode': str(error), 'automaticRollbackOrStart': False}))
        raise SystemExit(1)
