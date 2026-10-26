import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--check', action='store_true')
arguments = parser.parse_args()
source = Path(arguments.source)
if sys.platform != 'linux' or os.getuid() == 0:
    raise RuntimeError('LINUX_ORDINARY_ACCOUNT_REQUIRED')
if not source.is_absolute() or source.resolve() != source or source.is_symlink() or not source.is_dir() or source.stat().st_uid != os.getuid():
    raise RuntimeError('OWNED_TRANSPORT_SOURCE_REQUIRED')
revision = '470b6d30a8664d5f85da2a8b261b59a4f5f18704'
fixture = 'test/qualification/sandbox-production-mac-probe.ts'
script = 'packages/runtime-sandbox/scripts/qualify-production.mjs'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True, timeout=15).strip()
if head != revision:
    raise RuntimeError('TRANSPORT_SOURCE_REVISION_CHANGED')
original = subprocess.check_output(['git', 'show', 'HEAD:' + fixture], cwd=source, timeout=15)
text = original.decode()
replacements = {
    'await mkdtemp("/tmp/h-v2-")': 'await mkdtemp(`${process.env.HIMAWARI_TEST_TEMP_ROOT}/v`)',
    'await mkdtemp("/tmp/h-live-")': 'await mkdtemp(`${process.env.HIMAWARI_TEST_TEMP_ROOT}/l`)',
}
for before, after in replacements.items():
    if text.count(before) != 1:
        raise RuntimeError('ORIGINAL_COMPOSITION_SCRATCH_PATH_CHANGED')
    text = text.replace(before, after)
adapted = text.encode()
target = source / fixture
metadata = target.lstat()
if not stat.S_ISREG(metadata.st_mode) or target.is_symlink() or target.resolve() != target or metadata.st_uid != os.getuid():
    raise RuntimeError('COMPOSITION_FIXTURE_UNSAFE')
before_status = subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, text=True, timeout=15)
if not arguments.check:
    if before_status or target.read_bytes() != original:
        raise RuntimeError('CLEAN_ORIGINAL_TRANSPORT_SOURCE_REQUIRED')
    target.write_bytes(adapted)
if target.read_bytes() != adapted:
    raise RuntimeError('COMPOSITION_PATH_ADAPTATION_CHANGED')
changed = subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=source, text=True, timeout=15).splitlines()
if changed != [fixture]:
    raise RuntimeError('ONLY_COMPOSITION_SCRATCH_PATH_CHANGE_ALLOWED')
script_bytes = (source / script).read_bytes()
if script_bytes != subprocess.check_output(['git', 'show', 'HEAD:' + script], cwd=source, timeout=15):
    raise RuntimeError('ORIGINAL_COMPOSITION_ENTRY_CHANGED')
patch = subprocess.check_output(['git', 'diff', '--no-ext-diff', '--full-index', 'HEAD', '--', fixture], cwd=source, timeout=15)
contract_path = Path(__file__).resolve().parent / 'composition-source-contract.json'
contract = json.loads(contract_path.read_text())
if hashlib.sha256(original).hexdigest() != contract['originalFixtureSha256'] or hashlib.sha256(adapted).hexdigest() != contract['adaptedFixtureSha256'] or hashlib.sha256(patch).hexdigest() != contract['patchSha256'] or hashlib.sha256(script_bytes).hexdigest() != contract['entrySha256']:
    raise RuntimeError('COMPOSITION_SOURCE_CONTRACT_CHANGED')
print(json.dumps({
    'schema': 'himawari-twelfth-deployment-composition-source.v1',
    'passed': True,
    'productionQualificationIssued': False,
    'sourceRoot': str(source),
    'revision': revision,
    'checkedOnly': arguments.check,
    'cleanBeforePreparation': not arguments.check,
    'changedFiles': [fixture],
    'originalFixtureSha256': hashlib.sha256(original).hexdigest(),
    'adaptedFixtureSha256': hashlib.sha256(adapted).hexdigest(),
    'entrySha256': hashlib.sha256(script_bytes).hexdigest(),
    'packageLockSha256': hashlib.sha256((source / 'package-lock.json').read_bytes()).hexdigest(),
    'patchSha256': hashlib.sha256(patch).hexdigest(),
    'patch': patch.decode(),
    'scratchRootBytes': 10,
    'maximumHostRootBytes': 18,
    'maximumPrivateRootBytes': 20,
    'unchangedAssertionsDeadlinesAndProductImports': True,
}))
