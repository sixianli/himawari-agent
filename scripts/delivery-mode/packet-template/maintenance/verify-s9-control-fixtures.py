import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True

source_path = Path(__file__).with_name('S9-control-files.py')
spec = importlib.util.spec_from_file_location('__PKT_LABEL___s9_control', source_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source_bytes = source_path.read_bytes()
plan = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
fourth_plan = {'decisionRef': 'G90', 'routeKey': 'coding', 'oldGrantId': 'directory:himawari-prod-workspace-20261012', 'oldCanonicalPath': '/var/lib/himawari/qualification-workspace', 'newGrantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos'], 'durationDays': 90}
binding = {'identity': {'deploymentId': 'deployment:one', 'ownerId': 'owner:one', 'agentId': 'agent:one', 'hostId': 'host:one'}, 'maintenance': {'recoveryMethod': 'stopped-raw-copy-v1', 'recovery__PKT_CURRENT_SCHEMA__Id': 'raw51'}, 'workspace': plan, 'service': {'oldUnitSha256': 'e' * 64, 'oldConfigSha256': module.OLD_CONFIG_SHA}}
approval = {'schemaVersion': 'himawari.__PKT_LABEL__-change-rollback-approval.v1', 'action': 'S9_RAW_RESTORE51', 'recoveryId': 'raw51', 'recoveryDigest': 'sha256:' + '1' * 64, 'targetStateRoot': str(module.STATE), 'targetPrefix': str(module.OLD_PREFIX), 'discardsPostRecoveryPointHistory': True, 'discardsCapabilityUpgrade': True, 'requiresIndependentAccountRecovery': True, 'controlFilesApproved': True, 'approvalRef': 'user:approved-specific-rollback', 'preservedCurrentRecoveryId': 'preserved51'}
identity3 = {key: binding['identity'][key] for key in ('deploymentId', 'ownerId', 'agentId')}
report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-maintenance.v1', 'action': 'S9_RAW_RESTORE51', 'passed': True, 'approvalSha256': '2' * 64, 'approvalRef': approval['approvalRef'], 'restoredResult': {'recoveryId': 'raw51', 'digest': approval['recoveryDigest'], 'schemaVersion': '__PKT_CURRENT_SCHEMA__', 'fullIntegrityCheck': 'ok', 'foreignKeys': 'ok', 'method': 'stopped-raw-copy-v1', **identity3}, 'preservedCurrent': {'recoveryId': 'preserved51', 'method': 'stopped-raw-copy-v1', 'schema': __PKT_CURRENT_SCHEMA__, 'verifiedResult': {'recoveryId': 'preserved51', 'digest': 'sha256:' + '3' * 64, 'schemaVersion': '__PKT_CURRENT_SCHEMA__', 'fullIntegrityCheck': 'ok', 'foreignKeys': 'ok', 'method': 'stopped-raw-copy-v1', **identity3}}, 'accountRecoveryRequired': True, 'serviceStartAuthorized': False}
cases = []


def check(name, operation):
    try:
        operation()
        cases.append({'name': name, 'passed': True})
    except Exception as error:
        cases.append({'name': name, 'passed': False, 'error': repr(error)})


def refuses(code, operation):
    def run():
        try:
            operation()
        except RuntimeError as error:
            if str(error) != code:
                raise RuntimeError('UNEXPECTED_CODE:' + str(error) + ' expected ' + code)
            return
        raise RuntimeError('NOT_REJECTED:' + code)
    return run


def equals(expected, operation):
    def run():
        actual = operation()
        if actual != expected:
            raise RuntimeError('UNEXPECTED_RESULT:' + json.dumps(actual, sort_keys=True))
    return run


check('accepts approved schema__PKT_CURRENT_SCHEMA__ restore proof', equals(__PKT_CURRENT_SCHEMA__, lambda: module.validate_restore_proof('S9_RAW_RESTORE51', binding, approval, '2' * 64, report)))
for name, code, mutate in [
    ('schema49 route', '__PKT_LABEL_UPPER___S9_EXPLICIT_ROUTE_REQUIRED', lambda value: value['approval'].update(action='S9_RAW_RESTORE49')),
    ('schema50 route', '__PKT_LABEL_UPPER___S9_EXPLICIT_ROUTE_REQUIRED', lambda value: value['approval'].update(action='S9_RAW_RESTORE50')),
    ('restored schema50', '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_ROUTE_CHANGED', lambda value: value['report']['restoredResult'].update(schemaVersion='50')),
    ('preserved current schema50', '__PKT_LABEL_UPPER___S9_CURRENT_STATE_NOT_PRESERVED', lambda value: value['report']['preservedCurrent'].update(schema=50)),
    ('unfilled approval reference', '__PKT_LABEL_UPPER___S9_CONCRETE_APPROVAL_REQUIRED', lambda value: value['approval'].update(approvalRef='PENDING:decision')),
    ('empty approval reference', '__PKT_LABEL_UPPER___S9_CONCRETE_APPROVAL_REQUIRED', lambda value: value['approval'].update(approvalRef='')),
    ('digest differs from restored point', '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_ROUTE_CHANGED', lambda value: value['approval'].update(recoveryDigest='sha256:' + '4' * 64)),
    ('restore onto new runtime', '__PKT_LABEL_UPPER___S9_APPROVED_TARGET_CHANGED', lambda value: value['approval'].update(targetPrefix='/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__')),
    ('other recovery point', '__PKT_LABEL_UPPER___S9_APPROVED_TARGET_CHANGED', lambda value: value['approval'].update(recoveryId='raw50')),
    ('control files not approved', '__PKT_LABEL_UPPER___S9_ROLLBACK_EFFECTS_NOT_APPROVED', lambda value: value['approval'].update(controlFilesApproved=False)),
    ('capability upgrade loss not acknowledged', '__PKT_LABEL_UPPER___S9_ROLLBACK_EFFECTS_NOT_APPROVED', lambda value: value['approval'].update(discardsCapabilityUpgrade=False)),
    ('fourth approval fields only', '__PKT_LABEL_UPPER___S9_ROLLBACK_EFFECTS_NOT_APPROVED', lambda value: (value['approval'].pop('discardsCapabilityUpgrade'), value['approval'].update(discardsWorkspaceGrant=True))),
    ('history loss not acknowledged', '__PKT_LABEL_UPPER___S9_ROLLBACK_EFFECTS_NOT_APPROVED', lambda value: value['approval'].update(discardsPostRecoveryPointHistory='yes')),
    ('maintenance not passed', '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_PROOF_CHANGED', lambda value: value['report'].update(passed=False)),
    ('approval bytes changed after restore', '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_PROOF_CHANGED', lambda value: value['report'].update(approvalSha256='5' * 64)),
    ('restored schema49', '__PKT_LABEL_UPPER___S9_DATABASE_RESTORE_ROUTE_CHANGED', lambda value: value['report']['restoredResult'].update(schemaVersion='49')),
    ('preserved integrity failed', '__PKT_LABEL_UPPER___S9_BACKUP_INTEGRITY_UNVERIFIED', lambda value: value['report']['preservedCurrent']['verifiedResult'].update(fullIntegrityCheck='failed')),
    ('service start authorized', '__PKT_LABEL_UPPER___S9_ACCOUNT_RECOVERY_BOUNDARY_CHANGED', lambda value: value['report'].update(serviceStartAuthorized=True)),
    ('encrypted backup method', '__PKT_LABEL_UPPER___S9_BACKUP_INTEGRITY_UNVERIFIED', lambda value: value['report']['restoredResult'].update(method='encrypted-backup')),
    ('restored foreign keys failed', '__PKT_LABEL_UPPER___S9_BACKUP_INTEGRITY_UNVERIFIED', lambda value: value['report']['restoredResult'].update(foreignKeys='failed')),
    ('preserved point overwrites restore point', '__PKT_LABEL_UPPER___S9_CURRENT_STATE_NOT_PRESERVED', lambda value: (value['report']['preservedCurrent'].update(recoveryId='raw51'), value['approval'].update(preservedCurrentRecoveryId='raw51'))),
    ('restored point of another deployment', '__PKT_LABEL_UPPER___S9_BACKUP_IDENTITY_CHANGED', lambda value: value['report']['restoredResult'].update(deploymentId='deployment:other')),
]:
    changed = copy.deepcopy({'approval': approval, 'report': report})
    mutate(changed)
    check('rejects ' + name, refuses(code, lambda changed=changed: module.validate_restore_proof('S9_RAW_RESTORE51', binding, changed['approval'], '2' * 64, changed['report'])))
check('rejects schema49 action', refuses('__PKT_LABEL_UPPER___S9_EXPLICIT_ROUTE_REQUIRED', lambda: module.validate_restore_proof('S9_RAW_RESTORE49', binding, {**approval, 'action': 'S9_RAW_RESTORE49'}, '2' * 64, {**report, 'action': 'S9_RAW_RESTORE49'})))

check('accepts the G90 plan', equals(plan, lambda: module.workspace_plan(binding)))
for name, mutate in [
    ('renewal plan', lambda value: value.update(decisionRef='G76')),
    ('directory moved', lambda value: value.update(canonicalPath='/var/lib/himawari/qualification-workspace')),
    ('other grant', lambda value: value.update(grantId='directory:himawari-prod-workspace-20261012')),
    ('subdirectory missing', lambda value: value.update(subdirectories=['files'])),
    ('extra field', lambda value: value.update(extra=True)),
    ('fourth grant-creation plan', lambda value: (value.clear(), value.update(copy.deepcopy(fourth_plan)))),
]:
    changed = copy.deepcopy(binding)
    mutate(changed['workspace'])
    check('rejects workspace ' + name, refuses('__PKT_LABEL_UPPER___S9_WORKSPACE_PLAN_CHANGED', lambda changed=changed: module.workspace_plan(changed)))
check('rejects missing workspace plan', refuses('__PKT_LABEL_UPPER___S9_WORKSPACE_PLAN_CHANGED', lambda: module.workspace_plan({k: v for k, v in binding.items() if k != 'workspace'})))
check('reads bound original unit digest', equals('e' * 64, lambda: module.old_unit_sha(binding)))
for name, service in [('unfilled unit digest', {'oldUnitSha256': 'S0_DB:service.unitFragmentSha256', 'oldConfigSha256': module.OLD_CONFIG_SHA}), ('third pre-deploy config digest', {'oldUnitSha256': 'e' * 64, 'oldConfigSha256': 'e0a4834e005493dba3717042bae2d7fccdd37085f5c0fe7f17ee15eea1900643'})]:
    check('rejects ' + name, refuses('__PKT_LABEL_UPPER___S9_ORIGINAL_SERVICE_BINDING_CHANGED', lambda service=service: module.old_unit_sha({**binding, 'service': service})))

def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()

grant_value = {'id': plan['grantId'], 'revision': 1, 'hostId': 'host:one', 'canonicalRootId': '2049:222', 'displayPath': plan['canonicalPath'], 'operations': ['read', 'create', 'update'], 'dataClassification': 'private', 'disclosure': 'model', 'pathPolicy': 'same_filesystem_no_links', 'mountPolicy': 'fixed_device', 'authorizationRef': 'owner-cli:' + plan['grantId'], 'expiresAt': '2027-01-13T00:00:00.000Z', 'revokedAt': None}
grant_bytes = json.dumps(grant_value)
grant_row = {'revision': 1, 'value_json': grant_bytes}
records = {ref: json.dumps({'ref': ref, 'lifecycle': 'active', 'runner': 'eleventh'}) for ref in ('capability:pi', 'capability:exa')}
capability_rows = {ref: {'id': ref, 'version': '1.0.0', 'status': 'active', 'revision': 3, 'integrity': 'sha256:' + ('a' if ref == 'capability:pi' else 'b') * 64, 'record_json': record} for ref, record in records.items()}
frozen_authorization = {'directoryGrants': [{'routeKey': 'coding', 'grantId': plan['grantId'], 'stateRevision': 1, 'metadataSha256': digest(grant_bytes)}], 'capabilities': [{'capabilityRef': ref, 'version': row['version'], 'status': row['status'], 'revision': row['revision'], 'storedIntegrity': row['integrity'], 'registryRecordSha256': digest(row['record_json'])} for ref, row in capability_rows.items()]}
check('restored point has the S0 catalog and the unchanged grant', equals({'capabilityUpgradeDiscarded': True, 'grantRecordUnchanged': True, 'accountRecoveryRequired': True, 'serviceStartAuthorized': False}, lambda: module.validate_restored_catalog(binding, frozen_authorization, grant_row, capability_rows)))

def upgraded(value):
    row = value['rows']['capability:pi']
    row.update(revision=row['revision'] + 1, integrity='sha256:' + 'c' * 64, record_json=row['record_json'].replace('eleventh', '__PKT_LABEL__'))

for name, code, change in [
    ('capability still upgraded', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', upgraded),
    ('capability revision changed', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows']['capability:exa'].update(revision=4)),
    ('capability runner digest changed', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows']['capability:exa'].update(integrity='sha256:' + 'd' * 64)),
    ('capability record bytes changed', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows']['capability:exa'].update(record_json=value['rows']['capability:exa']['record_json'] + ' ')),
    ('capability disabled', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows']['capability:exa'].update(status='disabled')),
    ('capability missing', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows'].pop('capability:exa')),
    ('capability row for another ref', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows']['capability:exa'].update(id='capability:other')),
    ('extra capability', '__PKT_LABEL_UPPER___S9_RESTORED_CATALOG_NOT_AT_S0', lambda value: value['rows'].update({'capability:other': dict(value['rows']['capability:exa'], id='capability:other')})),
    ('frozen catalog empty', '__PKT_LABEL_UPPER___S9_FROZEN_CATALOG_INVALID', lambda value: value['frozen'].update(capabilities=[])),
    ('frozen catalog digest malformed', '__PKT_LABEL_UPPER___S9_FROZEN_CATALOG_INVALID', lambda value: value['frozen']['capabilities'][0].update(registryRecordSha256='x')),
    ('changed grant bytes', '__PKT_LABEL_UPPER___S9_RESTORED_GRANT_CHANGED', lambda value: value.update(grant=dict(value['grant'], value_json=value['grant']['value_json'] + ' '))),
    ('changed grant state revision', '__PKT_LABEL_UPPER___S9_RESTORED_GRANT_CHANGED', lambda value: value.update(grant=dict(value['grant'], revision=2))),
    ('missing grant', '__PKT_LABEL_UPPER___S9_RESTORED_GRANT_CHANGED', lambda value: value.update(grant=None)),
    ('frozen readback names another grant', '__PKT_LABEL_UPPER___S9_FROZEN_GRANT_INVALID', lambda value: value['frozen']['directoryGrants'][0].update(grantId='directory:himawari-prod-workspace-20261012')),
    ('frozen readback has two coding grants', '__PKT_LABEL_UPPER___S9_FROZEN_GRANT_INVALID', lambda value: value['frozen']['directoryGrants'].append(dict(value['frozen']['directoryGrants'][0]))),
    ('frozen grant digest malformed', '__PKT_LABEL_UPPER___S9_FROZEN_GRANT_INVALID', lambda value: value['frozen']['directoryGrants'][0].update(metadataSha256='x')),
    ('binding plan changed', '__PKT_LABEL_UPPER___S9_WORKSPACE_PLAN_CHANGED', lambda value: value['binding']['workspace'].update(grantId='directory:other')),
]:
    values = {'binding': copy.deepcopy(binding), 'frozen': copy.deepcopy(frozen_authorization), 'grant': copy.deepcopy(grant_row), 'rows': copy.deepcopy(capability_rows)}
    change(values)
    check('rejects ' + name, refuses(code, lambda values=values: module.validate_restored_catalog(values['binding'], values['frozen'], values['grant'], values['rows'])))

original_safe_file = module.safe_file
original_evidence = module.EVIDENCE
with tempfile.TemporaryDirectory(dir=os.environ['HIMAWARI_TEST_TEMP_ROOT']) as directory:
    evidence = Path(directory).resolve()
    module.EVIDENCE = evidence
    module.safe_file = lambda filename, uid=0, mode=None: original_safe_file(filename, os.getuid() if uid == 0 else uid, mode)
    try:
        inspection = {'mode': 'inspect-only', 'passed': True, 'processesAbsent': {'confirmed': True, 'basis': 'fixture', 'limitations': []}, 'serviceAfter': {'ActiveState': 'inactive', 'MainPID': '0'}}

        def write_report(name, value, mode=0o640):
            path = evidence / name
            data = (json.dumps(value) + '\n').encode()
            path.write_bytes(data)
            path.chmod(mode)
            return {'passed': True, 'serviceStopped': True, 'report': {'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}}

        good = write_report('s2-inspection-1.json', inspection)
        check('accepts S2 inspect-only proof', equals({'inspection': good['report'], 'processesAbsent': True}, lambda: module.stopped_proof(good)))
        for name, code, build in [
            ('stop command failed', '__PKT_LABEL_UPPER___S9_STOP_PROOF_FAILED', lambda: {**good, 'passed': False}),
            ('service still running', '__PKT_LABEL_UPPER___S9_STOP_PROOF_FAILED', lambda: {**good, 'serviceStopped': False}),
            ('report outside evidence directory', '__PKT_LABEL_UPPER___S9_STOP_PROOF_PATH_CHANGED', lambda: {**good, 'report': {**good['report'], 'path': str(evidence.parent / 's2-inspection-1.json')}}),
            ('report not an inspection', '__PKT_LABEL_UPPER___S9_STOP_PROOF_PATH_CHANGED', lambda: write_report('s2-started-2.json', inspection)),
            ('report digest differs', '__PKT_LABEL_UPPER___S9_STOP_PROOF_CHANGED', lambda: {**good, 'report': {**good['report'], 'sha256': '0' * 64}}),
            ('processes not confirmed absent', '__PKT_LABEL_UPPER___S9_PROCESSES_NOT_ABSENT', lambda: write_report('s2-inspection-3.json', {**inspection, 'processesAbsent': {'confirmed': False}})),
            ('stop mode instead of inspection', '__PKT_LABEL_UPPER___S9_PROCESSES_NOT_ABSENT', lambda: write_report('s2-inspection-4.json', {**inspection, 'mode': 'stop'})),
            ('service main process remained', '__PKT_LABEL_UPPER___S9_PROCESSES_NOT_ABSENT', lambda: write_report('s2-inspection-5.json', {**inspection, 'serviceAfter': {'ActiveState': 'inactive', 'MainPID': '42'}})),
        ]:
            check('rejects ' + name, refuses(code, lambda build=build: module.stopped_proof(build())))
        writable = write_report('s2-inspection-6.json', inspection, 0o660)
        check('rejects group-writable inspection report', refuses('__PKT_LABEL_UPPER___S9_FILE_UNSAFE', lambda: module.stopped_proof(writable)))
    finally:
        module.safe_file = original_safe_file
        module.EVIDENCE = original_evidence


def leftovers_cleared_between_restore_and_reload():
    text = source_bytes.decode()
    call = "report['clearedPrepareLeftovers'] = clear_prepare_leftovers(suffix)"
    unit = text.index('replace_exact(UNIT, original_unit, 0, 0o644, suffix)')
    reload = text.index("command(['/usr/bin/systemctl', 'daemon-reload']")
    if text.count(call) != 1 or not unit < text.index(call) < reload:
        raise RuntimeError('UNEXPECTED_ORDER')


check('clears prepare leftovers after restoring the unit and before daemon-reload', leftovers_cleared_between_restore_and_reload)

original_fchown = os.fchown
original_config = module.CONFIG
original_snapshot = module.SNAPSHOT
with tempfile.TemporaryDirectory(dir=os.environ['HIMAWARI_TEST_TEMP_ROOT']) as directory:
    root = Path(directory).resolve()
    for name in ('etc', 'deployment', 'evidence'):
        (root / name).mkdir(mode=0o700)
    module.EVIDENCE = root / 'evidence'
    module.CONFIG = root / 'etc' / 'config.json'
    module.SNAPSHOT = root / 'deployment' / 'capability-deployment.json'
    module.safe_file = lambda filename, uid=0, mode=None: original_safe_file(filename, os.getuid() if uid in (0, __PKT_SERVICE_UID__) else uid, mode)
    os.fchown = lambda fd, uid, gid: None
    try:
        def leftover_path(target):
            return target.with_name(target.name + '.next')

        def leftover(target, data, mode=0o600):
            path = leftover_path(target)
            path.write_bytes(data)
            path.chmod(mode)
            return path

        def clears(suffix, contents):
            def run():
                for target, data in contents:
                    leftover(target, data)
                cleared = module.clear_prepare_leftovers(suffix)
                actual = [(item['path'], Path(item['retained']['path']).parent == module.EVIDENCE, Path(item['retained']['path']).read_bytes(), item['retained']['mode'], os.path.lexists(item['path'])) for item in cleared]
                expected = [(str(leftover_path(target)), True, data, '0600', False) for target, data in contents]
                if actual != expected:
                    raise RuntimeError('UNEXPECTED_RESULT:' + repr(actual))
            return run

        def keeps_unsafe(code, suffix, make):
            def run():
                path = make()
                try:
                    refuses(code, lambda: module.clear_prepare_leftovers(suffix))()
                    if not os.path.lexists(path) or any(entry.name.startswith('s9-control-leftover-' + suffix + '-') for entry in module.EVIDENCE.iterdir()):
                        raise RuntimeError('UNSAFE_LEFTOVER_TOUCHED')
                finally:
                    path.unlink()
            return run

        def symlinked():
            (root / 'elsewhere.json').write_bytes(b'{}')
            leftover_path(module.CONFIG).symlink_to(root / 'elsewhere.json')
            return leftover_path(module.CONFIG)

        check('clears both temporary files of an interrupted prepare and keeps their bytes', clears('both', [(module.CONFIG, b'{"half":'), (module.SNAPSHOT, b'{"snapshot":1}\n')]))
        check('clears the snapshot temporary file left before the configuration one was written', clears('snapshot', [(module.SNAPSHOT, b'{"snapshot":2}\n')]))
        check('clears the configuration temporary file left after the snapshot was published', clears('config', [(module.CONFIG, b'{"config":')]))
        check('clears nothing after a completed prepare', equals([], lambda: module.clear_prepare_leftovers('none')))
        check('refuses and keeps a symlinked temporary file', keeps_unsafe('__PKT_LABEL_UPPER___S9_FILE_UNSAFE', 'link', symlinked))
        check('refuses and keeps a group-writable temporary file', keeps_unsafe('__PKT_LABEL_UPPER___S9_FILE_UNSAFE', 'writable', lambda: leftover(module.SNAPSHOT, b'{}', 0o620)))
        check('refuses and keeps a temporary file with another mode', keeps_unsafe('__PKT_LABEL_UPPER___S9_FILE_MODE_CHANGED', 'mode', lambda: leftover(module.CONFIG, b'{}', 0o640)))
    finally:
        os.fchown = original_fchown
        module.safe_file = original_safe_file
        module.EVIDENCE = original_evidence
        module.CONFIG = original_config
        module.SNAPSHOT = original_snapshot


print(json.dumps({'passed': all(item['passed'] for item in cases), 'scope': 'S9 concrete approval, restore proof, restored S0 capability catalog and unchanged G90 grant, bound original unit, S2 inspect-only stop proof and interrupted prepare temporary files', 'total': len(cases), 'failed': [item for item in cases if not item['passed']], 'sourceSha256': hashlib.sha256(source_bytes).hexdigest(), 'fixtureSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'stopProofOwnershipAdaptation': 'safe_file owners 0 and __PKT_SERVICE_UID__ mapped to the fixture account and fchown skipped; all other checks unchanged', 'productionExecutionProved': False}))
raise SystemExit(0 if all(item['passed'] for item in cases) else 1)
