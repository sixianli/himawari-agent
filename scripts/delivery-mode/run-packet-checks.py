import argparse
import concurrent.futures
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

NODE_FIXTURES = (
    'install/verify-source-cache-fixtures.mjs',
    'maintenance/verify-fixtures.mjs',
    'maintenance/verify-raw-copy-fixtures.mjs',
    'maintenance/verify-sidecar-tidy-fixtures.mjs',
    's0-db/verify-catalog-runtime-switch.mjs',
    'signing/verify-capability-manifest.mjs',
    'systemd/verify-startup-readiness-fixtures.mjs',
)
PYTHON_FIXTURES = (
    'maintenance/verify-s9-control-fixtures.py',
    'maintenance/verify-s9-raw-tree-fixtures.py',
    'install/verify-s9-clean-transport-fixtures.py',
    'acceptance/cloud/verify-failure-scene-fixtures.py',
    'signing/verify-finalize-capability-check.py',
    'measurement/verify-s6-report-contract.py',
)
HERMES_ONLY = ('steps/verify-steps.py',)
SRT_BOUNDARY = 'packages/runtime-sandbox/scripts/check-srt-boundary.mjs'
MIGRATE_FIXTURE = 'maintenance/verify-migrate-fixtures.mjs'
INSTALLED_PROBE = 'acceptance/cloud/adapters/probe-foreground.mjs'
PRODUCTION_PROBE_RUNNER = 'acceptance/cloud/run-network-preparation.py'
PI_TOOLS_VARIABLE = 'HIMAWARI_PACKET_PI_TOOLS'
INSTALLED_PROBE_TIMEOUT_SECONDS = 900
OLD_CONFIG_PENDING = "OLD_CONFIG_SHA = 'PENDING:s0.service.configurationSha256'\n"
OLD_CONFIG_HOLDERS = ('systemd/S2-stop-and-inspect.py', 'maintenance/S9-control-files.py')


def short_scratch():
    while True:
        path = Path('/tmp/h' + secrets.token_hex(2))
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            continue
        path.chmod(0o700)
        return path


def planned_schemas(packet):
    source = (packet / 'maintenance/maintenance-common.mjs').read_text()
    found = {name: re.findall(r'^export const ' + name + r' = ([0-9]+);$', source, re.M) for name in ('currentSchema', 'targetSchema')}
    if any(len(values) != 1 for values in found.values()):
        raise SystemExit('PACKET_CHECKS_SCHEMA_CONSTANTS_MISSING')
    return int(found['currentSchema'][0]), int(found['targetSchema'][0])


AUDIT_COPY = 'acceptance/cloud/probe-source/scripts/operations/workspace-lifecycle-audit.mjs'


def audit_script_problem(packet, target):
    path = packet / AUDIT_COPY
    if not path.is_file():
        return 'PACKET_CHECKS_AUDIT_SCRIPT_MISSING ' + AUDIT_COPY
    text = path.read_text()
    if len(re.findall(r'^export const LEGACY_MIGRATION_COUNT = [0-9]+;$', text, re.M)) == 1 and re.search(r'^export const AUDIT_READ_TABLES = Object\.freeze\(\[\s*"', text, re.M):
        return None
    found = re.findall(r'^export const SUPPORTED_SCHEMA_MAX = ([0-9]+);$', text, re.M)
    if len(found) != 1:
        return 'PACKET_CHECKS_AUDIT_SCRIPT_LIMIT_MISSING ' + AUDIT_COPY
    if int(found[0]) < target:
        return 'PACKET_CHECKS_AUDIT_SCRIPT_BEHIND supported=' + found[0] + ' targetSchema=' + str(target)
    return None


def expected_probe_count(packet):
    found = re.findall(r"pi\['passed'\] != ([0-9]+)", (packet / PRODUCTION_PROBE_RUNNER).read_text())
    if len(found) != 1:
        raise SystemExit('PACKET_CHECKS_PROBE_COUNT_MISSING ' + PRODUCTION_PROBE_RUNNER)
    return int(found[0])


def installed_probe_problem(packet, stdout):
    lines = stdout.decode(errors='replace').strip().splitlines()
    try:
        report = json.loads(lines[-1])
    except (IndexError, ValueError):
        return 'INSTALLED_PROBE_REPORT_MISSING'
    expected = expected_probe_count(packet)
    if report.get('passed') != expected:
        return 'INSTALLED_PROBE_COUNT passed=' + json.dumps(report.get('passed')) + ' expected=' + str(expected)
    if report.get('qualification') is not False:
        return 'INSTALLED_PROBE_QUALIFICATION_ISSUED'
    rows = report.get('reports')
    if not isinstance(rows, list) or len(rows) != expected:
        return 'INSTALLED_PROBE_REPORT_ROWS expected=' + str(expected)
    if not all(isinstance(row, dict) and row.get('namespaceState') == 'released' for row in rows):
        return 'INSTALLED_PROBE_NAMESPACE_NOT_RELEASED'
    return None


def pi_tools(environment):
    directory = environment.get(PI_TOOLS_VARIABLE)
    if not directory or not Path(directory).is_dir():
        return None
    found = {'bash': shutil.which('bash', path='/usr/bin:/bin'), 'rg': shutil.which('rg', path='/usr/bin:/bin'), 'fd': shutil.which('fd', path=directory)}
    return found if all(found.values()) else None


def install_candidate(command, packet, source, environment, output, prefix):
    install = [command[0], str(source / 'scripts/install-node-runtime.mjs'), '--prefix', str(prefix), '--artifact', str(candidate_archive(packet)), '--context', str(packet / 'materials/context.json')]
    return subprocess.run(install, cwd=source, env=environment, stdout=output, stderr=subprocess.STDOUT, check=False, umask=0o022).returncode


def run_installed_probe(command, packet, source, environment, output, scratch):
    tools = pi_tools(environment)
    if tools is None:
        output.write(b'INSTALLED_PROBE_PI_TOOLS_MISSING ' + PI_TOOLS_VARIABLE.encode() + b'\n')
        return 1
    prefix = scratch / 'prefix'
    code = install_candidate(command, packet, source, environment, output, prefix)
    if code != 0:
        return code
    runtime = prefix / 'lib/himawari-agent'
    binaries = runtime / 'pi-tools/bin'
    binaries.mkdir(parents=True)
    for name, found in tools.items():
        shutil.copy(found, binaries / name)
    probe_environment = {**environment, 'HOME': str(scratch), 'TMPDIR': str(scratch), 'HIMAWARI_TEST_TEMP_ROOT': str(scratch), 'HIMAWARI_LIVE_SANDBOX_PROBE': '1', 'HIMAWARI_PROBE_SCRATCH': str(scratch), 'HIMAWARI_PROBE_RUNTIME': str(runtime), 'NODE_PATH': '', 'NODE_OPTIONS': ''}
    try:
        result = subprocess.run(command, cwd=scratch, env=probe_environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=output, check=False, umask=0o022, timeout=INSTALLED_PROBE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        output.write(b'INSTALLED_PROBE_TIMEOUT ' + str(INSTALLED_PROBE_TIMEOUT_SECONDS).encode() + b'\n')
        return 1
    output.write(result.stdout)
    if result.returncode != 0:
        return result.returncode
    problem = installed_probe_problem(packet, result.stdout)
    if problem:
        output.write(problem.encode() + b'\n')
        return 1
    return 0


def plan(packet, node, python, include_hermes_only, migrating):
    checks = [(name, [str(node), str(packet / name)], 'source') for name in NODE_FIXTURES]
    checks.append(('systemd/fixtures/verify-doctor-fixtures.mjs', [str(node), '--test', str(packet / 'systemd/fixtures/verify-doctor-fixtures.mjs')], 'source'))
    checks.append(('systemd/verify-switch-config-fixtures.py', [python, '-I', str(packet / 'systemd/verify-switch-config-fixtures.py'), str(node)], 'source'))
    checks += [(name, [python, '-I', str(packet / name)], None) for name in PYTHON_FIXTURES]
    checks.append(('inputs/verify-finalize-bindings.py', [python, '-I', str(packet / 'inputs/verify-finalize-bindings.py'), str(node), 'SCRATCH'], None))
    checks.append(('inputs/verify-packet-consistency.py', [python, '-I', str(packet / 'inputs/verify-packet-consistency.py'), 'SCRATCH'], None))
    checks.append(('inputs/check-packet-consistency.py', [python, '-I', str(packet / 'inputs/check-packet-consistency.py'), str(packet)], None))
    if migrating:
        checks.append((MIGRATE_FIXTURE, [str(node), str(packet / MIGRATE_FIXTURE)], 'migrate'))
    if include_hermes_only:
        checks += [(name, [python, '-I', str(packet / name), 'SCRATCH'], None) for name in HERMES_ONLY]
        checks.append((SRT_BOUNDARY, [str(node), SRT_BOUNDARY], 'source'))
        checks.append((INSTALLED_PROBE, [str(node), str(packet / INSTALLED_PROBE)], 'installed-probe'))
    return checks


def candidate_archive(packet):
    archives = sorted((packet / 'materials').glob('linux-*-abi[0-9]*-*-1.tar.gz'))
    if len(archives) != 1:
        raise SystemExit('PACKET_CHECKS_CANDIDATE_ARCHIVE_COUNT ' + str(len(archives)))
    return archives[0]


def run_check(check, packet, source, environment, logs):
    name, command, directory = check
    scratch = short_scratch() if 'SCRATCH' in command or directory in ('migrate', 'installed-probe') else None
    command = [str(scratch) if part == 'SCRATCH' else part for part in command]
    log = logs / (name.replace('/', '_') + '.log')
    started = time.monotonic()
    try:
        with log.open('wb') as output:
            if directory == 'installed-probe':
                code = run_installed_probe(command, packet, source, environment, output, scratch)
            elif directory == 'migrate':
                prefix = scratch / 'prefix'
                code = install_candidate(command, packet, source, environment, output, prefix)
                if code == 0:
                    code = subprocess.run(command, cwd=source, env={**environment, 'HIMAWARI_MIGRATE_PREFIX': str(prefix)}, stdout=output, stderr=subprocess.STDOUT, check=False, umask=0o022).returncode
            else:
                code = subprocess.run(command, cwd=source if directory == 'source' else None, env=environment, stdout=output, stderr=subprocess.STDOUT, check=False, umask=0o022).returncode
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)
    return name, code, log, round(time.monotonic() - started, 1)


def main():
    parser = argparse.ArgumentParser(prog='run-packet-checks.py')
    parser.add_argument('packet')
    parser.add_argument('--node', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--logs')
    parser.add_argument('--skip-hermes-only', action='store_true')
    parser.add_argument('--record')
    parser.add_argument('--pi-tools')
    arguments = parser.parse_args()
    packet = Path(arguments.packet).resolve()
    node = Path(arguments.node).resolve()
    source = Path(arguments.source).resolve()
    for holder in OLD_CONFIG_HOLDERS:
        if (packet / holder).read_text().count(OLD_CONFIG_PENDING) != 1:
            print('PACKET_CHECKS_OLD_CONFIG_ALREADY_FILLED ' + holder)
            return 2
    current, target = planned_schemas(packet)
    if target != current:
        candidate_archive(packet)
        if not os.path.isabs(os.environ.get('HIMAWARI_CI_PYTHON', '')):
            print('PACKET_CHECKS_CI_PYTHON_REQUIRED')
            return 2
    problem = audit_script_problem(packet, target)
    if problem:
        print(problem)
        return 2
    python = '/usr/bin/python3' if Path('/usr/bin/python3').exists() else sys.executable
    logs = Path(arguments.logs).resolve() if arguments.logs else Path(tempfile.mkdtemp(prefix='packet-checks-'))
    logs.mkdir(parents=True, exist_ok=True)
    temp_root = short_scratch()
    environment = {**os.environ, 'PATH': str(node.parent) + ':/usr/bin:/bin', 'HIMAWARI_TEST_TEMP_ROOT': str(temp_root), 'PYTHONDONTWRITEBYTECODE': '1'}
    if arguments.pi_tools:
        environment[PI_TOOLS_VARIABLE] = arguments.pi_tools
    checks = plan(packet, node, python, not arguments.skip_hermes_only, target != current)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(checks)) as pool:
            results = sorted(pool.map(lambda check: run_check(check, packet, source, environment, logs), checks))
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
    failed = [result for result in results if result[1] != 0]
    for name, code, log, seconds in results:
        print('CHECK ' + name + ' rc=' + str(code) + ' ' + str(seconds) + 's')
    for name, code, log, seconds in failed:
        print('== ' + name)
        print('\n'.join(log.read_text(errors='replace').splitlines()[-12:]))
    if arguments.record:
        Path(arguments.record).write_text(json.dumps({'passed': not failed, 'currentSchema': current, 'targetSchema': target, 'checks': [{'name': name, 'exit': code, 'seconds': seconds} for name, code, log, seconds in results]}, indent=2) + '\n')
    print('PACKET_CHECKS ' + ('failed' if failed else 'passed') + ' ' + str(len(results) - len(failed)) + '/' + str(len(results)) + ' logs=' + str(logs))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
