import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
PARAMETERS = 'packet-parameters.json'
CHECKS = 'packet-checks.json'


def load_checks_module():
    spec = importlib.util.spec_from_file_location('run_packet_checks', HERE / 'run-packet-checks.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def problems(packet):
    if not (packet / PARAMETERS).is_file():
        return ['PACKET_NOT_GENERATED ' + PARAMETERS + ' missing; build the packet with scripts/delivery-mode/make-packet.py prepare']
    parameters = json.loads((packet / PARAMETERS).read_text())
    if not (packet / CHECKS).is_file():
        return ['PACKET_CHECKS_MISSING ' + CHECKS]
    record = json.loads((packet / CHECKS).read_text())
    found = []
    commit = json.loads((packet / 'inputs' / 'bindings.json').read_text()).get('candidate', {}).get('testedCommit')
    if parameters.get('COMMIT') != commit or record.get('commit') != commit:
        found.append('PACKET_COMMIT_MISMATCH parameters=' + str(parameters.get('COMMIT')) + ' checks=' + str(record.get('commit')) + ' bindings=' + str(commit))
    if [record.get('currentSchema'), record.get('targetSchema')] != [parameters.get('CURRENT_SCHEMA'), parameters.get('TARGET_SCHEMA')]:
        found.append('PACKET_CHECKS_OTHER_SCHEMA')
    migrating = parameters.get('CURRENT_SCHEMA') != parameters.get('TARGET_SCHEMA')
    required = [name for name, command, directory in load_checks_module().plan(packet, Path('node'), 'python', True, migrating)]
    results = {item.get('name'): item.get('exit') for item in record.get('checks', [])}
    for name in required:
        if results.get(name) != 0:
            found.append('PACKET_CHECK_NOT_PASSED ' + name + ' ' + json.dumps(results.get(name)))
    if record.get('passed') is not True:
        found.append('PACKET_CHECKS_FAILED')
    return found


def main():
    found = problems(Path(sys.argv[1]).resolve())
    for problem in found:
        print(problem)
    print('GENERATED_PACKET ' + ('failed' if found else 'passed'))
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
