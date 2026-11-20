import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time

base = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
os.umask(0o022)
if len(sys.argv) != 4 or sys.argv[1] != '--approved-__PKT_LABEL__-deployment-acceptance':
    raise RuntimeError('EXPLICIT___PKT_LABEL_UPPER___DEPLOYMENT_ACCEPTANCE_APPROVAL_REQUIRED')
manifest_path, evidence = map(Path, sys.argv[2:])
manifest = json.loads(manifest_path.read_text())
profile = manifest['profile']
node = Path(manifest['node'])
cleanup_helper = Path(manifest['cleanupHelper']['path'])
registry = evidence / 'owned-processes.json'
if profile not in ['hermes-rehearsal', 'cloud-__PKT_LABEL__-change']:
    raise RuntimeError('ACCEPTANCE_PROFILE_REQUIRED')
if profile == 'hermes-rehearsal':
    if socket.gethostname() != 'hermes-home':
        raise RuntimeError('HERMES_REHEARSAL_HOST_REQUIRED')
else:
    if socket.gethostname() == 'hermes-home' or str(node) != '/opt/himawari/node/bin/node':
        raise RuntimeError('FORMAL_CLOUD_NODE_REQUIRED')
if cleanup_helper.resolve() != cleanup_helper or cleanup_helper.is_symlink() or not cleanup_helper.is_file() or hashlib.sha256(cleanup_helper.read_bytes()).hexdigest() != manifest['cleanupHelper']['sha256']:
    raise RuntimeError('CLEANUP_HELPER_CHANGED')
if sys.platform != 'linux' or os.getuid() == 0 or manifest['acceptanceUid'] != os.getuid() or manifest['expectedHostname'] != socket.gethostname():
    raise RuntimeError('APPROVED_HOST_ORDINARY_ACCOUNT_REQUIRED')
if manifest['compositionEntry']['status'] != 'ready':
    raise RuntimeError('COMPOSITION_ENTRY_REVIEW_REQUIRED')
if not hasattr(os, 'pidfd_open') or not hasattr(__import__('signal'), 'pidfd_send_signal'):
    raise RuntimeError('PIDFD_SUPPORT_REQUIRED')
if evidence.resolve() != evidence or evidence.is_symlink() or not evidence.is_dir() or evidence.stat().st_uid != os.getuid() or stat.S_IMODE(evidence.stat().st_mode) != 0o700 or any(evidence.iterdir()):
    raise RuntimeError('NEW_OWNED_EVIDENCE_DIRECTORY_REQUIRED')
if evidence.parent != Path(manifest['evidenceRoot']) or profile == 'cloud-__PKT_LABEL__-change' and not str(evidence).startswith('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/acceptance/') or profile == 'hermes-rehearsal' and not str(evidence).startswith('/data/hermes/himawari/tool-audit-round2/'):
    raise RuntimeError('DECLARED_EVIDENCE_LOCATION_REQUIRED')
for relative, expected in manifest['files'].items():
    filename = base / relative
    if filename.resolve() != filename or filename.is_symlink() or not filename.is_file() or hashlib.sha256(filename.read_bytes()).hexdigest() != expected:
        raise RuntimeError('ACCEPTANCE_SOURCE_CHANGED:' + relative)
spec = importlib.util.spec_from_file_location('cloud_proc_sampler', base / 'adapters/proc-sampler.py')
sampler_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler_module)
scene_spec = importlib.util.spec_from_file_location('failure_scene', base / 'adapters/failure-scene.py')
scene_module = importlib.util.module_from_spec(scene_spec)
scene_spec.loader.exec_module(scene_module)

def root_free():
    return shutil.disk_usage('/').free

def file_bytes(path, tally=None):
    try:
        return path.lstat().st_size
    except FileNotFoundError:
        if tally is not None:
            tally.vanished += 1
        return 0

def directory_bytes(directory, tally=None):
    def listing_failed(error):
        if tally is None:
            return
        if isinstance(error, FileNotFoundError):
            tally.vanished += 1
        else:
            tally.warnings.append({'phase': 'listing', 'type': type(error).__name__, 'message': str(error)})
    return sum(file_bytes(Path(parent) / name, tally) for parent, directories, files in os.walk(directory, onerror=listing_failed, followlinks=False) for name in files)

class Resources:
    def __init__(self, scratch):
        self.scratch = scratch
        self.peak = 0
        self.lowest = root_free()
        self.warnings = []
        self.vanished = 0
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.observe, daemon=True)

    def sample(self):
        current = {'at': time.time(), 'scratchBytes': directory_bytes(self.scratch, self) if self.scratch.exists() else 0, 'rootFreeBytes': root_free()}
        self.peak = max(self.peak, current['scratchBytes'])
        self.lowest = min(self.lowest, current['rootFreeBytes'])
        with (evidence / 'resources.jsonl').open('a') as output:
            output.write(json.dumps(current) + '\n')

    def sample_or_warn(self):
        try:
            self.sample()
        except Exception as error:
            self.warnings.append({'phase': 'sample', 'type': type(error).__name__, 'message': str(error)})

    def observe(self):
        while not self.stopping.is_set():
            self.sample_or_warn()
            self.stopping.wait(5)

    def stop(self):
        self.stopping.set()
        self.thread.join()
        self.sample_or_warn()

record = {'schema': 'himawari-__PKT_LABEL__-cloud-acceptance-run.v1', 'startedAt': time.time(), 'rootFreeBeforeBytes': root_free(), 'scratchCleanupPending': True, 'runnerErrors': [], 'productionQualificationIssued': False, 'passed': False, 'profile': profile, 'nonProduction': True, 'hostname': socket.gethostname(), 'acceptanceUid': os.getuid()}
scratch = None
resources = None
resources_stopped = False
observer = None
process = None
code = 1
try:
    if socket.gethostname() != 'hermes-home' and record['rootFreeBeforeBytes'] < 10 * 1024**3:
        raise RuntimeError('ORIGINAL_G59_CLOUD_ROOT_FREE_PREFLIGHT_FAILED')
    scratch = Path(subprocess.check_output(['/usr/bin/python3', '-I', str(cleanup_helper), '--create-scratch', '--evidence', str(evidence), '--owned-processes', str(registry), '--controller-pid', str(os.getpid())], text=True, timeout=15).strip())
    info = scratch.lstat()
    if not re.fullmatch('/tmp/h[A-Za-z0-9]{4}', str(scratch)) or len(str(scratch).encode()) != 10 or not stat.S_ISDIR(info.st_mode) or scratch.is_symlink() or scratch.resolve() != scratch or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('SCRATCH_ROOT_UNSAFE')
    scratch_identity = (info.st_dev, info.st_ino, info.st_uid)
    record['scratch'] = str(scratch)
    record['scratchIdentity'] = {'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid}
    resources = Resources(scratch)
    resources.thread.start()
    environment = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(scratch), 'LANG': 'C.UTF-8', 'TMPDIR': str(scratch), 'HIMAWARI_TEST_TEMP_ROOT': str(scratch), 'PYTHONDONTWRITEBYTECODE': '1'}
    argv = ['/usr/bin/python3', '-I', str(cleanup_helper), '--run', '--owned-processes', str(registry), '--', '/usr/bin/python3', '-I', str(base / 'run-network-preparation.py'), '--approved-__PKT_LABEL__-deployment-acceptance', str(manifest_path), str(scratch), str(evidence)]
    record['command'] = argv
    with (evidence / 'console.stdout').open('x') as output, (evidence / 'console.stderr').open('x') as error:
        process = subprocess.Popen(argv, cwd=base, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=error)
        root_identity = sampler_module.read_identity(process.pid)
        record['observerRootIdentity'] = root_identity
        observer = sampler_module.ProcSampler(process.pid, root_identity['starttimeTicks'], evidence / 'proc.jsonl', evidence, interval=1.0, other_scope='same-uid')
        observer_thread = threading.Thread(target=observer.run, daemon=True)
        observer_thread.start()
        code = process.wait()
        observer.request_stop('runner_complete')
        observer_thread.join(timeout=30)
        if observer_thread.is_alive():
            raise RuntimeError('PROCESS_OBSERVER_STOP_FAILED')
    record['exitCode'] = code
    if code != 0:
        raise RuntimeError('ACCEPTANCE_SUBCOMMAND_FAILED')
    result = json.loads((evidence / 'acceptance-report.json').read_text())
    if result['passed'] is not True:
        raise RuntimeError('ACCEPTANCE_REPORT_NOT_PASSED')
    record['passed'] = True
except Exception as error:
    record['runnerErrors'].append({'type': type(error).__name__, 'message': str(error)})
finally:
    if observer is not None:
        observer.request_stop('retention')
        observer_thread.join(timeout=30)
    if scratch is not None:
        try:
            current = scratch.lstat()
            if scratch.resolve() != scratch or scratch.is_symlink() or (current.st_dev, current.st_ino, current.st_uid) != scratch_identity:
                raise RuntimeError('SCRATCH_IDENTITY_CHANGED')
            if not record['passed'] and any(scratch.iterdir()):
                record['retainedScratch'] = scene_module.retain_failure_scene(scratch, evidence)
            known = set()
            observations = evidence / 'proc.jsonl'
            if process is not None:
                if not observations.is_file() or observations.stat().st_size == 0 or 'observerRootIdentity' not in record:
                    raise RuntimeError('SCRATCH_PROCESS_OBSERVATION_INCOMPLETE')
                known.add((process.pid, record['observerRootIdentity']['starttimeTicks']))
                for line in observations.read_text().splitlines():
                    value = json.loads(line)
                    for entry in value.get('testTree', {}).get('processes', []):
                        known.add((entry['pid'], entry['starttimeTicks']))
                values = [json.loads(line) for line in observations.read_text().splitlines()]
                if not any(value.get('type') == 'sampler_stop' for value in values) or any(value.get('type') == 'sampler_error' for value in values):
                    raise RuntimeError('SCRATCH_PROCESS_OBSERVATION_INCOMPLETE')
            live = []
            for pid, starttime in known:
                try:
                    info = sampler_module.parse_stat(Path(f'/proc/{pid}/stat').read_text())
                except FileNotFoundError:
                    continue
                if info['starttimeTicks'] == starttime and info['state'] not in ['Z', 'X', 'x']:
                    live.append({'pid': pid, 'starttimeTicks': starttime, 'comm': info['comm']})
            record['scratchCleanupProcessReadback'] = {'observedTaskIdentitiesChecked': len(known), 'liveDescendants': live}
            if live:
                raise RuntimeError('SCRATCH_STILL_USED_BY_OBSERVED_TASK_PROCESS')
            if resources is not None:
                resources_stopped = True
                resources.stop()
                record['resourceSamplingStoppedBeforeReferenceCheck'] = True
            if not record['passed']:
                raise RuntimeError('FAILED_ACCEPTANCE_SCENE_RETAINED_NO_AUTOMATIC_DELETION')
            cleanup_argv = ['/usr/bin/python3', '-I', str(cleanup_helper), '--scratch', str(scratch), '--evidence', str(evidence), '--owned-processes', str(registry), '--search-root', str(base), '--search-root', manifest['sourceRoot'], '--report-name', 'scratch-cleanup']
            with (evidence / 'scratch-cleanup.stdout').open('x') as output, (evidence / 'scratch-cleanup.stderr').open('x') as error:
                cleanup_code = subprocess.run(cleanup_argv, stdout=output, stderr=error, stdin=subprocess.DEVNULL, timeout=180).returncode
            cleanup = json.loads((evidence / 'scratch-cleanup-decision.json').read_text())
            record['scratchCleanupReferenceReadback'] = {'command': cleanup_argv, 'exitCode': cleanup_code, 'deleteAllowed': cleanup['deleteAllowed'], 'decisionSha256': hashlib.sha256((evidence / 'scratch-cleanup-decision.json').read_bytes()).hexdigest()}
            if cleanup_code != 0 or cleanup['deleteAllowed'] is not True:
                raise RuntimeError('SCRATCH_REFERENCE_CLEANUP_NOT_CONFIRMED')
            if resources_stopped:
                record['resourceSamplingStoppedBeforeScratchDeletion'] = True
            shutil.rmtree(scratch)
            record['scratchDeleted'] = not scratch.exists()
            record['scratchCleanupPending'] = False
        except Exception as error:
            record['runnerErrors'].append({'phase': 'scratch-retention-or-cleanup', 'type': type(error).__name__, 'message': str(error)})
    if resources is not None:
        if not resources_stopped:
            resources_stopped = True
            resources.stop()
        record.update({'scratchPeakBytes': resources.peak, 'rootLowestFreeBytes': resources.lowest, 'resourceSamplingWarnings': resources.warnings, 'resourceSamplingVanishedEntries': resources.vanished})
    record['rootFreeAfterCleanupBytes'] = root_free()
    record['intentionallyRetainedEvidenceBytes'] = directory_bytes(evidence)
    record['rootSpaceShortfallBytes'] = record['rootFreeBeforeBytes'] - record['rootFreeAfterCleanupBytes']
    record['finishedAt'] = time.time()
    record['durationSeconds'] = record['finishedAt'] - record['startedAt']
    record['passed'] = record['passed'] and not record['runnerErrors'] and not record['scratchCleanupPending']
    (evidence / 'run-report.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))
sys.exit(0 if record['passed'] else 1)
