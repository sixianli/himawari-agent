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

base = Path(__file__).resolve().parent
report = {'schema': 'himawari-twelfth-cloud-limited-acceptance.v1', 'productionQualificationIssued': False, 'commands': [], 'assertions': [], 'passed': False}
os.umask(0o022)
if len(sys.argv) != 5 or sys.argv[1] != '--approved-twelfth-deployment-acceptance':
    raise RuntimeError('EXPLICIT_TWELFTH_DEPLOYMENT_ACCEPTANCE_APPROVAL_REQUIRED')
manifest_path, scratch, evidence = map(Path, sys.argv[2:])
manifest = json.loads(manifest_path.read_text())
profile = manifest['profile']
node = Path(manifest['node'])
runtime = Path(manifest['runtime'])
source = Path(manifest['sourceRoot'])
cleanup_helper = Path(manifest['cleanupHelper']['path'])
registry = evidence / 'owned-processes.json'
validator = base.parent / 'helpers/validate-r2l6-installed.mjs'
if profile not in ['hermes-rehearsal', 'cloud-twelfth-change']:
    raise RuntimeError('ACCEPTANCE_PROFILE_REQUIRED')
if profile == 'hermes-rehearsal':
    root = Path(manifest['rehearsalRoot'])
    if socket.gethostname() != 'hermes-home' or not str(root).startswith('/tmp/h') or len(str(root).encode()) != 10 or any(root not in value.parents for value in [node, runtime, source]):
        raise RuntimeError('HERMES_OWNED_REHEARSAL_PATHS_REQUIRED')
else:
    if socket.gethostname() == 'hermes-home' or str(node) != '/opt/himawari/node/bin/node' or str(runtime) != '/opt/himawari/releases/2026-10-26-twelfth/lib/himawari-agent' or str(source) != '/var/tmp/himawari-twelfth-20261026/validation/source':
        raise RuntimeError('FORMAL_CLOUD_PATHS_REQUIRED')
if any(value.resolve() != value or value.is_symlink() for value in [node, runtime, source, cleanup_helper]):
    raise RuntimeError('ACCEPTANCE_PATH_CANONICAL_REQUIRED')
if hashlib.sha256(cleanup_helper.read_bytes()).hexdigest() != manifest['cleanupHelper']['sha256']:
    raise RuntimeError('CLEANUP_HELPER_CHANGED')
if manifest['compositionEntry']['argv'] != [str(source / 'packages/runtime-sandbox/scripts/qualify-production.mjs'), '--v2']:
    raise RuntimeError('ORIGINAL_COMPOSITION_ENTRY_REQUIRED')
report.update({'profile': profile, 'nonProduction': True, 'hostname': socket.gethostname(), 'acceptanceUid': os.getuid(), 'runtime': str(runtime), 'sourceRoot': str(source), 'node': str(node)})
report['inputManifestSha256'] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
if manifest['schema'] != 'himawari-twelfth-cloud-acceptance-inputs.v1' or manifest['compositionEntry']['status'] != 'ready':
    raise RuntimeError('COMPOSITION_ENTRY_REVIEW_REQUIRED')
if sys.platform != 'linux' or os.getuid() == 0 or os.getuid() != manifest['acceptanceUid'] or socket.gethostname() != manifest['expectedHostname']:
    raise RuntimeError('APPROVED_HOST_ORDINARY_ACCOUNT_REQUIRED')
if runtime.resolve() != runtime or str(runtime) != manifest['runtime']:
    raise RuntimeError('FORMAL_RUNTIME_CHANGED')
environment = dict(os.environ)
environment.update({'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(scratch), 'TMPDIR': str(scratch), 'HIMAWARI_TEST_TEMP_ROOT': str(scratch), 'HIMAWARI_LIVE_SANDBOX_PROBE': '1', 'HIMAWARI_PROBE_SCRATCH': str(scratch), 'HIMAWARI_PROBE_RUNTIME': str(runtime), 'HIMAWARI_QUALIFY_INSTALLED_RUNTIME': str(runtime), 'NODE_PATH': '', 'NODE_OPTIONS': ''})

def digest(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()

def invoke(name, argv, timeout=900, parse=True, cwd=None):
    started = time.monotonic()
    output_path, error_path = evidence / (name + '.json'), evidence / (name + '.stderr')
    with output_path.open('x') as output, error_path.open('x') as error:
        registered_argv = ['/usr/bin/python3', '-I', str(cleanup_helper), '--run', '--owned-processes', str(registry), '--', *list(map(str, argv))]
        result = subprocess.run(registered_argv, cwd=cwd or base, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=error, timeout=timeout)
    entry = {'name': name, 'argv': list(map(str, argv)), 'registrationCommand': registered_argv, 'cwd': str(cwd or base), 'exitCode': result.returncode, 'durationSeconds': round(time.monotonic() - started, 3), 'stdoutSha256': digest(output_path), 'stderrSha256': digest(error_path)}
    report['commands'].append(entry)
    if result.returncode != 0:
        raise RuntimeError('SUBCOMMAND_FAILED:' + name)
    if not parse:
        return output_path
    value = json.loads(output_path.read_text())
    if not isinstance(value, dict):
        raise RuntimeError('PROBE_JSON_OBJECT_REQUIRED:' + name)
    return value

try:
    invoke('scratch-guard', [node, base / 'adapters/scratch-root-check.mjs', scratch], timeout=30)
    for relative, expected in manifest['files'].items():
        filename = base / relative
        if filename.resolve() != filename or filename.is_symlink() or not filename.is_file() or digest(filename) != expected:
            raise RuntimeError('ACCEPTANCE_SOURCE_CHANGED:' + relative)
    if validator.resolve() != validator or validator.is_symlink() or digest(validator) != manifest['r2l6ValidatorSha256']:
        raise RuntimeError('R2L6_VALIDATOR_CHANGED')
    for key in ['artifact', 'context']:
        if digest(manifest['candidate'][key]) != manifest['candidate'][key + 'Sha256']:
            raise RuntimeError('CANDIDATE_CHANGED:' + key)
    download = manifest['question12Downloads']
    for name, expected in download['files'].items():
        if digest(Path(download['root']) / name) != expected:
            raise RuntimeError('QUESTION12_BYTES_CHANGED:' + name)
    tools = manifest['runtimeTools']
    for tool in tools:
        filename = runtime / 'pi-tools/bin' / tool['name']
        if filename.is_symlink() or filename.resolve() != filename or digest(filename) != tool['sha256']:
            raise RuntimeError('INSTALLED_TOOL_CHANGED:' + tool['name'])
    report['runtimeTools'] = tools
    proof = manifest['compositionEntry']['nodeModulesProof']
    proof_path = Path(proof['path'])
    if proof_path.resolve() != proof_path or proof_path.is_symlink() or digest(proof_path) != proof['sha256']:
        raise RuntimeError('TRANSPORT_NODE_MODULES_PROOF_CHANGED')
    proof_value = json.loads(proof_path.read_text())
    if proof_value['schemaVersion'] != 2 or proof_value['scope'] != 'whole-locked-node-modules' or proof_value['lockCheck']['exitCode'] != 0 or proof_value['packageLockSha256'] != digest(source / 'package-lock.json') or not proof_value['packages'] or not proof_value['entries']:
        raise RuntimeError('WHOLE_LOCKED_NODE_MODULES_REQUIRED')
    shutil.copyfile(proof_path, evidence / 'transport-node-modules-proof.json')
    report['transportNodeModulesProofSha256'] = proof['sha256']
    bwrap = invoke('bwrap-identities', [node, base / 'adapters/inspect-bwrap.mjs', profile, manifest['bwrapPaths']['srt'], manifest['bwrapPaths']['program']], timeout=30)
    report['bwrapIdentities'] = bwrap
    composition_source_root = scratch / 'source'
    if profile == 'cloud-twelfth-change':
        if source.stat().st_uid != 0 or source.stat().st_mode & 0o022:
            raise RuntimeError('ROOT_BOUND_TRANSPORT_SOURCE_REQUIRED')
    else:
        if source.stat().st_uid != os.getuid() or source.stat().st_mode & 0o022:
            raise RuntimeError('OWNED_BOUND_TRANSPORT_SOURCE_REQUIRED')
    if composition_source_root.exists() or composition_source_root.is_symlink():
        raise RuntimeError('NEW_OWNED_COMPOSITION_SOURCE_REQUIRED')
    shutil.copytree(source, composition_source_root, symlinks=True)
    if composition_source_root.resolve() != composition_source_root or composition_source_root.stat().st_uid != os.getuid():
        raise RuntimeError('OWNED_COMPOSITION_COPY_REQUIRED')
    tracked = subprocess.check_output(['/usr/bin/git', '-C', str(composition_source_root), 'ls-files', '-z'], timeout=30).decode().split('\0')
    tracked = [name for name in tracked if name]
    copied_source = []
    for relative in sorted(tracked):
        input_file, output_file = source / relative, composition_source_root / relative
        original_bytes, copied_bytes = input_file.read_bytes(), output_file.read_bytes()
        input_info, output_info = input_file.lstat(), output_file.lstat()
        if not stat.S_ISREG(input_info.st_mode) or not stat.S_ISREG(output_info.st_mode) or output_info.st_uid != os.getuid() or original_bytes != copied_bytes or stat.S_IMODE(input_info.st_mode) != stat.S_IMODE(output_info.st_mode):
            raise RuntimeError('COMPOSITION_TRACKED_SOURCE_COPY_CHANGED:' + relative)
        copied_source.append({'path': relative, 'sha256': hashlib.sha256(copied_bytes).hexdigest(), 'bytes': len(copied_bytes), 'mode': stat.S_IMODE(output_info.st_mode)})
    expected_entries = {entry['path']: entry for entry in proof_value['entries']}
    observed_entries = set()
    def inspect_dependency_tree(entry):
        relative = str(entry.relative_to(composition_source_root))
        info = entry.lstat()
        if relative not in expected_entries or info.st_uid != os.getuid():
            raise RuntimeError('COMPOSITION_MODULE_COPY_UNEXPECTED:' + relative)
        observed_entries.add(relative)
        expected = expected_entries[relative]
        if stat.S_IMODE(info.st_mode) != expected['mode']:
            raise RuntimeError('COMPOSITION_MODULE_COPY_MODE_CHANGED:' + relative)
        if expected['type'] == 'directory' and stat.S_ISDIR(info.st_mode):
            for child in sorted(entry.iterdir()):
                inspect_dependency_tree(child)
        elif expected['type'] == 'file' and stat.S_ISREG(info.st_mode):
            if info.st_size != expected['bytes'] or digest(entry) != expected['sha256']:
                raise RuntimeError('COMPOSITION_MODULE_COPY_BYTES_CHANGED:' + relative)
        elif expected['type'] == 'symlink' and stat.S_ISLNK(info.st_mode):
            target = os.readlink(entry)
            resolved = entry.resolve()
            if target != expected['link'] or Path(target).is_absolute() or resolved != composition_source_root and composition_source_root not in resolved.parents:
                raise RuntimeError('COMPOSITION_MODULE_COPY_LINK_CHANGED:' + relative)
        else:
            raise RuntimeError('COMPOSITION_MODULE_COPY_TYPE_CHANGED:' + relative)
    for relative in proof_value['dependencyRoots']:
        inspect_dependency_tree(composition_source_root / relative)
    if observed_entries != set(expected_entries):
        raise RuntimeError('COMPOSITION_MODULE_COPY_SET_CHANGED')
    copy_report = {'schemaVersion': 'himawari.twelfth-change-composition-source-copy.v1', 'passed': True, 'inputSourceRoot': str(source), 'workingSourceRoot': str(composition_source_root), 'sourceHead': proof_value['sourceHead'], 'sourceFileCount': len(copied_source), 'trackedSourceSha256': hashlib.sha256(json.dumps(copied_source, separators=(',', ':'), sort_keys=True).encode()).hexdigest(), 'nodeModulesProofSha256': proof['sha256'], 'dependencyRoots': proof_value['dependencyRoots'], 'dependencyEntryCount': len(observed_entries), 'allTrackedBytesAndModesMatchedInput': True, 'allDependencyEntriesMatchedProof': True, 'ownerUid': os.getuid()}
    with (evidence / 'composition-source-copy.json').open('x') as output:
        output.write(json.dumps(copy_report, indent=2) + '\n')
    report['compositionSourceCopy'] = copy_report
    report['compositionExecutionSourceRoot'] = str(composition_source_root)
    composition_source = invoke('composition-source-preparation', ['/usr/bin/python3', '-I', base / 'prepare-composition-source.py', '--source', composition_source_root], timeout=180)
    report['compositionSource'] = composition_source
    before = invoke('runtime-before', [node, base / 'adapters/digest-installed-runtime.mjs', runtime], timeout=180)
    report['runtimeDigestBefore'] = before['runtimeDigest']
    pi = invoke('pi-installed', [node, base / 'adapters/probe-foreground.mjs'])
    if pi['passed'] != 22 or pi['qualification'] or not all(row['namespaceState'] == 'released' for row in pi['reports']):
        raise RuntimeError('PI_ASSERTIONS_NOT_SATISFIED')
    for tool in tools:
        if tool['name'] in ['bash', 'rg', 'fd'] and pi['toolDigests'][tool['name']] != tool['sha256']:
            raise RuntimeError('PI_TOOL_DIGEST_MISMATCH')
    report['assertions'].append({'name': 'installed-pi-22-scenarios', 'passed': True, 'scenarioCount': 22})
    composition = invoke('composition-installed', [node, composition_source_root / 'packages/runtime-sandbox/scripts/qualify-production.mjs', '--v2'], timeout=600, cwd=composition_source_root)
    if composition['productionSandboxProbePassed'] is not True or composition['installedRuntime'] != str(runtime) or composition['cleanup'] != 'confirmed' or composition['replayExecuted'] is not False:
        raise RuntimeError('COMPOSITION_ASSERTIONS_NOT_SATISFIED')
    network = invoke('network-installed', [node, base / 'adapters/probe-authorized-network.mjs'])
    if network['passed'] is not True or network['productionSuitable'] or len(network['evidence']) != 10 or not all(row['passed'] and row['namespaceState'] == 'released' and row['network']['closed'] for row in network['evidence']):
        raise RuntimeError('NETWORK_ASSERTIONS_NOT_SATISFIED')
    for row in network['evidence']:
        if row['scenario'] in ['download', 'socks-download'] and row['artifactSha256'] != download['referenceSha256']:
            raise RuntimeError('NETWORK_DOWNLOAD_BYTES_MISMATCH')
    report['assertions'].append({'name': 'authorized-network-ten-scenarios', 'passed': True, 'scenarioCount': 10})
    boundary = invoke('boundary-installed', [node, base / 'adapters/probe-network-boundary.mjs'], timeout=600)
    if len(boundary['evidence']) != 7 or not all(row['denialObserved'] and row['namespaceState'] == 'released' and row['network']['closed'] for row in boundary['evidence']):
        raise RuntimeError('BOUNDARY_ASSERTIONS_NOT_SATISFIED')
    worker_loss = invoke('worker-loss-installed', [node, base / 'adapters/probe-linux-worker-loss.mjs'], timeout=600)
    if worker_loss['passed'] is not True:
        raise RuntimeError('WORKER_LOSS_ASSERTIONS_NOT_SATISFIED')
    search = invoke('web-search-installed', [node, base / 'adapters/probe-public-search.mjs'], timeout=600)
    if search['passed'] is not True or search['installedRuntime'] != str(runtime) or len(search['evidence']) != 3 or not all(row['passed'] and row['namespaceState'] == 'released' and row['network']['closed'] for row in search['evidence']):
        raise RuntimeError('PUBLIC_SEARCH_ASSERTIONS_NOT_SATISFIED')
    r2l6_output = evidence / 'r2l6'
    r2l6_output.mkdir(mode=0o700)
    invoke('r2l6-console', [node, base / 'probe-source/test/qualification/sandbox-install-restart-probe.mjs', '--runtime', runtime, '--scratch', scratch, '--output', r2l6_output, '--audit-script', base / 'probe-source/scripts/operations/workspace-lifecycle-audit.mjs', '--artifact', manifest['candidate']['artifact'], '--context', manifest['candidate']['context']], timeout=600, parse=False)
    shutil.copyfile(r2l6_output / 'report.json', evidence / 'r2l6-installed.json')
    invoke('r2l6-validation', [node, validator, '--runtime', runtime, '--report', evidence / 'r2l6-installed.json'], timeout=180)
    invoke('composition-source-after', ['/usr/bin/python3', '-I', base / 'prepare-composition-source.py', '--source', composition_source_root, '--check'], timeout=180)
    after = invoke('runtime-after', [node, base / 'adapters/digest-installed-runtime.mjs', runtime], timeout=180)
    if before['runtimeDigest'] != after['runtimeDigest']:
        raise RuntimeError('INSTALLED_RUNTIME_CHANGED_DURING_PROBES')
    for tool in tools:
        if digest(runtime / 'pi-tools/bin' / tool['name']) != tool['sha256']:
            raise RuntimeError('INSTALLED_TOOL_CHANGED_DURING_PROBES')
    for key in ['artifact', 'context']:
        if digest(manifest['candidate'][key]) != manifest['candidate'][key + 'Sha256']:
            raise RuntimeError('CANDIDATE_CHANGED_DURING_PROBES')
    report['runtimeDigestAfter'] = after['runtimeDigest']
    report['assertions'].append({'name': 'installation-bytes-unchanged', 'passed': True})
    report['passed'] = True
finally:
    if 'runtimeDigestBefore' in report and 'runtimeDigestAfter' not in report:
        try:
            after = invoke('runtime-after-failure', [node, base / 'adapters/digest-installed-runtime.mjs', runtime], timeout=180)
            report['runtimeDigestAfter'] = after['runtimeDigest']
            if report['runtimeDigestBefore'] != report['runtimeDigestAfter']:
                report['runtimeIntegrityFailure'] = 'INSTALLED_RUNTIME_CHANGED_DURING_PROBES'
                report['passed'] = False
        except Exception as error:
            report['runtimeIntegrityFailure'] = str(error)
            report['passed'] = False
    (evidence / 'acceptance-report.json').write_text(json.dumps(report, indent=2) + '\n')
