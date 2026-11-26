from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import sys

sys.dont_write_bytecode = True
if len(sys.argv) not in [2, 3] or sys.argv[1] not in ['--candidate-from-s0', '--freeze-reviewed-packet'] or (sys.argv[1] == '--freeze-reviewed-packet') != (len(sys.argv) == 3):
    raise RuntimeError('EXPLICIT___PKT_LABEL_UPPER___BINDING_PUBLICATION_REQUIRED')
root = Path(__file__).resolve().parents[1]
os.umask(0o077)
readbacks = {}
head = '__PKT_COMMIT__'
reviewed_ref = 'round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed'
recovery_contract = {'recoveryMethod': 'stopped-raw-copy-v1', 'recovery__PKT_CURRENT_SCHEMA__Id': '__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema__PKT_CURRENT_SCHEMA__'}
workspace_plan = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
strict_capability_keys = ['activeHealthy', 'versionMatchesSnapshot', 'operationsMatchSnapshot', 'scopesMatchSnapshot', 'costMatchesSnapshot', 'secretRefsMatchSnapshot', 'permissionRefsMatchSnapshot', 'declarationMatchesSnapshotExceptArtifact', 'snapshotIntegrityMatchesRunner', 'storedIntegrityMatchesDeclaration', 'runnerMatchesRecorded', 'integrityMatchesSnapshot', 'declarationInvariantMatchesSnapshot']
history_tables = ['runs', 'threads', 'thread_gateway_events', 'run_coordination_checkpoints', 'model_budget_accounts', 'model_budget_allocations', 'model_invocation_identities', 'run_payload_artifacts', 'capability_invocation_receipts', 'sandbox_execution_records', 'sandbox_release_receipts', 'sandbox_reservation_release_receipts']

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None

def positive(value):
    return type(value) is int and 0 < value <= 2 ** 53 - 1

def text(value):
    return isinstance(value, str) and len(value) > 0 and '\x00' not in value and not re.search(r'^(S0_DB:|PENDING:|REPLACE_)', value)

def absolute(value):
    return text(value) and value.startswith('/') and posixpath.normpath(value) == value and not value.startswith('//')

def relative(value):
    return text(value) and not value.startswith('/') and posixpath.normpath(value) == value and all(part not in ['', '.', '..'] for part in value.split('/'))

def date(value):
    require(text(value), '__PKT_LABEL_UPPER___INPUT_DATE_INVALID')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, '__PKT_LABEL_UPPER___INPUT_DATE_ZONE_REQUIRED')
    return parsed

def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def bytes_of(filename):
    require(filename.is_absolute() and (root == filename.parent or root in filename.parents), '__PKT_LABEL_UPPER___INPUT_OUTSIDE_PACKET')
    before = filename.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and filename.resolve() == filename, '__PKT_LABEL_UPPER___INPUT_NOT_CANONICAL:' + str(filename.relative_to(root)))
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            payload = source.read()
        require(file_identity(before) == file_identity(os.fstat(descriptor)) == file_identity(filename.lstat()), '__PKT_LABEL_UPPER___INPUT_CHANGED_DURING_READ')
    finally:
        os.close(descriptor)
    value = {'path': str(filename.relative_to(root)), 'bytes': len(payload), 'sha256': sha(payload)}
    require(filename not in readbacks or readbacks[filename] == value, '__PKT_LABEL_UPPER___INPUT_CHANGED_AFTER_VALIDATION')
    readbacks[filename] = value
    return payload

def read(name):
    require(relative(name), '__PKT_LABEL_UPPER___INPUT_NAME_INVALID')
    return json.loads(bytes_of(root / name))

def resolve(value, s0):
    if isinstance(value, str) and value.startswith('S0_DB:'):
        current = s0
        for key in value.removeprefix('S0_DB:').split('.'):
            current = current[key]
        require(current is not None and current != '', '__PKT_LABEL_UPPER___S0_VALUE_MISSING:' + value)
        return current
    if isinstance(value, dict):
        return {key: resolve(item, s0) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, s0) for item in value]
    return value

def observed_identity(value, executable):
    require(isinstance(value, dict) and set(value) == {'device', 'inode', 'uid', 'gid', 'mode'}, '__PKT_LABEL_UPPER___SYSTEM_TOOL_IDENTITY_SHAPE_INVALID')
    require(all(isinstance(value[key], str) and re.fullmatch(r'[0-9]+', value[key]) for key in ['device', 'inode']) and int(value['inode']) > 0, '__PKT_LABEL_UPPER___SYSTEM_TOOL_FILE_IDENTITY_INVALID')
    require(type(value['uid']) is int and value['uid'] == 0 and type(value['gid']) is int and value['gid'] >= 0, '__PKT_LABEL_UPPER___SYSTEM_TOOL_OWNER_INVALID')
    require(isinstance(value['mode'], str) and re.fullmatch(r'[0-7]{4}', value['mode']), '__PKT_LABEL_UPPER___SYSTEM_TOOL_MODE_INVALID')
    mode = int(value['mode'], 8)
    require(not executable or mode & 0o111 and not mode & 0o022, '__PKT_LABEL_UPPER___SYSTEM_TOOL_MODE_UNSAFE')

def system_tools(observed, binding):
    names = {'bwrap', 'socat', 'bash', 'rg'}
    require(observed['schema'] == 'himawari-cloud-system-tools-observation.v1' and observed['hostname'] == binding['host']['hostname'] == '__PKT_HOSTNAME__' and observed['platform'] == 'linux', '__PKT_LABEL_UPPER___SYSTEM_TOOLS_NOT_OBSERVED')
    require(observed['verifierSha256'] == sha(bytes_of(root / 'signing/cloud-system-tool-bindings.mjs')), '__PKT_LABEL_UPPER___SYSTEM_TOOL_VERIFIER_CHANGED')
    require(set(observed['systemToolPaths']) == names and set(observed['systemToolIdentities']) == names, '__PKT_LABEL_UPPER___SYSTEM_TOOL_SET_INVALID')
    for name in names:
        value = observed['systemToolIdentities'][name]
        require(set(value) == {'requestedPath', 'realpath', 'identity', 'sha256', 'links'}, '__PKT_LABEL_UPPER___SYSTEM_TOOL_BINDING_SHAPE_INVALID')
        require(observed['systemToolPaths'][name] == value['requestedPath'] == '/usr/bin/' + name and absolute(value['realpath']) and digest(value['sha256']), '__PKT_LABEL_UPPER___SYSTEM_TOOL_PATH_OR_DIGEST_INVALID')
        observed_identity(value['identity'], True)
        require(isinstance(value['links'], list) and len(value['links']) <= 40, '__PKT_LABEL_UPPER___SYSTEM_TOOL_LINKS_INVALID')
        for link in value['links']:
            require(set(link) == {'path', 'target', 'identity'} and absolute(link['path']) and text(link['target']), '__PKT_LABEL_UPPER___SYSTEM_TOOL_LINK_INVALID')
            observed_identity(link['identity'], False)
    for field in ['systemBwrap', 'systemBwrapIdentity']:
        require(binding['host'][field] == {'path': '/usr/bin/bwrap', 'sha256': observed['systemToolIdentities']['bwrap']['sha256']}, '__PKT_LABEL_UPPER___SYSTEM_BWRAP_OBSERVATION_CHANGED')

def authorization(s0, binding):
    observations = s0['authorization']['capabilities']
    grants = s0['authorization']['directoryGrants']
    require(isinstance(observations, list) and len(observations) > 0 and isinstance(grants, list) and len(grants) > 0, '__PKT_LABEL_UPPER___OLD_AUTHORIZATION_REQUIRED')
    capabilities = {}
    workers = set()
    for observation in observations:
        require(text(observation['capabilityRef']) and text(observation['version']) and observation['capabilityRef'] not in capabilities and observation['status'] == 'active' and positive(observation['revision']), '__PKT_LABEL_UPPER___OLD_CAPABILITY_IDENTITY_INVALID')
        require(observation['hostId'] == s0['identity']['hostId'] and text(observation['workerInstanceId']) and observation['runtimeRoot'] == binding['paths']['oldPrefix'] + '/lib/himawari-agent', '__PKT_LABEL_UPPER___OLD_CAPABILITY_RUNTIME_CHANGED')
        for field in strict_capability_keys:
            require(observation[field] is True, '__PKT_LABEL_UPPER___OLD_CAPABILITY_PREVIOUS_SHAPE_CHANGED:' + field)
        require(all(digest(observation[field]) for field in ['runnerSha256', 'actualRunnerSha256', 'manifestInvariantDigest', 'registryRecordSha256']) and observation['runnerSha256'] == observation['actualRunnerSha256'], '__PKT_LABEL_UPPER___OLD_CAPABILITY_DIGEST_INVALID')
        capabilities[observation['capabilityRef']] = observation
        workers.add(observation['workerInstanceId'])
    require(len(workers) == 1, '__PKT_LABEL_UPPER___OLD_WORKER_IDENTITY_DIFFERENT')
    require(binding.get('workspace') == workspace_plan, '__PKT_LABEL_UPPER___G90_WORKSPACE_PLAN_CHANGED')
    require(len(grants) == 1, '__PKT_LABEL_UPPER___OLD_GRANT_SET_CHANGED')
    grant = grants[0]
    require(all(text(grant[field]) for field in ['routeKey', 'grantId', 'capabilityRef', 'capabilityVersion', 'canonicalRootId']) and grant['routeKey'] == workspace_plan['routeKey'], '__PKT_LABEL_UPPER___OLD_GRANT_IDENTITY_INVALID')
    require(grant['capabilityRef'] in capabilities and grant['capabilityVersion'] == capabilities[grant['capabilityRef']]['version'] and grant['hostId'] == s0['identity']['hostId'], '__PKT_LABEL_UPPER___OLD_GRANT_CAPABILITY_CHANGED')
    require(positive(grant['revision']) and positive(grant['stateRevision']) and grant['revokedAt'] is None, '__PKT_LABEL_UPPER___OLD_GRANT_REVOKED_OR_REVISION_INVALID')
    require(all(grant[field] is True for field in ['readAllowed', 'hostMatchesRoute', 'rootMatchesSnapshot', 'currentlyUsable']) and date(grant['expiresAt']) > datetime.now(timezone.utc), '__PKT_LABEL_UPPER___OLD_GRANT_UNUSABLE')
    require(grant['grantId'] == workspace_plan['grantId'] and grant['displayPath'] == workspace_plan['canonicalPath'], '__PKT_LABEL_UPPER___G90_EXISTING_GRANT_CHANGED')
    require(absolute(grant['displayPath']) and all(isinstance(grant[field], str) and re.fullmatch(r'[0-9]+', grant[field]) for field in ['device', 'inode']) and int(grant['inode']) > 0 and digest(grant['metadataSha256']), '__PKT_LABEL_UPPER___OLD_GRANT_ROOT_INVALID')
    require(grant['pathPolicy'] == 'same_filesystem_no_links' and grant['mountPolicy'] == 'fixed_device', '__PKT_LABEL_UPPER___OLD_GRANT_POLICY_CHANGED')

def s0_host(s0, binding):
    service = s0['service']
    require(isinstance(service, dict) and set(service) == {'unitFragmentPath', 'unitFragmentSha256', 'configurationSha256', 'pairSupervisor', 'pairSupervisorSha256'}, '__PKT_LABEL_UPPER___S0_SERVICE_SHAPE_INVALID')
    require(service['unitFragmentPath'] == binding['service']['unitFragmentPath'] and digest(service['unitFragmentSha256']) and service['unitFragmentSha256'] == binding['service']['oldUnitSha256'], '__PKT_LABEL_UPPER___S0_UNIT_CHANGED')
    require(service['configurationSha256'] == binding['service']['oldConfigSha256'] and service['pairSupervisor'] == binding['service']['pairSupervisor'] and digest(service['pairSupervisorSha256']), '__PKT_LABEL_UPPER___S0_CONFIG_OR_SUPERVISOR_CHANGED')
    require(digest(service['configurationSha256']), '__PKT_LABEL_UPPER___S0_CONFIG_DIGEST_INVALID')
    grant = s0['authorization']['directoryGrants'][0]
    workspace = s0['workspace']
    owner = (binding['host']['uid'], binding['host']['gid'])
    require(isinstance(workspace, dict) and set(workspace) == {'path', 'device', 'inode', 'uid', 'gid', 'mode', 'subdirectories'} and workspace['path'] == workspace_plan['canonicalPath'], '__PKT_LABEL_UPPER___S0_WORKSPACE_READBACK_INVALID')
    require((workspace['uid'], workspace['gid']) == owner and workspace['mode'] == '0700' and (workspace['device'], workspace['inode']) == (grant['device'], grant['inode']), '__PKT_LABEL_UPPER___S0_WORKSPACE_IDENTITY_CHANGED')
    children = workspace['subdirectories']
    require(isinstance(children, list) and [child.get('name') if isinstance(child, dict) else None for child in children] == workspace_plan['subdirectories'], '__PKT_LABEL_UPPER___S0_WORKSPACE_SUBDIRECTORIES_CHANGED')
    for child in children:
        require(set(child) == {'name', 'device', 'inode', 'uid', 'gid', 'mode'} and (child['uid'], child['gid']) == owner and child['device'] == grant['device'] and isinstance(child['inode'], str) and re.fullmatch(r'[0-9]+', child['inode']) and child['inode'] != grant['inode'] and isinstance(child['mode'], str) and re.fullmatch(r'[0-7]{4}', child['mode']) is not None, '__PKT_LABEL_UPPER___S0_WORKSPACE_SUBDIRECTORIES_CHANGED')
    history = s0['history']
    require(isinstance(history, dict) and list(history) == history_tables and all(set(value) == {'rows', 'sha256'} and type(value['rows']) is int and value['rows'] >= 0 and digest(value['sha256']) for value in history.values()), '__PKT_LABEL_UPPER___S0_HISTORY_INVALID')

def old_config_anchors(s0):
    for name in ['systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py']:
        anchors = re.findall(r"^OLD_CONFIG_SHA = '([^']*)'\n", bytes_of(root / name).decode(), re.M)
        require(len(anchors) == 1 and digest(anchors[0]), '__PKT_LABEL_UPPER___OLD_CONFIG_ANCHOR_NOT_FILLED:' + name)
        require(anchors[0] == s0['service']['configurationSha256'], '__PKT_LABEL_UPPER___OLD_CONFIG_ANCHOR_CHANGED:' + name)

def npm_observation(observed, binding):
    require(observed['schemaVersion'] == 'himawari.__PKT_LABEL__-change-npm-observation.v1' and observed['passed'] is True and observed['hostname'] == binding['host']['hostname'] and type(observed['actorUid']) is int and observed['actorUid'] == 0 and observed['readOnly'] is True and observed['networkCommandsIssued'] is False, '__PKT_LABEL_UPPER___NPM_OBSERVATION_INVALID')
    prefix = '/opt/himawari/node'
    node = prefix + '/bin/node'
    package_root = prefix + '/lib/node_modules/npm'
    cli = package_root + '/bin/npm-cli.js'
    require(observed['node'] == {'path': node, 'realpath': node, 'version': binding['host']['nodeVersion'], 'sha256': binding['host']['nodeSha256']} and binding['host']['node'] == node, '__PKT_LABEL_UPPER___NPM_NODE_CHANGED')
    npm = observed['npm']
    require(npm['requestedPath'] == prefix + '/bin/npm' and npm['realpath'] == cli and npm['packageRoot'] == package_root and isinstance(npm['version'], str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', npm['version']) and npm['packageManifestVersion'] == npm['version'], '__PKT_LABEL_UPPER___NPM_LAYOUT_OR_VERSION_INVALID')
    entries = npm['entries']
    require(isinstance(entries, list) and len(entries) > 0 and positive(npm['entryCount']) and npm['entryCount'] == len(entries) and type(npm['bytes']) is int and npm['bytes'] >= 0, '__PKT_LABEL_UPPER___NPM_ENTRY_COUNT_INVALID')
    indexed = {}
    for entry in entries:
        kind = entry['type']
        common = {'path', 'uid', 'gid', 'mode', 'type'}
        expected = common if kind == 'directory' else common | {'bytes', 'sha256'} if kind == 'file' else common | {'link', 'realpath'} if kind == 'symlink' else set()
        require(set(entry) == expected and (entry['path'] == '.' or relative(entry['path'])) and entry['path'] not in indexed, '__PKT_LABEL_UPPER___NPM_ENTRY_SHAPE_INVALID')
        require(type(entry['uid']) is int and entry['uid'] == 0 and type(entry['gid']) is int and entry['gid'] == 0 and type(entry['mode']) is int and 0 <= entry['mode'] <= 0o7777 and (kind == 'symlink' or not entry['mode'] & 0o022), '__PKT_LABEL_UPPER___NPM_ENTRY_OWNER_OR_MODE_UNSAFE')
        if kind == 'file':
            require(type(entry['bytes']) is int and entry['bytes'] >= 0 and digest(entry['sha256']), '__PKT_LABEL_UPPER___NPM_FILE_DIGEST_INVALID')
        if kind == 'symlink':
            require(text(entry['link']) and absolute(entry['realpath']) and (entry['realpath'] == package_root or entry['realpath'].startswith(package_root + '/')), '__PKT_LABEL_UPPER___NPM_LINK_ESCAPES')
            target = posixpath.normpath(posixpath.join(package_root, posixpath.dirname(entry['path']), entry['link']))
            require(target == package_root or target.startswith(package_root + '/'), '__PKT_LABEL_UPPER___NPM_LINK_TEXT_ESCAPES')
        indexed[entry['path']] = entry
    require(list(indexed) == sorted(indexed) and indexed.get('.', {}).get('type') == 'directory', '__PKT_LABEL_UPPER___NPM_ENTRIES_NOT_SORTED_OR_ROOT_MISSING')
    for name in indexed:
        if name != '.':
            parent = str(PurePosixPath(name).parent)
            require(indexed.get(parent, {}).get('type') == 'directory', '__PKT_LABEL_UPPER___NPM_ENTRY_PARENT_MISSING')
    require(npm['bytes'] == sum(entry.get('bytes', 0) for entry in entries) and digest(npm['entriesSha256']) and npm['entriesSha256'] == sha(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()), '__PKT_LABEL_UPPER___NPM_TREE_DIGEST_CHANGED')
    require(indexed.get('bin/npm-cli.js', {}).get('type') == 'file' and digest(npm['cliSha256']) and npm['cliSha256'] == indexed['bin/npm-cli.js']['sha256'] and indexed.get('package.json', {}).get('type') == 'file', '__PKT_LABEL_UPPER___NPM_CLI_NOT_BOUND_TO_TREE')
    chain = npm['requestedPathChain']
    expected_paths = ['/', '/opt', '/opt/himawari', prefix, prefix + '/bin', prefix + '/bin/npm']
    require(isinstance(chain, list) and [entry['path'] for entry in chain] == expected_paths, '__PKT_LABEL_UPPER___NPM_REQUESTED_CHAIN_CHANGED')
    for index, entry in enumerate(chain):
        require(type(entry['uid']) is int and entry['uid'] == 0 and type(entry['gid']) is int and entry['gid'] == 0 and type(entry['mode']) is int and 0 <= entry['mode'] <= 0o7777 and all(isinstance(entry[field], str) and re.fullmatch(r'[0-9]+', entry[field]) for field in ['device', 'inode']) and int(entry['inode']) > 0, '__PKT_LABEL_UPPER___NPM_REQUESTED_CHAIN_IDENTITY_UNSAFE')
        if index == len(chain) - 1:
            require(entry['type'] == 'symlink' and text(entry['link']) and entry['realpath'] == cli and posixpath.normpath(posixpath.join(prefix + '/bin', entry['link'])) == cli, '__PKT_LABEL_UPPER___NPM_REQUESTED_LINK_CHANGED')
        else:
            require(entry['type'] == 'directory' and not entry['mode'] & 0o022, '__PKT_LABEL_UPPER___NPM_REQUESTED_PARENT_UNSAFE')
    command = observed['versionCommand']
    expected_argv = [node, '--experimental-permission', '--allow-fs-read=' + prefix, '--allow-fs-read=/dev/null', '--no-global-search-paths', cli, '--version', '--offline', '--ignore-scripts', '--logs-max=0', '--userconfig=/dev/null', '--globalconfig=' + prefix + '/.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig', '--cache=/dev/null']
    config_files = command['configFiles']
    require(isinstance(config_files, dict) and set(config_files) == {'user', 'global', 'globalAbsentBefore', 'globalAbsentAfter'} and config_files['user'] == '/dev/null' and config_files['global'] == prefix + '/.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig' and config_files['globalAbsentBefore'] is True and config_files['globalAbsentAfter'] is True, '__PKT_LABEL_UPPER___NPM_CONFIG_ISOLATION_NOT_PROVED')
    require(command['argv'] == expected_argv and type(command['exitCode']) is int and command['exitCode'] == 0 and digest(command['stdoutSha256']) and digest(command['stderrSha256']) and command['filesystemWritesAllowed'] is False and command['offline'] is True, '__PKT_LABEL_UPPER___NPM_READONLY_VERSION_COMMAND_CHANGED')
    date(observed['observedAt'])

def materials(binding):
    manifest = read('install/p5-materials.json')
    require(manifest['schemaVersion'] == 2 and manifest['purpose'] == 'cloud-__PKT_LABEL__-install' and manifest['nonProduction'] is False and manifest['nodeAlreadyInstalled'] is True and manifest['nodeSha256'] == binding['host']['nodeSha256'] and manifest['sourceHead'] == head, '__PKT_LABEL_UPPER___MATERIAL_MANIFEST_INVALID')
    bundle_name = 'source-' + head[:7] + '.bundle'
    expected = {bundle_name, 'candidate.tar.gz', 'context.json', '__PKT_PYTHON_ARCHIVE_NAME__', 'node-modules.tar.gz', 'node-modules.json', 'npm-ls.json'}
    require(isinstance(manifest['files'], list) and len(manifest['files']) == len(expected) and {entry['name'] for entry in manifest['files']} == expected, '__PKT_LABEL_UPPER___MATERIAL_SET_INVALID')
    indexed = {}
    for entry in manifest['files']:
        name = entry.get('sourceName', entry['name'])
        require(relative(name) and '/' not in name and positive(entry['bytes']) and digest(entry['sha256']), '__PKT_LABEL_UPPER___MATERIAL_ENTRY_INVALID')
        filename = root / 'materials' / name
        payload = bytes_of(filename)
        require(len(payload) == entry['bytes'] and sha(payload) == entry['sha256'], '__PKT_LABEL_UPPER___MATERIAL_BYTES_CHANGED:' + entry['name'])
        indexed[entry['name']] = (filename, entry)
    candidate = binding['candidate']
    for label in ['archive', 'context']:
        filename = Path(candidate[label + 'Path'])
        require(filename == indexed['candidate.tar.gz' if label == 'archive' else 'context.json'][0], '__PKT_LABEL_UPPER___CANDIDATE_MATERIAL_PATH_DIFFERENT')
        payload = bytes_of(filename)
        require(positive(candidate[label + 'Bytes']) and digest(candidate[label + 'Sha256']) and len(payload) == candidate[label + 'Bytes'] and sha(payload) == candidate[label + 'Sha256'], '__PKT_LABEL_UPPER___CANDIDATE_MATERIAL_CHANGED')
    context = json.loads(bytes_of(Path(candidate['contextPath'])))
    require(all(context[field] == head for field in ['testedSha', 'headSha', 'baseSha']), '__PKT_LABEL_UPPER___CANDIDATE_CONTEXT_REVISION_CHANGED')
    installation = binding['installationInputs']
    for label in ['sourceBundle', 'sourceModeProof']:
        name = installation[label + 'Path']
        require(relative(name), '__PKT_LABEL_UPPER___INSTALLATION_INPUT_PATH_INVALID')
        payload = bytes_of(root / name)
        require(positive(installation[label + 'Bytes']) and digest(installation[label + 'Sha256']) and len(payload) == installation[label + 'Bytes'] and sha(payload) == installation[label + 'Sha256'], '__PKT_LABEL_UPPER___INSTALLATION_INPUT_CHANGED')
    require(root / installation['sourceBundlePath'] == indexed[bundle_name][0], '__PKT_LABEL_UPPER___SOURCE_BUNDLE_PATH_DIFFERENT')

require(not os.path.lexists(root / 'inputs/bindings.json') and not os.path.lexists(root / 'freeze-manifest.json'), '__PKT_LABEL_UPPER___BINDINGS_ALREADY_PUBLISHED')
s0 = read('inputs/s0-db-readback.json')
observed = read('inputs/system-tools-observed.json')
npm = read('inputs/npm-observed.json')
binding = resolve(read('inputs/bindings.draft.json'), s0)
require('revision' not in binding, '__PKT_LABEL_UPPER___UNEXPECTED_REVISION_ANCESTRY')
maintenance = binding['maintenance']
require(all(maintenance.get(key) == value for key, value in recovery_contract.items()) and not any(re.fullmatch(r'(recovery|backup)[0-9]+Id', key) and key not in recovery_contract or key == 'retainedStepBindingSha256' for key in maintenance), '__PKT_LABEL_UPPER___RECOVERY_CONTRACT_CHANGED')
identity_keys = {'ownerId', 'agentId', 'deploymentId', 'hostId'}
authority_keys = {'authorityEpoch', 'fencingToken', 'ownerId', 'agentId', 'deploymentId', 'status'}
require(re.fullmatch(r'[0-9a-f]{40}', head) is not None, '__PKT_LABEL_UPPER___CANDIDATE_HEAD_NOT_SET')
require(s0['schemaVersion'] == 'himawari.__PKT_LABEL__-change-s0-db.v1' and binding['schemaVersion'] == 'himawari.__PKT_LABEL__-change-bindings.v1' and binding['status'] == 'candidate-awaiting-s0-db-and-freeze' and binding['d1Commit'] == binding['gateCommit'] == binding['candidate']['testedCommit'] == head, '__PKT_LABEL_UPPER___INPUT_SCHEMA_OR_CANDIDATE_INVALID')
require(set(s0['identity']) == set(binding['identity']) == identity_keys and all(text(value) for value in s0['identity'].values()) and binding['identity'] == s0['identity'], '__PKT_LABEL_UPPER___S0_IDENTITY_SET_DIFFERENT')
for key, value in [('deploymentId', 'himawari-prod-deployment'), ('hostId', 'himawari-prod-host'), ('ownerId', 'owner:first-production'), ('agentId', 'agent:first-production')]:
    require(s0['identity'][key] == value, '__PKT_LABEL_UPPER___S0_TARGET_CHANGED')
require(set(s0['authority']) == set(binding['authority']) == authority_keys and binding['authority'] == s0['authority'] and all(s0['authority'][field] == s0['identity'][field] for field in ['ownerId', 'agentId', 'deploymentId']) and s0['authority']['status'] == 'active' and positive(s0['authority']['authorityEpoch']) and positive(s0['authority']['fencingToken']), '__PKT_LABEL_UPPER___S0_AUTHORITY_SET_DIFFERENT')
require(s0['schema'] == {'current': __PKT_CURRENT_SCHEMA__, 'minimumWriter': __PKT_CURRENT_SCHEMA__, 'ledgerCount': __PKT_CURRENT_SCHEMA__, 'ledgerMax': __PKT_CURRENT_SCHEMA__} and all(type(value) is int for value in s0['schema'].values()) and set(s0['gate']) == {'oldReservedCount', 'unresolvedReservedCount', 'nonTerminalRunCount'} and all(type(value) is int for value in s0['gate'].values()) and s0['gate']['oldReservedCount'] >= 0 and s0['gate']['nonTerminalRunCount'] >= 0 and s0['gate']['unresolvedReservedCount'] == 0, '__PKT_LABEL_UPPER___S0_INITIAL_STATE_CHANGED')
require(all(text(binding['approvals'][key]) for key in ['qualificationRule', 'executionMethod']), '__PKT_LABEL_UPPER___HOST_ACCEPTANCE_DECISION_REQUIRED')
require('configurationChange' not in binding, '__PKT_LABEL_UPPER___CONFIGURATION_CHANGE_NOT_ALLOWED')
authorization(s0, binding)
s0_host(s0, binding)
old_config_anchors(s0)
system_tools(observed, binding)
npm_observation(npm, binding)
materials(binding)
unit = bytes_of(root / 'systemd/himawari-prod.service.draft')
require(b'REPLACE_' not in unit and b'S0_DB:' not in unit and b'PENDING:' not in unit, '__PKT_LABEL_UPPER___NEW_UNIT_NOT_FINAL')
require(binding['service'].get('newUnitSha256') in (None, sha(unit)), '__PKT_LABEL_UPPER___NEW_UNIT_SHA_CHANGED')
binding['service']['newUnitSha256'] = sha(unit)
binding.setdefault('inputReadbacks', {})
for name in ['inputs/s0-db-readback.json', 'inputs/system-tools-observed.json', 'inputs/npm-observed.json']:
    binding['inputReadbacks'][name] = readbacks[root / name]['sha256']
binding['status'] = 'ready-for-Claude-review'
binding['approvals'].pop('freezeManifestSha256', None)
reference = None
if sys.argv[1] == '--freeze-reviewed-packet':
    reference = sys.argv[2]
    require(reference == reviewed_ref, '__PKT_LABEL_UPPER___REVIEWED_APPROVAL_REFERENCE_REQUIRED')
    binding['status'] = 'frozen-approved'
    binding['approvals']['packageRef'] = reference
out = root / ('inputs/bindings.json' if reference else 'inputs/bindings.reviewed.json')
require(not out.exists() and not out.is_symlink() and (not reference or not (root / 'freeze-manifest.json').exists() and not (root / 'freeze-manifest.json').is_symlink()), '__PKT_LABEL_UPPER___BINDINGS_ALREADY_PUBLISHED')
data = (json.dumps(binding, ensure_ascii=False, indent=2) + '\n').encode()
files = []
if reference:
    for filename in sorted(root.rglob('*')):
        if filename.relative_to(root).parts[0] == 'run-logs':
            continue
        require(not filename.is_symlink(), '__PKT_LABEL_UPPER___FROZEN_MEMBER_SYMLINK')
        if filename.is_file() and str(filename.relative_to(root)) != 'freeze-manifest.json':
            bytes_of(filename)
            files.append(readbacks[filename])
        else:
            require(filename.is_dir(), '__PKT_LABEL_UPPER___FROZEN_MEMBER_TYPE_INVALID')
    files.append({'path': str(out.relative_to(root)), 'bytes': len(data), 'sha256': sha(data)})
    files.sort(key=lambda value: value['path'])
with out.open('xb') as stream:
    stream.write(data)
    stream.flush()
    os.fsync(stream.fileno())
require(out.read_bytes() == data, '__PKT_LABEL_UPPER___BINDING_READBACK_FAILED')
if reference:
    manifest = {'schemaVersion': 'himawari.__PKT_LABEL__-change-freeze.v1', 'status': 'frozen-approved', 'approvalRef': reference, 'files': files}
    manifest_data = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    destination = root / 'freeze-manifest.json'
    with destination.open('xb') as stream:
        stream.write(manifest_data)
        stream.flush()
        os.fsync(stream.fileno())
    require(destination.read_bytes() == manifest_data, '__PKT_LABEL_UPPER___FREEZE_MANIFEST_READBACK_FAILED')
print(json.dumps({'status': binding['status'], 'bindingsSha256': sha(data), 'filesFrozen': len(files)}))
