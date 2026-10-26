import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import time
import traceback


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def root_free_bytes():
    state = os.statvfs('/')
    return state.f_bavail * state.f_frsize


def digest_file(filename):
    digest = hashlib.sha256()
    with filename.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class ResourceMonitor:
    def __init__(self, scratch, stream, started):
        self.scratch = scratch
        self.stream = stream
        self.started = started
        self.phase = 'initialization'
        self.peak = 0
        self.lowest = root_free_bytes()
        self.errors = []
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, name='scratch-resource-monitor')
        self.running = False

    def observe_free(self, value):
        with self.lock:
            self.lowest = min(self.lowest, value)

    def capture(self):
        try:
            free = root_free_bytes()
            self.observe_free(free)
            result = subprocess.run(['du', '-sb', str(self.scratch)], capture_output=True, text=True)
            size = int(result.stdout.split()[0]) if result.returncode == 0 and result.stdout else None
            sample = {'elapsedSeconds': round(time.monotonic() - self.started, 3), 'phase': self.phase, 'scratchBytes': size, 'rootFreeBytes': free}
            if size is None:
                sample['scratchReadError'] = {'exitCode': result.returncode, 'stderr': result.stderr}
                self.errors.append(sample['scratchReadError'])
            else:
                self.peak = max(self.peak, size)
            self.stream.write(json.dumps(sample) + '\n')
            self.stream.flush()
        except Exception as error:
            failure = {'type': type(error).__name__, 'message': str(error), 'phase': self.phase}
            self.errors.append(failure)
            self.stream.write(json.dumps({'elapsedSeconds': round(time.monotonic() - self.started, 3), 'resourceSamplingError': failure}) + '\n')
            self.stream.flush()

    def run(self):
        deadline = time.monotonic()
        while not self.stopped.is_set():
            self.capture()
            deadline += 5
            now = time.monotonic()
            if deadline <= now:
                deadline = now + 5
            self.stopped.wait(max(0, deadline - now))

    def start(self):
        self.thread.start()
        self.running = True

    def stop(self):
        self.stopped.set()
        if self.running:
            self.thread.join()
        self.capture()


if sys.platform != 'linux' or subprocess.check_output(['hostname'], text=True).strip() != 'hermes-home':
    raise RuntimeError('HOST_MISMATCH')
if len(sys.argv) != 2 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', sys.argv[1]):
    raise RuntimeError('STAGE_NAME_INVALID')
os.umask(0o022)
base = Path('/data/hermes/himawari/tool-audit-round2/r30')
source = Path('/home/andy/himawari-tests/round2/source')
evidence = base / 'evidence/r64/host-acceptance-preparation-04'
if Path('/data').stat().st_dev == Path('/').stat().st_dev or source.stat().st_dev != Path('/').stat().st_dev or base.resolve() != base or source.resolve() != source or evidence.resolve() != evidence:
    raise RuntimeError('DATA_DISK_OR_TASK_PATH_UNSAFE')
if any(directory.stat().st_uid != os.getuid() for directory in [base, source, evidence]):
    raise RuntimeError('TASK_DIRECTORY_OWNER_MISMATCH')
stage = sys.argv[1]
run_path = evidence / f'{stage}-run.json'
report = source / '.ci-output/r64/host-acceptance-preparation-04' / f'{stage}-vitest.json'
if stage == 'product-unfiltered-01':
    report = source / '.ci-output/r64/independent-product-01/product-unfiltered-vitest.json'
report.parent.mkdir(parents=True, exist_ok=True)
retained_report = evidence / f'{stage}-vitest.json'
helper_snapshot = evidence / (stage + '-helper-inputs')
generated = [run_path, retained_report, helper_snapshot]
if stage != 'product-unfiltered-01':
    generated.append(report)
generated.extend(evidence / f'{stage}-{suffix}' for suffix in ['console.log', 'resources.jsonl', 'fp.json', 'workspace.patch', 'installation.log', 'proc-console.log', 'proc.jsonl', 'proc.stop', 'scratch.tar.gz'])
if stage.startswith('d15-'):
    generated.extend(evidence / f'{stage}-{suffix}' for suffix in ['diagnostics', 'collect.json'])
if stage.startswith('diagnostic-'):
    generated.append(evidence / f'{stage}-diagnostics')
if stage == 'full':
    generated.extend([evidence / 'full-output-path.txt', evidence / 'full-output-retained', evidence / 'full-local-summary.json'])
if stage.startswith('product-'):
    generated.extend([source / '.ci-output/r64/host-acceptance-preparation-04' / stage, evidence / (stage + '-output'), evidence / (stage + '-state.tar.gz')])
if stage == 'candidate-build':
    generated.extend([source / '.ci-output/r64-d4-rework-a1-final-01-product-build', evidence / 'candidate-build-retained', evidence / 'candidate-inputs.json'])
if stage.startswith('candidate-permissions-'):
    generated.extend([source / '.ci-output/r64/host-acceptance-preparation-04' / f'{stage}-installation.jsonl', evidence / f'{stage}-installation.jsonl'])
if any(filename.exists() or filename.is_symlink() for filename in generated):
    raise RuntimeError('EVIDENCE_ALREADY_EXISTS')
initial_root_free = root_free_bytes()
if initial_root_free < 10 * 1024**3:
    raise RuntimeError('ROOT_FREE_BELOW_10_GIB')
helpers = ['run-stage-03.py', 'commands-03.json', 'proc-sampler.py']
if stage == 'host-network-preparation-01':
    helpers.extend(['run-network-preparation.py', 'digest-installed-runtime.mjs', 'scratch-root.mjs', 'scratch-root-check.mjs', 'adaptation-manifest.json', 'probe-foreground.mjs', 'probe-linux-worker-loss.mjs', 'probe-network-boundary.mjs', 'probe-authorized-network.mjs', 'candidate-inputs.json'])
if stage.startswith('mem0-compat-'):
    helpers.append('mem0-compat.py')
started = time.monotonic()
command_started = None
scratch = None
scratch_identity = None
monitor = None
process = None
observer = None
observer_log = None
code = None
runner_errors = []
record = {
    'stage': stage,
    'command': None,
    'argv': None,
    'helperInputs': {},
    'initializationStartedAt': utc_now(),
    'startedAt': utc_now(),
    'scratchCleanupPending': False,
    'rootFreeBeforeScratchBytes': initial_root_free,
    'resourceSamplingIntervalSeconds': 5,
    'resourceSamplingBoundary': 'observed scratch size and root free space from scratch validation through initialization, installation, command completion, and evidence retention; peaks between samples can be missed',
}


def require_root_free(phase):
    available = root_free_bytes()
    record.setdefault('rootFreePreflight', []).append({'phase': phase, 'at': utc_now(), 'bytes': available})
    if monitor:
        monitor.observe_free(available)
    if available < 10 * 1024**3:
        raise RuntimeError(f'ROOT_FREE_BELOW_10_GIB:{phase}')


def owned_canonical(pathname, root, directory=False):
    if not pathname.is_relative_to(root) or pathname.resolve(strict=True) != pathname:
        raise RuntimeError(f'OWNED_PATH_NOT_CANONICAL:{pathname}')
    current = pathname
    while True:
        info = current.lstat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o002:
            raise RuntimeError(f'OWNED_PATH_OWNER_OR_MODE_UNSAFE:{current}')
        expected_directory = current != pathname or directory
        if not (stat.S_ISDIR(info.st_mode) if expected_directory else stat.S_ISREG(info.st_mode)):
            raise RuntimeError(f'OWNED_PATH_TYPE_UNSAFE:{current}')
        if current == root:
            return pathname.lstat()
        current = current.parent


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def retained_file(filename, target, input_root, retained_root):
    before = owned_canonical(filename, input_root)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    owned_canonical(target.parent, retained_root, directory=True)
    source_fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(source_fd, 'rb') as incoming:
        if file_identity(os.fstat(incoming.fileno())) != file_identity(before):
            raise RuntimeError(f'RETENTION_SOURCE_IDENTITY_CHANGED:{filename}')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(target_fd, 'wb') as outgoing:
            for chunk in iter(lambda: incoming.read(1024 * 1024), b''):
                outgoing.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        if file_identity(os.fstat(incoming.fileno())) != file_identity(before) or file_identity(filename.lstat()) != file_identity(before):
            raise RuntimeError(f'RETENTION_SOURCE_CHANGED_DURING_COPY:{filename}')
    owned_canonical(target, retained_root)
    if size != before.st_size or digest_file(target) != digest.hexdigest():
        raise RuntimeError(f'RETENTION_COPY_DIGEST_MISMATCH:{filename}')
    return {'source': str(filename), 'retained': str(target), 'sha256': digest.hexdigest(), 'bytes': size, 'sourceDevice': before.st_dev, 'sourceInode': before.st_ino, 'sourceUid': before.st_uid}


def candidate_inputs():
    inputs_path = evidence / 'candidate-inputs.json'
    owned_canonical(inputs_path, evidence)
    inputs = json.loads(inputs_path.read_text())
    build_root = source / '.ci-output/r64-d4-rework-a1-final-01-product-build'
    build_run = json.loads((evidence / 'candidate-build-run.json').read_text())
    if build_run['runnerExitCode'] != 0 or build_run['runnerErrors'] or build_run['candidateInputs'] != inputs:
        raise RuntimeError('CANDIDATE_BUILD_NOT_PASSED')
    owned_canonical(build_root, source, directory=True)
    archive_path = Path(inputs['artifact'])
    context_path = Path(inputs['context'])
    for pathname, key in [(archive_path, 'artifactSha256'), (context_path, 'contextSha256')]:
        before = owned_canonical(pathname, build_root)
        if digest_file(pathname) != inputs[key] or file_identity(pathname.lstat()) != file_identity(before):
            raise RuntimeError('CANDIDATE_INPUT_DIGEST_OR_IDENTITY_MISMATCH')
    return inputs, archive_path, context_path


def retain_full_output(previous_outputs):
    ci_root = source / '.ci-output'
    owned_canonical(ci_root, source, directory=True)
    record['ciOutputs'] = sorted({str(filename) for filename in ci_root.glob('local-*')} - previous_outputs)
    if len(record['ciOutputs']) != 1:
        raise RuntimeError(f"UNEXPECTED_LOCAL_OUTPUT_COUNT:{record['ciOutputs']}")
    output_root = Path(record['ciOutputs'][0])
    if not re.fullmatch(r'local-[0-9]+', output_root.name):
        raise RuntimeError('FULL_OUTPUT_NAME_UNSAFE')
    output_info = owned_canonical(output_root, ci_root, directory=True)
    retained_root = evidence / 'full-output-retained'
    retained_root.mkdir(mode=0o700, exist_ok=False)
    owned_canonical(retained_root, evidence, directory=True)
    with (evidence / 'full-output-path.txt').open('x') as output:
        output.write(str(output_root) + '\n')
    retention = {'source': str(output_root), 'retainedRoot': str(retained_root), 'sourceDevice': output_info.st_dev, 'sourceInode': output_info.st_ino, 'sourceUid': output_info.st_uid, 'files': [], 'excluded': []}
    record['fullOutputRetention'] = retention
    artifact_name = re.compile(r'(?:linux-x64|macos-arm64)-abi[0-9]+-[0-9a-f]{40}-.+\.tar\.gz(?:\.partial)?')
    for current, directories, filenames in os.walk(output_root, followlinks=False):
        current = Path(current)
        owned_canonical(current, output_root, directory=True)
        for name in sorted(directories):
            directory = current / name
            relative = directory.relative_to(output_root)
            rebuildable = len(relative.parts) == 3 and ((relative.parts[0] in {'build-linux-x64', 'build-macos-arm64'} and relative.parts[1:] == ('build', 'work')) or (relative.parts[0] in {'browser-chromium', 'browser-firefox', 'browser-webkit'} and relative.parts[1:] == ('browser', 'payload')))
            if rebuildable:
                directories.remove(name)
                retention['excluded'].append({'source': str(directory), 'reason': 'rebuildable directory subtree'})
            else:
                owned_canonical(directory, output_root, directory=True)
        directories.sort()
        for name in sorted(filenames):
            filename = current / name
            if artifact_name.fullmatch(name):
                retention['excluded'].append({'source': str(filename), 'reason': 'rebuildable CI runtime package archive'})
                continue
            target = retained_root / filename.relative_to(output_root)
            retention['files'].append(retained_file(filename, target, output_root, retained_root))
    if (output_root.lstat().st_dev, output_root.lstat().st_ino, output_root.lstat().st_uid) != (output_info.st_dev, output_info.st_ino, output_info.st_uid):
        raise RuntimeError('FULL_OUTPUT_IDENTITY_CHANGED')
    summary_path = output_root / 'local-summary.json'
    record['fullSummaryReadback'] = {'path': str(summary_path), 'exists': summary_path.is_file()}
    if not summary_path.is_file():
        raise RuntimeError(f'MISSING_LOCAL_SUMMARY:{summary_path}')
    retained_summary = evidence / 'full-local-summary.json'
    summary_copy = retained_file(summary_path, retained_summary, output_root, evidence)
    summary = json.loads(retained_summary.read_bytes())
    record['fullSummaryReadback'].update({'retainedPath': str(retained_summary), 'sha256': summary_copy['sha256'], 'status': summary.get('status'), 'publicationFailures': summary.get('publicationFailures'), 'checks': summary.get('checks')})


with (evidence / f'{stage}-console.log').open('x') as console, (evidence / f'{stage}-resources.jsonl').open('x') as samples:
    try:
        scratch = Path(subprocess.check_output(['mktemp', '-d', '/tmp/hXXXX'], text=True).strip())
        info = scratch.lstat()
        scratch_identity = (info.st_dev, info.st_ino, info.st_uid)
        record.update({'scratch': str(scratch), 'scratchBytes': len(os.fsencode(scratch)), 'scratchMode': oct(stat.S_IMODE(info.st_mode)), 'scratchOwnedByTestAccount': info.st_uid == os.getuid(), 'scratchCleanupPending': True})
        if len(os.fsencode(scratch)) != 10 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or scratch.resolve() != scratch:
            raise RuntimeError('SCRATCH_ROOT_UNSAFE')
        monitor = ResourceMonitor(scratch, samples, started)
        monitor.observe_free(initial_root_free)
        monitor.start()
        installation = {'executables': {'python': str(base / 'tools/python/python/bin/python3')}}
        env = dict(os.environ)
        env.pop('HIMAWARI_TEST_TIMEOUT_MS', None)
        env.pop('HIMAWARI_TEST_ARTIFACT', None)
        env.pop('HIMAWARI_TEST_CONTEXT', None)
        for name in ['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'HIMAWARI_TEST_DIAGNOSTIC_OUTPUT', 'HIMAWARI_TEST_PI_STAGE_DIAGNOSTICS', 'HIMAWARI_TEST_D15_OBSERVER', 'HIMAWARI_TEST_D15_SOURCE', 'HIMAWARI_TEST_D15_OUTPUT', 'HIMAWARI_TEST_D15_RUN_ID', 'HIMAWARI_TEST_D15_CHILD_CONTEXT', 'HIMAWARI_TEST_D15_ARCHIVE_PARENT_STAGE', 'HIMAWARI_TEST_IMPORT_DIAGNOSTICS', 'HIMAWARI_TEST_IMPORT_SOURCE', 'HIMAWARI_TEST_IMPORT_OUTPUT', 'HIMAWARI_TEST_COLLECT_REPORT', 'HIMAWARI_TEST_INSTALLATION_REPORT']:
            env.pop(name, None)
        env.update({
            'PATH': str(base / 'tools/bin') + ':/usr/bin:/bin',
            'HIMAWARI_CI_TOOLS': str(base / 'tools'),
            'HIMAWARI_CI_PYTHON': installation['executables']['python'],
            'PLAYWRIGHT_BROWSERS_PATH': str(base / 'browsers'),
            'HIMAWARI_TEST_TEMP_ROOT': str(scratch),
            'TMPDIR': str(scratch),
            'LONGTASK_HOST': 'hermes',
        })
        if stage == 'product-unfiltered-01' and report.exists():
            previous = evidence / (stage + '-previous-working-report.json')
            record['previousWorkingReportRetention'] = retained_file(report, previous, source, evidence)
            record['reportPathReuseBoundary'] = 'The exact longtask acceptance command writes to its original working output path. Before execution its old bytes are copied and verified in this run; canonical prior reports on DATA and Mac remain unchanged.'
        monitor.phase = 'initialization'
        if stage.startswith('diagnostic-'):
            env['HIMAWARI_TEST_DIAGNOSTIC_OUTPUT'] = str(evidence / f'{stage}-diagnostics')
            env['HIMAWARI_TEST_PI_STAGE_DIAGNOSTICS'] = '1'
            env['NODE_OPTIONS'] = '--import=' + (evidence / 'diagnostic-bootstrap.mjs').as_uri()
            helpers.extend(['diagnostic-bootstrap.mjs', 'vitest-reporter.mjs'])
        if stage.startswith('post-collect-'):
            env['HIMAWARI_TEST_COLLECT_REPORT'] = str(evidence / (stage + '-collect.json'))
            helpers.append('collect-reporter.mjs')
            record['collectReporterOnly'] = True
        if stage.startswith('d22-'):
            env.update({
                'HIMAWARI_TEST_IMPORT_DIAGNOSTICS': '1',
                'HIMAWARI_TEST_IMPORT_SOURCE': str(source),
                'HIMAWARI_TEST_IMPORT_OUTPUT': str(evidence / (stage + '-import')),
                'HIMAWARI_TEST_COLLECT_REPORT': str(evidence / (stage + '-collect.json')),
                'NODE_OPTIONS': '--import=' + (evidence / 'd22-bootstrap.mjs').as_uri(),
            })
            helpers.extend(['d22-bootstrap.mjs', 'http-d22-bootstrap.mjs', 'collect-reporter.mjs'])
            record['d22DiagnosticsEnabled'] = True
        if stage.startswith('d15-'):
            diagnostic_path = evidence / f'{stage}-diagnostics'
            diagnostic_path.mkdir(mode=0o700, exist_ok=False)
            inputs, archive_path, context_path = candidate_inputs()
            env.update({
                'HIMAWARI_TEST_ARTIFACT': str(archive_path),
                'HIMAWARI_TEST_CONTEXT': str(context_path),
                'HIMAWARI_TEST_D15_OBSERVER': '1',
                'HIMAWARI_TEST_D15_SOURCE': str(source),
                'HIMAWARI_TEST_D15_OUTPUT': str(diagnostic_path),
                'HIMAWARI_TEST_D15_RUN_ID': stage,
                'NODE_OPTIONS': '--import=' + (evidence / 'd15-observer-v2.mjs').as_uri(),
                'HIMAWARI_TEST_COLLECT_REPORT': str(evidence / f'{stage}-collect.json'),
            })
            helpers.extend(['candidate-inputs.json', 'd15-observer-v2.mjs', 'd15-archive-observer-v2.py', 'collect-reporter.mjs'])
            record['artifactInputs'] = inputs
            record['d15DiagnosticsEnabled'] = True
            record['diagnosticPath'] = str(diagnostic_path)
        if stage.startswith('candidate-permissions-'):
            inputs = json.loads((evidence / 'candidate-inputs.json').read_text())
            archive_path = Path(inputs['artifact'])
            context_path = Path(inputs['context'])
            build_root = source / '.ci-output/r64-d4-rework-a1-final-01-product-build'
            if any(not p.is_relative_to(build_root) or p.resolve() != p or p.stat().st_uid != os.getuid() for p in [archive_path, context_path]):
                raise RuntimeError('CANDIDATE_INPUT_PATH_UNSAFE')
            if digest_file(archive_path) != inputs['artifactSha256'] or digest_file(context_path) != inputs['contextSha256']:
                raise RuntimeError('CANDIDATE_INPUT_DIGEST_MISMATCH')
            installation_report = source / '.ci-output/r64/host-acceptance-preparation-04' / f'{stage}-installation.jsonl'
            if installation_report.parent.resolve() != installation_report.parent or installation_report.parent.stat().st_uid != os.getuid():
                raise RuntimeError('INSTALLATION_REPORT_PARENT_UNSAFE')
            descriptor = os.open(installation_report, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            report_info = os.fstat(descriptor)
            os.close(descriptor)
            if report_info.st_uid != os.getuid() or stat.S_IMODE(report_info.st_mode) != 0o600 or not stat.S_ISREG(report_info.st_mode):
                raise RuntimeError('INSTALLATION_REPORT_UNSAFE')
            record['installationReportIdentity'] = {'device': report_info.st_dev, 'inode': report_info.st_ino, 'uid': report_info.st_uid, 'mode': oct(stat.S_IMODE(report_info.st_mode))}
            env.update({'HIMAWARI_TEST_ARTIFACT': str(archive_path), 'HIMAWARI_TEST_CONTEXT': str(context_path), 'HIMAWARI_TEST_INSTALLATION_REPORT': str(installation_report)})
            helpers.append('candidate-inputs.json')
            record['artifactInputs'] = inputs
            record['installationReportBoundary'] = 'test-only monotonic timestamps around unchanged spawnSync; append after elapsed measurement; no internal observers or collect reporter'
        if stage.startswith('http-installed-') or stage in {'affected-integration', 'diagnostic-fullintegration', 'control-preparation-focused', 'layer2-control-integration-02'}:
            inputs, archive_path, context_path = candidate_inputs()
            env.update({'HIMAWARI_TEST_ARTIFACT': str(archive_path), 'HIMAWARI_TEST_CONTEXT': str(context_path)})
            helpers.append('candidate-inputs.json')
            record['artifactInputs'] = inputs
        if stage == 'package-guardian-digest':
            inputs, archive_path, context_path = candidate_inputs()
            helpers.extend(['package-guardian-digest.mjs', 'candidate-inputs.json', 'guardian-benchmark.json'])
            record['artifactInputs'] = inputs
        if stage.startswith('product-'):
            inputs, archive_path, context_path = candidate_inputs()
            env.update({
                'HIMAWARI_TEST_ARTIFACT': str(archive_path),
                'HIMAWARI_TEST_CONTEXT': str(context_path),
                'HIMAWARI_PRODUCT_PATH_E2E': '1',
                'HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL': 'chromium',
                'HIMAWARI_PRODUCT_PATH_KEEP_ROOT': '1',
                'HIMAWARI_PRODUCT_PATH_OUTPUT': str(source / '.ci-output/r64/host-acceptance-preparation-04' / stage),
            })
            helpers.append('candidate-inputs.json')
            record['artifactInputs'] = inputs
            record['productEnvironment'] = {key: env[key] for key in ['HIMAWARI_PRODUCT_PATH_E2E', 'HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL', 'HIMAWARI_PRODUCT_PATH_KEEP_ROOT', 'HIMAWARI_PRODUCT_PATH_OUTPUT']}
        if stage.startswith('container-backend-'):
            env.update({
                'HIMAWARI_CONTAINER_QUALIFICATION': '1',
                'HIMAWARI_LIVE_SANDBOX_PROBE': '1',
                'HIMAWARI_CONTAINER_DOCKER_CLI': '/usr/bin/docker',
                'HIMAWARI_CONTAINER_DOCKER_HOST': 'unix:///var/run/docker.sock',
                'HIMAWARI_CONTAINER_WORK_ROOT': str(scratch),
                'HIMAWARI_CONTAINER_RUNNER_IMAGE_ID': 'b27f6f38dd2d2a50a64a914199f3c60156d8055fc9a894a18511efaf1cab35b1',
                'HIMAWARI_CONTAINER_EVIDENCE_PATH': str(evidence / (stage + '-measurement.json')),
            })
            record['containerEnvironment'] = {key: value for key, value in env.items() if key.startswith('HIMAWARI_CONTAINER_') or key == 'HIMAWARI_LIVE_SANDBOX_PROBE'}
        record['diagnosticsEnabled'] = 'HIMAWARI_TEST_DIAGNOSTIC_OUTPUT' in env
        record['nodeOptionsPresent'] = 'NODE_OPTIONS' in env
        record['compileCacheExplicitlyEnabled'] = 'NODE_COMPILE_CACHE' in env
        record['measurementBoundary'] = 'test-side raw explicit mode, handoff and timer start; ready memory RSS is process-wide; summarize-measurements.py rejects missing required schema instead of inferring mode from timing' if stage.startswith('diagnostic-') else None
        command = json.loads((evidence / 'commands-03.json').read_text())[stage]
        command = [part.replace('{report}', str(report)).replace('{scratch}', str(scratch)) for part in command]
        record.update({'command': shlex.join(command), 'argv': command, 'environment': {key: env[key] for key in ['PATH', 'HIMAWARI_CI_TOOLS', 'HIMAWARI_CI_PYTHON', 'PLAYWRIGHT_BROWSERS_PATH', 'HIMAWARI_TEST_TEMP_ROOT', 'TMPDIR', 'HIMAWARI_TEST_DIAGNOSTIC_OUTPUT', 'HIMAWARI_TEST_ARTIFACT', 'HIMAWARI_TEST_CONTEXT', 'NODE_OPTIONS', 'HIMAWARI_TEST_D15_OBSERVER', 'HIMAWARI_TEST_D15_SOURCE', 'HIMAWARI_TEST_D15_OUTPUT', 'HIMAWARI_TEST_D15_RUN_ID', 'HIMAWARI_TEST_COLLECT_REPORT', 'HIMAWARI_TEST_IMPORT_DIAGNOSTICS', 'HIMAWARI_TEST_IMPORT_SOURCE', 'HIMAWARI_TEST_IMPORT_OUTPUT', 'HIMAWARI_TEST_INSTALLATION_REPORT'] if key in env}, 'stageDiagnosticsEnabled': env.get('HIMAWARI_TEST_PI_STAGE_DIAGNOSTICS') == '1', 'retiredTimeoutVariablePresent': 'HIMAWARI_TEST_TIMEOUT_MS' in env})
        monitor.phase = 'fingerprint'
        with (evidence / f'{stage}-fp.json').open('x') as output:
            subprocess.run([installation['executables']['python'], str(base / 'tools/longtask.py'), '--repo', str(source), 'fingerprint', '--json'], cwd=source, env=env, stdout=output, stderr=console, check=True)
        monitor.phase = 'helper-snapshot'
        helper_snapshot.mkdir(exist_ok=False)
        for helper in helpers:
            snapshot = helper_snapshot / helper
            shutil.copy2(evidence / helper, snapshot)
            record['helperInputs'][helper] = digest_file(snapshot)
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True, stderr=console).strip()
        diff = subprocess.check_output(['git', '-c', 'core.quotePath=false', 'diff', 'HEAD', '--binary', '--full-index'], cwd=source, stderr=console)
        with (evidence / f'{stage}-workspace.patch').open('xb') as output:
            output.write(diff)
        untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=source, stderr=console).decode().split('\0')
        record.update({'revision': revision, 'workspacePatchSha256': hashlib.sha256(diff).hexdigest(), 'workspacePatchScope': 'tracked staged and unstaged differences from HEAD; untracked files are listed separately and covered by the fingerprint', 'untrackedFiles': [filename for filename in untracked if filename], 'helperSnapshot': str(helper_snapshot)})
        previous_d3 = set((source / '.ci-output/r2-d3').glob('*'))
        previous_s4 = set((source / '.ci-output/r2-s4-guardian').glob('*'))
        previous_outputs = {str(filename) for filename in (source / '.ci-output').glob('local-*')}
        require_root_free('measurement')
        monitor.phase = 'measurement'
        command_started = time.monotonic()
        record['startedAt'] = utc_now()
        print(json.dumps(record), flush=True)
        process = subprocess.Popen(command, cwd=source, env=env, stdout=console, stderr=subprocess.STDOUT)
        if process is not None:
            sampler_path = evidence / 'proc-sampler.py'
            spec = importlib.util.spec_from_file_location('reply05_sampler', sampler_path)
            sampler = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(sampler)
            identity = sampler.read_identity(process.pid)
            observer_log = (evidence / f'{stage}-proc-console.log').open('x')
            observer = subprocess.Popen([installation['executables']['python'], str(sampler_path), '--root-pid', str(identity['pid']), '--root-starttime', str(identity['starttimeTicks']), '--checkout', str(source), '--output', str(evidence / f'{stage}-proc.jsonl'), '--stop-file', str(evidence / f'{stage}-proc.stop'), '--interval', '2'], cwd=evidence, env=env, stdout=observer_log, stderr=subprocess.STDOUT)
            record['observerRootIdentity'] = identity
        code = process.wait()
        if stage.startswith('candidate-permissions-'):
            current_info = installation_report.lstat()
            expected_info = record['installationReportIdentity']
            if installation_report.is_symlink() or not stat.S_ISREG(current_info.st_mode) or current_info.st_uid != expected_info['uid'] or current_info.st_dev != expected_info['device'] or current_info.st_ino != expected_info['inode'] or stat.S_IMODE(current_info.st_mode) != 0o600:
                raise RuntimeError('INSTALLATION_REPORT_IDENTITY_CHANGED')
            retained_installation = evidence / f'{stage}-installation.jsonl'
            shutil.copy2(installation_report, retained_installation)
            record['installationReportRetention'] = {'source': str(installation_report), 'retained': str(retained_installation), 'sha256': digest_file(retained_installation)}
        record['commandFinishedAt'] = utc_now()
        record['durationSeconds'] = round(time.monotonic() - command_started, 3)
        if stage == 'candidate-build':
            build_root = source / '.ci-output/r64-d4-rework-a1-final-01-product-build'
            retained_build = evidence / 'candidate-build-retained'
            retained_build.mkdir(exist_ok=False)
            record['buildReportRetention'] = []
            for filename in sorted(build_root.rglob('*')):
                if filename.suffix not in ['.json', '.jsonl', '.log', '.txt'] or not filename.is_file():
                    continue
                if filename.resolve() != filename or filename.stat().st_uid != os.getuid():
                    raise RuntimeError('BUILD_REPORT_PATH_UNSAFE')
                target = retained_build / filename.relative_to(build_root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(filename, target)
                record['buildReportRetention'].append({'source': str(filename), 'retained': str(target), 'sha256': digest_file(target), 'bytes': target.stat().st_size})
            summary = json.loads((build_root / 'local-summary.json').read_text())
            record['buildSummary'] = {'status': summary['status'], 'publicationFailures': summary['publicationFailures'], 'checks': summary['checks']}
            if code == 0 and summary['status'] == 'local_passed':
                result = json.loads((build_root / 'build-linux-x64/result.json').read_text())
                if result['status'] != 'passed' or len(result['artifacts']) != 1:
                    raise RuntimeError('CANDIDATE_BUILD_ARTIFACT_COUNT_OR_STATUS')
                artifact_record = result['artifacts'][0]
                archive_path = build_root / 'build-linux-x64' / artifact_record['path']
                context_path = build_root / 'context.json'
                if archive_path.resolve() != archive_path or not archive_path.is_relative_to(build_root) or digest_file(archive_path) != artifact_record['sha256']:
                    raise RuntimeError('CANDIDATE_BUILD_ARTIFACT_UNSAFE')
                inputs = {'artifact': str(archive_path), 'artifactSha256': artifact_record['sha256'], 'artifactBytes': archive_path.stat().st_size, 'context': str(context_path), 'contextSha256': digest_file(context_path), 'revision': revision, 'workspacePatchSha256': record['workspacePatchSha256'], 'fingerprintSha256': digest_file(evidence / f'{stage}-fp.json')}
                with (evidence / 'candidate-inputs.json').open('x') as output:
                    output.write(json.dumps(inputs, indent=2) + '\n')
                record['candidateInputs'] = inputs
    except BaseException as error:
        runner_errors.append({'phase': monitor.phase if monitor else 'scratch-initialization', 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
        traceback.print_exc(file=console)
        console.flush()
    finally:
        if process is not None and process.poll() is None:
            code = process.wait()
            record['commandFinishedAt'] = utc_now()
            record['durationSeconds'] = round(time.monotonic() - command_started, 3)
        elif process is not None:
            code = process.returncode
        if report.exists():
            try:
                shutil.copy2(report, retained_report)
                record['reportRetention'] = {'source': str(report), 'retained': str(retained_report), 'sha256': digest_file(retained_report)}
            except Exception as error:
                runner_errors.append({'phase': 'report-retention', 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
                traceback.print_exc(file=console)
        if stage == 'full' and process is not None:
            try:
                if monitor:
                    monitor.phase = 'evidence-retention'
                retain_full_output(previous_outputs)
            except Exception as error:
                runner_errors.append({'phase': 'full-output-retention', 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
                traceback.print_exc(file=console)
                console.flush()
        if observer is not None:
            try:
                (evidence / f'{stage}-proc.stop').touch(exist_ok=False)
                record['observerExitCode'] = observer.wait()
                if record['observerExitCode']:
                    runner_errors.append({'phase': 'observer', 'type': 'ObserverFailure', 'message': f"observer exited {record['observerExitCode']}"})
            except Exception as error:
                runner_errors.append({'phase': 'observer-stop', 'type': type(error).__name__, 'message': str(error)})
                record['observerExitCode'] = observer.wait()
            finally:
                if observer_log:
                    observer_log.close()
        if stage.startswith('product-') and process is not None:
            try:
                monitor.phase = 'product-evidence-retention'
                product_output = source / '.ci-output/r64/host-acceptance-preparation-04' / stage
                retained_output = evidence / (stage + '-output')
                retained_output.mkdir(mode=0o700, exist_ok=False)
                record['productOutputRetention'] = []
                if product_output.is_dir():
                    for filename in sorted(product_output.rglob('*')):
                        if not filename.is_file():
                            continue
                        target = retained_output / filename.relative_to(product_output)
                        record['productOutputRetention'].append(retained_file(filename, target, product_output, retained_output))
                retained_state = evidence / (stage + '-state.tar.gz')
                with tarfile.open(retained_state, 'x:gz') as archive:
                    for installation_root in sorted(scratch.iterdir()):
                        if installation_root.name.startswith('pp-') and installation_root.is_dir():
                            for child in sorted(installation_root.iterdir()):
                                if child.name not in ['prefix', 'browser', 'test-bash']:
                                    archive.add(child, arcname=str(child.relative_to(scratch)))
                record['productStateRetention'] = {'path': str(retained_state), 'sha256': digest_file(retained_state), 'bytes': retained_state.stat().st_size, 'excludedRebuildableNames': ['prefix', 'browser', 'test-bash']}
            except Exception as error:
                runner_errors.append({'phase': 'product-retention', 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
                traceback.print_exc(file=console)
        if process is not None:
            try:
                output = source / '.ci-output/r2-d3'
                retained = evidence / (stage + '-d3-readbacks')
                retained.mkdir(mode=0o700, exist_ok=False)
                record['d3ReadbackRetention'] = []
                for root in sorted(set(output.glob('*')) - previous_d3):
                    for filename in sorted(root.rglob('*.json')):
                        target = retained / filename.relative_to(output)
                        record['d3ReadbackRetention'].append(retained_file(filename, target, output, retained))
            except Exception as error:
                runner_errors.append({'phase': 'd3-retention', 'type': type(error).__name__, 'message': str(error)})
        if process is not None:
            try:
                output = source / '.ci-output/r2-s4-guardian'
                retained = evidence / (stage + '-s4-readbacks')
                retained.mkdir(mode=0o700, exist_ok=False)
                record['s4ReadbackRetention'] = []
                for root in sorted(set(output.glob('*')) - previous_s4):
                    for filename in sorted(root.rglob('*')):
                        if filename.is_file():
                            target = retained / filename.relative_to(output)
                            record['s4ReadbackRetention'].append(retained_file(filename, target, output, retained))
            except Exception as error:
                runner_errors.append({'phase': 's4-retention', 'type': type(error).__name__, 'message': str(error)})
        if process is not None and (source / '.ci-output/r2-l5-mem0').exists():
            try:
                output = source / '.ci-output/r2-l5-mem0'
                retained = evidence / (stage + '-mem0-readbacks')
                retained.mkdir(mode=0o700, exist_ok=False)
                record['mem0ReadbackRetention'] = []
                for filename in sorted(output.rglob('*.json')):
                    target = retained / filename.relative_to(output)
                    record['mem0ReadbackRetention'].append(retained_file(filename, target, output, retained))
            except Exception as error:
                runner_errors.append({'phase': 'mem0-retention', 'type': type(error).__name__, 'message': str(error)})
        if process is not None and (source / '.ci-output/r2-l5-http').exists():
            try:
                output = source / '.ci-output/r2-l5-http'
                retained = evidence / (stage + '-http-readbacks')
                retained.mkdir(mode=0o700, exist_ok=False)
                record['httpReadbackRetention'] = []
                for filename in sorted(output.rglob('*.json')):
                    target = retained / filename.relative_to(output)
                    record['httpReadbackRetention'].append(retained_file(filename, target, output, retained))
            except Exception as error:
                runner_errors.append({'phase': 'http-retention', 'type': type(error).__name__, 'message': str(error)})
        if stage.startswith('container-backend-') and process is not None:
            try:
                output = source / '.ci-output/r2-d6'
                retained = evidence / (stage + '-d6-readbacks')
                retained.mkdir(mode=0o700, exist_ok=False)
                record['d6ReadbackRetention'] = []
                for filename in sorted(output.rglob('*')):
                    if filename.is_file():
                        target = retained / filename.relative_to(output)
                        record['d6ReadbackRetention'].append(retained_file(filename, target, output, retained))
            except Exception as error:
                runner_errors.append({'phase': 'd6-retention', 'type': type(error).__name__, 'message': str(error)})
        if code is None:
            code = 1
        record['exitCode'] = code
        if scratch is not None and scratch_identity is not None:
            try:
                if monitor:
                    monitor.phase = 'evidence-retention'
                current = scratch.lstat()
                if (current.st_dev, current.st_ino, current.st_uid) != scratch_identity or current.st_uid != os.getuid() or scratch.resolve() != scratch:
                    raise RuntimeError('SCRATCH_IDENTITY_CHANGED')
                if (code != 0 or runner_errors) and any(scratch.iterdir()):
                    retained = evidence / f'{stage}-scratch.tar.gz'
                    with tarfile.open(retained, 'x:gz') as archive:
                        archive.add(scratch, arcname=scratch.name)
                    record['retainedScratch'] = str(retained)
                    record['retainedScratchSha256'] = digest_file(retained)
                if monitor:
                    monitor.stop()
                    record.update({'scratchPeakBytes': monitor.peak, 'rootLowestFreeBytes': monitor.lowest, 'resourceSamplingErrors': monitor.errors})
                    monitor = None
                known_processes = {(process.pid, record['observerRootIdentity']['starttimeTicks'])} if process is not None and 'observerRootIdentity' in record else set()
                observations_path = evidence / f'{stage}-proc.jsonl'
                if process is not None and (record.get('observerExitCode') != 0 or not known_processes or not observations_path.is_file() or observations_path.stat().st_size == 0):
                    raise RuntimeError('SCRATCH_PROCESS_OBSERVATION_INCOMPLETE')
                if observations_path.is_file():
                    for line in observations_path.read_text().splitlines():
                        observation = json.loads(line)
                        for member in observation.get('testTree', {}).get('processes', []):
                            known_processes.add((member['pid'], member['starttimeTicks']))
                live_descendants = []
                for pid, starttime in known_processes:
                    try:
                        info = sampler.parse_stat(Path(f'/proc/{pid}/stat').read_text())
                    except FileNotFoundError:
                        continue
                    if info['starttimeTicks'] == starttime and info['state'] not in ['Z', 'X', 'x']:
                        live_descendants.append({'pid': pid, 'starttimeTicks': starttime, 'comm': info['comm']})
                record['scratchCleanupProcessReadback'] = {'observedTaskIdentitiesChecked': len(known_processes), 'liveDescendants': live_descendants}
                if live_descendants:
                    raise RuntimeError('SCRATCH_STILL_USED_BY_OBSERVED_TASK_PROCESS')
                shutil.rmtree(scratch)
                record['scratchCleanupPending'] = False
                record['scratchDeleted'] = not scratch.exists()
            except Exception as error:
                runner_errors.append({'phase': 'scratch-retention-or-cleanup', 'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()})
                traceback.print_exc(file=console)
        if monitor:
            monitor.stop()
            record.update({'scratchPeakBytes': monitor.peak, 'rootLowestFreeBytes': monitor.lowest, 'resourceSamplingErrors': monitor.errors})
        record['runnerErrors'] = runner_errors
        record.setdefault('durationSeconds', round(time.monotonic() - started, 3))
        record['totalDurationSeconds'] = round(time.monotonic() - started, 3)
        record['finishedAt'] = utc_now()
        record['rootFreeAfterCleanupBytes'] = root_free_bytes()
        record['runnerExitCode'] = 1 if runner_errors else code if code >= 0 else 128 - code
        with run_path.open('x') as output:
            output.write(json.dumps(record, indent=2) + '\n')
        print(json.dumps(record), flush=True)
sys.exit(record['runnerExitCode'])
