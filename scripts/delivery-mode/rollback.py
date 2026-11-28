import base64
import json
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
DATABASE_CHANGING_REPORTS = ['step-s4', 'step-s5', 'step-s7_config_apply', 'step-s7_catalog_upgrade', 'step-s7_switch_start']
RECOVERY_COPY_ACTION = 'S3_COPY51'
RESTORE_ACTION = 'S9_RAW_RESTORE51'
CONTROL_ACTION = 'S9_RAW_CONTROL51'


def fail(code):
    raise SystemExit('ROLLBACK_STOPPED ' + code)


def rollback_plan(packet):
    binding = json.loads((packet / 'inputs' / 'bindings.json').read_text())
    match = re.fullmatch(r'himawari\.([a-z]+)-change-bindings\.v1', binding['schemaVersion'])
    if not match:
        fail('BINDINGS_SCHEMA_UNKNOWN:' + binding['schemaVersion'])
    schema = binding['maintenance']['expectedInitialSchema']
    return {
        'address': binding['host']['address'],
        'hostname': binding['host']['hostname'],
        'uid': binding['host']['uid'],
        'gid': binding['host']['gid'],
        'unit': binding['service']['unit'],
        'unitPath': binding['service']['unitFragmentPath'],
        'oldUnitSha256': binding['service']['oldUnitSha256'],
        'oldConfigSha256': binding['service']['oldConfigSha256'],
        'config': binding['paths']['config'],
        'stateRoot': binding['paths']['stateRoot'],
        'database': binding['paths']['database'],
        'evidenceRoot': binding['paths']['evidenceRoot'],
        'oldPrefix': binding['paths']['oldPrefix'],
        'deploymentId': binding['identity']['deploymentId'],
        'approvalSchema': 'himawari.' + match.group(1) + '-change-rollback-approval.v1',
        'restoreAction': RESTORE_ACTION,
        'controlAction': CONTROL_ACTION,
        'recoveryId': binding['maintenance']['recovery' + str(schema) + 'Id'],
        'recoveryReport': RECOVERY_COPY_ACTION.lower() + '-result.json',
        'databaseChangingReports': DATABASE_CHANGING_REPORTS,
    }


def remote(plan, mode):
    encoded = base64.b64encode(json.dumps(plan).encode()).decode()
    script = (HERE / 'rollback-remote.py').read_bytes()
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', 'root@' + plan['address'], '/usr/bin/python3 -I - ' + mode + ' ' + encoded]
    child = subprocess.run(command, input=script, stdout=subprocess.PIPE, check=False)
    output = child.stdout.decode()
    sys.stdout.write(output)
    if child.returncode != 0:
        fail('REMOTE_' + mode.upper() + '_FAILED')
    line = next(line for line in output.splitlines() if line.startswith('ROLLBACK_REMOTE_RESULT '))
    return json.loads(line.split(' ', 1)[1])


def step(packet, action):
    print('ROLLBACK_STEP_START ' + action, flush=True)
    code = subprocess.run(['/bin/bash', str(packet / 'steps' / 'run-user-step.sh'), action], check=False).returncode
    if code != 0:
        fail('STEP_FAILED:' + action + ' exit=' + str(code))
    print('ROLLBACK_STEP_PASSED ' + action, flush=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: bash rollback.sh <operation packet directory>')
    packet = Path(sys.argv[1]).resolve()
    consistency = packet / 'inputs' / 'check-packet-consistency.py'
    if consistency.exists() and subprocess.run(['/usr/bin/python3', '-I', str(consistency), str(packet)], stdout=subprocess.DEVNULL, check=False).returncode != 0:
        fail('PACKET_INCONSISTENT')
    plan = rollback_plan(packet)
    try:
        route = recover(packet, plan)
    except SystemExit as stopped:
        keep_old_release_running(plan, stopped)
    print('ROLLBACK_PASSED route=' + route + ' release=' + plan['oldPrefix'])
    return 0


def recover(packet, plan):
    prepared = remote(plan, 'prepare')
    if prepared['route'] == 'restore':
        step(packet, 'S2_INSPECT')
        if prepared['sidecars']:
            step(packet, 'S9_SIDECAR_TIDY')
        step(packet, plan['restoreAction'])
        step(packet, plan['controlAction'])
    remote(plan, 'start')
    return prepared['route']


def keep_old_release_running(plan, stopped, run_remote=None):
    print(str(stopped.code), file=sys.stderr, flush=True)
    print('ROLLBACK_FALLBACK_START: making sure the old release is running even though the rollback stopped', flush=True)
    try:
        result = (run_remote or remote)(plan, 'fallback')
    except SystemExit as fallback_stopped:
        raise SystemExit(str(stopped.code) + ' and ' + str(fallback_stopped.code)) from None
    print('ROLLBACK_FALLBACK_RUNNING started=' + str(result.get('started')).lower() + ' release=' + plan['oldPrefix'], flush=True)
    raise SystemExit(str(stopped.code) + ' (the old release is running; the rollback did not finish, so check its data before deploying again)')


if __name__ == '__main__':
    sys.exit(main())
