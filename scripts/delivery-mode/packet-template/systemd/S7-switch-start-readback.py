import hashlib
import copy
import json
import os
from pathlib import Path
import pwd
import shlex
import socket
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
os.umask(0o077)
packet = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet')
base = packet / 'systemd'
operations = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
evidence = Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
qualification = Path('/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__')
configuration = Path('/etc/himawari/config.json')
fragment = Path('/etc/systemd/system/himawari-prod.service')
node = Path('/opt/himawari/node/bin/node')
unit = 'himawari-prod.service'
old_pair_supervisor = '__PKT_OLD_OPERATIONS__/pair-supervisor.mjs'
account = pwd.getpwnam('himawari-prod')
if sys.argv[1:] != ['--approved-r2l13-__PKT_LABEL__-deployment-switch-start'] or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or sys.platform != 'linux' or os.getuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__' or (account.pw_uid, account.pw_gid) != (__PKT_SERVICE_UID__, __PKT_SERVICE_GID__) or Path(__file__).resolve() != base / 'S7-switch-start-readback.py':
    raise RuntimeError('EXPLICIT___PKT_LABEL_UPPER___DEPLOYMENT_ROOT_SWITCH_START_REQUIRED')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def regular(filename, uid=0, mode=None):
    info = filename.lstat()
    if filename.resolve() != filename or not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or info.st_nlink != 1 or mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_INPUT_UNSAFE:' + str(filename))
    return filename.read_bytes()

def directory(filename, uid, mode=None):
    info = filename.lstat()
    if filename.resolve() != filename or not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_DIRECTORY_UNSAFE:' + str(filename))

startup_phase_baseline_ms = __PKT_STARTUP_PHASE_BASELINE_MS__

STARTUP_FAILURE_TERMS = ('failed', 'failure', 'error', 'timeout', 'lost', 'quarantined', 'child_exit', 'child_error', 'retryable')
STARTUP_NON_FATAL_EVENTS = frozenset({'memory.embedding_catch_up_failed'})

def startup_failure_events(messages):
    return [value.get('event', '') for value in messages if isinstance(value, dict) and value.get('event') not in STARTUP_NON_FATAL_EVENTS and any(term in str(value.get('event', '')).lower() for term in STARTUP_FAILURE_TERMS)]

def content_audits_completed(messages):
    counts = {'sandbox_runtime.content_audit_started': {}, 'sandbox_runtime.content_audit_completed': {}, 'sandbox_runtime.content_audit_superseded': {}}
    for value in messages:
        if isinstance(value, dict) and value.get('event') in counts and isinstance(value.get('pid'), int) and not isinstance(value.get('pid'), bool):
            counts[value['event']][value['pid']] = counts[value['event']].get(value['pid'], 0) + 1
    started, completed, superseded = counts['sandbox_runtime.content_audit_started'], counts['sandbox_runtime.content_audit_completed'], counts['sandbox_runtime.content_audit_superseded']
    return len(started) >= 2 and all(completed.get(pid, 0) + superseded.get(pid, 0) >= number for pid, number in started.items())

def startup_phases(journal, invocation, baseline):
    timed = []
    for line in journal.decode().splitlines():
        entry = json.loads(line)
        if entry.get('_SYSTEMD_INVOCATION_ID') != invocation:
            continue
        try:
            message = json.loads(entry['MESSAGE'])
            at = int(entry['__REALTIME_TIMESTAMP']) / 1000
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
        if isinstance(message, dict):
            timed.append((at, message))
    spawned = [at for at, message in timed if message.get('event') == 'pair.child_spawned']
    if not spawned:
        return {'invocationId': invocation, 'phases': [], 'warnings': [], 'runtimeDigests': []}
    started = min(spawned)
    marks = [(message['step'], at) for at, message in timed if message.get('component') == 'agent-service' and message.get('event') == 'startup.step' and isinstance(message.get('step'), str)]
    marks += [(message['component'] + '-ready', at) for at, message in timed if message.get('event') == 'service.ready' and message.get('component') in ['agent-service', 'execution-worker']]
    phases, previous = [], started
    for step, at in sorted(marks, key=lambda mark: mark[1]):
        phases.append({'step': step, 'durationMs': round(at - previous), 'sinceSpawnMs': round(at - started)})
        previous = at
    warnings = [{**phase, 'baselineMs': baseline[phase['step']]} for phase in phases if phase['step'] in baseline and phase['durationMs'] > 2 * baseline[phase['step']]]
    digests = [{'reused': message.get('reused'), 'hashed': message.get('hashed'), 'durationMs': message.get('durationMs'), 'retriedWithoutCache': message.get('retriedWithoutCache')} for at, message in timed if message.get('event') == 'sandbox_runtime.digest_completed']
    warnings += [{'step': 'runtime-fingerprint-cache', **digest} for digest in digests if digest['hashed'] != 0 or digest['retriedWithoutCache'] is not False]
    warnings += [{'step': 'runtime-fingerprint-cache-missed', 'reused': message.get('reused'), 'hashed': message.get('hashed')} for at, message in timed if message.get('event') == 'sandbox_runtime.fingerprint_cache_missed']
    warnings += [{'step': 'content-audit-retrying'} for at, message in timed if message.get('event') == 'sandbox_runtime.content_audit_retrying']
    return {'invocationId': invocation, 'phases': phases, 'warnings': warnings, 'runtimeDigests': digests}

def json_file(filename, uid=0, mode=None):
    return json.loads(regular(filename, uid, mode))

def show():
    keys = ['FragmentPath', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'NRestarts', 'ExecMainStatus', 'Result', 'User', 'Group', 'UMask', 'WorkingDirectory', 'Environment', 'UnsetEnvironment', 'NoNewPrivileges', 'CapabilityBoundingSet', 'AmbientCapabilities', 'ExecStartPre', 'ExecStart', 'KillMode', 'KillSignal', 'TimeoutStopUSec', 'Restart', 'ControlGroup']
    result = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(keys)], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, text=True, timeout=15)
    return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)

def retain(filename, data, gid=0, mode=0o600):
    with filename.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.chown(filename, 0, gid, follow_symlinks=False)
    filename.chmod(mode)
    if regular(filename, 0, mode) != data or filename.stat().st_gid != gid:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_RETAINED_READBACK_FAILED')
    return {'path': str(filename), 'sha256': sha(data), 'bytes': len(data), 'uid': 0, 'gid': gid, 'mode': format(mode, '04o')}

def retain_json(filename, value, gid=0, mode=0o600):
    return retain(filename, (json.dumps(value, indent=2) + '\n').encode(), gid, mode)

def run(argv, name, service=False, stdin=None, timeout=1200):
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    if service:
        argv = ['/usr/bin/setpriv', '--reuid=__PKT_SERVICE_UID__', '--regid=__PKT_SERVICE_GID__', '--init-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '/usr/bin/env', '-i', 'HOME=/var/lib/himawari/state', 'PATH=/opt/himawari/node/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'HIMAWARI_RUNTIME_PROTECTION_FILE=' + str(operations / 'runtime-protection.json'), *map(str, argv)]
    result = subprocess.run(list(map(str, argv)), input=stdin, capture_output=True, env=environment, cwd='/var/lib/himawari/state' if service else operations, timeout=timeout, preexec_fn=lambda: os.umask(0o022 if service else 0o077))
    output = retain(evidence / (name + '.stdout'), result.stdout)
    error = retain(evidence / (name + '.stderr'), result.stderr)
    record = {'command': list(map(str, argv)), 'exitCode': result.returncode, 'stdout': output, 'stderr': error}
    orchestration['commands'].append(record)
    if result.returncode != 0:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_COMMAND_FAILED:' + name)
    return result.stdout

def verify_manifest(manifest, root):
    for line in regular(manifest).decode().splitlines():
        expected, relative = line.split('  ', 1)
        if not len(expected) == 64 or Path(relative).is_absolute() or '..' in Path(relative).parts or sha(regular(root / relative)) != expected:
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_PACKET_SHA_CHANGED:' + relative)

for filename, uid, mode in [(packet, 0, None), (base, 0, None), (operations, 0, None), (evidence, __PKT_SERVICE_UID__, 0o700), (qualification, 0, 0o750)]:
    directory(filename, uid, mode)
frozen_packet = json.loads(subprocess.check_output(['/usr/bin/python3', '-I', str(packet / 'acceptance/helpers/verify-frozen-packet.py'), '--approved-__PKT_LABEL__-frozen-packet-readback'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=120))
verify_manifest(base / 'OWNED-SHA256SUMS', base)
binding_bytes = regular(operations / 'inputs/bindings.json')
binding = json.loads(binding_bytes)
frozen_s0_bytes = regular(operations / 'inputs/s0-db-readback.json')
frozen_s0 = json.loads(frozen_s0_bytes)
if binding['schemaVersion'] != 'himawari.__PKT_LABEL__-change-bindings.v1' or binding['status'] != 'frozen-approved' or not binding['approvals']['packageRef'] or any(value is None or isinstance(value, str) and value.startswith(('S0_DB:', 'PENDING:', 'EXECUTION_OUTPUT:', 'REPLACE_')) for value in binding['identity'].values()):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_FROZEN_BINDING_REQUIRED')
fixed_paths = {'oldPrefix': '__PKT_OLD_PREFIX__', 'newPrefix': '/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__', 'config': str(configuration), 'stateRoot': '/var/lib/himawari/state', 'database': '/var/lib/himawari/state/data/product.sqlite', 'evidenceRoot': str(evidence), 'newOperations': str(operations)}
if any(binding['paths'][key] != value for key, value in fixed_paths.items()) or binding['service']['pairSupervisor'] != old_pair_supervisor or binding['service']['newPrepareHelper'] != str(operations / 'cloud-protected-prepare.mjs') or binding['service']['newRuntimeProtectionFile'] != str(operations / 'runtime-protection.json') or binding['service']['workerTokenFile'] != '/var/lib/himawari/state/secrets/worker-token.json':
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_FROZEN_PATH_CHANGED')
if sha(regular(node)) != '__PKT_NODE_SHA256__' or sha(regular(fragment)) != binding['service']['oldUnitSha256'] or binding['service']['oldUnitSha256'] != frozen_s0['service']['unitFragmentSha256']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_LOCKED_NODE_OR_ORIGINAL_UNIT_CHANGED')
configuration_bytes = regular(configuration, __PKT_SERVICE_UID__, 0o600)
original_configuration_bytes = regular(evidence / 'original-config.json', __PKT_SERVICE_UID__, 0o600)
if 'configurationChange' in binding or sha(original_configuration_bytes) != binding['service']['oldConfigSha256'] or binding['service']['oldConfigSha256'] != frozen_s0['service']['configurationSha256'] or configuration_bytes == original_configuration_bytes:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_PREPARED_CONFIG_REQUIRED_BEFORE_EXECSTARTPRE')
original_configuration = json.loads(original_configuration_bytes)
current_configuration = json.loads(configuration_bytes)
def static_root_configuration(original):
    if original.get('http', {}).get('staticRoot') != '__PKT_OLD_PREFIX__/share/control-center':
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_STATIC_ROOT_CHANGED')
    models = [entry for entry in original.get('modelDescriptors') or [] if isinstance(entry, dict) and entry.get('ref') == '__PKT_MODEL_REF__']
    if len(models) != 1 or any(type(models[0].get(key)) is not int or models[0][key] != value for key, value in (('contextWindow', __PKT_ORIGINAL_CONTEXT_WINDOW__), ('maxTokens', __PKT_ORIGINAL_MAX_TOKENS__))):
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_MODEL_DESCRIPTOR_CHANGED')
    if 'budgets' in original:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_BUDGETS_PRESENT')
    public_fetch = (original.get('runPolicy') or {}).get('publicFetch')
    if not isinstance(public_fetch, dict) or type(public_fetch.get('maximumBytes')) is not int or public_fetch['maximumBytes'] != __PKT_ORIGINAL_PUBLIC_FETCH_BYTES__:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED')
    expected = copy.deepcopy(original)
    expected['http']['staticRoot'] = '/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/share/control-center'
    next(entry for entry in expected['modelDescriptors'] if isinstance(entry, dict) and entry.get('ref') == '__PKT_MODEL_REF__').update(contextWindow=__PKT_TARGET_CONTEXT_WINDOW__, maxTokens=__PKT_TARGET_MAX_TOKENS__)
    expected['runPolicy']['publicFetch']['maximumBytes'] = __PKT_TARGET_PUBLIC_FETCH_BYTES__
    approved_embedding = json.loads('__PKT_TARGET_EMBEDDING_JSON__')
    if approved_embedding is not None:
        positions = [index for index, entry in enumerate(expected.get('modelDescriptors') or []) if isinstance(entry, dict) and entry.get('role') == 'embedding']
        if len(positions) != 1 or not isinstance(expected.get('memory'), dict):
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED')
        expected['modelDescriptors'][positions[0]] = approved_embedding
        expected['memory']['dimensions'] = approved_embedding['dimensions']
        expected['memory'].pop('minimumSimilarity', None)
        if isinstance(expected['runPolicy'].get('proactive'), dict):
            expected['runPolicy']['proactive'].pop('memoryMinimumSimilarity', None)
    approved_speech = json.loads('__PKT_TARGET_SPEECH_JSON__')
    if approved_speech is not None:
        expected['speech'] = approved_speech
    for key, value in json.loads('__PKT_TARGET_RUN_POLICY_JSON__').items():
        expected['runPolicy'][key] = value
    return expected
static_root_config = static_root_configuration(original_configuration)
static_root_config_bytes = (json.dumps(static_root_config, indent=2, ensure_ascii=False) + '\n').encode()
static_root_config_sha = sha(static_root_config_bytes)
__PKT_WHEN_FIRST_TOOLS__
if {key: value for key, value in current_configuration.items() if key != 'capabilityDeployment'} != {key: value for key, value in static_root_config.items() if key != 'capabilityDeployment'} or 'capabilityDeployment' in original_configuration or not isinstance(current_configuration.get('capabilityDeployment'), dict):
__PKT_OTHERWISE__
if {key: value for key, value in current_configuration.items() if key != 'capabilityDeployment'} != {key: value for key, value in static_root_config.items() if key != 'capabilityDeployment'} or current_configuration['capabilityDeployment'] == original_configuration['capabilityDeployment']:
__PKT_END_WHEN__
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_UNAPPROVED_CONFIG_FIELD_CHANGED')
original_properties = show()
if original_properties['ActiveState'] != 'inactive' or original_properties['MainPID'] != '0' or original_properties['FragmentPath'] != str(fragment):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_ORIGINAL_SERVICE_NOT_STOPPED')
maintenance_reports = {}
for name, action in [('s7_db_status-result.json', 'S7_DB_STATUS'), ('s7_config_apply-result.json', 'S7_CONFIG_APPLY'), ('s7_catalog_upgrade-result.json', 'S7_CATALOG_UPGRADE')]:
    report_bytes = regular(evidence / name, __PKT_SERVICE_UID__, 0o600)
    report = json.loads(report_bytes)
    if report['passed'] is not True or report['action'] != action or report['bindingSha256'] != sha(binding_bytes):
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_MAINTENANCE_NOT_VERIFIED:' + action)
    maintenance_reports[action] = (report, sha(report_bytes))
db_status_report = maintenance_reports['S7_DB_STATUS'][0]
upgrade_report, upgrade_report_sha256 = maintenance_reports['S7_CATALOG_UPGRADE']
config_apply_report = maintenance_reports['S7_CONFIG_APPLY'][0]
for report, key, filename in [(db_status_report, 'state', 's7-preswitch-state.json'), (db_status_report, 'authorization', 's7-preupgrade-authorization.json'), (config_apply_report, 'configuration', 's7-config-apply.json'), (config_apply_report, 'authorization', 's7-static-root-authorization.json'), (upgrade_report, 'catalogBefore', 's7-catalog-before.json'), (upgrade_report, 'prepare', 's7-catalog-prepare-command.json'), (upgrade_report, 'plan', 's7-catalog-plan-command.json'), (upgrade_report, 'upgrade', 's7-catalog-upgrade-command.json'), (upgrade_report, 'catalogAfter', 's7-catalog-after.json'), (upgrade_report, 'after', 's7-catalog-after__PKT_TARGET_SCHEMA__.json'), (upgrade_report, 'postUpgradeState', 's7-post-upgrade-state.json')]:
    if report[key]['path'] != str(evidence / filename) or report[key]['sha256'] != sha(regular(evidence / filename, __PKT_SERVICE_UID__, 0o600)):
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_MAINTENANCE_EVIDENCE_CHANGED:' + filename)
original_sha = binding['service']['oldConfigSha256']
config_apply = json_file(evidence / 's7-config-apply.json', __PKT_SERVICE_UID__, 0o600)
static_root_authorization = json_file(evidence / 's7-static-root-authorization.json', __PKT_SERVICE_UID__, 0o600)
if config_apply != {'path': str(configuration), 'beforeSha256': original_sha, 'afterSha256': static_root_config_sha, 'bytes': len(static_root_config_bytes)} or static_root_authorization['passed'] is not True or static_root_authorization['configurationSha256'] != static_root_config_sha or static_root_authorization['authorization'] != frozen_s0['authorization'] or upgrade_report['catalogBefore']['sha256'] == '':
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_STATIC_ROOT_CONFIGURATION_NOT_VERIFIED')
authorization = json_file(evidence / 's7-preupgrade-authorization.json', __PKT_SERVICE_UID__, 0o600)
verification = db_status_report['authorizationVerification']
if authorization['schemaVersion'] != 'himawari.__PKT_LABEL__-change-preupgrade-authorization.v1' or authorization['passed'] is not True or authorization['configurationSha256'] != original_sha or authorization['s0ReadbackSha256'] != sha(frozen_s0_bytes) or authorization['authorization'] != frozen_s0['authorization'] or authorization['workspace'] != frozen_s0['workspace'] or verification['passed'] is not True or verification['configurationSha256'] != original_sha or verification['authorizationSha256'] != db_status_report['authorization']['sha256'] or verification['checkedAt'] != authorization['checkedAt']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_PREUPGRADE_AUTHORIZATION_NOT_VERIFIED')
expected_workspace_plan = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
if binding['workspace'] != expected_workspace_plan or original_configuration['runPolicy']['coding']['grantId'] != expected_workspace_plan['grantId']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_APPROVED_WORKSPACE_PLAN_REQUIRED')
def directory_identity(filename):
    info = os.lstat(filename)
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_WORKSPACE_DIRECTORY_CHANGED')
    return {'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': format(stat.S_IMODE(info.st_mode), '04o')}
live_workspace = {'path': expected_workspace_plan['canonicalPath'], **directory_identity(expected_workspace_plan['canonicalPath']), 'subdirectories': [{'name': name, **directory_identity(expected_workspace_plan['canonicalPath'] + '/' + name)} for name in expected_workspace_plan['subdirectories']]}
if live_workspace != frozen_s0['workspace'] or (live_workspace['uid'], live_workspace['gid'], live_workspace['mode']) != (__PKT_SERVICE_UID__, __PKT_SERVICE_GID__, '0700'):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_WORKSPACE_DIRECTORY_CHANGED')
catalog = upgrade_report['catalog']
existing_refs = sorted(capability['capabilityRef'] for capability in frozen_s0['authorization']['capabilities'])
__PKT_WHEN_FIRST_TOOLS__
new_refs = sorted(__PKT_NEW_CAPABILITY_REFS_JSON__)
refs = sorted(existing_refs + new_refs)
if existing_refs or not new_refs or len(set(new_refs)) != len(new_refs) or refs != new_refs:
__PKT_OTHERWISE__
refs = existing_refs
if refs != ['himawari.pi-coding', 'himawari.public-fetch', 'himawari.public-search']:
__PKT_END_WHEN__
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_CAPABILITY_SET_CHANGED')
audit_before = catalog['upgradeAuditBefore']
if set(catalog) != {'preparedConfigurationSha256', 'snapshotSha256', 'planDigest', 'upgraded', 'upgradeAuditBefore', 'upgradeAudit'} or catalog['preparedConfigurationSha256'] != sha(configuration_bytes) or sorted(entry['capabilityRef'] for entry in catalog['upgraded']) != refs or catalog['upgradeAudit'][:len(audit_before)] != audit_before or sorted(entry['action'] + ':' + entry['targetRef'] + ':' + entry['outcome'] for entry in catalog['upgradeAudit'][len(audit_before):]) != sorted('owner.capability.upgrade:' + ref + ':completed' for ref in refs):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_CATALOG_UPGRADE_NOT_VERIFIED')
snapshot_path = '/var/lib/himawari/state/deployment/capability-deployment.json'
snapshot_bytes = regular(Path(snapshot_path), __PKT_SERVICE_UID__, 0o600)
if current_configuration['capabilityDeployment'] != {'snapshotPath': snapshot_path, 'sha256': 'sha256:' + sha(snapshot_bytes)} or catalog['snapshotSha256'] != sha(snapshot_bytes):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_PREPARED_SNAPSHOT_CHANGED')
catalog_after = json_file(evidence / 's7-catalog-after.json', __PKT_SERVICE_UID__, 0o600)
if catalog_after['authorization']['directoryGrants'] != frozen_s0['authorization']['directoryGrants'] or catalog_after['workspace'] != frozen_s0['workspace'] or sorted(item['capabilityRef'] for item in catalog_after['strict']) != refs or any(item['lifecycle'] != 'active' or item['pendingDeclaration'] is not None or item['declarationEqualsSnapshot'] is not True or item['qualificationEqualsSnapshot'] is not True or item['transitionOutcome'] != 'activated' or item['unrevokedHandles'] != 0 for item in catalog_after['strict']):
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_UPGRADED_CATALOG_NOT_STRICT')
state = json_file(evidence / 's7-preswitch-state.json', __PKT_SERVICE_UID__, 0o600)
upgraded_state = json_file(evidence / 's7-catalog-after__PKT_TARGET_SCHEMA__.json', __PKT_SERVICE_UID__, 0o600)
for value, schema in [(state, __PKT_CURRENT_SCHEMA__), (upgraded_state, __PKT_TARGET_SCHEMA__)]:
    if value['schema']['current'] != schema or value['schema']['minimumWriter'] != schema or value['gate']['unresolvedReservedCount'] != 0 or value['gate']['nonTerminalRunCount'] != 0 or value['authority'] != binding['authority']:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_SCHEMA_GATE_OR_AUTHORITY_CHANGED')
if upgraded_state['history'] != state['history']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_HISTORY_CHANGED')
for key, expected in binding['identity'].items():
    if upgraded_state['identity'].get(key, upgraded_state['authority'].get(key)) != expected:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_PRESWITCH_IDENTITY_CHANGED:' + key)
post_upgrade_state = json_file(evidence / 's7-post-upgrade-state.json', __PKT_SERVICE_UID__, 0o600)
if post_upgrade_state['schemaVersion'] != 'himawari.__PKT_LABEL__-change-post-upgrade-state.v1' or post_upgrade_state['action'] != 'S7_CATALOG_UPGRADE' or post_upgrade_state['deploymentId'] != binding['identity']['deploymentId'] or post_upgrade_state['schemaSequence'] != __PKT_TARGET_SCHEMA__ or post_upgrade_state['schemaMinimumWriter'] != __PKT_TARGET_SCHEMA__ or post_upgrade_state['migrationCount'] != __PKT_TARGET_SCHEMA__ or post_upgrade_state['integrityCheck'] != 'ok' or post_upgrade_state['foreignKeys'] != 'ok':
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_POST_UPGRADE_STATE_FAILED')
qualification_run = json_file(qualification / 'acceptance-evidence/run-report.json')
if qualification_run['passed'] is not True or qualification_run['profile'] != 'cloud-__PKT_LABEL__-change' or qualification_run['scratchDeleted'] is not True or qualification_run['scratchCleanupPending'] is not False or qualification_run['acceptanceUid'] != __PKT_SERVICE_UID__ or qualification_run['runnerErrors']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_COMPLETE_S6_REQUIRED')
probe = json_file(evidence / 's6-service-read-launch.json')
if probe['passed'] is not True or probe['productionStateAccess'] is not False or probe['systemdRunExitCode'] != 0 or probe['errors'] or probe['readback']['scratchDeleted'] is not True or probe['cgroupReadback']['remainingPids']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_SERVICE_ENVIRONMENT_READ_REQUIRED')
for filename in ['s7-orchestration.started.json', 's7-startup-preflight.json', 's7-startup-verification.json', 's7-orchestration-result.json', 's7-original-unit.service']:
    if (evidence / filename).exists() or (evidence / filename).is_symlink():
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_UNIQUE_NEW_ATTEMPT_REQUIRED')
new_fragment = regular(base / 'himawari-prod.service.draft')
if b'REPLACE_' in new_fragment or b'S0_DB:' in new_fragment:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_FINAL_UNIT_REQUIRED')
if sha(new_fragment) != binding['service']['newUnitSha256']:
    raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_UNIT_NOT_BOUND')
for filename in ['cloud-protected-prepare.mjs', 'validate-r2l6-installed.mjs', 'cloud-system-tool-bindings.mjs', 'cloud-capability-manifest.mjs', 'runtime-protection.json']:
    regular(operations / filename)
regular(Path(binding['service']['workerTokenFile']), __PKT_SERVICE_UID__, 0o600)
initial_enabled = subprocess.run(['/usr/bin/systemctl', 'is-enabled', unit], capture_output=True, text=True, timeout=15).stdout.strip()
orchestration = {'schemaVersion': 'himawari.__PKT_LABEL__-change-switch-orchestration.v1', 'passed': False, 'bindingSha256': sha(binding_bytes), 'frozenPacketReadback': frozen_packet, 'catalogUpgrade': {'reportSha256': upgrade_report_sha256, 'preparedConfigurationSha256': catalog['preparedConfigurationSha256'], 'snapshotSha256': catalog['snapshotSha256'], 'planDigest': catalog['planDigest'], 'upgraded': catalog['upgraded']}, 'startedAt': time.time(), 'commands': [], 'errors': [], 'oldProperties': original_properties, 'oldEnabledState': initial_enabled, 'unitSwitched': False, 'startRequested': False, 'rollbackPerformed': False, 'rootFreeBeforeBytes': os.statvfs('/').f_bavail * os.statvfs('/').f_frsize}
retain_json(evidence / 's7-orchestration.started.json', {'bindingSha256': sha(binding_bytes), 'startedAt': orchestration['startedAt']})
try:
    published = []
    for filename in ['pair-supervisor.mjs', 'S7-startup-readback.mjs', 'verify-doctor.mjs']:
        destination = operations / filename
        if destination.exists() or destination.is_symlink():
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_NEW_OPERATION_HELPER_REQUIRED:' + filename)
        published.append(retain(destination, regular(base / filename), __PKT_SERVICE_GID__, 0o640))
    orchestration['publishedHelpers'] = published
    preflight = json.loads(run([node, '--no-global-search-paths', operations / 'S7-startup-readback.mjs', '--preflight'], 's7-preflight', service=True))
    if preflight['passed'] is not True or preflight['signatureVerified'] is not True or preflight['liveHostVerified'] is not True or preflight['runtimeProtectionVerified'] is not True or preflight['configurationSha256'] != sha(configuration_bytes) or preflight['catalogUpgradeSha256'] != upgrade_report_sha256 or preflight['catalog']['authority'] != binding['authority'] or preflight['catalog']['upgraded'] != catalog['upgraded'] or preflight['catalog']['authorization']['directoryGrants'] != frozen_s0['authorization']['directoryGrants'] or preflight['catalog']['workspace'] != frozen_s0['workspace']:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_SIGNED_RUNTIME_PREFLIGHT_FAILED')
    retain_json(evidence / 's7-startup-preflight.json', preflight, __PKT_SERVICE_GID__, 0o640)
    orchestration['originalUnit'] = retain(evidence / 's7-original-unit.service', regular(fragment))
    destination = Path(str(fragment) + '.__PKT_LABEL__-__PKT_DATE_COMPACT__.next')
    retain(destination, new_fragment, 0, 0o644)
    os.replace(destination, fragment)
    orchestration['unitSwitched'] = True
    if regular(fragment, 0, 0o644) != new_fragment:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_UNIT_PUBLICATION_READBACK_FAILED')
    run(['/usr/bin/systemctl', 'daemon-reload'], 's7-daemon-reload', timeout=30)
    switched = show()
    expected_properties = {'FragmentPath': str(fragment), 'User': 'himawari-prod', 'Group': 'himawari-prod', 'UMask': '0022', 'WorkingDirectory': '/var/lib/himawari/state', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'AmbientCapabilities': '', 'KillMode': 'mixed', 'TimeoutStopUSec': '35s', 'Restart': 'on-failure', 'UnsetEnvironment': 'TMPDIR'}
    environment = dict(value.split('=', 1) for value in shlex.split(switched['Environment']) if '=' in value)
    expected_environment = {'PATH': '/opt/himawari/node/bin:/usr/bin:/bin', 'HOME': '/var/lib/himawari/state', 'LANG': 'C.UTF-8', 'HIMAWARI_RUNTIME_PROTECTION_FILE': str(operations / 'runtime-protection.json')}
    if any(switched[key] != value for key, value in expected_properties.items()) or environment != expected_environment or switched['ActiveState'] != 'inactive' or switched['MainPID'] != '0' or str(operations / 'cloud-protected-prepare.mjs') not in switched['ExecStartPre'] or str(operations / 'pair-supervisor.mjs') not in switched['ExecStart'] or binding['paths']['newPrefix'] not in switched['ExecStart']:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_EFFECTIVE_UNIT_CHANGED')
    orchestration['switchedProperties'] = switched
    orchestration['newUnitSha256'] = sha(new_fragment)
    orchestration['startRequested'] = True
    run(['/usr/bin/systemctl', 'start', unit], 's7-systemctl-start', timeout=60)
    deadline = time.monotonic() + 120
    while True:
        current = show()
        invocation = current['InvocationID']
        orchestration['startInvocationId'] = invocation
        if current['NRestarts'] != '0' or current['ActiveState'] not in ['active', 'activating'] or not invocation or current['InvocationID'] == original_properties['InvocationID']:
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_FIRST_START_NOT_HEALTHY')
        journal = subprocess.check_output(['/usr/bin/journalctl', '_SYSTEMD_INVOCATION_ID=' + invocation, '--output=json', '--no-pager'], timeout=15)
        messages = []
        for line in journal.decode().splitlines():
            entry = json.loads(line)
            try:
                messages.append(json.loads(entry['MESSAGE']))
            except (json.JSONDecodeError, KeyError):
                pass
        failure_events = startup_failure_events(messages)
        if failure_events:
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_STARTUP_FAILURE_EVENT')
        audits_completed = content_audits_completed(messages)
        if audits_completed and all(any(value.get('component') == component and value.get('event') == 'service.ready' for value in messages if isinstance(value, dict)) for component in ['agent-service', 'execution-worker']):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_CONTENT_AUDITS_NOT_COMPLETED' if not audits_completed else '__PKT_LABEL_UPPER___SWITCH_BOTH_READY_DEADLINE_EXCEEDED')
        time.sleep(0.2)
    orchestration['invocationId'] = invocation
    orchestration['journal'] = retain(evidence / 's7-invocation-journal.jsonl', journal)
    startup = json.loads(run([node, '--no-global-search-paths', operations / 'S7-startup-readback.mjs', '--startup', invocation], 's7-startup-readback', service=True, stdin=journal))
    if startup['schemaVersion'] != 'himawari.__PKT_LABEL__-change-startup-verification.v1' or startup['passed'] is not True or startup['signatureVerified'] is not True or startup['liveHostVerified'] is not True or startup['currentEpoch'] != binding['authority']['authorityEpoch'] or startup['currentFencingToken'] <= binding['authority']['fencingToken'] or startup['catalogUpgradeSha256'] != upgrade_report_sha256 or startup['catalog']['authority']['fencingToken'] != startup['currentFencingToken'] or startup['catalog']['upgraded'] != catalog['upgraded'] or startup['catalog']['authorization']['directoryGrants'] != frozen_s0['authorization']['directoryGrants'] or startup['catalog']['workspace'] != frozen_s0['workspace']:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_INDEPENDENT_STARTUP_READBACK_FAILED')
    doctor = run([Path(binding['paths']['newPrefix']) / 'bin/himawari', 'doctor', '--config', configuration], 's7-doctor', service=True)
    verified_doctor = json.loads(run([node, '--no-global-search-paths', operations / 'verify-doctor.mjs', '-', binding['identity']['deploymentId']], 's7-doctor-verify', service=True, stdin=doctor))
    if verified_doctor['passed'] is not True or verified_doctor['knownDefect'] != 'BL-20261008-007':
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_DOCTOR_UNEXPECTED_DEPENDENCY')
    startup['doctor'] = verified_doctor
    startup['doctorOutputSha256'] = sha(doctor)
    startup['bindingSha256'] = sha(binding_bytes)
    startup['unitFragmentSha256'] = sha(regular(fragment, 0, 0o644))
    final = show()
    if final['ActiveState'] != 'active' or final['SubState'] != 'running' or final['InvocationID'] != invocation or final['NRestarts'] != '0' or final['MainPID'] != str(startup['mainPid']) or subprocess.run(['/usr/bin/systemctl', 'is-enabled', unit], capture_output=True, text=True, timeout=15).stdout.strip() != initial_enabled:
        raise RuntimeError('__PKT_LABEL_UPPER___SWITCH_FINAL_SERVICE_CHANGED')
    orchestration['verifiedStartup'] = startup
    orchestration['finalProperties'] = final
    orchestration['passed'] = True
except Exception as error:
    orchestration['errors'].append({'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else '__PKT_LABEL_UPPER___SWITCH_EXECUTION_FAILED'})
    if orchestration['startRequested']:
        stopped = subprocess.run(['/usr/bin/systemctl', 'stop', unit], capture_output=True, timeout=45)
        orchestration['stopOnFailure'] = {'exitCode': stopped.returncode, 'properties': show()}
finally:
    captured = subprocess.run(['/usr/bin/journalctl', '--unit=' + unit, '--since=@' + str(int(orchestration['startedAt'])), '--output=json', '--no-pager'], capture_output=True, timeout=15)
    orchestration['finalJournal'] = retain(evidence / 's7-final-journal.jsonl', captured.stdout)
    if orchestration.get('startInvocationId'):
        orchestration['startupPhases'] = startup_phases(captured.stdout, orchestration['startInvocationId'], startup_phase_baseline_ms)
    if captured.returncode != 0:
        orchestration['passed'] = False
        orchestration['errors'].append({'code': '__PKT_LABEL_UPPER___SWITCH_FINAL_JOURNAL_READ_FAILED'})
    if orchestration['passed'] and not orchestration['errors']:
        orchestration['startupVerification'] = retain_json(evidence / 's7-startup-verification.json', orchestration.pop('verifiedStartup'), __PKT_SERVICE_GID__, 0o640)
    elif orchestration['startRequested'] and not orchestration.get('stopOnFailure'):
        stopped = subprocess.run(['/usr/bin/systemctl', 'stop', unit], capture_output=True, timeout=45)
        orchestration['stopOnFailure'] = {'exitCode': stopped.returncode, 'properties': show()}
    orchestration['rootFreeAfterBytes'] = os.statvfs('/').f_bavail * os.statvfs('/').f_frsize
    orchestration['passed'] = orchestration['passed'] and not orchestration['errors']
    receipt = retain_json(evidence / 's7-orchestration-result.json', orchestration)
    print(json.dumps({'passed': orchestration['passed'], 'receipt': receipt, 'rollbackPerformed': False, 'startupPhases': orchestration.get('startupPhases')}))
sys.exit(0 if orchestration['passed'] else 1)
