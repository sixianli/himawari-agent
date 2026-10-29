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
CONFIG_SHA256 = 'c' * 64
UNIT_SHA256 = 'd' * 64
COMMIT = 'b' * 40
BINDING = {'host': {'address': '192.0.2.10', 'hostname': 'prod-host'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'oldConfigSha256': CONFIG_SHA256, 'oldUnitSha256': UNIT_SHA256}, 'paths': {'stateRoot': '/var/lib/himawari/state', 'config': '/etc/himawari/config.json'}, 'authority': {'authorityEpoch': 1, 'fencingToken': 31}, 'candidate': {'archiveSha256': ARTIFACT_SHA256, 'testedCommit': COMMIT}}
SCENARIOS = ['accept-homepage', 'accept-search-toggle', 'accept-news-search', 'accept-long-answer', 'accept-run-command', 'accept-unrelated-no-memory', 'accept-memory-page', 'accept-phone-layout', 'accept-after-restart']


def walkthrough(sha=ARTIFACT_SHA256, statuses=None):
    statuses = statuses or {}
    return {'schema': 'himawari-browser-acceptance.v1', 'artifactSha256': sha, 'results': [{'scenario': name, 'status': statuses.get(name, 'passed')} for name in SCENARIOS]}
GOOD_FACTS = 'hostname=prod-host\nactive=active\noptFree=999999999\nstateFree=999999999\nuid=0\nconfigSha256=' + CONFIG_SHA256 + '\nunitSha256=' + UNIT_SHA256 + '\nauthority=1 31\nrootFree=99999999999\ndocumentTools=ok\n'


def generated_records(commit=COMMIT, failed=()):
    checks = load('run_packet_checks', 'run-packet-checks.py')
    names = [name for name, command, directory in checks.plan(Path('/packet'), Path('node'), 'python', True, False)]
    parameters = {'COMMIT': COMMIT, 'CURRENT_SCHEMA': 56, 'TARGET_SCHEMA': 56}
    record = {'passed': not failed, 'commit': commit, 'currentSchema': 56, 'targetSchema': 56, 'checks': [{'name': name, 'exit': 1 if name in failed else 0} for name in names]}
    return parameters, record


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


class LeftoverPreflightTest(unittest.TestCase):
    UNIT = 'himawari-fourteenth-read-20261026.service'
    PATHS = ['/opt/himawari/releases/2026-10-27-fourteenth', '/var/tmp/himawari-fourteenth-20261027']

    def failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update({'probeUnit.' + self.UNIT: 'not-found', **{'targetPath.' + path: 'absent' for path in self.PATHS}})
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000, [self.UNIT], self.PATHS) if not passed]

    def test_clean_server_passes(self):
        self.assertEqual(self.failed(), [])

    def test_failed_probe_unit_from_an_earlier_attempt_is_refused_before_the_stop(self):
        self.assertEqual(self.failed(**{'probeUnit.' + self.UNIT: 'loaded'}), ['PROBE_UNIT_UNUSED ' + self.UNIT])
        self.assertEqual(self.failed(**{'probeUnit.' + self.UNIT: ''}), ['PROBE_UNIT_UNUSED ' + self.UNIT])

    def test_leftover_target_path_is_refused(self):
        self.assertEqual(self.failed(**{'targetPath.' + self.PATHS[1]: 'present'}), ['TARGET_PATH_ABSENT ' + self.PATHS[1]])

    def test_root_without_room_for_acceptance_is_refused(self):
        self.assertEqual(self.failed(rootFree=str(10 * 1024 ** 3)), ['ROOT_FREE_FOR_ACCEPTANCE'])

    def test_probe_units_come_from_the_packet_measurement_scripts(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            (packet / 'measurement').mkdir()
            (packet / 'measurement' / 'S6-service-read.py').write_text("import os\nunit = '" + self.UNIT + "'\n")
            (packet / 'measurement' / 'other.py').write_text("unit = 'himawari-prod.service'\n")
            self.assertEqual(preflight.probe_units(packet, BINDING), [self.UNIT])

    def test_target_paths_come_from_the_bindings(self):
        binding = {**BINDING, 'paths': {**BINDING['paths'], 'newPrefix': self.PATHS[0], 'newOperations': '/opt/himawari/operations/fourteenth-20261027', 'evidenceRoot': '/var/lib/himawari/fourteenth-20261027-evidence', 'transportRoot': self.PATHS[1] + '/input'}}
        self.assertEqual(preflight.target_paths(binding), sorted([self.PATHS[0], self.PATHS[1], '/opt/himawari/operations/fourteenth-20261027', '/var/lib/himawari/fourteenth-20261027-evidence']))

    def test_remote_script_reads_unit_state_and_paths(self):
        script = preflight.remote_script(BINDING, [self.UNIT], self.PATHS)
        self.assertIn('/usr/bin/systemctl show -p LoadState --value ' + self.UNIT, script)
        self.assertIn("[ -e /var/tmp/himawari-fourteenth-20261027 ]", script)
        self.assertIn('df --output=avail -B1 /', script)


class DocumentToolsPreflightTest(unittest.TestCase):
    def failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000) if not passed]

    def test_server_without_document_libraries_or_fonts_is_refused(self):
        self.assertEqual(self.failed(documentTools='missing'), ['DOCUMENT_TOOLS_INSTALLED'])
        self.assertEqual(self.failed(documentTools=''), ['DOCUMENT_TOOLS_INSTALLED'])

    def test_remote_script_checks_libraries_pandoc_and_cjk_fonts(self):
        script = preflight.remote_script(BINDING)
        for needle in ('import docx, openpyxl, pypdf, pdfminer, weasyprint, markdown', '/usr/bin/pandoc --version', '/usr/bin/fc-list :lang=zh family', 'Noto Sans CJK', 'LXGW WenKai'):
            self.assertIn(needle, script)

    def test_remote_document_check_passes_only_when_everything_is_present(self):
        script = preflight.DOCUMENT_TOOLS_CHECK
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory)
            for name in ('python3', 'pandoc', 'fc-list'):
                (fake / name).write_text('#!/bin/sh\nexit 0\n')
                (fake / name).chmod(0o755)
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"; echo "LXGW WenKai"\n')
            (fake / 'grep').symlink_to(shutil.which('grep'))
            local = script.replace('/usr/bin/', str(fake) + '/')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=ok')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "DejaVu Sans"\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"; echo "LXGW WenKai"\n')
            (fake / 'python3').write_text('#!/bin/sh\nexit 1\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')


class FrozenStatePreflightTest(unittest.TestCase):
    TAG = '[PG-3]'

    def failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000) if not passed]

    def test_restart_after_freeze_is_refused_before_anything_changes(self):
        self.assertEqual(self.failed(configSha256='e' * 64), ['CONFIG_UNCHANGED_SINCE_FREEZE'])
        self.assertEqual(self.failed(authority='1 32'), ['AUTHORITY_UNCHANGED_SINCE_FREEZE'])
        self.assertEqual(self.failed(unitSha256='f' * 64), ['UNIT_UNCHANGED_SINCE_FREEZE'])
        self.assertEqual(self.failed(authority=''), ['AUTHORITY_UNCHANGED_SINCE_FREEZE'])

    def test_remote_script_reads_config_unit_and_authority_mirror(self):
        script = preflight.remote_script(BINDING)
        self.assertIn('/usr/bin/sha256sum /etc/himawari/config.json', script)
        self.assertIn('/usr/bin/sha256sum /etc/systemd/system/himawari-prod.service', script)
        self.assertIn('/var/lib/himawari/state/authority.json', script)


class DeployHarness(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.scripts = root / 'scripts'
        self.scripts.mkdir()
        for name in ('deploy.sh', 'deploy-preflight.py', 'browser-acceptance-gate.py', 'generated-packet-gate.py', 'run-packet-checks.py'):
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
        parameters, record = generated_records()
        (self.packet / 'packet-parameters.json').write_text(json.dumps(parameters))
        (self.packet / 'packet-checks.json').write_text(json.dumps(record))
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


class DeployFlowTest(DeployHarness):
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


class GeneratedPacketGateTest(DeployHarness):
    TAG = '[PG-1]'

    def test_a_copied_packet_without_generator_records_changes_nothing(self):
        (self.packet / 'packet-parameters.json').unlink()
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result'], calls), (6, 'not-generated', []))

    def test_a_packet_whose_checks_did_not_all_pass_changes_nothing(self):
        for record in (generated_records(failed=('maintenance/verify-fixtures.mjs',))[1], generated_records(commit='e' * 40)[1]):
            (self.packet / 'packet-checks.json').write_text(json.dumps(record))
            code, result, calls = self.deploy()
            self.assertEqual((code, result['result'], calls), (6, 'not-generated', []))

    def test_a_migrating_packet_needs_the_migration_check(self):
        parameters, record = generated_records()
        parameters['TARGET_SCHEMA'] = record['targetSchema'] = 57
        (self.packet / 'packet-parameters.json').write_text(json.dumps(parameters))
        (self.packet / 'packet-checks.json').write_text(json.dumps(record))
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result'], calls), (6, 'not-generated', []))


class DeployOrderTest(DeployHarness):
    TAG = '[PG-4]'

    def test_acceptance_runs_while_the_old_release_still_serves(self):
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertLess(calls.index('S6_ACCEPTANCE'), calls.index('S2_STOP'))
        self.assertEqual(calls[:4], ['S1_TRANSPORT', 'S1_INSTALL', 'S6_ACCEPTANCE', 'S2_STOP'])

    def test_failed_acceptance_leaves_the_old_release_running(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S6_ACCEPTANCE')
        self.assertEqual((result['result'], result['stoppedAt']), ('stopped-before-service-stop', 'S6_ACCEPTANCE'))
        self.assertNotIn('S2_STOP', calls)
        self.assertNotIn('rollback', calls)
        self.assertNotEqual(code, 0)

    def test_old_order_stays_available_as_a_fallback(self):
        code, result, calls = self.deploy(HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP='1')
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertEqual(calls[2:5], ['S2_STOP', 'S3_COPY51', 'S6_ACCEPTANCE'])

    def test_restart_after_freeze_stops_deploy_with_a_refreeze_hint(self):
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('authority=1 31', 'authority=1 32'))
        self.assertEqual((code, result['result']), (4, 'preflight-failed'))
        self.assertEqual(calls, [])
        self.assertIn('PREFLIGHT_REFREEZE', Path(result['log']).read_text())
        self.assertIn('make-packet.py freeze', Path(result['log']).read_text())


if __name__ == '__main__':
    unittest.main()
