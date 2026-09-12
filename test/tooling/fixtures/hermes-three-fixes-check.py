"""仅使用合成 SQLite 数据检查本次验收导出的范围和费用上界。"""
import json
import hashlib
import pathlib
import runpy
import sqlite3
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
observer = runpy.run_path(str(ROOT / 'scripts/operations/hermes-three-fixes-observer.py'))
qualifier = runpy.run_path(str(ROOT / 'scripts/operations/hermes-three-fixes-qualify.py'))
static_check = runpy.run_path(str(ROOT / 'scripts/operations/hermes-three-fixes-cutover-v2.py'))['verify_web']

with tempfile.TemporaryDirectory(prefix='himawari-three-fixes-') as directory:
    database = pathlib.Path(directory) / 'synthetic.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript('''
          CREATE TABLE runs(owner_id,agent_id,id,thread_id,status,created_at,updated_at,private_body);
          CREATE TABLE model_budget_accounts(owner_id,agent_id,account_id,run_id,reserved_cost_micros,spent_cost_micros,status);
          CREATE TABLE model_budget_allocations(owner_id,agent_id,account_id,model_ref,estimated_cost_micros,actual_cost_micros,status,reserved_at);
          CREATE TABLE trace_events(owner_id,agent_id,run_id,sequence,event_type,occurred_at);
          CREATE TABLE run_payload_artifacts(owner_id,agent_id,run_id,purpose,history_sequence);
          CREATE TABLE sandbox_execution_records(owner_id,agent_id,run_id,job_id,plan_json,facts_json);
        ''')
        owner, agent = observer['OWNER'], observer['AGENT']
        now = observer['START']
        for run_id, thread, created in [
            ('current', observer['THREADS'][0], now),
            ('unrelated', 'private-unrelated-thread', now),
            ('historical', observer['THREADS'][0], '2026-09-11T00:00:00.000Z'),
        ]:
            db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)',
                       (owner, agent, run_id, thread, 'completed', created, created, 'PRIVATE_SENTINEL'))
            db.execute('INSERT INTO model_budget_accounts VALUES(?,?,?,?,?,?,?)',
                       (owner, agent, 'run:'+run_id, run_id, 0, 0, 'settled'))
        for state, estimated, actual in [('settled', 20, 10), ('reserved', 30, None),
                                          ('released', 50, None), ('unknown', 70, None)]:
            db.execute('INSERT INTO model_budget_allocations VALUES(?,?,?,?,?,?,?,?)',
                       (owner, agent, 'run:current', 'synthetic', estimated, actual, state, now))
        for account, reserved in [('run:unrelated', now), ('run:historical', '2026-09-11T00:00:00.000Z')]:
            db.execute('INSERT INTO model_budget_allocations VALUES(?,?,?,?,?,?,?,?)',
                       (owner, agent, account, 'private-model', 9000, 9000, 'settled', reserved))
        db.execute('INSERT INTO sandbox_execution_records VALUES(?,?,?,?,?,?)',
                   (owner, agent, 'current', 'job-current', json.dumps({'operation':'web_search'}),
                    json.dumps({'result':{'kind':'succeeded'},'resource':{'cleanup':'confirmed','supervision':'released'}})))
    result = observer['observe'](database)
    assert result['modelBudgetUpperBoundMicros'] == 110
    assert result['searchJobCount'] == 1
    assert [r['id'] for r in result['runs']] == ['current']
    assert len(result['allocations']) == 4
    assert 'PRIVATE_SENTINEL' not in json.dumps(result)
    assert 'private-model' not in json.dumps(result)
    link = pathlib.Path(directory) / 'symlink'
    link.symlink_to(database)
    try:
        qualifier['plain'](link)
    except AssertionError:
        pass
    else:
        raise AssertionError('符号链接不能作为规范安装文件')

    source = pathlib.Path(directory).resolve() / 'probe-source'
    build = pathlib.Path(directory).resolve() / 'original-build'
    package = source / 'packages/example'
    package.mkdir(parents=True)
    (package/'package.json').write_text(json.dumps({'name':'@himawari-agent/example'}))
    workspace = source/'node_modules/@himawari-agent'
    workspace.mkdir(parents=True)
    workspace_link = workspace/'example'
    workspace_link.symlink_to(build/'packages/example')
    assert qualifier['localize_workspace_links'](source, build) == 1
    assert not workspace_link.readlink().is_absolute()
    assert workspace_link.resolve() == package
    assert qualifier['localize_workspace_links'](source, build) == 0

    workspace_link.unlink()
    workspace_link.symlink_to(build/'packages/example')
    external = source/'node_modules/unrelated'
    external.symlink_to(pathlib.Path(directory)/'private')
    try:
        qualifier['localize_workspace_links'](source, build)
    except AssertionError as error:
        assert str(error) == 'UNSAFE_SOURCE_LINK'
    else:
        raise AssertionError('不能重定位任意外部依赖')
    assert workspace_link.readlink() == build/'packages/example'
    external.unlink()
    (package/'package.json').write_text(json.dumps({'name':'@himawari-agent/different'}))
    try:
        qualifier['localize_workspace_links'](source, build)
    except AssertionError as error:
        assert str(error) == 'WORKSPACE_LINK_MISMATCH'
    else:
        raise AssertionError('包身份不匹配时不能重定位')

    artifact = pathlib.Path(directory).resolve()/'browser-artifact'
    html = b'<html>synthetic browser artifact</html>'
    static_check.__globals__['FILES'] = {'index.html':hashlib.sha256(html).hexdigest()}
    try:
        static_check(artifact)
    except AssertionError as error:
        assert str(error) == 'STATIC_ROOT_MISSING_OR_LINKED'
    else:
        raise AssertionError('缺失页面目录必须在停机前被拒绝')
    artifact.mkdir()
    (artifact/'index.html').write_bytes(html)
    static_check(artifact)
    (artifact/'index.html').write_text('corrupted')
    try:
        static_check(artifact)
    except AssertionError as error:
        assert str(error) == 'STATIC_FILE_CHANGED'
    else:
        raise AssertionError('损坏页面不能通过摘要检查')
    (artifact/'index.html').unlink()
    (artifact/'index.html').symlink_to(database)
    try:
        static_check(artifact)
    except AssertionError as error:
        assert str(error) == 'STATIC_FILE_UNSAFE'
    else:
        raise AssertionError('页面不能通过符号链接读取其他数据')

for name, digest in qualifier['INPUTS'].items():
    source = ROOT / ('scripts/probe-protected-runtime.mjs' if name == 'probe-protected-runtime.mjs'
                     else 'scripts/operations/' + name)
    assert qualifier['sha'](source) == digest, name
assert 'source-manifest.json' in (ROOT/'scripts/operations/hermes-three-fixes-seal.mjs').read_text()
