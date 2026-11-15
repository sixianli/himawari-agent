import hashlib
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
base = Path(__file__).resolve().parent
stage = Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__')
runtime = Path('/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent')
evidence = stage / 'acceptance/service-read-01'
protected = Path('/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')
unit = 'himawari-__PKT_LABEL__-read-20261026.service'
account = pwd.getpwnam('himawari-prod')
if sys.argv[1:] != ['--approved-s6-service-environment-read'] or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or sys.platform != 'linux' or os.getuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__' or (account.pw_uid, account.pw_gid) != (999, 988):
    raise RuntimeError('EXPLICIT___PKT_LABEL_UPPER___DEPLOYMENT_CLOUD_ROOT_READ_REQUIRED')

def regular(filename, owner=0):
    info = filename.lstat()
    if filename.resolve() != filename or not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022 or info.st_nlink != 1:
        raise RuntimeError('ROOT_BOUND_INPUT_UNSAFE:' + str(filename))
    return filename.read_bytes()

def show(name):
    keys = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'User', 'Group', 'UMask', 'NoNewPrivileges', 'CapabilityBoundingSet', 'AmbientCapabilities', 'Environment', 'UnsetEnvironment', 'WorkingDirectory', 'KillMode', 'TimeoutStopUSec', 'Restart', 'InaccessiblePaths', 'ExecMainStatus', 'Result']
    text = subprocess.check_output(['/usr/bin/systemctl', 'show', name, '--no-pager', '--property=' + ','.join(keys)], text=True, timeout=15)
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)

def cgroup_pids(filename):
    try:
        return filename.read_text().splitlines()
    except FileNotFoundError:
        return []

def write(filename, value):
    data = (json.dumps(value, indent=2) + '\n').encode()
    with filename.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    filename.chmod(0o600)
    if regular(filename) != data:
        raise RuntimeError('PROTECTED_REPORT_READBACK_FAILED')
    return {'path': str(filename), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

for directory, owner, mode in [(base, 0, None), (stage / 'acceptance', 999, 0o700), (protected, 999, 0o700), (runtime, 0, None)]:
    info = directory.lstat()
    if directory.resolve() != directory or not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022 or mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('BOUND_DIRECTORY_UNSAFE:' + str(directory))
for line in regular(base / 'OWNED-SHA256SUMS').decode().splitlines():
    expected, relative = line.split('  ', 1)
    filename = base / relative
    if Path(relative).is_absolute() or '..' in Path(relative).parts or hashlib.sha256(regular(filename)).hexdigest() != expected:
        raise RuntimeError('PROBE_SCRIPT_SHA_CHANGED:' + relative)
node = Path('/opt/himawari/node/bin/node')
if hashlib.sha256(regular(node)).hexdigest() != 'e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2':
    raise RuntimeError('LOCKED_NODE_CHANGED')
old = show('himawari-prod.service')
expected_properties = {'User': 'himawari-prod', 'Group': 'himawari-prod', 'UMask': '0022', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'AmbientCapabilities': '', 'KillMode': 'mixed', 'TimeoutStopUSec': '35s'}
if old.get('ActiveState') not in ['inactive', 'failed'] or old.get('MainPID') != '0' or any(old.get(key) != value for key, value in expected_properties.items()):
    raise RuntimeError('STOPPED_ORIGINAL_SERVICE_PROPERTIES_CHANGED')
acceptance = json.loads(regular(stage / 'acceptance/run-01/run-report.json', 999))
if acceptance['passed'] is not True or acceptance['profile'] != 'cloud-__PKT_LABEL__-change' or acceptance['scratchCleanupPending'] is not False:
    raise RuntimeError('S6_COMPLETE_NEW_HOST_ACCEPTANCE_REQUIRED')
protection = Path('/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/runtime-protection.json')
regular(protection)
frozen_packet = json.loads(subprocess.check_output(['/usr/bin/python3', '-I', str(stage / 'packet/acceptance/helpers/verify-frozen-packet.py'), '--approved-__PKT_LABEL__-frozen-packet-readback'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=120))
frozen_binding_bytes = regular(stage / 'packet/inputs/bindings.json')
if hashlib.sha256(frozen_binding_bytes).hexdigest() != frozen_packet['bindingsSha256']:
    raise RuntimeError('FROZEN_BINDING_CHANGED_AFTER_READBACK')
if hashlib.sha256(regular(Path('/etc/systemd/system/himawari-prod.service'))).hexdigest() != json.loads(frozen_binding_bytes)['service']['oldUnitSha256']:
    raise RuntimeError('ORIGINAL_UNIT_CHANGED_BEFORE_SWITCH')
if evidence.exists() or evidence.is_symlink() or show(unit).get('LoadState') != 'not-found':
    raise RuntimeError('UNIQUE_UNRUN_PROBE_TARGET_REQUIRED')
evidence.mkdir(mode=0o700)
os.chown(evidence, 999, 988)
report_path = protected / 's6-service-read-launch.json'
if report_path.exists() or report_path.is_symlink():
    raise RuntimeError('PROBE_LAUNCH_REPORT_ALREADY_EXISTS')
record = {'schema': 'himawari-__PKT_LABEL__-systemd-read-launch.v1', 'passed': False, 'errors': [], 'hostname': socket.gethostname(), 'unit': unit, 'originalServiceProperties': old, 'expectedProperties': expected_properties, 'evidence': str(evidence), 'productionStateAccess': False, 'limits': 'One fictitious installed Pi read. Extra InaccessiblePaths blocks production state/jobs/config. ExecStartPre and Agent/Worker pair are omitted; cwd is new acceptance data; Restart=no. Product child rewrites HOME/TMPDIR as usual.'}
properties = [f'{key}={value}' for key, value in expected_properties.items() if key != 'TimeoutStopUSec'] + ['TimeoutStopSec=35s', 'Type=exec', 'Restart=no', 'After=network.target', 'StartLimitIntervalSec=60s', 'StartLimitBurst=10', 'SendSIGKILL=yes', 'KillSignal=SIGTERM', 'WorkingDirectory=' + str(stage / 'acceptance'), 'UnsetEnvironment=TMPDIR', 'InaccessiblePaths=/var/lib/himawari/state /var/lib/himawari/jobs /etc/himawari', 'StandardOutput=journal', 'StandardError=journal', 'SyslogIdentifier=himawari-__PKT_LABEL__-read-20261026']
argv = ['/usr/bin/systemd-run', '--unit=' + unit, '--wait', '--service-type=exec', *['--property=' + value for value in properties], '--setenv=HOME=/var/lib/himawari/state', '--setenv=PATH=/opt/himawari/node/bin:/usr/bin:/bin', '--setenv=LANG=C.UTF-8', '--setenv=HIMAWARI_RUNTIME_PROTECTION_FILE=' + str(protection), '/usr/bin/python3', '-I', str(base / 'probe/run-service-probe.py'), '--approved-service-read', str(runtime), str(node), str(evidence)]
record['frozenPacketReadback'] = frozen_packet
record['command'] = argv
child = None
try:
    with (protected / 's6-service-read-systemd.stdout').open('x') as output, (protected / 's6-service-read-systemd.stderr').open('x') as error:
        child = subprocess.Popen(argv, stdout=output, stderr=error, stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        deadline = time.monotonic() + 15
        while True:
            actual = show(unit)
            if actual.get('LoadState') == 'loaded':
                break
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('TRANSIENT_UNIT_PROPERTY_READBACK_MISSING')
            time.sleep(0.05)
        record['effectiveProperties'] = actual
        actual_environment = dict(value.split('=', 1) for value in shlex.split(actual.get('Environment', '')) if '=' in value)
        required_environment = {'HOME': '/var/lib/himawari/state', 'PATH': '/opt/himawari/node/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HIMAWARI_RUNTIME_PROTECTION_FILE': str(protection)}
        if any(actual.get(key) != value for key, value in expected_properties.items()) or actual.get('UnsetEnvironment') != 'TMPDIR' or actual.get('WorkingDirectory') != str(stage / 'acceptance') or any(actual_environment.get(key) != value for key, value in required_environment.items()) or 'TMPDIR' in actual_environment or set(shlex.split(actual.get('InaccessiblePaths', ''))) != {'/var/lib/himawari/state', '/var/lib/himawari/jobs', '/etc/himawari'}:
            raise RuntimeError('TRANSIENT_UNIT_ENVIRONMENT_MISMATCH')
        code = child.wait(timeout=360)
    record['systemdRunExitCode'] = code
    if code != 0:
        raise RuntimeError('SERVICE_ENVIRONMENT_REAL_READ_FAILED')
    run = json.loads(regular(evidence / 'probe-run.json', 999))
    read = json.loads(regular(evidence / 'read-report.json', 999))
    if run['passed'] is not True or read['passed'] is not True or run['scratchCleanupPending'] is not False or read['requestCount'] != 1:
        raise RuntimeError('INDEPENDENT_SERVICE_READ_REPORT_FAILED')
    record['readback'] = {'probeRunSha256': hashlib.sha256(regular(evidence / 'probe-run.json', 999)).hexdigest(), 'readReportSha256': hashlib.sha256(regular(evidence / 'read-report.json', 999)).hexdigest(), 'fixtureSha256': read['fixture']['sha256'], 'measurementReadback': run['measurementReadback'], 'scratchDeleted': run['scratchDeleted'], 'rootFreeBeforeBytes': run['rootFreeBeforeBytes'], 'rootLowestFreeBytes': run['rootLowestFreeBytes'], 'rootFreeAfterBytes': run['rootFreeAfterBytes'], 'scratchPeakBytes': run['scratchPeakBytes']}
    record['passed'] = True
except Exception as error:
    record['errors'].append({'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'SYSTEMD_PROBE_FAILED'})
    if child is not None and child.poll() is None:
        subprocess.run(['/usr/bin/systemctl', 'stop', unit], check=False, timeout=45)
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            record['errors'].append({'code': 'OWNED_TRANSIENT_CONTROLLER_STILL_RUNNING'})
finally:
    journal = subprocess.run(['/usr/bin/journalctl', '--unit=' + unit, '--no-pager', '--output=short-iso'], capture_output=True, timeout=15)
    journal_path = protected / 's6-service-read-journal.log'
    with journal_path.open('xb') as output:
        output.write(journal.stdout)
    journal_path.chmod(0o600)
    record['journal'] = {'path': str(journal_path), 'sha256': hashlib.sha256(journal.stdout).hexdigest(), 'exitCode': journal.returncode}
    record['finalUnitProperties'] = show(unit)
    expected_cgroup = '/system.slice/' + unit
    reported_cgroups = {value for value in [record.get('effectiveProperties', {}).get('ControlGroup'), record['finalUnitProperties'].get('ControlGroup')] if value}
    cgroup_path = Path('/sys/fs/cgroup') / expected_cgroup.lstrip('/')
    pids = cgroup_path / 'cgroup.procs'
    remaining = cgroup_pids(pids)
    record['cgroupReadback'] = {'path': str(cgroup_path), 'reportedControlGroups': sorted(reported_cgroups), 'cgroupPresent': cgroup_path.is_dir(), 'remainingPids': remaining}
    if reported_cgroups - {expected_cgroup}:
        record['errors'].append({'code': 'PROBE_CGROUP_PATH_UNEXPECTED'})
    if remaining:
        record['errors'].append({'code': 'PROBE_CGROUP_STILL_HAS_PROCESSES'})
    record['passed'] = record['passed'] and not record['errors']
    receipt = write(report_path, record)
    print(json.dumps({'receipt': receipt, 'passed': record['passed']}))
sys.exit(0 if record['passed'] else 1)
