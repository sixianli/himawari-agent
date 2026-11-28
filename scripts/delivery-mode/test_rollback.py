import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import threading
import http.server
import unittest

HERE = Path(__file__).resolve().parent
NODE = os.environ.get('ROLLBACK_TEST_NODE', 'node')
PACKET_PARAMETERS = json.loads((HERE / 'fixtures' / 'twelfth-parameters.json').read_text())


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


remote = load('rollback_remote', 'rollback-remote.py')
orchestrator = load('rollback_orchestrator', 'rollback.py')
packet_maker = load('make_packet', 'make-packet.py')
DEPLOYMENT = {'id': 'himawari-prod-deployment', 'ownerId': 'owner:first-production', 'agentId': 'agent:first-production', 'revision': 7, 'status': 'active', 'authorityEpoch': 1, 'fencingToken': 12, 'transferId': None}
S0_READBACK = {
    'schema.current': PACKET_PARAMETERS['CURRENT_SCHEMA'],
    'schema.minimumWriter': PACKET_PARAMETERS['CURRENT_SCHEMA'],
    'identity.deploymentId': DEPLOYMENT['id'],
    'identity.hostId': 'host:rollback-test',
    'service.unitFragmentSha256': 'b' * 64,
    'service.configurationSha256': 'c' * 64,
    'authority.authorityEpoch': DEPLOYMENT['authorityEpoch'],
    'authority.fencingToken': DEPLOYMENT['fencingToken'],
    'authority.ownerId': DEPLOYMENT['ownerId'],
    'authority.agentId': DEPLOYMENT['agentId'],
    'authority.deploymentId': DEPLOYMENT['id'],
    'authority.status': DEPLOYMENT['status'],
}


def with_s0_readback(value):
    if isinstance(value, dict):
        return {key: with_s0_readback(item) for key, item in value.items()}
    if isinstance(value, list):
        return [with_s0_readback(item) for item in value]
    if isinstance(value, str) and value.startswith('S0_DB:'):
        return S0_READBACK[value.removeprefix('S0_DB:')]
    return value


def packet_from_template(target):
    packet_maker.render(target, PACKET_PARAMETERS)
    draft = json.loads((target / 'inputs' / 'bindings.draft.json').read_text())
    (target / 'inputs' / 'bindings.json').write_text(json.dumps(with_s0_readback(draft)))
    return target


def recovery_database(path, deployment):
    connection = sqlite3.connect(path)
    connection.execute('CREATE TABLE deployments (id TEXT PRIMARY KEY, owner_id TEXT, agent_id TEXT, revision INTEGER, status TEXT, authority_epoch INTEGER, fencing_token INTEGER, transfer_id TEXT)')
    connection.execute('INSERT INTO deployments VALUES (?,?,?,?,?,?,?,?)', [deployment[key] for key in ('id', 'ownerId', 'agentId', 'revision', 'status', 'authorityEpoch', 'fencingToken', 'transferId')])
    connection.commit()
    connection.close()


def mirror_file(path, deployment):
    path.write_text(json.dumps({'schemaVersion': 1, **deployment}, separators=(',', ':')) + '\n')
    os.chmod(path, 0o600)


class AuthorityMirrorTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.database = self.root / 'recovery.sqlite'
        self.mirror = self.root / 'authority.json'
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        recovery_database(self.database, DEPLOYMENT)

    def tearDown(self):
        self.directory.cleanup()

    def align(self):
        return remote.align_authority_mirror(self.mirror, self.database, DEPLOYMENT['id'], self.evidence, os.getuid(), os.getgid(), '20261025T120000Z', (os.getuid(), os.getgid()))

    def test_mirror_advanced_by_the_new_release_is_set_back_to_the_recovery_point(self):
        mirror_file(self.mirror, {**DEPLOYMENT, 'revision': 9, 'fencingToken': 14})
        original = self.mirror.read_bytes()
        result = self.align()
        self.assertTrue(result['changed'])
        self.assertEqual(json.loads(self.mirror.read_text()), {'schemaVersion': 1, **DEPLOYMENT})
        self.assertEqual(stat.S_IMODE(self.mirror.stat().st_mode), 0o600)
        self.assertEqual(Path(result['savedOriginal']).read_bytes(), original)
        self.assertEqual(result['originalSha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual((result['fencingTokenBefore'], result['fencingTokenAfter']), (14, 12))
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ['authority.json', 'evidence', 'recovery.sqlite'])

    def test_mirror_already_matching_the_recovery_point_is_left_alone(self):
        mirror_file(self.mirror, DEPLOYMENT)
        before = self.mirror.stat()
        self.assertFalse(self.align()['changed'])
        self.assertEqual(self.mirror.stat().st_ino, before.st_ino)
        self.assertEqual(list(self.evidence.iterdir()), [])


class PlanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        cls.packet = packet_from_template(Path(directory.name) / 'packet')

    def setUp(self):
        self.plan = orchestrator.rollback_plan(self.packet)

    def test_plan_matches_the_packet_rollback_route(self):
        binding = json.loads((self.packet / 'inputs' / 'bindings.json').read_text())
        schema = binding['maintenance']['expectedInitialSchema']
        self.assertEqual(self.plan['recoveryId'], binding['maintenance']['recovery' + str(schema) + 'Id'])
        self.assertEqual(self.plan['oldPrefix'], binding['paths']['oldPrefix'])
        self.assertEqual(self.plan['evidenceRoot'], binding['paths']['evidenceRoot'])

    def test_plan_runs_only_steps_the_packet_and_deploy_script_define(self):
        step_table = (self.packet / 'steps' / 'run-step.py').read_text()
        steps = set(re.findall(r"'(S[0-9]+_[A-Z0-9_]+)'", step_table))
        for action in (self.plan['restoreAction'], self.plan['controlAction']):
            self.assertIn(action, steps)
        maintenance = set(re.findall(r"'(S[0-9]+_[A-Z0-9_]+)'", re.search(r'^MAINTENANCE_ACTIONS = \{([^}]*)\}', step_table, re.M).group(1)))
        self.assertIn(self.plan['restoreAction'], maintenance)
        self.assertNotIn(self.plan['controlAction'], maintenance)
        self.assertRegex(step_table, "'" + re.escape(self.plan['controlAction']) + r"': \[[^\]]*'" + re.escape(self.plan['restoreAction']) + r"'\]")
        orders = [order.split() for order in re.findall(r'actions=\(([^)]*)\)', (HERE / 'deploy.sh').read_text())]
        self.assertTrue(orders)
        copies = {action for order in orders for action in order if action.startswith('S3_')}
        self.assertEqual(len(copies), 1)
        self.assertEqual(self.plan['recoveryReport'], copies.pop().lower() + '-result.json')

    def test_generated_approval_passes_the_packet_maintenance_check(self):
        approval = remote.approval_document(self.plan, 'a' * 64, '20261025T120000Z')
        script = (
            'import { readFileSync } from "node:fs";'
            'const common = await import(process.argv[1]);'
            'const binding = JSON.parse(readFileSync(process.argv[2], "utf8"));'
            'const approval = JSON.parse(process.argv[3]);'
            'common.verifyRollbackApproval(approval, common.rollbackApprovalExpectation(binding, approval.action));'
            'console.log("APPROVAL_ACCEPTED");'
        )
        child = subprocess.run([NODE, '--input-type=module', '-e', script, (self.packet / 'maintenance' / 'maintenance-common.mjs').as_uri(), str(self.packet / 'inputs' / 'bindings.json'), json.dumps(approval)], capture_output=True, text=True, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn('APPROVAL_ACCEPTED', child.stdout)


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        (root / 'config.json').write_bytes(b'old-config')
        (root / 'unit').write_bytes(b'old-unit')
        (root / 'evidence').mkdir()
        self.plan = {'config': str(root / 'config.json'), 'unitPath': str(root / 'unit'), 'evidenceRoot': str(root / 'evidence'), 'oldConfigSha256': hashlib.sha256(b'old-config').hexdigest(), 'oldUnitSha256': hashlib.sha256(b'old-unit').hexdigest(), 'databaseChangingReports': orchestrator.DATABASE_CHANGING_REPORTS}
        self.root = root

    def tearDown(self):
        self.directory.cleanup()

    def test_stop_before_any_switch_only_needs_the_old_release_started(self):
        (self.root / 'evidence' / 'step-s6_sign-1-result.json').write_text('{}')
        self.assertTrue(remote.untouched(self.plan))

    def test_I261128_a_failed_read_only_database_status_check_only_needs_the_old_release_started(self):
        (self.root / 'evidence' / 'step-s7_db_status-1795873685446334318-result.json').write_text('{}')
        self.assertTrue(remote.untouched(self.plan))

    def test_applied_config_needs_the_restore(self):
        (self.root / 'evidence' / 'step-s7_config_apply-1-started.json').write_text('{}')
        self.assertFalse(remote.untouched(self.plan))

    def test_catalog_upgrade_needs_the_restore(self):
        (self.root / 'evidence' / 'step-s7_catalog_upgrade-1-result.json').write_text('{}')
        self.assertFalse(remote.untouched(self.plan))

    def test_started_new_release_needs_the_restore(self):
        (self.root / 'evidence' / 'step-s7_switch_start-1-started.json').write_text('{}')
        self.assertFalse(remote.untouched(self.plan))

    def test_changed_config_needs_the_restore(self):
        (self.root / 'config.json').write_bytes(b'new-config')
        self.assertFalse(remote.untouched(self.plan))

    def test_missing_evidence_root_counts_as_untouched(self):
        self.plan['evidenceRoot'] = str(self.root / 'absent')
        self.assertTrue(remote.untouched(self.plan))


class FallbackTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        unit = Path(self.directory.name) / 'unit'
        unit.write_bytes(b'old-unit')
        self.unit = unit
        self.plan = {'unit': 'himawari.service', 'unitPath': str(unit), 'oldUnitSha256': hashlib.sha256(b'old-unit').hexdigest(), 'oldPrefix': '/opt/himawari/releases/old'}
        self.calls = []
        self.saved = remote.service, remote.subprocess.run
        remote.subprocess.run = lambda command, **_: self.calls.append(command[1:])

    def tearDown(self):
        remote.service, remote.subprocess.run = self.saved
        self.directory.cleanup()

    def started(self, plan):
        self.calls.append(['start'])
        return {'serviceAfter': {'SubState': 'running'}}

    def test_I261128_a_stopped_old_release_is_started_after_a_failed_rollback(self):
        remote.service = lambda unit: {'ActiveState': 'failed', 'SubState': 'failed', 'MainPID': '0'}
        result = remote.fallback(self.plan, self.started)
        self.assertEqual((result['started'], self.calls), (True, [['reset-failed', 'himawari.service'], ['start']]))

    def test_a_running_service_is_left_alone(self):
        remote.service = lambda unit: {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '42'}
        self.assertEqual((remote.fallback(self.plan, self.started)['started'], self.calls), (False, []))

    def test_a_unit_that_is_not_the_old_release_is_not_started(self):
        self.unit.write_bytes(b'new-unit')
        remote.service = lambda unit: {'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0'}
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_FALLBACK_UNIT_NOT_OLD'):
            remote.fallback(self.plan, self.started)
        self.assertEqual(self.calls, [])

    def test_I261128_every_rollback_failure_ends_with_the_fallback_and_still_reports_failure(self):
        source = (HERE / 'rollback.py').read_text()
        self.assertIn("    try:\n        route = recover(packet, plan)\n    except SystemExit as stopped:\n        keep_old_release_running(plan, stopped)", source)
        asked = []
        with self.assertRaises(SystemExit) as raised:
            orchestrator.keep_old_release_running(self.plan, SystemExit('ROLLBACK_STOPPED STEP_FAILED:S9_RAW_CONTROL51 exit=1'), lambda plan, mode: asked.append(mode) or {'started': True})
        self.assertEqual(asked, ['fallback'])
        self.assertIn('STEP_FAILED:S9_RAW_CONTROL51', str(raised.exception.code))
        self.assertIn('the old release is running', str(raised.exception.code))

    def test_a_failed_fallback_reports_both_failures(self):
        def refuse(plan, mode):
            raise SystemExit('ROLLBACK_STOPPED REMOTE_FALLBACK_FAILED')
        with self.assertRaises(SystemExit) as raised:
            orchestrator.keep_old_release_running(self.plan, SystemExit('ROLLBACK_STOPPED STEP_FAILED:S9_RAW_CONTROL51 exit=1'), refuse)
        self.assertEqual(str(raised.exception.code), 'ROLLBACK_STOPPED STEP_FAILED:S9_RAW_CONTROL51 exit=1 and ROLLBACK_STOPPED REMOTE_FALLBACK_FAILED')


class HomepageTest(unittest.TestCase):
    def serve(self, statuses):
        replies = list(statuses)

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(replies.pop(0) if len(replies) > 1 else replies[0])
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:' + str(server.server_address[1]) + '/'

    def target(self, url, host=None):
        return {'url': url, 'host': host or url.split('/')[2]}

    def test_homepage_address_comes_from_the_restored_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'publicOrigin': 'https://himawari.siyi.win', 'http': {'listenHost': '127.0.0.1', 'listenPort': 8400}}))
            self.assertEqual(remote.homepage_target(config), {'url': 'http://127.0.0.1:8400/', 'host': 'himawari.siyi.win'})

    def test_homepage_is_asked_for_under_the_public_host_the_service_accepts(self):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers['Host'])
                self.send_response(200 if self.headers['Host'] == 'himawari.siyi.win' else 403)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'publicOrigin': 'https://himawari.siyi.win', 'http': {'listenHost': '127.0.0.1', 'listenPort': server.server_address[1]}}))
            self.assertEqual(remote.wait_for_homepage(remote.homepage_target(config), timeout_seconds=1, interval_seconds=0.05), 200)
        self.assertEqual(seen, ['himawari.siyi.win'])

    def test_rollback_waits_until_the_homepage_answers_200(self):
        url = self.serve([503, 503, 200])
        self.assertEqual(remote.wait_for_homepage(self.target(url), timeout_seconds=10, interval_seconds=0.05), 200)

    def test_rollback_fails_when_the_homepage_never_answers_200(self):
        url = self.serve([503])
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_HOMEPAGE_NOT_READY:503'):
            remote.wait_for_homepage(self.target(url), timeout_seconds=0.3, interval_seconds=0.05)

    def test_rollback_fails_when_nothing_listens(self):
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_HOMEPAGE_NOT_READY:None'):
            remote.wait_for_homepage(self.target('http://127.0.0.1:9/'), timeout_seconds=0.2, interval_seconds=0.05)


if __name__ == '__main__':
    unittest.main()
