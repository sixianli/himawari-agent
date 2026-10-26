import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ARTIFACT_SHA256 = 'a' * 64
BINDING = {'host': {'address': '192.0.2.10', 'hostname': 'prod-host'}, 'service': {'unit': 'himawari-prod.service'}, 'paths': {'stateRoot': '/var/lib/himawari/state'}, 'candidate': {'archiveSha256': ARTIFACT_SHA256}}
SCENARIOS = ['accept-homepage', 'accept-search-toggle', 'accept-news-search', 'accept-long-answer', 'accept-memory-page', 'accept-after-restart']


def walkthrough(sha=ARTIFACT_SHA256, statuses=None):
    statuses = statuses or {}
    return {'schema': 'himawari-browser-acceptance.v1', 'artifactSha256': sha, 'results': [{'scenario': name, 'status': statuses.get(name, 'passed')} for name in SCENARIOS]}
GOOD_FACTS = 'hostname=prod-host\nactive=active\noptFree=999999999\nstateFree=999999999\nuid=0\n'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preflight = load('deploy_preflight', 'deploy-preflight.py')


class PreflightChecksTest(unittest.TestCase):
    def facts(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return facts

    def failed(self, facts, size=1000):
        return [name for name, passed in preflight.checks(BINDING, facts, size) if not passed]

    def test_healthy_server_passes(self):
        self.assertEqual(self.failed(self.facts()), [])

    def test_wrong_host_inactive_service_and_low_disk_are_refused(self):
        self.assertEqual(self.failed(self.facts(hostname='hermes-home')), ['HOSTNAME'])
        self.assertEqual(self.failed(self.facts(active='failed')), ['SERVICE_ACTIVE'])
        self.assertEqual(self.failed(self.facts(optFree='1500')), ['OPT_FREE'])
        self.assertEqual(self.failed(self.facts(uid='1001')), ['ROOT_LOGIN'])


class DeployFlowTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.scripts = root / 'scripts'
        self.scripts.mkdir()
        for name in ('deploy.sh', 'deploy-preflight.py', 'browser-acceptance-gate.py'):
            shutil.copy(HERE / name, self.scripts / name)
        self.calls = root / 'calls'
        (self.scripts / 'rollback.sh').write_text('echo rollback >> ' + str(self.calls) + '\nexit "${FAKE_ROLLBACK_EXIT:-0}"\n')
        (root / 'disk-hygiene').mkdir()
        shutil.copy(HERE.parent / 'disk-hygiene' / 'prune-rebuildable.py', root / 'disk-hygiene' / 'prune-rebuildable.py')
        self.old_packet = root / '.ci-output' / 'production' / '2026-10-01-old-change-packet-01'
        self.old_material = self.old_packet / 'materials' / 'node-modules.tar.gz'
        self.old_material.parent.mkdir(parents=True)
        self.old_material.write_bytes(b'x')
        os.utime(self.old_material, (1, 1))
        self.previous_material = root / '.ci-output' / 'production' / '2026-10-20-previous-change-packet-01' / 'materials' / 'node-modules.tar.gz'
        self.previous_material.parent.mkdir(parents=True)
        self.previous_material.write_bytes(b'x')
        os.utime(self.previous_material, (1, 1))
        self.packet = root / '.ci-output' / 'production' / '2026-10-26-current-change-packet-01'
        (self.packet / 'inputs').mkdir(parents=True)
        (self.packet / 'steps').mkdir()
        (self.packet / 'inputs' / 'bindings.json').write_text(json.dumps(BINDING))
        self.walkthrough = self.packet / 'browser-acceptance' / 'walkthrough.json'
        self.walkthrough.parent.mkdir()
        self.walkthrough.write_text(json.dumps(walkthrough()))
        (self.packet / 'steps' / 'run-user-step.sh').write_text('echo "$1" >> ' + str(self.calls) + '\n[[ "$1" != "${FAKE_FAIL_AT:-none}" ]]\n')
        bin_directory = root / 'bin'
        bin_directory.mkdir()
        (bin_directory / 'ssh').write_text('#!/bin/bash\nprintf "%b" "$FAKE_FACTS"\n')
        os.chmod(bin_directory / 'ssh', 0o755)
        self.environment = {**os.environ, 'PATH': str(bin_directory) + ':' + os.environ['PATH'], 'FAKE_FACTS': GOOD_FACTS}

    def tearDown(self):
        self.directory.cleanup()

    def deploy(self, **environment):
        child = subprocess.run(['bash', str(self.scripts / 'deploy.sh'), str(self.packet)], capture_output=True, text=True, env={**self.environment, **environment}, check=False)
        line = next(line for line in child.stdout.splitlines() if line.startswith('DEPLOY_RESULT '))
        calls = self.calls.read_text().split() if self.calls.exists() else []
        return child.returncode, json.loads(line.split(' ', 1)[1]), calls

    def test_full_run_passes_and_keeps_a_log(self):
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertEqual(calls[0], 'S1_TRANSPORT')
        self.assertEqual(calls[-1], 'S8_READBACK')
        self.assertIn('DEPLOY_PASSED', Path(result['log']).read_text())

    def test_successful_deploy_prunes_rebuildable_files_of_old_packets(self):
        (self.packet / 'materials').mkdir()
        current = self.packet / 'materials' / 'node-modules.tar.gz'
        current.write_bytes(b'x')
        os.utime(current, (1, 1))
        code, result, _ = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertFalse(self.old_material.exists())
        self.assertTrue(self.previous_material.exists())
        self.assertTrue(current.exists())
        self.assertIn('PRUNE_RESULT', Path(result['log']).read_text())

    def test_failed_deploy_does_not_prune(self):
        self.deploy(FAKE_FAIL_AT='S1_INSTALL')
        self.assertTrue(self.old_material.exists())

    def test_failed_preflight_changes_nothing(self):
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('active=active', 'active=failed'))
        self.assertEqual((code, result['result']), (4, 'preflight-failed'))
        self.assertEqual(calls, [])

    def test_deploy_without_a_browser_walkthrough_changes_nothing(self):
        self.walkthrough.unlink()
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result'], result['stoppedAt']), (5, 'no-browser-acceptance', 'ACCEPTANCE'))
        self.assertEqual(calls, [])

    def test_walkthrough_of_another_artifact_is_refused(self):
        self.walkthrough.write_text(json.dumps(walkthrough(sha='b' * 64)))
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result']), (5, 'no-browser-acceptance'))
        self.assertEqual(calls, [])

    def test_walkthrough_with_a_failed_or_missing_check_is_refused(self):
        for broken in ({'accept-search-toggle': 'failed'}, {'accept-memory-page': None}):
            self.walkthrough.write_text(json.dumps(walkthrough(statuses=broken)))
            code, result, calls = self.deploy()
            self.assertEqual((code, result['result']), (5, 'no-browser-acceptance'))
            self.assertEqual(calls, [])

    def test_failure_before_the_service_stop_does_not_roll_back(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S1_INSTALL')
        self.assertEqual((result['result'], result['stoppedAt']), ('stopped-before-service-stop', 'S1_INSTALL'))
        self.assertNotIn('rollback', calls)
        self.assertNotEqual(code, 0)

    def test_failure_after_the_service_stop_restores_the_old_release(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S7_SWITCH_START')
        self.assertEqual((result['result'], result['stoppedAt']), ('recovered', 'S7_SWITCH_START'))
        self.assertEqual(calls[-1], 'rollback')
        self.assertNotEqual(code, 0)

    def test_failed_recovery_is_reported(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S2_STOP', FAKE_ROLLBACK_EXIT='1')
        self.assertEqual(result['result'], 'recovery-failed')
        self.assertNotEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
