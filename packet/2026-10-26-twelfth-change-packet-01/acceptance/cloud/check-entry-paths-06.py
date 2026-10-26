import argparse
import ast
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--packet-directory', required=True)
parser.add_argument('--manifest', required=True)
arguments = parser.parse_args()
root = Path(arguments.packet_directory)
if not root.is_absolute() or root.resolve() != root or root.is_symlink():
    raise RuntimeError('PACKET_DIRECTORY_CANONICAL_REQUIRED')
manifest = json.loads(Path(arguments.manifest).read_text())
if manifest['schema'] != 'himawari-twelfth-cloud-acceptance-inputs.v1':
    raise RuntimeError('ACCEPTANCE_INPUT_SCHEMA_REQUIRED')
files = []
for relative, expected in sorted(manifest['files'].items()):
    path = root / relative
    if Path(relative).is_absolute() or '..' in Path(relative).parts or path.resolve() != path or path.is_symlink() or not path.is_file():
        raise RuntimeError('PACKET_FILE_UNSAFE:' + relative)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError('PACKET_FILE_CHANGED:' + relative)
    if path.suffix == '.py':
        ast.parse(path.read_text(), filename=str(path))
    files.append({'path': str(path), 'sha256': actual})
required = ['prepare-composition-source.py', 'composition-source-contract.json', 'composition-scratch.patch', 'adapters/inspect-bwrap.mjs', 'run-stage-03.py', 'run-network-preparation.py', 'adapters/scratch-root.mjs', 'adapters/scratch-root-check.mjs', 'adapters/proc-sampler.py', 'adapters/failure-scene.py', 'adapters/probe-foreground.mjs', 'adapters/probe-authorized-network.mjs', 'adapters/probe-network-boundary.mjs', 'adapters/probe-linux-worker-loss.mjs', 'adapters/probe-public-search.mjs', 'probe-source/test/qualification/sandbox-install-restart-probe.mjs', 'probe-source/test/qualification/sandbox-install-restart-controller.py', 'probe-source/test/qualification/sandbox-install-restart-model.mjs', 'probe-source/test/qualification/sandbox-install-restart-http.mjs', 'probe-source/scripts/operations/workspace-lifecycle-audit.mjs']
if any(name not in manifest['files'] for name in required):
    raise RuntimeError('REQUIRED_ACCEPTANCE_SOURCE_MISSING')
if not all((root / name).read_text().startswith('import { validateScratchRoot } from "./scratch-root.mjs";') for name in ['adapters/probe-foreground.mjs', 'adapters/probe-authorized-network.mjs', 'adapters/probe-network-boundary.mjs', 'adapters/probe-linux-worker-loss.mjs', 'adapters/probe-public-search.mjs']):
    raise RuntimeError('SCRATCH_GUARD_IMPORT_REQUIRED')
if manifest['profile'] not in ['cloud-twelfth-change', 'hermes-rehearsal'] or manifest['bwrapPaths']['srt'] != '/usr/bin/bwrap':
    raise RuntimeError('EXPLICIT_HOST_PROFILE_AND_SRT_PATH_REQUIRED')
if manifest['compositionEntry']['status'] != 'ready' or manifest['compositionEntry']['argv'] != [manifest['sourceRoot'] + '/packages/runtime-sandbox/scripts/qualify-production.mjs', '--v2']:
    raise RuntimeError('ORIGINAL_COMPOSITION_SOURCE_ENTRY_REQUIRED')
helper = Path(manifest['cleanupHelper']['path'])
if helper.is_file():
    if helper.resolve() != helper or helper.is_symlink() or hashlib.sha256(helper.read_bytes()).hexdigest() != manifest['cleanupHelper']['sha256']:
        raise RuntimeError('CLEANUP_HELPER_CHANGED')
print(json.dumps({'passed': True, 'outerAcceptanceEntryExecuted': False, 'method': 'JSON and Python AST readback; no import or execution of acceptance entries', 'files': files, 'compositionReady': manifest['compositionEntry']['status'] == 'ready', 'cleanupHelperObservedAtDeclaredPath': helper.is_file(), 'profile': manifest['profile'], 'productionQualificationIssued': False, 'draftUnresolvedFields': ['expectedHostname', 'acceptanceUid', 'question12Downloads', 'runtimeTools', 'compositionEntry.nodeModulesProof']}))
