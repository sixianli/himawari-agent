import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
os.umask(0o022)
parser = argparse.ArgumentParser()
for name in ['runtime', 'source', 'node', 'npm-cli', 'modules-archive', 'modules-proof', 'artifact', 'context', 'fd-cache', 'number-cache', 'scratch', 'output']:
    parser.add_argument('--' + name, required=True)
arguments = parser.parse_args()
if sys.platform != 'linux' or os.getuid() == 0 or socket.gethostname() != 'hermes-home' or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1:
    raise RuntimeError('HERMES_ORDINARY_ACCOUNT_ISOLATED_REHEARSAL_REQUIRED')
values = {name: Path(value) for name, value in vars(arguments).items()}
for name, filename in values.items():
    if filename.resolve() != filename or filename.is_symlink() or not filename.exists():
        raise RuntimeError('CANONICAL_INPUT_REQUIRED:' + name)
scratch, output = values['scratch'], values['output']
for filename in [scratch, output]:
    info = filename.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('OWNED_PRIVATE_REHEARSAL_ROOT_REQUIRED')
if len(str(scratch).encode()) != 10 or not str(scratch).startswith('/tmp/h') or any(output.iterdir()) or not str(output).startswith('/data/hermes/himawari/tool-audit-round2/'):
    raise RuntimeError('SHORT_SCRATCH_NEW_DATA_EVIDENCE_REQUIRED')
base = Path(__file__).resolve().parents[1]
cloud = base / 'cloud'
manifest = json.loads((cloud / 'cloud-inputs.draft.json').read_text())
for relative, expected in manifest['files'].items():
    filename = cloud / relative
    if filename.resolve() != filename or filename.is_symlink() or hashlib.sha256(filename.read_bytes()).hexdigest() != expected:
        raise RuntimeError('FROZEN_ACCEPTANCE_SOURCE_CHANGED:' + relative)
expected_candidate = {'artifact': '__PKT_ARTIFACT_SHA256__', 'context': '__PKT_CONTEXT_SHA256__'}
for name, expected in expected_candidate.items():
    if hashlib.sha256(values[name].read_bytes()).hexdigest() != expected:
        raise RuntimeError('FIXED_CANDIDATE_CHANGED:' + name)
proof = json.loads(values['modules_proof'].read_text())
if proof['sourceHead'] != '__PKT_COMMIT__' or proof['scope'] != 'whole-locked-node-modules' or proof['node'] != 'v22.22.3' or proof['lockCheck']['exitCode'] != 0 or not proof['entries'] or hashlib.sha256(values['modules_archive'].read_bytes()).hexdigest() != proof['archive']['sha256']:
    raise RuntimeError('ACTUAL_FULL_LOCKED_DEPENDENCY_TRANSPORT_REQUIRED')
npm_cli = values['npm_cli']
npm_input_root = npm_cli.parent.parent
if str(npm_cli) != '/data/hermes/himawari/tool-audit-round2/r30/tools/npm/package/bin/npm-cli.js' or hashlib.sha256(npm_cli.read_bytes()).hexdigest() != '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7' or json.loads((npm_input_root / 'package.json').read_text())['version'] != '11.8.0':
    raise RuntimeError('PINNED_NPM_11_8_0_REQUIRED')
record = {'schema': 'himawari-__PKT_LABEL__-s6-hermes-rehearsal.v1', 'passed': False, 'commands': [], 'errors': [], 'rootFreeBeforeBytes': shutil.disk_usage('/').free, 'scratch': str(scratch), 'newPaths': [], 'originalSource': str(values['source']), 'runtimeCopiedFrom': str(values['runtime']), 'productionExecuted': False, 'productionQualificationIssued': False, 'systemdServiceEnvironmentProven': False, 'startedAt': time.time()}
environment = {'PATH': str(values['node'].parent) + ':/usr/bin:/bin', 'HOME': str(scratch), 'TMPDIR': str(scratch), 'HIMAWARI_TEST_TEMP_ROOT': str(scratch), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}

def invoke(name, argv, timeout=180, cwd=None, extra_environment=None):
    stdout, stderr = output / (name + '.stdout'), output / (name + '.stderr')
    command_environment = {**environment, **(extra_environment or {})}
    with stdout.open('x') as out, stderr.open('x') as error:
        code = subprocess.run(list(map(str, argv)), cwd=cwd, env=command_environment, stdout=out, stderr=error, stdin=subprocess.DEVNULL, timeout=timeout).returncode
    row = {'name': name, 'command': list(map(str, argv)), 'environment': command_environment, 'cwd': str(cwd) if cwd else os.getcwd(), 'exitCode': code, 'stdoutSha256': hashlib.sha256(stdout.read_bytes()).hexdigest(), 'stderrSha256': hashlib.sha256(stderr.read_bytes()).hexdigest()}
    record['commands'].append(row)
    if code != 0:
        raise RuntimeError('REHEARSAL_STEP_FAILED:' + name)
    return stdout

def npm_entries(root):
    entries = []
    for filename in sorted(root.rglob('*')):
        info = filename.lstat()
        entry = {'path': str(filename.relative_to(root)), 'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            entry['type'] = 'directory'
        elif stat.S_ISREG(info.st_mode):
            data = filename.read_bytes()
            entry.update({'type': 'file', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        else:
            raise RuntimeError('PINNED_NPM_REGULAR_TREE_REQUIRED')
        entries.append(entry)
    return entries

try:
    validation, inputs = scratch / 'validation', scratch / 'input'
    validation.mkdir(mode=0o700)
    inputs.mkdir(mode=0o700)
    source = validation / 'source'
    record['newPaths'] += [str(validation), str(inputs)]
    invoke('clone-transport-source', ['/usr/bin/git', 'clone', '--shared', '--no-checkout', '--', values['source'], source])
    invoke('checkout-candidate-source', ['/usr/bin/git', '-C', source, 'checkout', '--detach', '__PKT_COMMIT__'])
    if subprocess.check_output(['/usr/bin/git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
        raise RuntimeError('CLEAN_TRANSPORT_SOURCE_REQUIRED')
    for name, destination in [('artifact', 'candidate.tar.gz'), ('context', 'context.json'), ('modules_proof', 'node-modules.json')]:
        shutil.copyfile(values[name], inputs / destination)
        (inputs / destination).chmod(0o600)
    invoke('extract-whole-locked-modules', ['/usr/bin/python3', '-I', base / 'helpers/extract-node-modules.py', values['modules_archive'], inputs / 'node-modules.json', source])
    prefix = scratch / 'prefix'
    runtime = prefix / 'lib/himawari-agent'
    source_runtime_readback = json.loads(invoke('installed-source-runtime-before', [values['node'], cloud / 'adapters/digest-installed-runtime.mjs', values['runtime']], extra_environment={'HIMAWARI_PROBE_RUNTIME': str(values['runtime'])}).read_text())
    installer = source / 'scripts/install-node-runtime.mjs'
    installer_before = installer.read_bytes()
    invoke('publish-rehearsal-installation', [values['node'], '--no-global-search-paths', installer, '--source', values['runtime'], '--prefix', prefix])
    if installer.read_bytes() != installer_before or runtime.resolve() != runtime:
        raise RuntimeError('ORIGINAL_INSTALLER_OR_RUNTIME_CHANGED')
    runtime_readback = json.loads(invoke('published-runtime-readback', [values['node'], cloud / 'adapters/digest-installed-runtime.mjs', runtime], extra_environment={'HIMAWARI_PROBE_RUNTIME': str(runtime)}).read_text())
    source_runtime_after = json.loads(invoke('installed-source-runtime-after', [values['node'], cloud / 'adapters/digest-installed-runtime.mjs', values['runtime']], extra_environment={'HIMAWARI_PROBE_RUNTIME': str(values['runtime'])}).read_text())
    if runtime_readback['runtimeDigest'] != source_runtime_readback['runtimeDigest'] or source_runtime_after['runtimeDigest'] != source_runtime_readback['runtimeDigest']:
        raise RuntimeError('ORIGINAL_INSTALLED_RUNTIME_COPY_CHANGED')
    entrypoints = json.loads((runtime / 'runtime-manifest.json').read_text())['entrypoints']
    wrappers = []
    for command, key in [('himawari', 'himawari'), ('himawari-agent-service', 'agentService'), ('himawari-execution-worker', 'executionWorker')]:
        filename = prefix / 'bin' / command
        info = filename.lstat()
        module = runtime / entrypoints[key]
        quoted_module = "'" + str(module).replace("'", "'\\''") + "'"
        expected = '#!/bin/sh\nunset NODE_PATH\nexec node --no-global-search-paths ' + quoted_module + ' "$@"\n'
        data = filename.read_bytes()
        if not stat.S_ISREG(info.st_mode) or filename.resolve() != filename or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o755 or module.resolve() != module or not module.is_file() or data != expected.encode():
            raise RuntimeError('ORIGINAL_INSTALLER_WRAPPER_READBACK_FAILED:' + command)
        wrappers.append({'path': str(filename), 'entrypoint': str(module), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'mode': 0o755, 'actualInstalledEntrypoint': True})
    if runtime.parents[1] / 'bin/himawari' != prefix / 'bin/himawari':
        raise RuntimeError('ORIGINAL_R2L6_CLI_LAYOUT_REQUIRED')
    record['installation'] = {'prefix': str(prefix), 'runtime': str(runtime), 'sourceRuntime': str(values['runtime']), 'installer': str(installer), 'installerSha256': hashlib.sha256(installer_before).hexdigest(), 'method': 'original-7748-installer-source-copy-and-publish', 'runtimeDigest': runtime_readback['runtimeDigest'], 'sourceRuntimeUnchanged': True, 'wrappers': wrappers}
    record['newPaths'].append(str(prefix))
    if (runtime / 'pi-tools/bin').exists() and any((runtime / 'pi-tools/bin').iterdir()):
        raise RuntimeError('UNPREPARED_INSTALLED_CANDIDATE_REQUIRED')
    node_root = scratch / 'node/bin'
    node_root.mkdir(parents=True, mode=0o700)
    node = node_root / 'node'
    shutil.copyfile(values['node'], node)
    node.chmod(0o755)
    if hashlib.sha256(node.read_bytes()).hexdigest() != hashlib.sha256(values['node'].read_bytes()).hexdigest():
        raise RuntimeError('LOCKED_NODE_COPY_CHANGED')
    npm = scratch / 'node/lib/node_modules/npm'
    npm.parent.mkdir(parents=True, mode=0o700)
    npm_before = npm_entries(npm_input_root)
    shutil.copytree(npm_input_root, npm)
    if npm_entries(npm) != npm_before or npm_entries(npm_input_root) != npm_before:
        raise RuntimeError('LOCKED_NPM_COPY_CHANGED')
    (node_root / 'npm').symlink_to('../lib/node_modules/npm/bin/npm-cli.js')
    if (node_root / 'npm').resolve() != npm / 'bin/npm-cli.js':
        raise RuntimeError('LOCKED_NPM_ADJACENT_ENTRY_REQUIRED')
    npm_version = invoke('locked-npm-version', [node, node_root / 'npm', '--version'])
    if npm_version.read_text().strip() != '11.8.0':
        raise RuntimeError('COPIED_NPM_VERSION_CHANGED')
    record['lockedNpm'] = {'inputRoot': str(npm_input_root), 'copiedRoot': str(npm), 'cli': str((node_root / 'npm').resolve()), 'adjacentEntry': str(node_root / 'npm'), 'version': '11.8.0', 'cliSha256': hashlib.sha256((npm / 'bin/npm-cli.js').read_bytes()).hexdigest(), 'entryCount': len(npm_before), 'bytes': sum(entry.get('bytes', 0) for entry in npm_before), 'entriesSha256': hashlib.sha256(json.dumps(npm_before, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), 'allCopiedEntriesMatchedInput': True, 'inputUnchangedAfterCopy': True}
    record['newPaths'].append(str(scratch / 'node'))
    downloads = output / 'question-12-downloads'
    downloads.mkdir(mode=0o700)
    invoke('cached-question-12', ['/usr/bin/python3', '-I', cloud / 'download-question-12.py', '--cached-question-12-inputs', values['fd_cache'], values['number_cache'], downloads], timeout=180)
    manifest.update({'profile': 'hermes-rehearsal', 'status': 'real-second-candidate-Hermes-rehearsal-not-production', 'expectedHostname': 'hermes-home', 'acceptanceUid': os.getuid(), 'acceptanceAccount': 'hermes-task-ordinary-account', 'node': str(node), 'runtime': str(runtime), 'sourceRoot': str(source), 'rehearsalRoot': str(scratch), 'evidenceRoot': str(output), 'nonProduction': True, 'bwrapPaths': {'srt': '/usr/bin/bwrap', 'program': '/usr/bin/bwrap'}, 'cleanupHelper': {'path': str(base / 'helpers/check-p5-scratch-cleanup.py'), 'sha256': hashlib.sha256((base / 'helpers/check-p5-scratch-cleanup.py').read_bytes()).hexdigest()}})
    manifest['candidate'].update({'artifact': str(inputs / 'candidate.tar.gz'), 'context': str(inputs / 'context.json')})
    manifest['compositionEntry'].update({'argv': [str(source / 'packages/runtime-sandbox/scripts/qualify-production.mjs'), '--v2'], 'nodeModulesProof': {'path': str(inputs / 'node-modules.json'), 'sha256': hashlib.sha256((inputs / 'node-modules.json').read_bytes()).hexdigest()}})
    manifest['question12Downloads']['root'] = str(downloads)
    preparation = output / 'rehearsal-preparation-inputs.json'
    preparation.write_text(json.dumps(manifest, indent=2) + '\n')
    tool_output = invoke('runtime-tool-preparation', ['/usr/bin/python3', '-I', cloud / 'prepare-runtime-tools.py', '--approved-rehearsal-tool-preparation', runtime, node, preparation])
    tools = json.loads(tool_output.read_text())
    if tools['passed'] is not True:
        raise RuntimeError('PREPARED_TOOL_READBACK_FAILED')
    manifest['runtimeTools'] = [{'name': row['name'], 'sha256': row['sha256']} for row in tools['runtimeTools']]
    manifest_path = output / 'hermes-rehearsal-inputs.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    run = output / 'run-01'
    run.mkdir(mode=0o700)
    invoke('complete-seven-report-acceptance', ['/usr/bin/python3', '-I', cloud / 'run-stage-03.py', '--approved-__PKT_LABEL__-deployment-acceptance', manifest_path, run], timeout=3600)
    report = json.loads((run / 'run-report.json').read_text())
    acceptance = json.loads((run / 'acceptance-report.json').read_text())
    if report['passed'] is not True or report['scratchCleanupPending'] is not False or acceptance['passed'] is not True or acceptance['productionQualificationIssued'] is not False:
        raise RuntimeError('COMPLETE_REHEARSAL_READBACK_FAILED')
    names = ['pi-installed.json', 'composition-installed.json', 'network-installed.json', 'boundary-installed.json', 'worker-loss-installed.json', 'web-search-installed.json', 'r2l6-installed.json']
    record['reports'] = [{'name': name, 'sha256': hashlib.sha256((run / name).read_bytes()).hexdigest(), 'bytes': (run / name).stat().st_size} for name in names]
    record['innerScratchCleanup'] = {'scratch': report['scratch'], 'deleted': report['scratchDeleted'], 'rootFreeBeforeBytes': report['rootFreeBeforeBytes'], 'rootLowestFreeBytes': report['rootLowestFreeBytes'], 'rootFreeAfterBytes': report['rootFreeAfterCleanupBytes'], 'scratchPeakBytes': report['scratchPeakBytes']}
    record['outerScratchCleanupPending'] = True
    record['outerCleanupBy'] = 'parent retained-evidence wrapper after its process/reference readback'
    record['passed'] = True
except Exception as error:
    record['errors'].append({'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'REHEARSAL_PREPARATION_FAILED'})
finally:
    record['rootFreeAfterBytes'] = shutil.disk_usage('/').free
    record['finishedAt'] = time.time()
    target = output / 'rehearsal-report.json'
    data = (json.dumps(record, indent=2) + '\n').encode()
    with target.open('xb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    target.chmod(0o600)
    if target.read_bytes() != data:
        raise RuntimeError('REHEARSAL_REPORT_READBACK_FAILED')
    print(json.dumps(record))
sys.exit(0 if record['passed'] else 1)
