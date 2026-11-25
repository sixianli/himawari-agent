#!/usr/bin/python3
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import socket
import stat
import subprocess
import sys
import time

OPS = pathlib.Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__')
EVIDENCE = pathlib.Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
UNIT = pathlib.Path('/etc/systemd/system/himawari-prod.service')
CONFIG = pathlib.Path('/etc/himawari/config.json')
OLD_PREFIX = pathlib.Path('__PKT_OLD_PREFIX__')
OLD_QUALIFICATION = pathlib.Path('__PKT_OLD_QUALIFICATION__')
OLD_PROTECTION = pathlib.Path('__PKT_OLD_OPERATIONS__/runtime-protection.json')
SERVICE_UID = __PKT_SERVICE_UID__
SERVICE_GID = __PKT_SERVICE_GID__
OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(filename):
    return hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest()


def safe_path(filename, directory=False, owners=(0, SERVICE_UID)):
    filename = pathlib.Path(filename)
    info = filename.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid in owners and not info.st_mode & 0o022 and filename.resolve(strict=True) == filename, '__PKT_LABEL_UPPER___S2_PATH_UNSAFE')
    return info


def load(filename):
    safe_path(filename)
    return json.loads(pathlib.Path(filename).read_text())


def retain(name, value, owner=0, mode=0o640):
    filename = EVIDENCE / name
    with filename.open('x') as handle:
        os.fchmod(handle.fileno(), mode)
        os.fchown(handle.fileno(), owner, SERVICE_GID)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    return {'path': str(filename), 'sha256': digest(filename), 'bytes': filename.stat().st_size}


def command(args, timeout=20):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C.UTF-8', 'SYSTEMD_PAGER': 'cat'})
    require(result.returncode == 0, '__PKT_LABEL_UPPER___S2_SYSTEM_COMMAND_FAILED')
    return result.stdout


def service():
    fields = 'ActiveState,SubState,MainPID,InvocationID,ControlGroup,User,Group,UMask,NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities,KillMode,TimeoutStopUSec'
    output = command(['/usr/bin/systemctl', 'show', 'himawari-prod.service', '--no-pager', '--property=' + fields])
    return dict(line.split('=', 1) for line in output.strip().splitlines())


def root_space():
    info = os.statvfs('/')
    return {'checkedAt': utc(), 'availableBytes': info.f_bavail * info.f_frsize, 'availableInodes': info.f_favail}


def preserve_file(source, destination_name, uid=0, mode=0o600):
    source = pathlib.Path(source)
    safe_path(source)
    target = EVIDENCE / destination_name
    with source.open('rb') as input_file, target.open('xb') as output_file:
        os.fchmod(output_file.fileno(), mode)
        os.fchown(output_file.fileno(), uid, SERVICE_GID)
        shutil.copyfileobj(input_file, output_file)
        output_file.flush()
        os.fsync(output_file.fileno())
    require(digest(source) == digest(target), '__PKT_LABEL_UPPER___S2_PRESERVED_BYTES_CHANGED')
    return {'source': str(source), 'path': str(target), 'bytes': target.stat().st_size, 'sha256': digest(target), 'ownerUid': uid, 'mode': oct(mode)}


def preserve_qualification():
    safe_path(OLD_QUALIFICATION, True, (0,))
    target = EVIDENCE / 'old-public-qualification'
    target.mkdir(mode=0o700)
    os.chown(target, 0, SERVICE_GID)
    records = []
    for directory, folders, files in os.walk(OLD_QUALIFICATION, followlinks=False):
        original = pathlib.Path(directory)
        safe_path(original, True, (0,))
        for name in folders:
            safe_path(original / name, True, (0,))
        destination = target / original.relative_to(OLD_QUALIFICATION)
        if destination != target:
            destination.mkdir(mode=0o700)
            os.chown(destination, 0, SERVICE_GID)
        for name in files:
            source = original / name
            safe_path(source, owners=(0,))
            require(name != 'host-qualification-private-key.pem' and not name.endswith('.key'), '__PKT_LABEL_UPPER___S2_PRIVATE_SIGNING_MATERIAL_UNEXPECTED')
            copied = destination / name
            with source.open('rb') as input_file, copied.open('xb') as output_file:
                os.fchmod(output_file.fileno(), 0o600)
                os.fchown(output_file.fileno(), 0, SERVICE_GID)
                shutil.copyfileobj(input_file, output_file)
            require(digest(source) == digest(copied), '__PKT_LABEL_UPPER___S2_QUALIFICATION_COPY_CHANGED')
            records.append({'source': str(source), 'path': str(copied), 'sha256': digest(copied), 'bytes': copied.stat().st_size})
__PKT_WHEN_FIRST_TOOLS__
    require(records and not any(pathlib.Path(record['path']).name == 'installation-receipt.json' for record in records), '__PKT_LABEL_UPPER___S2_FIRST_TOOLS_QUALIFICATION_UNEXPECTED')
__PKT_OTHERWISE__
    require(any(pathlib.Path(record['path']).name == 'installation-receipt.json' for record in records), '__PKT_LABEL_UPPER___S2_OLD_QUALIFICATION_RECEIPT_MISSING')
__PKT_END_WHEN__
    return records


def process_survey():
    require(os.readlink('/proc/self/ns/pid') == os.readlink('/proc/1/ns/pid'), '__PKT_LABEL_UPPER___S2_PROCESS_NAMESPACE_INCOMPLETE')
    mounts = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
    proc_mounts = [line for line in mounts if ' /proc ' in line and ' - proc ' in line]
    require(len(proc_mounts) == 1 and not any(option.startswith('hidepid=') and option != 'hidepid=0' for option in proc_mounts[0].replace(' ', ',').split(',')), '__PKT_LABEL_UPPER___S2_PROC_MOUNT_UNVERIFIED')
    entries = sorted(int(item.name) for item in pathlib.Path('/proc').iterdir() if item.name.isdigit())
    records = []
    vanished = []
    opaque = []
    markers = {'oldRuntime': str(OLD_PREFIX), 'newRuntime': '/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__', 'state': '/var/lib/himawari/state', 'privateJobs': '/var/lib/himawari/jobs', 'config': str(CONFIG), 'originalJob': 'jaPmvdt2BcE7SalwB7GHbWjFPlEDIG4SU5sZrmt2eXlc'}
    require(os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'), '__PKT_LABEL_UPPER___S2_SOCKET_NAMESPACE_INCOMPLETE')
    socket_inodes = {}
    for line in pathlib.Path('/proc/net/unix').read_text().splitlines()[1:]:
        fields = line.split(maxsplit=7)
        if len(fields) == 8:
            labels = [label for label, marker in markers.items() if fields[7] == marker or fields[7].startswith(marker + '/')]
            if labels:
                socket_inodes[fields[6]] = labels
    for pid in entries:
        root = pathlib.Path('/proc') / str(pid)
        try:
            raw_stat = (root / 'stat').read_text()
            fields = raw_stat[raw_stat.rfind(')') + 2:].split()
            status = dict(line.split(':', 1) for line in (root / 'status').read_text().splitlines() if ':' in line)
            uids = [int(value) for value in status['Uid'].split()]
            cmdline = (root / 'cmdline').read_bytes().decode('utf-8', errors='replace')
            hits = {label for label, value in markers.items() if value in cmdline}
            for name in ('cwd', 'exe'):
                try:
                    value = os.readlink(root / name)
                    hits.update(label for label, marker in markers.items() if value == marker or value.startswith(marker + '/'))
                except FileNotFoundError:
                    pass
            for descriptor in (root / 'fd').iterdir():
                try:
                    value = os.readlink(descriptor).removesuffix(' (deleted)')
                    hits.update(label for label, marker in markers.items() if value == marker or value.startswith(marker + '/'))
                    if value.startswith('socket:[') and value.endswith(']') and value[8:-1] in socket_inodes:
                        hits.update('namedUnixSocket:' + label for label in socket_inodes[value[8:-1]])
                except FileNotFoundError:
                    pass
            current = (root / 'stat').read_text()
            current_fields = current[current.rfind(')') + 2:].split()
            require(fields[19] == current_fields[19], '__PKT_LABEL_UPPER___S2_PROCESS_IDENTITY_CHANGED')
            if SERVICE_UID in uids or hits:
                records.append({'pid': pid, 'state': fields[0], 'parentPid': int(fields[1]), 'processGroupId': int(fields[2]), 'startToken': fields[19], 'uids': uids, 'noNewPrivileges': status.get('NoNewPrivs', '').strip(), 'capabilityBoundingSet': status.get('CapBnd', '').strip(), 'capabilityEffective': status.get('CapEff', '').strip(), 'capabilityAmbient': status.get('CapAmb', '').strip(), 'markerMatches': sorted(hits)})
        except FileNotFoundError:
            vanished.append(pid)
        except (PermissionError, ProcessLookupError):
            opaque.append(pid)
    return {'checkedAt': utc(), 'enumeratedCount': len(entries), 'vanishedDuringRead': vanished, 'opaquePids': opaque, 'related': records, 'hostPidNamespace': os.readlink('/proc/self/ns/pid'), 'hostNetworkNamespace': os.readlink('/proc/self/ns/net'), 'originalNamedUnixSocketInodes': socket_inodes, 'completeVisibleEnumeration': not opaque}


def cgroup_survey(control_group):
    require(control_group == '/system.slice/himawari-prod.service', '__PKT_LABEL_UPPER___S2_ORIGINAL_CGROUP_UNEXPECTED')
    mounts = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
    require(os.readlink('/proc/self/ns/cgroup') == os.readlink('/proc/1/ns/cgroup'), '__PKT_LABEL_UPPER___S2_CGROUP_NAMESPACE_INCOMPLETE')
    require(any(' /sys/fs/cgroup ' in line and ' - cgroup2 ' in line for line in mounts), '__PKT_LABEL_UPPER___S2_CGROUP_NAMESPACE_UNVERIFIED')
    require(pathlib.Path('/sys/fs/cgroup/cgroup.controllers').is_file(), '__PKT_LABEL_UPPER___S2_CGROUP2_ROOT_UNAVAILABLE')
    root = pathlib.Path('/sys/fs/cgroup' + control_group)
    if not root.exists():
        return {'path': str(root), 'exists': False, 'processes': [], 'scope': 'original-v2-cgroup-and-all-descendants'}
    processes = []
    for directory, folders, files in os.walk(root, followlinks=False):
        location = pathlib.Path(directory)
        require(not location.is_symlink(), '__PKT_LABEL_UPPER___S2_CGROUP_PATH_UNSAFE')
        require('cgroup.procs' in files, '__PKT_LABEL_UPPER___S2_CGROUP_PROCS_UNAVAILABLE')
        processes.extend(int(line) for line in (location / 'cgroup.procs').read_text().splitlines())
    return {'path': str(root), 'exists': True, 'processes': sorted(set(processes)), 'scope': 'original-v2-cgroup-and-all-descendants'}


def retained_journal_metadata(invocation_id, suffix):
    arguments = ['/usr/bin/journalctl', '--unit=himawari-prod.service', '--no-pager', '--output=json', '--since=-1h']
    if invocation_id:
        arguments.append('_SYSTEMD_INVOCATION_ID=' + invocation_id)
    rows = []
    for line in command(arguments, 30).splitlines():
        record = json.loads(line)
        rows.append({key: record.get(key) for key in ('__REALTIME_TIMESTAMP', '_PID', '_UID', '_GID', '_SYSTEMD_UNIT', '_SYSTEMD_INVOCATION_ID')})
    return retain('s2-journal-metadata-' + suffix + '.json', {'scope': 'journal-envelope-metadata-only-no-message-or-environment', 'rows': rows})


def main():
    require(os.geteuid() == 0 and socket.gethostname() == '__PKT_HOSTNAME__', '__PKT_LABEL_UPPER___S2_HOST_OR_ACTOR_INVALID')
    require(sys.argv[1:] in ([], ['--inspect-only']), '__PKT_LABEL_UPPER___S2_ARGUMENT_INVALID')
    inspect_only = sys.argv[1:] == ['--inspect-only']
    account = pwd.getpwnam('himawari-prod')
    require((account.pw_uid, account.pw_gid) == (SERVICE_UID, SERVICE_GID), '__PKT_LABEL_UPPER___S2_SERVICE_ACCOUNT_CHANGED')
    evidence_info = safe_path(EVIDENCE, True)
    require(evidence_info.st_uid == SERVICE_UID and stat.S_IMODE(evidence_info.st_mode) == 0o700, '__PKT_LABEL_UPPER___S2_EVIDENCE_UNSAFE')
    binding = load(OPS / 'inputs/bindings.json')
    s0 = load(OPS / 'inputs/s0-db-readback.json')
    require(binding['status'] == 'frozen-approved' and bool(binding['approvals']['packageRef']), '__PKT_LABEL_UPPER___S2_PACKAGE_NOT_FROZEN')
    for key, value in s0['identity'].items():
        require(binding['identity'].get(key) == value, '__PKT_LABEL_UPPER___S2_S0_BINDING_CHANGED')
    require(binding['service']['oldConfigSha256'] == OLD_CONFIG_SHA and binding['service']['oldUnitSha256'] == s0['service']['unitFragmentSha256'], '__PKT_LABEL_UPPER___S2_S0_SERVICE_BINDING_CHANGED')
    current_unit_sha = digest(UNIT)
    require(current_unit_sha == binding['service']['oldUnitSha256'] or (inspect_only and current_unit_sha == binding['service']['newUnitSha256']), '__PKT_LABEL_UPPER___S2_KNOWN_UNIT_REQUIRED')
    initial_service = service()
    require(initial_service['User'] == 'himawari-prod' and initial_service['NoNewPrivileges'] == 'yes' and initial_service['CapabilityBoundingSet'] == '' and initial_service['AmbientCapabilities'] == '' and initial_service['UMask'] == '0022', '__PKT_LABEL_UPPER___S2_ORIGINAL_SERVICE_BOUNDARY_CHANGED')
    suffix = str(time.time_ns())
    report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-stop.v1', 'mode': 'inspect-only' if inspect_only else 'stop', 'startedAt': utc(), 'actor': {'uid': 0, 'account': 'root', 'hostname': socket.gethostname()}, 'spaceBefore': root_space(), 'initialService': initial_service, 'passed': False}
    retain('s2-started-' + suffix + '.json', report)
    try:
        if not inspect_only:
            require(initial_service['ActiveState'] == 'active' and int(initial_service['MainPID']) > 0, '__PKT_LABEL_UPPER___S2_INITIAL_SERVICE_NOT_ACTIVE')
            require(digest(CONFIG) == OLD_CONFIG_SHA, '__PKT_LABEL_UPPER___S2_OLD_CONFIG_CHANGED')
            safe_path(UNIT, owners=(0,))
            config_info = safe_path(CONFIG, owners=(SERVICE_UID,))
            require(stat.S_IMODE(config_info.st_mode) == 0o600, '__PKT_LABEL_UPPER___S2_CONFIG_PERMISSION_CHANGED')
            initial_processes = process_survey()
            require(initial_processes['completeVisibleEnumeration'], '__PKT_LABEL_UPPER___S2_INITIAL_PROCESS_VISIBILITY_INCOMPLETE')
            for process in initial_processes['related']:
                if SERVICE_UID in process['uids']:
                    require(process['noNewPrivileges'] == '1' and int(process['capabilityEffective'] or '1', 16) == 0 and int(process['capabilityBoundingSet'] or '1', 16) == 0 and int(process['capabilityAmbient'] or '1', 16) == 0, '__PKT_LABEL_UPPER___S2_ORIGINAL_PROCESS_BOUNDARY_UNVERIFIED')
            report['initialProcessSurvey'] = initial_processes
__PKT_WHEN_FIRST_TOOLS__
            report['preserved'] = [preserve_file(UNIT, 'original-unit.service'), preserve_file(CONFIG, 'original-config.json', SERVICE_UID), preserve_file('__PKT_OLD_OPERATIONS__/pair-supervisor.mjs', 'original-pair-supervisor.mjs')]
            require(not os.path.lexists('/var/lib/himawari/state/deployment/capability-deployment.json') and not os.path.lexists('/var/lib/himawari/state/deployment/startup-attestation.json') and 'capabilityDeployment' not in load(CONFIG), '__PKT_LABEL_UPPER___S2_FIRST_TOOLS_HOST_ALREADY_HAS_TOOLS')
__PKT_OTHERWISE__
            report['preserved'] = [preserve_file(UNIT, 'original-unit.service'), preserve_file(CONFIG, 'original-config.json', SERVICE_UID), preserve_file('/var/lib/himawari/state/deployment/capability-deployment.json', 'original-capability-deployment.json', SERVICE_UID), preserve_file('/var/lib/himawari/state/deployment/startup-attestation.json', 'original-startup-attestation.json', SERVICE_UID), preserve_file(OLD_PROTECTION, 'original-runtime-protection.json'), preserve_file('__PKT_OLD_OPERATIONS__/cloud-protected-prepare.mjs', 'original-prepare-helper.mjs'), preserve_file('__PKT_OLD_OPERATIONS__/pair-supervisor.mjs', 'original-pair-supervisor.mjs')]
__PKT_END_WHEN__
            report['preservedQualification'] = preserve_qualification()
            report['journalBefore'] = retained_journal_metadata(initial_service['InvocationID'], suffix + '-before')
            report['originalControlGroup'] = initial_service['ControlGroup']
            require(report['originalControlGroup'] == '/system.slice/himawari-prod.service', '__PKT_LABEL_UPPER___S2_ORIGINAL_CGROUP_UNEXPECTED')
            retain('s2-preserved-before-stop-' + suffix + '.json', report)
            command(['/usr/bin/systemctl', 'stop', 'himawari-prod.service'], 90)
        else:
            safe_path(EVIDENCE / 's2-stop-result.json', owners=(0,))
            previous = load(EVIDENCE / 's2-stop-result.json')
            require(previous['passed'] is True, '__PKT_LABEL_UPPER___S2_ORIGINAL_STOP_REPORT_REQUIRED')
            report['originalControlGroup'] = previous['originalControlGroup']
        stopped = service()
        require(stopped['ActiveState'] == 'inactive' and stopped['MainPID'] == '0', '__PKT_LABEL_UPPER___S2_SERVICE_NOT_STOPPED')
        first = process_survey()
        second = process_survey()
        group = cgroup_survey(report['originalControlGroup'])
        report['processSurveys'] = [first, second]
        report['cgroupSurvey'] = group
        processes_absent = first['completeVisibleEnumeration'] and second['completeVisibleEnumeration'] and not first['related'] and not second['related'] and not group['processes']
        report['processesAbsent'] = {'confirmed': processes_absent, 'basis': 'Two complete host process surveys contain no UID999 process or original runtime/state/job consumer, original v2 service cgroup has no descendants; original service NNP/zero caps prevents UID elevation.', 'limitations': 'Original host PID/PGID/start token was not retained. Full service UID absence with unchanged NoNewPrivileges and zero capabilities is the explicit substitute. No tool outcome or external effect conclusion.'}
        report['journalAfter'] = retained_journal_metadata(initial_service['InvocationID'], suffix + '-after')
        report['serviceAfter'] = stopped
        report['spaceAfter'] = root_space()
        report['finishedAt'] = utc()
        report['passed'] = bool(processes_absent)
        retained = retain('s2-inspection-' + suffix + '.json', report)
        if not inspect_only and report['passed']:
            retain('s2-stop-result.json', report)
        require(report['passed'], '__PKT_LABEL_UPPER___S2_PROCESSES_NOT_ABSENT')
        print(json.dumps({'passed': True, 'report': retained, 'serviceStopped': True}), flush=True)
    except Exception as error:
        report['finishedAt'] = utc()
        report['spaceAfter'] = root_space()
        code = str(error)
        report['failureCode'] = code if code.startswith('__PKT_LABEL_UPPER___S2_') and code.replace('_', '').isalnum() else '__PKT_LABEL_UPPER___S2_UNEXPECTED_FAILURE'
        retained = retain('s2-failure-' + suffix + '.json', report)
        print(json.dumps({'passed': False, 'failureCode': report['failureCode'], 'report': retained, 'automaticRollbackOrStart': False}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('{"passed":false,"failureCode":"__PKT_LABEL_UPPER___S2_PRECHECK_FAILED"}', flush=True)
        raise SystemExit(1)
