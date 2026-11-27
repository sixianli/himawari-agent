import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys

sys.dont_write_bytecode = True

stage = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__')
packet = stage / 'packet'
qualification = Path('/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__')
runtime = Path('/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent')
account = pwd.getpwnam('himawari-prod')
if sys.platform != 'linux' or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or os.geteuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__' or sys.argv[1:] != ['--approved-s6-binding-publication'] or account.pw_uid != __PKT_SERVICE_UID__ or account.pw_gid != __PKT_SERVICE_GID__:
    raise RuntimeError('APPROVED___PKT_LABEL_UPPER___CLOUD_ROOT_BINDING_REQUIRED')
os.umask(0o077)

def directory(filename, uid, mode=None):
    info = filename.lstat()
    if not stat.S_ISDIR(info.st_mode) or filename.resolve() != filename or filename.is_symlink() or info.st_uid != uid or info.st_mode & 0o022 or mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('PUBLIC_DIRECTORY_UNSAFE:' + str(filename))
    return info

def read(filename, uid):
    before = filename.lstat()
    if not stat.S_ISREG(before.st_mode) or filename.resolve() != filename or filename.is_symlink() or before.st_uid != uid or before.st_nlink != 1 or before.st_mode & 0o022:
        raise RuntimeError('PUBLIC_FILE_UNSAFE:' + str(filename))
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as input_file:
            data = input_file.read()
        after = os.fstat(descriptor)
        current = filename.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(after) or identity(after) != identity(current):
            raise RuntimeError('PUBLIC_FILE_CHANGED_DURING_READ:' + str(filename))
        return data
    finally:
        os.close(descriptor)

def sha(data):
    return hashlib.sha256(data).hexdigest()

for filename in [stage, packet, packet / 'signing', packet / 'acceptance/cloud', qualification, qualification / 'acceptance-evidence']:
    directory(filename, 0)
manifest_path = packet / 'acceptance/cloud/cloud-inputs.json'
manifest_bytes = read(manifest_path, 0)
manifest = json.loads(manifest_bytes)
if manifest['profile'] != 'cloud-__PKT_LABEL__-change' or manifest['expectedHostname'] != socket.gethostname() or manifest['acceptanceUid'] != account.pw_uid or manifest['runtime'] != str(runtime) or manifest['sourceRoot'] != str(stage / 'validation/source') or manifest['productionQualificationIssued'] is not False or 'REPLACE_' in json.dumps(manifest):
    raise RuntimeError('ACTUAL___PKT_LABEL_UPPER___CLOUD_INPUTS_REQUIRED')
s0_path = packet / 'inputs/s0-db-readback.json'
s0_bytes = read(s0_path, 0)
s0 = json.loads(s0_bytes)
frozen_path = packet / 'inputs/bindings.json'
frozen_bytes = read(frozen_path, 0)
frozen = json.loads(frozen_bytes)
if frozen['schemaVersion'] != 'himawari.__PKT_LABEL__-change-bindings.v1' or frozen['status'] != 'frozen-approved' or s0['schemaVersion'] != 'himawari.__PKT_LABEL__-change-s0-db.v1' or any(s0['identity'][field] != frozen['identity'][field] for field in ['ownerId', 'agentId', 'hostId', 'deploymentId']) or frozen['paths']['newPrefix'] + '/lib/himawari-agent' != str(runtime) or frozen['host']['uid'] != account.pw_uid or frozen['host']['gid'] != account.pw_gid or frozen['host']['hostname'] != socket.gethostname() or frozen['d1Commit'] != manifest['candidate']['revision']:
    raise RuntimeError('FROZEN_ORIGINAL_AUTHORIZATION_REQUIRED')
host_id = s0['identity']['hostId']
deployment_id = s0['identity']['deploymentId']
if not host_id or not deployment_id:
    raise RuntimeError('FROZEN_ORIGINAL_HOST_IDENTITY_REQUIRED')
grant_validator_path = packet / 'signing/workspace-grant-binding.py'
read(grant_validator_path, 0)
grant_spec = importlib.util.spec_from_file_location('workspace_grant_binding', grant_validator_path)
grant_validator = importlib.util.module_from_spec(grant_spec)
grant_spec.loader.exec_module(grant_validator)
checked, problems = grant_validator.check_production_authorization(frozen, s0, new_capability_refs=__PKT_NEW_CAPABILITY_REFS_JSON__, read_configuration=lambda: read(Path('/etc/himawari/config.json'), 0), service_uid=account.pw_uid, service_gid=account.pw_gid)
if problems:
    raise RuntimeError(' '.join(problems))
grant_binding = checked['grantBinding']
authorization = {'directoryGrants': grant_binding['authorizedDirectoryGrants'], 'capabilities': grant_binding['capabilities']}
authorized_roots = {root['canonicalRootId']: root for root in checked['authorizedRoots']}
worker_instance_id = checked['workerInstanceId']
system_tool_paths = {name: '/usr/bin/' + name for name in ['bwrap', 'socat', 'bash', 'rg']}
system_tools_bytes = read(packet / 'inputs/system-tools-observed.json', 0)
system_tools = json.loads(system_tools_bytes)
if system_tools['verifierSha256'] != sha(read(packet / 'signing/cloud-system-tool-bindings.mjs', 0)):
    raise RuntimeError('FROZEN_SYSTEM_TOOL_VERIFIER_CHANGED')
if system_tools['schema'] != 'himawari-cloud-system-tools-observation.v1' or system_tools['hostname'] != socket.gethostname() or system_tools['platform'] != 'linux' or system_tools['systemToolPaths'] != system_tool_paths or set(system_tools['systemToolIdentities']) != set(system_tool_paths):
    raise RuntimeError('FROZEN_SYSTEM_TOOL_OBSERVATION_REQUIRED')
for name, observed in system_tools['systemToolIdentities'].items():
    if observed['requestedPath'] != system_tool_paths[name] or observed['identity']['uid'] != 0 or any(link['identity']['uid'] != 0 for link in observed['links']):
        raise RuntimeError('ROOT_SYSTEM_TOOL_IDENTITY_REQUIRED')
run_bytes = read(qualification / 'acceptance-evidence/run-report.json', 0)
acceptance_bytes = read(qualification / 'acceptance-evidence/acceptance-report.json', 0)
run = json.loads(run_bytes)
acceptance = json.loads(acceptance_bytes)
for report in [run, acceptance]:
    if report['passed'] is not True or report['profile'] != 'cloud-__PKT_LABEL__-change' or report['hostname'] != socket.gethostname() or report['acceptanceUid'] != account.pw_uid or report['productionQualificationIssued'] is not False:
        raise RuntimeError('ACTUAL_FULL___PKT_LABEL_UPPER___CLOUD_ACCEPTANCE_REQUIRED')
if run['scratchDeleted'] is not True or run['scratchCleanupPending'] is not False or run['runnerErrors'] or run['scratchCleanupProcessReadback']['liveDescendants'] or run['scratchCleanupReferenceReadback']['deleteAllowed'] is not True or run['scratchCleanupReferenceReadback']['exitCode'] != 0:
    raise RuntimeError('ACTUAL___PKT_LABEL_UPPER___CLOUD_CLEANUP_REQUIRED')
proof_sha256 = manifest['compositionEntry']['nodeModulesProof']['sha256']
if acceptance['runtime'] != str(runtime) or acceptance['sourceRoot'] != manifest['sourceRoot'] or acceptance['inputManifestSha256'] != sha(manifest_bytes) or acceptance['runtimeDigestBefore'] != acceptance['runtimeDigestAfter'] or acceptance['transportNodeModulesProofSha256'] != proof_sha256:
    raise RuntimeError('__PKT_LABEL_UPPER___ACCEPTANCE_INPUT_BINDING_MISMATCH')
if not re.fullmatch('/tmp/h[A-Za-z0-9]{4}', run['scratch']) or acceptance['compositionExecutionSourceRoot'] != run['scratch'] + '/source':
    raise RuntimeError('__PKT_LABEL_UPPER___ACCEPTANCE_WORKING_SOURCE_UNBOUND')
copy_bytes = read(qualification / 'acceptance-evidence/composition-source-copy.json', 0)
copy_report = json.loads(copy_bytes)
if copy_report != acceptance['compositionSourceCopy'] or copy_report['schemaVersion'] != 'himawari.__PKT_LABEL__-change-composition-source-copy.v1' or copy_report['inputSourceRoot'] != manifest['sourceRoot'] or copy_report['workingSourceRoot'] != acceptance['compositionExecutionSourceRoot'] or copy_report['sourceHead'] != manifest['candidate']['revision'] or copy_report['nodeModulesProofSha256'] != proof_sha256 or copy_report['ownerUid'] != account.pw_uid or any(copy_report[field] is not True for field in ['passed', 'allTrackedBytesAndModesMatchedInput', 'allDependencyEntriesMatchedProof']) or copy_report['sourceFileCount'] <= 0 or copy_report['dependencyEntryCount'] <= 0 or not re.fullmatch('[a-f0-9]{64}', copy_report['trackedSourceSha256']):
    raise RuntimeError('__PKT_LABEL_UPPER___ACCEPTANCE_WORKING_SOURCE_COPY_UNVERIFIED')
observations = {}
for name in ['pi-installed', 'composition-installed', 'network-installed', 'boundary-installed', 'worker-loss-installed', 'web-search-installed', 'r2l6-installed']:
    data = read(qualification / (name + '.json'), 0)
    if data != read(qualification / 'acceptance-evidence' / (name + '.json'), 0):
        raise RuntimeError('PUBLISHED_OBSERVATION_COPY_CHANGED:' + name)
    observations[name] = sha(data)
validator = packet / 'signing/validate-r2l6-installed.mjs'
if sha(read(validator, 0)) != manifest['r2l6ValidatorSha256']:
    raise RuntimeError('BOUND_R2L6_VALIDATOR_CHANGED')
validation = json.loads(subprocess.check_output(['/opt/himawari/node/bin/node', '--no-global-search-paths', str(validator), '--runtime', str(runtime), '--report', str(qualification / 'r2l6-installed.json')], stdin=subprocess.DEVNULL, text=True, timeout=180))
if validation['passed'] is not True or validation['runtimeDigest'] != acceptance['runtimeDigestBefore'] or validation['reportSha256'] != observations['r2l6-installed']:
    raise RuntimeError('ACTUAL_INSTALLED_R2L6_VALIDATION_REQUIRED')
acceptance_files = {}
for relative, expected in manifest['files'].items():
    relative_path = Path(relative)
    if relative_path.is_absolute() or '..' in relative_path.parts:
        raise RuntimeError('ACCEPTANCE_SOURCE_PATH_INVALID')
    filename = packet / 'acceptance/cloud' / relative
    if sha(read(filename, 0)) != expected:
        raise RuntimeError('BOUND_ACCEPTANCE_SOURCE_CHANGED:' + relative)
    acceptance_files[relative] = {'path': str(filename), 'sha256': expected}
for relative in ['signing/validate-r2l6-installed.mjs', 'signing/cloud-system-tool-bindings.mjs', 'signing/cloud-capability-manifest.mjs', 'signing/verify-capability-manifest.mjs', 'signing/collect-system-tools.mjs', 'signing/finalize-binding-inputs.py', 'signing/workspace-grant-binding.py', 'signing/cloud-seal.mjs', 'signing/cloud-protected-prepare.mjs', 'signing/publish-runtime-protection.mjs', 'signing/publish-signing-materials.py', 'signing/sign-__PKT_LABEL__.sh', 'inputs/system-tools-observed.json', 'inputs/s0-db-readback.json', 'inputs/bindings.json']:
    filename = packet / relative
    acceptance_files[relative] = {'path': str(filename), 'sha256': sha(read(filename, 0))}
acceptance_files['cloud-inputs.json'] = {'path': str(manifest_path), 'sha256': sha(manifest_bytes)}
qualification_sources = {}
for source in ['packages/runtime-pi/scripts/probe-foreground.mjs', 'packages/runtime-sandbox/scripts/qualify-production.mjs', 'packages/runtime-sandbox/scripts/probe-authorized-network.mjs', 'packages/runtime-sandbox/scripts/probe-network-boundary.mjs', 'packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs', 'packages/runtime-sandbox/scripts/probe-public-search.mjs', 'test/qualification/sandbox-install-restart-probe.mjs', 'test/qualification/sandbox-install-restart-controller.py', 'test/qualification/sandbox-install-restart-model.mjs', 'test/qualification/sandbox-install-restart-http.mjs', 'scripts/operations/workspace-lifecycle-audit.mjs']:
    relative = 'probe-source/' + source
    qualification_sources[source] = acceptance_files[relative]
workspace = Path('/var/lib/himawari/qualification-workspace-__PKT_LABEL__-__PKT_DATE_COMPACT__')
workspace_info = directory(workspace, account.pw_uid, 0o700)
if sha(read(qualification / 'acceptance-evidence/transport-node-modules-proof.json', 0)) != proof_sha256:
    raise RuntimeError('PUBLISHED_WHOLE_MODULES_PROOF_CHANGED')
transport_proof = json.loads(read(qualification / 'acceptance-evidence/transport-node-modules-proof.json', 0))
if transport_proof['sourceHead'] != manifest['candidate']['revision'] or copy_report['dependencyRoots'] != transport_proof['dependencyRoots'] or copy_report['dependencyEntryCount'] != len(transport_proof['entries']):
    raise RuntimeError('__PKT_LABEL_UPPER___ACCEPTANCE_WORKING_DEPENDENCIES_UNBOUND')
composition_contract = json.loads(read(packet / 'acceptance/cloud/composition-source-contract.json', 0))
for filename in ['composition-source-preparation.json', 'composition-source-after.json']:
    observed = json.loads(read(qualification / 'acceptance-evidence' / filename, 0))
    if observed['passed'] is not True or observed['revision'] != manifest['candidate']['revision'] or observed['sourceRoot'] != acceptance['compositionExecutionSourceRoot'] or observed['changedFiles'] != [composition_contract['fixture']] or observed['unchangedAssertionsDeadlinesAndProductImports'] is not True or observed['packageLockSha256'] != transport_proof['packageLockSha256'] or any(observed[field] != composition_contract[field] for field in ['originalFixtureSha256', 'adaptedFixtureSha256', 'patchSha256', 'entrySha256']):
        raise RuntimeError('__PKT_LABEL_UPPER___ACCEPTANCE_WORKING_SOURCE_ADAPTATION_CHANGED')
binding = {
    'schema': 'himawari-__PKT_LABEL__-cloud-binding-inputs.v1',
    'status': 'public-site-binding-not-signed-qualification',
    'expectedHostname': socket.gethostname(),
    'acceptanceUid': account.pw_uid,
    'hostId': host_id,
    'deploymentId': deployment_id,
    'workerInstanceId': worker_instance_id,
    'ownerId': s0['identity']['ownerId'],
    'agentId': s0['identity']['agentId'],
    'runtime': str(runtime),
    'privateRoot': '/var/lib/himawari/jobs',
    'workspace': str(workspace),
    'qualificationWorkspaceRef': 'workspace:himawari-prod-__PKT_LABEL__-qualification',
    'authorizedDirectoryGrants': authorization['directoryGrants'],
    'workspaceGrant': grant_binding['workspaceGrant'],
    'originalConfigurationSha256': grant_binding['originalConfigurationSha256'],
    'authorizedRoots': list(authorized_roots.values()),
    'persistentCapabilityObservations': authorization['capabilities'],
    'authorizationObservationSha256': sha(s0_bytes),
    'frozenBindingsSha256': sha(frozen_bytes),
    'snapshotPath': '/var/lib/himawari/state/deployment/capability-deployment.json',
    'capabilities': [{'ref': 'himawari.pi-coding', 'version': '1.0.0'}, {'ref': 'himawari.public-search', 'version': '1.0.0'}, {'ref': 'himawari.public-fetch', 'version': '1.0.0'}],
    'systemToolPaths': system_tool_paths,
    'systemToolIdentities': system_tools['systemToolIdentities'],
    'systemToolObservationSha256': sha(system_tools_bytes),
    'bwrapPaths': manifest['bwrapPaths'],
    'candidate': manifest['candidate'],
    'compositionSourceRoot': manifest['sourceRoot'],
    'compositionExecutionSourceRoot': acceptance['compositionExecutionSourceRoot'],
    'compositionSourceCopySha256': sha(copy_bytes),
    'qualificationSources': qualification_sources,
    'acceptanceInputsSha256': sha(manifest_bytes),
    'nodeModulesProofSha256': proof_sha256,
    'workspaceIdentity': {'path': str(workspace), 'device': str(workspace_info.st_dev), 'inode': str(workspace_info.st_ino), 'uid': workspace_info.st_uid, 'gid': workspace_info.st_gid, 'mode': '0700'},
    'acceptanceReadback': {'runReportSha256': sha(run_bytes), 'acceptanceReportSha256': sha(acceptance_bytes), 'observations': observations, 'r2l6Validation': validation},
    'acceptanceFiles': acceptance_files,
}
payload = (json.dumps(binding, indent=2) + '\n').encode()
targets = [packet / 'signing/binding-inputs.json', qualification / 'binding-inputs.json']
if any(os.path.lexists(filename) for filename in targets):
    raise RuntimeError('NEW_PUBLIC_BINDING_OUTPUTS_REQUIRED')
outputs = []
for target in targets:
    with target.open('xb') as output:
        output.write(payload)
    os.chown(target, 0, account.pw_gid, follow_symlinks=False)
    target.chmod(0o640)
    if read(target, 0) != payload or target.stat().st_gid != account.pw_gid or stat.S_IMODE(target.stat().st_mode) != 0o640:
        raise RuntimeError('PUBLISHED_BINDING_READBACK_FAILED')
    outputs.append({'path': str(target), 'bytes': len(payload), 'sha256': sha(payload), 'uid': target.stat().st_uid, 'gid': target.stat().st_gid, 'mode': '0640'})
print(json.dumps({'passed': True, 'productionQualificationIssued': False, 'hostname': socket.gethostname(), 'acceptanceUid': account.pw_uid, 'outputs': outputs, 'acceptanceInputsSha256': sha(manifest_bytes), 'systemToolObservationSha256': sha(system_tools_bytes), 'authorizationObservationSha256': sha(s0_bytes), 'workspaceIdentity': binding['workspaceIdentity'], 'authorizedRoots': binding['authorizedRoots'], 'r2l6Validation': validation}))
