import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
incoming_umask = os.umask(0o022)
base = Path(__file__).resolve().parent
if len(sys.argv) not in [5, 6] or sys.argv[1] != '--approved-service-read' or len(sys.argv) == 6 and sys.argv[5] != '--hermes-rehearsal':
    raise RuntimeError('EXPLICIT_SINGLE_SERVICE_READ_REQUIRED')
runtime, node, evidence = map(Path, sys.argv[2:5])
rehearsal = len(sys.argv) == 6
if sys.platform != 'linux' or os.getuid() == 0 or incoming_umask != 0o022 or evidence.resolve() != evidence or evidence.is_symlink() or evidence.stat().st_uid != os.getuid() or stat.S_IMODE(evidence.stat().st_mode) != 0o700 or any(evidence.iterdir()):
    raise RuntimeError('NEW_OWNED_EMPTY_PROBE_EVIDENCE_REQUIRED')
if runtime.resolve() != runtime or node.resolve() != node or runtime.is_symlink() or node.is_symlink() or 'TMPDIR' in os.environ:
    raise RuntimeError('CANONICAL_RUNTIME_AND_UNSET_TMPDIR_REQUIRED')
status = Path('/proc/self/status').read_text().splitlines()
protection = {line.split(':', 1)[0]: line.split(':', 1)[1].strip() for line in status if line.startswith(('CapInh:', 'CapPrm:', 'CapEff:', 'CapBnd:', 'CapAmb:', 'NoNewPrivs:'))}
if rehearsal:
    if socket.gethostname() != '__PKT_BUILDER_HOSTNAME__':
        raise RuntimeError('HERMES_ONLY_REHEARSAL_REQUIRED')
else:
    if socket.gethostname() != '__PKT_HOSTNAME__' or os.getuid() != __PKT_SERVICE_UID__ or os.getgid() != __PKT_SERVICE_GID__ or str(runtime) != '/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent' or str(node) != '/opt/himawari/node/bin/node' or os.environ.get('HOME') != '/var/lib/himawari/state' or os.environ.get('PATH') != '/opt/himawari/node/bin:/usr/bin:/bin' or protection.get('NoNewPrivs') != '1' or any(int(protection.get(key, '-1'), 16) != 0 for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']):
        raise RuntimeError('PRODUCTION_SERVICE_IDENTITY_ENVIRONMENT_REQUIRED')
helper = base.parents[1] / 'acceptance/helpers/check-p5-scratch-cleanup.py'
if helper.resolve() != helper or helper.is_symlink() or not helper.is_file():
    raise RuntimeError('BOUND_CLEANUP_HELPER_REQUIRED')
registry = evidence / 'owned-processes.json'
record = {'schema': 'himawari-__PKT_LABEL__-service-read-run.v1', 'profile': 'hermes-rehearsal' if rehearsal else 'production-service-environment', 'systemdPropertiesProven': False, 'passed': False, 'errors': [], 'resourceSamplingWarnings': [], 'rootFreeBeforeBytes': shutil.disk_usage('/').free, 'scratchCleanupPending': True, 'environment': {'uid': os.getuid(), 'gid': os.getgid(), 'HOME': os.environ.get('HOME'), 'PATH': os.environ.get('PATH'), 'TMPDIR': os.environ.get('TMPDIR'), 'umask': '0022', 'protection': protection}, 'runtime': str(runtime), 'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest()}
scratch = None
monitor_stop = threading.Event()
peak = 0
lowest = record['rootFreeBeforeBytes']

def file_bytes(path):
    try:
        return path.lstat().st_size
    except FileNotFoundError:
        return 0

def tree_bytes(directory):
    return sum(file_bytes(Path(parent) / name) for parent, directories, names in os.walk(directory) for name in names)

def sample():
    global peak, lowest
    size = tree_bytes(scratch) if scratch and scratch.exists() else 0
    free = shutil.disk_usage('/').free
    peak, lowest = max(peak, size), min(lowest, free)
    with (evidence / 'resources.jsonl').open('a') as output:
        output.write(json.dumps({'at': time.time(), 'scratchBytes': size, 'rootFreeBytes': free}) + '\n')

def sample_or_warn():
    try:
        sample()
    except Exception as error:
        record['resourceSamplingWarnings'].append({'phase': 'resource-sampling', 'type': type(error).__name__, 'message': str(error)})

def observe():
    while not monitor_stop.wait(1):
        sample_or_warn()

try:
    scratch = Path(subprocess.check_output(['/usr/bin/python3', '-I', str(helper), '--create-scratch', '--evidence', str(evidence), '--owned-processes', str(registry), '--controller-pid', str(os.getpid())], text=True, timeout=15).strip())
    info = scratch.lstat()
    if len(str(scratch).encode()) != 10 or scratch.resolve() != scratch or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('SCRATCH_IDENTITY_INVALID')
    scratch_identity = (info.st_dev, info.st_ino, info.st_uid)
    record['scratch'] = str(scratch)
    record['scratchIdentity'] = {'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid}
    logs = evidence / 'observations'
    logs.mkdir(mode=0o700)
    environment = dict(os.environ)
    environment['HIMAWARI___PKT_LABEL_UPPER___PROBE_LOG'] = str(logs)
    environment.pop('TMPDIR', None)
    argv = ['/usr/bin/python3', '-I', str(helper), '--run', '--owned-processes', str(registry), '--', str(node), '--no-global-search-paths', '--import', str(base / 'bootstrap.mjs'), str(base / 'read-driver.mjs'), str(runtime), str(scratch), str(evidence)]
    record['command'] = argv
    observer = threading.Thread(target=observe, daemon=True)
    observer.start()
    with (evidence / 'read.stdout').open('x') as output, (evidence / 'read.stderr').open('x') as error:
        code = subprocess.run(argv, env=environment, cwd=base, stdin=subprocess.DEVNULL, stdout=output, stderr=error, timeout=120).returncode
    record['exitCode'] = code
    if code != 0:
        raise RuntimeError('REAL_SANDBOX_READ_FAILED')
    readback = json.loads((evidence / 'read-report.json').read_text())
    if readback['passed'] is not True or readback['requestCount'] != 1 or readback['modelRequests'] != 0 or readback['result']['srtReset'] is not True:
        raise RuntimeError('REAL_READ_REPORT_FAILED')
    observations = [json.loads(filename.read_text()) for filename in sorted(logs.glob('observation-*.json'))]
    if sorted(row['role'] for row in observations) != ['caller', 'host', 'sdk-thread'] or any(row['droppedEvents'] != 0 for row in observations):
        raise RuntimeError('COMPLETE_CALLER_HOST_SDK_MEASUREMENTS_REQUIRED')
    host_steps = {entry['name'] for row in observations if row['role'] == 'host' for entry in row['events'] if entry['kind'] == 'span' and entry['outcome'] == 'returned'}
    sdk_steps = {entry['name'] for row in observations if row['role'] == 'sdk-thread' for entry in row['events'] if entry['kind'] == 'span' and entry['outcome'] == 'returned'}
    if not {'host.module_loading', 'host.private_realpath', 'host.policy', 'host.control', 'host.resource_snapshot', 'host.dependencies', 'host.guardian', 'host.network', 'host.sdk_initialize', 'host.wrap', 'host.cleanup', 'host.reset'} <= host_steps or not {'sdk.module_loading', 'sdk.dependencies', 'sdk.initialize', 'sdk.wrap', 'sdk.cleanup', 'sdk.reset'} <= sdk_steps:
        raise RuntimeError('PREPARATION_STEP_TIMINGS_INCOMPLETE')
    expected = (evidence / 'expected-fixture.bin').read_bytes()
    actual = (evidence / 'actual-tool-result.bin').read_bytes()
    if expected != actual or hashlib.sha256(actual).hexdigest() != readback['fixture']['sha256']:
        raise RuntimeError('INDEPENDENT_CONTENT_READBACK_FAILED')
    record['measurementReadback'] = [{'role': row['role'], 'pid': row['pid'], 'threadId': row['threadId'], 'timerLateMaxMs': row['timerLateMaxMs'], 'histogramMaxMs': row['histogramMaxMs'], 'stepSpans': [entry for entry in row['events'] if entry['kind'] == 'span']} for row in observations]
    record['passed'] = True
except Exception as error:
    record['errors'].append({'phase': 'read-or-readback', 'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'PROBE_FAILED'})
finally:
    monitor_stop.set()
    if 'observer' in locals():
        observer.join(timeout=5)
    if scratch:
        sample_or_warn()
        info = scratch.lstat()
        if (info.st_dev, info.st_ino, info.st_uid) != scratch_identity:
            record['errors'].append({'phase': 'cleanup', 'code': 'SCRATCH_IDENTITY_CHANGED'})
        elif record['passed'] and not record['errors']:
            argv = ['/usr/bin/python3', '-I', str(helper), '--scratch', str(scratch), '--evidence', str(evidence), '--owned-processes', str(registry), '--search-root', str(base.parents[1]), '--report-name', 'service-read-cleanup']
            with (evidence / 'cleanup.stdout').open('x') as output, (evidence / 'cleanup.stderr').open('x') as error:
                cleanup_code = subprocess.run(argv, stdout=output, stderr=error, stdin=subprocess.DEVNULL, timeout=180).returncode
            cleanup_path = evidence / 'service-read-cleanup-decision.json'
            cleanup = json.loads(cleanup_path.read_text()) if cleanup_path.is_file() else {}
            record['cleanup'] = {'exitCode': cleanup_code, 'deleteAllowed': cleanup.get('deleteAllowed'), 'reportSha256': hashlib.sha256(cleanup_path.read_bytes()).hexdigest() if cleanup_path.is_file() else None}
            if cleanup_code == 0 and cleanup.get('deleteAllowed') is True:
                shutil.rmtree(scratch)
                record['scratchDeleted'] = not scratch.exists()
                record['scratchCleanupPending'] = False
            else:
                record['errors'].append({'phase': 'cleanup', 'code': 'SCRATCH_CLEANUP_NOT_CONFIRMED_SCENE_RETAINED'})
        else:
            record['failureSceneRetained'] = str(scratch)
    record['scratchPeakBytes'] = peak
    record['rootLowestFreeBytes'] = lowest
    record['rootFreeAfterBytes'] = shutil.disk_usage('/').free
    record['retainedEvidenceBytes'] = tree_bytes(evidence)
    record['rootFreeShortfallBytes'] = record['rootFreeBeforeBytes'] - record['rootFreeAfterBytes']
    record['passed'] = record['passed'] and not record['errors'] and not record['scratchCleanupPending']
    target = evidence / 'probe-run.json'
    data = (json.dumps(record, indent=2) + '\n').encode()
    with target.open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    target.chmod(0o600)
    if target.read_bytes() != data:
        raise RuntimeError('PROBE_RUN_READBACK_FAILED')
    print(json.dumps(record))
sys.exit(0 if record['passed'] else 1)
