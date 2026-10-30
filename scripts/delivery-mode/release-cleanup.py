import base64
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
SMALL_FILE_BYTES = 1024 ** 2
LARGE_FILE_BYTES = 10 * 1024 ** 2
LOCK_PATH = '/run/lock/himawari-release-cleanup.lock'


def cleanup_plan(binding):
    paths = binding['paths']
    evidence_parent = str(Path(paths['evidenceRoot']).parent)
    return {
        'hostname': binding['host']['hostname'],
        'unit': binding['service']['unit'],
        'unitPath': binding['service']['unitFragmentPath'],
        'configDirectory': str(Path(paths['config']).parent),
        'database': paths['database'],
        'releasesRoot': str(Path(paths['newPrefix']).parent),
        'operationsRoot': str(Path(paths['newOperations']).parent),
        'tmpRoot': str(Path(paths['transportRoot']).parent.parent),
        'evidenceParent': evidence_parent,
        'archiveRoot': evidence_parent + '/release-cleanup',
        'currentOperations': paths['newOperations'],
        'currentEvidence': paths['evidenceRoot'],
        'smallFileBytes': SMALL_FILE_BYTES,
        'largeFileBytes': LARGE_FILE_BYTES,
        'lockPath': LOCK_PATH,
    }


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('plan', 'apply'):
        print('usage: python3 release-cleanup.py <operation packet directory> plan|apply', file=sys.stderr)
        return 64
    packet = Path(sys.argv[1]).resolve()
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    encoded = base64.b64encode(json.dumps(cleanup_plan(binding)).encode()).decode()
    command = ['ssh', *SSH_OPTIONS, 'root@' + binding['host']['address'], '/usr/bin/python3 -I - ' + sys.argv[2] + ' ' + encoded]
    child = subprocess.run(command, input=(HERE / 'release-cleanup-remote.py').read_bytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900, check=False)
    output = child.stdout.decode(errors='replace')
    line = next((line for line in output.splitlines() if line.startswith('CLEANUP_REMOTE_RESULT ')), None)
    if child.returncode != 0 or line is None:
        print('CLEANUP_FAILED exit=' + str(child.returncode) + ' ' + child.stderr.decode(errors='replace').strip())
        return 1
    result = json.loads(line.split(' ', 1)[1])
    for item in result['deleted']:
        print('CLEANUP_DELETED ' + item['reason'] + ' ' + item['path'] + ' ' + str(item['bytes']))
    for item in result['trimmed']:
        print('CLEANUP_TRIMMED ' + item['path'] + ' ' + str(item['bytes']))
    for item in result['renamed']:
        print('CLEANUP_RENAMED ' + item['from'] + ' -> ' + item['to'])
    for item in result['kept']:
        print('CLEANUP_KEPT ' + item['reason'] + ' ' + item['path'])
    print('CLEANUP_RESULT ' + json.dumps({'mode': result['mode'], 'freedBytes': result['freedBytes'], 'archivedFiles': len(result['archived']), 'rootFreeBeforeBytes': result['rootFreeBeforeBytes'], 'rootFreeAfterBytes': result['rootFreeAfterBytes'], 'report': result.get('report')}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
