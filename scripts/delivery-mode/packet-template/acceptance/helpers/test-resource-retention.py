import argparse
import ast
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import sys
import threading
import time

sys.dont_write_bytecode = True
os.umask(0o022)
parser = argparse.ArgumentParser()
parser.add_argument('--stage', required=True)
arguments = parser.parse_args()
if sys.platform != 'linux' or os.getuid() == 0 or socket.gethostname() != 'hermes-home' or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1:
    raise RuntimeError('HERMES_ORDINARY_ACCOUNT_ISOLATED_FIXTURE_REQUIRED')
stage = Path(arguments.stage)
scratch_root = Path(os.environ['HIMAWARI_TEST_TEMP_ROOT'])
output_root = Path(os.environ['HIMAWARI_RUN_EVIDENCE'])
for filename in [stage, scratch_root, output_root]:
    if filename.resolve() != filename or filename.is_symlink():
        raise RuntimeError('CANONICAL_FIXTURE_PATH_REQUIRED')
stage_info = stage.lstat()
if not stat.S_ISREG(stage_info.st_mode):
    raise RuntimeError('ACTUAL_STAGE_REGULAR_FILE_REQUIRED')
for filename in [scratch_root, output_root]:
    info = filename.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
        raise RuntimeError('OWNED_FIXTURE_DIRECTORY_REQUIRED')
if len(str(scratch_root).encode()) != 10 or not str(scratch_root).startswith('/tmp/h') or stat.S_IMODE(scratch_root.stat().st_mode) != 0o700 or not str(output_root).startswith('/data/hermes/himawari/tool-audit-round2/'):
    raise RuntimeError('TASK_WRAPPER_SHORT_SCRATCH_AND_DATA_OUTPUT_REQUIRED')
working = scratch_root / 'resource-retention-fixture'
evidence_root = output_root / 'resource-retention-fixture'
working.mkdir(mode=0o700)
evidence_root.mkdir(mode=0o700)
stage_bytes = stage.read_bytes()
stage_tree = ast.parse(stage_bytes, filename=str(stage))
definitions = [entry for entry in stage_tree.body if isinstance(entry, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
finalizers = [entry for entry in stage_tree.body if isinstance(entry, ast.Try) and any(isinstance(node, ast.Constant) and node.value == 'run-report.json' for statement in entry.finalbody for node in ast.walk(statement))]
if len(finalizers) != 1 or not any(isinstance(entry, ast.ClassDef) and entry.name == 'Resources' for entry in definitions):
    raise RuntimeError('ORIGINAL_STAGE_RESOURCE_AND_FINALIZER_REQUIRED')
definition_code = compile(ast.Module(body=definitions, type_ignores=[]), str(stage), 'exec')
finalizer_code = compile(ast.Module(body=finalizers[0].finalbody, type_ignores=[]), str(stage), 'exec')

class OneObservation(threading.Event):
    def wait(self, timeout=None):
        self.set()
        return True

def require(condition, code):
    if not condition:
        raise AssertionError(code)

def execute_case(name, interrupted_sample=False, final_sample_failure=False, acceptance_passed=True):
    case_root = working / name
    case_evidence = evidence_root / name
    case_root.mkdir(mode=0o700)
    case_evidence.mkdir(mode=0o700)
    scratch = case_root / 'scratch'
    scratch.mkdir(mode=0o700)
    marker = scratch / 'retained-marker.txt'
    marker_bytes = b'resource-retention-fixture-owned-scene\n'
    marker.write_bytes(marker_bytes)
    marker.chmod(0o600)
    packet_root = case_root / 'packet'
    source_root = case_root / 'source'
    packet_root.mkdir(mode=0o700)
    source_root.mkdir(mode=0o700)
    helper = case_root / 'fixture-cleanup-decision.py'
    helper.write_text("import json\nfrom pathlib import Path\nimport sys\narguments = sys.argv[1:]\nevidence = Path(arguments[arguments.index('--evidence') + 1])\nresult = {'deleteAllowed': True, 'fixtureCleanupDecision': True}\n(evidence / 'scratch-cleanup-decision.json').write_text(json.dumps(result) + '\\n')\nprint(json.dumps(result))\n")
    helper.chmod(0o600)
    report_names = ['pi-installed.json', 'composition-installed.json', 'network-installed.json', 'boundary-installed.json', 'worker-loss-installed.json', 'web-search-installed.json', 'r2l6-installed.json']
    acceptance = {'passed': acceptance_passed, 'fixtureSevenReportBoundary': True, 'reports': report_names, 'productionQualificationIssued': False}
    (case_evidence / 'acceptance-report.json').write_text(json.dumps(acceptance) + '\n')
    context = {'__name__': 'resource_retention_fixture_stage', '__file__': str(stage), 'evidence': case_evidence}
    exec(definition_code, context)
    resources = context['Resources'](scratch)
    resources.stopping = OneObservation()
    resource_log = case_evidence / 'resources.jsonl'
    if interrupted_sample:
        resource_log.mkdir(mode=0o700)
    resources.thread.start()
    resources.thread.join(timeout=5)
    require(not resources.thread.is_alive(), 'FIXTURE_RESOURCE_THREAD_DID_NOT_STOP')
    if interrupted_sample:
        require(len(resources.warnings) == 1, 'ORIGINAL_RESOURCE_OBSERVER_DID_NOT_RECORD_FILESYSTEM_WARNING')
        resource_log.rmdir()
    else:
        require(not resources.warnings and resource_log.is_file(), 'FIXTURE_INITIAL_RESOURCE_SAMPLE_FAILED')
    if final_sample_failure:
        if resource_log.exists():
            (case_evidence / 'initial-resource-sample.jsonl').write_bytes(resource_log.read_bytes())
            resource_log.unlink()
        resource_log.mkdir(mode=0o700)
    info = scratch.lstat()
    record = {'schema': 'himawari-__PKT_LABEL__-cloud-acceptance-run.v1', 'startedAt': time.time(), 'rootFreeBeforeBytes': context['root_free'](), 'scratchCleanupPending': True, 'runnerErrors': [], 'productionQualificationIssued': False, 'passed': acceptance_passed, 'profile': 'hermes-rehearsal', 'nonProduction': True, 'hostname': socket.gethostname(), 'acceptanceUid': os.getuid(), 'scratch': str(scratch), 'scratchIdentity': {'device': str(info.st_dev), 'inode': str(info.st_ino), 'uid': info.st_uid}}
    context.update({'record': record, 'scratch': scratch, 'scratch_identity': (info.st_dev, info.st_ino, info.st_uid), 'resources': resources, 'resources_stopped': False, 'observer': None, 'process': None, 'cleanup_helper': helper, 'registry': case_evidence / 'owned-processes.json', 'base': packet_root, 'manifest': {'sourceRoot': str(source_root)}})
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        exec(finalizer_code, context)
    (case_evidence / 'finalizer.stdout').write_text(captured.getvalue())
    observed = json.loads((case_evidence / 'run-report.json').read_text())
    readback = {'scratchExists': scratch.is_dir(), 'markerExists': marker.is_file(), 'markerSha256': hashlib.sha256(marker.read_bytes()).hexdigest() if marker.is_file() else None, 'resourceWarnings': observed.get('resourceSamplingWarnings', []), 'lastSampleSucceeded': resource_log.is_file(), 'cleanupHelperInvoked': (case_evidence / 'scratch-cleanup.stdout').exists(), 'runPassed': observed['passed'], 'scratchCleanupPending': observed['scratchCleanupPending'], 'runnerErrors': observed['runnerErrors']}
    result = {'name': name, 'passed': False, 'input': {'sevenReportAcceptancePassed': acceptance_passed, 'interruptedResourceSample': interrupted_sample, 'finalResourceSampleFailure': final_sample_failure, 'externalCleanupDecision': 'fixture-allow-only-own-new-directory'}, 'readback': readback, 'assertionFailures': [], 'evidence': str(case_evidence)}
    try:
        if not acceptance_passed:
            require(observed['passed'] is False, 'FAILED_ACCEPTANCE_RUN_REPORTED_PASSED')
            require(scratch.is_dir(), 'FAILED_RUN_SCRATCH_SCENE_WAS_DELETED')
            require(marker.is_file() and marker.read_bytes() == marker_bytes, 'FAILED_RUN_SCENE_BYTES_NOT_RETAINED')
            require(observed['scratchCleanupPending'] is True, 'FAILED_RUN_CLEANUP_WAS_MARKED_COMPLETE')
            require(not readback['cleanupHelperInvoked'], 'FAILED_RUN_REACHED_CLEANUP_DECISION')
        else:
            require(observed['passed'] is True, 'SUCCESS_OR_SAMPLING_WARNING_RUN_REPORTED_FAILURE')
            require(not observed['runnerErrors'], 'SAMPLING_WARNING_BECAME_RUNNER_ERROR')
            require(not scratch.exists(), 'SUCCESS_CONTROL_SCRATCH_WAS_NOT_DELETED')
            require(observed['scratchCleanupPending'] is False, 'SUCCESS_CONTROL_CLEANUP_NOT_CONFIRMED')
            require(readback['cleanupHelperInvoked'], 'SUCCESS_CONTROL_CLEANUP_DECISION_NOT_EXECUTED')
        if interrupted_sample:
            require(bool(readback['resourceWarnings']) and readback['lastSampleSucceeded'], 'TRANSIENT_WARNING_WITH_SUCCESSFUL_FINAL_SAMPLE_NOT_REACHED')
        if final_sample_failure:
            require(bool(readback['resourceWarnings']) and not readback['lastSampleSucceeded'], 'FINAL_SAMPLE_FILESYSTEM_WARNING_NOT_REACHED')
        result['passed'] = True
    except AssertionError as error:
        result['assertionFailures'].append(str(error))
    (case_evidence / 'fixture-readback.json').write_text(json.dumps(result, indent=2) + '\n')
    return result

cases = [
    ('transient-resource-warning-final-sample-success', {'interrupted_sample': True}),
    ('all-success-cleanup-control', {}),
    ('final-resource-sample-warning', {'final_sample_failure': True}),
    ('acceptance-failure-retention-control', {'acceptance_passed': False}),
]
report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-resource-retention-fixture.v1', 'passed': False, 'productionQualificationIssued': False, 'unitBoundaryOnly': True, 'stage': {'path': str(stage), 'sha256': hashlib.sha256(stage_bytes).hexdigest(), 'executedOriginalResourcesAndFinalizer': True}, 'fixtureSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'workingRoot': str(working), 'evidenceRoot': str(evidence_root), 'cases': []}
for name, options in cases:
    try:
        report['cases'].append(execute_case(name, **options))
    except Exception as error:
        report['cases'].append({'name': name, 'passed': False, 'fixtureFailure': {'type': type(error).__name__, 'reason': str(error)}})
report['passed'] = len(report['cases']) == len(cases) and all(case['passed'] for case in report['cases'])
if stage.read_bytes() != stage_bytes:
    report['passed'] = False
    report['stageChangedDuringFixture'] = True
target = evidence_root / 'fixture-report.json'
data = (json.dumps(report, indent=2) + '\n').encode()
with target.open('xb') as retained:
    retained.write(data)
    retained.flush()
    os.fsync(retained.fileno())
target.chmod(0o600)
if target.read_bytes() != data:
    raise RuntimeError('RESOURCE_FIXTURE_REPORT_READBACK_FAILED')
print(json.dumps(report))
sys.exit(0 if report['passed'] else 1)
