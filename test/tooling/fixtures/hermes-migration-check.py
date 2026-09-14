"""Exercise the real handoff function; chown is the only simulated OS boundary."""
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[3] / "scripts/operations/hermes-protected-migration.py"
spec = importlib.util.spec_from_file_location("migration", SOURCE)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
acceptance_spec = importlib.util.spec_from_file_location("acceptance", SOURCE.with_name("hermes-protected-acceptance.py"))
acceptance = importlib.util.module_from_spec(acceptance_spec)
acceptance_spec.loader.exec_module(acceptance)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.workspace = self.root / "workspaces/default"
        self.user = types.SimpleNamespace(pw_uid=998, pw_gid=998)
        self.owner = types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
        for name in migration.MUTABLE:
            (self.root / name).mkdir(mode=0o700)
        self.workspace.mkdir(mode=0o700)
        (self.workspace / "preserve.txt").write_text("existing user data")
        self.transferred = []
        self.stack = []
        for name, value in [("R", self.root), ("ANDY", self.owner)]:
            context = patch.object(migration, name, value)
            context.start()
            self.addCleanup(context.stop)

    def chown(self, filename, uid, gid, *, follow_symlinks):
        self.assertFalse(follow_symlinks)
        self.assertEqual((uid, gid), (998, 998))
        self.transferred.append(filename)

    def test_signer_can_read_private_workspace_before_handoff(self):
        before = self.workspace.stat()

        def sign():
            # The actual signer runs as andy and stats this child of a 0700 root.
            if self.root / "workspaces" in self.transferred:
                raise PermissionError("EACCES: signer lost workspace access")
            self.assertEqual(self.workspace.stat().st_ino, before.st_ino)

        with patch.object(migration.os, "chown", self.chown):
            migration.handoff_runtime_data(self.user, sign)
        self.assertIn(self.workspace, self.transferred)
        self.assertEqual(self.workspace.stat().st_ino, before.st_ino)
        self.assertEqual(self.workspace.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.workspace / "preserve.txt").read_text(), "existing user data")

    def test_failed_signing_does_not_transfer_any_data(self):
        def fail():
            raise ValueError("SIGNING_FAILED")

        with patch.object(migration.os, "chown", self.chown):
            with self.assertRaisesRegex(ValueError, "SIGNING_FAILED"):
                migration.handoff_runtime_data(self.user, fail)
        self.assertEqual(self.transferred, [])

    def test_replaced_workspace_is_rejected_before_transfer(self):
        def replace():
            self.workspace.rename(self.workspace.with_name("preserved-original"))
            self.workspace.mkdir(mode=0o700)

        with patch.object(migration.os, "chown", self.chown):
            with self.assertRaisesRegex(AssertionError, "WORKSPACE_IDENTITY_CHANGED"):
                migration.handoff_runtime_data(self.user, replace)
        self.assertEqual(self.transferred, [])

    def test_replaced_workspace_during_transfer_is_rejected(self):
        def replace(filename, uid, gid, *, follow_symlinks):
            self.chown(filename, uid, gid, follow_symlinks=follow_symlinks)
            if filename == self.workspace:
                self.workspace.rename(self.workspace.with_name("preserved-original"))
                self.workspace.mkdir(mode=0o700)

        with patch.object(migration.os, "chown", replace):
            with self.assertRaisesRegex(AssertionError, "WORKSPACE_IDENTITY_CHANGED"):
                migration.handoff_runtime_data(self.user, lambda: None)


class AcceptanceSnapshotTests(unittest.TestCase):
    def test_export_is_read_only_scoped_and_includes_unsettled_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'state/data').mkdir(parents=True)
            database = root / 'state/data/product.sqlite'
            with sqlite3.connect(database) as db:
                db.executescript('''
                    CREATE TABLE runs(id,status,created_at,updated_at,owner_id,agent_id,thread_id);
                    CREATE TABLE model_budget_accounts(owner_id,agent_id,spent_cost_micros,reserved_cost_micros);
                    CREATE TABLE sandbox_execution_records(run_id,job_id,plan_json,facts_json);
                ''')
                db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?,?)', ('synthetic', 'completed', '2026-09-11', '2026-09-11', acceptance.OWNER, acceptance.AGENT, acceptance.THREADS[0]))
                db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?,?)', ('PRIVATE_UNRELATED_RUN', 'running', '2026-09-11', '2026-09-11', acceptance.OWNER, acceptance.AGENT, 'PRIVATE_OTHER_THREAD'))
                db.execute('INSERT INTO model_budget_accounts VALUES (?,?,?,?)', (acceptance.OWNER, acceptance.AGENT, 12000, 300000))
                db.execute('INSERT INTO sandbox_execution_records VALUES (?,?,?,?)', ('synthetic', 'job', json.dumps({'operation': 'read', 'input': 'PRIVATE_INPUT'}), json.dumps({'result': {'kind': 'result', 'output': {'text': 'PRIVATE_OUTPUT'}}, 'resource': {'supervision': 'released', 'cleanup': 'confirmed'}})))
            before = database.read_bytes()
            with patch.object(acceptance, 'ROOT', root):
                result = acceptance.snapshot()
            self.assertEqual(database.read_bytes(), before)
            self.assertEqual(result['activeRuns'], 1)
            self.assertEqual(result['budget']['combinedUpperBoundMicros'], 375653)
            self.assertEqual(len(result['runs']), 1)
            self.assertEqual(result['runs'][0]['jobs'][0]['cleanup'], 'confirmed')
            self.assertNotIn('PRIVATE_', json.dumps(result))


if __name__ == "__main__":
    unittest.main()
