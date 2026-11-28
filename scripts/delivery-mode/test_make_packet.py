import argparse
import threading
import ast
import copy
import hashlib
import importlib.util
import json
import os
import pwd
import re
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
FIXTURES = HERE / 'fixtures'
TWELFTH = json.loads((FIXTURES / 'twelfth-parameters.json').read_text())
TWELFTH_FROZEN = json.loads((FIXTURES / 'twelfth-frozen-sha256.json').read_text())
TWELFTH_COMMIT = TWELFTH['COMMIT']
MEMORY_PAGE_COMMIT = '4ca2d24c4af3dba5868a1d18ea882b371462845b'
ADDED_FILES = {'install/source-cache.mjs', 'install/verify-source-cache-fixtures.mjs', 'maintenance/verify-migrate-fixtures.mjs', 'measurement/verify-s6-report-contract.py', 'systemd/verify-startup-readiness-fixtures.mjs'}
RENAMED_FILES = {'systemd/fixtures/verify-doctor-fixtures.mjs': 'systemd/fixtures/verify-doctor.test.mjs'}
INTENDED_CHANGES = {
    'measurement/probe/read-driver.mjs', 'signing/verify-finalize-capability-check.py', 'acceptance/cloud/adapters/probe-public-search.mjs', 'acceptance/cloud/adapters/probe-linux-worker-loss.mjs',
    'acceptance/cloud/probe-source/packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs', 'acceptance/cloud/probe-source/packages/runtime-sandbox/scripts/probe-authorized-network.mjs', 'acceptance/cloud/probe-source/packages/runtime-sandbox/scripts/probe-network-boundary.mjs', 'acceptance/cloud/probe-source/packages/runtime-sandbox/scripts/probe-public-search.mjs',
    'acceptance/helpers/collect-installer-dependencies.mjs', 'install/collect-installer-dependencies.mjs', 'steps/transport-packet.py', 'steps/packet-common.py',
    'systemd/run-user-s7.sh', 'signing/sign-twelfth.sh', 'steps/run-user-step.sh', 'signing/prepare-twelfth-snapshot.sh', 'maintenance/run-user-maintenance.sh', 'maintenance/run-user-control-rollback.sh',
    'acceptance/OWNED-SHA256SUMS', 'acceptance/S6-limited-host-acceptance.sh', 'acceptance/cloud/adaptation-manifest.json',
    'acceptance/cloud/adapters/probe-authorized-network.mjs', 'acceptance/cloud/adapters/probe-foreground.mjs', 'acceptance/cloud/adapters/probe-network-boundary.mjs', 'acceptance/cloud/probe-source/packages/runtime-pi/scripts/probe-foreground.mjs', 'acceptance/cloud/cloud-inputs.draft.json',
    'acceptance/cloud/run-cloud-acceptance.sh', 'acceptance/cloud/run-stage-03.py', 'acceptance/cloud/run-question12-downloads.sh', 'inputs/bindings.draft.json',
    'inputs/check-packet-consistency.py', 'inputs/verify-packet-consistency.py', 'inputs/finalize-bindings.py', 'install/twelfth-artifact-install.mjs', 'install/verify-s9-clean-transport-fixtures.py', 'install/P5-new-prefix.md', 'inputs/verify-finalize-bindings.py', 'maintenance/OWNED-SHA256SUMS', 'maintenance/P-readback-design.md', 'maintenance/S9-control-files.py', 'maintenance/maintenance-common.mjs',
    'maintenance/production-shape-config-template.json', 'acceptance/cloud/download-question-12.py', 'acceptance/cloud/adapters/failure-scene.py', 'acceptance/cloud/verify-failure-scene-fixtures.py',
    'acceptance/helpers/test-resource-retention.py', 'acceptance/helpers/check-p5-scratch-cleanup.py', 'measurement/probe/run-service-probe.py', 'install/S9-clean-transport.py', 'signing/finalize-binding-inputs.py', 'signing/workspace-grant-binding.py',
    'maintenance/raw-copy-recovery.mjs', 'maintenance/run-maintenance.mjs', 'maintenance/verify-fixtures.mjs', 'measurement/OWNED-SHA256SUMS', 'measurement/S6-service-read.py', 'measurement/probe/bootstrap.mjs', 's0-db/read-s0-db.mjs',
    'signing/cloud-protected-prepare.mjs', 'signing/cloud-seal.mjs', 'signing/publish-runtime-protection.mjs', 'steps/README.md', 'steps/run-local-step.py', 'steps/run-step.py', 'steps/verify-steps.py', 'systemd/OWNED-SHA256SUMS', 'systemd/P9-switch-start-readback.md',
    's0-db/verify-catalog-runtime-switch.mjs', 'signing/cloud-capability-manifest.mjs', 'signing/verify-capability-manifest.mjs',
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
        'machine': 'x86_64',
        'serviceUid': 999,
        'serviceGid': 988,
        'nodeSha256': 'e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2',
        'systemBwrapSha256': 'e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71',
        'signerKeys': ['/var/lib/himawari/qualification/first-20261007/host-qualification-public-key.pem'],
        'active': 'active',
        'execStart': ['ExecStart=/opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/' + running + '-' + compact + '/pair-supervisor.mjs --prefix ' + prefix + ' --config /etc/himawari/config.json --worker-token-file /var/lib/himawari/state/secrets/worker-token.json'],
        'staticRoot': prefix + '/share/control-center',
        'modelCount': 1,
        'primaryClassifications': [['public', 'private', 'sensitive']],
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
        self.assertEqual(packet_maker.next_label('firstinstall'), 'first')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_LABEL_NOT_DERIVABLE'):
            packet_maker.next_label('hotfix')

    def test_discovery_derives_the_running_release_and_the_next_label(self):
        derived = packet_maker.interpret_discovery(production_facts(), INSTANCE)
        self.assertEqual(derived['LABEL'], 'twelfth')
        for key in ('OLD_PREFIX', 'OLD_OPERATIONS', 'OLD_QUALIFICATION', 'ORIGINAL_CONTEXT_WINDOW', 'ORIGINAL_MAX_TOKENS', 'ORIGINAL_PUBLIC_FETCH_BYTES'):
            self.assertEqual(derived[key], TWELFTH[key], key)

    def test_discovery_refuses_a_production_state_the_template_does_not_fit(self):
        cases = [
            ({'active': 'failed'}, 'PACKET_SERVICE_NOT_ACTIVE'),
            ({'staticRoot': '/opt/himawari/releases/2026-10-20-tenth/share/control-center'}, 'PACKET_STATIC_ROOT_NOT_RUNNING_RELEASE'),
            ({'budgetsPresent': True}, 'PACKET_CONFIG_BUDGETS_PRESENT'),
            ({'model': None, 'modelCount': 0}, 'PACKET_CONFIG_MODEL_LIMITS_NOT_READABLE'),
            ({'primaryClassifications': [['public', 'private']]}, 'PACKET_PRIMARY_MODEL_CANNOT_SEE_SENSITIVE'),
            ({'primaryClassifications': []}, 'PACKET_PRIMARY_MODEL_CANNOT_SEE_SENSITIVE'),
            ({'newPathsExist': ['/opt/himawari/releases/2026-10-26-twelfth']}, 'PACKET_TARGET_PATHS_EXIST'),
            ({'execStart': ['ExecStart=/usr/bin/node /srv/other.mjs']}, 'PACKET_RUNNING_UNIT_NOT_RECOGNIZED'),
        ]
        cases += [
            ({'machine': 'riscv64'}, 'PACKET_ARCHITECTURE_UNSUPPORTED'),
            ({'serviceUid': None}, 'PACKET_SERVICE_ACCOUNT_NOT_READABLE'),
            ({'serviceGid': 0}, 'PACKET_SERVICE_ACCOUNT_NOT_READABLE'),
            ({'nodeSha256': 'abc'}, 'PACKET_NODE_DIGEST_NOT_READABLE'),
            ({'systemBwrapSha256': None}, 'PACKET_SYSTEM_BWRAP_NOT_READABLE'),
            ({'signerKeys': []}, 'PACKET_FIRST_SIGNER_KEY_NOT_FOUND'),
            ({'hostname': ''}, 'PACKET_HOSTNAME_NOT_READABLE'),
        ]
        for changes, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(packet_maker.PacketError, code):
                packet_maker.interpret_discovery(production_facts(**changes), INSTANCE)

    def test_machine_facts_come_from_the_target_not_the_instance_file(self):
        for key in ('serviceUid', 'serviceGid'):
            self.assertNotIn(key, INSTANCE['fixedByTemplate'])
        self.assertNotIn('address', INSTANCE['host'])
        arm = production_facts(hostname='tokyo-a1', machine='aarch64', serviceUid=1001, serviceGid=1002, nodeSha256='a' * 64, signerKeys=['/var/lib/himawari/qualification/zeroth-20261101/host-qualification-public-key.pem'])
        derived = packet_maker.interpret_discovery(arm, INSTANCE)
        self.assertEqual({key: derived[key] for key in ('HOSTNAME', 'NODE_ARCH', 'SERVICE_UID', 'SERVICE_GID', 'NODE_SHA256', 'FIRST_SIGNER_KEY_PATH')}, {'HOSTNAME': 'tokyo-a1', 'NODE_ARCH': 'arm64', 'SERVICE_UID': 1001, 'SERVICE_GID': 1002, 'NODE_SHA256': 'a' * 64, 'FIRST_SIGNER_KEY_PATH': '/var/lib/himawari/qualification/zeroth-20261101/host-qualification-public-key.pem'})

    def test_the_target_address_comes_from_the_command_line_or_the_environment(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('HIMAWARI_PACKET_HOST', None)
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HOST_UNKNOWN'):
                packet_maker.load_instance('andy-production')
            self.assertEqual(packet_maker.load_instance('andy-production', '203.0.113.7')['host']['address'], '203.0.113.7')
            os.environ['HIMAWARI_PACKET_HOST'] = '198.51.100.9'
            self.assertEqual(packet_maker.load_instance('andy-production')['host']['address'], '198.51.100.9')
            self.assertEqual(packet_maker.load_instance('andy-production', '203.0.113.7')['host']['address'], '203.0.113.7')
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HOST_UNKNOWN'):
                packet_maker.load_instance('andy-production', 'root@host; rm -rf /')

    def test_fd_pins_follow_the_target_architecture(self):
        x64, arm = packet_maker.fd_parameters('x64'), packet_maker.fd_parameters('arm64')
        self.assertEqual(x64, {key: TWELFTH[key] for key in ('FD_TRIPLE', 'FD_ARCHIVE_SHA256', 'FD_BINARY_SHA256')})
        self.assertEqual(arm['FD_TRIPLE'], 'aarch64-unknown-linux-musl')
        self.assertNotEqual(arm['FD_ARCHIVE_SHA256'], x64['FD_ARCHIVE_SHA256'])
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_FD_NOT_PINNED'):
            packet_maker.fd_parameters('riscv64')

    def test_first_tools_mode_follows_the_missing_capability_deployment(self):
        installed = packet_maker.interpret_discovery(production_facts(capabilityDeploymentPresent=True), INSTANCE)
        self.assertEqual((installed['FIRST_TOOLS'], installed['NEW_CAPABILITY_REFS_JSON']), ('0', '[]'))
        fresh = packet_maker.interpret_discovery(production_facts(capabilityDeploymentPresent=False), INSTANCE)
        self.assertEqual(fresh['FIRST_TOOLS'], '1')
        self.assertEqual(json.loads(fresh['NEW_CAPABILITY_REFS_JSON']), ['himawari.pi-coding', 'himawari.public-search', 'himawari.public-fetch'])

    FIRST_TOOLS_REFS = ['himawari.pi-coding', 'himawari.public-fetch', 'himawari.public-search']
    SWITCH_FILES = ('systemd/S2-stop-and-inspect.py', 'systemd/S7-startup-readback.mjs', 'systemd/S7-switch-start-readback.py', 'install/S9-clean-transport.py')
    UPGRADE_SWITCH_SHA256 = {
    'systemd/S2-stop-and-inspect.py': '9cbe8623fd17f45312d9e0eb6c0f4773072cf553128d4ccaa395803ba4181389',
    'systemd/S7-startup-readback.mjs': '80e880d599317d208c4300bbfbcb255cb8ecb098cfa0e4bfa5282149b990200c',
    'systemd/S7-switch-start-readback.py': 'b154d5b181215b884e3011797f7d3127c101a3c9db415d242ff46ee037c1fdc9',
    'install/S9-clean-transport.py': '235a7d2882edaa304097746315a4be7f5c5f467fea83cd1522a43a1e3b223533',    }

    def render_first_tools(self):
        return self.render(FIRST_TOOLS='1', NEW_CAPABILITY_REFS_JSON=json.dumps(self.FIRST_TOOLS_REFS, separators=(',', ':')))

    def test_upgrade_switch_and_readback_scripts_render_unchanged(self):
        packet = self.render()
        for name, expected in self.UPGRADE_SWITCH_SHA256.items():
            self.assertEqual(hashlib.sha256((packet / name).read_bytes()).hexdigest(), expected, name)
            self.assertNotIn('__PKT_WHEN', (packet / name).read_text())

    def test_first_tools_switch_and_readback_scripts_handle_a_host_with_no_tools(self):
        packet = self.render_first_tools()
        stop = (packet / 'systemd/S2-stop-and-inspect.py').read_text()
        self.assertIn('S2_FIRST_TOOLS_HOST_ALREADY_HAS_TOOLS', stop)
        self.assertNotIn("original-capability-deployment.json", stop)
        self.assertNotIn("original-startup-attestation.json", stop)
        self.assertNotIn("original-prepare-helper.mjs", stop)
        self.assertNotIn('S2_OLD_QUALIFICATION_RECEIPT_MISSING', stop)
        switch = (packet / 'systemd/S7-switch-start-readback.py').read_text()
        self.assertIn("new_refs = sorted(" + json.dumps(self.FIRST_TOOLS_REFS, separators=(',', ':')) + ")", switch)
        self.assertNotIn("original_configuration['capabilityDeployment']", switch)
        self.assertIn('STARTUP_FIRST_TOOLS_SET_CHANGED', (packet / 'systemd/S7-startup-readback.mjs').read_text())
        self.assertIn('TRANSPORT_FIRST_TOOLS_SET_CHANGED', (packet / 'install/S9-clean-transport.py').read_text())
        for name in self.SWITCH_FILES:
            self.assertNotEqual(hashlib.sha256((packet / name).read_bytes()).hexdigest(), self.UPGRADE_SWITCH_SHA256[name], name)
            self.assertNotIn('__PKT_', (packet / name).read_text())
        for name in ('systemd/S2-stop-and-inspect.py', 'systemd/S7-switch-start-readback.py', 'install/S9-clean-transport.py'):
            compile((packet / name).read_text(), name, 'exec')
        node = subprocess.run(['node', '--check', str(packet / 'systemd/S7-startup-readback.mjs')], capture_output=True, text=True, check=False)
        self.assertEqual(node.returncode, 0, node.stderr)

    def test_condition_blocks_are_balanced_and_not_nested(self):
        parameters = {'FIRST_TOOLS': '1'}
        self.assertEqual(packet_maker.select_conditional_blocks('a\n__PKT_WHEN_FIRST_TOOLS__\nb\n__PKT_OTHERWISE__\nc\n__PKT_END_WHEN__\nd\n', parameters, 'x'), 'a\nb\nd\n')
        self.assertEqual(packet_maker.select_conditional_blocks('a\n__PKT_WHEN_FIRST_TOOLS__\nb\n__PKT_OTHERWISE__\nc\n__PKT_END_WHEN__\nd\n', {'FIRST_TOOLS': '0'}, 'x'), 'a\nc\nd\n')
        for broken in ('__PKT_WHEN_FIRST_TOOLS__\nb\n', '__PKT_END_WHEN__\n', '__PKT_WHEN_FIRST_TOOLS__\n__PKT_WHEN_FIRST_TOOLS__\n__PKT_END_WHEN__\n__PKT_END_WHEN__\n'):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_CONDITION'):
                packet_maker.select_conditional_blocks(broken, parameters, 'x')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_PARAMETER_MISSING'):
            packet_maker.select_conditional_blocks('__PKT_WHEN_NOPE__\n__PKT_END_WHEN__\n', parameters, 'x')

    def test_a_unit_written_by_first_install_is_recognized(self):
        prefix = '/opt/himawari/releases/2026-11-25-0a1b2c3d'
        facts = production_facts(
            execStart=['ExecStart=/opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/first-install/pair-supervisor.mjs --prefix ' + prefix + ' --config /etc/himawari/config.json --worker-token-file /var/lib/himawari/state/secrets/worker-token.json'],
            staticRoot=prefix + '/share/control-center',
        )
        derived = packet_maker.interpret_discovery(facts, INSTANCE, 'twelfth')
        self.assertEqual((derived['OLD_LABEL'], derived['OLD_PREFIX'], derived['OLD_OPERATIONS']), ('firstinstall', prefix, '/opt/himawari/operations/first-install'))
        self.assertEqual(packet_maker.interpret_discovery(facts, INSTANCE)['LABEL'], 'first')

    def test_an_expected_hostname_pinned_in_the_instance_is_still_enforced(self):
        pinned = {**INSTANCE, 'host': {**INSTANCE['host'], 'expectedHostname': 'hermes-home'}}
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HOST_UNEXPECTED'):
            packet_maker.interpret_discovery(production_facts(), pinned)

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

    def test_the_instance_file_cannot_switch_history_comparison_off(self):
        self.assertNotIn('historyComparison', INSTANCE)
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HISTORY_COMPARISON_SWITCH_REMOVED'):
            packet_maker.base_parameters({**INSTANCE, 'historyComparison': {'mode': 'off'}}, TWELFTH_COMMIT, '2026-11-15', {'LABEL': 'thirtieth'})

    def test_andy_production_rolls_a_failed_deploy_back_and_keep_stays_available(self):
        self.assertEqual(packet_maker.deploy_failure_choice(INSTANCE), 'rollback')
        self.assertEqual(packet_maker.deploy_failure_choice({}), 'rollback')
        self.assertEqual(packet_maker.deploy_failure_choice({'onDeployFailure': 'keep'}), 'keep')
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_ON_DEPLOY_FAILURE_INVALID'):
            packet_maker.deploy_failure_choice({'onDeployFailure': 'ignore'})

    def test_material_cache_settings_come_from_the_instance_file(self):
        self.assertEqual(json.loads(packet_maker.material_cache(INSTANCE)), INSTANCE['materialCache'])
        self.assertEqual(json.loads(packet_maker.material_cache({'materialCache': {'minBytes': 5, 'maxBytes': 9}})), {'minBytes': 5, 'maxBytes': 9})
        self.assertIsNone(json.loads(packet_maker.material_cache({})))
        for broken in ({'minBytes': 0, 'maxBytes': 9}, {'minBytes': 10, 'maxBytes': 9}, {'minBytes': '1', 'maxBytes': 9}, {'minBytes': 1}, {'minBytes': 1, 'maxBytes': 9, 'path': '/tmp'}, 'on'):
            with self.subTest(broken=broken), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_MATERIAL_CACHE_INVALID'):
                packet_maker.material_cache({'materialCache': broken})

    def test_history_is_compared_only_while_the_service_is_stopped(self):
        packet = self.render()
        runner = (packet / 'maintenance' / 'run-maintenance.mjs').read_text()
        common = (packet / 'maintenance' / 'maintenance-common.mjs').read_text()
        for gone in ('compareHistoryRows', 'verifyHistoryAgainstRecoveryPoint', 'startupRecoveryColumns', 'historyComparison', 'HISTORY_COMPARISON'):
            self.assertNotIn(gone, runner + common)
        s8 = runner[runner.index('action === "S8_READBACK"'):runner.index('action === "S9_SIDECAR_TIDY"')]
        history_lines = [line.strip() for line in s8.splitlines() if 'istory' in line]
        self.assertEqual(len(history_lines), 1, history_lines)
        self.assertIn('jsonFile(`${evidenceRoot}/s3-copy-after', history_lines[0])
        self.assertIn('s7-catalog-after', history_lines[0])
        switch = (packet / 'systemd' / 'S7-switch-start-readback.py').read_text()
        self.assertIn("if upgraded_state['history'] != state['history']:", switch)
        self.assertNotIn('history_comparison', switch)
        restore = runner[runner.index('const reference = retained.reference;'):]
        self.assertTrue(restore.splitlines()[1].strip().startswith('verifyHistoryUnchanged(reference, state)'))

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

    SPEECH_TARGET = {'adapter': 'dashscope-qwen-tts', 'magpieModelRef': 'deepseek-primary', 'provider': 'dashscope-intl', 'model': 'qwen3-tts-flash', 'voice': 'Serena', 'languageType': 'Chinese', 'firstAudioTimeoutMs': 1500, 'maximumCharacters': 600}

    def test_an_approved_speech_target_adds_only_the_speech_section(self):
        packet = self.render(TARGET_SPEECH_JSON=packet_maker.speech_target(self.SPEECH_TARGET))
        original = production_config(TWELFTH['OLD_PREFIX'], TWELFTH['ORIGINAL_PUBLIC_FETCH_BYTES'], TWELFTH['ORIGINAL_CONTEXT_WINDOW'], TWELFTH['ORIGINAL_MAX_TOKENS'])
        switched = static_root_configuration(packet)(copy.deepcopy(original))
        self.assertEqual(switched['speech'], self.SPEECH_TARGET)
        self.assertEqual({key: value for key, value in switched.items() if key not in ('speech', 'http', 'runPolicy', 'modelDescriptors')}, {key: value for key, value in original.items() if key not in ('http', 'runPolicy', 'modelDescriptors')})
        replaced = static_root_configuration(packet)({**copy.deepcopy(original), 'speech': {**self.SPEECH_TARGET, 'voice': 'Cherry'}})
        self.assertEqual(replaced['speech'], self.SPEECH_TARGET)
        fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)
        self.assertNotIn('speech', static_root_configuration(self.render())(copy.deepcopy(original)))

    COMPUTERS_TARGET = {'browser': {'maxOutputBytes': 8388608, 'maxTextChars': 20000, 'responseReserveMs': 5000}}

    def test_a_computers_target_turns_on_user_computers_and_the_browser_only(self):
        additions = json.loads(packet_maker.run_policy_target(self.COMPUTERS_TARGET))
        socket_path = json.loads((HERE.parent.parent / 'scripts/operations/computers/settings.json').read_text())['paths']['socket']
        self.assertEqual(additions, {'userComputers': {'socketPath': socket_path}, 'browser': self.COMPUTERS_TARGET['browser']})
        packet = self.render(TARGET_RUN_POLICY_JSON=packet_maker.run_policy_target(self.COMPUTERS_TARGET))
        original = production_config(TWELFTH['OLD_PREFIX'], TWELFTH['ORIGINAL_PUBLIC_FETCH_BYTES'], TWELFTH['ORIGINAL_CONTEXT_WINDOW'], TWELFTH['ORIGINAL_MAX_TOKENS'])
        switched = static_root_configuration(packet)(copy.deepcopy(original))
        self.assertEqual(switched['runPolicy']['userComputers'], additions['userComputers'])
        self.assertEqual(switched['runPolicy']['browser'], additions['browser'])
        self.assertEqual({key: value for key, value in switched['runPolicy'].items() if key not in ('userComputers', 'browser', 'publicFetch')}, {key: value for key, value in original['runPolicy'].items() if key != 'publicFetch'})
        fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)
        self.assertNotIn('userComputers', static_root_configuration(self.render())(copy.deepcopy(original))['runPolicy'])

    def test_a_computers_target_outside_the_supported_shape_is_refused(self):
        self.assertEqual(packet_maker.run_policy_target(None), '{}')
        browser = self.COMPUTERS_TARGET['browser']
        for candidate in (
            'computers', {}, {'browser': browser, 'socketPath': '/tmp/x'}, {'browser': {**browser, 'extra': 1}},
            {'browser': {key: value for key, value in browser.items() if key != 'maxTextChars'}},
            {'browser': {**browser, 'maxOutputBytes': -1}}, {'browser': {**browser, 'maxTextChars': 1.5}}, {'browser': {**browser, 'responseReserveMs': True}},
        ):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_COMPUTERS_TARGET_INVALID'):
                packet_maker.run_policy_target(candidate)

    APP_CONNECTIONS_TARGET = [{'name': 'github', 'title': 'GitHub', 'serverUrl': 'https://api.githubcopilot.com/mcp/', 'clientId': 'Iv23fixture', 'clientSecret': {'ref': 'github-app-client', 'version': 'v1'}, 'trustsReadOnlyLabels': True}]
    APP_CONNECTION_SECRET = {'ref': 'github-app-client', 'version': 'v1', 'purpose': 'app-connection-client', 'scope': 'agent'}

    def test_an_app_connections_target_adds_the_connection_and_its_secret_reference_only(self):
        additions = json.loads(packet_maker.run_policy_target(self.COMPUTERS_TARGET, self.APP_CONNECTIONS_TARGET))
        self.assertEqual(additions['appConnections'], [{'name': 'github', 'title': 'GitHub', 'serverUrl': 'https://api.githubcopilot.com/mcp/', 'clientId': 'Iv23fixture', 'clientSecretRef': 'github-app-client', 'trustsReadOnlyLabels': True}])
        self.assertEqual(set(additions), {'userComputers', 'browser', 'appConnections'})
        self.assertEqual(json.loads(packet_maker.run_policy_target(None, self.APP_CONNECTIONS_TARGET)), {'appConnections': additions['appConnections']})
        self.assertEqual(json.loads(packet_maker.secret_references_target(self.APP_CONNECTIONS_TARGET)), [self.APP_CONNECTION_SECRET])
        self.assertEqual(packet_maker.secret_references_target(None), '[]')
        packet = self.render(
            TARGET_RUN_POLICY_JSON=packet_maker.run_policy_target(None, self.APP_CONNECTIONS_TARGET),
            TARGET_SECRET_REFERENCES_JSON=packet_maker.secret_references_target(self.APP_CONNECTIONS_TARGET),
        )
        model_secret = {'ref': 'vercel-gateway', 'version': 'v1', 'purpose': 'model-gateway', 'scope': 'deployment:one'}
        original = {**production_config(TWELFTH['OLD_PREFIX'], TWELFTH['ORIGINAL_PUBLIC_FETCH_BYTES'], TWELFTH['ORIGINAL_CONTEXT_WINDOW'], TWELFTH['ORIGINAL_MAX_TOKENS']), 'secretReferences': [model_secret]}
        switched = static_root_configuration(packet)(copy.deepcopy(original))
        self.assertEqual(switched['runPolicy']['appConnections'], additions['appConnections'])
        self.assertEqual(switched['secretReferences'], [*original['secretReferences'], self.APP_CONNECTION_SECRET])
        self.assertEqual({key: value for key, value in switched['runPolicy'].items() if key not in ('appConnections', 'publicFetch')}, {key: value for key, value in original['runPolicy'].items() if key != 'publicFetch'})
        redeployed = static_root_configuration(packet)({**copy.deepcopy(original), 'secretReferences': [{**self.APP_CONNECTION_SECRET, 'version': 'v0'}, model_secret]})
        self.assertEqual(redeployed['secretReferences'], [model_secret, self.APP_CONNECTION_SECRET])
        fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)
        unchanged = static_root_configuration(self.render())(copy.deepcopy(original))
        self.assertNotIn('appConnections', unchanged['runPolicy'])
        self.assertEqual(unchanged['secretReferences'], original['secretReferences'])

    def test_an_app_connections_target_outside_the_supported_shape_is_refused(self):
        valid = self.APP_CONNECTIONS_TARGET[0]
        for candidate in (
            [], {}, 'github', [valid, valid], [{**valid, 'name': 'GitHub'}], [{**valid, 'serverUrl': 'http://api.githubcopilot.com/mcp/'}],
            [{**valid, 'clientId': 'has space'}], [{**valid, 'clientSecret': 'plain-secret-value'}], [{**valid, 'clientSecret': {'ref': '../x', 'version': 'v1'}}],
            [{**valid, 'trustsReadOnlyLabels': 'yes'}], [{**valid, 'extra': 1}], [{key: value for key, value in valid.items() if key != 'title'}],
        ):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_APP_CONNECTIONS_TARGET_INVALID'):
                packet_maker.run_policy_target(None, candidate)

    APPLE_PUSH_TARGET = {'teamId': 'TEAM123456', 'keyId': 'KEY1234567', 'topics': ['win.example.app'], 'environments': ['development', 'production'], 'secret': {'ref': 'apple-push', 'version': 'v1'}}
    APPLE_PUSH_SECRET = {'ref': 'apple-push', 'version': 'v1', 'purpose': 'apple-push', 'scope': 'agent'}

    def test_an_apple_push_target_adds_only_apple_push_and_its_secret_reference(self):
        additions = json.loads(packet_maker.run_policy_target(None, None, self.APPLE_PUSH_TARGET))
        self.assertEqual(additions, {'applePush': {'secretRef': 'apple-push', 'teamId': 'TEAM123456', 'keyId': 'KEY1234567', 'topics': ['win.example.app'], 'environments': ['development', 'production']}})
        self.assertNotIn('webPush', json.loads(packet_maker.run_policy_target(self.COMPUTERS_TARGET, self.APP_CONNECTIONS_TARGET, self.APPLE_PUSH_TARGET)))
        self.assertEqual(json.loads(packet_maker.secret_references_target(self.APP_CONNECTIONS_TARGET, self.APPLE_PUSH_TARGET)), [self.APP_CONNECTION_SECRET, self.APPLE_PUSH_SECRET])
        packet = self.render(
            TARGET_RUN_POLICY_JSON=packet_maker.run_policy_target(None, None, self.APPLE_PUSH_TARGET),
            TARGET_SECRET_REFERENCES_JSON=packet_maker.secret_references_target(None, self.APPLE_PUSH_TARGET),
        )
        original = production_config(TWELFTH['OLD_PREFIX'], TWELFTH['ORIGINAL_PUBLIC_FETCH_BYTES'], TWELFTH['ORIGINAL_CONTEXT_WINDOW'], TWELFTH['ORIGINAL_MAX_TOKENS'])
        switched = static_root_configuration(packet)(copy.deepcopy(original))
        self.assertEqual(switched['runPolicy']['applePush'], additions['applePush'])
        self.assertNotIn('webPush', switched['runPolicy'])
        self.assertEqual(switched['secretReferences'], [*(original.get('secretReferences') or []), self.APPLE_PUSH_SECRET])
        fixtures = subprocess.run([sys.executable, '-I', str(packet / 'systemd' / 'verify-switch-config-fixtures.py'), shutil.which('node')], capture_output=True, text=True, check=False)
        self.assertEqual(fixtures.returncode, 0, fixtures.stdout + fixtures.stderr)

    def test_an_apple_push_target_outside_the_supported_shape_is_refused(self):
        valid = self.APPLE_PUSH_TARGET
        for candidate in (
            {}, 'apple', {**valid, 'teamId': 'team'}, {**valid, 'keyId': 'KEY12345678'}, {**valid, 'topics': []}, {**valid, 'topics': ['a.b', 'a.b']},
            {**valid, 'topics': ['bad topic']}, {**valid, 'environments': ['staging']}, {**valid, 'secret': 'inline-key'}, {**valid, 'secret': {'ref': '../x', 'version': 'v1'}},
            {**valid, 'signingKey': 'x'}, {key: value for key, value in valid.items() if key != 'keyId'},
        ):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_APPLE_PUSH_TARGET_INVALID'):
                packet_maker.run_policy_target(None, None, candidate)
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_SECRET_REFERENCE_DUPLICATE'):
            packet_maker.secret_references_target(self.APP_CONNECTIONS_TARGET, {**valid, 'secret': {'ref': 'github-app-client', 'version': 'v1'}})

    def test_a_speech_target_outside_the_supported_shape_is_refused(self):
        self.assertEqual(packet_maker.speech_target(None), 'null')
        self.assertEqual(json.loads(packet_maker.speech_target(self.SPEECH_TARGET)), self.SPEECH_TARGET)
        valid = self.SPEECH_TARGET
        missing_voice = {key: value for key, value in valid.items() if key != 'voice'}
        for candidate in (
            {**valid, 'adapter': 'openai-tts'}, {**valid, 'provider': 'dashscope/../x'}, {**valid, 'provider': 'Upper'},
            {**valid, 'voice': 'has space'}, {**valid, 'languageType': 'zh-CN'}, {**valid, 'firstAudioTimeoutMs': 100},
            {**valid, 'firstAudioTimeoutMs': 1500.0}, {**valid, 'maximumCharacters': 601}, {**valid, 'maximumCharacters': True},
            {**valid, 'endpoint': 'https://example.com'}, missing_voice, 'speech',
        ):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_SPEECH_TARGET_INVALID'):
                packet_maker.speech_target(candidate)

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


class TemplateNeutralityTest(unittest.TestCase):
    TAG = '[PG-7]'

    def setUp(self):
        self.neutral = load('check_template_neutral', 'check-template-neutral.py')
        self.directory = tempfile.TemporaryDirectory()
        self.template = Path(self.directory.name) / 'packet-template'
        self.builder = Path(self.directory.name) / 'hermes'
        shutil.copytree(HERE / 'packet-template', self.template)
        shutil.copytree(HERE / 'hermes', self.builder)

    def tearDown(self):
        self.directory.cleanup()

    def test_the_template_and_the_builder_scripts_carry_no_machine_values(self):
        self.assertEqual(self.neutral.violations(), [])

    def test_each_kind_of_machine_value_put_back_into_the_template_is_refused(self):
        target = self.template / 'systemd/S2-stop-and-inspect.py'
        original = target.read_text()
        cases = {
            'SERVICE_UID = 999': 'service account number',
            "'--reuid=1001'": 'service account number in setpriv',
            "NODE = 'e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2'": 'node binary fingerprint',
            "KEY = '/var/lib/himawari/qualification/first-20261007/key.pem'": 'qualification directory of the first install',
            "HOST = 'vmi3618928'": 'target host name',
            "ADDRESS = '84.247.157.41'": 'target address',
            "BUILDER = 'hermes-home'": 'builder host name',
            "MACHINE = 'x86_64'": 'cpu architecture',
            "PLATFORM = 'linux-x64'": 'cpu architecture',
            "ABI = 'linux-arm64-abi127'": 'node abi number',
        }
        for line, name in cases.items():
            with self.subTest(name=name, line=line):
                target.write_text(original + '\n' + line + '\n')
                found = self.neutral.violations(self.template, self.builder)
                self.assertTrue(any(item.startswith('systemd/S2-stop-and-inspect.py:') and item.endswith(name) for item in found), found)
        target.write_text(original)
        self.assertEqual(self.neutral.violations(self.template, self.builder), [])

    def test_a_builder_script_with_a_fixed_machine_is_refused_too(self):
        script = self.builder / 'build-candidate.sh'
        script.write_text(script.read_text() + '\nreport=$out/report/build-linux-x64\n')
        self.assertTrue(any(item.startswith('hermes/build-candidate.sh:') for item in self.neutral.violations(self.template, self.builder)))

    def test_the_command_exits_non_zero_when_a_value_is_bound(self):
        clean = subprocess.run([sys.executable, '-I', str(HERE / 'check-template-neutral.py')], capture_output=True, text=True, check=False)
        self.assertEqual((clean.returncode, clean.stdout.strip()), (0, 'TEMPLATE_NEUTRAL'))


class ArmTargetTest(RenderedPacket):
    TAG = '[PG-6]'
    ARM = {'SERVICE_UID': 1001, 'SERVICE_GID': 1002, 'NODE_SHA256': 'a' * 64, 'SYSTEM_BWRAP_SHA256': 'f' * 64, 'NODE_ARCH': 'arm64', 'HOSTNAME': 'tokyo-a1', 'ADDRESS': '192.0.2.7', 'FIRST_SIGNER_KEY_PATH': '/var/lib/himawari/qualification/zeroth-20261101/host-qualification-public-key.pem', 'PYTHON_SHA256': 'b' * 64, 'PYTHON_BYTES': 123, 'BUILDER_HOSTNAME': 'tokyo-a1', 'REHEARSAL_HOSTNAME': ''}

    def test_a_packet_for_another_machine_carries_none_of_the_old_machine_values(self):
        packet = self.render(**self.ARM)
        rehearsal_only = load('check_template_neutral', 'check-template-neutral.py').REHEARSAL_ONLY
        old = (TWELFTH['HOSTNAME'], TWELFTH['ADDRESS'], TWELFTH['NODE_SHA256'], TWELFTH['SYSTEM_BWRAP_SHA256'], TWELFTH['PYTHON_SHA256'], 'first-20261007', 'hermes-home')
        for path in packet.rglob('*'):
            relative = path.relative_to(packet).as_posix()
            if path.is_file() and not any(relative == entry or (entry.endswith('/') and relative.startswith(entry)) for entry in rehearsal_only):
                text = path.read_text()
                for value in old:
                    self.assertNotIn(value, text, path.relative_to(packet).as_posix() + ' ' + value)
        self.assertIn('process.arch === "arm64"', (packet / 'install/twelfth-artifact-install.mjs').read_text())
        self.assertIn('hostname() === ""', (packet / 'install/twelfth-artifact-install.mjs').read_text())
        self.assertIn('"nodeSha256": "' + 'a' * 64 + '"', (packet / 'install/p5-materials.json').read_text())
        draft_host = json.loads((packet / 'inputs/bindings.draft.json').read_text())['host']
        self.assertEqual((draft_host['systemBwrap']['sha256'], draft_host['systemBwrapIdentity']['sha256']), ('f' * 64, 'f' * 64))
        self.assertIn('/usr/bin/setpriv --reuid=1001 --regid=1002', (packet / 'signing/prepare-twelfth-snapshot.sh').read_text())

    def test_the_python_archive_digest_is_the_one_the_commit_locks_for_that_architecture(self):
        lock = {'python': {'version': '3.12.10', 'artifacts': {'linux-x64': {'sha256': 'c' * 64}, 'linux-arm64': {'sha256': 'd' * 64}}}}
        with unittest.mock.patch.object(packet_maker, 'git', return_value=json.dumps(lock)):
            self.assertEqual(packet_maker.python_material_sha('e' * 40, 'x64'), 'c' * 64)
            self.assertEqual(packet_maker.python_material_sha('e' * 40, 'arm64'), 'd' * 64)
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_PYTHON_MATERIAL_NOT_LOCKED'):
                packet_maker.python_material_sha('e' * 40, 'riscv64')
        lock['python']['version'] = '3.13.0'
        with unittest.mock.patch.object(packet_maker, 'git', return_value=json.dumps(lock)):
            self.assertEqual(packet_maker.python_material_version('e' * 40), '3.13.0')
            self.assertEqual(packet_maker.python_archive_name('3.13.0'), 'python-3.13.0.tar.gz')
        lock['python']['version'] = 'latest'
        with unittest.mock.patch.object(packet_maker, 'git', return_value=json.dumps(lock)), self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_PYTHON_VERSION_UNSUPPORTED'):
            packet_maker.python_material_version('e' * 40)

    def test_the_arm_builder_is_the_target_itself_and_never_the_rehearsal_host(self):
        settings = packet_maker.load_builder('arm64', 'tokyo-a1', '192.0.2.7')
        self.assertEqual((settings['hostname'], settings['address']), ('tokyo-a1', '192.0.2.7'))
        with unittest.mock.patch.object(packet_maker, 'python_material_sha', return_value='b' * 64), unittest.mock.patch.object(packet_maker, 'python_material_version', return_value='3.12.10'):
            same = packet_maker.builder_parameters('e' * 40, {'HOSTNAME': 'tokyo-a1', 'NODE_ARCH': 'arm64'}, settings)
            self.assertEqual((same['BUILDER_HOSTNAME'], same['REHEARSAL_HOSTNAME']), ('tokyo-a1', ''))
        for arch in ('riscv64', 'x64'):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_BUILDER_UNKNOWN_ARCHITECTURE'):
                packet_maker.load_builder(arch, 'x', 'y')

    def test_the_arm_builder_reaches_the_target_over_ssh_as_the_build_account(self):
        hermes = packet_maker.Hermes('thirteenth-1234abcd-20261027t010203', packet_maker.load_builder('arm64', 'tokyo-a1', '192.0.2.7'))
        command = hermes.ssh_argv('true')
        self.assertEqual((command[0], command[-2], command[-1]), ('ssh', 'himawari-build@192.0.2.7', 'true'))
        upload = hermes.upload_argv('/tmp/a', '/remote/b')
        self.assertEqual((upload[0], upload[-2], upload[-1]), ('scp', '/tmp/a', 'himawari-build@192.0.2.7:/remote/b'))


class ServiceAccountContractTest(unittest.TestCase):
    SCRIPTS = ('run-question12-downloads.sh', 'run-cloud-acceptance.sh')

    def account_block(self, name):
        lines = (HERE / 'packet-template/acceptance/cloud' / name).read_text().splitlines()
        start = next(index for index, line in enumerate(lines) if line.startswith('account=$(getent passwd himawari-prod)'))
        end = next(index for index, line in enumerate(lines) if line.startswith('test "$(id -G himawari-prod)"'))
        return '\n'.join(lines[start:end + 1])

    def run_block(self, name, passwd_line, groups):
        program = 'set -euo pipefail\ngetent() { printf "%s\\n" "$PASSWD_LINE"; }\nid() { printf "%s\\n" "$GROUPS_LINE"; }\n' + self.account_block(name) + '\necho ACCOUNT_OK\n'
        return subprocess.run(['bash', '-c', program], capture_output=True, text=True, env={'PATH': '/usr/bin:/bin', 'PASSWD_LINE': passwd_line, 'GROUPS_LINE': groups})

    def first_install_account(self):
        line = next(line for line in (HERE.parents[1] / 'scripts/install/first-install.sh').read_text().splitlines() if 'useradd' in line and '"$service_user"' in line)
        home = re.search(r'--home-dir "([^"]+)"', line).group(1).replace('$state_parent', '/var/lib/himawari')
        shell = re.search(r'--shell (\S+)', line).group(1)
        return home, shell

    def test_I120_acceptance_accepts_the_service_account_first_install_created_on_tokyo(self):
        for name in self.SCRIPTS:
            with self.subTest(script=name):
                tokyo = self.run_block(name, 'himawari-prod:x:999:988::/var/lib/himawari:/usr/sbin/nologin', '988')
                self.assertIn('ACCOUNT_OK', tokyo.stdout, tokyo.stderr)
                home, shell = self.first_install_account()
                fresh = self.run_block(name, 'himawari-prod:x:999:988::' + home + ':' + shell, '988')
                self.assertIn('ACCOUNT_OK', fresh.stdout, fresh.stderr)

    def test_acceptance_still_rejects_a_service_account_that_can_log_in_or_has_extra_groups(self):
        for name in self.SCRIPTS:
            with self.subTest(script=name):
                self.assertNotIn('ACCOUNT_OK', self.run_block(name, 'himawari-prod:x:999:988::/var/lib/himawari/state:/bin/bash', '988').stdout)
                self.assertNotIn('ACCOUNT_OK', self.run_block(name, 'himawari-prod:x:999:988::/var/lib/himawari/state:/usr/sbin/nologin', '988 27').stdout)
                self.assertNotIn('ACCOUNT_OK', self.run_block(name, 'himawari-prod:x:0:0::/var/lib/himawari/state:/usr/sbin/nologin', '0').stdout)

    def test_first_install_gives_the_service_account_the_state_root_as_home(self):
        self.assertEqual(self.first_install_account(), ('/var/lib/himawari/state', '/usr/sbin/nologin'))


class WorkspaceGrantExpiryTest(unittest.TestCase):
    def setUp(self):
        self.binding = load('workspace_grant_binding', 'packet-template/signing/workspace-grant-binding.py')

    def test_I120_an_existing_grant_expiry_without_milliseconds_or_in_another_zone_is_read_as_utc(self):
        from datetime import datetime, timezone
        expected = datetime(2099, 1, 1, tzinfo=timezone.utc)
        for value in ['2099-01-01T00:00:00Z', '2099-01-01T00:00:00.000Z', '2099-01-01T09:00:00+09:00', '2098-12-31T19:00:00.000000-05:00']:
            self.assertEqual(self.binding.utc(value), expected, value)

    def test_an_expiry_without_a_zone_or_in_another_shape_is_rejected(self):
        for value in ['2099-01-01T00:00:00', '2099-01-01', 'tomorrow', 1, None]:
            with self.assertRaisesRegex(RuntimeError, 'G90_ZONED_TIMESTAMP_REQUIRED'):
                self.binding.utc(value)


class ProductionRehearsalTest(unittest.TestCase):
    def grant(self, **changes):
        grant = {'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'capabilityRef': 'himawari.pi-coding', 'capabilityVersion': '1.0.0', 'revision': 1, 'stateRevision': 1, 'hostId': 'host:tokyo', 'canonicalRootId': '1:2', 'displayPath': '/var/lib/himawari/workspace', 'device': '1', 'inode': '2', 'pathPolicy': 'same_filesystem_no_links', 'mountPolicy': 'fixed_device', 'expiresAt': '2099-01-01T00:00:00Z', 'revokedAt': None, 'readAllowed': True, 'hostMatchesRoute': True, 'rootMatchesSnapshot': True, 'currentlyUsable': True, 'metadataSha256': 'a' * 64}
        grant.update(changes)
        return grant

    def inputs(self, grant):
        frozen = {'workspace': {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}, 'paths': {'oldPrefix': '/opt/himawari/releases/2026-11-25-db0859f5'}, 'service': {'oldConfigSha256': 'b' * 64}, 'host': {'uid': 1, 'gid': 1}, 'identity': {}, 'authority': {}}
        s0 = {'identity': {'hostId': 'host:tokyo'}, 'authorization': {'directoryGrants': [grant], 'capabilities': []}}
        return frozen, s0

    def test_I120_one_rehearsal_lists_every_problem_the_signing_step_would_hit_on_production_data(self):
        binding = load('workspace_grant_binding_rehearsal', 'packet-template/signing/workspace-grant-binding.py')
        frozen, s0 = self.inputs(self.grant(expiresAt='next year'))
        with tempfile.TemporaryDirectory() as directory:
            configuration = Path(directory) / 'config.json'
            configuration.write_text('{"runPolicy": {}}')
            _, problems = binding.check_production_authorization(frozen, s0, new_capability_refs=['himawari.pi-coding', 'himawari.public-search', 'himawari.public-fetch'], configuration_path=str(configuration), service_uid=os.getuid(), service_gid=os.getgid())
        self.assertEqual(problems, ['G90_ZONED_TIMESTAMP_REQUIRED', 'G90_ZONED_TIMESTAMP_REQUIRED', 'ORIGINAL_CONFIGURATION_CHANGED', 'FIRST_TOOLS_WORKER_IDENTITY_REQUIRED'])

    def test_I120_the_signing_step_reads_the_original_configuration_as_the_service_account_owns_it(self):
        binding = load('workspace_grant_binding_owner', 'packet-template/signing/workspace-grant-binding.py')
        frozen, s0 = self.inputs(self.grant())
        with tempfile.TemporaryDirectory() as directory:
            configuration = Path(directory) / 'config.json'
            configuration.write_text('{"runPolicy": {"coding": {"workerInstanceId": "worker-1"}}}')
            configuration.chmod(0o600)
            frozen['service']['oldConfigSha256'] = binding.digest(configuration.read_bytes())
            check = lambda uid: binding.check_production_authorization(frozen, s0, new_capability_refs=['himawari.pi-coding', 'himawari.public-search', 'himawari.public-fetch'], configuration_path=str(configuration), service_uid=uid, service_gid=os.getgid())[1]
            owned = check(os.getuid())
            someone_else = check(os.getuid() + 1)
        self.assertFalse([problem for problem in owned if 'CONFIGURATION' in problem], owned)
        self.assertIn('ORIGINAL_CONFIGURATION_UNREADABLE:G90_VERIFICATION_FILE_UNSAFE', someone_else)
        signing = (HERE / 'packet-template/signing/finalize-binding-inputs.py').read_text()
        self.assertNotIn("read(Path('/etc/himawari/config.json'), 0)", signing)

    def test_the_signing_step_and_the_freeze_rehearsal_run_the_same_check(self):
        signing = (HERE / 'packet-template/signing/finalize-binding-inputs.py').read_text()
        self.assertIn('grant_validator.check_production_authorization(', signing)
        self.assertNotIn('bind_existing_grant(', signing)
        self.assertIn("'signing/workspace-grant-binding.py'", (HERE / 'make-packet.py').read_text())
        self.assertIn('module.check_production_authorization(', packet_maker.REHEARSAL_DRIVER)
        self.assertIn('common.staticRootConfiguration(original)', packet_maker.MAINTENANCE_REHEARSAL_DRIVER)
        self.assertIn('common.routeIdentity(original, payload.plan)', packet_maker.MAINTENANCE_REHEARSAL_DRIVER)
        self.assertIn('rehearse_production_data(packet, instance, parameters)', (HERE / 'make-packet.py').read_text())

    def test_I120_freeze_refuses_the_packet_with_every_problem_the_rehearsal_found_on_the_target(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory) / 'packet'
            packet_maker.render(packet, {**TWELFTH, **FIRST_TOOLS_PARAMETERS, 'BUILDER_HOSTNAME': socket.gethostname()})
            frozen, s0 = self.inputs(self.grant(expiresAt='next year'))
            frozen['service']['oldUnitSha256'] = 'c' * 64
            (packet / 'inputs/bindings.json').write_text(json.dumps(frozen))
            (packet / 'inputs/s0-db-readback.json').write_text(json.dumps(s0))
            configuration = Path(directory) / 'config.json'
            configuration.write_text('{"runPolicy": {}}')
            unit = Path(directory) / 'himawari-prod.service'
            unit.write_text('[Service]\n')
            instance = {'fixedByTemplate': {'serviceAccount': pwd.getpwuid(os.getuid()).pw_name, 'config': str(configuration), 'unit': 'himawari-rehearsal-absent.service', 'unitPath': str(unit), 'nodePath': shutil.which('node')}}
            parameters = {'HOSTNAME': socket.gethostname(), 'NEW_CAPABILITY_REFS_JSON': FIRST_TOOLS_PARAMETERS['NEW_CAPABILITY_REFS_JSON']}

            def local(_instance, remote, stdin_bytes, timeout=300):
                return subprocess.run(['/bin/bash', '-c', remote], input=stdin_bytes, capture_output=True, check=True).stdout

            with unittest.mock.patch.object(packet_maker, 'run_remote', local):
                with self.assertRaises(packet_maker.PacketError) as raised:
                    packet_maker.rehearse_production_data(packet, instance, parameters)
            problems = str(raised.exception).split(' ')
            self.assertEqual(problems[0], 'PACKET_PRODUCTION_REHEARSAL_FAILED')
            for expected in ['G90_ZONED_TIMESTAMP_REQUIRED', 'ORIGINAL_CONFIGURATION_CHANGED', 'FIRST_TOOLS_WORKER_IDENTITY_REQUIRED', 'ORIGINAL_UNIT_CHANGED_BEFORE_SWITCH', 'staticRootConfiguration:TWELFTH_MAINTENANCE_ORIGINAL_STATIC_ROOT_CHANGED', 'routeIdentity:TWELFTH_MAINTENANCE_ROUTE_IDENTITY_INVALID']:
                self.assertIn(expected, problems)
            self.assertTrue(any(problem.startswith('STOPPED_ORIGINAL_SERVICE_PROPERTIES_CHANGED:User=') for problem in problems), problems)


class DeployScriptErrorLineTest(unittest.TestCase):
    TRAP = """trap 'echo "SCRIPT_COMMAND_FAILED file=${BASH_SOURCE[0]} line=$LINENO exit=$? command=$BASH_COMMAND" >&2' ERR"""

    def scripts(self):
        found = sorted((HERE / 'packet-template').rglob('*.sh')) + [HERE / 'rollback.sh']
        self.assertGreaterEqual(len(found), 10)
        return found

    def header(self, path):
        lines = path.read_text().splitlines()
        index = next(index for index, line in enumerate(lines) if line.startswith('set -'))
        return lines[index:index + 2]

    def test_I120_every_deploy_script_turns_on_the_shared_error_line(self):
        for path in self.scripts():
            with self.subTest(script=path.name):
                self.assertEqual(self.header(path), ['set -Eeuo pipefail', self.TRAP])

    def test_I120_a_failure_inside_any_child_script_or_function_prints_the_failing_line(self):
        for path in self.scripts():
            with self.subTest(script=path.name), tempfile.TemporaryDirectory() as directory:
                child = Path(directory) / 'child.sh'
                child.write_text('\n'.join(self.header(path) + ['inner() {', '  false', '}', 'inner']) + '\n')
                parent = Path(directory) / 'parent.sh'
                parent.write_text('\n'.join(self.header(path) + ['run_child() {', '  /bin/bash "$1"', '}', 'run_child ' + str(child)]) + '\n')
                result = subprocess.run(['/bin/bash', str(parent)], capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('SCRIPT_COMMAND_FAILED file=' + str(child) + ' line=4 exit=1 command=false', result.stderr)
                self.assertIn('SCRIPT_COMMAND_FAILED file=' + str(parent) + ' line=4 exit=1 command=/bin/bash "$1"', result.stderr)


class ArmHostPathsTest(unittest.TestCase):
    TAG = '[PG-6]'
    OPTIONAL_LIB64 = '...["/lib64"].filter(existsSync)'

    def test_sandbox_read_paths_leave_out_lib64_on_a_host_that_has_none(self):
        template = HERE / 'packet-template'
        carried = {'acceptance/cloud/' + copy for copy in re.findall(r'"packetCopy": "([^"]+)"', (template / 'acceptance/cloud/r2l6-source-manifest.json').read_text())}
        executed = [path for path in sorted(template.rglob('*.mjs')) if not path.relative_to(template).as_posix().startswith('acceptance/cloud/basis-04/') and path.relative_to(template).as_posix() not in carried]
        sources = executed + sorted((HERE.parents[1] / 'packages/runtime-sandbox/scripts').glob('probe-*.mjs')) + [HERE.parents[1] / 'packages/runtime-pi/scripts/probe-foreground.mjs', HERE.parents[1] / 'test/qualification/sandbox-install-restart-model.mjs']
        bare = [str(path.relative_to(HERE.parents[1])) + ':' + str(number) for path in sources for number, line in enumerate(path.read_text().splitlines(), 1) if '"/lib64"' in line and self.OPTIONAL_LIB64 not in line]
        self.assertEqual(bare, [])
        seal = (HERE / 'packet-template/signing/cloud-seal.mjs').read_text()
        self.assertIn(self.OPTIONAL_LIB64, seal.split('readOnlyToolchainPaths: [', 1)[1].split('protectedPaths: [', 1)[0])

    def test_the_lib64_entry_resolves_on_hosts_with_it_and_disappears_on_hosts_without_it(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is not installed')
        script = 'import { existsSync } from "node:fs"; import { realpath } from "node:fs/promises"; const entries = ["/usr/lib", ' + self.OPTIONAL_LIB64 + ', "/proc"]; const resolved = await Promise.all(entries.map((p) => realpath(p))); process.stdout.write(JSON.stringify({ entries, resolved }));'
        child = subprocess.run([node, '--input-type=module', '-e', script], capture_output=True, text=True, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        listed = json.loads(child.stdout)['entries']
        self.assertEqual('/lib64' in listed, os.path.lexists('/lib64'))


class MigrateFixtureSeedTest(unittest.TestCase):
    TAG = '[PG-6]'

    def test_the_migrate_fixture_seeds_the_migrations_production_has_not_left_pending(self):
        source = (HERE / 'packet-template/maintenance/verify-migrate-fixtures.mjs').read_text()
        self.assertNotIn('migrations.slice(0, from)', source)
        self.assertIn('const pendingNames = new Set(common.migrationExpectedLedger.map((row) => row.name));', source)
        self.assertIn('persistence.applyMigrations(seeded, productionApplied);', source)
        self.assertIn('.map((migration, index) => ({ ...migration, sequence: index + 1 }))', source)


class FinalizeCapabilityFixtureTest(unittest.TestCase):
    TAG = '[PG-6]'
    PRODUCTION_REFS = ['himawari.pi-coding', 'himawari.public-fetch', 'himawari.public-search']

    def run_fixture(self, capabilities):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory)
            (packet / 'signing').mkdir()
            (packet / 'inputs').mkdir()
            shutil.copy(HERE / 'packet-template/signing/verify-finalize-capability-check.py', packet / 'signing')
            shutil.copy(HERE / 'packet-template/signing/finalize-binding-inputs.py', packet / 'signing')
            shutil.copy(HERE / 'packet-template/signing/workspace-grant-binding.py', packet / 'signing')
            (packet / 'inputs/s0-db-readback.json').write_text(json.dumps({'identity': {'hostId': 'host:fixture'}, 'authorization': {'capabilities': capabilities}}))
            (packet / 'inputs/bindings.draft.json').write_text(json.dumps({'paths': {'oldPrefix': '/opt/himawari/releases/old'}}))
            child = subprocess.run([sys.executable, '-I', str(packet / 'signing/verify-finalize-capability-check.py')], capture_output=True, text=True, check=False)
            return child.returncode, child.stdout + child.stderr

    def capability(self, ref):
        fields = ['activeHealthy', 'versionMatchesSnapshot', 'operationsMatchSnapshot', 'scopesMatchSnapshot', 'costMatchesSnapshot', 'secretRefsMatchSnapshot', 'permissionRefsMatchSnapshot', 'declarationMatchesSnapshotExceptArtifact', 'snapshotIntegrityMatchesRunner', 'storedIntegrityMatchesDeclaration', 'runnerMatchesRecorded', 'integrityMatchesSnapshot', 'declarationInvariantMatchesSnapshot']
        return {'capabilityRef': ref, 'version': '1.0.0', 'status': 'active', **{field: True for field in fields}, 'runnerSha256': 'a' * 64, 'actualRunnerSha256': 'a' * 64, 'hostId': 'host:fixture', 'runtimeRoot': '/opt/himawari/releases/old/lib/himawari-agent', 'workerInstanceId': 'worker:fixture'}

    def test_a_production_without_tools_yet_passes_the_fixture(self):
        self.assertEqual(self.run_fixture([])[0], 0)

    def test_the_three_approved_tools_still_pass_and_every_tampered_field_is_refused(self):
        code, output = self.run_fixture([self.capability(ref) for ref in self.PRODUCTION_REFS])
        self.assertEqual(code, 0, output)
        self.assertGreater(json.loads(output)['cases'], 1)

    def test_any_other_production_tool_set_is_refused_and_named(self):
        code, output = self.run_fixture([self.capability('himawari.pi-coding')])
        self.assertNotEqual(code, 0)
        self.assertIn('FINALIZE_CAPABILITY_FIXTURE_PRODUCTION_SET_CHANGED ["himawari.pi-coding"]', output)


FAKE_SSH = '#!/bin/bash\nexec bash -c "${@: -1}"\n'
FAKE_SCP = '#!/bin/bash\nremote="${@: -1}"; remote="${remote#*:}"; local="${@: -2:1}"; cp "$local" "$remote.upload-tmp" && mv "$remote.upload-tmp" "$remote"\n'


class HermesCommandTest(unittest.TestCase):
    TAG = '[PG-1]'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        ssh = self.root / 'ssh'
        ssh.write_text(FAKE_SSH)
        ssh.chmod(0o755)
        self.scp = self.root / 'scp'
        self.scp.write_text(FAKE_SCP)
        self.scp.chmod(0o755)
        self.environment = {'HIMAWARI_PACKET_SSH': str(ssh), 'HIMAWARI_PACKET_SCP': str(self.scp), 'HIMAWARI_HERMES_POLL_SECONDS': '0.05'}
        os.environ.update(self.environment)
        self.hermes = packet_maker.Hermes('thirteenth-1234abcd-20261027t010203', packet_maker.load_builder('arm64', 'tokyo-a1', '192.0.2.7'))
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

    def test_wait_keeps_polling_while_the_exit_file_is_still_empty(self):
        self.hermes.install_scripts()
        log_root = Path(self.hermes.work + '-inputs')
        log_root.mkdir(parents=True, exist_ok=True)
        exit_file = log_root / 'late.exit'
        exit_file.write_text('')
        (log_root / 'late.log').write_text('')
        writer = threading.Timer(0.3, lambda: exit_file.write_text('0\n'))
        writer.start()
        try:
            self.hermes.wait('late')
        finally:
            writer.join()

    def test_a_walkthrough_preflight_failure_refuses_the_packet(self):
        self.hermes.install_scripts()
        uploaded = Path(self.hermes.scripts) / 'builder.json'
        settings = json.loads(uploaded.read_text())
        settings['hostname'] += '-elsewhere'
        uploaded.write_text(json.dumps(settings))
        with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HERMES_PREFLIGHT_FAILED .*HERMES_WALKTHROUGH_FAILED HOST_UNEXPECTED'):
            self.hermes.preflight()

    def test_an_upload_area_the_target_refuses_is_found_before_any_build(self):
        refusing = self.root / 'refusing-scp'
        refusing.write_text('#!/bin/bash\nremote="${@: -1}"; remote="${remote#*:}"; case "$remote" in ' + str(self.root / 'scripts') + '/*) exec ' + shlex.quote(str(self.scp)) + ' "$@" ;; *) echo "scp: $remote: Permission denied" >&2; exit 1 ;; esac\n')
        refusing.chmod(0o755)
        with unittest.mock.patch.dict(os.environ, {'HIMAWARI_PACKET_SCP': str(refusing)}):
            with self.assertRaisesRegex(packet_maker.PacketError, 'PACKET_HERMES_UPLOAD_AREA_REFUSED .*Permission denied'):
                self.hermes.probe_uploads()
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
        (source / 'ci').mkdir()
        (source / 'ci/toolchain-lock.json').write_text(json.dumps({'python': {'version': '3.12.10'}}))
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
        (self.scripts / 'builder.json').write_text(json.dumps({'arch': 'x64', 'hostname': hostname, 'tools': str(self.tools), 'source': str(source), 'workRoot': str(self.work), 'browsers': str(root / 'browsers'), 'piToolBin': str(self.toolbin)}))

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

    def failing_node(self, report):
        self.executable(self.tools / 'bin' / 'node', 'for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done\n'
                        'mkdir -p "$HIMAWARI_PRODUCT_PATH_OUTPUT"\necho "{}" > "$HIMAWARI_PRODUCT_PATH_OUTPUT/browser-acceptance.json"\n'
                        'echo "vitest says the page never showed the reply"\n' + report + '\nexit 1')

    def test_a_failed_walkthrough_names_the_failing_test_and_its_message(self):
        report = {'testResults': [{'status': 'failed', 'message': '', 'assertionResults': [
            {'status': 'passed', 'fullName': 'release acceptance in a real browser signs in', 'failureMessages': []},
            {'status': 'failed', 'fullName': 'release acceptance in a real browser answers', 'failureMessages': ['AssertionError: expected\n  reply to be visible']}]}]}
        self.failing_node('cat > "$out" <<\'JSON\'\n' + json.dumps(report) + '\nJSON')
        run = self.walkthrough('walk-1')
        self.assertEqual(run.returncode, 4, run.stdout + run.stderr)
        self.assertIn('HERMES_WALKTHROUGH_TEST_FAILED release acceptance in a real browser answers :: AssertionError: expected reply to be visible', run.stderr)
        self.assertNotIn('signs in', run.stderr)
        self.assertIn('vitest says the page never showed the reply', run.stderr)
        self.assertEqual(run.stderr.strip().splitlines()[-1], 'HERMES_WALKTHROUGH_FAILED VITEST_EXIT 1')

    def test_a_walkthrough_that_left_no_report_still_shows_the_end_of_the_vitest_output(self):
        self.failing_node('true')
        run = self.walkthrough('walk-1')
        self.assertEqual(run.returncode, 4, run.stdout + run.stderr)
        self.assertIn('HERMES_WALKTHROUGH_NO_TEST_REPORT', run.stderr)
        self.assertIn('vitest says the page never showed the reply', run.stderr)
        self.assertEqual(run.stderr.strip().splitlines()[-1], 'HERMES_WALKTHROUGH_FAILED VITEST_EXIT 1')

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
            ssh = root / 'ssh'
            ssh.write_text('#!/bin/bash\necho "${@: -1}" >> ' + shlex.quote(str(calls)) + '\n')
            ssh.chmod(0o755)
            with unittest.mock.patch.dict(os.environ, {'HIMAWARI_PACKET_SSH': str(ssh)}):
                hermes = packet_maker.Hermes('twentieth-e9d30b22-20261030t010000', packet_maker.load_builder('arm64', 'target', '192.0.2.1'))
                with unittest.mock.patch.object(packet_maker, 'build_packet', side_effect=SystemExit('PACKET_HERMES_STEP_FAILED')), \
                        unittest.mock.patch.object(packet_maker, 'Hermes', return_value=hermes), \
                        unittest.mock.patch.object(packet_maker, 'load_instance', return_value={'host': {'address': '192.0.2.1'}}), \
                        unittest.mock.patch.object(packet_maker, 'load_builder', return_value={'hostname': 'builder'}), \
                        unittest.mock.patch.object(packet_maker, 'builder_parameters', return_value={}), \
                        unittest.mock.patch.object(packet_maker, 'resolve_commit', return_value='e' * 40), \
                        unittest.mock.patch.object(packet_maker, 'require_current_scripts'), \
                        unittest.mock.patch.object(packet_maker, 'require_claims_proven'), \
                        unittest.mock.patch.object(packet_maker, 'discover', return_value={}), \
                        unittest.mock.patch.object(packet_maker, 'interpret_discovery', return_value={'LABEL': 'twentieth', 'HOSTNAME': 'target', 'NODE_ARCH': 'x64'}), \
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
        self.git_environment = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'maintenance.auto', 'GIT_CONFIG_VALUE_0': 'false'}
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
        ssh = self.root / 'ssh'
        ssh.write_text(FAKE_SSH)
        ssh.chmod(0o755)
        builder_repo = self.root / 'builder-repo'
        subprocess.run(['git', 'clone', '-q', '--no-checkout', str(self.repo), str(builder_repo)], check=True)
        with unittest.mock.patch.dict(os.environ, {'HIMAWARI_PACKET_SSH': str(ssh)}):
            hermes = packet_maker.Hermes('twentyfourth-1234abcd-20261101t010203', packet_maker.load_builder('arm64', 'target', '192.0.2.1'))
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
    tree = ast.parse(packet_maker.select_conditional_blocks((PACKET_TEMPLATE / relative).read_text(), {'FIRST_TOOLS': '0'}, relative))
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


class ServiceReadPrivateJobsTest(unittest.TestCase):
    def test_I120_the_read_unit_hides_the_private_jobs_root_without_requiring_it_to_exist(self):
        source = (PACKET_TEMPLATE / 'measurement/S6-service-read.py').read_text()
        self.assertIn("'InaccessiblePaths=/var/lib/himawari/state -/var/lib/himawari/jobs /etc/himawari'", source)
        self.assertIn("{'/var/lib/himawari/state', '-/var/lib/himawari/jobs', '/etc/himawari'}", source)
        self.assertNotIn(" /var/lib/himawari/jobs ", source)


class MaintenanceFailureDetailTest(unittest.TestCase):
    def test_I261128_a_maintenance_step_that_fails_before_its_report_names_the_failed_condition(self):
        source = (PACKET_TEMPLATE / 'maintenance/run-maintenance.mjs').read_text()
        self.assertIn('_MAINTENANCE_PRECHECK_FAILED ${precheckFailureCode(error)}', source)
        start = source.index('export function precheckFailureCode')
        function = source[start:source.index('\n}\n', start) + 3].replace('export function', 'function')
        script = function + '\n'.join([
            'import assert from "node:assert/strict";',
            'const lines = [];',
            'try { assert.equal(1, 2, "FIRST_MAINTENANCE_STOPPED_AUTHORITY_CHANGED"); } catch (error) { lines.push(precheckFailureCode(error)); }',
            'const missing = new Error("ENOENT: no such file"); missing.code = "ENOENT"; missing.path = "/var/lib/x.json"; lines.push(precheckFailureCode(missing));',
            'lines.push(precheckFailureCode(new TypeError("Cannot read properties of undefined")));',
            'console.log(JSON.stringify(lines));',
        ])
        child = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, text=True, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(json.loads(child.stdout), ['FIRST_MAINTENANCE_STOPPED_AUTHORITY_CHANGED', 'ENOENT:/var/lib/x.json', 'TypeError'])

    def test_I261128_an_unexpected_s9_control_failure_records_what_failed_and_where(self):
        import errno
        import re
        import traceback
        relative = 'maintenance/S9-control-files.py'
        self.assertIn("report['failureDetail'] = unexpected_failure_detail(error)", (PACKET_TEMPLATE / relative).read_text())
        namespace = execute_definitions(relative, template_definitions(relative, {'unexpected_failure_detail'}), {'errno': errno, 're': re, 'traceback': traceback})
        detail = namespace['unexpected_failure_detail']

        def raised(error):
            try:
                raise error
            except Exception as caught:
                return detail(caught)

        missing = raised(FileNotFoundError(errno.ENOENT, 'No such file or directory', '/var/lib/himawari/x.json'))
        self.assertEqual((missing['type'], missing['errno'], missing['filename']), ('FileNotFoundError', 'ENOENT', '/var/lib/himawari/x.json'))
        self.assertEqual(raised(KeyError('newUnitSha256'))['key'], 'newUnitSha256')
        self.assertNotIn('key', raised(KeyError('a sentence with spaces')))
        self.assertEqual(raised(RuntimeError('FIRST_S9_SOMETHING:detail'))['code'], 'FIRST_S9_SOMETHING:detail')
        self.assertEqual(raised(ValueError('free text'))['function'], 'raised')

    def test_I261128_step_and_deploy_failure_lines_carry_the_failed_condition(self):
        for relative in ('packet-template/steps/run-step.py', 'last-failure-report.py'):
            source = (HERE / relative).read_text()
            self.assertIn("'failedCondition', 'failureDetail'", source, relative)


class MaintenanceUnexpectedFailureDetailTest(unittest.TestCase):
    def test_I261128_an_unexpected_maintenance_failure_records_its_message_and_frame(self):
        source = (PACKET_TEMPLATE / 'maintenance/run-maintenance.mjs').read_text()
        self.assertIn('report.failureDetail = unexpectedFailureDetail(error);', source)
        functions = []
        for name in ('precheckFailureCode', 'unexpectedFailureDetail'):
            start = source.index(f'export function {name}')
            functions.append(source[start:source.index('\n}\n', start) + 3].replace('export function', 'function'))
        script = '\n'.join(functions) + '\n'.join([
            'const lines = [];',
            'function load() { throw new TypeError("config.models.limits is not iterable \u2603\\nsecond line"); }',
            'try { load(); } catch (error) { lines.push(unexpectedFailureDetail(error)); }',
            'lines.push(unexpectedFailureDetail("plain"));',
            'console.log(JSON.stringify(lines));',
        ])
        with tempfile.TemporaryDirectory() as directory:
            module = Path(directory) / 'detail.mjs'
            module.write_text(script)
            child = subprocess.run(['node', str(module)], capture_output=True, text=True, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        thrown, plain = json.loads(child.stdout)
        self.assertEqual((thrown['code'], thrown['message']), ('TypeError', 'config.models.limits is not iterable ?'))
        self.assertTrue(thrown['frame'].startswith('load ('), thrown)
        self.assertEqual(plain, {'code': 'string'})


class RestoreControlFirstToolsTest(unittest.TestCase):
    RELATIVE = 'maintenance/S9-control-files.py'

    def test_I261128_restoring_to_a_release_without_tools_checks_only_the_old_supervisor(self):
        source = (PACKET_TEMPLATE / self.RELATIVE).read_text()
        self.assertIn('for filename in old_root_files(first_tools):', source)
        self.assertIn('if not first_tools:', source)
        namespace = execute_definitions(self.RELATIVE, template_definitions(self.RELATIVE, {'old_root_files'}), {'Path': Path})
        files = namespace['old_root_files']
        self.assertEqual([path.name for path in files(True)], ['pair-supervisor.mjs'])
        self.assertEqual([path.name for path in files(False)], ['runtime-protection.json', 'cloud-protected-prepare.mjs', 'pair-supervisor.mjs'])


class ForcedStopTest(unittest.TestCase):
    RELATIVE = 'systemd/S2-stop-and-inspect.py'

    def settle(self, stopped, after):
        calls = []
        namespace = execute_definitions(self.RELATIVE, template_definitions(self.RELATIVE, {'settle_failed_stop'}), {})
        result = namespace['settle_failed_stop'](stopped, lambda: calls.append('result') or {'Result': 'exit-code', 'ExecMainStatus': '1'}, lambda: calls.append('reset'), lambda: calls.append('show') or after)
        return result, calls

    def test_I261128_a_stop_that_the_old_release_ended_by_force_is_reset_and_counts_as_stopped(self):
        source = (PACKET_TEMPLATE / self.RELATIVE).read_text()
        self.assertIn("stopped, report['stopEndedFailed'] = settle_failed_stop(service(), stop_result, reset_failed, service)", source)
        (stopped, facts), calls = self.settle({'ActiveState': 'failed', 'MainPID': '0'}, {'ActiveState': 'inactive', 'MainPID': '0'})
        self.assertEqual((stopped['ActiveState'], facts['Result'], calls), ('inactive', 'exit-code', ['result', 'reset', 'show']))

    def test_a_clean_stop_is_left_alone(self):
        (stopped, facts), calls = self.settle({'ActiveState': 'inactive', 'MainPID': '0'}, None)
        self.assertEqual((stopped['ActiveState'], facts, calls), ('inactive', None, []))

    def test_a_failed_unit_that_still_has_a_main_process_is_not_reset(self):
        (stopped, facts), calls = self.settle({'ActiveState': 'failed', 'MainPID': '4242'}, None)
        self.assertEqual((stopped['MainPID'], facts, calls), ('4242', None, []))


class MaintenanceImportsTest(unittest.TestCase):
    def test_I120_every_shared_maintenance_function_a_module_calls_is_imported(self):
        common = (PACKET_TEMPLATE / 'maintenance/maintenance-common.mjs').read_text()
        exported = set(re.findall(r'^export (?:async )?function ([A-Za-z0-9_]+)', common, re.M)) | set(re.findall(r'^export const ([A-Za-z0-9_]+)', common, re.M))
        checked = 0
        for path in sorted((PACKET_TEMPLATE / 'maintenance').glob('*.mjs')):
            if path.name == 'maintenance-common.mjs':
                continue
            source = path.read_text()
            imports = re.search(r'import \{([^}]*)\} from "\./maintenance-common\.mjs";', source)
            if not imports:
                continue
            checked += 1
            imported = {name.strip().split(' as ')[-1] for name in imports.group(1).split(',') if name.strip()}
            body = source[imports.end():]
            defined = set(re.findall(r'(?:function|const|let|var) ([A-Za-z0-9_]+)', body))
            used = {name for name in exported if re.search(r'(?<![.\w])' + name + r'\(', body)}
            self.assertEqual(sorted(used - imported - defined), [], path.name)
        self.assertGreater(checked, 0)


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


FIRST_TOOLS_REFS = ['himawari.pi-coding', 'himawari.public-search', 'himawari.public-fetch']
FIRST_TOOLS_PARAMETERS = {'FIRST_TOOLS': '1', 'NEW_CAPABILITY_REFS_JSON': json.dumps(FIRST_TOOLS_REFS, separators=(',', ':'))}


class FirstToolsMaintenanceTest(RenderedPacket):
    TAG = '[PG-2]'

    def hashes(self, packet):
        return {path.relative_to(packet).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in packet.rglob('*') if path.is_file()}

    def s9(self, packet):
        spec = importlib.util.spec_from_file_location('s9_control_' + packet.name, packet / 'maintenance' / 'S9-control-files.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_two_renders_differ_only_in_the_files_that_carry_the_new_capability_list(self):
        upgrade = self.hashes(self.render())
        first = self.hashes(self.render(**FIRST_TOOLS_PARAMETERS))
        self.assertEqual(set(upgrade), set(first))
        self.assertEqual({name for name in upgrade if upgrade[name] != first[name]}, {'signing/cloud-capability-manifest.mjs', 'signing/verify-capability-manifest.mjs', 'signing/finalize-binding-inputs.py', 'inputs/finalize-bindings.py', 'inputs/verify-finalize-bindings.py', 'systemd/S2-stop-and-inspect.py', 'systemd/S7-switch-start-readback.py', 'systemd/S7-startup-readback.mjs', 'install/S9-clean-transport.py'})

    def test_maintenance_fixtures_pass_with_every_config_target_andy_production_sets(self):
        targets = INSTANCE['configTargets']
        self.assertTrue(targets.get('speech') and targets.get('computers') and targets.get('appConnections') and targets.get('applePush'))
        packet = self.render(**FIRST_TOOLS_PARAMETERS,
                             TARGET_SPEECH_JSON=packet_maker.speech_target(targets.get('speech')),
                             TARGET_RUN_POLICY_JSON=packet_maker.run_policy_target(targets.get('computers'), targets.get('appConnections'), targets.get('applePush')),
                             TARGET_SECRET_REFERENCES_JSON=packet_maker.secret_references_target(targets.get('appConnections'), targets.get('applePush')))
        self.assertEqual({secret['purpose'] for secret in json.loads(packet_maker.secret_references_target(targets.get('appConnections'), targets.get('applePush')))}, {'app-connection-client', 'apple-push'})
        scratch = self.root / 'fixture-temp-production-targets'
        scratch.mkdir()
        result = subprocess.run([shutil.which('node'), str(packet / 'maintenance' / 'verify-fixtures.mjs')], capture_output=True, text=True, cwd=HERE.parents[1], env={**os.environ, 'HIMAWARI_TEST_TEMP_ROOT': str(scratch)}, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_maintenance_fixtures_pass_in_the_first_tools_render(self):
        packet = self.render(**FIRST_TOOLS_PARAMETERS)
        scratch = self.root / 'fixture-temp-first'
        scratch.mkdir()
        result = subprocess.run([shutil.which('node'), str(packet / 'maintenance' / 'verify-fixtures.mjs')], capture_output=True, text=True, cwd=HERE.parents[1], env={**os.environ, 'HIMAWARI_TEST_TEMP_ROOT': str(scratch)}, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        counts = json.loads(result.stdout.strip().splitlines()[-1])['counts']
        for group in ('firstToolsAccepted', 'firstToolsPendingAccepted', 'firstToolsRegisteredAccepted', 'firstToolsGrantRejections', 'firstToolsPendingRejections', 'firstToolsRegisteredRejections'):
            self.assertGreater(counts[group], 0, group)

    def frozen(self, capabilities):
        grant_bytes = json.dumps({'id': 'directory:himawari-prod-workspace-20261015', 'revision': 1})
        grant = {'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'stateRevision': 1, 'metadataSha256': hashlib.sha256(grant_bytes.encode()).hexdigest()}
        return {'directoryGrants': [grant], 'capabilities': capabilities}, {'revision': 1, 'value_json': grant_bytes}

    def test_s9_restore_of_a_first_tools_deployment_needs_a_catalog_with_no_registrations(self):
        module = self.s9(self.render(**FIRST_TOOLS_PARAMETERS))
        binding = {'workspace': {'decisionRef': 'G90', 'routeKey': 'coding', 'grantId': 'directory:himawari-prod-workspace-20261015', 'canonicalPath': '/var/lib/himawari/workspace', 'subdirectories': ['files', 'repos']}}
        frozen, grant_row = self.frozen([])
        self.assertEqual(module.validate_restored_catalog(binding, frozen, grant_row, {}, True, 0)['capabilityUpgradeDiscarded'], True)
        row = {'id': 'himawari.pi-coding', 'version': '1.0.0', 'status': 'active', 'revision': 1, 'integrity': 'sha256:' + 'a' * 64, 'record_json': '{}'}
        for rows, count in (({}, 1), ({'himawari.pi-coding': row}, 1), ({}, None)):
            with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_RESTORED_CATALOG_NOT_AT_S0'):
                module.validate_restored_catalog(binding, frozen, grant_row, rows, True, count)
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_FROZEN_CATALOG_INVALID'):
            module.validate_restored_catalog(binding, frozen, grant_row, {})
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_RESTORED_GRANT_CHANGED'):
            module.validate_restored_catalog(binding, frozen, {'revision': 2, 'value_json': grant_row['value_json']}, {}, True, 0)

    def test_s9_control_files_skip_the_snapshot_and_attestation_only_when_they_are_absent_in_a_first_tools_restore(self):
        module = self.s9(self.render(**FIRST_TOOLS_PARAMETERS))
        for name in ('CONFIG', 'UNIT', 'SNAPSHOT', 'ATTESTATION'):
            setattr(module, name, self.root / name.lower())
        for name in ('CONFIG', 'UNIT'):
            getattr(module, name).write_text('x')
        self.assertEqual([entry[1] for entry in module.control_files(False)], ['config.json', 'unit.service', 'capability-deployment.json', 'startup-attestation.json'])
        self.assertEqual([entry[1] for entry in module.control_files(True)], ['config.json', 'unit.service'])
        module.SNAPSHOT.write_text('x')
        self.assertEqual([entry[1] for entry in module.control_files(True)], ['config.json', 'unit.service', 'capability-deployment.json'])

    def test_s9_first_tools_state_is_read_from_the_original_configuration_and_must_match_the_frozen_catalog(self):
        module = self.s9(self.render(**FIRST_TOOLS_PARAMETERS))
        module.EVIDENCE = self.root / 'evidence'
        module.EVIDENCE.mkdir()
        module.safe_file = lambda filename, uid=0, mode=None: Path(filename).read_bytes()
        module.OLD_CONFIG_SHA = hashlib.sha256(b'{"runPolicy": {}}').hexdigest()
        (module.EVIDENCE / 'original-config.json').write_bytes(b'{"runPolicy": {}}')
        self.assertIs(module.first_tools_restore({'capabilities': []}), True)
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_FIRST_TOOLS_STATE_INCONSISTENT'):
            module.first_tools_restore({'capabilities': [{'capabilityRef': 'himawari.pi-coding'}]})
        installed = b'{"capabilityDeployment": {"snapshotPath": "/x", "sha256": "sha256:00"}}'
        (module.EVIDENCE / 'original-config.json').write_bytes(installed)
        module.OLD_CONFIG_SHA = hashlib.sha256(installed).hexdigest()
        self.assertIs(module.first_tools_restore({'capabilities': [{'capabilityRef': 'himawari.pi-coding'}]}), False)
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_FIRST_TOOLS_STATE_INCONSISTENT'):
            module.first_tools_restore({'capabilities': []})
        module.OLD_CONFIG_SHA = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'TWELFTH_S9_ORIGINAL_CONTROL_BYTES_CHANGED'):
            module.first_tools_restore({'capabilities': []})


if __name__ == '__main__':
    unittest.main()
