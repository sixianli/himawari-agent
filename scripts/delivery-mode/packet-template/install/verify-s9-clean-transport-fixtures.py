import copy
import importlib.util
import inspect
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('second_cleanup', Path(__file__).with_name('S9-clean-transport.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
temporary = os.environ.get('HIMAWARI_TEST_TEMP_ROOT')
if not temporary:
    raise RuntimeError('FIXTURE_OWNED_TEMP_ROOT_REQUIRED')
root = Path(tempfile.mkdtemp(prefix='transport-cleanup-fixture-', dir=temporary))
cases = 0
try:
    stage = root / 'stage'
    stage.mkdir(mode=0o700)
    (stage / 'validation/source/node_modules').mkdir(parents=True)
    (stage / 'validation/source/node_modules/rebuildable.js').write_text('export const fictitious = true;\n')
    (stage / 'acceptance/service-read-01').mkdir(parents=True)
    (stage / 'acceptance/service-read-01/read-report.json').write_text('{"passed":true,"fictitious":true}\n')
    (stage / 'acceptance/service-read-01/read.log').write_text('FICTITIOUS_RETAINED_EVIDENCE\n')
    (stage / 'packet/materials').mkdir(parents=True)
    (stage / 'packet/materials/candidate.tar.gz').write_bytes(b'FICTITIOUS_REBUILDABLE_ARCHIVE')
    (stage / 'packet/materials/source-build-inputs.json').write_text('{"proof":"fictitious"}\n')
    (stage / 'input').mkdir()
    (stage / 'input/context.json').write_text('{"source":"fictitious"}\n')
    info = stage.stat()
    receipt = {'schemaVersion': 'himawari.__PKT_LABEL__-change-owned-directories.v1', 'passed': True, 'actor': {'uid': 0, 'hostname': '__PKT_HOSTNAME__'}, 'directories': [{'path': str(stage), 'device': info.st_dev, 'inode': info.st_ino, 'uid': os.getuid(), 'gid': os.getgid(), 'mode': '0700'}]}
    module.validate_created_identity(stage, receipt, os.getuid(), os.getgid(), 0o700)
    changed = copy.deepcopy(receipt)
    changed['directories'][0]['inode'] += 1
    try:
        module.validate_created_identity(stage, changed, os.getuid(), os.getgid(), 0o700)
    except RuntimeError:
        cases += 1
    else:
        raise RuntimeError('WRONG_CREATED_IDENTITY_NOT_REJECTED')
    try:
        module.validate_no_stage_dependency({'runtimeRoot': str(stage / 'runtime')}, stage)
    except RuntimeError:
        cases += 1
    else:
        raise RuntimeError('LIVE_STAGE_DEPENDENCY_NOT_REJECTED')
    module.validate_no_stage_dependency({'runtimeRoot': '/fictitious-permanent-runtime'}, stage)
    for processes in [{'completeVisibleEnumeration': False, 'consumers': []}, {'completeVisibleEnumeration': True, 'consumers': [{'pid': 123}]}]:
        try:
            module.validate_process_visibility(processes)
        except RuntimeError:
            cases += 1
        else:
            raise RuntimeError('UNKNOWN_OR_CONSUMED_STAGE_NOT_REJECTED')
    before = module.inventory_tree(stage, {os.getuid()})
    module.validate_references({'recordedArchive': {'path': str(stage / 'packet/materials/candidate.tar.gz'), 'sha256': 'fictitious'}}, stage, before)
    for reference in [{'retentionRequired': True, 'path': str(stage / 'validation/source')}, {'trace': str(stage / 'validation/source/unique-trace.json')}]:
        try:
            module.validate_references(reference, stage, before)
        except RuntimeError:
            cases += 1
        else:
            raise RuntimeError('UNPRESERVED_EVIDENCE_REFERENCE_NOT_REJECTED')
    archive = root / 'retained'
    archive.mkdir(mode=0o700)
    retained = module.archive_retained(stage, archive, before, {os.getuid()})
    expected = {entry['relative'] for entry in retained}
    if 'acceptance/service-read-01/read-report.json' not in expected or 'acceptance/service-read-01/read.log' not in expected or 'packet/materials/source-build-inputs.json' not in expected or 'input/context.json' not in expected or 'packet/materials/candidate.tar.gz' in expected or 'validation/source/node_modules/rebuildable.js' in expected:
        raise RuntimeError('RETENTION_CLASSIFICATION_INCORRECT')
    (stage / 'input/context.json').write_text('{"changed":true}\n')
    try:
        module.remove_reviewed_tree(stage, before, {os.getuid()})
    except RuntimeError:
        cases += 1
    else:
        raise RuntimeError('CHANGED_AFTER_REVIEW_NOT_REJECTED')
    (stage / 'input/context.json').write_text('{"source":"fictitious"}\n')
    final = module.inventory_tree(stage, {os.getuid()})
    module.remove_reviewed_tree(stage, final, {os.getuid()})
    if stage.exists() or (archive / 'acceptance/service-read-01/read.log').read_text() != 'FICTITIOUS_RETAINED_EVIDENCE\n':
        raise RuntimeError('ISOLATED_DELETE_OR_RETAINED_READBACK_FAILED')
    cases += 1
    production_stage = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__')
    denied_input = str(production_stage / 'input')
    runtime = '/fictitious-permanent/runtime'
    signed_bindings = []
    capabilities = []
    for key, capability_ref, operations in [('pi', 'himawari.pi-coding', ['read', 'write', 'edit', 'find', 'grep', 'ls', 'bash']), ('search', 'himawari.public-search', ['web_search']), ('fetch', 'himawari.public-fetch', ['web_fetch'])]:
        runner = runtime + '/' + key + '-runner.js'
        binding = {'schemaVersion': 'sandbox-host-binding.v1', 'capabilityRef': capability_ref, 'capabilityVersion': '1.0.0', 'hostId': 'fictitious-host', 'profileRef': 'authorized-project.v1', 'runtimeRoot': runtime, 'runtimeDigest': 'sha256:' + 'a' * 64, 'artifactDigest': 'sha256:' + 'b' * 64, 'executable': {'path': runtime + '/node', 'sha256': 'c' * 64}, 'runner': {'path': runner, 'sha256': 'b' * 64}, 'privateRoot': '/fictitious-permanent/jobs', 'roots': [{'canonicalRootId': '123:456', 'canonicalPath': '/fictitious-permanent/workspace', 'device': '123', 'inode': '456'}], 'readOnlyToolchainPaths': [runtime, '/usr/bin'], 'protectedPaths': ['/fictitious-permanent/state', '/fictitious-permanent/config', denied_input], 'maximumResourceCeiling': {'maxWallTimeMs': 300000, 'maxCpuTimeMs': 30000, 'maxMemoryBytes': 536870912, 'maxOutputBytes': 524288, 'maxProgressEvents': 256}, 'supportedExecutions': [{'schemaVersion': 'sandbox-execution.v2', 'mode': 'foreground'}], 'allowedDomains': [] if key == 'pi' else ['mcp.exa.ai:443', 'api.deepseek.com:443'], 'operationBindings': [{'operation': operation, 'mode': 'foreground', 'backendRef': 'srt', 'scopeSource': 'grant_targets', 'directoryOperations': ['read'], 'network': 'disabled', 'contract': {'ref': 'fictitious-contract', 'version': '1', 'kind': 'fixed_read'}} if key == 'pi' else {'operation': operation, 'mode': 'foreground', 'backendRef': 'srt', 'scopeSource': 'private_temp', 'directoryOperations': [], 'network': 'grant_targets', 'contract': {'ref': 'fictitious-web-contract', 'version': '1', 'kind': 'network_only'}} for operation in operations]}
        manifest = {'manifestVersion': 'capability.v2', 'ref': capability_ref, 'displayName': 'Fictitious capability', 'version': '1.0.0', 'source': {'type': 'program', 'locator': 'artifact:fictitious-' + key}, 'sourceIdentity': 'host:fictitious-host', 'integrity': binding['artifactDigest'], 'artifact': {'digest': binding['artifactDigest'], 'signatureStatus': 'verified', 'signerRef': 'host-signer:fictitious', 'rollbackArtifactRef': None}, 'operations': operations, 'permissionRefs': [], 'isolation': 'sandbox', 'scopes': {'dataClassifications': ['public', 'private'], 'network': binding['allowedDomains'], 'filesystem': ['workspace:himawari-prod-qualification'], 'secrets': [] if key == 'pi' else ['deepseek-web']}, 'cost': {'currency': 'USD', 'maxMicrosPerInvocation': 0}, 'health': {'status': 'healthy', 'checkedAt': '2026-10-09T00:00:00.000Z'}, 'reviewedBy': 'fictitious-owner', 'reviewedAt': '2026-10-09T00:00:00.000Z', 'contractCompatibility': ['capability-conformance.v1'], 'runtime': {'kind': 'program', 'argv': [runtime + '/node', runner, binding['hostId'], 'fictitious-worker'], 'environmentKeys': [], 'workdirRef': 'workspace:himawari-prod-qualification', 'stdin': 'protected_payload', 'stdout': 'protected_payload', 'subprocesses': [], 'network': binding['allowedDomains'], 'filesystem': ['workspace:himawari-prod-qualification']}}
        sandbox = {'schemaVersion': 'sandbox-runtime-qualification.v1', 'qualificationRef': 'fictitious-qualification-' + key, 'hostId': binding['hostId'], 'profileRef': binding['profileRef'], 'srtVersion': '0.0.81', 'platform': 'linux', 'architecture': 'x64', 'osRelease': 'fictitious-kernel', 'runtimeDigest': binding['runtimeDigest'], 'runnerDigest': binding['runner']['sha256'], 'evidenceDigest': 'd' * 64, 'resourceMode': 'observe_and_stop', 'terminationMode': 'verified_tree', 'guarantees': [], 'limitations': [], 'supportedExecutions': binding['supportedExecutions'], 'qualifiedAt': '2026-10-09T00:00:00.000Z', 'expiresAt': '2026-10-09T00:05:00.000Z'}
        qualification = {'qualificationVersion': 'capability-runtime-qualification.v1', 'platform': 'linux', 'runtimeIdentity': 'srt:0.0.81', 'productionSuitable': True, 'artifactDigest': binding['artifactDigest'], 'enforcement': {'filesystem': True, 'network': True, 'processes': True, 'secrets': True, 'resourceCeilings': False, 'termination': True}, 'reasonCodes': [], 'checkedAt': '2026-10-09T00:00:00.000Z', 'sandbox': sandbox}
        signed_bindings.append({'key': key, 'binding': copy.deepcopy(binding)})
        capabilities.append({'manifest': manifest, 'binding': {'kind': 'sandbox', 'value': copy.deepcopy(binding)}, 'qualification': qualification})
    snapshot = {'schemaVersion': 'capability-deployment.v1', 'capabilities': capabilities}
    guard_cases = [('permits exact signed denial paths in complete snapshot', snapshot, signed_bindings, False)]
    reordered = copy.deepcopy(snapshot)
    reordered['capabilities'].reverse()
    guard_cases.append(('permits capability order changes with exact signed bindings', reordered, signed_bindings, False))
    for field, value in [('runtimeRoot', str(production_stage / 'runtime')), ('privateRoot', str(production_stage / 'jobs')), ('runner', {'path': str(production_stage / 'runner.js'), 'sha256': 'b' * 64}), ('executable', {'path': str(production_stage / 'node'), 'sha256': 'c' * 64}), ('roots', [{'canonicalPath': str(production_stage / 'workspace')}]), ('readOnlyToolchainPaths', [denied_input]), ('unexpectedReadPath', denied_input)]:
        changed_snapshot = copy.deepcopy(snapshot)
        changed_signed = copy.deepcopy(signed_bindings)
        changed_snapshot['capabilities'][0]['binding']['value'][field] = value
        changed_signed[0]['binding'][field] = value
        guard_cases.append(('rejects stage read through binding.' + field, changed_snapshot, changed_signed, True))
    for location in ['source', 'runtime', 'qualification', 'top-level protectedPaths']:
        changed_snapshot = copy.deepcopy(snapshot)
        if location == 'source':
            changed_snapshot['capabilities'][0]['manifest']['source']['locator'] = denied_input
        elif location == 'runtime':
            changed_snapshot['capabilities'][0]['manifest']['runtime']['argv'][1] = denied_input
        elif location == 'qualification':
            changed_snapshot['capabilities'][0]['qualification']['sandbox']['unexpectedPath'] = denied_input
        else:
            changed_snapshot['protectedPaths'] = [denied_input]
        guard_cases.append(('rejects stage path in ' + location, changed_snapshot, signed_bindings, True))
    for denied_path in [str(production_stage / 'input-other'), str(production_stage / 'input/child'), str(production_stage / 'validation/source'), str(production_stage / 'input/../input')]:
        changed_snapshot = copy.deepcopy(snapshot)
        changed_signed = copy.deepcopy(signed_bindings)
        changed_snapshot['capabilities'][0]['binding']['value']['protectedPaths'][-1] = denied_path
        changed_signed[0]['binding']['protectedPaths'][-1] = denied_path
        guard_cases.append(('rejects changed denial path ' + denied_path, changed_snapshot, changed_signed, True))
    for name, target, field, value in [('wrong snapshot schema', 'snapshot', 'schemaVersion', 'other.v1'), ('wrong binding schema', 'binding', 'schemaVersion', 'other.v1'), ('wrong binding kind', 'entry', 'kind', 'program'), ('wrong protectedPaths shape', 'binding', 'protectedPaths', denied_input)]:
        changed_snapshot = copy.deepcopy(snapshot)
        destination = changed_snapshot if target == 'snapshot' else changed_snapshot['capabilities'][0]['binding'] if target == 'entry' else changed_snapshot['capabilities'][0]['binding']['value']
        destination[field] = value
        guard_cases.append(('rejects ' + name, changed_snapshot, signed_bindings, True))
    for name, value in [('missing signed bindings', None), ('missing one signed capability', signed_bindings[:1]), ('duplicated signed capability', signed_bindings + [copy.deepcopy(signed_bindings[0])])]:
        guard_cases.append(('rejects ' + name, snapshot, value, True))
    changed_signed = copy.deepcopy(signed_bindings)
    changed_signed[0]['binding']['protectedPaths'].remove(denied_input)
    guard_cases.append(('rejects unsigned denial path', snapshot, changed_signed, True))
    changed_signed = copy.deepcopy(signed_bindings)
    changed_signed[0]['binding']['runner']['sha256'] = 'e' * 64
    guard_cases.append(('rejects changed signed runner identity', snapshot, changed_signed, True))
    changed_snapshot = copy.deepcopy(snapshot)
    changed_snapshot['capabilities'][1]['binding']['value']['capabilityRef'] = changed_snapshot['capabilities'][0]['binding']['value']['capabilityRef']
    guard_cases.append(('rejects duplicate snapshot capability', changed_snapshot, signed_bindings, True))
    supports_signed_bindings = 'signed_bindings' in inspect.signature(module.validate_no_stage_dependency).parameters
    outcomes = []
    for index, (name, value, signed, should_reject) in enumerate(guard_cases):
        try:
            if index == 0 and not supports_signed_bindings:
                module.validate_no_stage_dependency(value, production_stage)
            else:
                module.validate_no_stage_dependency(value, production_stage, signed)
        except TypeError:
            if supports_signed_bindings:
                raise
            outcomes.append({'name': name, 'status': 'pending-signed-binding-interface'})
        except RuntimeError as error:
            outcomes.append({'name': name, 'status': 'passed' if should_reject else 'failed', 'failureCode': str(error)})
        else:
            outcomes.append({'name': name, 'status': 'failed' if should_reject else 'passed'})
    successful = all(value['status'] == 'passed' for value in outcomes)
    print(json.dumps({'passed': successful, 'scope': 'isolated-real-filesystem-retention-review-and-deletion-guards', 'cases': cases + len(outcomes), 'originalFilesystemCasesPassed': cases, 'snapshotGuardCases': outcomes, 'retainedFileCount': len(retained), 'productionDeletionProved': False}))
    if not successful:
        sys.exit(1)
finally:
    shutil.rmtree(root)
