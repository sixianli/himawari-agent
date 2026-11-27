import json
from pathlib import Path
import re
import subprocess
import sys

TAIL_LINES = 20
WIDTH = 300
STATE = Path('/var/lib/himawari')


def say(kind, text):
    for line in str(text).splitlines() or ['']:
        print('LAST_FAILURE_' + kind + ' ' + line[:WIDTH])


def tail(path):
    try:
        text = path.read_bytes().decode('utf-8', 'replace')
    except OSError as error:
        return ['unreadable ' + type(error).__name__]
    return [line for line in text.splitlines() if line.strip()][-TAIL_LINES:]


def evidence_directories():
    found = [path for path in STATE.glob('*-evidence*') if path.is_dir() and not path.is_symlink()]
    return sorted(found, key=lambda path: path.stat().st_mtime_ns)[-2:]


def report_evidence(directory):
    say('EVIDENCE', str(directory))
    for result in sorted(directory.glob('step-*-result.json')):
        try:
            value = json.loads(result.read_text())
        except (OSError, ValueError) as error:
            say('STEP', result.name + ' unreadable ' + type(error).__name__)
            continue
        if value.get('passed') is True:
            continue
        say('STEP', json.dumps({key: value.get(key) for key in ('action', 'exitCode', 'failureCode', 'startedAt')}, ensure_ascii=False))
    for error_file in sorted(directory.glob('*.stderr')):
        if error_file.is_symlink() or not error_file.is_file() or error_file.stat().st_size == 0:
            continue
        say('FILE', str(error_file))
        for line in tail(error_file):
            say('TAIL', error_file.name + ' ' + line)


def differences(expected, actual, prefix=''):
    if isinstance(expected, dict) and isinstance(actual, dict):
        found = []
        for key in sorted(set(expected) | set(actual)):
            found += differences(expected.get(key), actual.get(key), prefix + '.' + key if prefix else key)
        return found
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        found = []
        for index, (left, right) in enumerate(zip(expected, actual)):
            found += differences(left, right, prefix + '[' + str(index) + ']')
        return found
    if expected != actual:
        return [prefix + ' expected=' + json.dumps(expected, ensure_ascii=False)[:120] + ' actual=' + json.dumps(actual, ensure_ascii=False)[:120]]
    return []


def report_npm(packet):
    observer = packet / 'acceptance/helpers/observe-production-npm.py'
    expected_path = packet / 'inputs/npm-observed.json'
    if not observer.is_file() or not expected_path.is_file():
        say('NPM', 'no observer or frozen observation in ' + str(packet))
        return
    source = observer.read_text()
    match = re.search(r'--approved-([a-z0-9]+)-production-npm-readonly-observation', source)
    if not match:
        say('NPM', 'observer flag not found')
        return
    run = subprocess.run(['/usr/bin/python3', '-I', '-', match.group(0)], input=source.encode(), capture_output=True, timeout=120)
    if run.returncode != 0:
        say('NPM', 'observer exit=' + str(run.returncode))
        for line in [line for line in run.stderr.decode('utf-8', 'replace').splitlines() if line.strip()][-TAIL_LINES:]:
            say('NPM', line)
        return
    actual = json.loads(run.stdout)
    expected = json.loads(expected_path.read_text())
    compared = {key: expected.get(key) for key in ['schemaVersion', 'passed', 'hostname', 'actorUid', 'readOnly', 'networkCommandsIssued', 'node', 'npm']}
    compared['versionCommand'] = {key: expected.get('versionCommand', {}).get(key) for key in ['argv', 'exitCode', 'stdoutSha256', 'filesystemWritesAllowed', 'configFiles', 'offline']}
    current = {key: actual.get(key) for key in compared if key != 'versionCommand'}
    current['versionCommand'] = {key: actual['versionCommand'].get(key) for key in compared['versionCommand']}
    found = differences(compared, current)
    say('NPM', 'frozen observation matches the host now' if not found else str(len(found)) + ' differences from the frozen observation')
    for line in found[:40]:
        say('NPM', line)


def main():
    packet = Path(sys.argv[1]) if len(sys.argv) == 2 else None
    for directory in evidence_directories():
        report_evidence(directory)
    if packet is not None:
        report_npm(packet)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        say('REPORT_ERROR', type(error).__name__ + ' ' + str(error))
