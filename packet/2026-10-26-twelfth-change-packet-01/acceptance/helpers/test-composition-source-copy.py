import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
os.umask(0o022)
parser = argparse.ArgumentParser()
parser.add_argument('--runner', required=True)
arguments = parser.parse_args()
if sys.platform != 'linux' or os.getuid() == 0 or socket.gethostname() != 'hermes-home' or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1:
    raise RuntimeError('HERMES_ORDINARY_ACCOUNT_ISOLATED_COPY_FIXTURE_REQUIRED')
runner = Path(arguments.runner)
scratch_root = Path(os.environ['HIMAWARI_TEST_TEMP_ROOT'])
output_root = Path(os.environ['HIMAWARI_RUN_EVIDENCE'])
for filename in [runner, scratch_root, output_root]:
    if filename.resolve() != filename or filename.is_symlink():
        raise RuntimeError('CANONICAL_COPY_FIXTURE_PATH_REQUIRED')
if not stat.S_ISREG(runner.lstat().st_mode):
    raise RuntimeError('ACTUAL_NETWORK_RUNNER_REGULAR_FILE_REQUIRED')
for filename in [scratch_root, output_root]:
    info = filename.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
        raise RuntimeError('OWNED_COPY_FIXTURE_DIRECTORY_REQUIRED')
if len(str(scratch_root).encode()) != 10 or not str(scratch_root).startswith('/tmp/h') or stat.S_IMODE(scratch_root.stat().st_mode) != 0o700 or not str(output_root).startswith('/data/hermes/himawari/tool-audit-round2/'):
    raise RuntimeError('TASK_WRAPPER_SHORT_SCRATCH_AND_DATA_OUTPUT_REQUIRED')
working = scratch_root / 'composition-source-copy-fixture'
evidence_root = output_root / 'composition-source-copy-fixture'
working.mkdir(mode=0o700)
evidence_root.mkdir(mode=0o700)
runner_bytes = runner.read_bytes()
runner_tree = ast.parse(runner_bytes, filename=str(runner))
definitions = [entry for entry in runner_tree.body if isinstance(entry, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
copy_blocks = []
for entry in runner_tree.body:
    if not isinstance(entry, ast.Try):
        continue
    starts = [index for index, statement in enumerate(entry.body) if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'composition_source_root' for target in statement.targets)]
    ends = [index for index, statement in enumerate(entry.body) if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and target.value.id == 'report' and isinstance(target.slice, ast.Constant) and target.slice.value == 'compositionExecutionSourceRoot' for target in statement.targets)]
    if len(starts) == 1 and len(ends) == 1 and starts[0] < ends[0]:
        copy_blocks.append(entry.body[starts[0]:ends[0] + 1])
if len(copy_blocks) != 1:
    raise RuntimeError('ORIGINAL_COMPOSITION_COPY_BLOCK_REQUIRED')
definition_code = compile(ast.Module(body=definitions, type_ignores=[]), str(runner), 'exec')
copy_code = compile(ast.Module(body=copy_blocks[0], type_ignores=[]), str(runner), 'exec')

def digest(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()

def require(condition, code):
    if not condition:
        raise AssertionError(code)

def inventory(root, dependency_roots):
    entries = []
    def inspect(filename):
        info = filename.lstat()
        entry = {'path': str(filename.relative_to(root)), 'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            entry['type'] = 'directory'
            entries.append(entry)
            for child in sorted(filename.iterdir()):
                inspect(child)
        elif stat.S_ISREG(info.st_mode):
            entry.update({'type': 'file', 'bytes': info.st_size, 'sha256': digest(filename)})
            entries.append(entry)
        elif stat.S_ISLNK(info.st_mode):
            entry.update({'type': 'symlink', 'link': os.readlink(filename)})
            entries.append(entry)
        else:
            raise RuntimeError('FIXTURE_REGULAR_DEPENDENCY_TREE_REQUIRED')
    for relative in dependency_roots:
        inspect(root / relative)
    return sorted(entries, key=lambda entry: entry['path'])

def write_file(filename, content, mode=0o644):
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    filename.write_bytes(content)
    filename.chmod(mode)

def execute_case(name, mutation=None, expected_error=None):
    case_root = working / name
    case_evidence = evidence_root / name
    case_root.mkdir(mode=0o700)
    case_evidence.mkdir(mode=0o700)
    source = case_root / 'source'
    source.mkdir(mode=0o755)
    scratch = case_root / 'scratch'
    scratch.mkdir(mode=0o700)
    home = case_root / 'home'
    home.mkdir(mode=0o700)
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_AUTHOR_DATE': '2000-01-01T00:00:00+00:00', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00+00:00', 'PYTHONDONTWRITEBYTECODE': '1'}
    commands = []
    def git(label, *arguments):
        argv = ['/usr/bin/git', '-c', 'user.name=Copy Fixture', '-c', 'user.email=copy-fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(source), *arguments]
        completed = subprocess.run(argv, env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        (case_evidence / (label + '.stdout')).write_bytes(completed.stdout)
        (case_evidence / (label + '.stderr')).write_bytes(completed.stderr)
        commands.append({'argv': argv, 'exitCode': completed.returncode, 'stdoutSha256': hashlib.sha256(completed.stdout).hexdigest(), 'stderrSha256': hashlib.sha256(completed.stderr).hexdigest()})
        require(completed.returncode == 0, 'FIXTURE_GIT_SETUP_FAILED:' + label)
        return completed.stdout
    tracked_files = {
        'package.json': b'{"name":"copy-fixture","version":"1.0.0","private":true}\n',
        'package-lock.json': b'{"name":"copy-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n',
        'README.txt': b'composition-copy-fixture-tracked-source\n',
        'packages/workspace/package.json': b'{"name":"fixture-workspace","version":"1.0.0","private":true}\n',
    }
    for relative, content in tracked_files.items():
        write_file(source / relative, content)
    git('git-init', 'init', '--quiet', '--template=')
    git('git-add', 'add', '--', *sorted(tracked_files))
    git('git-commit', 'commit', '--quiet', '-m', 'composition copy fixture')
    source_head = git('git-head', 'rev-parse', 'HEAD').decode().strip()
    write_file(source / 'node_modules/package-a/package.json', b'{"name":"package-a","version":"1.0.0"}\n')
    module_file = source / 'node_modules/package-a/index.js'
    write_file(module_file, b'export default 1;\n', 0o755)
    write_file(source / 'node_modules/package-a/node_modules/is-number/package.json', b'{"name":"is-number","version":"7.0.0"}\n')
    write_file(source / 'node_modules/package-a/node_modules/is-number/index.js', b'export default Number.isFinite;\n')
    write_file(source / 'packages/workspace/node_modules/zod/package.json', b'{"name":"zod","version":"4.4.3"}\n')
    zod_file = source / 'packages/workspace/node_modules/zod/index.js'
    write_file(zod_file, b'export const fixture = true;\n')
    link = source / 'node_modules/.bin/package-a'
    link.parent.mkdir(mode=0o755)
    link.symlink_to('../package-a/index.js')
    dependency_roots = ['node_modules', 'packages/workspace/node_modules']
    proof_value = {'schemaVersion': 2, 'scope': 'whole-locked-node-modules', 'sourceHead': source_head, 'node': 'v22.22.3', 'platform': 'linux-x64', 'packageLockSha256': digest(source / 'package-lock.json'), 'lockCheck': {'method': 'fictitious-fixture-only-no-npm-execution', 'exitCode': 0}, 'dependencyRoots': dependency_roots, 'packages': [{'path': 'node_modules/package-a', 'name': 'package-a', 'version': '1.0.0', 'installed': True}, {'path': 'node_modules/package-a/node_modules/is-number', 'name': 'is-number', 'version': '7.0.0', 'installed': True}, {'path': 'packages/workspace/node_modules/zod', 'name': 'zod', 'version': '4.4.3', 'installed': True}], 'entries': inventory(source, dependency_roots), 'fictitiousFixtureOnly': True}
    if mutation == 'external-link':
        write_file(case_root / 'outside-fixture.txt', b'fixture-owned-external-target\n')
        link.unlink()
        link.symlink_to('../../../outside-fixture.txt')
        next(entry for entry in proof_value['entries'] if entry['path'] == str(link.relative_to(source)))['link'] = os.readlink(link)
    elif mutation == 'extra-entry':
        write_file(source / 'node_modules/package-a/unproved.txt', b'fixture-unproved-entry\n')
    elif mutation == 'changed-bytes':
        module_file.write_bytes(b'export default 2;\n')
    elif mutation == 'changed-mode':
        zod_file.chmod(0o600)
    elif mutation == 'missing-entry':
        zod_file.unlink()
    elif mutation == 'group-writable-source':
        source.chmod(0o775)
    archive = case_evidence / 'fictitious-node-modules.tar.gz'
    with tarfile.open(archive, 'x:gz') as payload:
        for relative in dependency_roots:
            payload.add(source / relative, arcname=relative)
    proof_value['archive'] = {'name': archive.name, 'bytes': archive.stat().st_size, 'sha256': digest(archive)}
    proof_path = case_evidence / 'fictitious-node-modules-proof.json'
    proof_bytes = (json.dumps(proof_value, indent=2) + '\n').encode()
    proof_path.write_bytes(proof_bytes)
    proof_path.chmod(0o600)
    tracked_before = {relative: {'sha256': digest(source / relative), 'mode': stat.S_IMODE((source / relative).lstat().st_mode)} for relative in sorted(tracked_files)}
    dependencies_before = inventory(source, dependency_roots)
    context = {'__name__': 'composition_copy_fixture_runner', '__file__': str(runner)}
    exec(definition_code, context)
    context.update({'source': source, 'scratch': scratch, 'evidence': case_evidence, 'profile': 'hermes-rehearsal', 'proof_value': proof_value, 'proof': {'path': str(proof_path), 'sha256': hashlib.sha256(proof_bytes).hexdigest()}, 'report': {}})
    error = None
    previous_environment = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(environment)
        exec(copy_code, context)
    except Exception as observed_error:
        error = {'type': type(observed_error).__name__, 'reason': str(observed_error)}
    finally:
        os.environ.clear()
        os.environ.update(previous_environment)
    copied = scratch / 'source'
    copy_report_path = case_evidence / 'composition-source-copy.json'
    copy_report = json.loads(copy_report_path.read_text()) if copy_report_path.is_file() else None
    input_unchanged = tracked_before == {relative: {'sha256': digest(source / relative), 'mode': stat.S_IMODE((source / relative).lstat().st_mode)} for relative in sorted(tracked_files)} and dependencies_before == inventory(source, dependency_roots)
    result = {'name': name, 'passed': False, 'profile': 'hermes-rehearsal', 'sourceUid': source.stat().st_uid, 'sourceMode': stat.S_IMODE(source.stat().st_mode), 'fictitiousFixtureOnly': True, 'commands': commands, 'observed': {'error': error, 'copyExists': copied.is_dir(), 'copyReportExists': copy_report_path.is_file(), 'compositionExecutionSourceRoot': context['report'].get('compositionExecutionSourceRoot'), 'inputUnchanged': input_unchanged}, 'assertionFailures': [], 'evidence': str(case_evidence)}
    try:
        require(input_unchanged, 'ORIGINAL_SOURCE_OR_DEPENDENCIES_MUTATED')
        if expected_error is not None:
            require(error is not None, 'INVALID_SOURCE_COPY_WAS_NOT_REJECTED')
            require(error['type'] == 'RuntimeError' and error['reason'].startswith(expected_error), 'SOURCE_COPY_REJECTION_REASON_MISMATCH')
            require(not copy_report_path.exists(), 'REJECTED_COPY_ISSUED_SUCCESS_PROOF')
        else:
            require(error is None, 'VALID_SOURCE_COPY_REJECTED')
            require(copied.is_dir() and copied.resolve() == copied and copied.stat().st_uid == os.getuid(), 'HERMES_SOURCE_WAS_NOT_COPIED_TO_OWNED_SCRATCH')
            require(copied != source and context['report'].get('compositionExecutionSourceRoot') == str(copied), 'HERMES_COMPOSITION_REUSES_INPUT_SOURCE')
            require(copy_report is not None and copy_report['passed'] is True, 'SOURCE_COPY_PROOF_MISSING')
            require(copy_report['inputSourceRoot'] == str(source) and copy_report['workingSourceRoot'] == str(copied) and copy_report['sourceHead'] == source_head, 'SOURCE_COPY_PROOF_IDENTITY_MISMATCH')
            require(copy_report['nodeModulesProofSha256'] == hashlib.sha256(proof_bytes).hexdigest(), 'SOURCE_COPY_PROOF_SHA_MISMATCH')
            require(copy_report['sourceFileCount'] == len(tracked_files) and copy_report['dependencyEntryCount'] == len(proof_value['entries']), 'SOURCE_COPY_PROOF_COUNT_MISMATCH')
            require(copy_report['dependencyRoots'] == dependency_roots and copy_report['allTrackedBytesAndModesMatchedInput'] is True and copy_report['allDependencyEntriesMatchedProof'] is True, 'SOURCE_COPY_PROOF_READBACK_MISMATCH')
            require(inventory(copied, dependency_roots) == proof_value['entries'], 'COPIED_DEPENDENCY_FULL_INVENTORY_MISMATCH')
            require(all((copied / relative).read_bytes() == (source / relative).read_bytes() and stat.S_IMODE((copied / relative).lstat().st_mode) == stat.S_IMODE((source / relative).lstat().st_mode) for relative in tracked_files), 'COPIED_TRACKED_SOURCE_BYTES_OR_MODES_MISMATCH')
            copied_link = copied / str(link.relative_to(source))
            require(copied_link.is_symlink() and copied_link.resolve() == copied / 'node_modules/package-a/index.js', 'LEGAL_INTERNAL_DEPENDENCY_LINK_NOT_PRESERVED')
            (copied / 'README.txt').write_bytes(b'fixture-working-copy-only-change\n')
            require((source / 'README.txt').read_bytes() == tracked_files['README.txt'], 'WORKING_COPY_WRITE_CHANGED_ORIGINAL_INPUT')
        result['passed'] = True
    except AssertionError as assertion_error:
        result['assertionFailures'].append(str(assertion_error))
    (case_evidence / 'fixture-readback.json').write_text(json.dumps(result, indent=2) + '\n')
    return result

cases = [
    ('valid-nested-tree-and-internal-link', {}),
    ('external-link-rejected', {'mutation': 'external-link', 'expected_error': 'COMPOSITION_MODULE_COPY_LINK_CHANGED'}),
    ('extra-entry-rejected', {'mutation': 'extra-entry', 'expected_error': 'COMPOSITION_MODULE_COPY_UNEXPECTED'}),
    ('changed-bytes-rejected', {'mutation': 'changed-bytes', 'expected_error': 'COMPOSITION_MODULE_COPY_BYTES_CHANGED'}),
    ('changed-mode-rejected', {'mutation': 'changed-mode', 'expected_error': 'COMPOSITION_MODULE_COPY_MODE_CHANGED'}),
    ('missing-entry-rejected', {'mutation': 'missing-entry', 'expected_error': 'COMPOSITION_MODULE_COPY_SET_CHANGED'}),
    ('group-writable-source-rejected', {'mutation': 'group-writable-source', 'expected_error': 'OWNED_BOUND_TRANSPORT_SOURCE_REQUIRED'}),
]
report = {'schemaVersion': 'himawari.twelfth-change-composition-source-copy-fixture.v1', 'passed': False, 'productionQualificationIssued': False, 'unitBoundaryOnly': True, 'productionRootOwnerProven': False, 'runner': {'path': str(runner), 'sha256': hashlib.sha256(runner_bytes).hexdigest(), 'executedOriginalCompositionCopyBlock': True}, 'fixtureSha256': digest(Path(__file__)), 'workingRoot': str(working), 'evidenceRoot': str(evidence_root), 'cases': []}
for name, options in cases:
    try:
        report['cases'].append(execute_case(name, **options))
    except Exception as error:
        report['cases'].append({'name': name, 'passed': False, 'fixtureFailure': {'type': type(error).__name__, 'reason': str(error)}})
report['passed'] = len(report['cases']) == len(cases) and all(case['passed'] for case in report['cases'])
if runner.read_bytes() != runner_bytes:
    report['passed'] = False
    report['runnerChangedDuringFixture'] = True
target = evidence_root / 'fixture-report.json'
data = (json.dumps(report, indent=2) + '\n').encode()
with target.open('xb') as retained:
    retained.write(data)
    retained.flush()
    os.fsync(retained.fileno())
target.chmod(0o600)
if target.read_bytes() != data:
    raise RuntimeError('SOURCE_COPY_FIXTURE_REPORT_READBACK_FAILED')
print(json.dumps(report))
sys.exit(0 if report['passed'] else 1)
