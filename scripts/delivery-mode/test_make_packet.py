import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / 'fixtures'
TWELFTH = json.loads((FIXTURES / 'twelfth-parameters.json').read_text())
TWELFTH_FROZEN = json.loads((FIXTURES / 'twelfth-frozen-sha256.json').read_text())
TWELFTH_COMMIT = TWELFTH['COMMIT']
MEMORY_PAGE_COMMIT = '4ca2d24c4af3dba5868a1d18ea882b371462845b'
ADDED_FILES = {'maintenance/verify-migrate-fixtures.mjs', 'systemd/verify-startup-readiness-fixtures.mjs'}
RENAMED_FILES = {'systemd/fixtures/verify-doctor-fixtures.mjs': 'systemd/fixtures/verify-doctor.test.mjs'}
INTENDED_CHANGES = {
    'acceptance/OWNED-SHA256SUMS', 'acceptance/S6-limited-host-acceptance.sh', 'acceptance/cloud/cloud-inputs.draft.json',
    'acceptance/cloud/run-cloud-acceptance.sh', 'acceptance/cloud/run-question12-downloads.sh', 'inputs/bindings.draft.json',
    'inputs/finalize-bindings.py', 'inputs/verify-finalize-bindings.py', 'maintenance/OWNED-SHA256SUMS', 'maintenance/S9-control-files.py', 'maintenance/maintenance-common.mjs',
    'maintenance/production-shape-config-template.json',
    'maintenance/raw-copy-recovery.mjs', 'maintenance/run-maintenance.mjs', 'maintenance/verify-fixtures.mjs', 's0-db/read-s0-db.mjs',
    'signing/cloud-seal.mjs', 'steps/README.md', 'steps/run-step.py', 'systemd/OWNED-SHA256SUMS', 'systemd/P9-switch-start-readback.md',
    'systemd/S2-stop-and-inspect.py', 'systemd/S7-startup-readback.mjs', 'systemd/S7-switch-start-readback.py', 'systemd/verify-switch-config-fixtures.py',
}
INSTANCE = json.loads((HERE / 'instances' / 'andy-production.json').read_text())


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packet_maker = load('make_packet', 'make-packet.py')
checks_runner = load('run_packet_checks', 'run-packet-checks.py')


def production_facts(running='eleventh', date='2026-10-26', public_fetch=102400, context_window=1000000, max_tokens=32768, **changes):
    compact = date.replace('-', '')
    prefix = '/opt/himawari/releases/' + date + '-' + running
    facts = {
        'hostname': 'vmi3618928',
        'active': 'active',
        'execStart': ['ExecStart=/opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/' + running + '-' + compact + '/pair-supervisor.mjs --prefix ' + prefix + ' --config /etc/himawari/config.json --worker-token-file /var/lib/himawari/state/secrets/worker-token.json'],
        'staticRoot': prefix + '/share/control-center',
        'modelCount': 1,
        'model': {'contextWindow': context_window, 'maxTokens': max_tokens},
        'publicFetchMaximumBytes': public_fetch,
        'budgetsPresent': False,
        'configSha256': 'c' * 64,
        'unitSha256': 'd' * 64,
        'newPathsExist': [],
    }
    facts.update(changes)
    return facts


def static_root_configuration(packet):
    source = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
    function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'static_root_configuration')
    namespace = {'copy': copy}
    exec(compile(ast.Module(body=[function], type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
    return namespace['static_root_configuration']


def production_config(old_prefix, public_fetch, context_window=1000000, max_tokens=32768):
    return {
        'http': {'host': '127.0.0.1', 'port': 8400, 'staticRoot': old_prefix + '/share/control-center'},
        'runPolicy': {'publicFetch': {'maximumBytes': public_fetch}},
        'modelDescriptors': [{'ref': 'deepseek-primary', 'role': 'primary', 'contextWindow': context_window, 'maxTokens': max_tokens}],
    }


class RenderedPacket(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def render(self, **changes):
        packet = self.root / ('packet-' + str(len(list(self.root.iterdir()))))
        packet_maker.render(packet, {**TWELFTH, **changes})
        return packet


class TemplateTest(RenderedPacket):
    TAG = '[PG-1]'

    def test_twelfth_parameters_rebuild_the_frozen_twelfth_packet_except_intended_changes(self):
        packet = self.render()
        packet_maker.regenerate_hashes(packet)
        rendered = {RENAMED_FILES.get(name, name): digest for name, digest in ((path.relative_to(packet).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()) for path in packet.rglob('*') if path.is_file())}
        self.assertEqual(set(rendered), set(TWELFTH_FROZEN) | ADDED_FILES)
        self.assertEqual({name for name in rendered if name not in ADDED_FILES and rendered[name] != TWELFTH_FROZEN[name]}, INTENDED_CHANGES)

    def test_every_placeholder_is_filled(self):
        packet = self.render()
        for path in packet.rglob('*'):
            self.assertNotIn('__PKT_', path.relative_to(packet).as_posix())
            if path.is_file():
                self.assertNotIn('__PKT_', path.read_text(), path)
        self.assertTrue((packet / 'install' / 'twelfth-artifact-install.mjs').is_file())

    def test_startup_readback_expects_the_public_mode_the_loaded_configuration_sets(self):
        source = (self.render() / 'systemd' / 'S7-startup-readback.mjs').read_text()
        self.assertNotRegex(source, r'publicMode,\s*false')
        self.assertIn('assert.equal(agentReady[0].publicMode, configuration.publicMode, "TWELFTH_STARTUP_PUBLIC_MODE_CHANGED");', source)

    def run_readiness(self, packet, *arguments):
        return subprocess.run(['node', str(packet / 'systemd' / 'verify-startup-readiness-fixtures.mjs'), *arguments], capture_output=True, text=True, check=False)

    def startup_journal(self, ready_ms):
        directory = self.root / ('journal-' + str(ready_ms))
        directory.mkdir()
        start = 1793200000000000
        rows = [
            {'__REALTIME_TIMESTAMP': str(start), 'MESSAGE': json.dumps({'event': 'pair.child_spawned', 'name': 'worker'})},
            {'__REALTIME_TIMESTAMP': str(start + 40000), 'MESSAGE': json.dumps({'event': 'pair.child_spawned', 'name': 'agent'})},
            {'__REALTIME_TIMESTAMP': str(start + ready_ms * 1000), 'MESSAGE': json.dumps({'component': 'agent-service', 'event': 'service.ready'})},
            {'__REALTIME_TIMESTAMP': str(start + ready_ms * 1000 + 50000), 'MESSAGE': json.dumps({'component': 'execution-worker', 'event': 'service.ready'})},
        ]
        path = directory / 'journal.jsonl'
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        return str(path)

    def test_startup_readback_refuses_a_start_slower_than_the_budget(self):
        packet = self.render()
        fixtures = self.run_readiness(packet)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)
        self.assertIn('STARTUP_READINESS_FIXTURES_PASSED 6 budgetMs=15000', fixtures.stdout)
        quick = self.run_readiness(packet, self.startup_journal(9000))
        self.assertEqual(quick.returncode, 0, quick.stderr)
        self.assertEqual(json.loads(quick.stdout), {'startupReadyMs': 9050, 'startupReadyBudgetMs': 15000})
        for ready_ms in (29350, 35000, 55000):
            slow = self.run_readiness(packet, self.startup_journal(ready_ms))
            self.assertNotEqual(slow.returncode, 0)
            self.assertIn('TWELFTH_STARTUP_READY_TOO_SLOW:' + str(ready_ms + 50), slow.stderr)

    def test_startup_budget_leaves_the_worker_wait_a_margin(self):
        worker = lambda wait: 'const DEFAULT_STARTUP_WAIT_TIMEOUT_MS = ' + wait + ';\n'
        self.assertEqual(packet_maker.startup_ready_budget(INSTANCE, worker('45_000')), 30000)
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STARTUP_BUDGET_LEAVES_NO_MARGIN budgetMs=30000 marginMs=15000 workerWaitMs=30000'):
            packet_maker.startup_ready_budget(INSTANCE, worker('30_000'))
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_WORKER_STARTUP_WAIT_NOT_READABLE'):
            packet_maker.startup_ready_budget(INSTANCE, 'const STARTUP_WAIT = 45_000;\n')
        for key, invalid in (('startupReadyBudgetSeconds', None), ('startupReadyBudgetSeconds', 0), ('startupReadyMarginSeconds', -1), ('startupReadyMarginSeconds', 1.5), ('startupReadyBudgetSeconds', '30')):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STARTUP_BUDGET_INVALID'):
                packet_maker.startup_ready_budget({**INSTANCE, key: invalid}, worker('45_000'))

    def test_a_missing_parameter_is_refused(self):
        parameters = dict(TWELFTH)
        del parameters['COMMIT']
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_PARAMETER_MISSING COMMIT'):
            packet_maker.render(self.root / 'packet', parameters)

    def test_label_follows_the_running_release(self):
        self.assertEqual(packet_maker.next_label('eleventh'), 'twelfth')
        self.assertEqual(packet_maker.next_label('twelfth'), 'thirteenth')
        self.assertEqual(packet_maker.next_label('nineteenth'), 'twentieth')
        self.assertEqual(packet_maker.next_label('twentieth'), 'twentyfirst')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_LABEL_NOT_DERIVABLE'):
            packet_maker.next_label('hotfix')

    def test_discovery_derives_the_running_release_and_the_next_label(self):
        derived = packet_maker.interpret_discovery(production_facts(), INSTANCE)
        self.assertEqual(derived['LABEL'], 'twelfth')
        for key in ('OLD_PREFIX', 'OLD_OPERATIONS', 'OLD_QUALIFICATION', 'ORIGINAL_CONTEXT_WINDOW', 'ORIGINAL_MAX_TOKENS', 'ORIGINAL_PUBLIC_FETCH_BYTES'):
            self.assertEqual(derived[key], TWELFTH[key], key)

    def test_discovery_refuses_a_production_state_the_template_does_not_fit(self):
        cases = [
            ({'hostname': 'hermes-home'}, 'PACKET_HOST_UNEXPECTED'),
            ({'active': 'failed'}, 'PACKET_SERVICE_NOT_ACTIVE'),
            ({'staticRoot': '/opt/himawari/releases/2026-10-20-tenth/share/control-center'}, 'PACKET_STATIC_ROOT_NOT_RUNNING_RELEASE'),
            ({'budgetsPresent': True}, 'PACKET_CONFIG_BUDGETS_PRESENT'),
            ({'model': None, 'modelCount': 0}, 'PACKET_CONFIG_MODEL_LIMITS_NOT_READABLE'),
            ({'newPathsExist': ['/opt/himawari/releases/2026-10-26-twelfth']}, 'PACKET_TARGET_PATHS_EXIST'),
            ({'execStart': ['ExecStart=/usr/bin/node /srv/other.mjs']}, 'PACKET_RUNNING_UNIT_NOT_RECOGNIZED'),
        ]
        for changes, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(packet_maker.PacketError, code):
                packet_maker.interpret_discovery(production_facts(**changes), INSTANCE)

    def test_regenerated_hashes_satisfy_the_packet_consistency_check(self):
        packet = self.render()
        (packet / 'systemd' / 'S2-stop-and-inspect.py').write_text((packet / 'systemd' / 'S2-stop-and-inspect.py').read_text() + '\n')
        packet_maker.regenerate_hashes(packet)
        problems = self.consistency_problems(packet)
        self.assertEqual([problem for problem in problems if not problem.startswith('CANDIDATE_ARCHIVE_MISSING')], [])

    def test_carried_copies_follow_the_commit(self):
        head = packet_maker.resolve_commit('HEAD')
        audit = 'scripts/operations/workspace-lifecycle-audit.mjs'
        packet = self.render(COMMIT=head)
        copy_path = packet / 'acceptance/cloud/probe-source' / audit
        expected = packet_maker.git('show', head + ':' + audit, binary=True)
        refreshed = packet_maker.refresh_carried_copies(packet, head)
        self.assertEqual(copy_path.read_bytes(), expected)
        if refreshed:
            self.assertIn(audit, refreshed)
        self.assertEqual(packet_maker.adapter_drift(packet, head), [])
        packet_maker.regenerate_hashes(packet)
        self.assertEqual([problem for problem in self.consistency_problems(packet) if not problem.startswith('CANDIDATE_ARCHIVE_MISSING')], [])
        carry = json.loads((packet / packet_maker.CARRY_MANIFEST).read_text())
        entry = next(item for item in carry['files'] if item['source'] == audit)
        self.assertEqual((entry['sha256'], entry['bytes']), (hashlib.sha256(expected).hexdigest(), len(expected)))
        self.assertIn(entry['sha256'], (packet / packet_maker.ADAPTATION_MANIFEST).read_text())

    def test_old_config_digest_is_set_and_reset_in_both_holders(self):
        packet = self.render()
        packet_maker.set_old_config(packet, 'e' * 64)
        for holder in packet_maker.OLD_CONFIG_HOLDERS:
            self.assertIn("OLD_CONFIG_SHA = '" + 'e' * 64 + "'\n", (packet / holder).read_text())
        packet_maker.set_old_config(packet, None)
        for holder in packet_maker.OLD_CONFIG_HOLDERS:
            self.assertEqual((packet / holder).read_text().count(packet_maker.OLD_CONFIG_PENDING + '\n'), 1)

    def test_candidate_values_fill_every_pending_draft_field(self):
        packet = self.render()
        materials = self.root / 'materials'
        materials.mkdir()
        (materials / ('linux-x64-abi127-' + TWELFTH_COMMIT + '-1-1.tar.gz')).write_bytes(b'archive')
        (materials / 'context.json').write_text(json.dumps({'testedSha': TWELFTH_COMMIT}))
        (materials / TWELFTH['BUNDLE_NAME']).write_bytes(b'bundle')
        (materials / 'source-build-inputs.json').write_text(json.dumps({'passed': True, 'sourceHead': TWELFTH_COMMIT, 'sourceTreeDigestBefore': 'a' * 64, 'sourceTreeDigestAfter': 'a' * 64, 'sourceWritesPerformed': False, 'permissionChangesPerformed': False, 'records': [{'mode': 0o644}, {'mode': 0o755}]}))
        packet_maker.fill_draft(packet, packet_maker.candidate_values(packet, TWELFTH_COMMIT, materials))
        draft = json.loads((packet / 'inputs' / 'bindings.draft.json').read_text())
        self.assertNotIn('PENDING:', json.dumps(draft))
        self.assertEqual(draft['candidate']['testedCommit'], TWELFTH_COMMIT)
        self.assertEqual(draft['installationInputs']['sourceModeCounts'], {'0644': 1, '0755': 1})

    def consistency_problems(self, packet):
        child = subprocess.run([sys.executable, '-I', str(packet / 'inputs' / 'check-packet-consistency.py'), str(packet)], capture_output=True, text=True, check=False)
        return json.loads(child.stdout)['problems']


class SandboxReadPathsTest(RenderedPacket):
    def test_model_sandbox_can_read_fonts_and_font_configuration(self):
        seal = (self.render() / 'signing' / 'cloud-seal.mjs').read_text()
        listed = seal.split('readOnlyToolchainPaths: [', 1)[1].split('].map(', 1)[0]
        for path in ('"/usr/share"', '"/etc/fonts"', '"/var/cache/fontconfig"'):
            self.assertIn(path, listed)


class DerivedExpectationsTest(RenderedPacket):
    TAG = '[PG-2]'

    def test_schema_comes_from_production_and_the_commit(self):
        self.assertEqual(packet_maker.target_schema(TWELFTH_COMMIT), 56)
        derived = packet_maker.schema_parameters({'COMMIT': TWELFTH_COMMIT, 'TARGET_SCHEMA': 56}, {'schema': {'current': 56, 'minimumWriter': 56}})
        self.assertEqual(derived, {'CURRENT_SCHEMA': 56, 'PREVIOUS_SCHEMA': 55, 'MIGRATION_LEDGER': '[]'})
        packet = self.render(**derived)
        draft = (packet / 'inputs' / 'bindings.draft.json').read_text()
        self.assertIn('"recovery56Id": "twelfth-20261026-raw-schema56"', draft)
        self.assertIn('"targetSchema": 56', draft)
        self.assertIn('s3-copy-after56.json', (packet / 'maintenance' / 'run-maintenance.mjs').read_text())

    def test_a_newer_commit_plans_the_migration_from_the_engine(self):
        self.assertEqual(packet_maker.target_schema(MEMORY_PAGE_COMMIT), 57)
        derived = packet_maker.schema_parameters({'COMMIT': MEMORY_PAGE_COMMIT, 'TARGET_SCHEMA': 57}, {'schema': {'current': 56, 'minimumWriter': 56}})
        self.assertEqual(json.loads(derived['MIGRATION_LEDGER']), [{'sequence': 57, 'name': 'memory_page', 'phase': 'expand'}])
        two = packet_maker.schema_parameters({'COMMIT': MEMORY_PAGE_COMMIT, 'TARGET_SCHEMA': 57}, {'schema': {'current': 54, 'minimumWriter': 54}})
        self.assertEqual([row['sequence'] for row in json.loads(two['MIGRATION_LEDGER'])], [55, 56, 57])
        packet = self.render(COMMIT=MEMORY_PAGE_COMMIT, TARGET_SCHEMA=57, **derived)
        common = (packet / 'maintenance' / 'maintenance-common.mjs').read_text()
        self.assertIn('export const currentSchema = 56;', common)
        self.assertIn('export const targetSchema = 57;', common)
        self.assertIn('[{"sequence":57,"name":"memory_page","phase":"expand"}].map', common)
        maintenance = (packet / 'maintenance' / 'run-maintenance.mjs').read_text()
        for expected in ('s3-copy-after56.json', 's7-config-apply-after57.json', 's7-catalog-after57.json', '"s7-migrate" + targetSchema'):
            self.assertIn(expected, maintenance)
        self.assertIn('[50, 51, 55, 56, 56, 57].includes(currentSchema)', (packet / 'maintenance' / 'raw-copy-recovery.mjs').read_text())
        readback = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
        self.assertIn("for value, schema in [(state, 56), (upgraded_state, 57)]:", readback)
        self.assertIn("post_upgrade_state['migrationCount'] != 57", readback)
        self.assertIn('"targetSchema": 57', (packet / 'inputs' / 'bindings.draft.json').read_text())

    def test_a_migration_that_rewrites_preserved_history_is_refused_before_any_build(self):
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES 0030_run_model_selection.sql runs'):
            packet_maker.schema_parameters({'COMMIT': MEMORY_PAGE_COMMIT, 'TARGET_SCHEMA': 30}, {'schema': {'current': 29, 'minimumWriter': 29}})

    def test_a_schema_the_template_cannot_reach_is_refused_before_any_build(self):
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_COMMIT_OLDER_THAN_PRODUCTION_SCHEMA'):
            packet_maker.schema_parameters({'COMMIT': TWELFTH_COMMIT, 'TARGET_SCHEMA': 56}, {'schema': {'current': 57, 'minimumWriter': 57}})
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_S0_SCHEMA_INVALID'):
            packet_maker.schema_parameters({'COMMIT': TWELFTH_COMMIT, 'TARGET_SCHEMA': 56}, {'schema': {'current': 56, 'minimumWriter': 55}})

    def test_twelfth_incident_hand_kept_original_public_fetch_is_reproduced(self):
        stale = self.render(ORIGINAL_PUBLIC_FETCH_BYTES=32768)
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED'):
            static_root_configuration(stale)(production_config(TWELFTH['OLD_PREFIX'], 102400))

    def test_config_expectations_follow_what_production_has(self):
        for public_fetch in (32768, 102400):
            with self.subTest(public_fetch=public_fetch):
                derived = packet_maker.interpret_discovery(production_facts(public_fetch=public_fetch), INSTANCE)
                packet = self.render(**{key: derived[key] for key in packet_maker.DISCOVERED_KEYS})
                switched = static_root_configuration(packet)(production_config(TWELFTH['OLD_PREFIX'], public_fetch))
                self.assertEqual(switched['runPolicy']['publicFetch']['maximumBytes'], INSTANCE['configTargets']['publicFetchMaximumBytes'])
                self.assertEqual(switched['http']['staticRoot'], '/opt/himawari/releases/2026-10-26-twelfth/share/control-center')
                fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
                self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)


class HermesCommandTest(unittest.TestCase):
    TAG = '[PG-1]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        wrapper = self.root / 'hermes-ssh.sh'
        wrapper.write_text('#!/bin/bash\nexec bash -c "$1"\n')
        wrapper.chmod(0o755)
        upload = self.root / 'hermes-upload.sh'
        upload.write_text('#!/bin/bash\ncp "$1" "$2.upload-tmp" && mv "$2.upload-tmp" "$2"\n')
        upload.chmod(0o755)
        self.environment = {'HIMAWARI_HERMES_SSH': str(wrapper), 'HIMAWARI_HERMES_UPLOAD': str(upload), 'HIMAWARI_HERMES_POLL_SECONDS': '0.05'}
        os.environ.update(self.environment)
        self.hermes = packet_maker.Hermes('thirteenth-1234abcd-20261027t010203')
        self.hermes.work = str(self.root / 'work' / self.hermes.run_id)
        self.hermes.scripts = str(self.root / 'scripts' / self.hermes.run_id)

    def tearDown(self):
        for key in self.environment:
            os.environ.pop(key, None)
        self.directory.cleanup()

    def test_detached_steps_report_success_and_failure(self):
        self.hermes.install_scripts()
        self.assertTrue((Path(self.hermes.scripts) / 'build-candidate.sh').is_file())
        self.hermes.start('ok', "echo 'quoted value' > " + str(self.root / 'out.txt'))
        self.hermes.wait('ok')
        self.assertEqual((self.root / 'out.txt').read_text(), 'quoted value\n')
        self.hermes.start('broken', 'echo BUILD_LOG_LINE; exit 7')
        with self.assertRaisesRegex(packet_maker.PacketError, '(?s)PACKET_HERMES_STEP_FAILED broken exit=7.*BUILD_LOG_LINE'):
            self.hermes.wait('broken')

    def test_a_walkthrough_preflight_failure_refuses_the_packet(self):
        self.hermes.install_scripts()
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HERMES_PREFLIGHT_FAILED .*HERMES_WALKTHROUGH_FAILED HOST_UNEXPECTED'):
            self.hermes.preflight()

    def test_an_upload_area_the_wrapper_refuses_is_found_before_any_build(self):
        refusing = self.root / 'refusing-upload.sh'
        refusing.write_text('#!/bin/bash\ncase "$2" in ' + str(self.root / 'scripts') + '/*) cp "$1" "$2.upload-tmp" && mv "$2.upload-tmp" "$2" ;; *) echo "HERMES_UPLOAD_REMOTE_OUTSIDE_TEST_AREA: $2" >&2; exit 3 ;; esac\n')
        refusing.chmod(0o755)
        self.hermes.upload_wrapper = str(refusing)
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HERMES_UPLOAD_AREA_REFUSED .*HERMES_UPLOAD_REMOTE_OUTSIDE_TEST_AREA'):
            self.hermes.probe_uploads()
        self.hermes.upload_wrapper = os.environ['HIMAWARI_HERMES_UPLOAD']
        self.hermes.probe_uploads()
        self.assertEqual(list(Path(self.hermes.scripts).iterdir()), [])
        self.assertEqual(list(Path(self.hermes.work + '-inputs').iterdir()), [])

    def test_every_upload_in_prepare_order_finds_its_remote_directory(self):
        self.hermes.probe_uploads()
        self.hermes.install_scripts()
        bundle = self.root / 'source-1234abc.bundle'
        bundle.write_bytes(b'bundle')
        self.hermes.upload(bundle, self.hermes.work + '-inputs/' + bundle.name)
        packet = self.root / 'packet'
        (packet / 'materials').mkdir(parents=True)
        for name in ('linux-x64-abi127-fixture-1.tar.gz', 'context.json'):
            (packet / 'materials' / name).write_bytes(b'x')
        (packet / 'packet-parameters.json').write_text(json.dumps({'ARTIFACT_NAME': 'linux-x64-abi127-fixture-1.tar.gz'}))
        self.hermes.upload_check_materials(packet)
        self.assertTrue((Path(self.hermes.work) / 'materials' / 'context.json').is_file())
        self.assertTrue((Path(self.hermes.work + '-inputs') / bundle.name).is_file())

    def test_builder_uploads_go_where_the_hermes_upload_wrapper_allows(self):
        settings = json.loads((HERE / 'hermes' / 'builder.json').read_text())
        allowed = ('/home/andy/himawari-tests/', '/data/hermes/himawari/tool-audit-round2/')
        for key in ('workRoot', 'scriptRoot'):
            self.assertTrue(settings[key].startswith(allowed), key)
        self.assertTrue(settings['workRoot'].startswith('/data/'))

    def test_materials_are_fetched_and_digests_checked(self):
        remote = Path(self.hermes.work) / 'materials'
        remote.mkdir(parents=True)
        (remote / 'context.json').write_text('{}')
        (Path(self.hermes.work) / 'SHA256SUMS').write_text(hashlib.sha256(b'{}').hexdigest() + '  context.json\n')
        local = self.root / 'local'
        local.mkdir()
        self.hermes.fetch_materials(local)
        self.assertEqual((local / 'context.json').read_text(), '{}')
        (remote / 'context.json').write_text('{"changed": true}')
        (local / 'context.json').unlink()
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HERMES_FETCH_DIGEST'):
            self.hermes.fetch_materials(local)


class PacketChecksRunnerTest(unittest.TestCase):
    TAG = '[PG-4]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.packet = self.root / 'packet'
        (self.packet / 'materials').mkdir(parents=True)
        self.archive = self.packet / 'materials' / 'linux-x64-abi127-fixture-1.tar.gz'
        self.archive.write_bytes(b'artifact')
        (self.packet / 'materials' / 'context.json').write_text('{}')
        self.source = self.root / 'source'
        (self.source / 'scripts').mkdir(parents=True)
        self.logs = self.root / 'logs'
        self.logs.mkdir()
        self.node = self.root / 'node'
        self.node.write_text('#!/bin/bash\necho "ARGS $*"\necho "UMASK $(umask)"\n')
        self.node.chmod(0o755)

    def tearDown(self):
        self.directory.cleanup()

    def run_check(self, check):
        previous = os.umask(0o002)
        try:
            name, code, log, seconds = checks_runner.run_check(check, self.packet, self.source, dict(os.environ), self.logs)
        finally:
            os.umask(previous)
        return code, log.read_text()

    def test_checks_run_with_umask_022_whatever_the_hermes_login_sets(self):
        code, output = self.run_check(('fixture', [str(self.node)], None))
        self.assertEqual(code, 0)
        self.assertIn('UMASK 0022', output)

    def test_migration_check_installs_the_runtime_from_this_packets_build(self):
        code, output = self.run_check((checks_runner.MIGRATE_FIXTURE, [str(self.node), 'fixture.mjs'], 'migrate'))
        self.assertEqual(code, 0)
        install = next(line for line in output.splitlines() if 'install-node-runtime.mjs' in line)
        self.assertIn('--artifact ' + str(self.archive) + ' --context ' + str(self.packet / 'materials/context.json'), install)
        self.assertNotIn('--source', install)
        self.assertNotIn('dist/node-runtime', output)

    def test_migration_check_refuses_a_packet_without_exactly_one_build(self):
        self.archive.unlink()
        with self.assertRaisesRegex(SystemExit, 'PACKET_CHECKS_CANDIDATE_ARCHIVE_COUNT 0'):
            self.run_check((checks_runner.MIGRATE_FIXTURE, [str(self.node), 'fixture.mjs'], 'migrate'))

    def test_an_upgrade_without_the_locked_python_stops_before_any_check(self):
        for holder in checks_runner.OLD_CONFIG_HOLDERS:
            (self.packet / holder).parent.mkdir(parents=True, exist_ok=True)
            (self.packet / holder).write_text(checks_runner.OLD_CONFIG_PENDING)
        (self.packet / 'maintenance/maintenance-common.mjs').write_text('export const currentSchema = 56;\nexport const targetSchema = 57;\n')
        environment = {key: value for key, value in os.environ.items() if key != 'HIMAWARI_CI_PYTHON'}
        run = subprocess.run([sys.executable, '-I', str(HERE / 'run-packet-checks.py'), str(self.packet), '--node', str(self.node), '--source', str(self.source), '--logs', str(self.logs)], env=environment, capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        self.assertIn('PACKET_CHECKS_CI_PYTHON_REQUIRED', run.stdout)
        self.assertEqual([path.name for path in self.logs.iterdir()], [])


class ReleaseWalkthroughTest(unittest.TestCase):
    TAG = '[PG-4]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.scripts = root / 'scripts'
        self.scripts.mkdir()
        shutil.copy(HERE / 'hermes' / 'run-release-walkthrough.sh', self.scripts)
        self.tools = root / 'tools'
        self.executable(self.tools / 'bin' / 'node', 'env > "$HIMAWARI_PRODUCT_PATH_OUTPUT.env"\nmkdir -p "$HIMAWARI_PRODUCT_PATH_OUTPUT"\necho "{}" > "$HIMAWARI_PRODUCT_PATH_OUTPUT/browser-acceptance.json"')
        self.executable(self.tools / 'python/python/bin/python3', 'echo "Python 3.12.10"')
        self.toolbin = root / 'pi-tools'
        for name in ('fd', 'rg'):
            self.executable(self.toolbin / name, 'exit 0')
        (root / 'browsers').mkdir()
        source = root / 'source'
        source.mkdir()
        subprocess.run(['git', 'init', '-q', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], check=True)
        revision = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
        self.work = root / 'work'
        materials = self.work / 'walk-1' / 'materials'
        materials.mkdir(parents=True)
        (materials / ('linux-x64-abi127-' + revision + '-1-1.tar.gz')).write_bytes(b'x')
        (materials / 'context.json').write_text(json.dumps({'testedSha': revision}))
        hostname = subprocess.run(['hostname'], capture_output=True, text=True, check=True).stdout.strip()
        (self.scripts / 'builder.json').write_text(json.dumps({'hostname': hostname, 'tools': str(self.tools), 'source': str(source), 'workRoot': str(self.work), 'browsers': str(root / 'browsers'), 'piToolBin': str(self.toolbin)}))

    def tearDown(self):
        self.directory.cleanup()

    def executable(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/bash\n' + body + '\n')
        path.chmod(0o755)

    def walkthrough(self, argument):
        return subprocess.run(['bash', str(self.scripts / 'run-release-walkthrough.sh'), argument], capture_output=True, text=True, check=False)

    def test_the_walkthrough_gives_the_tests_the_locked_python_and_the_pi_tools(self):
        run = self.walkthrough('walk-1')
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        seen = dict(line.split('=', 1) for line in (self.work / 'walk-1' / 'walkthrough' / 'product-path.env').read_text().splitlines() if '=' in line)
        self.assertEqual(seen['HIMAWARI_CI_PYTHON'], str(self.tools / 'python/python/bin/python3'))
        self.assertEqual(seen['HIMAWARI_CI_TOOLS'], str(self.tools))
        self.assertEqual(seen['HIMAWARI_TEST_PI_TOOLBIN'], str(self.toolbin))

    def test_a_missing_pi_tool_stops_the_preflight_before_any_test(self):
        self.assertEqual(self.walkthrough('--preflight').stdout.strip(), 'HERMES_WALKTHROUGH_PREFLIGHT_OK')
        (self.toolbin / 'fd').unlink()
        for argument in ('--preflight', 'walk-1'):
            run = self.walkthrough(argument)
            self.assertEqual(run.returncode, 5)
            self.assertIn('PI_TOOL_MISSING ' + str(self.toolbin / 'fd'), run.stderr)
        self.assertFalse((self.work / 'walk-1' / 'walkthrough').exists())

    def test_a_python_that_is_not_the_locked_one_stops_the_preflight(self):
        self.executable(self.tools / 'python/python/bin/python3', 'echo "Python 3.12.3"')
        run = self.walkthrough('--preflight')
        self.assertEqual(run.returncode, 5)
        self.assertIn('LOCKED_PYTHON_MISSING', run.stderr)

    def test_the_generator_runs_the_preflight_before_any_build(self):
        settings = json.loads((HERE / 'hermes' / 'builder.json').read_text())
        self.assertTrue(settings['piToolBin'].startswith('/home/andy/himawari-tests/'))
        source = (HERE / 'make-packet.py').read_text()
        body = source[source.index('def prepare(arguments):'):]
        self.assertLess(body.index('hermes.preflight()'), body.index("step('discover'"))
        self.assertLess(body.index('hermes.preflight()'), body.index('hermes.build('))


if __name__ == '__main__':
    unittest.main()
