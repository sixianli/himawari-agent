import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
SMALL_FILE_BYTES = 1024 ** 2
LARGE_FILE_BYTES = 10 * 1024 ** 2
KEEP_DATABASE_COPIES = 3
KEEP_STATE_COPIES = 3
LOCK_PATH = '/run/lock/himawari-release-cleanup.lock'
SCRATCH_ROOT = '/tmp'
KEEP_FAILURE_SCENES = 1
KEEP_FAILED_ACCEPTANCE = 2
KEEP_FAILED_ATTEMPTS = 2
FAILED_ATTEMPT_BYTES = 200 * 1024 ** 2
TARGET_PATHS_LEFT_EXIT = 3


def load_target_paths():
    spec = importlib.util.spec_from_file_location('deploy_target_paths', HERE / 'deploy-target-paths.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cleanup_plan(binding, keep_failure_scenes=KEEP_FAILURE_SCENES, freeze_sha256=None):
    paths = binding['paths']
    owned = load_target_paths()
    evidence_parent = str(Path(paths['evidenceRoot']).parent)
    return {
        'hostname': binding['host']['hostname'],
        'unit': binding['service']['unit'],
        'unitPath': binding['service']['unitFragmentPath'],
        'config': paths['config'],
        'database': paths['database'],
        'releasesRoot': str(Path(paths['newPrefix']).parent),
        'operationsRoot': str(Path(paths['newOperations']).parent),
        'currentStage': str(Path(paths['transportRoot']).parent),
        'tmpRoot': str(Path(paths['transportRoot']).parent.parent),
        'evidenceParent': evidence_parent,
        'archiveRoot': evidence_parent + '/release-cleanup',
        'currentOperations': paths['newOperations'],
        'currentEvidence': paths['evidenceRoot'],
        'smallFileBytes': SMALL_FILE_BYTES,
        'largeFileBytes': LARGE_FILE_BYTES,
        'keepDatabaseCopies': KEEP_DATABASE_COPIES,
        'stateRoot': str(Path(paths['database']).parent.parent),
        'keepStateCopies': KEEP_STATE_COPIES,
        'lockPath': LOCK_PATH,
        'scratchRoot': SCRATCH_ROOT,
        'keepFailureScenes': keep_failure_scenes,
        'freezeSha256': freeze_sha256,
        'qualificationTarget': binding['service']['newQualificationEvidenceRoot'],
        'keepFailedAcceptance': KEEP_FAILED_ACCEPTANCE,
        'targetPaths': owned.target_paths(binding),
        'targetParents': owned.allowed_parents(binding),
        'keepFailedAttempts': KEEP_FAILED_ATTEMPTS,
        'failedAttemptBytes': FAILED_ATTEMPT_BYTES,
    }


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[2] not in ('plan', 'apply') or (len(sys.argv) == 4 and not sys.argv[3].isdigit()):
        print('usage: python3 release-cleanup.py <operation packet directory> plan|apply [failure scenes to keep, default ' + str(KEEP_FAILURE_SCENES) + ']', file=sys.stderr)
        return 64
    packet = Path(sys.argv[1]).resolve()
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    keep = int(sys.argv[3]) if len(sys.argv) == 4 else KEEP_FAILURE_SCENES
    encoded = base64.b64encode(json.dumps(cleanup_plan(binding, keep, hashlib.sha256((packet / 'freeze-manifest.json').read_bytes()).hexdigest())).encode()).decode()
    command = ['ssh', *SSH_OPTIONS, 'root@' + binding['host']['address'], '/usr/bin/python3 -I - ' + sys.argv[2] + ' ' + encoded]
    child = subprocess.run(command, input=(HERE / 'release-cleanup-remote.py').read_bytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900, check=False)
    output = child.stdout.decode(errors='replace')
    line = next((line for line in output.splitlines() if line.startswith('CLEANUP_REMOTE_RESULT ')), None)
    if child.returncode != 0 or line is None:
        print('CLEANUP_FAILED exit=' + str(child.returncode) + ' ' + child.stderr.decode(errors='replace').strip())
        return 1
    return report(json.loads(line.split(' ', 1)[1]))


def report(result):
    for item in result['deleted']:
        print('CLEANUP_DELETED ' + item['reason'] + ' ' + item['path'] + ' ' + str(item['bytes']))
    for item in result['trimmed']:
        print('CLEANUP_TRIMMED ' + item['path'] + ' ' + str(item['bytes']))
    for item in result['renamed']:
        print('CLEANUP_RENAMED ' + item['from'] + ' -> ' + item['to'])
    for item in result.get('staleTransports', []):
        print('CLEANUP_STALE_TRANSPORT pid=' + str(item['pid']) + ' terminated=' + str(item['terminated']).lower())
    for item in result['kept']:
        print('CLEANUP_KEPT ' + item['reason'] + ' ' + item['path'])
    for item in result.get('targetPathsLeft', []):
        print('CLEANUP_TARGET_PATH_LEFT ' + item['reason'] + ' ' + item['path'])
    print('CLEANUP_RESULT ' + json.dumps({'mode': result['mode'], 'freedBytes': result['freedBytes'], 'archivedFiles': len(result['archived']), 'rootFreeBeforeBytes': result['rootFreeBeforeBytes'], 'rootFreeAfterBytes': result['rootFreeAfterBytes'], 'report': result.get('report')}))
    return TARGET_PATHS_LEFT_EXIT if result['mode'] == 'apply' and result.get('targetPathsLeft') else 0


if __name__ == '__main__':
    sys.exit(main())
