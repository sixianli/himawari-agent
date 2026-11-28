import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

TAIL_LINES = 20
WIDTH = 300
STATE = Path('/var/lib/himawari')
TOOL_SOURCES = ['/usr/bin/bash', '/usr/bin/rg', '/usr/bin/bwrap', '/opt/himawari/node/bin/node']


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


SKIPPED_DIRECTORIES = {'node_modules', '.git', 'source', 'scratch-failure-files'}
REPORT_KEYS = ('failure', 'failureCode', 'failedCondition', 'failureDetail', 'error', 'errors', 'reason', 'runnerErrors', 'readbackErrors', 'runtimeIntegrityFailure', 'fault')


def files_under(root):
    found = []
    for parent, directories, files in os.walk(root):
        directories[:] = sorted(name for name in directories if name not in SKIPPED_DIRECTORIES)
        for filename in sorted(files):
            path = Path(parent) / filename
            if path.is_file() and not path.is_symlink() and path.stat().st_size > 0:
                found.append(path)
    return found


def failed_report_details(path):
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            return None
        value = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or value.get('passed') is not False:
        return None
    details = {key: value[key] for key in REPORT_KEYS if value.get(key)}
    failed = [entry.get('id') or entry.get('name') for entry in value.get('assertions', []) if isinstance(entry, dict) and entry.get('passed') is False]
    if failed:
        details['failedAssertions'] = failed[:20]
    commands = [{'name': entry.get('name'), 'exitCode': entry.get('exitCode')} for entry in value.get('commands', []) if isinstance(entry, dict) and entry.get('exitCode') not in (0, None)]
    if commands:
        details['failedCommands'] = commands[:20]
    return json.dumps(details, ensure_ascii=False, sort_keys=True)[:1500] if details else None


def report_failed_acceptance():
    root = STATE / 'release-cleanup' / 'failed-acceptance'
    if not root.is_dir() or root.is_symlink():
        return
    found = sorted(path for path in root.iterdir() if path.is_dir() and not path.is_symlink())
    if not found:
        return
    newest = found[-1]
    say('ACCEPTANCE', str(newest))
    files = files_under(newest)
    for path in [path for path in files if path.suffix == '.json']:
        details = failed_report_details(path)
        if details:
            for start in range(0, len(details), WIDTH):
                say('REPORT', str(path.relative_to(newest)) + ' ' + details[start:start + WIDTH])
    for error_file in [path for path in files if path.suffix in ('.stderr', '.err', '.log')][:16]:
        say('FILE', str(error_file))
        for line in tail(error_file)[-10:]:
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


def probe(name, passed, detail):
    say('READY', ('ok ' if passed else 'FAIL ') + name + ' ' + detail)


def probe_downloads(packet):
    source = packet / 'acceptance/cloud/download-question-12.py'
    if not source.is_file():
        probe('downloads', False, 'no download script in ' + str(packet))
        return
    for url in re.findall(r"_url = '(https://[^']+)'", source.read_text()):
        try:
            request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'himawari-deploy-readiness'})
            with urllib.request.urlopen(request, timeout=20) as response:
                probe('download', response.status == 200, str(response.status) + ' ' + url)
        except Exception as error:
            probe('download', False, type(error).__name__ + ' ' + str(error)[:120] + ' ' + url)


def probe_tool_sources():
    for path in TOOL_SOURCES:
        target = Path(path)
        try:
            target.lstat()
            passed = target.is_file() and not target.is_symlink() and target.resolve() == target
            probe('tool-source', passed, path + (' regular file' if passed else ' is a link or not a regular file'))
        except FileNotFoundError:
            probe('tool-source', False, path + ' missing')


def probe_sandbox():
    for key in ['kernel/apparmor_restrict_unprivileged_userns', 'kernel/unprivileged_userns_clone', 'user/max_user_namespaces']:
        path = Path('/proc/sys') / key
        say('READY', 'sysctl ' + key.replace('/', '.') + '=' + (path.read_text().strip() if path.exists() else 'absent'))
    command = ['/usr/bin/setpriv', '--reuid=himawari-prod', '--regid=himawari-prod', '--init-groups', '--no-new-privs', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '/usr/bin/true']
    try:
        run = subprocess.run(command, capture_output=True, timeout=30)
        error = run.stderr.decode('utf-8', 'replace').strip().splitlines()
        probe('sandbox', run.returncode == 0, 'bwrap as himawari-prod exit=' + str(run.returncode) + (' ' + error[-1][:200] if error else ''))
    except Exception as error:
        probe('sandbox', False, type(error).__name__ + ' ' + str(error)[:160])


def main():
    packet = Path(sys.argv[1]) if len(sys.argv) == 2 else None
    for directory in evidence_directories():
        report_evidence(directory)
    report_failed_acceptance()
    if packet is not None:
        report_npm(packet)
        probe_downloads(packet)
    probe_tool_sources()
    probe_sandbox()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        say('REPORT_ERROR', type(error).__name__ + ' ' + str(error))
