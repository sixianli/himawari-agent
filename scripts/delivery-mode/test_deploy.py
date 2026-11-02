import importlib.util
import json
import os
import re
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
BINDING = {'host': {'address': '192.0.2.10', 'hostname': 'prod-host'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'oldConfigSha256': CONFIG_SHA256, 'oldUnitSha256': UNIT_SHA256, 'newQualificationEvidenceRoot': '/var/lib/himawari/qualification/fourteenth-20261027'}, 'paths': {'stateRoot': '/var/lib/himawari/state', 'config': '/etc/himawari/config.json'}, 'authority': {'authorityEpoch': 1, 'fencingToken': 31}, 'candidate': {'archiveSha256': ARTIFACT_SHA256, 'testedCommit': COMMIT}}
SCENARIOS = ['accept-homepage', 'accept-search-approval', 'accept-search-toggle', 'accept-news-search', 'accept-long-answer', 'accept-run-command', 'accept-unrelated-no-memory', 'accept-model-switch', 'accept-conversation-search', 'accept-reminders-page', 'accept-files-page', 'accept-slow-memory-search', 'accept-file-writing-progress', 'accept-progress-without-state', 'accept-memory-page', 'accept-phone-layout', 'accept-phone-send', 'accept-after-restart']


TIMED = {'accept-run-command': 5721, 'accept-unrelated-no-memory': 1223}


def walkthrough(sha=ARTIFACT_SHA256, statuses=None, answer_ms=None):
    statuses = statuses or {}
    timings = {**TIMED, **(answer_ms or {})}
    return {'schema': 'himawari-browser-acceptance.v1', 'artifactSha256': sha, 'results': [{'scenario': name, 'status': statuses.get(name, 'passed'), **({'answerMs': timings[name]} if timings.get(name) is not None else {})} for name in SCENARIOS]}
GOOD_FACTS = 'hostname=prod-host\nactive=active\noptFree=999999999\nstateFree=999999999\nuid=0\nconfigSha256=' + CONFIG_SHA256 + '\nunitSha256=' + UNIT_SHA256 + '\nauthority=1 31\nrootFree=99999999999\ndocumentTools=ok\nsandboxLinks=ok\nscratchScenes=0\ntargetPath.' + BINDING['service']['newQualificationEvidenceRoot'] + '=absent\n'


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

    def test_one_failure_scene_is_allowed_two_are_refused_before_anything_changes(self):
        self.assertEqual(self.failed(self.facts(scratchScenes='1')), [])
        self.assertEqual(self.failed(self.facts(scratchScenes='2')), ['TMP_SCRATCH_WITHIN_LIMIT'])
        self.assertEqual(self.failed(self.facts(scratchScenes=' 23')), ['TMP_SCRATCH_WITHIN_LIMIT'])

    def test_remote_script_counts_acceptance_scratch_directories_in_tmp(self):
        script = preflight.remote_script(BINDING)
        self.assertIn('scratchScenes=', script)
        with tempfile.TemporaryDirectory() as root:
            for name in ('hh3uq', 'hQLLK', 'hlong12', 'systemd-private-x'):
                (Path(root) / name).mkdir()
            (Path(root) / 'hfile').write_text('x')
            command = preflight.SCRATCH_SCENE_COUNT.replace('/tmp', root)
            counted = subprocess.run(['bash', '-c', command], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(counted, '2')


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
        self.assertEqual(preflight.target_paths(binding), sorted([self.PATHS[0], self.PATHS[1], '/opt/himawari/operations/fourteenth-20261027', '/var/lib/himawari/fourteenth-20261027-evidence', '/var/lib/himawari/qualification/fourteenth-20261027']))

    def test_remote_script_reads_unit_state_and_paths(self):
        script = preflight.remote_script(BINDING, [self.UNIT], self.PATHS)
        self.assertIn('/usr/bin/systemctl show -p LoadState --value ' + self.UNIT, script)
        self.assertIn("[ -e /var/tmp/himawari-fourteenth-20261027 ]", script)
        self.assertIn('df --output=avail -B1 /', script)


sandbox_links = load('sandbox_command_links', 'sandbox-command-links.py')


class SandboxCommandLinksPreflightTest(unittest.TestCase):
    def failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000) if not passed]

    def test_host_with_commands_the_sandbox_cannot_follow_is_refused(self):
        self.assertEqual(self.failed(sandboxLinks='broken:awk,which'), ['SANDBOX_COMMAND_LINKS_REACHABLE'])
        self.assertEqual(self.failed(sandboxLinks='check-failed'), ['SANDBOX_COMMAND_LINKS_REACHABLE'])
        self.assertEqual(self.failed(sandboxLinks=''), ['SANDBOX_COMMAND_LINKS_REACHABLE'])

    def test_roots_come_from_the_packet_seal_script(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            (packet / 'signing').mkdir()
            (packet / 'signing' / 'cloud-seal.mjs').write_text('x = { readOnlyToolchainPaths: [ runtime, "/usr/bin", "/etc/alternatives", ["/etc/magic"] ], protectedPaths: [ "/etc/himawari" ] }')
            self.assertEqual(preflight.sandbox_read_roots(packet), ['/usr/bin', '/etc/alternatives', '/etc/magic'])

    def test_real_seal_template_roots_let_every_command_link_resolve_on_this_host(self):
        roots = preflight.sandbox_read_roots(HERE / 'packet-template')
        self.assertIn('/etc/alternatives', roots)
        self.assertEqual(sandbox_links.unreachable_commands(roots), [])

    def test_link_to_a_directory_outside_the_roots_is_reported_and_inside_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'bin').mkdir()
            (base / 'alt').mkdir()
            (base / 'closed').mkdir()
            (base / 'real').write_text('x')
            (base / 'alt' / 'awk').symlink_to(base / 'real')
            (base / 'closed' / 'vi').symlink_to(base / 'real')
            (base / 'bin' / 'awk').symlink_to(base / 'alt' / 'awk')
            (base / 'bin' / 'vi').symlink_to(base / 'closed' / 'vi')
            (base / 'bin' / 'plain').write_text('x')
            roots = [str(base / 'bin'), str(base / 'alt'), str(base / 'real')]
            self.assertEqual(sandbox_links.unreachable_commands(roots, str(base / 'bin')), ['vi'])
            self.assertEqual(sandbox_links.unreachable_commands(roots + [str(base / 'closed')], str(base / 'bin')), [])

    def test_remote_script_runs_the_scan_with_the_roots_and_fails_closed(self):
        script = preflight.remote_script(BINDING, roots=['/usr/bin', '/etc/alternatives'])
        self.assertIn('unreachable_commands', script)
        self.assertIn('/usr/bin /etc/alternatives', script)
        self.assertIn('|| echo sandboxLinks=check-failed', script)


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
        for needle in ('import docx, openpyxl, pypdf, pdfminer, weasyprint, markdown', '/usr/bin/pandoc --version', '/usr/bin/fc-list :lang=zh family', 'Noto Sans CJK', 'LXGW WenKai', '/usr/lib/himawari-document-python/bin/python', 'harfbuzz_subset'):
            self.assertIn(needle, script)

    def test_remote_document_check_passes_only_when_everything_is_present(self):
        script = preflight.DOCUMENT_TOOLS_CHECK
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory)
            for name in ('python3', 'python', 'pandoc', 'fc-list'):
                (fake / name).write_text('#!/bin/sh\nexit 0\n')
                (fake / name).chmod(0o755)
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"; echo "LXGW WenKai"\n')
            (fake / 'grep').symlink_to(shutil.which('grep'))
            local = script.replace('/usr/bin/', str(fake) + '/').replace('/usr/lib/himawari-document-python/bin/', str(fake) + '/')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=ok')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "DejaVu Sans"\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')
            (fake / 'fc-list').write_text('#!/bin/sh\necho "Noto Sans CJK SC"; echo "LXGW WenKai"\n')
            (fake / 'python3').write_text('#!/bin/sh\nexit 1\n')
            self.assertEqual(subprocess.run(['/bin/sh', '-c', local], capture_output=True, text=True).stdout.strip(), 'documentTools=missing')
            (fake / 'python3').write_text('#!/bin/sh\nexit 0\n')
            (fake / 'python').write_text('#!/bin/sh\nexit 1\n')
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
        for name in ('deploy.sh', 'deploy-preflight.py', 'browser-acceptance-gate.py', 'generated-packet-gate.py', 'run-packet-checks.py', 'script-checkout-gate.py', 'sandbox-command-links.py'):
            shutil.copy(HERE / name, self.scripts / name)
        self.calls = root / 'calls'
        (self.scripts / 'release-cleanup.py').write_text('import sys\nopen(' + repr(str(root / 'calls')) + ', "a").write("cleanup-" + sys.argv[2] + "\\n")\nopen(' + repr(str(root / 'keeps')) + ', "a").write(" ".join(sys.argv[3:]) + "\\n")\n')
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
        (self.packet / 'signing').mkdir()
        shutil.copy(HERE / 'packet-template' / 'signing' / 'cloud-seal.mjs', self.packet / 'signing' / 'cloud-seal.mjs')
        parameters, record = generated_records()
        (self.packet / 'packet-parameters.json').write_text(json.dumps(parameters))
        (self.packet / 'packet-checks.json').write_text(json.dumps(record))
        self.walkthrough = self.packet / 'browser-acceptance' / 'walkthrough.json'
        self.walkthrough.parent.mkdir()
        self.walkthrough.write_text(json.dumps(walkthrough()))
        (self.packet / 'steps' / 'run-user-step.sh').write_text('echo "$1" >> ' + str(self.calls) + '\n[[ "$1" != "${FAKE_FAIL_AT:-none}" ]]\n')
        self.commit = self.commit_checkout(root)
        bin_directory = root / 'bin'
        bin_directory.mkdir()
        (bin_directory / 'ssh').write_text('#!/bin/bash\nprintf "%b" "$FAKE_FACTS"\n')
        os.chmod(bin_directory / 'ssh', 0o755)
        self.environment = {**os.environ, 'PATH': str(bin_directory) + ':' + os.environ['PATH'], 'FAKE_FACTS': GOOD_FACTS}

    def tearDown(self):
        self.directory.cleanup()

    def commit_checkout(self, root):
        git = ['git', '-C', str(root), '-c', 'user.name=t', '-c', 'user.email=t@t']
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        subprocess.run([*git, 'add', 'scripts'], check=True)
        subprocess.run([*git, 'commit', '-q', '-m', 'scripts'], check=True)
        commit = subprocess.run([*git, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
        binding = json.loads((self.packet / 'inputs' / 'bindings.json').read_text())
        binding['candidate']['testedCommit'] = commit
        (self.packet / 'inputs' / 'bindings.json').write_text(json.dumps(binding))
        for name, key in (('packet-parameters.json', 'COMMIT'), ('packet-checks.json', 'commit')):
            record = json.loads((self.packet / name).read_text())
            record[key] = commit
            (self.packet / name).write_text(json.dumps(record))
        return commit

    def deploy(self, **environment):
        code, result, calls = self.deploy_with_cleanup(**environment)
        return code, result, [call for call in calls if not call.startswith('cleanup-')]

    def deploy_with_cleanup(self, **environment):
        child = subprocess.run(['bash', str(self.scripts / 'deploy.sh'), str(self.packet)], capture_output=True, text=True, env={**self.environment, **environment}, check=False)
        line = next(line for line in child.stdout.splitlines() if line.startswith('DEPLOY_RESULT '))
        calls = self.calls.read_text().split() if self.calls.exists() else []
        return child.returncode, json.loads(line.split(' ', 1)[1]), calls


class DeployLockTest(DeployHarness):
    def lock(self):
        return self.packet.parent / ('.' + self.packet.name + '.deploy.lock')

    def holder(self):
        process = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (process.kill(), process.wait()))
        self.lock().mkdir()
        (self.lock() / 'pid').write_text(str(process.pid) + '\n')
        (self.lock() / 'started').write_text('2026-11-01T07:00:00Z\n')
        return process

    def test_a_second_deploy_of_the_same_packet_stops_and_names_the_holder(self):
        process = self.holder()
        code, result, calls = self.deploy_with_cleanup()
        self.assertEqual((code, result['result'], result['stoppedAt']), (8, 'already-running', 'LOCK'))
        self.assertEqual(calls, [])
        log = Path(result['log']).read_text()
        self.assertIn('DEPLOY_ALREADY_RUNNING pid=' + str(process.pid), log)
        self.assertIn('2026-11-01T07:00:00Z', log)
        self.assertIsNone(process.poll())
        self.assertTrue(self.lock().exists())

    def test_a_lock_left_by_a_dead_process_is_taken_over(self):
        dead = subprocess.Popen(['true'])
        dead.wait()
        self.lock().mkdir()
        (self.lock() / 'pid').write_text(str(dead.pid) + '\n')
        code, result, _ = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))

    def test_the_lock_is_released_after_a_pass_and_after_a_failure(self):
        self.deploy()
        self.assertFalse(self.lock().exists())
        self.deploy(FAKE_FAIL_AT='S1_INSTALL')
        self.assertFalse(self.lock().exists())

    def test_the_lock_adds_no_file_to_the_frozen_packet_while_a_step_runs(self):
        snapshot = self.packet.parent / 'files-during-step'
        listing = 'find "$(dirname "$0")/.." -type f -not -path "*/run-logs/*" | sort'
        (self.packet / 'steps' / 'run-user-step.sh').write_text(listing + ' > ' + str(snapshot) + '\n')
        before = sorted(str(path) for path in self.packet.rglob('*') if path.is_file() and 'run-logs' not in path.parts)
        code, result, _ = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))
        during = [str(Path(line).resolve()) for line in snapshot.read_text().splitlines()]
        self.assertEqual(during, [str(Path(path).resolve()) for path in before])

    def test_a_lock_without_a_readable_pid_is_not_treated_as_free(self):
        self.lock().mkdir()
        code, result, _ = self.deploy()
        self.assertEqual((code, result['result']), (8, 'already-running'))


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

    def test_walkthrough_that_answered_too_slowly_or_without_timing_is_refused(self):
        for slow in ({'accept-unrelated-no-memory': 4001}, {'accept-run-command': 12001}, {'accept-unrelated-no-memory': None}):
            self.walkthrough.write_text(json.dumps(walkthrough(answer_ms=slow)))
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


class ProductionCleanupFlowTest(DeployHarness):
    def test_successful_deploy_cleans_the_server_before_the_preflight_and_after_the_switch(self):
        code, result, calls = self.deploy_with_cleanup()
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertEqual((calls[0], calls[1], calls[-1]), ('cleanup-apply', 'S1_TRANSPORT', 'cleanup-apply'))

    def test_cleanup_keeps_no_failure_scene_after_a_pass_and_one_otherwise(self):
        self.deploy_with_cleanup()
        self.assertEqual((self.calls.parent / 'keeps').read_text().split('\n')[:-1], ['1', '0'])
        (self.calls.parent / 'keeps').unlink()
        self.calls.unlink()
        self.deploy_with_cleanup(FAKE_FAIL_AT='S1_INSTALL')
        self.assertEqual((self.calls.parent / 'keeps').read_text().split('\n')[:-1], ['1', '1'])
        (self.calls.parent / 'keeps').unlink()
        self.calls.unlink()
        self.deploy_with_cleanup(FAKE_FAIL_AT='S7_SWITCH_START')
        self.assertEqual((self.calls.parent / 'keeps').read_text().split('\n')[:-1], ['1', '1'])

    def test_failure_before_the_service_stop_cleans_the_failed_attempt(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_FAIL_AT='S1_INSTALL')
        self.assertEqual(result['result'], 'stopped-before-service-stop')
        self.assertEqual(calls[-1], 'cleanup-apply')

    def test_recovered_deploy_cleans_after_the_old_release_runs_again(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_FAIL_AT='S7_SWITCH_START')
        self.assertEqual(result['result'], 'recovered')
        self.assertEqual(calls[-2:], ['rollback', 'cleanup-apply'])

    def test_failed_recovery_keeps_everything_on_the_server(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_FAIL_AT='S2_STOP', FAKE_ROLLBACK_EXIT='1')
        self.assertEqual(result['result'], 'recovery-failed')
        self.assertEqual(calls[-1], 'rollback')
        self.assertEqual(calls.count('cleanup-apply'), 1)

    def test_refused_packet_touches_nothing_on_the_server(self):
        self.walkthrough.unlink()
        code, result, calls = self.deploy_with_cleanup()
        self.assertEqual(result['result'], 'no-browser-acceptance')
        self.assertEqual(calls, [])


class RootSpacePreflightTest(unittest.TestCase):
    GIB = 1024 ** 3

    def failed(self, size, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update({'optFree': str(100 * self.GIB), 'stateFree': str(100 * self.GIB), **changes})
        return [name for name, passed in preflight.checks(BINDING, facts, size) if not passed]

    def test_measured_install_of_the_last_release_decides_the_room_needed(self):
        size = 1 * self.GIB
        self.assertEqual(self.failed(size, rootFree=str(17 * self.GIB), lastInstallUsed=str(4 * self.GIB)), [])
        self.assertEqual(self.failed(size, rootFree=str(16 * self.GIB), lastInstallUsed=str(4 * self.GIB)), ['ROOT_FREE_FOR_ACCEPTANCE'])

    def test_without_a_measurement_three_packet_sizes_are_assumed(self):
        size = 1 * self.GIB
        self.assertEqual(self.failed(size, rootFree=str(14 * self.GIB)), [])
        self.assertEqual(self.failed(size, rootFree=str(int(13.9 * self.GIB))), ['ROOT_FREE_FOR_ACCEPTANCE'])

    def test_space_line_reports_what_is_left_after_the_install(self):
        facts = {'rootFree': str(20 * self.GIB), 'lastInstallUsed': str(5 * self.GIB)}
        room = preflight.space(facts, self.GIB)
        self.assertEqual(room['predictedInstall'], self.GIB + 6 * self.GIB)
        self.assertEqual(room['predictedFreeAfterInstall'], 13 * self.GIB)
        self.assertTrue(room['measuredFromLastInstall'])

    def test_remote_script_reads_the_last_install_from_the_serving_release_evidence(self):
        script = preflight.remote_script({**BINDING, 'paths': {**BINDING['paths'], 'evidenceRoot': '/var/lib/himawari/twentieth-20261030-evidence'}})
        self.assertIn('lastInstallUsed=', script)
        self.assertIn('s1-result.json', script)
        self.assertIn('/var/lib/himawari ', script)

    def test_last_install_reader_returns_the_bytes_used_by_s1(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root / 'unit.service'
            unit.write_text('ExecStart=/opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/nineteenth-20261029/pair-supervisor.mjs --prefix /opt/himawari/releases/2026-10-29-nineteenth --config x\n')
            (root / 'nineteenth-20261029-evidence').mkdir()
            (root / 'nineteenth-20261029-evidence' / 's1-result.json').write_text(json.dumps({'passed': True, 'rootFreeBeforeBytes': 9000, 'rootFreeAfterBytes': 4000}))
            output = subprocess.run(['python3', '-I', '-c', preflight.LAST_INSTALL_USED, str(unit), str(root)], capture_output=True, text=True, check=True).stdout
            self.assertEqual(output.strip(), '5000')


class ScriptCheckoutGateTest(DeployHarness):
    def newer_commit_elsewhere(self):
        root = Path(self.directory.name)
        git = ['git', '-C', str(root), '-c', 'user.name=t', '-c', 'user.email=t@t']
        subprocess.run([*git, 'checkout', '-q', '-b', 'newer'], check=True)
        subprocess.run([*git, 'commit', '-q', '--allow-empty', '-m', 'newer'], check=True)
        newer = subprocess.run([*git, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run([*git, 'checkout', '-q', '-'], check=True)
        return newer

    def point_packet_at(self, commit):
        binding = json.loads((self.packet / 'inputs' / 'bindings.json').read_text())
        binding['candidate']['testedCommit'] = commit
        (self.packet / 'inputs' / 'bindings.json').write_text(json.dumps(binding))
        for name, key in (('packet-parameters.json', 'COMMIT'), ('packet-checks.json', 'commit')):
            record = json.loads((self.packet / name).read_text())
            record[key] = commit
            (self.packet / name).write_text(json.dumps(record))

    def test_scripts_older_than_the_packet_change_nothing_on_the_server(self):
        self.point_packet_at(self.newer_commit_elsewhere())
        code, result, calls = self.deploy_with_cleanup()
        self.assertEqual((code, result['result'], result['stoppedAt']), (7, 'old-scripts', 'SCRIPTS'))
        self.assertEqual(calls, [])

    def test_scripts_that_contain_the_packet_commit_go_on(self):
        code, result, calls = self.deploy_with_cleanup()
        self.assertEqual((code, result['result']), (0, 'passed'))


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


class SourceCachePreflightTest(unittest.TestCase):
    BASE = 'a' * 40
    PREFIX = '/opt/himawari/releases/2026-11-01-twentyfourth'

    def binding(self):
        return {**BINDING, 'paths': {**BINDING['paths'], 'newPrefix': self.PREFIX}}

    def facts(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return facts

    def failed(self, facts, base):
        return [name for name, passed in preflight.checks(BINDING, facts, 1000, base=base) if not passed]

    def test_cache_path_is_beside_the_releases_directory(self):
        self.assertEqual(preflight.source_cache(self.binding()), '/opt/himawari/source-cache.git')

    def test_a_packet_with_a_full_bundle_asks_nothing_of_the_cache(self):
        self.assertEqual(self.failed(self.facts(), ''), [])

    def test_an_incremental_bundle_whose_base_the_cache_lacks_is_refused_before_the_upload(self):
        self.assertEqual(self.failed(self.facts(sourceCacheBase='absent'), self.BASE), ['SOURCE_CACHE_HAS_BASE'])
        self.assertEqual(self.failed(self.facts(), self.BASE), ['SOURCE_CACHE_HAS_BASE'])
        self.assertEqual(self.failed(self.facts(sourceCacheBase='present'), self.BASE), [])

    def test_the_remote_check_reads_the_real_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null'}
            work = root / 'work'
            subprocess.run(['git', 'init', '-q', str(work)], check=True, env=environment)
            (work / 'f.txt').write_text('x\n')
            subprocess.run(['git', '-C', str(work), 'add', '-A'], check=True, env=environment)
            subprocess.run(['git', '-C', str(work), 'commit', '-q', '-m', 'm'], check=True, env=environment)
            commit = subprocess.run(['git', '-C', str(work), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
            prefix = root / 'opt' / 'releases' / '2026-11-01-twentyfourth'
            prefix.mkdir(parents=True)
            cache = root / 'opt' / 'source-cache.git'
            subprocess.run(['git', 'clone', '-q', '--bare', str(work), str(cache)], check=True)
            binding = {**BINDING, 'paths': {**BINDING['paths'], 'newPrefix': str(prefix)}}
            line = re.search(r'if /usr/bin/git -C .*? fi', preflight.remote_script(binding, base=commit)).group(0)
            present = subprocess.run(['bash', '-c', line], capture_output=True, text=True, check=True).stdout.strip()
            absent = subprocess.run(['bash', '-c', line.replace(commit, 'e' * 40)], capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual((present, absent), ('sourceCacheBase=present', 'sourceCacheBase=absent'))
            self.assertNotIn('sourceCacheBase', preflight.remote_script(binding))

    def test_the_base_comes_from_the_packet_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            self.assertEqual(preflight.source_base(packet), '')
            (packet / 'packet-parameters.json').write_text(json.dumps({'SOURCE_BASE_COMMIT': self.BASE}))
            self.assertEqual(preflight.source_base(packet), self.BASE)
            (packet / 'packet-parameters.json').write_text(json.dumps({'COMMIT': COMMIT}))
            self.assertEqual(preflight.source_base(packet), '')


if __name__ == '__main__':
    unittest.main()
