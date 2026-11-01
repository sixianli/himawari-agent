import argparse
import ast
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / 'fixtures'
TWELFTH = json.loads((FIXTURES / 'twelfth-parameters.json').read_text())
TWELFTH_FROZEN = json.loads((FIXTURES / 'twelfth-frozen-sha256.json').read_text())
TWELFTH_COMMIT = TWELFTH['COMMIT']
MEMORY_PAGE_COMMIT = '4ca2d24c4af3dba5868a1d18ea882b371462845b'
ADDED_FILES = {'maintenance/verify-migrate-fixtures.mjs', 'measurement/verify-s6-report-contract.py', 'systemd/verify-startup-readiness-fixtures.mjs'}
RENAMED_FILES = {'systemd/fixtures/verify-doctor-fixtures.mjs': 'systemd/fixtures/verify-doctor.test.mjs'}
INTENDED_CHANGES = {
    'acceptance/OWNED-SHA256SUMS', 'acceptance/S6-limited-host-acceptance.sh', 'acceptance/cloud/cloud-inputs.draft.json',
    'acceptance/cloud/run-cloud-acceptance.sh', 'acceptance/cloud/run-question12-downloads.sh', 'inputs/bindings.draft.json',
    'inputs/finalize-bindings.py', 'inputs/verify-finalize-bindings.py', 'maintenance/OWNED-SHA256SUMS', 'maintenance/S9-control-files.py', 'maintenance/maintenance-common.mjs',
    'maintenance/production-shape-config-template.json',
    'maintenance/raw-copy-recovery.mjs', 'maintenance/run-maintenance.mjs', 'maintenance/verify-fixtures.mjs', 'measurement/OWNED-SHA256SUMS', 'measurement/S6-service-read.py', 's0-db/read-s0-db.mjs',
    'signing/cloud-seal.mjs', 'signing/prepare-twelfth-snapshot.sh', 'steps/README.md', 'steps/run-local-step.py', 'steps/run-step.py', 'steps/verify-steps.py', 'systemd/OWNED-SHA256SUMS', 'systemd/P9-switch-start-readback.md',
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


def startup_phases(packet):
    source = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
    tree = ast.parse(source)
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'startup_phases' or isinstance(node, ast.Assign) and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['startup_phase_baseline_ms']]
    namespace = {'json': json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
    return namespace['startup_phases'], namespace['startup_phase_baseline_ms']


def startup_journal(invocation, offsets):
    start = 1_793_200_000_000_000
    rows = [{'_SYSTEMD_INVOCATION_ID': invocation, '__REALTIME_TIMESTAMP': str(start + offset * 1000), 'MESSAGE': json.dumps(message)} for offset, message in offsets]
    rows.append({'_SYSTEMD_INVOCATION_ID': 'other', '__REALTIME_TIMESTAMP': str(start), 'MESSAGE': json.dumps({'event': 'pair.child_spawned'})})
    rows.append({'_SYSTEMD_INVOCATION_ID': invocation, '__REALTIME_TIMESTAMP': str(start + 1000), 'MESSAGE': 'plain text line'})
    return ''.join(json.dumps(row) + '\n' for row in rows).encode()


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


class StartupPhaseTest(RenderedPacket):
    TAG = '[PG-5]'

    def journal(self, sandbox_services_ms):
        step = lambda name: {'component': 'agent-service', 'event': 'startup.step', 'step': name}
        return startup_journal('start', [
            (0, {'component': 'pair-supervisor', 'event': 'pair.child_spawned', 'name': 'worker'}),
            (25, {'component': 'pair-supervisor', 'event': 'pair.child_spawned', 'name': 'agent'}),
            (8361, step('state-opened')),
            (9019, step('workspace-synced')),
            (9019 + sandbox_services_ms, step('sandbox-services-created')),
            (9019 + sandbox_services_ms + 8400, {'component': 'execution-worker', 'event': 'service.ready'}),
            (9019 + sandbox_services_ms + 8450, step('worker-connected')),
            (9019 + sandbox_services_ms + 9800, {'component': 'agent-service', 'event': 'service.ready'}),
        ])

    def test_the_switch_report_times_every_startup_phase_and_warns_on_one_twice_its_usual_time(self):
        phases, baseline = startup_phases(self.render())
        self.assertEqual(baseline, {'sandbox-services-created': 6000, 'state-opened': 8200})
        slow = phases(self.journal(18824), 'start', baseline)
        self.assertEqual([(phase['step'], phase['durationMs']) for phase in slow['phases']], [
            ('state-opened', 8361), ('workspace-synced', 658), ('sandbox-services-created', 18824),
            ('execution-worker-ready', 8400), ('worker-connected', 50), ('agent-service-ready', 1350),
        ])
        self.assertEqual(slow['phases'][-1]['sinceSpawnMs'], 37643)
        self.assertEqual(slow['warnings'], [{'step': 'sandbox-services-created', 'durationMs': 18824, 'sinceSpawnMs': 27843, 'baselineMs': 6000}])
        self.assertEqual(phases(self.journal(12000), 'start', baseline)['warnings'], [])
        self.assertEqual(phases(self.journal(18824), 'missing', baseline), {'invocationId': 'missing', 'phases': [], 'warnings': []})

    def test_the_install_time_prepare_and_the_service_prepare_share_one_fingerprint_cache(self):
        packet = self.render()
        snapshot = next(packet.rglob('prepare-*-snapshot.sh')).read_text()
        unit = next(packet.rglob('himawari-prod.service.draft')).read_text()
        prepare = [line for line in snapshot.splitlines() if 'cloud-protected-prepare.mjs" --prepare' in line]
        self.assertEqual(len(prepare), 1)
        self.assertIn('state=/var/lib/himawari/state', snapshot)
        self.assertIn('--reuid=999', prepare[0])
        self.assertIn('HOME="$state"', prepare[0])
        self.assertIn('User=himawari-prod', unit)
        self.assertIn('Environment=HOME=/var/lib/himawari/state', unit)
        self.assertIn('cloud-protected-prepare.mjs --prepare', unit)
        self.assertNotIn('HIMAWARI_RUNTIME_FINGERPRINT_FILE', snapshot + unit)
        self.assertIn("operations + '/runtime-fingerprints.json'", snapshot)
        self.assertIn("os.O_NOFOLLOW", snapshot)
        self.assertIn('RUNTIME_FINGERPRINT_CACHE_SOURCE_UNSAFE', snapshot)
        self.assertIn('os.chown(temporary, 0, 0)', snapshot)
        self.assertIn('/lib/himawari-agent', snapshot.split('runtime=', 1)[1].splitlines()[0])

    def publish_fingerprints(self, snapshot, state, operations, runtime):
        marker = "python3 -I - \"$state\" \"$operations\" \"$runtime\" <<'PYTHON'\n"
        script = snapshot.split(marker, 1)[1].split('\nPYTHON\n', 1)[0]
        return subprocess.run(['python3', '-I', '-', str(state), str(operations), runtime], input=script, capture_output=True, text=True)

    def test_the_root_step_publishes_the_exact_cache_the_service_will_look_for(self):
        if os.getuid() != 0:
            self.skipTest('needs root to create files owned by the service account')
        packet = self.render()
        snapshot = next(packet.rglob('prepare-*-snapshot.sh')).read_text()
        prepare = next(packet.rglob('cloud-protected-prepare.mjs')).read_text()
        runtime = snapshot.split('runtime=', 1)[1].splitlines()[0]
        prefix = re.search(r'prefix = "([^"]+)"', prepare).group(1)
        self.assertEqual(runtime, prefix + '/lib/himawari-agent')
        token = subprocess.run(['node', '-e', 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,16))', runtime], capture_output=True, text=True, check=True).stdout
        state, operations = self.root / 'state', self.root / 'operations'
        (state / 'cache').mkdir(parents=True)
        operations.mkdir()
        source = state / 'cache' / ('runtime-fingerprints-' + token + '.json')
        payload = json.dumps({'version': 1, 'root': runtime, 'files': {'a': {}}})
        source.write_text(payload)
        os.chown(source, 999, 988)
        os.chmod(source, 0o600)
        result = self.publish_fingerprints(snapshot, state, operations, runtime)
        self.assertEqual(result.returncode, 0, result.stderr)
        published = operations / 'runtime-fingerprints.json'
        self.assertEqual(published.read_text(), payload)
        self.assertEqual((published.stat().st_uid, oct(published.stat().st_mode & 0o777)), (0, '0o644'))
        self.assertEqual(list(operations.glob('*.tmp')), [])
        published.unlink()
        os.chown(source, 1234, 988)
        self.assertNotEqual(self.publish_fingerprints(snapshot, state, operations, runtime).returncode, 0)
        os.chown(source, 999, 988)
        source.write_text(json.dumps({'version': 1, 'root': runtime + '2', 'files': {}}))
        os.chown(source, 999, 988)
        self.assertNotEqual(self.publish_fingerprints(snapshot, state, operations, runtime).returncode, 0)
        source.unlink()
        (state / 'secret').write_text(payload)
        source.symlink_to(state / 'secret')
        self.assertNotEqual(self.publish_fingerprints(snapshot, state, operations, runtime).returncode, 0)
        self.assertFalse(published.exists())
        source.unlink()
        self.assertIn('NOT_WRITTEN', self.publish_fingerprints(snapshot, state, operations, runtime).stdout)

    def test_a_missing_or_malformed_phase_baseline_is_refused(self):
        self.assertEqual(json.loads(packet_maker.startup_phase_baseline(INSTANCE))['sandbox-services-created'], 6000)
        for invalid in (None, {}, {'State Opened': 1}, {'state-opened': 0}, {'state-opened': 1.5}, ['state-opened']):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STARTUP_PHASE_BASELINE_INVALID'):
                packet_maker.startup_phase_baseline({**INSTANCE, 'startupPhaseBaselineMs': invalid})

    def test_the_switch_report_carries_the_phases_on_success_and_failure(self):
        readback = (self.render() / 'systemd' / 'S7-switch-start-readback.py').read_text()
        final = readback[readback.index('finally:'):]
        self.assertIn("orchestration['startupPhases'] = startup_phases(captured.stdout, orchestration['startInvocationId'], startup_phase_baseline_ms)", final)
        self.assertIn("'startupPhases': orchestration.get('startupPhases')", final)


class ServiceReadReportContractTest(RenderedPacket):
    TAG = '[PG-5]'

    def contract(self, packet):
        return subprocess.run([sys.executable, '-I', str(packet / 'measurement/verify-s6-report-contract.py')], capture_output=True, text=True, check=False)

    def test_the_packet_checks_run_the_service_read_report_contract(self):
        self.assertIn('measurement/verify-s6-report-contract.py', checks_runner.PYTHON_FIXTURES)

    def test_every_field_the_switch_and_cleanup_read_is_written_on_every_path(self):
        run = self.contract(self.render())
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('S6_REPORT_CONTRACT passed', run.stdout)

    def test_twentieth_incident_cgroup_readback_written_only_while_the_unit_runs_is_refused(self):
        packet = self.render()
        producer = packet / 'measurement/S6-service-read.py'
        source = producer.read_text()
        written = "    record['cgroupReadback'] = "
        self.assertIn(written, source)
        producer.write_text(source.replace(written, "    if record.get('effectiveProperties', {}).get('ControlGroup'):\n        record['cgroupReadback'] = ", 1))
        run = self.contract(packet)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn("S6_REPORT_FIELD_NOT_ALWAYS_WRITTEN systemd/S7-switch-start-readback.py reads probe['cgroupReadback']", run.stdout)
        self.assertIn("install/S9-clean-transport.py reads service_read['cgroupReadback']", run.stdout)


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

    def test_model_sandbox_can_follow_command_links_and_read_system_data_files(self):
        seal = (self.render() / 'signing' / 'cloud-seal.mjs').read_text()
        listed = seal.split('readOnlyToolchainPaths: [', 1)[1].split('protectedPaths: [', 1)[0]
        for path in ('"/etc/alternatives"', '"/usr/sbin"', '"/etc/mime.types"', '"/etc/magic"', '"/etc/locale.alias"', '"/etc/ld.so.cache"'):
            self.assertIn(path, listed)
        for secret in ('/etc/passwd', '/etc/shadow', '/etc/group', '/etc/himawari', '/etc/localtime'):
            self.assertNotIn('"' + secret + '"', listed)


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

    def write_audit_copy(self, text):
        path = self.packet / checks_runner.AUDIT_COPY
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_a_packet_whose_audit_script_stops_short_of_the_target_schema_is_refused(self):
        self.write_audit_copy('export const SUPPORTED_SCHEMA_MAX = 67;\n')
        self.assertEqual(checks_runner.audit_script_problem(self.packet, 68), 'PACKET_CHECKS_AUDIT_SCRIPT_BEHIND supported=67 targetSchema=68')

    def test_a_packet_whose_audit_script_covers_the_target_schema_passes(self):
        self.write_audit_copy('export const SUPPORTED_SCHEMA_MAX = 68;\n')
        self.assertIsNone(checks_runner.audit_script_problem(self.packet, 68))
        self.assertIsNone(checks_runner.audit_script_problem(self.packet, 57))

    def test_a_packet_with_an_audit_script_without_a_declared_limit_or_without_the_script_is_refused(self):
        self.assertEqual(checks_runner.audit_script_problem(self.packet, 68), 'PACKET_CHECKS_AUDIT_SCRIPT_MISSING ' + checks_runner.AUDIT_COPY)
        self.write_audit_copy('if (version > 67) throw 1;\n')
        self.assertEqual(checks_runner.audit_script_problem(self.packet, 68), 'PACKET_CHECKS_AUDIT_SCRIPT_LIMIT_MISSING ' + checks_runner.AUDIT_COPY)

    def test_the_runner_stops_before_any_check_when_the_audit_script_is_behind(self):
        for holder in checks_runner.OLD_CONFIG_HOLDERS:
            (self.packet / holder).parent.mkdir(parents=True, exist_ok=True)
            (self.packet / holder).write_text(checks_runner.OLD_CONFIG_PENDING)
        (self.packet / 'maintenance').mkdir(exist_ok=True)
        (self.packet / 'maintenance/maintenance-common.mjs').write_text('export const currentSchema = 68;\nexport const targetSchema = 68;\n')
        self.write_audit_copy('export const SUPPORTED_SCHEMA_MAX = 67;\n')
        run = subprocess.run([sys.executable, '-I', str(HERE / 'run-packet-checks.py'), str(self.packet), '--node', str(self.node), '--source', str(self.source), '--logs', str(self.logs)], capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        self.assertIn('PACKET_CHECKS_AUDIT_SCRIPT_BEHIND supported=67 targetSchema=68', run.stdout)
        self.assertEqual([path.name for path in self.logs.iterdir()], [])

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



class HermesCleanupTest(unittest.TestCase):
    TAG = '[PG-4]'

    def test_cleanup_removes_the_rebuildable_copies_and_keeps_logs_and_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'twentieth-e9d30b22-20261030t010000'
            files = {
                'materials/node-modules.tar.gz': True, 'materials/candidate.tar.gz': True,
                '-checks/packet/inputs/bindings.json': True, '-inputs/packet.tgz': True, '-inputs/source-e9d30b2.bundle': True,
                'summary': False, 'build.log': False, 'report/local-summary.json': False, 'walkthrough/browser-acceptance.json': False,
                '-inputs/build.log': False, '-inputs/build.exit': False, '-checks/record.json': False, '-checks/logs/check.log': False,
            }
            for name in files:
                path = Path(str(work) + name) if name.startswith('-') else work / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('x')
            subprocess.run(['bash', '-c', packet_maker.hermes_cleanup_command(str(work))], check=True)
            for name, removed in files.items():
                path = Path(str(work) + name) if name.startswith('-') else work / name
                self.assertEqual(path.exists(), not removed, name)

    def test_prepare_cleans_hermes_and_the_local_work_directory_even_when_it_fails(self):
        source = (HERE / 'make-packet.py').read_text()
        body = source[source.index('def prepare(arguments):'):source.index('def build_packet(')]
        self.assertIn('try:\n        build_packet(', body)
        self.assertLess(body.index('finally:'), body.index('hermes.cleanup()'))
        self.assertLess(body.index('finally:'), body.index('shutil.rmtree(work'))

    def test_a_failed_build_still_sends_the_cleanup_to_hermes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = root / 'calls'
            wrapper = root / 'hermes-ssh.sh'
            wrapper.write_text('#!/bin/bash\necho "$1" >> ' + shlex.quote(str(calls)) + '\n')
            wrapper.chmod(0o755)
            with unittest.mock.patch.dict(os.environ, {'HIMAWARI_HERMES_SSH': str(wrapper)}):
                hermes = packet_maker.Hermes('twentieth-e9d30b22-20261030t010000')
                with unittest.mock.patch.object(packet_maker, 'build_packet', side_effect=SystemExit('PACKET_HERMES_STEP_FAILED')), \
                        unittest.mock.patch.object(packet_maker, 'Hermes', return_value=hermes), \
                        unittest.mock.patch.object(packet_maker, 'load_instance', return_value={}), \
                        unittest.mock.patch.object(packet_maker, 'resolve_commit', return_value='e' * 40), \
                        unittest.mock.patch.object(packet_maker, 'require_current_scripts'), \
                        unittest.mock.patch.object(packet_maker, 'require_claims_proven'), \
                        unittest.mock.patch.object(packet_maker, 'discover', return_value={}), \
                        unittest.mock.patch.object(packet_maker, 'interpret_discovery', return_value={'LABEL': 'twentieth'}), \
                        unittest.mock.patch.object(packet_maker, 'base_parameters', return_value={'LABEL': 'twentieth', 'COMMIT8': 'e' * 8}):
                    with self.assertRaises(SystemExit):
                        packet_maker.prepare(argparse.Namespace(instance='andy-production', commit='HEAD', date='2026-10-30', label='twentieth', since=None, output_root='out'))
            self.assertIn(packet_maker.hermes_cleanup_command(hermes.work), calls.read_text())


class ScriptCheckoutTest(unittest.TestCase):
    TAG = '[PG-4]'

    def test_a_packet_for_a_commit_the_scripts_do_not_contain_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git = ['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@t']
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run([*git, 'commit', '-q', '--allow-empty', '-m', 'old'], check=True)
            old = subprocess.run([*git, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run([*git, 'checkout', '-q', '-b', 'main-newer'], check=True)
            subprocess.run([*git, 'commit', '-q', '--allow-empty', '-m', 'new'], check=True)
            newer = subprocess.run([*git, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
            with unittest.mock.patch.object(packet_maker, 'REPO', repo):
                packet_maker.require_current_scripts(old)
                packet_maker.require_current_scripts(newer)
                subprocess.run([*git, 'checkout', '-q', old], check=True)
                with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_SCRIPTS_OLDER_THAN_COMMIT'):
                    packet_maker.require_current_scripts(newer)

    def test_prepare_checks_the_scripts_before_anything_else(self):
        source = (HERE / 'make-packet.py').read_text()
        body = source[source.index('def prepare(arguments):'):source.index('def build_packet(')]
        self.assertLess(body.index('require_current_scripts(commit)'), body.index('discover('))


class UntestedClaimGateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.directory.name)
        self.git = ['git', '-C', str(self.repo), '-c', 'user.name=t', '-c', 'user.email=t@t']
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)

    def tearDown(self):
        self.directory.cleanup()

    def commit(self, message):
        subprocess.run([*self.git, 'commit', '-q', '--allow-empty', '-m', message], check=True)
        return subprocess.run([*self.git, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()

    def test_a_claim_without_proof_since_the_last_release_is_refused(self):
        base = self.commit('base')
        head = self.commit('fix: x\n\nUntested-critical-path: real sandbox prewarm')
        with unittest.mock.patch.object(packet_maker, 'REPO', self.repo):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_UNTESTED_CLAIM_WITHOUT_PROOF'):
                packet_maker.require_claims_proven(head, base, self.repo / 'out')

    def test_a_proven_claim_passes(self):
        base = self.commit('base')
        head = self.commit('fix: x\n\nUntested-critical-path: real sandbox prewarm\nReal-env-proof: ran r2l6 on Hermes')
        with unittest.mock.patch.object(packet_maker, 'REPO', self.repo):
            packet_maker.require_claims_proven(head, base, self.repo / 'out')

    def test_the_previous_packet_commit_is_the_default_start(self):
        root = self.repo / 'out'
        for name, commit in (('2026-10-01-a-change-packet-01', 'a' * 40), ('2026-10-20-b-change-packet-01', 'b' * 40)):
            (root / name).mkdir(parents=True)
            (root / name / packet_maker.PARAMETERS).write_text(json.dumps({'COMMIT': commit}))
        self.assertEqual(packet_maker.previous_release_commit(root), 'b' * 40)
        self.assertIsNone(packet_maker.previous_release_commit(self.repo / 'none'))

    def test_unknown_start_is_refused_not_skipped(self):
        head = self.commit('base')
        with unittest.mock.patch.object(packet_maker, 'REPO', self.repo):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_SINCE_UNKNOWN'):
                packet_maker.require_claims_proven(head, None, self.repo / 'out')

    def test_prepare_checks_claims_before_touching_production(self):
        source = (HERE / 'make-packet.py').read_text()
        body = source[source.index('def prepare(arguments):'):source.index('def build_packet(')]
        self.assertLess(body.index('require_claims_proven('), body.index('discover('))


class DependencyReinstallTest(unittest.TestCase):
    TAG = '[PG-4]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.source = root / 'source'
        self.source.mkdir()
        (self.source / 'package-lock.json').write_text('{"lockfileVersion": 3, "packages": {"": {}}}')
        self.tools = root / 'tools'
        self.calls = root / 'node-calls'
        self.outcome = root / 'node-outcome'
        self.outcome.write_text('0')
        bin_directory = root / 'bin'
        bin_directory.mkdir()
        node = bin_directory / 'node'
        node.write_text('#!/bin/bash\necho "$PWD $*" >> ' + shlex.quote(str(self.calls)) + '\nmkdir -p node_modules\nexit "$(cat ' + shlex.quote(str(self.outcome)) + ')"\n')
        node.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(bin_directory) + ':/usr/bin:/bin:/sbin')
        self.evidence = root / 'evidence'
        self.evidence.mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def install(self, run):
        return subprocess.run(['bash', str(HERE / 'hermes' / 'install-dependencies-if-changed.sh'), str(self.source), str(self.tools), str(self.evidence / ('install-' + run))], capture_output=True, text=True, env=self.environment, check=False)

    def installs(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_a_changed_dependency_lock_reinstalls_before_the_build_and_an_unchanged_one_does_not(self):
        first = self.install('run-1')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue(first.stdout.startswith('dependencies=reinstalled'))
        self.assertEqual(self.installs(), [str(self.source) + ' scripts/ci/install-dependencies.mjs --root . --tools ' + str(self.tools) + ' --evidence ' + str(self.evidence / 'install-run-1') + ' --cache .ci-output/npm-cache'])
        second = self.install('run-2')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertTrue(second.stdout.startswith('dependencies=unchanged'))
        self.assertEqual(len(self.installs()), 1)
        (self.source / 'package-lock.json').write_text('{"lockfileVersion": 3, "packages": {"": {}, "node_modules/docx-preview": {}}}')
        third = self.install('run-3')
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertTrue(third.stdout.startswith('dependencies=reinstalled'))
        self.assertEqual(len(self.installs()), 2)

    def test_a_failed_install_stops_the_build_and_is_retried_next_time(self):
        self.install('run-1')
        (self.source / 'package-lock.json').write_text('{"lockfileVersion": 3, "packages": {"": {}, "node_modules/web-push": {}}}')
        self.outcome.write_text('1')
        failed = self.install('run-2')
        self.assertEqual(failed.returncode, 5)
        self.assertIn('DEPENDENCY_INSTALL_FAILED', failed.stderr)
        self.outcome.write_text('0')
        retried = self.install('run-3')
        self.assertTrue(retried.stdout.startswith('dependencies=reinstalled'))
        self.assertEqual(len(self.installs()), 3)

    def test_missing_installed_dependencies_are_reinstalled_even_when_the_lock_matches(self):
        self.install('run-1')
        shutil.rmtree(self.source / 'node_modules')
        again = self.install('run-2')
        self.assertTrue(again.stdout.startswith('dependencies=reinstalled'))

    def test_the_builder_checks_dependencies_after_checkout_and_before_building_and_ships_the_helper(self):
        build = (HERE / 'hermes' / 'build-candidate.sh').read_text()
        self.assertLess(build.index('git checkout -q --detach'), build.index('install-dependencies-if-changed.sh" "$source"'))
        self.assertLess(build.index('install-dependencies-if-changed.sh" "$source"'), build.index('scripts/ci/local.mjs --check build'))
        generator = (HERE / 'make-packet.py').read_text()
        uploads = generator[generator.index('def install_scripts(self):'):generator.index('def start(self, name, command):')]
        self.assertIn("'install-dependencies-if-changed.sh'", uploads)


if __name__ == '__main__':
    unittest.main()
