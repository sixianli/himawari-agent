import contextlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from unittest import mock

HERE = Path(__file__).resolve().parent
ARTIFACT_SHA256 = 'a' * 64
CONFIG_SHA256 = 'c' * 64
UNIT_SHA256 = 'd' * 64
COMMIT = 'b' * 40
BINDING = {'host': {'address': '192.0.2.10', 'hostname': 'prod-host'}, 'service': {'unit': 'himawari-prod.service', 'unitFragmentPath': '/etc/systemd/system/himawari-prod.service', 'oldConfigSha256': CONFIG_SHA256, 'oldUnitSha256': UNIT_SHA256, 'newQualificationEvidenceRoot': '/var/lib/himawari/qualification/fourteenth-20261027'}, 'paths': {'stateRoot': '/var/lib/himawari/state', 'config': '/etc/himawari/config.json'}, 'authority': {'authorityEpoch': 1, 'fencingToken': 31}, 'candidate': {'archiveSha256': ARTIFACT_SHA256, 'testedCommit': COMMIT}}
SCENARIOS = ['accept-homepage', 'accept-search-approval', 'accept-search-toggle', 'accept-news-search', 'accept-long-answer', 'accept-run-command', 'accept-unrelated-no-memory', 'accept-model-switch', 'accept-conversation-search', 'accept-reminders-page', 'accept-files-page', 'accept-slow-memory-search', 'accept-file-writing-progress', 'accept-progress-without-state', 'accept-memory-page', 'accept-memory-export', 'accept-export-requires-login', 'accept-phone-layout', 'accept-phone-send', 'accept-after-restart']


TIMED = {'accept-run-command': 5721, 'accept-unrelated-no-memory': 1223}


def walkthrough(sha=ARTIFACT_SHA256, statuses=None, answer_ms=None):
    statuses = statuses or {}
    timings = {**TIMED, **(answer_ms or {})}
    return {'schema': 'himawari-browser-acceptance.v1', 'artifactSha256': sha, 'results': [{'scenario': name, 'status': statuses.get(name, 'passed'), **({'answerMs': timings[name]} if timings.get(name) is not None else {})} for name in SCENARIOS]}
GOOD_FACTS = 'hostname=prod-host\nactive=active\noptFree=999999999\nstateFree=999999999\nuid=0\nconfigSha256=' + CONFIG_SHA256 + '\nunitSha256=' + UNIT_SHA256 + '\nauthority=1 31\nrootFree=99999999999\ndocumentTools=ok\nsandboxLinks=ok\nscratchScenes=0\nrunningKernel=6.8.0-142-generic\nnextBootKernel=6.8.0-142-generic\nsavedBootKernel=6.8.0-142-generic\nqualifiedKernel=6.8.0-142-generic\ntargetPath.' + BINDING['service']['newQualificationEvidenceRoot'] + '=absent\n'


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

    def test_real_seal_template_roots_let_ubuntu_alternative_links_resolve_and_refuse_links_out_of_them(self):
        roots = preflight.sandbox_read_roots(HERE / 'packet-template')
        self.assertIn('/etc/alternatives', roots)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            rebased = [str(base) + root for root in roots]
            for folder in ('usr/bin', 'usr/lib/jvm/bin', 'usr/share/nodejs', 'etc/alternatives', 'opt/google/chrome', 'usr/local/bin'):
                (base / folder).mkdir(parents=True)
            for real in ('usr/bin/gawk', 'usr/bin/vim.basic', 'usr/bin/python3.12', 'usr/lib/jvm/bin/java', 'opt/google/chrome/chrome', 'usr/local/bin/go'):
                (base / real).write_text('x')
            links = {
                'etc/alternatives/awk': 'usr/bin/gawk',
                'etc/alternatives/vi': 'usr/bin/vim.basic',
                'etc/alternatives/java': 'usr/lib/jvm/bin/java',
                'etc/alternatives/x-www-browser': 'opt/google/chrome/chrome',
                'usr/bin/awk': 'etc/alternatives/awk',
                'usr/bin/vi': 'etc/alternatives/vi',
                'usr/bin/java': 'etc/alternatives/java',
                'usr/bin/x-www-browser': 'etc/alternatives/x-www-browser',
                'usr/bin/go': 'usr/local/bin/go',
            }
            for link, target in links.items():
                (base / link).symlink_to(base / target)
            (base / 'usr/bin/python3').symlink_to('python3.12')
            self.assertEqual(sandbox_links.unreachable_commands(rebased, str(base / 'usr/bin')), ['go', 'x-www-browser'])

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


embedding_artifact = load('embedding_artifact_check', 'embedding-artifact-check.py')


class LocalEmbeddingArtifactPreflightTest(unittest.TestCase):
    TAG = '[P3-1]'
    MODEL = 'jina-embeddings-v5-text-small-retrieval-int8'

    def install(self, root):
        state = root / 'state'
        state.mkdir()
        staging = root / 'staging'
        staging.mkdir()
        files = {}
        for name, content in (('model.onnx', b'weights'), ('tokenizer.json', b'{}'), ('tokenizer_config.json', b'{"a":1}')):
            (staging / name).write_bytes(content)
            files[name] = embedding_artifact.digest(staging / name)
        manifest = (json.dumps({'schema': 'himawari-embedding-artifact.v1', 'model': self.MODEL, 'dimensions': 1024, 'files': files}) + '\n').encode()
        (staging / 'manifest.json').write_bytes(manifest)
        sha = embedding_artifact.digest(staging / 'manifest.json')
        target = state / 'models' / self.MODEL / sha
        target.parent.mkdir(parents=True)
        staging.rename(target)
        return state, target, sha

    def test_a_complete_copy_passes_and_each_kind_of_damage_is_named(self):
        with tempfile.TemporaryDirectory() as directory:
            state, target, sha = self.install(Path(directory))
            self.assertIsNone(embedding_artifact.problem(str(state), self.MODEL, sha, '1024'))
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, 'e' * 64, '1024'), 'missing')
            self.assertEqual(embedding_artifact.problem(str(state), '../escape', sha, '1024'), 'target-invalid')
            (target / 'tokenizer_config.json').write_bytes(b'{}')
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, sha, '1024'), 'file-digest:tokenizer_config.json')
            (target / 'tokenizer_config.json').unlink()
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, sha, '1024'), 'missing-file:tokenizer_config.json')

    def test_p3_1_a_copy_the_service_would_refuse_is_refused_before_the_release(self):
        with tempfile.TemporaryDirectory() as directory:
            state, target, sha = self.install(Path(directory))
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, sha, '768'), 'manifest-dimensions')
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, sha, 'x'), 'target-invalid')
            manifest = json.loads((target / 'manifest.json').read_text())
            (target / 'extra.bin').write_bytes(b'x')
            manifest['files']['extra.bin'] = embedding_artifact.digest(target / 'extra.bin')
            (target / 'manifest.json').write_text(json.dumps(manifest) + '\n')
            extra_sha = embedding_artifact.digest(target / 'manifest.json')
            renamed = target.parent / extra_sha
            target.rename(renamed)
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, extra_sha, '1024'), 'manifest-shape')

    def test_p3_1_a_manifest_digest_that_is_not_hex_and_an_incomplete_packet_target_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            state, target, sha = self.install(Path(directory))
            manifest = json.loads((target / 'manifest.json').read_text())
            manifest['files']['model.onnx'] = 'Z' * 64
            (target / 'manifest.json').write_text(json.dumps(manifest) + '\n')
            changed = embedding_artifact.digest(target / 'manifest.json')
            target.rename(target.parent / changed)
            self.assertEqual(embedding_artifact.problem(str(state), self.MODEL, changed, '1024'), 'manifest-shape')
            packet = Path(directory) / 'packet'
            packet.mkdir()
            (packet / 'packet-parameters.json').write_text(json.dumps({'TARGET_EMBEDDING_JSON': json.dumps({'provider': 'local-onnx', 'model': self.MODEL})}))
            with self.assertRaisesRegex(SystemExit, 'not a complete local embedding target'):
                preflight.local_embedding_target(packet)
            (packet / 'packet-parameters.json').write_text(json.dumps({'TARGET_EMBEDDING_JSON': json.dumps({'provider': 'local-onnx', 'model': self.MODEL, 'artifactSha256': sha, 'dimensions': 1024})}))
            self.assertEqual(preflight.local_embedding_target(packet)['dimensions'], 1024)

    def test_a_model_directory_reached_through_a_link_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            state, target, sha = self.install(Path(directory))
            linked = Path(directory) / 'linked'
            linked.mkdir()
            (linked / 'models').symlink_to(state / 'models')
            self.assertEqual(embedding_artifact.problem(str(linked), self.MODEL, sha, '1024'), 'symlink')

    def test_preflight_checks_the_artifact_only_when_the_release_switches_to_a_local_model(self):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        target = {'provider': 'local-onnx', 'model': self.MODEL, 'artifactSha256': 'f' * 64, 'dimensions': 1024}
        self.assertNotIn('LOCAL_EMBEDDING_ARTIFACT_INSTALLED', [name for name, passed in preflight.checks(BINDING, facts, 1000)])
        self.assertNotIn('embedding-artifact', preflight.remote_script(BINDING))
        failed = [name for name, passed in preflight.checks(BINDING, facts, 1000, embedding=target) if not passed]
        self.assertEqual(failed, ['LOCAL_EMBEDDING_ARTIFACT_INSTALLED'])
        facts['embeddingArtifact'] = 'ok'
        self.assertEqual([name for name, passed in preflight.checks(BINDING, facts, 1000, embedding=target) if not passed], [])
        script = preflight.remote_script(BINDING, embedding=target)
        self.assertIn('/var/lib/himawari/state ' + self.MODEL + ' ' + 'f' * 64 + ' 1024 || echo embeddingArtifact=check-failed', script)

    def test_the_target_comes_from_the_packet_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            self.assertIsNone(preflight.local_embedding_target(packet))
            (packet / 'packet-parameters.json').write_text(json.dumps({'TARGET_EMBEDDING_JSON': 'null'}))
            self.assertIsNone(preflight.local_embedding_target(packet))
            target = {'provider': 'local-onnx', 'model': self.MODEL, 'artifactSha256': 'f' * 64, 'dimensions': 1024}
            (packet / 'packet-parameters.json').write_text(json.dumps({'TARGET_EMBEDDING_JSON': json.dumps(target)}))
            self.assertEqual(preflight.local_embedding_target(packet), target)
            (packet / 'packet-parameters.json').write_text(json.dumps({'TARGET_EMBEDDING_JSON': json.dumps({**target, 'provider': 'vercel-ai-gateway'})}))
            self.assertIsNone(preflight.local_embedding_target(packet))


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


class KernelPreflightTest(unittest.TestCase):
    TAG = '[I-83]'

    def failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000) if not passed]

    def test_matching_kernels_pass(self):
        self.assertEqual(self.failed(), [])

    def test_production_state_of_november_7_passes(self):
        self.assertEqual(self.next_boot(saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.failed(runningKernel='6.8.0-142-generic', nextBootKernel='6.8.0-142-generic', savedBootKernel='6.8.0-142-generic', qualifiedKernel='6.8.0-142-generic'), [])

    def test_a_reboot_into_another_kernel_is_refused(self):
        self.assertEqual(self.failed(nextBootKernel='6.8.0-147-generic'), ['NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL'])
        self.assertEqual(self.failed(nextBootKernel=''), ['NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL'])
        self.assertEqual(self.failed(savedBootKernel='6.8.0-147-generic'), ['NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL'])
        self.assertEqual(self.failed(savedBootKernel=''), ['NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL'])
        self.assertEqual(self.failed(runningKernel=''), ['NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL', 'RUNNING_KERNEL_MATCHES_QUALIFICATION'])

    def first_failed(self, **changes):
        facts = dict(line.split('=', 1) for line in GOOD_FACTS.splitlines())
        facts.update(changes)
        return [name for name, passed in preflight.checks(BINDING, facts, 1000, first=True) if not passed]

    def test_a_first_tools_deployment_on_a_host_with_no_receipt_yet_qualifies_the_running_kernel(self):
        self.assertEqual(self.first_failed(qualifiedKernel='none'), [])
        self.assertEqual(self.failed(qualifiedKernel='none'), ['RUNNING_KERNEL_MATCHES_QUALIFICATION'])
        self.assertEqual(self.first_failed(qualifiedKernel=''), ['RUNNING_KERNEL_MATCHES_QUALIFICATION'])
        self.assertEqual(self.first_failed(qualifiedKernel='6.8.0-139-generic'), ['RUNNING_KERNEL_MATCHES_QUALIFICATION'])

    def test_running_kernel_different_from_the_qualified_one_is_refused(self):
        self.assertEqual(self.failed(qualifiedKernel='6.8.0-139-generic'), ['RUNNING_KERNEL_MATCHES_QUALIFICATION'])
        self.assertEqual(self.failed(qualifiedKernel=''), ['RUNNING_KERNEL_MATCHES_QUALIFICATION'])

    UUID = '9a3e62be-0000-4000-8000-000000000001'
    ADVANCED = 'gnulinux-advanced-' + UUID

    def entry_id(self, kernel, kind='advanced'):
        return 'gnulinux-' + kernel + '-' + kind + '-' + self.UUID

    PRODUCTION_HEADER = [
        'if [ -s $prefix/grubenv ]; then', '  set have_grubenv=true', '  load_env', 'fi',
        'if [ "${initrdfail}" = 2 ]; then', '   set initrdfail=', 'elif [ "${initrdfail}" = 1 ]; then',
        '   set next_entry="${prev_entry}"', '   set prev_entry=', '   save_env prev_entry', '   if [ "${next_entry}" ]; then',
        '      set initrdfail=2', '   fi', '   save_env initrdfail', 'fi',
        'if [ "${next_entry}" ] ; then', '   set default="${next_entry}"', '   set next_entry=', '   save_env next_entry', '   set boot_once=true', 'else',
        '   set default="${saved_entry}"', 'fi',
        'if [ x"${feature_menuentry_id}" = xy ]; then', '  menuentry_id_option="--id"', 'else', '  menuentry_id_option=""', 'fi',
        'export menuentry_id_option',
        'if [ "${prev_saved_entry}" ]; then', '  set saved_entry="${prev_saved_entry}"', '  save_env saved_entry', '  set prev_saved_entry=', '  save_env prev_saved_entry', '  set boot_once=true', 'fi',
        'function savedefault {', '  if [ -z "${boot_once}" ]; then', '    saved_entry="${chosen}"', '    save_env saved_entry', '  fi', '}']

    def grub_config(self, default='${saved_entry}', linux='linux', boot='/boot', header=None):
        def entry(title, ident, kernel, indent):
            return [indent + "menuentry '" + title + "' --class ubuntu --class gnu-linux --class gnu --class os $menuentry_id_option '" + ident + "' {",
                    indent + '\trecordfail', indent + '\tload_video', indent + "\tif [ x$grub_platform = xxen ]; then insmod xzio; insmod lzopio; fi",
                    indent + '\t' + linux + '\t' + boot + '/vmlinuz-' + kernel + ' root=UUID=' + self.UUID + ' ro console=tty1 console=ttyS0',
                    indent + '\tinitrd\t/boot/initrd.img-' + kernel, indent + '}']
        if header is None:
            lines = ['if [ -s $prefix/grubenv ]; then', '  set have_grubenv=true', '  load_env', 'fi',
                     'if [ "${next_entry}" ] ; then', '   set default="${next_entry}"', '   set next_entry=', '   save_env next_entry', '   set boot_once=true', 'else', '   set default="' + default + '"', 'fi',
                     'function savedefault {', '  if [ -z "${boot_once}" ]; then', '    saved_entry="${chosen}"', '    save_env saved_entry', '  fi', '}']
        else:
            lines = list(header)
        lines += entry('Ubuntu', 'gnulinux-simple-' + self.UUID, '6.8.0-147-generic', '')
        lines.append("submenu 'Advanced options for Ubuntu' $menuentry_id_option '" + self.ADVANCED + "' {")
        for kernel in ('6.8.0-147-generic', '6.8.0-142-generic'):
            lines += entry('Ubuntu, with Linux ' + kernel, self.entry_id(kernel), kernel, '\t')
            lines += entry('Ubuntu, with Linux ' + kernel + ' (recovery mode)', self.entry_id(kernel, 'recovery'), kernel, '\t')
        lines.append('}')
        lines += ["menuentry 'UEFI Firmware Settings' $menuentry_id_option 'uefi-firmware' {", '\tfwsetup', '}']
        return '\n'.join(lines) + '\n'

    def next_boot(self, config=None, kernels=('6.8.0-147-generic', '6.8.0-142-generic'), environment=True, **values):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'grub.cfg').write_text(self.grub_config() if config is None else config)
            if environment:
                block = '# GRUB Environment Block\n' + ''.join(key + '=' + value + '\n' for key, value in values.items())
                (root / 'grubenv').write_text(block + '#' * (1024 - len(block)))
            for kernel in kernels:
                (root / ('vmlinuz-' + kernel)).write_bytes(b'k')
            output = subprocess.run(['python3', '-I', '-c', preflight.READ_NEXT_BOOT_KERNEL, str(root / 'grub.cfg'), str(root / 'grubenv'), str(root)], capture_output=True, text=True, check=True).stdout
            facts = dict(line.split('=', 1) for line in output.splitlines())
            return (facts['nextBootKernel'], facts['savedBootKernel'])

    def test_saved_entry_pointing_at_the_newer_kernel_gives_that_kernel(self):
        self.assertEqual(self.next_boot(saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-147-generic')), ('6.8.0-147-generic',) * 2)

    def test_one_time_next_entry_wins_over_saved_entry(self):
        saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        self.assertEqual(self.next_boot(saved_entry=saved, next_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-147-generic')), ('6.8.0-147-generic', '6.8.0-142-generic'))
        self.assertEqual(self.next_boot(saved_entry=saved, next_entry=''), ('6.8.0-142-generic', '6.8.0-142-generic'))
        self.assertEqual(self.next_boot(saved_entry=saved, next_entry='uefi-firmware'), ('', '6.8.0-142-generic'))

    def test_a_one_time_entry_does_not_hide_the_saved_entry(self):
        once = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        self.assertEqual(self.next_boot(saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-147-generic'), next_entry=once), ('6.8.0-142-generic', '6.8.0-147-generic'))
        self.assertEqual(self.next_boot(next_entry=once), ('', ''))

    def test_entries_can_be_named_by_number_title_or_id(self):
        self.assertEqual(self.next_boot(saved_entry='0'), ('6.8.0-147-generic',) * 2)
        self.assertEqual(self.next_boot(saved_entry='1>2'), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.next_boot(saved_entry='Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0-142-generic'), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.next_boot(saved_entry='gnulinux-simple-' + self.UUID), ('6.8.0-147-generic',) * 2)

    def test_the_header_read_from_the_production_grub_cfg_on_november_8_passes(self):
        saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        config = self.grub_config(header=self.PRODUCTION_HEADER)
        self.assertEqual(self.next_boot(config=config, saved_entry=saved), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.next_boot(config=config, saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-147-generic')), ('6.8.0-147-generic',) * 2)

    def test_grub_not_booting_the_saved_entry_gives_no_answer(self):
        self.assertEqual(self.next_boot(config=self.grub_config(default='0'), saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')), ('', ''))

    def test_efi_loader_and_a_separate_boot_partition_are_understood(self):
        saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        self.assertEqual(self.next_boot(config=self.grub_config(linux='linuxefi'), saved_entry=saved), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.next_boot(config=self.grub_config(boot=''), saved_entry=saved), ('6.8.0-142-generic',) * 2)

    def test_a_later_default_overrides_the_saved_entry(self):
        saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        self.assertEqual(self.next_boot(config=self.grub_config() + 'set default="0"\n', saved_entry=saved), ('', ''))
        self.assertEqual(self.next_boot(config=self.grub_config() + '# set default="0"\n', saved_entry=saved), ('6.8.0-142-generic',) * 2)
        self.assertEqual(self.next_boot(config='if false; then\n  set default="0"\nfi\n' + self.grub_config(), saved_entry=saved), ('', ''))
        self.assertEqual(self.next_boot(config=self.grub_config() + 'set  default="0"\n', saved_entry=saved), ('', ''))
        swapped = self.grub_config().replace('set default="${next_entry}"', 'X').replace('set default="${saved_entry}"', 'set default="${next_entry}"').replace('X', 'set default="${saved_entry}"')
        self.assertEqual(self.next_boot(config=swapped, saved_entry=saved), ('', ''))
        self.assertEqual(self.next_boot(config=self.grub_config().replace('   set boot_once=true\nelse\n', '   set boot_once=true\nfi\n'), saved_entry=saved), ('', ''))
        self.assertEqual(self.next_boot(config=self.grub_config().replace('$menuentry_id_option', '--id'), saved_entry=saved), ('6.8.0-142-generic',) * 2)

    def test_entries_that_do_not_boot_an_installed_kernel_give_no_answer(self):
        saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
        self.assertEqual(self.next_boot(kernels=('6.8.0-147-generic',), saved_entry=saved), ('', ''))
        self.assertEqual(self.next_boot(saved_entry=self.ADVANCED), ('', ''))
        self.assertEqual(self.next_boot(saved_entry='uefi-firmware'), ('', ''))
        self.assertEqual(self.next_boot(saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-150-generic')), ('', ''))
        self.assertEqual(self.next_boot(saved_entry='9'), ('', ''))
        self.assertEqual(self.next_boot(saved_entry='0>0'), ('', ''))
        self.assertEqual(self.next_boot(), ('', ''))
        self.assertEqual(self.next_boot(environment=False), ('', ''))

    def test_remote_script_reads_the_three_kernel_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'grub.cfg').write_text(self.grub_config())
            (root / 'grubenv').write_text('# GRUB Environment Block\nsaved_entry=' + self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic') + '\n')
            (root / 'vmlinuz-6.8.0-142-generic').write_bytes(b'k')
            with mock.patch.object(preflight, 'GRUB_CONFIG', str(root / 'grub.cfg')), mock.patch.object(preflight, 'GRUB_ENVIRONMENT', str(root / 'grubenv')), mock.patch.object(preflight, 'BOOT_DIRECTORY', str(root)):
                script = preflight.remote_script(BINDING)
            output = subprocess.run(['/bin/bash', '-c', script], capture_output=True, text=True, check=False).stdout
        facts = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        self.assertEqual((facts['nextBootKernel'], facts['savedBootKernel']), ('6.8.0-142-generic',) * 2)
        self.assertEqual(facts['runningKernel'], os.uname().release)
        self.assertIn('qualifiedKernel', facts)
        self.assertIn('/var/lib/himawari/qualification', preflight.remote_script(BINDING))

    def test_qualified_kernel_comes_from_the_newest_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (name, release) in enumerate([('old-20260901', '6.8.0-139-generic'), ('new-20261102', '6.8.0-142-generic')]):
                (root / name).mkdir()
                receipt = root / name / 'installation-receipt.json'
                receipt.write_text(json.dumps({'osRelease': release}))
                os.utime(receipt, (1000 + index, 1000 + index))
            (root / 'broken').mkdir()
            self.assertEqual(self.qualified(root), '6.8.0-142-generic')
            (root / 'newest-broken').mkdir()
            broken = root / 'newest-broken' / 'installation-receipt.json'
            broken.write_text('not json')
            os.utime(broken, (2000, 2000))
            self.assertEqual(self.qualified(root), '')

    def test_a_receipt_kernel_that_is_not_one_plain_word_gives_no_answer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for release in ('6.8.0-142-generic\nuid=0', 'a=b', ['6.8.0-142-generic']):
                (root / 'r').mkdir(exist_ok=True)
                (root / 'r' / 'installation-receipt.json').write_text(json.dumps({'osRelease': release}))
                self.assertEqual(self.qualified(root), '')

    def qualified(self, root):
        return subprocess.run(['python3', '-I', '-c', preflight.READ_QUALIFIED_KERNEL, str(root)], capture_output=True, text=True, check=True).stdout.strip()

    def test_equal_receipt_times_are_broken_by_directory_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, release in (('b-second', '6.8.0-142-generic'), ('a-first', '6.8.0-139-generic')):
                (root / name).mkdir()
                receipt = root / name / 'installation-receipt.json'
                receipt.write_text(json.dumps({'osRelease': release}))
                os.utime(receipt, (1000, 1000))
            self.assertEqual(self.qualified(root), '6.8.0-142-generic')

    def test_a_directory_without_receipts_says_none_were_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.qualified(Path(directory)), 'none')


class HostSystemBootTest(unittest.TestCase):
    TAG = KernelPreflightTest.TAG
    UUID, ADVANCED = KernelPreflightTest.UUID, KernelPreflightTest.ADVANCED
    entry_id, grub_config, next_boot = KernelPreflightTest.entry_id, KernelPreflightTest.grub_config, KernelPreflightTest.next_boot

    def remote(self, root):
        namespace = {'__name__': 'host_system_fixture'}
        exec(compile(load('host_system', 'host-system.py').remote_program(), 'host-system-remote', 'exec'), namespace)
        namespace['settings']['bootPaths'] = [str(root / 'grub.cfg'), str(root / 'grubenv'), str(root)]
        return namespace

    def test_pinning_picks_the_running_kernel_by_its_versioned_entry_not_the_simple_or_recovery_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'grub.cfg').write_text(self.grub_config())
            path = self.remote(root)['running_entry_path']('6.8.0-142-generic')
        self.assertEqual(path, self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic'))
        self.assertEqual(self.next_boot(saved_entry=path), ('6.8.0-142-generic',) * 2)

    def test_pinning_refuses_a_kernel_grub_does_not_list(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'grub.cfg').write_text(self.grub_config())
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
                self.remote(root)['running_entry_path']('7.0.0-1013-oracle')
        self.assertIn('HOST_SYSTEM_FAILED RUNNING_KERNEL_NOT_IN_GRUB', output.getvalue())

    def test_grub_tools_are_found_in_sbin_where_ubuntu_installs_them(self):
        namespace = self.remote(Path('/nonexistent'))
        with unittest.mock.patch.object(namespace['shutil'], 'which', side_effect=lambda name, path: '/usr/sbin/' + name if path.split(':')[0] == '/usr/sbin' else None):
            self.assertEqual(namespace['system_tool']('grub-set-default'), '/usr/sbin/grub-set-default')

    def test_a_missing_grub_tool_or_binary_is_reported_as_a_host_system_failure_not_a_traceback(self):
        namespace = self.remote(Path('/nonexistent'))
        output = io.StringIO()
        with contextlib.redirect_stdout(output), unittest.mock.patch.object(namespace['shutil'], 'which', return_value=None), self.assertRaises(SystemExit):
            namespace['system_tool']('grub-set-default')
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            namespace['run'](['/nonexistent/grub-set-default'])
        self.assertIn('HOST_SYSTEM_FAILED GRUB_TOOL_MISSING grub-set-default', output.getvalue())
        self.assertIn('HOST_SYSTEM_FAILED COMMAND_NOT_RUNNABLE /nonexistent/grub-set-default', output.getvalue())

    def test_the_remote_program_reuses_the_preflight_checks_and_pins_every_document_package(self):
        settings = self.remote(Path('/nonexistent'))['settings']
        self.assertEqual(settings['documentCheck'], preflight.DOCUMENT_TOOLS_CHECK)
        self.assertEqual(settings['bootReader'], preflight.READ_NEXT_BOOT_KERNEL)
        lines = [line for line in settings['requirements'].splitlines() if line]
        self.assertEqual(len(lines), 14)
        self.assertTrue(all(re.fullmatch(r'[a-z0-9-]+==[0-9.]+( --hash=sha256:[0-9a-f]{64})+', line) for line in lines), lines)
        self.assertIn('weasyprint==70.0 ', settings['requirements'])


class LastFailureReportTest(unittest.TestCase):
    def report(self, root, packet=None):
        module = load('last_failure_report', 'last-failure-report.py')
        module.STATE = root
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            module.report_evidence(root / 'first-20261127-evidence.attempt-failed-20261127T073915Z')
        return module, output.getvalue().splitlines()

    def test_I120_the_next_deploy_prints_why_the_last_one_failed_from_the_files_left_on_the_host(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'first-20261127-evidence.attempt-failed-20261127T073915Z'
            evidence.mkdir()
            (evidence / 'step-s6_acceptance-1-result.json').write_text(json.dumps({'action': 'S6_ACCEPTANCE', 'passed': False, 'exitCode': 1}))
            (evidence / 'step-s1_install-1-result.json').write_text(json.dumps({'action': 'S1_INSTALL', 'passed': True, 'exitCode': 0}))
            (evidence / 's6-npm-observation.stderr').write_text('Traceback\nRuntimeError: FIRST_NPM_FROZEN_OBSERVATION_CHANGED:npm\n')
            (evidence / 'step-s1_install-1.stderr').write_text('')
            _, lines = self.report(root)
        self.assertIn('LAST_FAILURE_TAIL s6-npm-observation.stderr RuntimeError: FIRST_NPM_FROZEN_OBSERVATION_CHANGED:npm', lines)
        self.assertTrue(any(line.startswith('LAST_FAILURE_STEP ') and 'S6_ACCEPTANCE' in line for line in lines))
        self.assertFalse(any('S1_INSTALL' in line for line in lines))
        self.assertFalse(any('step-s1_install-1.stderr' in line for line in lines))

    def test_I120_the_report_reads_the_saved_cloud_acceptance_failure(self):
        module = load('last_failure_report', 'last-failure-report.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module.STATE = root
            older = root / 'release-cleanup/failed-acceptance/20261127T080000Z-himawari-first/run-01'
            newest = root / 'release-cleanup/failed-acceptance/20261127T092948Z-himawari-first/run-01'
            for run in (older, newest):
                run.mkdir(parents=True)
            (older / 'console.stderr').write_text('old failure\n')
            (newest / 'run-report.json').write_text(json.dumps({'passed': False, 'exitCode': 1, 'runnerErrors': [{'type': 'RuntimeError', 'message': 'ACCEPTANCE_SUBCOMMAND_FAILED'}]}))
            (newest / 'acceptance-report.json').write_text(json.dumps({'passed': False, 'commands': [{'name': 'scratch-guard', 'exitCode': 0}, {'name': 'r2l6-console', 'exitCode': 1}]}))
            (newest / 'r2l6').mkdir()
            (newest / 'r2l6/report.json').write_text(json.dumps({'passed': False, 'failure': {'reason': 'Error: R2_L6_CONTROLLER_FAILED_EXIT', 'phase': 'restart'}, 'assertions': [{'id': 'install', 'passed': True}, {'id': 'restart', 'passed': False}]}))
            (newest / 'r2l6/passed.json').write_text(json.dumps({'passed': True, 'failure': 'ignored'}))
            copied = newest / 'scratch-failure-files/source/test/qualification/evidence'
            copied.mkdir(parents=True)
            (copied / 'contracts-before.log').write_text('FAIL old committed evidence\n')
            (newest / 'r2l6-console.stderr').write_text('Error: sandbox refused\n')
            (newest / 'scratch-guard.stderr').write_text('')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                module.report_failed_acceptance()
        lines = output.getvalue().splitlines()
        self.assertIn('LAST_FAILURE_REPORT run-01/run-report.json {"runnerErrors": [{"message": "ACCEPTANCE_SUBCOMMAND_FAILED", "type": "RuntimeError"}]}', lines)
        self.assertIn('LAST_FAILURE_REPORT run-01/acceptance-report.json {"failedCommands": [{"exitCode": 1, "name": "r2l6-console"}]}', lines)
        self.assertIn('LAST_FAILURE_REPORT run-01/r2l6/report.json {"failedAssertions": ["restart"], "failure": {"phase": "restart", "reason": "Error: R2_L6_CONTROLLER_FAILED_EXIT"}}', lines)
        self.assertIn('LAST_FAILURE_TAIL r2l6-console.stderr Error: sandbox refused', lines)
        self.assertFalse(any('scratch-guard' in line or 'old failure' in line or 'ignored' in line or 'old committed evidence' in line for line in lines))

    def test_npm_differences_name_the_exact_field_that_moved(self):
        module = load('last_failure_report', 'last-failure-report.py')
        expected = {'npm': {'version': '10.9.4', 'requestedPathChain': [{'path': '/opt', 'uid': 0}]}, 'node': {'version': 'v22.22.3'}}
        actual = {'npm': {'version': '10.9.4', 'requestedPathChain': [{'path': '/opt', 'uid': 1000}]}, 'node': {'version': 'v22.22.3'}}
        self.assertEqual(module.differences(expected, actual), ['npm.requestedPathChain[0].uid expected=0 actual=1000'])
        self.assertEqual(module.differences(expected, expected), [])

    def test_tool_source_probe_flags_links_and_missing_tools_before_s6_copies_them(self):
        module = load('last_failure_report', 'last-failure-report.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bash').write_text('x')
            (root / 'rg').symlink_to(root / 'bash')
            module.TOOL_SOURCES = [str(root / 'bash'), str(root / 'rg'), str(root / 'bwrap')]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                module.probe_tool_sources()
        lines = output.getvalue().splitlines()
        self.assertEqual(lines, [
            'LAST_FAILURE_READY ok tool-source ' + str(root / 'bash') + ' regular file',
            'LAST_FAILURE_READY FAIL tool-source ' + str(root / 'rg') + ' is a link or not a regular file',
            'LAST_FAILURE_READY FAIL tool-source ' + str(root / 'bwrap') + ' missing',
        ])

    def test_download_probe_checks_every_reference_url_the_packet_will_fetch(self):
        module = load('last_failure_report', 'last-failure-report.py')
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            script = packet / 'acceptance/cloud/download-question-12.py'
            script.parent.mkdir(parents=True)
            script.write_text((HERE / 'packet-template/acceptance/cloud/download-question-12.py').read_text().replace('__PKT_FD_TRIPLE__', 'aarch64-unknown-linux-gnu'))
            asked = []

            def answer(request, timeout):
                asked.append((request.get_method(), request.full_url))
                if 'registry.npmjs.org' in request.full_url:
                    raise OSError('blocked')
                response = mock.MagicMock()
                response.status = 200
                response.__enter__.return_value = response
                return response

            output = io.StringIO()
            with mock.patch.object(module.urllib.request, 'urlopen', answer), contextlib.redirect_stdout(output):
                module.probe_downloads(packet)
        self.assertEqual([method for method, _ in asked], ['HEAD', 'HEAD'])
        lines = output.getvalue().splitlines()
        self.assertIn('LAST_FAILURE_READY ok download 200 https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-aarch64-unknown-linux-gnu.tar.gz', lines)
        self.assertIn('LAST_FAILURE_READY FAIL download OSError blocked https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', lines)


class DeployHarness(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.scripts = root / 'scripts'
        self.scripts.mkdir()
        for name in ('deploy.sh', 'deploy-preflight.py', 'deploy-target-paths.py', 'browser-acceptance-gate.py', 'generated-packet-gate.py', 'run-packet-checks.py', 'script-checkout-gate.py', 'sandbox-command-links.py', 'embedding-artifact-check.py'):
            shutil.copy(HERE / name, self.scripts / name)
        self.calls = root / 'calls'
        (self.scripts / 'release-cleanup.py').write_text('import os, sys\nfrom pathlib import Path\ncalls = Path(' + repr(str(root / 'calls')) + ')\nfirst = not calls.exists() or "cleanup-" not in calls.read_text()\nopen(calls, "a").write("cleanup-" + sys.argv[2] + "\\n")\nopen(' + repr(str(root / 'keeps')) + ', "a").write(" ".join(sys.argv[3:]) + "\\n")\nsys.exit(int(os.environ.get("FAKE_CLEANUP_BEFORE_EXIT" if first else "FAKE_CLEANUP_AFTER_EXIT", "0")))\n')
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


class KeepFailedDeployTest(DeployHarness):
    def choose(self, choice):
        parameters = json.loads((self.packet / 'packet-parameters.json').read_text())
        parameters['ON_DEPLOY_FAILURE'] = choice
        (self.packet / 'packet-parameters.json').write_text(json.dumps(parameters))

    def test_twentyninth_incident_a_failure_after_the_stop_keeps_the_failed_release_when_the_packet_says_keep(self):
        self.choose('keep')
        code, result, calls = self.deploy_with_cleanup(FAKE_FAIL_AT='S8_READBACK')
        self.assertEqual((result['result'], result['stoppedAt']), ('failed-kept', 'S8_READBACK'))
        self.assertNotEqual(code, 0)
        self.assertNotIn('rollback', calls)
        self.assertEqual((calls[0], calls[-1], calls.count('cleanup-apply')), ('cleanup-apply', 'S8_READBACK', 1))
        log = Path(result['log']).read_text()
        self.assertIn('DEPLOY_ON_FAILURE keep from packet-parameters.json', log)
        self.assertIn('DEPLOY_ROLLBACK_SKIPPED owner-choice', log)
        self.assertNotIn('DEPLOY_AUTO_RECOVERY_START', log)

    def test_the_operator_variable_overrides_the_packet_choice_both_ways(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S2_STOP', HIMAWARI_DEPLOY_ON_FAILURE='keep')
        self.assertEqual(result['result'], 'failed-kept')
        self.assertNotIn('rollback', calls)
        self.assertIn('DEPLOY_ON_FAILURE keep from HIMAWARI_DEPLOY_ON_FAILURE', Path(result['log']).read_text())
        self.choose('keep')
        code, result, calls = self.deploy(FAKE_FAIL_AT='S7_SWITCH_START', HIMAWARI_DEPLOY_ON_FAILURE='rollback')
        self.assertEqual(result['result'], 'recovered')
        self.assertEqual(calls[-1], 'rollback')

    def test_a_packet_without_a_choice_still_rolls_back(self):
        code, result, calls = self.deploy(FAKE_FAIL_AT='S7_SWITCH_START')
        self.assertEqual(result['result'], 'recovered')
        self.assertIn('DEPLOY_ON_FAILURE rollback from packet-parameters.json', Path(result['log']).read_text())

    def test_keep_does_not_change_a_failure_before_the_stop_or_a_pass(self):
        self.choose('keep')
        code, result, calls = self.deploy(FAKE_FAIL_AT='S1_INSTALL')
        self.assertEqual(result['result'], 'stopped-before-service-stop')
        code, result, calls = self.deploy()
        self.assertEqual((code, result['result']), (0, 'passed'))

    def test_an_unknown_choice_changes_nothing(self):
        for environment, choice in (({'HIMAWARI_DEPLOY_ON_FAILURE': 'ignore'}, None), ({}, 'ignore')):
            if choice:
                self.choose(choice)
            code, result, calls = self.deploy_with_cleanup(**environment)
            self.assertEqual((code, result['result'], result['stoppedAt']), (9, 'invalid-on-failure', 'OPTION'))
            self.assertEqual(calls, [])


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

    def test_target_paths_left_after_the_cleanup_stop_the_deploy_before_the_preflight(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_CLEANUP_BEFORE_EXIT='3')
        self.assertEqual((code, result['result'], result['stoppedAt'], calls), (4, 'target-paths-left', 'PREFLIGHT', ['cleanup-apply']))

    def test_other_cleanup_failures_before_the_preflight_do_not_stop_the_deploy(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_CLEANUP_BEFORE_EXIT='1')
        self.assertEqual((code, result['result']), (0, 'passed'))

    def test_target_paths_left_after_a_passed_deploy_do_not_change_its_result(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_CLEANUP_AFTER_EXIT='3')
        self.assertEqual((code, result['result']), (0, 'passed'))
        log = Path(result['log']).read_text()
        self.assertNotIn('DEPLOY_CLEANUP_FAILED', log)
        self.assertIn('DEPLOY_CLEANUP_PATHS_KEPT after', log)

    def test_a_real_cleanup_failure_after_a_passed_deploy_is_still_reported(self):
        code, result, calls = self.deploy_with_cleanup(FAKE_CLEANUP_AFTER_EXIT='1')
        self.assertEqual((code, result['result']), (0, 'passed'))
        self.assertIn('DEPLOY_CLEANUP_FAILED after', Path(result['log']).read_text())

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

    def test_a_packet_checked_before_the_installed_probe_existed_changes_nothing(self):
        gate = load('generated_packet_gate', 'generated-packet-gate.py')
        installed_probe = load('run_packet_checks_names', 'run-packet-checks.py').INSTALLED_PROBE
        path = self.packet / 'packet-checks.json'
        record = json.loads(path.read_text())
        self.assertEqual(gate.problems(self.packet), [])
        record['checks'] = [item for item in record['checks'] if item['name'] != installed_probe]
        path.write_text(json.dumps(record))
        self.assertEqual(gate.problems(self.packet), ['PACKET_CHECK_NOT_PASSED ' + installed_probe + ' null'])
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


class KernelPreflightHintTest(DeployHarness):
    TAG = '[I-83]'

    def test_next_boot_kernel_hint_gives_the_full_quoted_entry_path(self):
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('nextBootKernel=6.8.0-142-generic', 'nextBootKernel=6.8.0-147-generic'))
        self.assertEqual((code, result['result'], calls), (4, 'preflight-failed', []))
        log = Path(result['log']).read_text()
        self.assertIn('PREFLIGHT_CHECK NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL failed', log)
        self.assertIn('would start 6.8.0-147-generic on the next reboot and 6.8.0-142-generic on the reboots after it', log)
        self.assertLess(log.index('GRUB_DEFAULT=saved'), log.index('grub-set-default'))
        self.assertIn("grub-set-default 'gnulinux-advanced-<uuid>>gnulinux-6.8.0-142-generic-advanced-<uuid>'", log)
        self.assertIn("owner's approval", log)
        self.assertIn('grub-editenv /boot/grub/grubenv unset next_entry', log)
        self.assertNotIn('PREFLIGHT_QUALIFIED_KERNEL', log)

    def test_unreadable_grub_state_is_named_in_the_hint(self):
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('nextBootKernel=6.8.0-142-generic', 'nextBootKernel='))
        self.assertEqual((code, result['result']), (4, 'preflight-failed'))
        self.assertIn('could not be read or parsed', Path(result['log']).read_text())

    def test_qualified_kernel_hint_asks_for_approval_and_keeps_a_fallback(self):
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('qualifiedKernel=6.8.0-142-generic', 'qualifiedKernel=6.8.0-139-generic'))
        self.assertEqual((code, result['result']), (4, 'preflight-failed'))
        log = Path(result['log']).read_text()
        self.assertIn('PREFLIGHT_QUALIFIED_KERNEL', log)
        self.assertIn("owner's approval", log)
        self.assertIn('rollback section of docs/runbooks/production-server-access-runbook.md', log)
        self.assertNotIn('PREFLIGHT_NEXT_BOOT_KERNEL', log)
        code, result, calls = self.deploy(FAKE_FACTS=GOOD_FACTS.replace('qualifiedKernel=6.8.0-142-generic', 'qualifiedKernel=6.8.0-139-generic').replace('savedBootKernel=6.8.0-142-generic', 'savedBootKernel=6.8.0-147-generic'))
        self.assertIn('PREFLIGHT_NEXT_BOOT_KERNEL first resolve PREFLIGHT_QUALIFIED_KERNEL below', Path(result['log']).read_text())


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
            environment = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'maintenance.auto', 'GIT_CONFIG_VALUE_0': 'false'}
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
