import json
from pathlib import Path
import shlex
import subprocess
import sys

SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
MINIMUM_FREE_FACTOR = 2


def packet_bytes(packet):
    return sum(path.stat().st_size for path in packet.rglob('*') if path.is_file() and 'run-logs' not in path.parts)


def remote_script(binding):
    state_parent = str(Path(binding['paths']['stateRoot']).parent)
    return '; '.join([
        'set -u',
        'echo "hostname=$(/usr/bin/hostname)"',
        'echo "active=$(/usr/bin/systemctl is-active ' + shlex.quote(binding['service']['unit']) + ')"',
        'echo "optFree=$(/usr/bin/df --output=avail -B1 /opt | /usr/bin/tail -n 1 | /usr/bin/tr -d \' \')"',
        'echo "stateFree=$(/usr/bin/df --output=avail -B1 ' + shlex.quote(state_parent) + ' | /usr/bin/tail -n 1 | /usr/bin/tr -d \' \')"',
        'echo "uid=$(/usr/bin/id -u)"',
    ])


def checks(binding, facts, size):
    needed = size * MINIMUM_FREE_FACTOR
    return [
        ('ROOT_LOGIN', facts.get('uid') == '0'),
        ('HOSTNAME', facts.get('hostname') == binding['host']['hostname']),
        ('SERVICE_ACTIVE', facts.get('active') == 'active'),
        ('OPT_FREE', int(facts.get('optFree') or 0) >= needed),
        ('STATE_FREE', int(facts.get('stateFree') or 0) >= needed),
    ]


def main():
    packet = Path(sys.argv[1]).resolve()
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    child = subprocess.run(['ssh', *SSH_OPTIONS, 'root@' + binding['host']['address'], remote_script(binding)], capture_output=True, text=True, timeout=60, check=False)
    if child.returncode != 0:
        print('PREFLIGHT_CHECK SSH failed exit=' + str(child.returncode) + ' ' + child.stderr.strip())
        return 1
    facts = dict(line.split('=', 1) for line in child.stdout.splitlines() if '=' in line)
    failed = False
    for name, passed in checks(binding, facts, packet_bytes(packet)):
        print('PREFLIGHT_CHECK ' + name + ' ' + ('passed' if passed else 'failed'))
        failed = failed or not passed
    print('PREFLIGHT_FACTS ' + json.dumps(facts))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
