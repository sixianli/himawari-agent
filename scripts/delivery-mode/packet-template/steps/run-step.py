import datetime
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
base = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packet_common', base / 'packet-common.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
ENTRY = common.OPERATIONS / 'steps' / 'run-step.py'
MAINTENANCE_ACTIONS = {'S3_COPY51', 'S7_DB_STATUS', 'S7_CONFIG_APPLY', 'S7_CATALOG_UPGRADE', 'S8_READBACK', 'S9_SIDECAR_TIDY', 'S9_RAW_RESTORE51'}


def command_for(action, stage=common.STAGE, operations=common.OPERATIONS):
    node = '/opt/himawari/node/bin/node'
    if action in MAINTENANCE_ACTIONS:
        return ['/usr/sbin/runuser', '-u', 'himawari-prod', '--', '/usr/bin/env', '-i', 'HOME=/var/lib/himawari/state', 'PATH=/opt/himawari/node/bin:/usr/bin:/bin', 'LANG=C.UTF-8', node, '--no-global-search-paths', str(operations / 'maintenance/run-maintenance.mjs'), action]
    commands = {
        'S2_STOP': ['/usr/bin/python3', '-I', str(operations / 'systemd/S2-stop-and-inspect.py')],
        'S2_INSPECT': ['/usr/bin/python3', '-I', str(operations / 'systemd/S2-stop-and-inspect.py'), '--inspect-only'],
        'S6_ACCEPTANCE': ['/bin/bash', str(stage / 'acceptance/S6-limited-host-acceptance.sh'), '--approved-r2l13-__PKT_LABEL__-deployment-qualification'],
        'S6_PUBLISH_MATERIALS': ['/usr/bin/python3', '-I', str(stage / 'signing/publish-signing-materials.py'), '--approved-s6-material-publication'],
        'S6_FINALIZE_BINDINGS': ['/usr/bin/python3', '-I', str(stage / 'signing/finalize-binding-inputs.py'), '--approved-s6-binding-publication'],
        'S6_SIGN': ['/bin/bash', str(stage / 'signing/sign-__PKT_LABEL__.sh'), '--approved-s6-signing'],
        'S6_RUNTIME_PROTECTION': [node, '--no-global-search-paths', str(stage / 'signing/publish-runtime-protection.mjs')],
        'S6_READ': ['/usr/bin/python3', '-I', str(operations / 'measurement/S6-service-read.py'), '--approved-s6-service-environment-read'],
        'S7_SWITCH_START': ['/usr/bin/python3', '-I', str(stage / 'systemd/S7-switch-start-readback.py'), '--approved-r2l13-__PKT_LABEL__-deployment-switch-start'],
        'S9_RAW_CONTROL51': ['/usr/bin/python3', '-I', str(operations / 'maintenance/S9-control-files.py'), 'S9_RAW_RESTORE51'],
        'S9_TRANSPORT_PREFLIGHT': ['/usr/bin/python3', '-I', str(operations / 'install/S9-clean-transport.py'), '--preflight'],
        'S9_TRANSPORT_APPLY': ['/usr/bin/python3', '-I', str(operations / 'install/S9-clean-transport.py'), '--apply'],
    }
    common.require(action in commands, '__PKT_LABEL_UPPER___STEP_ACTION_INVALID')
    return commands[action]


def verify_operations(frozen):
    for name, entry in common.operations_members(frozen['members']).items():
        common.require(common.record(common.OPERATIONS / name, 0) == {key: entry[key] for key in ('bytes', 'sha256')}, '__PKT_LABEL_UPPER___STEP_OPERATIONS_CHANGED:' + name)
    for name in common.FLAT_HELPERS:
        target = common.OPERATIONS / name
        if os.path.lexists(target):
            expected = frozen['members']['signing/' + name]
            common.require(common.record(target, 0) == {key: expected[key] for key in ('bytes', 'sha256')}, '__PKT_LABEL_UPPER___STEP_FLAT_HELPER_CHANGED:' + name)


def failure_tail(path, lines=40, width=300):
    try:
        text = path.read_bytes().decode('utf-8', 'replace')
    except OSError as error:
        return ['unreadable ' + type(error).__name__]
    return [line[:width] for line in text.splitlines() if line.strip()][-lines:]


FAILURE_FILE_SUFFIXES = ('.stderr', '.err', '.log')
FAILURE_FILE_SKIPPED_DIRECTORIES = {'node_modules', '.git', 'source', 'scratch-failure-files'}
FAILURE_REPORT_KEYS = ('failure', 'failureCode', 'failedCondition', 'failureDetail', 'error', 'errors', 'reason', 'runnerErrors', 'readbackErrors', 'runtimeIntegrityFailure', 'fault')


def written_files(roots, since_ns, accept):
    found = []
    for root in roots:
        if not root.is_dir() or root.is_symlink():
            continue
        for parent, directories, files in os.walk(root):
            directories[:] = sorted(name for name in directories if name not in FAILURE_FILE_SKIPPED_DIRECTORIES)
            for filename in files:
                if not accept(filename):
                    continue
                path = Path(parent) / filename
                try:
                    info = path.lstat()
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_mtime_ns < since_ns or info.st_size == 0:
                    continue
                found.append((info.st_mtime_ns, str(path), path))
    return [path for _, _, path in sorted(found)]


def failure_files(roots, since_ns, own_name, limit=12):
    return written_files(roots, since_ns, lambda filename: filename.endswith(FAILURE_FILE_SUFFIXES) and not filename.startswith(own_name + '.'))[-limit:]


def failed_reports(roots, since_ns, limit=8, width=1500):
    found = []
    for path in written_files(roots, since_ns, lambda filename: filename.endswith('.json')):
        try:
            if path.stat().st_size > 4 * 1024 * 1024:
                continue
            value = json.loads(path.read_bytes())
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict) or value.get('passed') is not False:
            continue
        details = {key: value[key] for key in FAILURE_REPORT_KEYS if value.get(key)}
        failed = [entry.get('id') or entry.get('name') for entry in value.get('assertions', []) if isinstance(entry, dict) and entry.get('passed') is False]
        if failed:
            details['failedAssertions'] = failed[:20]
        failed_commands = [{'name': entry.get('name'), 'exitCode': entry.get('exitCode')} for entry in value.get('commands', []) if isinstance(entry, dict) and entry.get('exitCode') not in (0, None)]
        if failed_commands:
            details['failedCommands'] = failed_commands[:20]
        if details:
            found.append((path, json.dumps(details, ensure_ascii=False, sort_keys=True)[:width]))
    return found[-limit:]


def main():
    os.umask(0o022)
    common.require(len(sys.argv) == 4 and sys.argv[1] == '--approved-r2l13-__PKT_LABEL__-step' and re.fullmatch('[a-f0-9]{64}', sys.argv[3]) and sys.executable == '/usr/bin/python3' and sys.flags.isolated == 1 and sys.platform == 'linux' and os.getuid() == 0 and socket.gethostname() == '__PKT_HOSTNAME__' and Path(__file__).resolve() == ENTRY, '__PKT_LABEL_UPPER___STEP_EXPLICIT_ROOT_TARGET_REQUIRED')
    account = pwd.getpwnam('himawari-prod')
    common.require((account.pw_uid, account.pw_gid) == (__PKT_SERVICE_UID__, __PKT_SERVICE_GID__), '__PKT_LABEL_UPPER___STEP_SERVICE_ACCOUNT_CHANGED')
    action = sys.argv[2]
    argv = command_for(action)
    frozen = common.verify_frozen(common.STAGE, common.APPROVED_REF, 0, exact=False)
    common.require(frozen['freezeSha256'] == sys.argv[3], '__PKT_LABEL_UPPER___STEP_EXPECTED_FREEZE_CHANGED')
    verify_operations(frozen)
    result_bytes = common.read(common.EVIDENCE / 's1-result.json', __PKT_SERVICE_UID__)
    result = json.loads(result_bytes)
    common.require(result.get('passed') is True, '__PKT_LABEL_UPPER___STEP_SUCCESSFUL_S1_REQUIRED')
    if action not in {'S2_STOP', 'S6_ACCEPTANCE', 'S8_READBACK', 'S9_TRANSPORT_PREFLIGHT', 'S9_TRANSPORT_APPLY'}:
        common.service_state()
    started_ns = time.time_ns()
    suffix = str(started_ns)
    report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-step.v1', 'action': action, 'passed': False, 'actor': {'uid': 0, 'hostname': socket.gethostname()}, 'freezeSha256': frozen['freezeSha256'], 'bindingsSha256': frozen['bindingsSha256'], 's1ReportSha256': common.sha(result_bytes), 'command': argv, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'automaticRollbackOrStart': False}
    name = 'step-' + action.lower() + '-' + suffix
    common.publish(common.EVIDENCE / (name + '-started.json'), (json.dumps(report, indent=2) + '\n').encode(), 0, __PKT_SERVICE_GID__, 0o640)
    try:
        with (common.EVIDENCE / (name + '.stdout')).open('xb') as output, (common.EVIDENCE / (name + '.stderr')).open('xb') as error:
            for stream in (output, error):
                os.fchmod(stream.fileno(), 0o600)
            child = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=error, cwd=str(common.OPERATIONS), env={'PATH': '/opt/himawari/node/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}, check=False)
        report['exitCode'] = child.returncode
        report['passed'] = child.returncode == 0
        for extension in ('stdout', 'stderr'):
            path = common.EVIDENCE / (name + '.' + extension)
            report[extension] = {'path': str(path), **common.record(path, 0)}
    except Exception as error:
        report['exitCode'] = 1
        report['failureCode'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    path = common.EVIDENCE / (name + '-result.json')
    common.publish(path, (json.dumps(report, indent=2) + '\n').encode(), 0, __PKT_SERVICE_GID__, 0o640)
    if not report['passed']:
        for extension in ('stderr', 'stdout'):
            for line in failure_tail(common.EVIDENCE / (name + '.' + extension), lines=80 if extension == 'stderr' else 40):
                print('STEP_FAILURE_TAIL ' + extension + ' ' + line)
        roots = [common.EVIDENCE, common.STAGE.parent]
        for found in failure_files(roots, started_ns, name):
            print('STEP_FAILURE_FILE ' + str(found))
            for line in failure_tail(found, lines=20):
                print('STEP_FAILURE_TAIL ' + found.name + ' ' + line)
        for found, details in failed_reports(roots, started_ns):
            for start in range(0, len(details), 300):
                print('STEP_FAILURE_REPORT ' + str(found) + ' ' + details[start:start + 300])
    print(json.dumps({'passed': report['passed'], 'action': action, 'exitCode': report['exitCode'], 'report': str(path), 'sha256': common.sha(common.read(path, 0))}))
    return report['exitCode'] if 0 <= report['exitCode'] <= 255 else 1


if __name__ == '__main__':
    sys.exit(main())
