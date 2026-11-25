#!/usr/bin/python3
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import time

STAGE = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__')
OPS = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
EVIDENCE = Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
QUALIFICATION = Path('/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__')
STATE = Path('/var/lib/himawari/state')
CONFIG = Path('/etc/himawari/config.json')
UNIT = Path('/etc/systemd/system/himawari-prod.service')
REBUILDABLE_DIRECTORIES = ('validation/source', 'validation/python', 'validation/ui-verified')
BULK_DIRECTORIES = REBUILDABLE_DIRECTORIES + ('acceptance/runtime-tools', 'acceptance/question-12-downloads')
ARCHIVE_NAMES = {'__PKT_BUNDLE_NAME__', 'candidate.tar.gz', 'python-3.12.10.tar.gz', 'node-modules.tar.gz', '__PKT_ARTIFACT_NAME__'}
RETAINED_EXTENSIONS = {'.json', '.jsonl', '.log', '.stdout', '.stderr', '.txt', '.csv', '.md', '.patch', '.diff'}


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def file_sha(filename):
    result = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(data)
    return result.hexdigest()


def safe_file(filename, uid=0, mode=None):
    filename = Path(filename)
    info = filename.lstat()
    require(filename.resolve(strict=True) == filename and stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and not info.st_mode & 0o022 and (mode is None or stat.S_IMODE(info.st_mode) == mode), '__PKT_LABEL_UPPER___TRANSPORT_FILE_UNSAFE')
    return filename.read_bytes()


def load(filename, uid=0, mode=None):
    return json.loads(safe_file(filename, uid, mode))


def retain_json(name, value):
    filename = EVIDENCE / name
    data = (json.dumps(value, indent=2) + '\n').encode()
    with filename.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o640)
        os.fchown(stream.fileno(), 0, __PKT_SERVICE_GID__)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    require(safe_file(filename, 0, 0o640) == data, '__PKT_LABEL_UPPER___TRANSPORT_REPORT_READBACK_FAILED')
    return {'path': str(filename), 'sha256': sha(data), 'bytes': len(data)}


def validate_created_identity(root, receipt, uid=0, gid=__PKT_SERVICE_GID__, mode=0o750):
    require(receipt['schemaVersion'] == 'himawari.__PKT_LABEL__-change-owned-directories.v1' and receipt['passed'] is True and receipt['actor'] == {'uid': 0, 'hostname': '__PKT_HOSTNAME__'}, '__PKT_LABEL_UPPER___TRANSPORT_CREATION_PROOF_REQUIRED')
    matches = [entry for entry in receipt['directories'] if entry['path'] == str(root)]
    require(len(matches) == 1, '__PKT_LABEL_UPPER___TRANSPORT_CREATED_PATH_AMBIGUOUS')
    info = root.lstat()
    expected = matches[0]
    require(stat.S_ISDIR(info.st_mode) and root.resolve(strict=True) == root and info.st_uid == uid and info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode and (info.st_dev, info.st_ino) == (expected['device'], expected['inode']) and expected['uid'] == uid and expected['gid'] == gid and expected['mode'] == format(mode, '04o'), '__PKT_LABEL_UPPER___TRANSPORT_CREATED_IDENTITY_CHANGED')


def should_retain(relative):
    value = Path(relative).as_posix()
    if any(value == prefix or value.startswith(prefix + '/') for prefix in REBUILDABLE_DIRECTORIES):
        return False
    if value.startswith(('packet/materials/', 'input/')) and Path(value).name in ARCHIVE_NAMES:
        return False
    if value.startswith(('acceptance/runtime-tools/', 'acceptance/question-12-downloads/')) and Path(value).suffix not in RETAINED_EXTENSIONS:
        return False
    return True


def inventory_tree(root, allowed_uids):
    require(root.resolve(strict=True) == root and root.is_dir() and not root.is_symlink(), '__PKT_LABEL_UPPER___TRANSPORT_ROOT_UNSAFE')
    entries = []
    def visit(filename):
        info = filename.lstat()
        relative = filename.relative_to(root).as_posix()
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'unsupported'
        require(info.st_uid in allowed_uids and kind != 'unsupported', '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_OWNER_OR_TYPE_UNKNOWN')
        require(info.st_dev == root.stat().st_dev, '__PKT_LABEL_UPPER___TRANSPORT_MEMBER_OTHER_DEVICE')
        entry = {'relative': relative, 'type': kind, 'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'bytes': info.st_size, 'allocatedBytes': info.st_blocks * 512, 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns, 'retained': should_retain(relative)}
        if kind == 'directory':
            entries.append(entry)
            for child in sorted(filename.iterdir()):
                visit(child)
        elif kind == 'file':
            require(info.st_nlink == 1, '__PKT_LABEL_UPPER___TRANSPORT_HARD_LINK_UNSAFE')
            if entry['retained']:
                entry['sha256'] = file_sha(filename)
            entries.append(entry)
        else:
            require(not entry['retained'] and any(relative.startswith(prefix + '/') for prefix in BULK_DIRECTORIES), '__PKT_LABEL_UPPER___TRANSPORT_EVIDENCE_SYMLINK_UNSAFE')
            link = os.readlink(filename)
            require(not Path(link).is_absolute() and str((filename.parent / link).resolve()).startswith(str(root) + '/'), '__PKT_LABEL_UPPER___TRANSPORT_SYMLINK_OUTSIDE_OWNED_TREE')
            entry['link'] = link
            entries.append(entry)
    for filename in sorted(root.iterdir()):
        require(filename.name in ('packet', 'input', 'validation', 'acceptance'), '__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_TOP_LEVEL_MEMBER')
        visit(filename)
    return entries


def validate_no_stage_dependency(value, root, signed_bindings=None):
    if signed_bindings is not None:
        require(root == STAGE and isinstance(value, dict) and value.get('schemaVersion') == 'capability-deployment.v1' and isinstance(value.get('capabilities'), list) and value['capabilities'], '__PKT_LABEL_UPPER___TRANSPORT_SNAPSHOT_SCHEMA_INVALID')
        require(isinstance(signed_bindings, list) and len(signed_bindings) == len(value['capabilities']), '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_BINDING_SET_INVALID')
        signed_by_ref = {}
        signed_keys = set()
        for entry in signed_bindings:
            require(isinstance(entry, dict) and isinstance(entry.get('key'), str) and entry['key'] and entry['key'] not in signed_keys and isinstance(entry.get('binding'), dict), '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_BINDING_INVALID')
            binding = entry['binding']
            require(binding.get('schemaVersion') == 'sandbox-host-binding.v1' and isinstance(binding.get('capabilityRef'), str) and binding['capabilityRef'] and binding['capabilityRef'] not in signed_by_ref, '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_BINDING_INVALID')
            signed_by_ref[binding['capabilityRef']] = binding
            signed_keys.add(entry['key'])
        reviewed = copy.deepcopy(value)
        snapshot_refs = set()
        denied_input = str(STAGE / 'input')
        for entry in reviewed['capabilities']:
            require(isinstance(entry, dict) and isinstance(entry.get('manifest'), dict) and isinstance(entry.get('binding'), dict) and entry['binding'].get('kind') == 'sandbox' and isinstance(entry['binding'].get('value'), dict), '__PKT_LABEL_UPPER___TRANSPORT_SNAPSHOT_BINDING_INVALID')
            binding = entry['binding']['value']
            reference = binding.get('capabilityRef')
            require(binding.get('schemaVersion') == 'sandbox-host-binding.v1' and isinstance(reference, str) and reference not in snapshot_refs and reference in signed_by_ref and binding == signed_by_ref[reference], '__PKT_LABEL_UPPER___TRANSPORT_SNAPSHOT_SIGNED_BINDING_CHANGED')
            require(entry['manifest'].get('ref') == reference and entry['manifest'].get('version') == binding.get('capabilityVersion'), '__PKT_LABEL_UPPER___TRANSPORT_SNAPSHOT_CAPABILITY_CHANGED')
            protected = binding.get('protectedPaths')
            require(isinstance(protected, list) and all(isinstance(path, str) for path in protected) and protected.count(denied_input) == 1, '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_DENIAL_PATH_INVALID')
            binding['protectedPaths'] = [path for path in protected if path != denied_input]
            snapshot_refs.add(reference)
        require(snapshot_refs == set(signed_by_ref), '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_BINDING_SET_INVALID')
        validate_no_stage_dependency(reviewed, root)
        return
    if isinstance(value, str):
        require(str(root) not in value, '__PKT_LABEL_UPPER___TRANSPORT_PERMANENT_STAGE_DEPENDENCY')
    elif isinstance(value, dict):
        for child in value.values():
            validate_no_stage_dependency(child, root)
    elif isinstance(value, list):
        for child in value:
            validate_no_stage_dependency(child, root)


def validate_process_visibility(value):
    require(value['completeVisibleEnumeration'] is True and not value['consumers'], '__PKT_LABEL_UPPER___TRANSPORT_PROCESS_CONSUMER_OR_VISIBILITY_UNKNOWN')


def validate_references(value, root, inventory, evidence_context=False):
    if isinstance(value, dict):
        retained = evidence_context or any(value.get(key) is True for key in ('retentionRequired', 'mustRetain', 'evidenceRetentionRequired', 'retainOriginalPath'))
        for key, child in value.items():
            validate_references(child, root, inventory, retained or key.lower() in ('trace', 'stdout', 'stderr', 'screenshot', 'evidence', 'report', 'evidencefile', 'retainedevidence'))
    elif isinstance(value, list):
        for child in value:
            validate_references(child, root, inventory, evidence_context)
    elif isinstance(value, str) and (value == str(root) or value.startswith(str(root) + '/')) and evidence_context:
        relative = Path(value).relative_to(root).as_posix()
        matches = [entry for entry in inventory if entry['relative'] == relative or entry['relative'].startswith(relative + '/')]
        require(matches and all(entry['retained'] for entry in matches), '__PKT_LABEL_UPPER___TRANSPORT_UNPRESERVED_EVIDENCE_REFERENCE')


def archive_retained(root, archive, inventory, allowed_uids):
    require(inventory_tree(root, allowed_uids) == inventory, '__PKT_LABEL_UPPER___TRANSPORT_CHANGED_BEFORE_ARCHIVE')
    records = []
    for entry in inventory:
        if not entry['retained'] or entry['type'] != 'file':
            continue
        source = root / entry['relative']
        destination = archive / entry['relative']
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(archive.resolve(strict=True) == archive and destination.parent.resolve(strict=True) == destination.parent and destination.parent.stat().st_uid == os.getuid(), '__PKT_LABEL_UPPER___TRANSPORT_ARCHIVE_PATH_UNSAFE')
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(descriptor, 'rb', closefd=False) as input_file, destination.open('xb') as output:
                opened = os.fstat(descriptor)
                require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) == (entry['device'], entry['inode'], entry['bytes'], entry['mtimeNs'], entry['ctimeNs']), '__PKT_LABEL_UPPER___TRANSPORT_SOURCE_CHANGED_DURING_OPEN')
                os.fchmod(output.fileno(), 0o600)
                shutil.copyfileobj(input_file, output)
                output.flush()
                os.fsync(output.fileno())
                require(os.fstat(descriptor).st_mtime_ns == entry['mtimeNs'] and os.fstat(descriptor).st_ctime_ns == entry['ctimeNs'], '__PKT_LABEL_UPPER___TRANSPORT_SOURCE_CHANGED_DURING_ARCHIVE')
        finally:
            os.close(descriptor)
        require(file_sha(destination) == entry['sha256'] and file_sha(source) == entry['sha256'], '__PKT_LABEL_UPPER___TRANSPORT_RETAINED_BYTES_CHANGED')
        records.append({'source': str(source), 'path': str(destination), 'relative': entry['relative'], 'bytes': entry['bytes'], 'sha256': entry['sha256']})
    require(inventory_tree(root, allowed_uids) == inventory, '__PKT_LABEL_UPPER___TRANSPORT_CHANGED_AFTER_ARCHIVE')
    return records


def remove_reviewed_tree(root, inventory, allowed_uids):
    require(shutil.rmtree.avoids_symlink_attacks and inventory_tree(root, allowed_uids) == inventory, '__PKT_LABEL_UPPER___TRANSPORT_CHANGED_OR_UNSAFE_BEFORE_DELETE')
    shutil.rmtree(root)
    require(not os.path.lexists(root), '__PKT_LABEL_UPPER___TRANSPORT_DELETE_READBACK_FAILED')


def mount_survey():
    require(os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'), '__PKT_LABEL_UPPER___TRANSPORT_MOUNT_NAMESPACE_INCOMPLETE')
    entries = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        point = fields[4].replace('\\040', ' ').replace('\\011', '\t').replace('\\134', '\\')
        if point == str(STAGE) or point.startswith(str(STAGE) + '/'):
            entries.append(point)
    require(not entries, '__PKT_LABEL_UPPER___TRANSPORT_OWNED_TREE_MOUNTED')
    return {'stageMounts': entries, 'initialHostMountNamespace': True}


def process_survey():
    require(os.readlink('/proc/self/ns/pid') == os.readlink('/proc/1/ns/pid') and os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'), '__PKT_LABEL_UPPER___TRANSPORT_PROCESS_NAMESPACE_INCOMPLETE')
    proc_mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines() if line.split()[1] == '/proc']
    require(len(proc_mounts) == 1 and not any(option.startswith('hidepid=') and option != 'hidepid=0' for option in proc_mounts[0][3].split(',')), '__PKT_LABEL_UPPER___TRANSPORT_PROCESS_MOUNT_INCOMPLETE')
    unix = [line.split()[6] for line in Path('/proc/net/unix').read_text().splitlines()[1:] if len(line.split()) >= 8 and str(STAGE) in line.split()[7]]
    opaque = []
    vanished = []
    consumers = []
    pids = sorted(int(entry.name) for entry in Path('/proc').iterdir() if entry.name.isdigit())
    marker = os.fsencode(str(STAGE))
    for pid in pids:
        directory = Path('/proc') / str(pid)
        try:
            before = (directory / 'stat').read_text()
            fields = before[before.rfind(')') + 2:].split()
            status = (directory / 'status').read_text()
            uid_line = next(line for line in status.splitlines() if line.startswith('Uid:'))
            uid_values = list(map(int, uid_line.split()[1:]))
            reasons = []
            if marker in (directory / 'cmdline').read_bytes():
                reasons.append('command-path')
            for name in ('cwd', 'exe'):
                try:
                    if str(STAGE) in os.readlink(directory / name):
                        reasons.append(name + '-path')
                except FileNotFoundError:
                    pass
            for descriptor in (directory / 'fd').iterdir():
                try:
                    link = os.readlink(descriptor)
                except FileNotFoundError:
                    continue
                if str(STAGE) in link or any(link == 'socket:[' + inode + ']' for inode in unix):
                    reasons.append('file-or-socket-consumer')
            after = (directory / 'stat').read_text()
            after_fields = after[after.rfind(')') + 2:].split()
            require(fields[19] == after_fields[19], '__PKT_LABEL_UPPER___TRANSPORT_PROCESS_IDENTITY_CHANGED')
            if reasons:
                consumers.append({'pid': pid, 'parentPid': int(fields[1]), 'processGroup': int(fields[2]), 'startTicks': fields[19], 'uids': uid_values, 'reasons': sorted(set(reasons))})
        except FileNotFoundError:
            vanished.append(pid)
        except (PermissionError, ProcessLookupError, OSError):
            opaque.append(pid)
    result = {'checkedAt': utc(), 'enumeratedCount': len(pids), 'completeVisibleEnumeration': not opaque, 'opaquePids': opaque, 'vanishedDuringRead': vanished, 'consumers': consumers, 'namedUnixSocketInodes': unix}
    validate_process_visibility(result)
    return result


def phase_readbacks():
    receipts = {}
    for name, uid in (('s1-result.json', __PKT_SERVICE_UID__), ('s6-qualification-readback.json', 0), ('s6-service-read-launch.json', 0), ('s7-orchestration-result.json', 0), ('s7-startup-verification.json', 0), ('s8_readback-result.json', __PKT_SERVICE_UID__)):
        data = safe_file(EVIDENCE / name, uid)
        value = json.loads(data)
        require(value['passed'] is True, '__PKT_LABEL_UPPER___TRANSPORT_REQUIRED_PHASE_NOT_PASSED')
        receipts[name] = {'path': str(EVIDENCE / name), 'sha256': sha(data), 'value': value}
    run = load(QUALIFICATION / 'acceptance-evidence/run-report.json')
    acceptance = load(QUALIFICATION / 'acceptance-evidence/acceptance-report.json')
    require(run['passed'] is True and acceptance['passed'] is True and run['scratchDeleted'] is True and run['scratchCleanupPending'] is False and not run['runnerErrors'], '__PKT_LABEL_UPPER___TRANSPORT_S6_CLEANUP_NOT_PROVED')
    service_read = receipts['s6-service-read-launch.json']['value']
    require(service_read['productionStateAccess'] is False and service_read['systemdRunExitCode'] == 0 and service_read['readback']['scratchDeleted'] is True and not service_read['errors'] and not service_read['cgroupReadback']['remainingPids'], '__PKT_LABEL_UPPER___TRANSPORT_SERVICE_READ_NOT_PROVED')
    startup = receipts['s7-startup-verification.json']['value']
    require(startup['signatureVerified'] is True and startup['liveHostVerified'] is True, '__PKT_LABEL_UPPER___TRANSPORT_STARTUP_NOT_VERIFIED')
    s8 = receipts['s8_readback-result.json']['value']
    require(s8['action'] == 'S8_READBACK' and s8['state']['path'] == str(EVIDENCE / 's8-database-readback.json') and s8['state']['sha256'] == sha(safe_file(EVIDENCE / 's8-database-readback.json', __PKT_SERVICE_UID__, 0o600)), '__PKT_LABEL_UPPER___TRANSPORT_S8_READBACK_CHANGED')
    return receipts


def permanent_readback(binding, phases):
    configuration_bytes = safe_file(CONFIG, __PKT_SERVICE_UID__, 0o600)
    configuration = json.loads(configuration_bytes)
    snapshot_path = STATE / 'deployment/capability-deployment.json'
    snapshot_bytes = safe_file(snapshot_path, __PKT_SERVICE_UID__, 0o600)
    protection_bytes = safe_file(OPS / 'runtime-protection.json')
    unit_bytes = safe_file(UNIT)
    startup = phases['s7-startup-verification.json']['value']
    receipt_bytes = safe_file(QUALIFICATION / 'installation-receipt.json')
    require(sha(configuration_bytes) == startup['configurationSha256'] and sha(snapshot_bytes) == startup['snapshotSha256'] and configuration['capabilityDeployment'] == {'snapshotPath': str(snapshot_path), 'sha256': 'sha256:' + sha(snapshot_bytes)} and sha(receipt_bytes) == startup['receiptSha256'], '__PKT_LABEL_UPPER___TRANSPORT_CURRENT_STARTUP_BINDING_CHANGED')
    receipt = json.loads(receipt_bytes)
    require(receipt.get('schema') == 'himawari-installed-foreground-receipt.v2' and receipt.get('runtime') == binding['paths']['newPrefix'] + '/lib/himawari-agent' and receipt.get('runtimeDigest') == startup['runtimeDigest'] and isinstance(receipt.get('bindings'), list), '__PKT_LABEL_UPPER___TRANSPORT_SIGNED_RECEIPT_BINDING_INVALID')
    validate_no_stage_dependency(configuration, STAGE)
    validate_no_stage_dependency(json.loads(snapshot_bytes), STAGE, receipt['bindings'])
__PKT_WHEN_FIRST_TOOLS__
    require(sorted(entry['manifest']['ref'] for entry in json.loads(snapshot_bytes)['capabilities']) == sorted(__PKT_NEW_CAPABILITY_REFS_JSON__), '__PKT_LABEL_UPPER___TRANSPORT_FIRST_TOOLS_SET_CHANGED')
__PKT_END_WHEN__
    validate_no_stage_dependency(json.loads(protection_bytes), STAGE)
    validate_no_stage_dependency(unit_bytes.decode(), STAGE)
    require(sha(unit_bytes) == phases['s7-orchestration-result.json']['value']['newUnitSha256'], '__PKT_LABEL_UPPER___TRANSPORT_CURRENT_UNIT_CHANGED')
    helper_paths = ['cloud-protected-prepare.mjs', 'validate-r2l6-installed.mjs', 'cloud-system-tool-bindings.mjs', 'cloud-capability-manifest.mjs', 'pair-supervisor.mjs', 's0-db/read-s0-db.mjs', 'maintenance/maintenance-common.mjs', 'maintenance/workspace-grant.mjs', 'maintenance/raw-copy-recovery.mjs', 'maintenance/run-maintenance.mjs', 'maintenance/maintenance-space-sampler.mjs', 'maintenance/S9-control-files.py', 'systemd/S2-stop-and-inspect.py']
    helpers = []
    for relative in helper_paths:
        data = safe_file(OPS / relative)
        validate_no_stage_dependency(data.decode(), STAGE)
        helpers.append({'path': str(OPS / relative), 'sha256': sha(data)})
    show = subprocess.check_output(['/usr/bin/systemctl', 'show', 'himawari-prod.service', '--no-pager', '--property=ActiveState,MainPID,InvocationID,ExecStartPre,ExecStart,WorkingDirectory,Environment'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, text=True, timeout=15)
    properties = dict(line.split('=', 1) for line in show.splitlines() if '=' in line)
    require(properties['ActiveState'] == 'active' and int(properties['MainPID']) == startup['mainPid'] and properties['InvocationID'] == startup['invocationId'], '__PKT_LABEL_UPPER___TRANSPORT_CURRENT_INVOCATION_CHANGED')
    validate_no_stage_dependency(properties, STAGE)
    return {'configurationSha256': sha(configuration_bytes), 'snapshotSha256': sha(snapshot_bytes), 'receiptSha256': sha(receipt_bytes), 'signedBindingSetVerified': True, 'protectionSha256': sha(protection_bytes), 'unitSha256': sha(unit_bytes), 'helpers': helpers, 'service': properties, 'permanentQualification': str(QUALIFICATION), 'historicalSignedSourcePathsAreNotRuntimeReads': True}


def reference_survey(inventory):
    examined = []
    for root in (EVIDENCE, QUALIFICATION, OPS / 'inputs'):
        for filename in sorted(root.rglob('*')):
            if not filename.is_file() or filename.suffix not in RETAINED_EXTENSIONS or 'transport-retained-' in str(filename) or filename.name.startswith('s9-transport-'):
                continue
            info = filename.lstat()
            require(not filename.is_symlink() and info.st_uid in (0, __PKT_SERVICE_UID__) and info.st_nlink == 1, '__PKT_LABEL_UPPER___TRANSPORT_REFERENCE_SOURCE_UNSAFE')
            text = filename.read_text(errors='strict')
            if str(STAGE) not in text:
                continue
            if filename.suffix == '.json':
                validate_references(json.loads(text), STAGE, inventory)
            for line in text.splitlines():
                require(not (str(STAGE) in line and re.search('必须保留|不得删除|不可删除|唯一.{0,20}证据|must retain|do not delete|retained evidence', line, re.IGNORECASE)), '__PKT_LABEL_UPPER___TRANSPORT_EXPLICIT_RETAINED_PATH_REFERENCE')
            examined.append({'path': str(filename), 'sha256': sha(text.encode()), 'stageReferences': 'historical inputs or separately archived evidence'})
    return examined


def preflight(binding):
    creation_bytes = safe_file(EVIDENCE / 's1-owned-directories.json', 0, 0o640)
    validate_created_identity(STAGE, json.loads(creation_bytes))
    material = load(OPS / 'install/p5-materials.json')
    for entry in material['files']:
        if entry['name'] not in ARCHIVE_NAMES:
            continue
        for filename in (STAGE / 'input' / entry['name'], STAGE / 'packet/materials' / entry.get('sourceName', entry['name'])):
            info = filename.lstat()
            require(filename.resolve(strict=True) == filename and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and info.st_size == entry['bytes'] and file_sha(filename) == entry['sha256'], '__PKT_LABEL_UPPER___TRANSPORT_REBUILDABLE_ARCHIVE_CHANGED')
    source = STAGE / 'validation/source'
    source_environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'GIT_OPTIONAL_LOCKS': '0'}
    head = subprocess.check_output(['/usr/bin/git', '-C', str(source), '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], env=source_environment, text=True, timeout=15).strip()
    changed = subprocess.check_output(['/usr/bin/git', '-C', str(source), '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain', '--untracked-files=all'], env=source_environment, text=True, timeout=30)
    require(head == material['sourceHead'] and not changed, '__PKT_LABEL_UPPER___TRANSPORT_VALIDATION_SOURCE_MODIFIED')
    mounts = mount_survey()
    first = process_survey()
    inventory = inventory_tree(STAGE, {0, __PKT_SERVICE_UID__})
    phases = phase_readbacks()
    permanent = permanent_readback(binding, phases)
    references = reference_survey(inventory)
    second = process_survey()
    return {'schemaVersion': 'himawari.__PKT_LABEL__-change-transport-cleanup-plan.v1', 'passed': True, 'checkedAt': utc(), 'target': str(STAGE), 'creationProofSha256': sha(creation_bytes), 'bindingSha256': sha(safe_file(OPS / 'inputs/bindings.json')), 'helperSha256': sha(safe_file(OPS / 'install/S9-clean-transport.py')), 'rootIdentity': json.loads(creation_bytes)['directories'][0], 'inventory': inventory, 'inventorySha256': sha(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()), 'retainedBytes': sum(entry['bytes'] for entry in inventory if entry['type'] == 'file' and entry['retained']), 'treeAllocatedBytes': sum(entry['allocatedBytes'] for entry in inventory), 'phases': {name: {key: value for key, value in item.items() if key != 'value'} for name, item in phases.items()}, 'permanentDependencies': permanent, 'references': references, 'mounts': mounts, 'processSurveys': [first, second], 'deleteApprovedByThisPreflight': False}


def main():
    require(sys.argv[1:] in (['--preflight'], ['--apply']) and sys.executable == '/usr/bin/python3' and sys.flags.isolated == 1 and sys.platform == 'linux' and os.geteuid() == 0 and socket.gethostname() == '__PKT_HOSTNAME__' and Path(__file__).resolve() == OPS / 'install/S9-clean-transport.py', '__PKT_LABEL_UPPER___TRANSPORT_EXPLICIT_FIXED_TARGET_REQUIRED')
    account = pwd.getpwnam('himawari-prod')
    require((account.pw_uid, account.pw_gid) == (__PKT_SERVICE_UID__, __PKT_SERVICE_GID__), '__PKT_LABEL_UPPER___TRANSPORT_SERVICE_ACCOUNT_CHANGED')
    os.chdir('/')
    evidence_info = EVIDENCE.lstat()
    require(EVIDENCE.resolve() == EVIDENCE and evidence_info.st_uid == __PKT_SERVICE_UID__ and evidence_info.st_gid == __PKT_SERVICE_GID__ and stat.S_IMODE(evidence_info.st_mode) == 0o700, '__PKT_LABEL_UPPER___TRANSPORT_EVIDENCE_UNSAFE')
    binding = load(OPS / 'inputs/bindings.json')
    require(binding['status'] == 'frozen-approved' and binding['approvals']['packageRef'] and binding['paths']['newOperations'] == str(OPS) and binding['paths']['evidenceRoot'] == str(EVIDENCE), '__PKT_LABEL_UPPER___TRANSPORT_FROZEN_APPROVAL_REQUIRED')
    freeze = load(STAGE / 'packet/freeze-manifest.json')
    require(freeze['status'] == 'frozen-approved' and freeze['approvalRef'] == binding['approvals']['packageRef'], '__PKT_LABEL_UPPER___TRANSPORT_FROZEN_PACKET_CHANGED')
    owned_helper = [entry for entry in freeze['files'] if entry['path'] == 'install/S9-clean-transport.py']
    require(len(owned_helper) == 1 and owned_helper[0]['sha256'] == sha(safe_file(OPS / 'install/S9-clean-transport.py')), '__PKT_LABEL_UPPER___TRANSPORT_FROZEN_HELPER_CHANGED')
    suffix = str(time.time_ns())
    result = {'schemaVersion': 'himawari.__PKT_LABEL__-change-transport-cleanup-result.v1', 'mode': sys.argv[1], 'passed': False, 'startedAt': utc(), 'target': str(STAGE), 'rootFreeBeforeBytes': shutil.disk_usage('/').free, 'automaticRollbackOrServiceChange': False}
    try:
        plan = preflight(binding)
        retained_plan = retain_json('s9-transport-plan-' + suffix + '.json', plan)
        result['plan'] = retained_plan
        if sys.argv[1] == '--preflight':
            current = EVIDENCE / 's9-transport-preflight.json'
            next_file = EVIDENCE / ('s9-transport-preflight.next-' + suffix)
            with next_file.open('xb') as stream:
                os.fchmod(stream.fileno(), 0o640)
                os.fchown(stream.fileno(), 0, __PKT_SERVICE_GID__)
                stream.write(safe_file(retained_plan['path'], 0, 0o640))
                stream.flush()
                os.fsync(stream.fileno())
            if os.path.lexists(current):
                safe_file(current, 0, 0o640)
            os.replace(next_file, current)
            result['preflightPassed'] = True
            result['deletionPerformed'] = False
        else:
            reviewed = load(EVIDENCE / 's9-transport-preflight.json', 0, 0o640)
            age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(reviewed['checkedAt'].replace('Z', '+00:00'))
            require(reviewed['passed'] is True and 0 <= age.total_seconds() <= 1800 and all(reviewed[key] == plan[key] for key in ('target', 'creationProofSha256', 'bindingSha256', 'helperSha256', 'rootIdentity', 'inventorySha256', 'permanentDependencies', 'phases')), '__PKT_LABEL_UPPER___TRANSPORT_REVIEWED_PLAN_CHANGED_OR_EXPIRED')
            require(plan['retainedBytes'] <= shutil.disk_usage('/').free, '__PKT_LABEL_UPPER___TRANSPORT_ARCHIVE_SPACE_INSUFFICIENT')
            archive = EVIDENCE / ('transport-retained-' + suffix)
            archive.mkdir(mode=0o700)
            os.chown(archive, 0, __PKT_SERVICE_GID__)
            records = archive_retained(STAGE, archive, plan['inventory'], {0, __PKT_SERVICE_UID__})
            result['retainedEvidence'] = retain_json('s9-transport-retained-' + suffix + '.json', {'sourceRoot': str(STAGE), 'permanentRoot': str(archive), 'files': records, 'retainedFileCount': len(records)})
            result['finalProcessSurvey'] = process_survey()
            result['finalMountSurvey'] = mount_survey()
            permanent_readback(binding, phase_readbacks())
            validate_created_identity(STAGE, load(EVIDENCE / 's1-owned-directories.json', 0, 0o640))
            retain_json('s9-transport-before-delete-' + suffix + '.json', result)
            remove_reviewed_tree(STAGE, plan['inventory'], {0, __PKT_SERVICE_UID__})
            for record in records:
                require(file_sha(record['path']) == record['sha256'], '__PKT_LABEL_UPPER___TRANSPORT_RETAINED_EVIDENCE_LOST_AFTER_DELETE')
            permanent_readback(binding, phase_readbacks())
            result['deletionPerformed'] = True
            result['deletedPaths'] = [str(STAGE)]
            result['deletedAllocatedBytes'] = plan['treeAllocatedBytes']
        result['passed'] = True
        result['finishedAt'] = utc()
        result['rootFreeAfterBytes'] = shutil.disk_usage('/').free
        retained = retain_json('s9-transport-result-' + suffix + '.json', result)
        print(json.dumps({'passed': True, 'mode': result['mode'], 'report': retained, 'deletionPerformed': result['deletionPerformed']}))
        return 0
    except Exception as error:
        result['finishedAt'] = utc()
        text = str(error)
        result['failureCode'] = text if re.fullmatch('__PKT_LABEL_UPPER___TRANSPORT_[A-Z0-9_]+', text) else '__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_FAILURE'
        result['rootFreeAfterBytes'] = shutil.disk_usage('/').free
        retained = retain_json('s9-transport-failure-' + suffix + '.json', result)
        print(json.dumps({'passed': False, 'report': retained, 'automaticRollbackOrServiceChange': False}))
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    os.umask(0o077)
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({'passed': False, 'failureCode': str(error), 'automaticRollbackOrServiceChange': False}))
        raise SystemExit(1)
