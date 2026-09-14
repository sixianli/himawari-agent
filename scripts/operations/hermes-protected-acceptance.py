#!/usr/bin/python3
"""Restart the idle, already migrated service once; export bounded acceptance facts.

No configuration, ownership, installation, credentials or Payload data is changed.
The observer exits after 15 minutes or after a cancelled and completed new Run
have both reached terminal state in the two fixed synthetic acceptance threads.
"""
import argparse
import datetime
import fcntl
import json
import os
import pathlib
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time

ROOT = pathlib.Path('/data/hermes/himawari')
ATTEMPT = ROOT / 'qualifications/2026-09-11-protected/attempt-v5'
OUTPUT = ATTEMPT / 'live-acceptance'
THREADS = (
    'thread:5d4c4dc4-110f-4a5e-a5a0-8c701fa454ef',
    'thread:9e717296-a9f1-4d43-a3b2-fca2cafca124',
)
OWNER = 'owner-james-26b80231-cdeb-4ad9-bb02-850541005fff'
AGENT = 'agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3'
DIGEST = '2da9b4f6bc1a20f00478d457fc73602bebc4fd852bb78ac449a5190a966c568d'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def snapshot():
    with sqlite3.connect('file:' + str(ROOT / 'state/data/product.sqlite') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        active = db.execute("SELECT COUNT(*) FROM runs WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]
        budget = dict(db.execute('SELECT COALESCE(SUM(spent_cost_micros),0) AS spent, COALESCE(SUM(reserved_cost_micros),0) AS reserved FROM model_budget_accounts WHERE owner_id=? AND agent_id=?', (OWNER, AGENT)).fetchone())
        budget['priorMacUpperBoundMicros'] = 63653
        budget['combinedUpperBoundMicros'] = budget['spent'] + budget['reserved'] + 63653
        runs = [dict(row) for row in db.execute('SELECT id,status,created_at,updated_at FROM runs WHERE owner_id=? AND agent_id=? AND thread_id IN (?,?) ORDER BY created_at', (OWNER, AGENT, *THREADS))]
        for run in runs:
            run['jobs'] = []
            for row in db.execute('SELECT job_id,plan_json,facts_json FROM sandbox_execution_records WHERE run_id=?', (run['id'],)):
                facts = json.loads(row['facts_json'])
                result = facts.get('result') or {}
                resource = facts.get('resource') or {}
                run['jobs'].append({
                    'jobId': row['job_id'],
                    'operation': json.loads(row['plan_json']).get('operation'),
                    'resultKind': result.get('kind'),
                    'reasonCode': result.get('reasonCode'),
                    'termination': result.get('termination'),
                    'completion': result.get('completion'),
                    'supervision': resource.get('supervision'),
                    'cleanup': resource.get('cleanup'),
                    'resourceReason': resource.get('reasonCode'),
                    'occurredAt': result.get('occurredAt'),
                })
        return {'observedAt': now(), 'activeRuns': active, 'budget': budget, 'runs': runs}


def service():
    raw = subprocess.check_output(['systemctl', 'show', 'himawari.service', '-p', 'MainPID,User,Group,ActiveState,SubState,NoNewPrivileges'], text=True, timeout=15)
    return dict(line.split('=', 1) for line in raw.splitlines())


def publish(report):
    with tempfile.NamedTemporaryFile(mode='w', dir=OUTPUT, prefix='.report-', delete=False) as handle:
        json.dump(report, handle, indent=2)
        handle.write('\n')
        os.fchmod(handle.fileno(), 0o644)
        os.fsync(handle.fileno())
        name = handle.name
    os.replace(name, OUTPUT / 'summary.json')


def main():
    assert os.geteuid() == 0 and sys_flags_safe(), 'ADMINISTRATOR_REQUIRED'
    assert socket.gethostname() == 'hermes-home', 'WRONG_HOST'
    assert os.environ.get('INVOCATION_ID') and not os.isatty(0), 'DETACHED_SYSTEMD_REQUIRED'
    assert ATTEMPT.resolve() == ATTEMPT and ATTEMPT.stat().st_uid == 0
    manifest_path = pathlib.Path('/etc/himawari/runtime.json')
    assert manifest_path.resolve() == manifest_path
    mode = manifest_path.stat()
    assert mode.st_uid == 0 and not mode.st_mode & 0o022
    manifest = json.loads(manifest_path.read_text())
    assert manifest['runtimeDigest'] == DIGEST and manifest['runtimeUid'] == 998
    before = snapshot()
    assert before['activeRuns'] == 0, 'ACTIVE_RUNS_RESTART_REFUSED'
    current = service()
    assert current['User'] == 'himawari' and current['Group'] == 'himawari'
    assert current['ActiveState'] == 'active' and current['NoNewPrivileges'] == 'yes'
    OUTPUT.mkdir(mode=0o755)  # Refuse a duplicate attempt or an existing symlink.
    os.chmod(OUTPUT, 0o755)
    report = {'scope': 'one idle-service restart and bounded synthetic Run/budget observations; no Payload text', 'before': before, 'serviceBefore': current, 'restartStartedAt': now()}
    publish(report)
    offsets = {name: (ROOT / 'logs' / (name + '.log')).stat().st_size for name in ('agent', 'worker')}
    # Recheck immediately before the only service mutation.
    assert snapshot()['activeRuns'] == 0, 'NEW_ACTIVE_RUNS_RESTART_REFUSED'
    subprocess.run(['systemctl', 'restart', 'himawari.service'], check=True, timeout=90)
    ready = set()
    for _ in range(180):
        for name, offset in offsets.items():
            with (ROOT / 'logs' / (name + '.log')).open('rb') as handle:
                handle.seek(offset)
                data = handle.read()
            if b'"event":"service.ready"' in data or b'"event": "service.ready"' in data:
                ready.add(name)
        if len(ready) == 2:
            break
        time.sleep(1)
    report['serviceAfter'] = service()
    report['readyProcesses'] = sorted(ready)
    report['restartReadyAt'] = now()
    report['restartPassed'] = len(ready) == 2 and report['serviceAfter']['MainPID'] != current['MainPID'] and report['serviceAfter']['ActiveState'] == 'active'
    publish(report)
    assert report['restartPassed'], 'RESTART_READINESS_NOT_CONFIRMED'
    for _ in range(180):
        report['latest'] = snapshot()
        statuses = {run['status'] for run in report['latest']['runs'] if run['created_at'] > report['restartReadyAt']}
        finished = {'completed', 'cancelled'}.issubset(statuses) and report['latest']['activeRuns'] == 0
        report['observerStatus'] = 'acceptance_runs_terminal' if finished else 'observing'
        publish(report)
        if finished:
            return
        time.sleep(5)
    report['observerStatus'] = 'observation_window_ended'
    publish(report)


def sys_flags_safe():
    import sys
    return sys.flags.optimize == 0 and sys.flags.isolated == 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart-and-observe', action='store_true', required=True)
    parser.parse_args()
    lock = os.open('/run/himawari-protected-acceptance.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    assert os.fstat(lock).st_uid == 0 and stat.S_ISREG(os.fstat(lock).st_mode)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    main()
