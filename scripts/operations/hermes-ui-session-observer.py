#!/usr/bin/python3
"""Export bounded E2E cost, execution and test-file facts; never mutate product state."""
import datetime
import hashlib
import json
import os
import pathlib
import socket
import sqlite3
import stat
import tempfile
import time

ROOT = pathlib.Path('/data/hermes/himawari')
OUTPUT = ROOT / 'qualifications/2026-09-12-ui-session-live'
OWNER = 'owner-james-26b80231-cdeb-4ad9-bb02-850541005fff'
AGENT = 'agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3'
START = '2026-09-11T15:39:00.000Z'
FILES = ('e2e-20260912-note.txt', 'e2e-20260912-rejected.txt',
         'e2e-20260912-script.py', 'e2e-20260912-script.log')


def observe(database):
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        scope = (OWNER, AGENT)
        runs = [dict(r) for r in db.execute(
            'SELECT id,thread_id,status,created_at,updated_at FROM runs '
            'WHERE owner_id=? AND agent_id=? AND created_at>=? ORDER BY created_at',
            (*scope, START))]
        for run in runs:
            run['budget'] = [dict(r) for r in db.execute(
                'SELECT reserved_cost_micros,spent_cost_micros,status FROM model_budget_accounts '
                'WHERE owner_id=? AND agent_id=? AND run_id=?', (*scope, run['id']))]
            run['events'] = [dict(r) for r in db.execute(
                'SELECT sequence,event_type,occurred_at FROM trace_events '
                'WHERE owner_id=? AND agent_id=? AND run_id=? ORDER BY sequence', (*scope, run['id']))]
            run['history'] = dict(db.execute(
                "SELECT COUNT(*) AS artifacts,MAX(history_sequence) AS latest_sequence FROM run_payload_artifacts "
                "WHERE owner_id=? AND agent_id=? AND run_id=? AND purpose='runtime_history'", (*scope, run['id'])).fetchone())
            run['jobs'] = []
            for row in db.execute('SELECT job_id,plan_json,facts_json FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND run_id=?', (*scope, run['id'])):
                facts = json.loads(row['facts_json'])
                result, resource = facts.get('result') or {}, facts.get('resource') or {}
                run['jobs'].append({'jobId': row['job_id'], 'operation': json.loads(row['plan_json']).get('operation'),
                    'resultKind': result.get('kind'), 'reasonCode': result.get('reasonCode'),
                    'cleanup': resource.get('cleanup'), 'supervision': resource.get('supervision')})
        allocations = [dict(r) for r in db.execute(
            'SELECT model_ref,estimated_cost_micros,actual_cost_micros,status FROM model_budget_allocations '
            'WHERE owner_id=? AND agent_id=? AND reserved_at>=?', (*scope, START))]
        upper = sum(r['actual_cost_micros'] if r['status']=='settled' else
                    0 if r['status']=='released' else r['estimated_cost_micros'] for r in allocations)
        return {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'since': START, 'modelBudgetUpperBoundMicros': upper,
                'additionalAuthorizedBudgetMicros': 2000000, 'allocations': allocations, 'runs': runs}


def file_facts():
    result = []
    base = ROOT / 'workspaces/default'
    for name in FILES:
        path = base / name
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            result.append({'name': name, 'exists': False})
            continue
        with os.fdopen(fd, 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise RuntimeError('UNEXPECTED_TEST_FILE')
            content = f.read(65537)
            if len(content)>65536:
                raise RuntimeError('TEST_FILE_CHANGED')
            result.append({'name':name, 'exists':True, 'bytes':len(content),
                           'sha256':hashlib.sha256(content).hexdigest()})
    return result


def main():
    assert os.geteuid()==0 and socket.gethostname()=='hermes-home'
    assert os.environ.get('INVOCATION_ID') and not os.isatty(0)
    OUTPUT.mkdir(mode=0o711)  # Exclusive attempt; preserve previous evidence.
    for _ in range(720):
        report = observe(ROOT / 'state/data/product.sqlite')
        report['files'] = file_facts()
        with tempfile.NamedTemporaryFile(mode='w', dir=OUTPUT, delete=False) as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
            f.write('\n')
            os.fchmod(f.fileno(), 0o644)
            os.fsync(f.fileno())
            name = f.name
        os.replace(name, OUTPUT / 'summary.json')
        time.sleep(5)


if __name__ == '__main__':
    main()
