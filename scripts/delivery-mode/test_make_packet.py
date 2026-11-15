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
ADDED_FILES = {'install/source-cache.mjs', 'install/verify-source-cache-fixtures.mjs', 'maintenance/verify-migrate-fixtures.mjs', 'measurement/verify-s6-report-contract.py', 'systemd/verify-startup-readiness-fixtures.mjs'}
RENAMED_FILES = {'systemd/fixtures/verify-doctor-fixtures.mjs': 'systemd/fixtures/verify-doctor.test.mjs'}
INTENDED_CHANGES = {
    'acceptance/OWNED-SHA256SUMS', 'acceptance/S6-limited-host-acceptance.sh', 'acceptance/cloud/adaptation-manifest.json',
    'acceptance/cloud/adapters/probe-authorized-network.mjs', 'acceptance/cloud/adapters/probe-foreground.mjs', 'acceptance/cloud/adapters/probe-network-boundary.mjs', 'acceptance/cloud/probe-source/packages/runtime-pi/scripts/probe-foreground.mjs', 'acceptance/cloud/cloud-inputs.draft.json',
    'acceptance/cloud/run-cloud-acceptance.sh', 'acceptance/cloud/run-stage-03.py', 'acceptance/cloud/run-question12-downloads.sh', 'inputs/bindings.draft.json',
    'inputs/check-packet-consistency.py', 'inputs/verify-packet-consistency.py', 'inputs/finalize-bindings.py', 'install/twelfth-artifact-install.mjs', 'install/verify-s9-clean-transport-fixtures.py', 'install/P5-new-prefix.md', 'inputs/verify-finalize-bindings.py', 'maintenance/OWNED-SHA256SUMS', 'maintenance/P-readback-design.md', 'maintenance/S9-control-files.py', 'maintenance/maintenance-common.mjs',
    'maintenance/production-shape-config-template.json', 'acceptance/cloud/download-question-12.py', 'acceptance/cloud/adapters/failure-scene.py', 'acceptance/cloud/verify-failure-scene-fixtures.py',
    'acceptance/helpers/test-resource-retention.py', 'acceptance/helpers/check-p5-scratch-cleanup.py', 'measurement/probe/run-service-probe.py', 'install/S9-clean-transport.py', 'signing/finalize-binding-inputs.py',
    'maintenance/raw-copy-recovery.mjs', 'maintenance/run-maintenance.mjs', 'maintenance/verify-fixtures.mjs', 'measurement/OWNED-SHA256SUMS', 'measurement/S6-service-read.py', 'measurement/probe/bootstrap.mjs', 's0-db/read-s0-db.mjs',
    'signing/cloud-protected-prepare.mjs', 'signing/cloud-seal.mjs', 'signing/publish-runtime-protection.mjs', 'steps/README.md', 'steps/run-local-step.py', 'steps/run-step.py', 'steps/verify-steps.py', 'systemd/OWNED-SHA256SUMS', 'systemd/P9-switch-start-readback.md',
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
    namespace = {'copy': copy, 'json': json}
    exec(compile(ast.Module(body=[function], type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
    return namespace['static_root_configuration']


def startup_phases(packet):
    startup_phases.audits = None
    source = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
    tree = ast.parse(source)
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ('startup_phases', 'content_audits_completed') or isinstance(node, ast.Assign) and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['startup_phase_baseline_ms']]
    namespace = {'json': json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'S7-switch-start-readback.py', 'exec'), namespace)
    startup_phases.audits = namespace['content_audits_completed']
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
        self.assertEqual(phases(self.journal(18824), 'missing', baseline), {'invocationId': 'missing', 'phases': [], 'warnings': [], 'runtimeDigests': []})

    def test_the_switch_report_warns_when_the_runtime_check_had_to_hash_files_again(self):
        phases, baseline = startup_phases(self.render())
        digest = lambda reused, hashed, retried: (9100, {'component': 'platform-node', 'event': 'sandbox_runtime.digest_completed', 'reused': reused, 'hashed': hashed, 'durationMs': 1100, 'retriedWithoutCache': retried})
        spawn = (0, {'component': 'pair-supervisor', 'event': 'pair.child_spawned', 'name': 'worker'})
        good = phases(startup_journal('start', [spawn, digest(30879, 0, False)]), 'start', baseline)
        self.assertEqual(good['warnings'], [])
        missed = phases(startup_journal('start', [spawn, (9000, {'component': 'platform-node', 'event': 'sandbox_runtime.fingerprint_cache_missed', 'reused': 0, 'hashed': 5}), (9100, {'component': 'platform-node', 'event': 'sandbox_runtime.content_audit_retrying'})]), 'start', baseline)
        self.assertEqual([warning['step'] for warning in missed['warnings']], ['runtime-fingerprint-cache-missed', 'content-audit-retrying'])
        self.assertEqual(good['runtimeDigests'][0]['reused'], 30879)
        for reused, hashed, retried in [(0, 30879, False), (10, 1, False), (30879, 0, True)]:
            bad = phases(startup_journal('start', [spawn, digest(reused, hashed, retried)]), 'start', baseline)
            self.assertEqual([warning['step'] for warning in bad['warnings']], ['runtime-fingerprint-cache'], (reused, hashed, retried))

    def test_the_s6_root_step_publishes_the_fingerprint_cache_the_service_will_read_and_fails_without_it(self):
        packet = self.render()
        step = (packet / 'signing' / 'publish-runtime-protection.mjs').read_text()
        runner = (packet / 'steps' / 'run-step.py').read_text()
        self.assertIn("'S6_RUNTIME_PROTECTION': [node, '--no-global-search-paths', str(stage / 'signing/publish-runtime-protection.mjs')]", runner)
        operations = re.search(r'const destination = "(/opt/himawari/operations/[^"]+)/runtime-protection.json"', step).group(1)
        self.assertIn('const fingerprintDestination = "' + operations + '/runtime-fingerprints.json";', step)
        readback = (packet / 'systemd' / 'S7-startup-readback.mjs').read_text()
        self.assertIn('const operations = "' + operations + '";', readback)
        self.assertIn('const protectionPath = operations + "/runtime-protection.json";', readback)
        order = [step.index(marker) for marker in [
            'await assert.rejects(lstat(fingerprintDestination), { code: "ENOENT" });',
            'process.env.HIMAWARI_RUNTIME_FINGERPRINT_FILE = fingerprintDestination;',
            'assert.equal(await platform.digestSandboxRuntime(runtime), receipt.runtimeDigest);',
            'await chmod(fingerprintDestination, 0o644);',
            'fingerprintInfo.uid === 0',
            'Object.keys(fingerprintCache.files).length > 0',
            'await writeFile(destination, bytes',
        ]]
        self.assertEqual(order, sorted(order))
        self.assertIn('(fingerprintInfo.mode & 0o7777) === 0o644', step)
        self.assertIn('fingerprintCache: { path: fingerprintDestination', step)
        self.assertEqual(step.count('runtime-fingerprints.json'), 1)
        shipped = [name.name for name in packet.rglob('*') if name.is_file() and name.suffix in ('.sh', '.py', '.mjs') and 'runtime-fingerprints' in name.read_text() and name.name != 'publish-runtime-protection.mjs']
        self.assertEqual(shipped, [])

    def test_an_unnamed_readback_error_keeps_its_original_message_and_location_in_the_failure_line(self):
        packet = self.render()
        source = (packet / 'systemd' / 'S7-startup-readback.mjs').read_text()
        call = 'process.stdout.write(JSON.stringify(await inspect(process.argv[2], process.argv[3])) + "\\n");'
        self.assertIn(call, source)
        flat = re.sub(r'^import \{[^}]*\} from "\./[^"]+";\n', '', source, flags=re.M)
        self.assertNotIn('from "./', flat)
        broken = flat.replace(call, 'throw new Error("ENOENT: no such file or directory, open \'/x/y\'");')
        named = flat.replace(call, 'throw new Error("TWELFTH_STARTUP_PID_INVALID");')
        path = packet / 'systemd' / 'readback-under-test.mjs'
        secret = flat.replace(call, 'throw new Error("fetch https://u:p@h.example/x?token=abc failed key sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 at /opt/himawari/state");')
        path.write_text(secret)
        leaked = subprocess.run([shutil.which('node'), str(path), '--preflight'], capture_output=True, text=True, cwd=packet)
        message = json.loads(leaked.stderr.strip().splitlines()[-1])['errorMessage']
        self.assertEqual(message, 'fetch <url> failed key <redacted> at /opt/himawari/state')
        for text, expected in [(broken, None), (named, 'TWELFTH_STARTUP_PID_INVALID')]:
            path.write_text(text)
            result = subprocess.run([shutil.which('node'), str(path), '--preflight'], capture_output=True, text=True, cwd=packet)
            self.assertEqual(result.returncode, 1, result.stderr)
            line = json.loads(result.stderr.strip().splitlines()[-1])
            if expected:
                self.assertEqual(line, {'passed': False, 'code': expected})
            else:
                self.assertEqual(line['code'], 'TWELFTH_STARTUP_INSPECTION_FAILED')
                self.assertEqual((line['errorName'], line['errorMessage']), ('Error', "ENOENT: no such file or directory, open '/x/y'"))
                self.assertTrue(line['frames'] and all(frame.startswith('at ') for frame in line['frames']))

    def test_a_rerun_moves_aside_the_evidence_files_an_earlier_run_left_instead_of_failing(self):
        import tempfile
        packet = self.render()
        source = (packet / 'maintenance' / 'maintenance-common.mjs').read_text()
        start = source.index('export function retainedJson')
        function = source[start:source.index('\n}\n', start) + 3]
        safe_start = source.index('function safeFile')
        safe = source[safe_start:source.index('\n}\n', safe_start) + 3]
        runner = (packet / 'maintenance' / 'run-maintenance.mjs').read_text()
        self.assertIn('supersede: action.startsWith("S9_")', runner)
        self.assertEqual(runner[runner.index('async function main'):].count('retainedJson('), 1)

        def run(body):
            with tempfile.TemporaryDirectory() as directory:
                evidence = Path(directory).resolve()
                module = evidence / 'retained-under-test.mjs'
                module.write_text('\n'.join([
                    'import assert from "node:assert/strict";',
                    'import { createHash } from "node:crypto";',
                    'import path from "node:path";',
                    'import { existsSync, linkSync, readFileSync, lstatSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
                    f'const evidenceRoot = {json.dumps(str(evidence))};',
                    'const fixed = { uid: process.getuid() };',
                    'const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");',
                    safe, function, body,
                ]).replace('__PKT_LABEL_UPPER__', 'TWENTYFIFTH'))
                result = subprocess.run([shutil.which('node'), str(module)], capture_output=True, text=True, cwd=evidence)
                runs = {item.name: json.loads(item.read_text())['run'] for item in evidence.glob('s9_*') if item.is_file() and not item.is_symlink()}
                return result, runs

        started = 's9_raw_restore51-started.json'
        result, runs = run('\n'.join(f'retainedJson("{started}", {{ run: {n} }}, {{ supersede: true }});' for n in (1, 2, 3)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(runs, {started: 3, started + '.superseded-1': 1, started + '.superseded-2': 2})

        result, runs = run('\n'.join(f'retainedJson("{started}", {{ run: {n} }});' for n in (1, 2)))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('EEXIST', result.stderr)
        self.assertEqual(runs, {started: 1})

        result, runs = run('\n'.join([
            f'writeFileSync(path.join(evidenceRoot, "other.json"), "{{}}");',
            f'symlinkSync(path.join(evidenceRoot, "other.json"), path.join(evidenceRoot, "{started}"));',
            f'retainedJson("{started}", {{ run: 2 }}, {{ supersede: true }});',
        ]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('MAINTENANCE_FILE_UNSAFE', result.stderr)
        self.assertEqual(runs, {})

    def test_the_switch_waits_for_both_background_content_audits_before_declaring_the_start_healthy(self):
        source = (self.render() / 'systemd' / 'S7-switch-start-readback.py').read_text()
        self.assertIn("sandbox_runtime.content_audit_completed", source)
        self.assertIn("if audits_completed and all(", source)
        startup_phases(self.render())
        event = lambda name, pid: {'event': 'sandbox_runtime.content_audit_' + name, 'pid': pid}
        gate = startup_phases.audits
        self.assertFalse(gate([]))
        self.assertFalse(gate([event('started', 11), event('completed', 11)]))
        self.assertFalse(gate([event('started', 11), event('completed', 11), event('completed', 11)]))
        self.assertFalse(gate([event('started', 11), event('started', 11), event('completed', 11), event('started', 12), event('completed', 12)]))
        self.assertTrue(gate([event('started', 11), event('started', 11), event('completed', 11), event('completed', 11), event('started', 12), event('completed', 12)]))
        self.assertFalse(gate([event('started', True), event('started', 12), event('completed', 12), event('completed', True)]))
        self.assertTrue(gate([event('started', 11), event('superseded', 11), event('started', 12), event('completed', 12)]))
        self.assertIn("'__PKT_LABEL_UPPER___SWITCH_CONTENT_AUDITS_NOT_COMPLETED' if not audits_completed".replace('__PKT_LABEL_UPPER__', 'TWELFTH'), (self.render() / 'systemd' / 'S7-switch-start-readback.py').read_text())

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
        self.assertEqual(packet_maker.startup_ready_budget(INSTANCE, worker('105_000')), 90000)
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STARTUP_BUDGET_LEAVES_NO_MARGIN budgetMs=90000 marginMs=15000 workerWaitMs=45000'):
            packet_maker.startup_ready_budget(INSTANCE, worker('45_000'))
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_WORKER_STARTUP_WAIT_NOT_READABLE'):
            packet_maker.startup_ready_budget(INSTANCE, 'const STARTUP_WAIT = 45_000;\n')
        for key, invalid in (('startupReadyBudgetSeconds', None), ('startupReadyBudgetSeconds', 0), ('startupReadyMarginSeconds', -1), ('startupReadyMarginSeconds', 1.5), ('startupReadyBudgetSeconds', '30')):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STARTUP_BUDGET_INVALID'):
                packet_maker.startup_ready_budget({**INSTANCE, key: invalid}, worker('105_000'))

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

    def test_the_bound_cleanup_helper_digest_follows_the_helper(self):
        packet = self.render()
        helper = packet / 'acceptance' / 'helpers' / 'check-p5-scratch-cleanup.py'
        draft_path = packet / packet_maker.CLOUD_INPUTS
        packet_maker.regenerate_hashes(packet)
        self.assertEqual(json.loads(draft_path.read_text())['cleanupHelper']['sha256'], hashlib.sha256(helper.read_bytes()).hexdigest())
        helper.write_text(helper.read_text() + '\n')
        self.assertIn('CLOUD_INPUT_CLEANUP_HELPER_DIGEST_STALE ' + json.loads(draft_path.read_text())['cleanupHelper']['path'], self.consistency_problems(packet))
        packet_maker.regenerate_hashes(packet)
        self.assertEqual(json.loads(draft_path.read_text())['cleanupHelper']['sha256'], hashlib.sha256(helper.read_bytes()).hexdigest())
        self.assertEqual([problem for problem in self.consistency_problems(packet) if not problem.startswith('CANDIDATE_ARCHIVE_MISSING')], [])

    def test_the_bound_cleanup_helper_path_must_stay_inside_the_packet(self):
        self.assertEqual(packet_maker.packet_member('/x/packet/acceptance/helpers/a.py'), 'acceptance/helpers/a.py')
        for path in ['/x/packet/../secret', '/x/packet/acceptance/../../secret', '/x/packet//etc/passwd', '/x/elsewhere/a.py', '/x/packet/a/packet/b.py']:
            with self.subTest(path=path), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_STAGED_PATH_OUTSIDE_PACKET'):
                packet_maker.packet_member(path)

    def test_the_template_cleanup_helper_digest_matches_the_template_helper(self):
        draft = (packet_maker.TEMPLATE / 'acceptance' / 'cloud' / 'cloud-inputs.draft.json').read_text()
        helper = packet_maker.TEMPLATE / 'acceptance' / 'helpers' / 'check-p5-scratch-cleanup.py'
        self.assertEqual(re.findall(r'"cleanupHelper": \{\s*"path": "[^"]+",\s*"sha256": "([0-9a-f]{64})"', draft), [hashlib.sha256(helper.read_bytes()).hexdigest()])

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

    def setUp(self):
        super().setUp()
        patcher = unittest.mock.patch.object(packet_maker, 'check_migration_replay')
        patcher.start()
        self.addCleanup(patcher.stop)

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

    def test_the_owner_lost_rebuild_that_copies_every_row_back_is_allowed_and_anything_else_is_not(self):
        sql = (packet_maker.REPO / packet_maker.MIGRATIONS / '0083_model_invocation_owner_lost.sql').read_text()
        tables = ['model_budget_allocations', 'model_invocation_identities']
        name = '0083_model_invocation_owner_lost.sql'
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql, tables), tables)
        self.assertEqual(packet_maker.rebuilds_keeping_rows('0099_other.sql', sql, tables), [])
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql + '\nDELETE FROM model_budget_allocations;', tables), [])
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql + '\nDROP TABLE model_budget_allocations;', tables), [])
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, '-- ' + sql, tables), [])
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql + '\nUPDATE saved_model_budget_allocations SET id = id;', tables), [])
        self.assertEqual(packet_maker.rebuilds_keeping_rows(name, sql.replace('INSERT INTO model_invocation_identities SELECT * FROM saved_model_invocation_identities;', ''), tables), [])

    def test_the_owner_lost_rebuild_is_allowed_through_the_migration_ledger_as_the_packet_maker_reads_it_from_git(self):
        self.assertEqual(packet_maker.migration_ledger('HEAD', 82, 83), [{'sequence': 83, 'name': 'model_invocation_owner_lost', 'phase': 'expand'}])

    def test_the_thread_origin_backfill_is_allowed_only_with_its_exact_text_and_the_ignored_history_column(self):
        name = '20261115045512_thread_origin.sql'
        sql = packet_maker.git('show', 'HEAD:' + packet_maker.MIGRATIONS + '/' + name)
        self.assertEqual(packet_maker.added_column_backfills(name, sql, ['threads']), ['threads'])
        self.assertEqual(packet_maker.added_column_backfills(name, sql + '\nDELETE FROM threads;', ['threads']), [])
        self.assertEqual(packet_maker.added_column_backfills('other.sql', sql, ['threads']), [])
        self.assertEqual(packet_maker.added_column_backfills(name, sql, ['messages']), [])
        self.assertEqual(packet_maker.history_ignored_columns(), {'thread_origin': {'threads': ('origin',)}})
        with unittest.mock.patch.dict(packet_maker.ADDED_COLUMN_BACKFILLS, {'0099_old_style.sql': (hashlib.sha256(sql.strip().encode()).hexdigest(), {'threads': 'origin'})}):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_ADDED_COLUMN_BACKFILL_NAME_INVALID'):
                packet_maker.added_column_backfills('0099_old_style.sql', sql, ['threads'])

    def test_history_fixtures_pass_in_a_packet_whose_ledger_applies_thread_origin(self):
        ledger = json.dumps([{'sequence': 57, 'id': '20261115045512', 'name': 'thread_origin', 'phase': 'expand'}], separators=(',', ':'))
        for packet in (self.render(MIGRATION_LEDGER=ledger, TARGET_SCHEMA=57), self.render()):
            scratch = self.root / ('fixture-temp-' + packet.name)
            scratch.mkdir()
            result = subprocess.run([shutil.which('node'), str(packet / 'maintenance' / 'verify-fixtures.mjs')], capture_output=True, text=True, cwd=HERE.parents[1], env={**os.environ, 'HIMAWARI_TEST_TEMP_ROOT': str(scratch)}, check=False)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            self.assertTrue(json.loads(result.stdout.strip().splitlines()[-1])['passed'])

    def history_fixtures(self, packet):
        scratch = self.root / ('fixture-temp-' + packet.name)
        scratch.mkdir()
        return subprocess.run([shutil.which('node'), str(packet / 'maintenance' / 'verify-fixtures.mjs')], capture_output=True, text=True, cwd=HERE.parents[1], env={**os.environ, 'HIMAWARI_TEST_TEMP_ROOT': str(scratch)}, check=False)

    def history_off(self, release='twelfth'):
        comparison = {'mode': 'off', 'reason': INSTANCE['historyComparison']['reason'], 'authorizedBy': INSTANCE['historyComparison']['authorizedBy'], 'release': release}
        return {'HISTORY_COMPARISON': 'off', 'HISTORY_COMPARISON_JSON': json.dumps(comparison, sort_keys=True, separators=(',', ':'), ensure_ascii=True)}

    def test_twentyninth_history_comparison_is_off_only_for_that_release(self):
        decision = INSTANCE['historyComparison']
        self.assertEqual(packet_maker.history_comparison(INSTANCE, 'twentyninth'), {'mode': 'off', 'reason': decision['reason'], 'authorizedBy': 'cmsg_01EE1hey9cboYNfwFnBv5dgr57gFLC1LwkkuA5Tm38FypH', 'release': 'twentyninth'})
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HISTORY_COMPARISON_OFF_FOR_OTHER_RELEASE'):
            packet_maker.history_comparison(INSTANCE, 'thirtieth')
        self.assertEqual(packet_maker.history_comparison({}, 'thirtieth'), {'mode': 'on'})
        self.assertEqual(packet_maker.history_comparison({'historyComparison': {'mode': 'on'}}, 'thirtieth'), {'mode': 'on'})
        for broken in ({'mode': 'partial'}, {**decision, 'reason': ' '}, {**decision, 'authorizedBy': 'Andy'}, {**decision, 'tables': ['model_budget_accounts']}, {'mode': 'off', 'release': 'twentyninth'}, 'off'):
            with self.subTest(broken=broken), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HISTORY_COMPARISON_INVALID'):
                packet_maker.history_comparison({'historyComparison': broken}, 'twentyninth')

    def test_andy_production_keeps_a_failed_deploy_and_other_instances_roll_back(self):
        self.assertEqual(packet_maker.deploy_failure_choice(INSTANCE), 'keep')
        self.assertEqual(packet_maker.deploy_failure_choice({}), 'rollback')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_ON_DEPLOY_FAILURE_INVALID'):
            packet_maker.deploy_failure_choice({'onDeployFailure': 'ignore'})

    def test_history_comparison_off_lets_a_migration_touch_preserved_tables(self):
        derived = packet_maker.schema_parameters({'COMMIT': MEMORY_PAGE_COMMIT, 'TARGET_SCHEMA': 30, 'HISTORY_COMPARISON': 'off'}, {'schema': {'current': 29, 'minimumWriter': 29}})
        self.assertEqual(json.loads(derived['MIGRATION_LEDGER']), [{'sequence': 30, 'name': 'run_model_selection', 'phase': 'expand'}])
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES'):
            packet_maker.schema_parameters({'COMMIT': MEMORY_PAGE_COMMIT, 'TARGET_SCHEMA': 30, 'HISTORY_COMPARISON': 'on'}, {'schema': {'current': 29, 'minimumWriter': 29}})

    def test_history_fixtures_pass_with_comparison_off_and_changed_history_rows(self):
        ledger = json.dumps([{'sequence': 57, 'id': '20261115045512', 'name': 'thread_origin', 'phase': 'expand'}], separators=(',', ':'))
        for packet in (self.render(MIGRATION_LEDGER=ledger, TARGET_SCHEMA=57, **self.history_off()), self.render(**self.history_off())):
            result = self.history_fixtures(packet)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            record = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(record['passed'])
            self.assertGreaterEqual(record['counts']['historyComparisonOff'], 2)
            self.assertIn("history_comparison = 'off'", (packet / 'systemd' / 'S7-switch-start-readback.py').read_text())
            self.assertIn('...historyComparisonEvidence(), passed: false', (packet / 'maintenance' / 'run-maintenance.mjs').read_text())
        self.assertIn("history_comparison = 'on'", (self.render() / 'systemd' / 'S7-switch-start-readback.py').read_text())

    def test_s9_restore_compares_history_even_when_the_release_switch_is_off(self):
        runner = (self.render(**self.history_off()) / 'maintenance' / 'run-maintenance.mjs').read_text()
        restore = runner[runner.index('const reference = retained.reference;'):]
        self.assertTrue(restore.splitlines()[1].strip().startswith('verifyHistoryUnchanged(reference, state, Object.freeze({ mode: "on" }))'))

    def test_a_packet_whose_history_switch_names_another_release_refuses_to_load(self):
        result = self.history_fixtures(self.render(**self.history_off(release='twentyninth')))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('TWELFTH_MAINTENANCE_HISTORY_COMPARISON_OFF_FOR_OTHER_RELEASE', result.stderr)

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

    def test_p3_1_an_approved_embedding_switch_replaces_only_the_embedding_and_its_dimensions(self):
        target = {'ref': 'local-embedding', 'role': 'embedding', 'provider': 'local-onnx', 'model': 'jina-embeddings-v5-text-small-retrieval-int8', 'version': 'onnx-int8-v1', 'allowedDataClassifications': ['public', 'private', 'sensitive'], 'disclosure': 'local_only', 'secretRef': None, 'capabilities': ['embedding'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'dimensions': 1024, 'artifactSha256': 'd' * 64}
        packet = self.render(TARGET_EMBEDDING_JSON=packet_maker.embedding_target(target))
        original = production_config(TWELFTH['OLD_PREFIX'], TWELFTH['ORIGINAL_PUBLIC_FETCH_BYTES'], TWELFTH['ORIGINAL_CONTEXT_WINDOW'], TWELFTH['ORIGINAL_MAX_TOKENS'])
        original['modelDescriptors'].append({'ref': 'qwen-embedding', 'role': 'embedding', 'provider': 'vercel-ai-gateway', 'model': 'alibaba/qwen3-embedding-8b', 'dimensions': 4096, 'secretRef': 'vercel-gateway'})
        original['memory'] = {'adapter': 'mem0-oss', 'dimensions': 4096, 'minimumSimilarity': 0.6}
        original['runPolicy']['proactive'] = {'modelRef': 'deepseek-primary', 'memoryMinimumSimilarity': 0.45}
        switched = static_root_configuration(packet)(original)
        self.assertEqual(switched['modelDescriptors'][1], target)
        self.assertEqual(switched['modelDescriptors'][0]['ref'], 'deepseek-primary')
        self.assertEqual(switched['memory'], {'adapter': 'mem0-oss', 'dimensions': 1024})
        self.assertEqual(switched['runPolicy']['proactive'], {'modelRef': 'deepseek-primary'})
        fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)
        self.assertIn('cases=11', fixtures.stdout)
        without = copy.deepcopy(original)
        without['modelDescriptors'].pop()
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_SWITCH_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED'):
            static_root_configuration(packet)(without)
        unchanged = static_root_configuration(self.render())(copy.deepcopy(original))
        self.assertEqual(unchanged['modelDescriptors'][1], original['modelDescriptors'][1])
        self.assertEqual(unchanged['memory'], original['memory'])

    def test_p3_1_an_embedding_target_outside_the_local_policy_is_refused(self):
        valid = {'ref': 'local-embedding', 'role': 'embedding', 'provider': 'local-onnx', 'model': 'jina-embeddings-v5-text-small-retrieval-int8', 'version': 'v', 'allowedDataClassifications': ['public', 'private'], 'disclosure': 'local_only', 'secretRef': None, 'capabilities': ['embedding'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'dimensions': 1024, 'artifactSha256': 'a' * 64}
        gateway = {**{key: value for key, value in valid.items() if key != 'artifactSha256'}, 'provider': 'vercel-ai-gateway', 'model': 'alibaba/qwen3-embedding-8b', 'disclosure': 'external_remote', 'secretRef': 'vercel-gateway', 'dimensions': 4096}
        self.assertEqual(packet_maker.embedding_target(None), 'null')
        self.assertEqual(json.loads(packet_maker.embedding_target(valid)), valid)
        self.assertEqual(json.loads(packet_maker.embedding_target(gateway)), gateway)
        missing_cost = {key: value for key, value in valid.items() if key != 'cost'}
        for candidate in (
            {**valid, 'secretRef': 'vercel-gateway'}, {**valid, 'disclosure': 'external_remote'}, {**valid, 'artifactSha256': 'short'},
            {**valid, 'artifactSha256': '0' * 64}, {**valid, 'role': 'primary'}, {**valid, 'dimensions': 0}, {**valid, 'dimensions': 768},
            {**valid, 'unknown': 1}, {**valid, 'model': "it's"}, {**valid, 'model': 'unknown-model'}, missing_cost,
            {**valid, 'cost': {**valid['cost'], 'input': 1}}, {**valid, 'capabilities': ['text']},
            {**gateway, 'artifactSha256': 'a' * 64}, {**gateway, 'secretRef': None}, {**gateway, 'dimensions': 768},
            {**valid, 'artifactSha256': int('1' * 64)}, {**valid, 'version': 'has space'}, {**valid, 'allowedDataClassifications': ['secret']},
            {**valid, 'capabilities': ['embedding', 3]}, {**gateway, 'cost': {**gateway['cost'], 'input': -1}}, {**gateway, 'cost': {**gateway['cost'], 'input': True}},
            {**gateway, 'disclosure': 'public'}, {**gateway, 'secretRef': 'bad ref'},
            {**valid, 'allowedDataClassifications': ['private', 'private']}, {**valid, 'capabilities': ['embedding', 'embedding']},
            {**valid, 'capabilities': ['embedding', 'image input']}, {**gateway, 'cost': {**gateway['cost'], 'input': float('inf')}},
            {**gateway, 'cost': {**gateway['cost'], 'input': 10 ** 400}}, {**valid, 'allowedDataClassifications': ['private', ['nested']]},
        ):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_EMBEDDING_TARGET_INVALID'):
                packet_maker.embedding_target(candidate)

    def test_p3_1_packet_embedding_profiles_match_the_runtime_profiles(self):
        source = (HERE.parents[1] / 'packages/application/src/embedding-profiles.ts').read_text()
        found = {}
        for block in re.findall(r'Object\.freeze\(\{(.*?)\}\)', source, re.S):
            model = re.search(r'model: "([^"]+)"', block)
            provider = re.search(r'provider: (\w+)', block)
            dims = re.search(r'dimensions: Object\.freeze\(\[([\d, ]+)\]\)', block)
            if model and provider and dims:
                name = {'GATEWAY_EMBEDDING_PROVIDER': 'vercel-ai-gateway', 'LOCAL_ONNX_EMBEDDING_PROVIDER': 'local-onnx'}[provider.group(1)]
                found[(name, model.group(1))] = tuple(int(value) for value in dims.group(1).split(','))
        self.assertEqual(found, packet_maker.EMBEDDING_PROFILES)


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
        uploaded = Path(self.hermes.scripts) / 'builder.json'
        settings = json.loads(uploaded.read_text())
        settings['hostname'] += '-elsewhere'
        uploaded.write_text(json.dumps(settings))
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

    def test_a_packet_whose_audit_script_reads_the_schema_by_introspection_passes_for_any_target(self):
        self.write_audit_copy('export const LEGACY_MIGRATION_COUNT = 95;\nexport const AUDIT_READ_TABLES = Object.freeze([\n  "runs",\n]);\n')
        self.assertIsNone(checks_runner.audit_script_problem(self.packet, 96))
        self.assertIsNone(checks_runner.audit_script_problem(self.packet, 500))

    def test_a_packet_whose_audit_script_lists_no_tables_is_refused(self):
        self.write_audit_copy('export const LEGACY_MIGRATION_COUNT = 95;\nexport const AUDIT_READ_TABLES = Object.freeze([]);\n')
        self.assertIsNotNone(checks_runner.audit_script_problem(self.packet, 96))

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
        (source / 'package.json').write_text('{}')
        subprocess.run(['git', 'init', '-q', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], check=True)
        self.source = source
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

    def test_a_source_checkout_without_files_stops_the_preflight(self):
        (self.source / 'package.json').unlink()
        for argument in ('--preflight', 'walk-1'):
            run = self.walkthrough(argument)
            self.assertEqual(run.returncode, 3)
            self.assertIn('SOURCE_TREE_EMPTY ' + str(self.source), run.stderr)
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


class SourceBundleTest(unittest.TestCase):
    TAG = '[PG-1]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.repo = self.root / 'repo'
        self.git_environment = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        self.run_git('init', '-q', str(self.repo), cwd=self.root)
        self.commits = []
        for index in range(4):
            (self.repo / ('file-' + str(index) + '.txt')).write_text(os.urandom(2000).hex() + '\n')
            self.run_git('add', '-A')
            self.run_git('commit', '-q', '-m', 'commit ' + str(index))
            self.commits.append(self.run_git('rev-parse', 'HEAD'))
        patcher = unittest.mock.patch.object(packet_maker, 'REPO', self.repo)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.directory.cleanup()

    def run_git(self, *arguments, cwd=None):
        child = subprocess.run(['git', *arguments], cwd=cwd or self.repo, env=self.git_environment, capture_output=True, text=True, check=True)
        return child.stdout.strip()

    def test_the_nearest_ancestor_the_server_already_holds_is_the_base(self):
        first, second, third, fourth = self.commits
        self.assertEqual(packet_maker.choose_source_base(fourth, [first, second]), second)
        self.assertEqual(packet_maker.choose_source_base(fourth, [second, first]), second)
        self.assertEqual(packet_maker.choose_source_base(third, [first, second, fourth]), second)

    def test_a_server_without_a_usable_cache_gets_the_whole_history(self):
        first, second, third, fourth = self.commits
        self.assertIsNone(packet_maker.choose_source_base(fourth, []))
        self.assertIsNone(packet_maker.choose_source_base(second, [third, fourth]))
        self.assertIsNone(packet_maker.choose_source_base(fourth, ['f' * 40]))

    def test_a_commit_the_server_already_holds_is_sent_against_its_parent(self):
        first, second, third, fourth = self.commits
        self.assertEqual(packet_maker.choose_source_base(fourth, [first, fourth]), third)
        self.assertIsNone(packet_maker.choose_source_base(first, [first]))

    def test_an_incremental_bundle_needs_only_its_base_and_is_smaller(self):
        first, second, third, fourth = self.commits
        full, incremental = self.root / 'full.bundle', self.root / 'incremental.bundle'
        packet_maker.create_bundle(fourth, full)
        packet_maker.create_bundle(fourth, incremental, third)
        self.assertEqual(packet_maker.bundle_prerequisites(full), [])
        self.assertEqual(packet_maker.bundle_prerequisites(incremental), [third])
        self.assertLess(incremental.stat().st_size, full.stat().st_size)
        cache = self.root / 'cache.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(cache)], check=True)
        refused = subprocess.run(['git', '-C', str(cache), 'bundle', 'verify', str(incremental)], capture_output=True, text=True, check=False)
        self.assertNotEqual(refused.returncode, 0)
        seeded = self.root / 'seeded.bundle'
        packet_maker.create_bundle(third, seeded)
        for bundle, head in ((seeded, third), (incremental, fourth)):
            subprocess.run(['git', '-C', str(cache), 'fetch', '-q', '--no-tags', str(bundle), 'HEAD:refs/release/' + head], check=True)
        self.assertEqual(subprocess.run(['git', '-C', str(cache), 'rev-parse', 'refs/release/' + fourth], capture_output=True, text=True, check=True).stdout.strip(), fourth)

    def test_a_cached_commit_on_another_line_of_history_is_not_chosen_as_the_base(self):
        first, second, third, fourth = self.commits
        self.run_git('checkout', '-q', '-b', 'side', first)
        (self.repo / 'side.txt').write_text('side\n')
        self.run_git('add', '-A')
        self.run_git('commit', '-q', '-m', 'side')
        side = self.run_git('rev-parse', 'HEAD')
        self.assertIsNone(packet_maker.choose_source_base(fourth, [side]))
        self.assertEqual(packet_maker.choose_source_base(fourth, [side, first]), first)

    def test_hermes_gets_its_own_whole_bundle_when_it_lacks_the_base(self):
        first, second, third, fourth = self.commits
        wrapper = self.root / 'hermes-ssh.sh'
        wrapper.write_text('#!/bin/bash\nexec bash -c "$1"\n')
        wrapper.chmod(0o755)
        builder_repo = self.root / 'builder-repo'
        subprocess.run(['git', 'clone', '-q', '--no-checkout', str(self.repo), str(builder_repo)], check=True)
        with unittest.mock.patch.dict(os.environ, {'HIMAWARI_HERMES_SSH': str(wrapper)}):
            hermes = packet_maker.Hermes('twentyfourth-1234abcd-20261101t010203')
            hermes.settings = {**hermes.settings, 'source': str(builder_repo)}
            self.assertTrue(hermes.has_commit(third))
            self.assertFalse(hermes.has_commit('e' * 40))
            materials, work = self.root / 'materials', self.root / 'work'
            materials.mkdir()
            work.mkdir()
            parameters = {'BUNDLE_NAME': 'source-' + fourth[:7] + '.bundle', 'SOURCE_CACHE_COMMITS': [third]}
            shared = packet_maker.make_source_bundles(argparse.Namespace(full_source=False), fourth, parameters, materials, work, hermes)
            self.assertEqual((parameters['SOURCE_BASE_COMMIT'], shared), (third, materials / parameters['BUNDLE_NAME']))
            self.assertEqual(packet_maker.bundle_prerequisites(shared), [third])
            hermes.has_commit = lambda commit: False
            parameters = {'BUNDLE_NAME': 'source-' + fourth[:7] + '.bundle', 'SOURCE_CACHE_COMMITS': [third]}
            separate = packet_maker.make_source_bundles(argparse.Namespace(full_source=False), fourth, parameters, materials, work, hermes)
            self.assertEqual((parameters['SOURCE_BASE_COMMIT'], separate), (third, work / 'builder.bundle'))
            self.assertEqual(packet_maker.bundle_prerequisites(separate), [])
            self.assertEqual(packet_maker.bundle_prerequisites(materials / parameters['BUNDLE_NAME']), [third])

    def test_the_full_source_flag_ships_the_whole_history(self):
        first, second, third, fourth = self.commits
        materials, work = self.root / 'materials', self.root / 'work'
        materials.mkdir()
        work.mkdir()

        class Builder:
            def has_commit(self, commit):
                raise AssertionError('the builder is not asked when the whole history is shipped')
        parameters = {'BUNDLE_NAME': 'source-' + fourth[:7] + '.bundle', 'SOURCE_CACHE_COMMITS': [third]}
        bundle = packet_maker.make_source_bundles(argparse.Namespace(full_source=True), fourth, parameters, materials, work, Builder())
        self.assertEqual((parameters['SOURCE_BASE_COMMIT'], packet_maker.bundle_prerequisites(bundle)), ('', []))

    def test_full_source_together_with_reused_materials_is_refused_before_anything_runs(self):
        arguments = argparse.Namespace(full_source=True, reuse_materials='/earlier/packet')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_FULL_SOURCE_WITH_REUSE'):
            packet_maker.prepare(arguments)

    def test_discovery_reports_the_releases_the_server_cache_holds(self):
        facts = production_facts(sourceCacheCommits=['b' * 40, 'a' * 40, 'not-a-commit'])
        self.assertEqual(packet_maker.interpret_discovery(facts, INSTANCE)['SOURCE_CACHE_COMMITS'], ['a' * 40, 'b' * 40])
        self.assertEqual(packet_maker.interpret_discovery(production_facts(), INSTANCE)['SOURCE_CACHE_COMMITS'], [])
        self.assertIn('refs/release', packet_maker.discovery_script())
        self.assertEqual(packet_maker.source_cache(INSTANCE), '/opt/himawari/source-cache.git')

    def test_the_cache_fixtures_run_with_the_other_packet_checks(self):
        names = [name for name, command, directory in checks_runner.plan(Path('/packet'), Path('node'), 'python', False, False)]
        self.assertIn('install/verify-source-cache-fixtures.mjs', names)

    def test_the_real_sandbox_boundary_check_runs_on_hermes_from_the_source_checkout(self):
        hermes = {name: (command, directory) for name, command, directory in checks_runner.plan(Path('/packet'), Path('node'), 'python', True, False)}
        self.assertEqual(hermes[checks_runner.SRT_BOUNDARY], (['node', 'packages/runtime-sandbox/scripts/check-srt-boundary.mjs'], 'source'))
        self.assertTrue((HERE.parent.parent / checks_runner.SRT_BOUNDARY).is_file())
        elsewhere = [name for name, command, directory in checks_runner.plan(Path('/packet'), Path('node'), 'python', False, False)]
        self.assertNotIn(checks_runner.SRT_BOUNDARY, elsewhere)

    def test_the_cache_fixtures_pass_against_real_git(self):
        child = subprocess.run(['node', str(HERE / 'packet-template/install/verify-source-cache-fixtures.mjs')], capture_output=True, text=True, check=False, env={**os.environ, 'HIMAWARI_TEST_TEMP_ROOT': str(self.root)})
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertTrue(json.loads(child.stdout)['passed'])


class InstalledProbeCheckTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.packet = self.root / 'packet'
        runner = self.packet / checks_runner.PRODUCTION_PROBE_RUNNER
        runner.parent.mkdir(parents=True)
        runner.write_text("    if pi['passed'] != 22 or pi['qualification']:\n")

    def report(self, **changes):
        report = {'passed': 22, 'qualification': False, 'reports': [{'namespaceState': 'released'}] * 22, **changes}
        return ('noise\n' + json.dumps(report) + '\n').encode()

    def test_the_installed_probe_runs_only_where_the_real_runtime_can_be_installed(self):
        hermes = {name: (command, directory) for name, command, directory in checks_runner.plan(Path('/packet'), Path('node'), 'python', True, False)}
        self.assertEqual(hermes[checks_runner.INSTALLED_PROBE], (['node', '/packet/' + checks_runner.INSTALLED_PROBE], 'installed-probe'))
        elsewhere = [name for name, command, directory in checks_runner.plan(Path('/packet'), Path('node'), 'python', False, False)]
        self.assertNotIn(checks_runner.INSTALLED_PROBE, elsewhere)

    def test_the_probe_that_production_runs_is_the_one_in_the_packet(self):
        template = HERE / 'packet-template'
        self.assertTrue((template / checks_runner.INSTALLED_PROBE).is_file())
        self.assertEqual(checks_runner.expected_probe_count(template), 22)

    def test_a_clean_report_passes(self):
        self.assertIsNone(checks_runner.installed_probe_problem(self.packet, self.report()))

    def test_the_expected_count_is_read_from_the_production_runner(self):
        (self.packet / checks_runner.PRODUCTION_PROBE_RUNNER).write_text("    if pi['passed'] != 23:\n")
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report()), 'INSTALLED_PROBE_COUNT passed=22 expected=23')

    def test_a_probe_that_fails_an_assertion_or_prints_no_report_is_refused(self):
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, b''), 'INSTALLED_PROBE_REPORT_MISSING')
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, b'not json\n'), 'INSTALLED_PROBE_REPORT_MISSING')
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(passed=21)), 'INSTALLED_PROBE_COUNT passed=21 expected=22')

    def test_a_report_that_issues_a_qualification_or_keeps_a_namespace_is_refused(self):
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(qualification=True)), 'INSTALLED_PROBE_QUALIFICATION_ISSUED')
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(reports=[{'namespaceState': 'held'}] * 22)), 'INSTALLED_PROBE_NAMESPACE_NOT_RELEASED')

    def test_two_runner_counts_are_refused(self):
        (self.packet / checks_runner.PRODUCTION_PROBE_RUNNER).write_text("pi['passed'] != 22\npi['passed'] != 22\n")
        with self.assertRaisesRegex(SystemExit, 'PACKET_CHECKS_PROBE_COUNT_MISSING'):
            checks_runner.expected_probe_count(self.packet)

    def test_fd_comes_from_the_given_directory_and_the_other_tools_from_the_system(self):
        tools = self.root / 'tools'
        tools.mkdir()
        self.assertIsNone(checks_runner.pi_tools({}))
        self.assertIsNone(checks_runner.pi_tools({checks_runner.PI_TOOLS_VARIABLE: str(self.root / 'missing')}))
        self.assertIsNone(checks_runner.pi_tools({checks_runner.PI_TOOLS_VARIABLE: str(tools)}))
        (tools / 'fd').write_text('#!/bin/sh\n')
        (tools / 'fd').chmod(0o755)
        found = checks_runner.pi_tools({checks_runner.PI_TOOLS_VARIABLE: str(tools)})
        if shutil.which('rg', path='/usr/bin:/bin'):
            self.assertEqual(found['fd'], str(tools / 'fd'))
            self.assertTrue(found['bash'].startswith(('/usr/bin/', '/bin/')))
        else:
            self.assertIsNone(found)

    def test_a_report_without_the_expected_number_of_rows_is_refused(self):
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(reports=[])), 'INSTALLED_PROBE_REPORT_ROWS expected=22')
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(reports=None)), 'INSTALLED_PROBE_REPORT_ROWS expected=22')
        rows = [{'namespaceState': 'released'}] * 22
        self.assertIsNone(checks_runner.installed_probe_problem(self.packet, self.report(reports=rows)))
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(reports=rows[:21] + [{'namespaceState': 'held'}])), 'INSTALLED_PROBE_NAMESPACE_NOT_RELEASED')
        self.assertEqual(checks_runner.installed_probe_problem(self.packet, self.report(reports=rows[:21] + ['x'])), 'INSTALLED_PROBE_NAMESPACE_NOT_RELEASED')

    def test_a_probe_that_never_returns_is_stopped_and_reported(self):
        tools = self.root / 'tools'
        tools.mkdir()
        (tools / 'fd').write_text('#!/bin/sh\n')
        (tools / 'fd').chmod(0o755)
        output = self.root / 'out.log'
        with unittest.mock.patch.object(checks_runner, 'install_candidate', return_value=0), unittest.mock.patch.object(checks_runner, 'INSTALLED_PROBE_TIMEOUT_SECONDS', 1), output.open('wb') as handle:
            scratch = self.root / 'scratch'
            scratch.mkdir()
            (scratch / 'prefix/lib/himawari-agent').mkdir(parents=True)
            code = checks_runner.run_installed_probe([sys.executable, '-c', 'import time; time.sleep(30)'], self.packet, self.root, {checks_runner.PI_TOOLS_VARIABLE: str(tools)}, handle, scratch)
        if shutil.which('rg', path='/usr/bin:/bin'):
            self.assertEqual(code, 1)
            self.assertIn('INSTALLED_PROBE_TIMEOUT', output.read_text())

    def test_every_adapter_hash_in_the_adaptation_manifest_matches_its_file(self):
        base = HERE / 'packet-template/acceptance/cloud'
        entries = re.findall(r'"adapter": "([^"]+)",\s*"adapterSha256": "([0-9a-f]{64})"', (base / 'adaptation-manifest.json').read_text())
        self.assertGreaterEqual(len(entries), 5)
        for adapter, digest in entries:
            self.assertEqual(hashlib.sha256((base / adapter).read_bytes()).hexdigest(), digest, adapter)

    def test_a_run_without_the_tools_directory_fails_before_installing_anything(self):
        output = self.root / 'out.log'
        with output.open('wb') as handle:
            code = checks_runner.run_installed_probe(['node', 'probe.mjs'], self.packet, self.root, {}, handle, self.root)
        self.assertEqual(code, 1)
        self.assertIn('INSTALLED_PROBE_PI_TOOLS_MISSING', output.read_text())
        self.assertFalse((self.root / 'prefix').exists())

    def test_the_packet_checker_passes_the_tools_directory(self):
        source = (HERE / 'make-packet.py').read_text()
        self.assertIn("' --pi-tools ' + shlex.quote(self.settings['piToolBin'])", source)


class TimestampedMigrationTests(unittest.TestCase):
    LEGACY = ['0001_one.sql', '0002_two.sql', '0003_three.sql']
    ENGINE = ''.join('{ sequence: %d, name: "%s", changeSet: "x", phase: "expand" as const, file: "%s" },' % (index + 1, name[5:-4], name) for index, name in enumerate(LEGACY))

    def fake_git(self, files):
        def run(*arguments, binary=False):
            if arguments[0] == 'ls-tree':
                return '\n'.join(packet_maker.MIGRATIONS + '/' + name for name in files)
            if arguments[0] == 'show' and arguments[1].endswith(packet_maker.MIGRATION_ENGINE):
                return self.ENGINE
            if arguments[0] == 'show':
                return 'CREATE TABLE harmless (id TEXT);'
            raise AssertionError(arguments)
        return run

    def plan(self, files, applied, current=None):
        with unittest.mock.patch.object(packet_maker, 'git', self.fake_git(files)), unittest.mock.patch.object(packet_maker, 'preserved_tables', return_value=()), unittest.mock.patch.object(packet_maker, 'check_migration_replay'):
            target = packet_maker.target_schema('c')
            derived = packet_maker.schema_parameters({'COMMIT': 'c', 'TARGET_SCHEMA': target}, {'schema': {'current': len(applied), 'minimumWriter': len(applied)}, 'migrationIds': applied, 'migrationDigests': ['d' + str(index) for index in range(len(applied))], 'migrationNames': ['n' + str(index) for index in range(len(applied))]})
        return target, json.loads(derived['MIGRATION_LEDGER'])

    def test_the_real_replay_check_passes_at_the_repository_head(self):
        packet_maker.check_migration_replay('HEAD')

    def test_the_packet_passes_the_applied_digests_to_the_replay_check(self):
        files = self.LEGACY
        seen = []
        with unittest.mock.patch.object(packet_maker, 'git', self.fake_git(files)), unittest.mock.patch.object(packet_maker, 'preserved_tables', return_value=()), unittest.mock.patch.object(packet_maker, 'check_migration_replay', side_effect=lambda commit, pairs=None: seen.append(pairs)):
            packet_maker.schema_parameters({'COMMIT': 'c', 'TARGET_SCHEMA': 3}, {'schema': {'current': 3, 'minimumWriter': 3}, 'migrationIds': ['0001', '0002', '0003'], 'migrationDigests': ['aa', 'bb', 'cc'], 'migrationNames': ['x', 'y', 'z']})
        self.assertEqual(seen, [['0001:aa:x', '0002:bb:y', '0003:cc:z']])

    def test_a_missing_or_short_digest_list_is_refused_instead_of_skipping_the_check(self):
        base = {'schema': {'current': 3, 'minimumWriter': 3}, 'migrationIds': ['0001', '0002', '0003'], 'migrationNames': ['x', 'y', 'z']}
        with unittest.mock.patch.object(packet_maker, 'git', self.fake_git(self.LEGACY)), unittest.mock.patch.object(packet_maker, 'preserved_tables', return_value=()), unittest.mock.patch.object(packet_maker, 'check_migration_replay'):
            for digests in (None, ['a', 'b'], ['a', 'b', '']):
                state = dict(base)
                if digests is not None:
                    state['migrationDigests'] = digests
                with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_S0_MIGRATION_DIGESTS_INVALID'):
                    packet_maker.schema_parameters({'COMMIT': 'c', 'TARGET_SCHEMA': 3}, state)

    def test_a_missing_or_malformed_name_list_is_refused_instead_of_skipping_the_rename_check(self):
        base = {'schema': {'current': 3, 'minimumWriter': 3}, 'migrationIds': ['0001', '0002', '0003'], 'migrationDigests': ['a', 'b', 'c']}
        with unittest.mock.patch.object(packet_maker, 'git', self.fake_git(self.LEGACY)), unittest.mock.patch.object(packet_maker, 'preserved_tables', return_value=()), unittest.mock.patch.object(packet_maker, 'check_migration_replay'):
            for names in (None, ['x', 'y'], ['x', 'y', ''], ['x', 'y', 'a:b']):
                state = dict(base)
                if names is not None:
                    state['migrationNames'] = names
                with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_S0_MIGRATION_NAMES_INVALID'):
                    packet_maker.schema_parameters({'COMMIT': 'c', 'TARGET_SCHEMA': 3}, state)

    def test_a_commit_whose_migrations_do_not_replay_is_refused(self):
        failed = subprocess.CompletedProcess([], 1, stdout='', stderr='MIGRATION_CONFLICT FULL_REPLAY_FAILS boom')
        with unittest.mock.patch.object(packet_maker.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(packet_maker.PacketError, 'MIGRATION_REPLAY_FAILED'):
                packet_maker.check_migration_replay('c')

    def test_timestamped_files_count_toward_the_target_and_are_planned_by_id(self):
        files = self.LEGACY + ['20261114010000_first.sql', '20261114020000_second.sql', '20261114020000_second.meta.json']
        target, ledger = self.plan(files, ['0001', '0002', '0003'])
        self.assertEqual(target, 5)
        self.assertEqual(ledger, [{'sequence': 4, 'name': 'first', 'phase': 'expand'}, {'sequence': 5, 'name': 'second', 'phase': 'expand'}])

    def test_a_late_merging_smaller_id_is_planned_after_the_ones_already_applied(self):
        files = self.LEGACY + ['20261114010000_first.sql', '20261114020000_second.sql']
        _, ledger = self.plan(files, ['0001', '0002', '0003', '20261114020000'])
        self.assertEqual(ledger, [{'sequence': 5, 'name': 'first', 'phase': 'expand'}])

    def test_unrecognized_files_and_foreign_production_ids_are_refused(self):
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_MIGRATION_FILE_NOT_RECOGNIZED bad_file.sql'):
            self.plan(self.LEGACY + ['bad_file.sql'], ['0001', '0002', '0003'])
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_PRODUCTION_HAS_MIGRATIONS_NOT_IN_COMMIT'):
            self.plan(self.LEGACY + ['20261114010000_first.sql'], ['0001', '0002', '0003', '20261114030000'])

    def test_the_same_count_with_a_different_set_is_refused(self):
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_MIGRATION_COUNT_MISMATCH|PACKET_PRODUCTION_HAS_MIGRATIONS_NOT_IN_COMMIT'):
            self.plan(self.LEGACY + ['20261114010000_first.sql'], ['0001', '0002', '0003', '20261114020000'])

    def test_production_in_sync_with_the_commit_needs_no_migration(self):
        files = self.LEGACY + ['20261114010000_first.sql']
        _, ledger = self.plan(files, ['0001', '0002', '0003', '20261114010000'])
        self.assertEqual(ledger, [])


PACKET_TEMPLATE = HERE / 'packet-template'


def template_definitions(relative, names=None, assignments=()):
    tree = ast.parse((PACKET_TEMPLATE / relative).read_text())
    nodes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and (names is None or node.name in names):
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in assignments for target in node.targets):
            nodes.append(node)
    return nodes


def execute_definitions(relative, nodes, namespace):
    exec(compile(ast.Module(body=nodes, type_ignores=[]), relative, 'exec'), namespace)
    return namespace


def vanishing_walk(vanishing):
    def walk(top, onerror=None, followlinks=False):
        for parent, directories, files in os.walk(top, onerror=onerror, followlinks=followlinks):
            listed = (parent, directories, list(files))
            if vanishing.exists():
                vanishing.unlink()
            yield listed
    return walk


class AcceptanceScratchSamplingTest(unittest.TestCase):
    STAGE = 'acceptance/cloud/run-stage-03.py'

    def sampling_functions(self, walk):
        nodes = template_definitions(self.STAGE, {'file_bytes', 'directory_bytes'})
        self.assertEqual({node.name for node in nodes}, {'file_bytes', 'directory_bytes'})
        namespace = execute_definitions(self.STAGE, nodes, {'Path': Path, 'os': type('FakeOs', (), {'walk': staticmethod(walk)})})
        return namespace['directory_bytes']

    def tally(self):
        return type('Tally', (), {'vanished': 0, 'warnings': None})()

    def test_a_file_removed_between_listing_and_size_read_counts_as_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            kept = Path(directory) / 'kept'
            vanishing = Path(directory) / 'node-compile-cache.tmp'
            kept.write_bytes(b'x' * 7)
            vanishing.write_bytes(b'y' * 11)
            tally = self.tally()
            tally.warnings = []
            self.assertEqual(self.sampling_functions(vanishing_walk(vanishing))(Path(directory), tally), 7)
            self.assertEqual((tally.vanished, tally.warnings), (1, []))

    def test_regression_guard_other_size_read_errors_are_not_counted_as_vanished(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'kept').write_bytes(b'x')
            with unittest.mock.patch.object(Path, 'lstat', side_effect=PermissionError('denied')):
                with self.assertRaises(PermissionError):
                    self.sampling_functions(os.walk)(Path(directory))

    def test_a_directory_that_cannot_be_listed_becomes_a_warning_and_a_vanished_one_is_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'locked').mkdir()
            (root / 'locked' / 'inside').write_bytes(b'z' * 5)
            (root / 'gone').mkdir()
            (root / 'kept').write_bytes(b'x' * 3)
            real_scandir = os.scandir

            def scandir(path):
                if str(path).endswith('locked'):
                    raise PermissionError(13, 'denied', str(path))
                if str(path).endswith('gone'):
                    raise FileNotFoundError(2, 'gone', str(path))
                return real_scandir(path)

            tally = self.tally()
            tally.warnings = []
            with unittest.mock.patch.object(os, 'scandir', side_effect=scandir):
                total = self.sampling_functions(os.walk)(root, tally)
            self.assertEqual(total, 3)
            self.assertEqual(tally.vanished, 1)
            self.assertEqual([(item['phase'], item['type']) for item in tally.warnings], [('listing', 'PermissionError')])

    def stage_context(self, evidence):
        tree = ast.parse((PACKET_TEMPLATE / self.STAGE).read_text())
        definitions = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
        finalizers = [node for node in tree.body if isinstance(node, ast.Try) and any(isinstance(item, ast.Constant) and item.value == 'run-report.json' for statement in node.finalbody for item in ast.walk(statement))]
        self.assertEqual(len(finalizers), 1)
        context = execute_definitions(self.STAGE, definitions, {'__name__': 'stage_fixture', 'evidence': evidence})
        return context, compile(ast.Module(body=finalizers[0].finalbody, type_ignores=[]), self.STAGE, 'exec')

    def test_a_failed_resource_sample_is_a_warning_and_the_run_still_passes_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scratch, evidence = root / 'scratch', root / 'evidence'
            scratch.mkdir(mode=0o700)
            evidence.mkdir(mode=0o700)
            (scratch / 'marker').write_bytes(b'scene')
            helper = root / 'decision.py'
            helper.write_text("import json, sys\nfrom pathlib import Path\narguments = sys.argv[1:]\nevidence = Path(arguments[arguments.index('--evidence') + 1])\n(evidence / 'scratch-cleanup-decision.json').write_text(json.dumps({'deleteAllowed': True}))\n")
            context, finalizer = self.stage_context(evidence)
            resources = context['Resources'](scratch)
            resources.stopping.set()
            resources.thread.start()
            resources.thread.join(timeout=5)
            (evidence / 'resources.jsonl').mkdir()
            info = scratch.lstat()
            record = {'rootFreeBeforeBytes': context['root_free'](), 'scratchCleanupPending': True, 'runnerErrors': [], 'passed': True, 'startedAt': 0.0}
            context.update({'record': record, 'scratch': scratch, 'scratch_identity': (info.st_dev, info.st_ino, info.st_uid), 'resources': resources, 'resources_stopped': False, 'observer': None, 'process': None, 'cleanup_helper': helper, 'registry': evidence / 'owned-processes.json', 'base': root, 'manifest': {'sourceRoot': str(root)}})
            with unittest.mock.patch('sys.stdout', new=__import__('io').StringIO()):
                exec(finalizer, context)
            report = json.loads((evidence / 'run-report.json').read_text())
            self.assertEqual(report['runnerErrors'], [])
            self.assertTrue(report['passed'])
            self.assertFalse(scratch.exists())
            self.assertEqual([item['type'] for item in report['resourceSamplingWarnings']], ['IsADirectoryError'])
            self.assertEqual(report['resourceSamplingVanishedEntries'], 0)
            self.assertNotIn('resourceSamplingErrors', report)

    def test_no_consumer_still_requires_the_removed_sampling_error_field(self):
        readers = [path.relative_to(PACKET_TEMPLATE) for path in PACKET_TEMPLATE.rglob('*') if path.is_file() and 'basis-04' not in path.parts and path.suffix in ('.py', '.mjs', '.sh') and 'resourceSamplingErrors' in path.read_text()]
        self.assertEqual(readers, [])
        self.assertIn("'resourceSamplingWarnings': resources.warnings", (PACKET_TEMPLATE / self.STAGE).read_text())


class ServiceProbeSamplingTest(unittest.TestCase):
    PROBE = 'measurement/probe/run-service-probe.py'

    def probe(self, walk, scratch, evidence):
        nodes = template_definitions(self.PROBE)
        fake_os = type('FakeOs', (), {'walk': staticmethod(walk)})
        record = {'errors': [], 'resourceSamplingWarnings': []}
        return execute_definitions(self.PROBE, nodes, {'Path': Path, 'os': fake_os, 'shutil': shutil, 'json': json, 'time': __import__('time'), 'scratch': scratch, 'evidence': evidence, 'record': record, 'peak': 0, 'lowest': 1 << 62})

    def test_a_scratch_file_removed_mid_walk_counts_as_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            scratch, evidence = Path(directory) / 'scratch', Path(directory) / 'evidence'
            scratch.mkdir()
            evidence.mkdir()
            (scratch / 'kept').write_bytes(b'x' * 7)
            vanishing = scratch / 'node-compile-cache.tmp'
            vanishing.write_bytes(b'y' * 11)
            namespace = self.probe(vanishing_walk(vanishing), scratch, evidence)
            namespace['sample']()
            self.assertEqual(json.loads((evidence / 'resources.jsonl').read_text())['scratchBytes'], 7)
            self.assertEqual(namespace['peak'], 7)

    def test_a_failed_sample_is_a_warning_not_a_run_error(self):
        with tempfile.TemporaryDirectory() as directory:
            scratch, evidence = Path(directory) / 'scratch', Path(directory) / 'evidence'
            scratch.mkdir()
            evidence.mkdir()
            (evidence / 'resources.jsonl').mkdir()
            namespace = self.probe(os.walk, scratch, evidence)
            namespace['sample_or_warn']()
            self.assertEqual(namespace['record']['errors'], [])
            self.assertEqual([item['type'] for item in namespace['record']['resourceSamplingWarnings']], ['IsADirectoryError'])


class ScratchRegistrationPollTest(unittest.TestCase):
    def test_a_process_dying_while_its_stat_is_read_is_skipped(self):
        helper = 'acceptance/helpers/check-p5-scratch-cleanup.py'
        entries = [type('Entry', (), {'name': name})() for name in ['self', '10', '11', '12', '13']]
        proc = type('Proc', (), {'iterdir': lambda self: iter(entries)})()
        fake_pathlib = type('FakePathlib', (), {'Path': staticmethod(lambda value: proc)})

        def process_identity(pid):
            if pid == 11:
                raise RuntimeError('P5_PROC_STAT_INVALID')
            if pid == 12:
                raise ValueError("invalid literal for int() with base 10: ''")
            if pid == 13:
                raise FileNotFoundError(pid)
            return {'pid': pid, 'startTime': 1}

        namespace = execute_definitions(helper, template_definitions(helper, {'identities_now'}), {'pathlib': fake_pathlib, 'process_identity': process_identity})
        self.assertEqual(namespace['identities_now'](), {10: {'pid': 10, 'startTime': 1}})

    def test_the_cleanup_inspection_still_fails_on_an_unreadable_process(self):
        source = (PACKET_TEMPLATE / 'acceptance/helpers/check-p5-scratch-cleanup.py').read_text()
        self.assertEqual(source.count('except (FileNotFoundError, ProcessLookupError, RuntimeError, ValueError):'), 1)
        self.assertIn('raise RuntimeError("P5_CLEANUP_PROCESS_IDENTITY_CHANGED")', source)


class ServiceReadCgroupTest(unittest.TestCase):
    def test_a_cgroup_file_removed_before_reading_means_no_remaining_processes(self):
        relative = 'measurement/S6-service-read.py'
        namespace = execute_definitions(relative, template_definitions(relative, {'cgroup_pids'}), {})
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(namespace['cgroup_pids'](Path(directory) / 'cgroup.procs'), [])
            present = Path(directory) / 'present.procs'
            present.write_text('101\n102\n')
            self.assertEqual(namespace['cgroup_pids'](present), ['101', '102'])
        self.assertIn('remaining = cgroup_pids(pids)', (PACKET_TEMPLATE / relative).read_text())


class QuestionTwelveDownloadRetryTest(unittest.TestCase):
    RELATIVE = 'acceptance/cloud/download-question-12.py'

    def retrying(self, outcomes):
        import socket
        import urllib.error
        calls, sleeps = [], []

        def download(url, limit):
            calls.append(url)
            outcome = outcomes[len(calls) - 1]
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        nodes = template_definitions(self.RELATIVE, {'transient', 'download_with_retry'}, assignments={'RETRY_DELAYS_SECONDS'})
        namespace = execute_definitions(self.RELATIVE, nodes, {'urllib': urllib, 'socket': socket, 'time': __import__('time'), 'report': {}, 'download': download})
        call = lambda: namespace['download_with_retry']('https://example.invalid/a', 10, sleep=sleeps.append)
        return call, calls, sleeps, namespace['report']

    def http_error(self, code):
        import urllib.error
        return urllib.error.HTTPError('https://example.invalid/a', code, 'status', {}, None)

    def test_transient_outside_errors_are_retried_with_short_backoff(self):
        import socket
        import urllib.error
        call, calls, sleeps, report = self.retrying([self.http_error(503), urllib.error.URLError(socket.gaierror(-3, 'Temporary failure in name resolution')), b'data'])
        self.assertEqual(call(), b'data')
        self.assertEqual((len(calls), sleeps), (3, [1, 3]))
        self.assertEqual([item['type'] for item in report['downloadRetries']], ['HTTPError', 'URLError'])
        call, calls, sleeps, report = self.retrying([ConnectionResetError(104, 'reset'), TimeoutError('timed out'), b'data'])
        self.assertEqual((call(), len(calls)), (b'data', 3))

    def test_three_transient_failures_give_up(self):
        call, calls, sleeps, report = self.retrying([self.http_error(502), self.http_error(503), self.http_error(504)])
        with self.assertRaises(Exception) as raised:
            call()
        self.assertEqual((raised.exception.code, len(calls), sleeps), (504, 3, [1, 3]))

    def test_policy_and_client_results_are_checked_once(self):
        for outcome in [RuntimeError('DOWNLOAD_REDIRECT_NOT_APPROVED'), RuntimeError('DOWNLOAD_SIZE_EXCEEDED'), self.http_error(403), self.http_error(404)]:
            call, calls, sleeps, report = self.retrying([outcome, b'data'])
            with self.assertRaises(type(outcome)):
                call()
            self.assertEqual((len(calls), sleeps, report), (1, [], {}))


class AuthorizedNetworkRetryTest(unittest.TestCase):
    SOURCE = PACKET_TEMPLATE / 'acceptance/cloud/adapters/probe-authorized-network.mjs'

    def curl_flags(self):
        found = re.findall(r'const curl = `/usr/bin/curl ([^`$]*?) --cacert ', self.SOURCE.read_text())
        self.assertEqual(len(found), 1)
        return shlex.split(found[0])

    def test_the_adaptation_manifest_names_the_retry_flags_the_adapter_uses(self):
        manifest = (PACKET_TEMPLATE / 'acceptance/cloud/adaptation-manifest.json').read_text()
        entry = manifest.split('"adapter": "adapters/probe-authorized-network.mjs"', 1)[1].split('"timingChanges"', 1)[0]
        source = self.SOURCE.read_text()
        for flag in ('--retry 2', '--fetch-retries=2', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=3000'):
            self.assertIn(flag, source)
            self.assertIn(flag, entry)

    def test_curl_retries_only_transient_results_and_never_an_allowlist_block(self):
        flags = self.curl_flags()
        self.assertIn('--retry', flags)
        self.assertNotIn('--retry-all-errors', flags)
        self.assertNotIn('--retry-connrefused', flags)
        curl = shutil.which('curl')
        if curl is None:
            self.skipTest('curl not installed')
        import socketserver
        import threading
        counts = {'get': 0, 'connect': 0}

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                line = self.rfile.readline().decode()
                while self.rfile.readline() not in (b'\r\n', b''):
                    pass
                if line.startswith('CONNECT'):
                    counts['connect'] += 1
                    self.wfile.write(b'HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-allowlist\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                    return
                counts['get'] += 1
                status = b'503 Service Unavailable' if counts['get'] == 1 else b'200 OK'
                self.wfile.write(b'HTTP/1.1 ' + status + b'\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')

        server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            proxy = 'http://127.0.0.1:' + str(server.server_address[1])
            environment = {key: value for key, value in os.environ.items() if 'proxy' not in key.lower()}
            transient = subprocess.run([curl, *flags, '-x', proxy, 'http://registry.invalid/is-number'], capture_output=True, text=True, env=environment, timeout=60)
            self.assertEqual((transient.returncode, transient.stdout, counts['get']), (0, 'ok', 2))
            blocked = subprocess.run([curl, *flags, '-x', proxy, '-D', '/dev/stdout', 'https://example.com/'], capture_output=True, text=True, env=environment, timeout=60)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn('blocked-by-allowlist', blocked.stdout)
            self.assertEqual(counts['connect'], 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_npm_install_retries_transient_fetch_failures(self):
        source = self.SOURCE.read_text()
        self.assertNotIn('--fetch-retries=0', source)
        self.assertIn('--fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000', source)


class MaintenanceSpaceSamplingTest(unittest.TestCase):
    def test_space_sampling_problems_are_recorded_not_fatal(self):
        source = (PACKET_TEMPLATE / 'maintenance/maintenance-common.mjs').read_text()
        self.assertNotIn('MAINTENANCE_SPACE_SAMPLING_FAILED', source)
        self.assertNotIn('MAINTENANCE_SPACE_SAMPLER_NOT_READY', source)
        self.assertIn('spaceSamplingWarnings: spaceSamplingWarnings(samplerFailure, sampled)', source)


class StartupFailureEventTest(unittest.TestCase):
    RELATIVE = 'systemd/S7-switch-start-readback.py'

    def failure_events(self):
        nodes = template_definitions(self.RELATIVE, {'startup_failure_events'}, assignments={'STARTUP_FAILURE_TERMS', 'STARTUP_NON_FATAL_EVENTS'})
        return execute_definitions(self.RELATIVE, nodes, {})['startup_failure_events']

    def test_a_retrying_diagnostic_does_not_fail_the_switch(self):
        messages = [
            {'component': 'agent-service', 'event': 'memory.embedding_catch_up_failed', 'code': 'EMBEDDING_LOCAL_UNAVAILABLE', 'retryInMs': '30000'},
            {'component': 'agent-service', 'event': 'service.ready'},
            'plain text',
        ]
        self.assertEqual(self.failure_events()(messages), [])

    def test_fatal_startup_events_still_fail_the_switch(self):
        messages = [{'event': name} for name in ['pair.child_exit', 'pair.child_error', 'sandbox_runtime.content_audit_retryable', 'sandbox_runtime.content_audit_failed', 'service.failed', 'authority.lost', 'sandbox.srt_prewarm.failed']]
        self.assertEqual(self.failure_events()(messages), [message['event'] for message in messages])

    def test_an_unlisted_failure_event_fails_the_switch_even_when_it_says_it_will_retry(self):
        self.assertEqual(self.failure_events()([{'component': 'agent-service', 'event': 'future.sync_failed', 'retryInMs': '1000'}]), ['future.sync_failed'])

    def test_the_switch_loop_uses_the_shared_matcher(self):
        source = (PACKET_TEMPLATE / self.RELATIVE).read_text()
        self.assertIn('failure_events = startup_failure_events(messages)', source)
        self.assertIn('assert.deepEqual(startupFailureEvents(records), [], ', (PACKET_TEMPLATE / 'systemd/S7-startup-readback.mjs').read_text())


class ProductionStartupBudgetTest(unittest.TestCase):
    def test_production_budget_has_headroom_over_measured_starts_and_fits_the_waits(self):
        worker = (HERE.parent.parent / packet_maker.WORKER_SERVICE_MAIN).read_text()
        budget_ms = packet_maker.startup_ready_budget(INSTANCE, worker)
        self.assertGreaterEqual(budget_ms, 2 * 37700)
        switch = (PACKET_TEMPLATE / 'systemd/S7-switch-start-readback.py').read_text()
        deadlines = re.findall(r'deadline = time\.monotonic\(\) \+ ([0-9]+)\n', switch)
        self.assertEqual(len(deadlines), 1)
        self.assertGreater(int(deadlines[0]) * 1000, budget_ms + INSTANCE['startupReadyMarginSeconds'] * 1000)


if __name__ == '__main__':
    unittest.main()
