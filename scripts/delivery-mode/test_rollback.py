import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import threading
import http.server
import unittest

HERE = Path(__file__).resolve().parent
PACKET = Path(os.environ['ROLLBACK_TEST_PACKET'])
NODE = os.environ.get('ROLLBACK_TEST_NODE', 'node')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


remote = load('rollback_remote', 'rollback-remote.py')
orchestrator = load('rollback_orchestrator', 'rollback.py')
DEPLOYMENT = {'id': 'himawari-prod-deployment', 'ownerId': 'owner:first-production', 'agentId': 'agent:first-production', 'revision': 7, 'status': 'active', 'authorityEpoch': 1, 'fencingToken': 12, 'transferId': None}


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
    def setUp(self):
        self.plan = orchestrator.rollback_plan(PACKET)

    def test_plan_matches_the_packet_rollback_route(self):
        binding = json.loads((PACKET / 'inputs' / 'bindings.json').read_text())
        self.assertEqual(self.plan['restoreAction'], 'S9_RAW_RESTORE51')
        self.assertEqual(self.plan['controlAction'], 'S9_RAW_CONTROL51')
        self.assertEqual(self.plan['recoveryId'], binding['maintenance']['recovery51Id'])
        self.assertEqual(self.plan['oldPrefix'], binding['paths']['oldPrefix'])
        self.assertEqual(self.plan['evidenceRoot'], binding['paths']['evidenceRoot'])

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
        child = subprocess.run([NODE, '--input-type=module', '-e', script, (PACKET / 'maintenance' / 'maintenance-common.mjs').as_uri(), str(PACKET / 'inputs' / 'bindings.json'), json.dumps(approval)], capture_output=True, text=True, check=False)
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

    def test_started_new_release_needs_the_restore(self):
        (self.root / 'evidence' / 'step-s7_switch_start-1-started.json').write_text('{}')
        self.assertFalse(remote.untouched(self.plan))

    def test_changed_config_needs_the_restore(self):
        (self.root / 'config.json').write_bytes(b'new-config')
        self.assertFalse(remote.untouched(self.plan))

    def test_missing_evidence_root_counts_as_untouched(self):
        self.plan['evidenceRoot'] = str(self.root / 'absent')
        self.assertTrue(remote.untouched(self.plan))


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

    def test_homepage_address_comes_from_the_restored_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'http': {'listenHost': '127.0.0.1', 'listenPort': 8400}}))
            self.assertEqual(remote.homepage_url(config), 'http://127.0.0.1:8400/')

    def test_rollback_waits_until_the_homepage_answers_200(self):
        url = self.serve([503, 503, 200])
        self.assertEqual(remote.wait_for_homepage(url, timeout_seconds=10, interval_seconds=0.05), 200)

    def test_rollback_fails_when_the_homepage_never_answers_200(self):
        url = self.serve([503])
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_HOMEPAGE_NOT_READY:503'):
            remote.wait_for_homepage(url, timeout_seconds=0.3, interval_seconds=0.05)

    def test_rollback_fails_when_nothing_listens(self):
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_HOMEPAGE_NOT_READY:None'):
            remote.wait_for_homepage('http://127.0.0.1:9/', timeout_seconds=0.2, interval_seconds=0.05)


if __name__ == '__main__':
    unittest.main()
