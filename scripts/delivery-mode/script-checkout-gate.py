import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def problems(packet, checkout):
    commit = json.loads((packet / 'packet-parameters.json').read_text()).get('COMMIT')
    head = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=False)
    if head.returncode != 0:
        return ['SCRIPT_CHECKOUT_NOT_GIT ' + str(checkout)]
    if subprocess.run(['git', '-C', str(checkout), 'merge-base', '--is-ancestor', str(commit), head.stdout.strip()], capture_output=True, check=False).returncode != 0:
        return ['SCRIPT_CHECKOUT_OLDER_THAN_PACKET scripts=' + head.stdout.strip() + ' packet=' + str(commit)]
    return []


def main():
    found = problems(Path(sys.argv[1]).resolve(), HERE)
    for problem in found:
        print(problem)
    print('SCRIPT_CHECKOUT ' + ('failed' if found else 'passed'))
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
