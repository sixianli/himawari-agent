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
OUTPUT = ROOT / 'qualifications/2026-09-13-source-links-live'
OWNER = 'owner-james-26b80231-cdeb-4ad9-bb02-850541005fff'
AGENT = 'agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3'
START = '2026-09-12T11:20:03.000Z'
THREADS = ('thread:67f83b5e-f5ab-4313-9efd-94f30e4d97b3',
           'thread:63599620-84b5-44d5-adc3-61c65cc83041',
           'thread-fork:dbd3edc2-bda1-49cb-b1f9-3e0a0428acfe')
FILES = ('e2e-20260912-note.txt', 'e2e-20260912-rejected.txt',
         'e2e-20260912-script.py', 'e2e-20260912-script.log')


def observe(database):
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        scope = (OWNER, AGENT)
        runs = [dict(r) for r in db.execute(
            'SELECT id,thread_id,status,created_at,updated_at FROM runs '
            'WHERE owner_id=? AND agent_id=? AND created_at>=? AND thread_id IN (?,?,?) ORDER BY created_at',
            (*scope, START, *THREADS))]
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
            'SELECT a.model_ref,a.estimated_cost_micros,a.actual_cost_micros,a.status FROM model_budget_allocations a '
            'JOIN model_budget_accounts b ON b.owner_id=a.owner_id AND b.agent_id=a.agent_id AND b.account_id=a.account_id '
            'JOIN runs r ON r.owner_id=b.owner_id AND r.agent_id=b.agent_id AND r.id=b.run_id '
            'WHERE a.owner_id=? AND a.agent_id=? AND a.reserved_at>=? AND r.thread_id IN (?,?,?)', (*scope, START, *THREADS))]
        upper = sum(r['actual_cost_micros'] if r['status']=='settled' else
                    0 if r['status']=='released' else r['estimated_cost_micros'] for r in allocations)
        return {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'since': START, 'modelBudgetUpperBoundMicros': upper,
                'searchJobCount': sum(job['operation']=='web_search' for run in runs for job in run['jobs']),
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
        configuration=json.loads((ROOT/'config/production.json').read_text())
        assert configuration['ownerId']==OWNER and configuration['agentId']==AGENT
        report['configuredModelBudget']={key:configuration['budgets'][key] for key in ('globalCostMicros','perRunCostMicros','perClassificationCostMicros')}
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
