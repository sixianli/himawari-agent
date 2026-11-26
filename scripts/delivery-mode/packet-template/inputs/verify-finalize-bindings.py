import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
if len(sys.argv) != 3 or sys.platform != 'linux':
    raise RuntimeError('HERMES_FIXTURE_NODE_AND_SCRATCH_REQUIRED')
node = Path(sys.argv[1]).resolve()
scratch = Path(sys.argv[2])
info = scratch.lstat()
if scratch.resolve() != scratch or not scratch.is_dir() or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or len(str(scratch)) != 10:
    raise RuntimeError('HERMES_FIXTURE_SCRATCH_UNSAFE')
packet = Path(__file__).resolve().parents[1]
source = packet / 'inputs/finalize-bindings.py'
verifier = packet / 'signing/cloud-system-tool-bindings.mjs'
digest = lambda value: hashlib.sha256(value).hexdigest()
observed_result = subprocess.run([str(node), '--no-global-search-paths', '--input-type=module', '-'], input='import { collectSystemToolBindings } from ' + json.dumps(verifier.as_uri()) + '; const result = await collectSystemToolBindings({bwrap:"/usr/bin/bwrap",socat:"/usr/bin/socat",bash:"/usr/bin/bash",rg:"/usr/bin/rg"}); process.stdout.write(JSON.stringify(result));', text=True, capture_output=True, check=True)
tools = json.loads(observed_result.stdout)
observed = {'schema': 'himawari-cloud-system-tools-observation.v1', 'hostname': '__PKT_HOSTNAME__', 'platform': 'linux', 'verifierSha256': digest(verifier.read_bytes()), 'systemToolPaths': {key: '/usr/bin/' + key for key in ['bwrap', 'socat', 'bash', 'rg']}, 'systemToolIdentities': tools['systemToolBindings']}
fixture_head = 'f1c7e0d2a3b4c5d6e7f8091a2b3c4d5e6f708192'
bundle_name = 'source-' + fixture_head[:7] + '.bundle'
identity = {'ownerId': 'owner:first-production', 'agentId': 'agent:first-production', 'deploymentId': 'himawari-prod-deployment', 'hostId': 'himawari-prod-host'}
workspace_plan = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
old_config_sha = '621bfd1aa7fd763f76ff771be4f8681a42ddcc71bbf37bd28a63b97c436434a2'
anchor_holders = ['systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py']
history_tables = ['runs', 'threads', 'thread_gateway_events', 'run_coordination_checkpoints', 'model_budget_accounts', 'model_budget_allocations', 'model_invocation_identities', 'run_payload_artifacts', 'capability_invocation_receipts', 'sandbox_execution_records', 'sandbox_release_receipts', 'sandbox_reservation_release_receipts']
authority = {'authorityEpoch': 7, 'fencingToken': 9, 'ownerId': identity['ownerId'], 'agentId': identity['agentId'], 'deploymentId': identity['deploymentId'], 'status': 'active'}
checks = ['activeHealthy', 'versionMatchesSnapshot', 'operationsMatchSnapshot', 'scopesMatchSnapshot', 'costMatchesSnapshot', 'secretRefsMatchSnapshot', 'permissionRefsMatchSnapshot', 'declarationMatchesSnapshotExceptArtifact', 'snapshotIntegrityMatchesRunner', 'storedIntegrityMatchesDeclaration', 'runnerMatchesRecorded', 'integrityMatchesSnapshot', 'declarationInvariantMatchesSnapshot']
capabilities = [{'capabilityRef': 'fixture:' + key, 'version': '1.0.0', 'status': 'active', 'revision': 2, 'hostId': identity['hostId'], 'workerInstanceId': 'fixture:worker', 'runtimeRoot': '__PKT_OLD_PREFIX__/lib/himawari-agent', **{name: True for name in checks}, 'runnerSha256': digest(key.encode()), 'actualRunnerSha256': digest(key.encode()), 'manifestInvariantDigest': digest((key + ':manifest').encode()), 'registryRecordSha256': digest((key + ':registry').encode())} for key in ['pi', 'exa']]
grant = {'routeKey': 'coding', 'grantId': workspace_plan['grantId'], 'capabilityRef': capabilities[0]['capabilityRef'], 'capabilityVersion': capabilities[0]['version'], 'revision': 1, 'stateRevision': 1, 'hostId': identity['hostId'], 'canonicalRootId': '1:2', 'displayPath': workspace_plan['canonicalPath'], 'device': '1', 'inode': '2', 'pathPolicy': 'same_filesystem_no_links', 'mountPolicy': 'fixed_device', 'expiresAt': '9999-01-01T00:00:00.000Z', 'revokedAt': None, 'readAllowed': True, 'hostMatchesRoute': True, 'rootMatchesSnapshot': True, 'currentlyUsable': True, 'metadataSha256': digest(b'fixture:grant')}
s0 = {'schemaVersion': 'himawari.__PKT_LABEL__-change-s0-db.v1', 'identity': identity, 'authority': authority, 'schema': {'current': __PKT_CURRENT_SCHEMA__, 'minimumWriter': __PKT_CURRENT_SCHEMA__, 'ledgerCount': __PKT_CURRENT_SCHEMA__, 'ledgerMax': __PKT_CURRENT_SCHEMA__}, 'gate': {'oldReservedCount': 1, 'unresolvedReservedCount': 0, 'nonTerminalRunCount': 1}, 'authorization': {'directoryGrants': [grant], 'capabilities': capabilities}, 'service': {'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'unitFragmentSha256': digest(b'fixture third unit'), 'configurationSha256': old_config_sha, 'pairSupervisor': '__PKT_OLD_OPERATIONS__/pair-supervisor.mjs', 'pairSupervisorSha256': digest(b'fixture supervisor')}, 'workspace': {'path': workspace_plan['canonicalPath'], 'device': '1', 'inode': '2', 'uid': __PKT_SERVICE_UID__, 'gid': __PKT_SERVICE_GID__, 'mode': '0700', 'subdirectories': [{'name': name, 'device': '1', 'inode': str(index + 3), 'uid': __PKT_SERVICE_UID__, 'gid': __PKT_SERVICE_GID__, 'mode': '0700'} for index, name in enumerate(workspace_plan['subdirectories'])]}, 'history': {table: {'rows': index, 'sha256': digest(table.encode())} for index, table in enumerate(history_tables)}}
draft = json.loads((packet / 'inputs/bindings.draft.json').read_text())
node_prefix = '/opt/himawari/node'
npm_root = node_prefix + '/lib/node_modules/npm'
npm_cli = npm_root + '/bin/npm-cli.js'
npm_version = '10.0.0'
npm_entries = [{'path': '.', 'uid': 0, 'gid': 0, 'mode': 0o755, 'type': 'directory'}, {'path': 'bin', 'uid': 0, 'gid': 0, 'mode': 0o755, 'type': 'directory'}, {'path': 'bin/npm-cli.js', 'uid': 0, 'gid': 0, 'mode': 0o644, 'type': 'file', 'bytes': 3, 'sha256': digest(b'npm')}, {'path': 'package.json', 'uid': 0, 'gid': 0, 'mode': 0o644, 'type': 'file', 'bytes': 4, 'sha256': digest(b'npm!')}]
npm_chain = [{'path': value, 'uid': 0, 'gid': 0, 'mode': 0o755, 'device': '1', 'inode': str(index + 1), 'type': 'directory'} for index, value in enumerate(['/', '/opt', '/opt/himawari', node_prefix, node_prefix + '/bin'])] + [{'path': node_prefix + '/bin/npm', 'uid': 0, 'gid': 0, 'mode': 0o777, 'device': '1', 'inode': '6', 'type': 'symlink', 'link': '../lib/node_modules/npm/bin/npm-cli.js', 'realpath': npm_cli}]
npm_command = [node_prefix + '/bin/node', '--experimental-permission', '--allow-fs-read=' + node_prefix, '--allow-fs-read=/dev/null', '--no-global-search-paths', npm_cli, '--version', '--offline', '--ignore-scripts', '--logs-max=0', '--userconfig=/dev/null', '--globalconfig=' + node_prefix + '/.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig', '--cache=/dev/null']
npm_observed = {'schemaVersion': 'himawari.__PKT_LABEL__-change-npm-observation.v1', 'passed': True, 'hostname': '__PKT_HOSTNAME__', 'actorUid': 0, 'readOnly': True, 'networkCommandsIssued': False, 'node': {'path': node_prefix + '/bin/node', 'realpath': node_prefix + '/bin/node', 'version': 'v22.22.3', 'sha256': draft['host']['nodeSha256']}, 'npm': {'requestedPath': node_prefix + '/bin/npm', 'realpath': npm_cli, 'packageRoot': npm_root, 'version': npm_version, 'packageManifestVersion': npm_version, 'cliSha256': digest(b'npm'), 'entriesSha256': digest(json.dumps(npm_entries, sort_keys=True, separators=(',', ':')).encode()), 'entryCount': len(npm_entries), 'bytes': 7, 'entries': npm_entries, 'requestedPathChain': npm_chain}, 'versionCommand': {'argv': npm_command, 'exitCode': 0, 'stdoutSha256': digest((npm_version + '\n').encode()), 'stderrSha256': digest(b''), 'filesystemWritesAllowed': False, 'configFiles': {'user': '/dev/null', 'global': node_prefix + '/.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig', 'globalAbsentBefore': True, 'globalAbsentAfter': True}, 'offline': True}, 'observedAt': '2026-10-09T00:00:00+00:00'}
results = []

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def fixture(root):
    (root / 'inputs').mkdir()
    (root / 'signing').mkdir()
    (root / 'materials').mkdir()
    (root / 'install').mkdir()
    (root / 'systemd').mkdir()
    shutil.copyfile(packet / 'systemd/himawari-prod.service.draft', root / 'systemd/himawari-prod.service.draft')
    (root / 'maintenance').mkdir()
    for name in anchor_holders:
        holder = (packet / name).read_text()
        assert holder.count("OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'\n") == 1
        (root / name).write_text(holder.replace("OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'\n", "OLD_CONFIG_SHA = '" + old_config_sha + "'\n"))
    script = source.read_text()
    assert len(re.findall(r"^head = '[^']*'\n", script, re.M)) == 1
    (root / 'inputs/finalize-bindings.py').write_text(re.sub(r"^head = '[^']*'\n", "head = '" + fixture_head + "'\n", script, flags=re.M))
    shutil.copyfile(verifier, root / 'signing/cloud-system-tool-bindings.mjs')
    current = copy.deepcopy(draft)
    current['d1Commit'] = current['gateCommit'] = fixture_head
    current['candidate'] = {key: 'fixture:' + key for key in current['candidate']}
    current['candidate']['testedCommit'] = fixture_head
    current['installationInputs'].update({'sourceBundlePath': 'materials/' + bundle_name, 'sourceModeProofRecordCount': 1, 'sourceModeCounts': {'0644': 1}, 'sourceModeProofDigestBeforeAndAfter': digest(b'fixture mode proof')})
    current['approvals'].update({'qualificationRule': 'fixture:host-acceptance-decision', 'executionMethod': 'fixture:execution-method-decision'})
    current.pop('revision', None)
    current['maintenance'].pop('recovery49Id', None)
    current['maintenance'].update(recovery_contract)
    current['host']['systemBwrap']['sha256'] = observed['systemToolIdentities']['bwrap']['sha256']
    current['host']['systemBwrapIdentity']['sha256'] = observed['systemToolIdentities']['bwrap']['sha256']
    files = []
    for name in [bundle_name, 'candidate.tar.gz', 'context.json', '__PKT_PYTHON_ARCHIVE_NAME__', 'node-modules.tar.gz', 'node-modules.json', 'npm-ls.json', 'source-build-inputs.json']:
        data = json.dumps({'testedSha': current['d1Commit'], 'headSha': current['d1Commit'], 'baseSha': current['d1Commit']}).encode() if name == 'context.json' else ('fictitious material ' + name).encode()
        (root / 'materials' / name).write_bytes(data)
        files.append({'name': name, 'bytes': len(data), 'sha256': digest(data)})
    archive = next(item for item in files if item['name'] == 'candidate.tar.gz')
    context = next(item for item in files if item['name'] == 'context.json')
    bundle = next(item for item in files if item['name'] == bundle_name)
    proof = next(item for item in files if item['name'] == 'source-build-inputs.json')
    current['candidate'].update({'archivePath': str(root / 'materials/candidate.tar.gz'), 'archiveBytes': archive['bytes'], 'archiveSha256': archive['sha256'], 'contextPath': str(root / 'materials/context.json'), 'contextBytes': context['bytes'], 'contextSha256': context['sha256']})
    current['installationInputs'].update({'sourceBundleBytes': bundle['bytes'], 'sourceBundleSha256': bundle['sha256'], 'sourceModeProofBytes': proof['bytes'], 'sourceModeProofSha256': proof['sha256']})
    write_json(root / 'install/p5-materials.json', {'schemaVersion': 2, 'purpose': 'cloud-__PKT_LABEL__-install', 'nonProduction': False, 'nodeAlreadyInstalled': True, 'nodeSha256': current['host']['nodeSha256'], 'sourceHead': current['d1Commit'], 'files': files[:-1]})
    write_json(root / 'inputs/bindings.draft.json', current)
    write_json(root / 'inputs/s0-db-readback.json', copy.deepcopy(s0))
    write_json(root / 'inputs/system-tools-observed.json', copy.deepcopy(observed))
    write_json(root / 'inputs/npm-observed.json', copy.deepcopy(npm_observed))
    return current

def execute(root, args):
    return subprocess.run([sys.executable, '-I', str(root / 'inputs/finalize-bindings.py'), *args], text=True, capture_output=True)

def test(name, mutate=None, args=None, verify=None, rejected=False):
    with tempfile.TemporaryDirectory(prefix='binding-', dir=scratch) as temporary:
        root = Path(temporary)
        fixture(root)
        if mutate:
            mutate(root)
        command = args if args is not None else ['--candidate-from-s0']
        run = execute(root, command)
        try:
            if rejected:
                assert run.returncode != 0, 'invalid input was accepted'
                assert not (root / 'inputs/bindings.reviewed.json').exists(), 'invalid candidate was published'
                assert not (root / 'inputs/bindings.json').exists(), 'invalid frozen binding was published'
                assert not (root / 'freeze-manifest.json').exists(), 'invalid freeze manifest was published'
            else:
                assert run.returncode == 0, run.stderr
                if verify:
                    verify(root, json.loads(run.stdout))
            results.append({'name': name, 'passed': True, 'exitCode': run.returncode})
        except Exception as error:
            results.append({'name': name, 'passed': False, 'exitCode': run.returncode, 'error': str(error), 'stderr': run.stderr[-3000:]})

def edit(name, operation):
    def mutate(root):
        filename = root / name
        value = json.loads(filename.read_text())
        operation(value)
        write_json(filename, value)
    return mutate

def reviewed(root, report):
    result = json.loads((root / 'inputs/bindings.reviewed.json').read_text())
    assert report['status'] == result['status'] == 'ready-for-Claude-review'
    assert result['identity'] == identity and result['authority'] == authority
    assert not (root / 'inputs/bindings.json').exists() and not (root / 'freeze-manifest.json').exists()
    for name in ['inputs/s0-db-readback.json', 'inputs/system-tools-observed.json', 'inputs/npm-observed.json']:
        assert result['inputReadbacks'][name] == digest((root / name).read_bytes())

def frozen(root, report):
    result = json.loads((root / 'inputs/bindings.json').read_text())
    manifest = json.loads((root / 'freeze-manifest.json').read_text())
    assert report['status'] == result['status'] == manifest['status'] == 'frozen-approved'
    assert manifest['approvalRef'] == result['approvals']['packageRef'] == 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'
    expected = {str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() and str(path.relative_to(root)) != 'freeze-manifest.json' and path.relative_to(root).parts[0] != 'run-logs'}
    assert {entry['path'] for entry in manifest['files']} == expected, 'freeze member set differs from actual ordinary files'
    for entry in manifest['files']:
        data = (root / entry['path']).read_bytes()
        assert entry['bytes'] == len(data) and entry['sha256'] == digest(data)

recovery_contract = {'recoveryMethod': 'stopped-raw-copy-v1', 'recovery__PKT_CURRENT_SCHEMA__Id': '__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema__PKT_CURRENT_SCHEMA__'}
reviewed_ref = 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'

def existing_publication(root, publication):
    original = b'fictitious original immutable publication\n'
    path = root / publication
    path.write_bytes(original)
    run = execute(root, ['--freeze-reviewed-packet', reviewed_ref])
    assert run.returncode != 0, 'existing immutable publication was accepted'
    assert path.read_bytes() == original, 'existing immutable publication bytes changed'
    assert '__PKT_LABEL_UPPER___BINDINGS_ALREADY_PUBLISHED' in run.stderr, run.stderr
    return run

for publication in ['inputs/bindings.json', 'freeze-manifest.json']:
    with tempfile.TemporaryDirectory(prefix='binding-conflict-', dir=scratch) as temporary:
        root = Path(temporary)
        fixture(root)
        try:
            run = existing_publication(root, publication)
            results.append({'name': 'refuses to overwrite existing ' + publication, 'passed': True, 'exitCode': run.returncode})
        except Exception as error:
            results.append({'name': 'refuses to overwrite existing ' + publication, 'passed': False, 'error': str(error)})

def frozen_recovery(root, report):
    frozen(root, report)
    current = json.loads((root / 'inputs/bindings.json').read_text())
    assert 'revision' not in current
    assert {key: current['maintenance'][key] for key in recovery_contract} == recovery_contract
    assert not any(key in current['maintenance'] for key in ('recovery49Id', 'recovery50Id', 'backup49Id', 'backup50Id', 'retainedStepBindingSha256'))

test('freezes the single Schema __PKT_CURRENT_SCHEMA__ raw-copy recovery contract without revision ancestry', args=['--freeze-reviewed-packet', reviewed_ref], verify=frozen_recovery)
test('rejects unapproved package ref', args=['--freeze-reviewed-packet', 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/unreviewed'], rejected=True)
test('rejects the third deployment package ref', args=['--freeze-reviewed-packet', 'round2/G66/third-20261012/reviewed-02'], rejected=True)
test('rejects leftover G69 revision ancestry', edit('inputs/bindings.draft.json', lambda current: current.__setitem__('revision', {'number': 2})), args=['--freeze-reviewed-packet', reviewed_ref], rejected=True)
for field, value in [('recoveryMethod', 'cli-backup'), ('recovery50Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema50'), ('recovery__PKT_CURRENT_SCHEMA__Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-schema__PKT_CURRENT_SCHEMA__'), ('recovery55Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema55'), ('recovery49Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema49'), ('backup49Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-schema49'), ('backup50Id', '__PKT_LABEL__-__PKT_DATE_COMPACT__-schema50')]:
    test('rejects changed raw-copy contract ' + field, edit('inputs/bindings.draft.json', lambda current, key=field, item=value: current['maintenance'].__setitem__(key, item)), args=['--freeze-reviewed-packet', reviewed_ref], rejected=True)
test('rejects missing recovery__PKT_CURRENT_SCHEMA__Id', edit('inputs/bindings.draft.json', lambda current: current['maintenance'].pop('recovery__PKT_CURRENT_SCHEMA__Id')), rejected=True)
test('rejects a leftover retained step binding', edit('inputs/bindings.draft.json', lambda current: current['maintenance'].__setitem__('retainedStepBindingSha256', {'S3_COPY51': '0' * 64})), rejected=True)

def edit_s0(operation):
    return edit('inputs/s0-db-readback.json', operation)

def edit_draft(operation):
    return edit('inputs/bindings.draft.json', operation)

test('rejects the unset candidate head placeholder', mutate=lambda root: (root / 'inputs/finalize-bindings.py').write_text(re.sub(r"^head = '[^']*'\n", "head = 'PENDING:candidate.testedCommit'\n", source.read_text(), flags=re.M)), rejected=True)
test('G90 rejects an expired existing grant even when reported unusable', edit_s0(lambda value: value['authorization']['directoryGrants'][0].update(expiresAt='2026-10-09T05:03:34.666Z', currentlyUsable=False)), rejected=True)
test('G90 rejects a valid existing grant reported unusable', edit_s0(lambda value: value['authorization']['directoryGrants'][0].__setitem__('currentlyUsable', False)), rejected=True)
test('G90 rejects an expired existing grant reported usable', edit_s0(lambda value: value['authorization']['directoryGrants'][0].__setitem__('expiresAt', '2026-10-09T05:03:34.666Z')), rejected=True)
test('G90 rejects a second directory grant', edit_s0(lambda value: value['authorization']['directoryGrants'].append(dict(value['authorization']['directoryGrants'][0], routeKey='search'))), rejected=True)
for field, value in [('decisionRef', 'G76'), ('routeKey', 'search'), ('grantId', 'directory:himawari-prod-workspace-20261012'), ('canonicalPath', '/var/lib/himawari/qualification-workspace'), ('subdirectories', ['files']), ('subdirectories', ['repos', 'files']), ('durationDays', 90), ('newGrantId', 'directory:himawari-prod-workspace-20261017')]:
    test('G90 rejects changed workspace plan ' + field + ' ' + repr(value), edit_draft(lambda current, key=field, item=value: current['workspace'].__setitem__(key, item)), rejected=True)
for field, value in [('grantId', 'different:old'), ('displayPath', '/different-root'), ('revokedAt', '2026-10-09T00:00:00.000Z'), ('readAllowed', False), ('hostMatchesRoute', False), ('rootMatchesSnapshot', False), ('pathPolicy', 'allow_links'), ('mountPolicy', 'any_device'), ('routeKey', 'search')]:
    test('G90 rejects changed existing grant ' + field, edit_s0(lambda current, key=field, item=value: current['authorization']['directoryGrants'][0].__setitem__(key, item)), rejected=True)
test('rejects a configuration change left in the draft', edit_draft(lambda current: current.__setitem__('configurationChange', {'coding': {'grantId': workspace_plan['grantId']}})), rejected=True)
for field in ['qualificationRule', 'executionMethod']:
    test('rejects pending host acceptance decision ' + field, edit_draft(lambda current, key=field: current['approvals'].__setitem__(key, 'PENDING:user.decision')), rejected=True)
test('rejects S0 configuration digest different from the S2 and S9 anchors', edit_s0(lambda value: value['service'].__setitem__('configurationSha256', '0' * 64)), rejected=True)
test('rejects a malformed S0 configuration digest', edit_s0(lambda value: value['service'].__setitem__('configurationSha256', 'wrong')), rejected=True)
for holder in anchor_holders:
    test('rejects an unfilled old configuration anchor in ' + holder, mutate=lambda root, name=holder: (root / name).write_text((packet / name).read_text()), rejected=True)
    test('rejects a second old configuration anchor in ' + holder, mutate=lambda root, name=holder: (root / name).write_text((root / name).read_text() + "OLD_CONFIG_SHA = '" + old_config_sha + "'\n"), rejected=True)
test('rejects S0 unit digest that is malformed', edit_s0(lambda value: value['service'].__setitem__('unitFragmentSha256', 'wrong')), rejected=True)
test('rejects S0 pair supervisor path change', edit_s0(lambda value: value['service'].__setitem__('pairSupervisor', '/opt/himawari/operations/second-20261009/pair-supervisor.mjs')), rejected=True)
def edit_workspace(operation):
    return edit_s0(lambda value: operation(value['workspace']))

for field, value in [('path', '/var/lib/himawari/qualification-workspace'), ('device', '9'), ('inode', '9'), ('uid', 1000), ('gid', 0), ('mode', '0750'), ('mode', '0777')]:
    test('rejects changed existing workspace ' + field + ' ' + repr(value), edit_workspace(lambda workspace, key=field, item=value: workspace.__setitem__(key, item)), rejected=True)
test('rejects an existing workspace readback with an extra field', edit_workspace(lambda workspace: workspace.__setitem__('targetExists', True)), rejected=True)
test('rejects the fourth target-only readback', edit_s0(lambda value: value.__setitem__('workspace', {'parent': {'path': '/var/lib/himawari', 'uid': 0, 'gid': 0, 'mode': '0755'}, 'target': workspace_plan['canonicalPath'], 'targetExists': False})), rejected=True)
test('rejects a missing workspace subdirectory', edit_workspace(lambda workspace: workspace['subdirectories'].pop()), rejected=True)
test('rejects an extra workspace subdirectory', edit_workspace(lambda workspace: workspace['subdirectories'].append(dict(workspace['subdirectories'][0], name='tmp', inode='9'))), rejected=True)
test('rejects reordered workspace subdirectories', edit_workspace(lambda workspace: workspace['subdirectories'].reverse()), rejected=True)
for field, value in [('device', '9'), ('inode', '2'), ('inode', 'x'), ('uid', 1000), ('gid', 0), ('mode', 'rwx')]:
    test('rejects changed workspace subdirectory ' + field + ' ' + repr(value), edit_workspace(lambda workspace, key=field, item=value: workspace['subdirectories'][1].__setitem__(key, item)), rejected=True)
test('accepts a workspace subdirectory whose mode the user widened', edit_workspace(lambda workspace: workspace['subdirectories'][0].__setitem__('mode', '0755')), verify=reviewed)
test('rejects a missing history table digest', edit_s0(lambda value: value['history'].pop('runs')), rejected=True)
test('rejects a malformed history digest', edit_s0(lambda value: value['history']['runs'].__setitem__('sha256', 'wrong')), rejected=True)
test('rejects an unresolved reservation at S0', edit_s0(lambda value: value['gate'].__setitem__('unresolvedReservedCount', 1)), rejected=True)
test('rejects an S0 readback without the non-terminal run count', edit_s0(lambda value: value['gate'].pop('nonTerminalRunCount')), rejected=True)

def bound_unit(root, report):
    reviewed(root, report)
    binding = json.loads((root / 'inputs/bindings.reviewed.json').read_text())
    assert binding['service']['oldUnitSha256'] == s0['service']['unitFragmentSha256']
    assert binding['workspace'] == workspace_plan and 'configurationChange' not in binding
    assert binding['service']['oldConfigSha256'] == s0['service']['configurationSha256'] == old_config_sha

test('binds the S0 unit and configuration digests and the existing workspace plan', verify=bound_unit)
test('valid complete S0 creates review candidate only', verify=reviewed)

def unit_bound(root, report):
    frozen(root, report)
    current = json.loads((root / 'inputs/bindings.json').read_text())
    assert current['service']['newUnitSha256'] == digest((root / 'systemd/himawari-prod.service.draft').read_bytes())
test('freeze binds the frozen new unit SHA for S2 inspect-only, S7 and S9', args=['--freeze-reviewed-packet', reviewed_ref], verify=unit_bound)
test('rejects a draft new unit SHA that differs from the frozen unit', edit('inputs/bindings.draft.json', lambda current: current['service'].__setitem__('newUnitSha256', '0' * 64)), rejected=True)
test('rejects a new unit that still holds a placeholder', mutate=lambda root: (root / 'systemd/himawari-prod.service.draft').write_text('ExecStart=REPLACE_ME\n'), rejected=True)
test('rejects a missing new unit', mutate=lambda root: (root / 'systemd/himawari-prod.service.draft').unlink(), rejected=True)
test('permits released historical reservations with old count 3 and unresolved count 0', edit('inputs/s0-db-readback.json', lambda value: value['gate'].__setitem__('oldReservedCount', 3)), verify=reviewed)
test('explicit reviewed approval freezes every ordinary file', args=['--freeze-reviewed-packet', 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'], verify=frozen)
def leaves_deploy_logs_unfrozen(root, report):
    frozen(root, report)
    manifest = json.loads((root / 'freeze-manifest.json').read_text())
    assert not any(entry['path'].startswith('run-logs/') for entry in manifest['files']), 'deploy logs were frozen'

def add_deploy_logs(root):
    (root / 'run-logs').mkdir(mode=0o700)
    (root / 'run-logs/deploy-20261027T010201Z.log').write_text('fictitious earlier deploy log')

test('deploy logs from an earlier attempt stay out of the freeze', mutate=add_deploy_logs, args=['--freeze-reviewed-packet', reviewed_ref], verify=leaves_deploy_logs_unfrozen)
test('nested freeze-manifest.json is retained as an ordinary member', mutate=lambda root: (root / 'signing/freeze-manifest.json').write_text('fictitious nested input'), args=['--freeze-reviewed-packet', 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'], verify=frozen)
for args in [[], ['--freeze-reviewed-packet'], ['--freeze-reviewed-packet', 'PENDING/approval'], ['--freeze-reviewed-packet', 'REPLACE_approval'], ['--freeze-reviewed-packet', 'short'], ['--candidate-from-s0', 'unapproved']]:
    test('rejects missing or invalid explicit operation ' + json.dumps(args), args=args, rejected=True)
for field in identity:
    test('rejects missing identity ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['identity'].pop(key)), rejected=True)
    test('rejects empty identity ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['identity'].__setitem__(key, '')), rejected=True)
test('rejects extra identity field', edit('inputs/s0-db-readback.json', lambda value: value['identity'].__setitem__('extra', 'fixture:extra')), rejected=True)
for field in authority:
    test('rejects changed draft authority ' + field, edit('inputs/bindings.draft.json', lambda value, key=field: value['authority'].__setitem__(key, 'different')), rejected=True)
    test('rejects missing authority ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['authority'].pop(key)), rejected=True)
test('rejects authority belonging to another owner', edit('inputs/s0-db-readback.json', lambda value: value['authority'].__setitem__('ownerId', 'fixture:other-owner')), rejected=True)
test('rejects inactive authority', edit('inputs/s0-db-readback.json', lambda value: value['authority'].__setitem__('status', 'retired')), rejected=True)
test('rejects extra authority field', edit('inputs/s0-db-readback.json', lambda value: value['authority'].__setitem__('extra', 'fixture:extra')), rejected=True)
for field in s0['schema']:
    test('rejects changed schema ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['schema'].__setitem__(key, 49)), rejected=True)
for value in [-1, '3', 3.5, True, None]:
    test('rejects malformed old historical gate count ' + repr(value), edit('inputs/s0-db-readback.json', lambda data, item=value: data['gate'].__setitem__('oldReservedCount', item)), rejected=True)
test('rejects absent old historical gate count', edit('inputs/s0-db-readback.json', lambda value: value['gate'].pop('oldReservedCount')), rejected=True)
test('rejects missing old directory grants', edit('inputs/s0-db-readback.json', lambda value: value['authorization'].__setitem__('directoryGrants', [])), rejected=True)
for field in ['readAllowed', 'hostMatchesRoute', 'rootMatchesSnapshot', 'currentlyUsable']:
    test('rejects unusable old directory grant ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['authorization']['directoryGrants'][0].__setitem__(key, False)), rejected=True)
for field, invalid in [('expiresAt', '2000-01-01T00:00:00.000Z'), ('revokedAt', '2026-10-08T00:00:00.000Z'), ('capabilityRef', 'fixture:unknown'), ('capabilityVersion', 'wrong'), ('hostId', 'fixture:other-host'), ('metadataSha256', 'wrong')]:
    test('rejects changed old directory grant ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field, item=invalid: value['authorization']['directoryGrants'][0].__setitem__(key, item)), rejected=True)
test('rejects absent capability observations', edit('inputs/s0-db-readback.json', lambda value: value['authorization'].__setitem__('capabilities', [])), rejected=True)
for field in checks:
    test('rejects old capability incompatibility ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['authorization']['capabilities'][0].__setitem__(key, False)), rejected=True)
    test('rejects missing old capability check ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field: value['authorization']['capabilities'][0].pop(key)), rejected=True)
for field, invalid in [('status', 'inactive'), ('actualRunnerSha256', digest(b'wrong runner')), ('manifestInvariantDigest', 'wrong'), ('registryRecordSha256', 'wrong'), ('hostId', 'fixture:other-host'), ('workerInstanceId', ''), ('runtimeRoot', '/fixture/other-runtime')]:
    test('rejects old capability changed ' + field, edit('inputs/s0-db-readback.json', lambda value, key=field, item=invalid: value['authorization']['capabilities'][0].__setitem__(key, item)), rejected=True)
for field in ['schema', 'hostname', 'verifierSha256']:
    test('rejects wrong system observation ' + field, edit('inputs/system-tools-observed.json', lambda value, key=field: value.__setitem__(key, 'wrong')), rejected=True)
for field in ['systemToolPaths', 'systemToolIdentities']:
    test('rejects missing tool entry ' + field, edit('inputs/system-tools-observed.json', lambda value, key=field: value[key].pop('socat')), rejected=True)
test('rejects malformed observed target SHA', edit('inputs/system-tools-observed.json', lambda value: value['systemToolIdentities']['socat'].__setitem__('sha256', 'invalid')), rejected=True)
test('rejects unapproved requested system path', edit('inputs/system-tools-observed.json', lambda value: value['systemToolPaths'].__setitem__('socat', '/usr/bin/bash')), rejected=True)
test('rejects non-root tool identity', edit('inputs/system-tools-observed.json', lambda value: value['systemToolIdentities']['bash']['identity'].__setitem__('uid', 1)), rejected=True)
test('rejects writable observed tool', edit('inputs/system-tools-observed.json', lambda value: value['systemToolIdentities']['bash']['identity'].__setitem__('mode', '0777')), rejected=True)
test('rejects nonabsolute canonical target', edit('inputs/system-tools-observed.json', lambda value: value['systemToolIdentities']['bash'].__setitem__('realpath', 'relative')), rejected=True)
for name in ['candidate.tar.gz', 'context.json', bundle_name, 'source-build-inputs.json', '__PKT_PYTHON_ARCHIVE_NAME__', 'node-modules.tar.gz', 'node-modules.json', 'npm-ls.json']:
    test('rejects changed material bytes ' + name, mutate=lambda root, filename=name: (root / 'materials' / filename).write_bytes(b'changed fictitious material'), rejected=True)
test('rejects duplicate material manifest entry', edit('install/p5-materials.json', lambda value: value['files'].append(copy.deepcopy(value['files'][0]))), rejected=True)
test('rejects wrong material source revision', edit('install/p5-materials.json', lambda value: value.__setitem__('sourceHead', 'wrong')), rejected=True)
test('rejects frozen member symlink before publishing', mutate=lambda root: (root / 'signing/link').symlink_to('cloud-system-tool-bindings.mjs'), args=['--freeze-reviewed-packet', 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'], rejected=True)
test('rejects missing actual S0 input', mutate=lambda root: (root / 'inputs/s0-db-readback.json').unlink(), rejected=True)
test('rejects missing actual system tools input', mutate=lambda root: (root / 'inputs/system-tools-observed.json').unlink(), rejected=True)
test('rejects missing actual npm input', mutate=lambda root: (root / 'inputs/npm-observed.json').unlink(), rejected=True)
for field, invalid in [('schemaVersion', 'wrong'), ('passed', False), ('hostname', 'wrong'), ('actorUid', 1), ('readOnly', False), ('networkCommandsIssued', True)]:
    test('rejects npm observation ' + field, edit('inputs/npm-observed.json', lambda value, key=field, item=invalid: value.__setitem__(key, item)), rejected=True)
for field, invalid in [('path', '/fixture/node'), ('realpath', '/fixture/node'), ('version', 'v22.0.0'), ('sha256', '0' * 64)]:
    test('rejects npm Node binding ' + field, edit('inputs/npm-observed.json', lambda value, key=field, item=invalid: value['node'].__setitem__(key, item)), rejected=True)
for field, invalid in [('requestedPath', '/fixture/npm'), ('realpath', '/fixture/npm-cli.js'), ('packageRoot', '/fixture/npm'), ('version', 'not-semver'), ('packageManifestVersion', '11.0.0'), ('cliSha256', '0' * 64), ('entriesSha256', '0' * 64), ('entryCount', 0), ('bytes', 0)]:
    test('rejects npm package metadata ' + field, edit('inputs/npm-observed.json', lambda value, key=field, item=invalid: value['npm'].__setitem__(key, item)), rejected=True)
for field, invalid in [('exitCode', 1), ('stdoutSha256', 'invalid'), ('stderrSha256', 'invalid'), ('filesystemWritesAllowed', True), ('configFiles', '/fixture/npmrc'), ('offline', False), ('argv', [node_prefix + '/bin/node', npm_cli, 'install'])]:
    test('rejects npm version command ' + field, edit('inputs/npm-observed.json', lambda value, key=field, item=invalid: value['versionCommand'].__setitem__(key, item)), rejected=True)
for field, invalid in [('user', '/fixture/npmrc'), ('global', '/fixture/npmrc'), ('global', '/dev/null'), ('globalAbsentBefore', False), ('globalAbsentAfter', False), ('globalAbsentBefore', 1), ('globalAbsentAfter', 1)]:
    test('rejects unsafe npm config isolation ' + field + ':' + repr(invalid), edit('inputs/npm-observed.json', lambda value, key=field, item=invalid: value['versionCommand']['configFiles'].__setitem__(key, item)), rejected=True)
test('rejects absent npm global config nonexistence proof', edit('inputs/npm-observed.json', lambda value: value['versionCommand']['configFiles'].pop('globalAbsentBefore')), rejected=True)
test('rejects npm entries lacking root', edit('inputs/npm-observed.json', lambda value: value['npm']['entries'].pop(0)), rejected=True)
test('rejects npm package path escape', edit('inputs/npm-observed.json', lambda value: value['npm']['entries'][2].__setitem__('path', '../escape')), rejected=True)
test('rejects writable npm file', edit('inputs/npm-observed.json', lambda value: value['npm']['entries'][2].__setitem__('mode', 0o666)), rejected=True)
test('rejects non-root npm file', edit('inputs/npm-observed.json', lambda value: value['npm']['entries'][2].__setitem__('uid', 1)), rejected=True)
test('rejects broken requested npm path chain', edit('inputs/npm-observed.json', lambda value: value['npm']['requestedPathChain'].pop(0)), rejected=True)
test('rejects unsafe npm link target', edit('inputs/npm-observed.json', lambda value: value['npm']['requestedPathChain'][-1].__setitem__('realpath', '/fixture/escape')), rejected=True)
report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-binding-publication-fixture.v1', 'productionQualificationIssued': False, 'passed': all(item['passed'] for item in results), 'total': len(results), 'failed': sum(not item['passed'] for item in results), 'sourceSha256': digest(source.read_bytes()), 'systemToolObservationSource': 'actual-read-only-Hermes-files-with-fictitious-production-labels', 'results': results}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(0 if report['passed'] else 1)
