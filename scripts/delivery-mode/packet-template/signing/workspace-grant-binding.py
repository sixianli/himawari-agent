import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

PLAN = {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}
GRANT_FIELDS = {'routeKey', 'grantId', 'capabilityRef', 'capabilityVersion', 'revision', 'stateRevision', 'hostId', 'canonicalRootId', 'displayPath', 'device', 'inode', 'pathPolicy', 'mountPolicy', 'expiresAt', 'revokedAt', 'readAllowed', 'hostMatchesRoute', 'rootMatchesSnapshot', 'currentlyUsable', 'metadataSha256'}
WORKSPACE_FIELDS = {'path', 'device', 'inode', 'uid', 'gid', 'mode', 'subdirectories'}
SUBDIRECTORY_FIELDS = {'name', 'device', 'inode', 'uid', 'gid', 'mode'}
AUTHORITY_FIELDS = {'deploymentId', 'ownerId', 'agentId', 'status', 'authorityEpoch', 'fencingToken'}
MAXIMUM_SAFE_INTEGER = 9007199254740991

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def equal(left, right):
    return canonical(left) == canonical(right)

def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'G90_DUPLICATE_JSON_KEY')
        value[key] = item
    return value

def parse_json(data):
    return json.loads(data, object_pairs_hook=object_pairs)

def utc(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})', value), 'G90_ZONED_TIMESTAMP_REQUIRED')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)

def safe_sha(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None

def safe_positive_integer(value):
    return type(value) is int and 0 < value <= MAXIMUM_SAFE_INTEGER

def decimal(value):
    return isinstance(value, str) and re.fullmatch('[0-9]+', value) is not None

def bind_existing_grant(frozen, s0, *, now=None):
    require(isinstance(frozen, dict) and isinstance(s0, dict), 'G90_FROZEN_INPUT_REQUIRED')
    require(equal(frozen['workspace'], PLAN), 'G90_EXACT_WORKSPACE_PLAN_REQUIRED')
    checked_at = datetime.now(timezone.utc) if now is None else now
    require(isinstance(checked_at, datetime) and checked_at.tzinfo is not None and checked_at.utcoffset() == timedelta(0), 'G90_UTC_VALIDATION_CLOCK_REQUIRED')
    authorization = s0['authorization']
    require(isinstance(authorization, dict) and isinstance(authorization['directoryGrants'], list) and isinstance(authorization['capabilities'], list), 'G90_ORIGINAL_AUTHORIZATION_REQUIRED')
    grants = authorization['directoryGrants']
    require(len(grants) == 1 and isinstance(grants[0], dict) and set(grants[0]) == GRANT_FIELDS, 'G90_ONLY_EXISTING_CODING_GRANT_SUPPORTED')
    grant = grants[0]
    require(grant['routeKey'] == PLAN['routeKey'] and grant['grantId'] == PLAN['grantId'] and grant['displayPath'] == PLAN['canonicalPath'], 'G90_EXISTING_GRANT_CHANGED')
    require(grant['hostId'] == s0['identity']['hostId'] and grant['capabilityRef'] == 'himawari.pi-coding' and grant['capabilityVersion'] == '1.0.0' and grant['pathPolicy'] == 'same_filesystem_no_links' and grant['mountPolicy'] == 'fixed_device', 'G90_EXISTING_GRANT_CONTRACT_CHANGED')
    require(grant['revokedAt'] is None and all(grant[field] is True for field in ['readAllowed', 'hostMatchesRoute', 'rootMatchesSnapshot', 'currentlyUsable']) and checked_at < utc(grant['expiresAt']), 'G90_EXISTING_GRANT_NOT_USABLE')
    require(decimal(grant['device']) and decimal(grant['inode']) and grant['canonicalRootId'] == grant['device'] + ':' + grant['inode'], 'G90_EXISTING_GRANT_ROOT_INVALID')
    require(safe_positive_integer(grant['revision']) and safe_positive_integer(grant['stateRevision']) and safe_sha(grant['metadataSha256']), 'G90_EXISTING_GRANT_RECORD_INVALID')
    workspace = s0['workspace']
    require(isinstance(workspace, dict) and set(workspace) == WORKSPACE_FIELDS and workspace['path'] == PLAN['canonicalPath'], 'G90_EXISTING_WORKSPACE_READBACK_REQUIRED')
    require(workspace['uid'] == frozen['host']['uid'] and workspace['gid'] == frozen['host']['gid'] and workspace['mode'] == '0700', 'G90_EXISTING_WORKSPACE_OWNER_OR_MODE_CHANGED')
    require(workspace['device'] == grant['device'] and workspace['inode'] == grant['inode'], 'G90_EXISTING_WORKSPACE_IDENTITY_CHANGED')
    children = workspace['subdirectories']
    require(isinstance(children, list) and [child.get('name') for child in children if isinstance(child, dict)] == PLAN['subdirectories'], 'G90_EXISTING_WORKSPACE_SUBDIRECTORIES_CHANGED')
    for child in children:
        require(set(child) == SUBDIRECTORY_FIELDS and child['uid'] == frozen['host']['uid'] and child['gid'] == frozen['host']['gid'] and child['device'] == grant['device'] and decimal(child['inode']) and child['inode'] != grant['inode'], 'G90_EXISTING_WORKSPACE_SUBDIRECTORIES_CHANGED')
    authority = s0['authority']
    require(isinstance(authority, dict) and set(authority) == AUTHORITY_FIELDS and equal(frozen['authority'], authority), 'G90_ORIGINAL_AUTHORITY_CHANGED')
    require(authority['status'] == 'active' and safe_positive_integer(authority['authorityEpoch']) and safe_positive_integer(authority['fencingToken']), 'G90_ORIGINAL_AUTHORITY_INVALID')
    for key in ['deploymentId', 'ownerId', 'agentId']:
        require(authority[key] == s0['identity'][key] == frozen['identity'][key], 'G90_ORIGINAL_AUTHORITY_IDENTITY_CHANGED')
    configuration_sha256 = frozen['service']['oldConfigSha256']
    require(safe_sha(configuration_sha256) and s0['service']['configurationSha256'] == configuration_sha256, 'G90_ORIGINAL_CONFIGURATION_CHANGED')
    authorized_root = {'canonicalRootId': grant['canonicalRootId'], 'canonicalPath': grant['displayPath'], 'device': grant['device'], 'inode': grant['inode']}
    return {'authorizedDirectoryGrants': [copy.deepcopy(grant)], 'authorizedRoots': [authorized_root], 'capabilities': copy.deepcopy(authorization['capabilities']), 'workspaceGrant': copy.deepcopy(PLAN), 'originalConfigurationSha256': configuration_sha256}

CAPABILITY_TRUE_FIELDS = ['activeHealthy', 'versionMatchesSnapshot', 'operationsMatchSnapshot', 'scopesMatchSnapshot', 'costMatchesSnapshot', 'secretRefsMatchSnapshot', 'permissionRefsMatchSnapshot', 'declarationMatchesSnapshotExceptArtifact', 'snapshotIntegrityMatchesRunner', 'storedIntegrityMatchesDeclaration', 'runnerMatchesRecorded', 'integrityMatchesSnapshot', 'declarationInvariantMatchesSnapshot']
TOOL_REFS = {'himawari.pi-coding', 'himawari.public-search', 'himawari.public-fetch'}

def problem_code(error):
    text = str(error)
    return text if isinstance(error, RuntimeError) and re.fullmatch('[A-Z0-9_]+(:[^ ]+)?', text) else type(error).__name__ + ':' + text[:200]

def current_root(grant, host_id, service_uid, service_gid, now):
    require(grant['hostId'] == host_id and grant['revokedAt'] is None and utc(grant['expiresAt']) > now and all(grant[field] is True for field in ['readAllowed', 'hostMatchesRoute', 'currentlyUsable']), 'NEW_AUTHORIZED_DIRECTORY_GRANT_UNUSABLE:' + str(grant['grantId']))
    require(grant['routeKey'] and grant['grantId'] and grant['capabilityRef'] and grant['capabilityVersion'] and grant['canonicalRootId'] and decimal(grant['device']) and decimal(grant['inode']), 'NEW_AUTHORIZED_DIRECTORY_GRANT_INVALID')
    filename = Path(grant['displayPath'])
    require(filename.is_absolute() and filename != Path('/'), 'NEW_AUTHORIZED_DIRECTORY_ROOT_INVALID')
    info = filename.lstat()
    require(stat.S_ISDIR(info.st_mode) and filename.resolve() == filename and not filename.is_symlink() and info.st_uid == service_uid and not info.st_mode & 0o022 and stat.S_IMODE(info.st_mode) == 0o700, 'PUBLIC_DIRECTORY_UNSAFE:' + str(filename))
    require(info.st_gid == service_gid and str(info.st_dev) == grant['device'] and str(info.st_ino) == grant['inode'], 'NEW_AUTHORIZED_DIRECTORY_ROOT_CHANGED')
    return {'canonicalRootId': grant['canonicalRootId'], 'canonicalPath': str(filename), 'device': str(info.st_dev), 'inode': str(info.st_ino)}

def capability_problems(capabilities, host_id, old_prefix):
    problems = []
    for observed in capabilities:
        if observed.get('version') != '1.0.0' or observed.get('status') != 'active' or any(observed.get(field) is not True for field in CAPABILITY_TRUE_FIELDS) or observed.get('runnerSha256') != observed.get('actualRunnerSha256'):
            problems.append('OLD_APPROVED_CAPABILITY_CHANGED:' + str(observed.get('capabilityRef')))
        if observed.get('hostId') != host_id or observed.get('runtimeRoot') != old_prefix + '/lib/himawari-agent' or not observed.get('workerInstanceId'):
            problems.append('OLD_APPROVED_RUNTIME_IDENTITY_CHANGED')
    return problems

def check_production_authorization(frozen, s0, *, new_capability_refs, configuration_path, service_uid, service_gid, now=None):
    checked_at = datetime.now(timezone.utc) if now is None else now
    problems = []
    result = {}
    host_id = s0['identity']['hostId']
    authorization = s0['authorization']
    try:
        result['grantBinding'] = bind_existing_grant(frozen, s0, now=checked_at)
    except Exception as error:
        problems.append(problem_code(error))
    grants = authorization.get('directoryGrants') if isinstance(authorization, dict) else None
    capabilities = authorization.get('capabilities') if isinstance(authorization, dict) else None
    if not isinstance(grants, list) or not isinstance(capabilities, list):
        problems.append('G90_ORIGINAL_AUTHORIZATION_REQUIRED')
        return result, problems
    if len(grants) != 1 or len(capabilities) != 3 - len(new_capability_refs) or {entry.get('capabilityRef') for entry in capabilities} != TOOL_REFS - set(new_capability_refs):
        problems.append('FROZEN_COMPLETE_AUTHORIZATION_REQUIRED')
    roots = {}
    for grant in grants:
        try:
            root = current_root(grant, host_id, service_uid, service_gid, checked_at)
            roots[root['canonicalRootId']] = root
        except Exception as error:
            problems.append(problem_code(error))
    result['authorizedRoots'] = list(roots.values())
    if 'grantBinding' in result and len(roots) == len(grants) and result['authorizedRoots'] != result['grantBinding']['authorizedRoots']:
        problems.append('NEW_AUTHORIZED_ROOT_CHANGED')
    problems += capability_problems(capabilities, host_id, frozen['paths']['oldPrefix'])
    worker_ids = {entry.get('workerInstanceId') for entry in capabilities}
    if not capabilities:
        try:
            configuration_bytes = read_stable(configuration_path, service_uid)
        except Exception as error:
            problems.append('ORIGINAL_CONFIGURATION_UNREADABLE:' + problem_code(error))
            return result, problems
        if digest(configuration_bytes) != frozen['service']['oldConfigSha256']:
            problems.append('ORIGINAL_CONFIGURATION_CHANGED')
        try:
            route_worker = (json.loads(configuration_bytes).get('runPolicy', {}).get('coding') or {}).get('workerInstanceId')
        except ValueError:
            route_worker = None
        if not isinstance(route_worker, str) or not route_worker:
            problems.append('FIRST_TOOLS_WORKER_IDENTITY_REQUIRED')
        worker_ids = {route_worker}
    if len(worker_ids) != 1:
        problems.append('OLD_APPROVED_WORKER_IDENTITY_AMBIGUOUS')
    else:
        result['workerInstanceId'] = next(iter(worker_ids))
    return result, problems

def read_stable(filename, uid):
    filename = Path(filename)
    before = filename.lstat()
    require(filename.is_absolute() and filename.resolve() == filename and stat.S_ISREG(before.st_mode) and not filename.is_symlink() and before.st_uid == uid and before.st_nlink == 1 and not before.st_mode & 0o022 and 0 < before.st_size <= 16777216, 'G90_VERIFICATION_FILE_UNSAFE')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            data = source.read()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(os.fstat(descriptor)) == identity(filename.lstat()), 'G90_VERIFICATION_FILE_CHANGED')
        return data
    finally:
        os.close(descriptor)

def verify_binding(arguments):
    require(len(arguments) == 4 and arguments[0] == '--verify-binding', 'G90_VERIFICATION_ARGUMENT_INVALID')
    binding = parse_json(read_stable(arguments[1], os.geteuid()))
    frozen_bytes = read_stable(arguments[2], os.geteuid())
    s0_bytes = read_stable(arguments[3], os.geteuid())
    projection = bind_existing_grant(parse_json(frozen_bytes), parse_json(s0_bytes))
    for key in ['workspaceGrant', 'originalConfigurationSha256', 'authorizedDirectoryGrants', 'authorizedRoots']:
        require(equal(binding[key], projection[key]), 'G90_SIGNED_GRANT_PROJECTION_CHANGED')
    require(equal(binding['persistentCapabilityObservations'], projection['capabilities']), 'G90_SIGNED_AUTHORIZATION_CHANGED')
    require(binding['authorizationObservationSha256'] == digest(s0_bytes), 'G90_ORIGINAL_S0_DIGEST_CHANGED')
    require(binding['frozenBindingsSha256'] == digest(frozen_bytes), 'G90_FROZEN_BINDINGS_DIGEST_CHANGED')
    return {'passed': True, 'originalConfigurationSha256': projection['originalConfigurationSha256'], 'grantId': PLAN['grantId']}

if __name__ == '__main__':
    try:
        print(json.dumps(verify_binding(sys.argv[1:]), separators=(',', ':')))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('G90_[A-Z0-9_]+', str(error)) else 'G90_GRANT_VERIFICATION_FAILED'
        sys.stderr.write(code + '\n')
        sys.exit(1)
