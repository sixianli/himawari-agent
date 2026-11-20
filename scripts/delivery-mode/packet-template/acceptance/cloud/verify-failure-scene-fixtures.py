import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

base = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('failure_scene', base / 'adapters/failure-scene.py')
scene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)
results = []

def check(name, condition):
    results.append({'name': name, 'passed': bool(condition)})

with tempfile.TemporaryDirectory(prefix='hfs') as root:
    root = Path(root)
    scratch = root / 'scratch'
    evidence = root / 'evidence'
    scratch.mkdir(mode=0o700)
    evidence.mkdir(mode=0o700)
    runtime = scratch / 'install/runtime/node_modules/pkg'
    runtime.mkdir(parents=True)
    big_runtime = runtime / 'index.json'
    big_runtime.write_bytes(b'{}' * 1000)
    blob = scratch / 'install/runtime/lib.bin'
    blob.write_bytes(os.urandom(3 * 1024 * 1024))
    reports = scratch / 'reports'
    reports.mkdir()
    (reports / 'acceptance-report.json').write_text('{"passed": false}\n')
    (reports / 'service.log').write_text('line\n' * 100)
    huge_log = reports / 'huge.log'
    huge_log.write_bytes(b'x' * (2 * 1024 * 1024))
    (reports / 'link-to-blob').symlink_to(blob)
    outside = root / 'outside.txt'
    outside.write_text('outside\n')
    (reports / 'link-outside.txt').symlink_to(outside)
    before = sorted(str(path.relative_to(scratch)) for path in scratch.rglob('*'))

    retained = scene.retain_failure_scene(scratch, evidence)
    manifest = json.loads((evidence / 'scratch-failure-manifest.json').read_text())
    entries = {entry['path']: entry for entry in manifest['entries']}
    copies = evidence / 'scratch-failure-files'

    check('scene left in place', sorted(str(path.relative_to(scratch)) for path in scratch.rglob('*')) == before)
    check('every scratch entry listed', sorted(entries) == before)
    check('blob listed with its digest', entries['install/runtime/lib.bin']['sha256'] == hashlib.sha256(blob.read_bytes()).hexdigest())
    check('blob not copied', not (copies / 'install/runtime/lib.bin').exists())
    check('node_modules text not copied', not (copies / 'install/runtime/node_modules/pkg/index.json').exists() and 'copied' not in entries['install/runtime/node_modules/pkg/index.json'])
    check('small report copied byte for byte', (copies / 'reports/acceptance-report.json').read_bytes() == (reports / 'acceptance-report.json').read_bytes())
    check('small log copied', (copies / 'reports/service.log').is_file())
    check('oversized log skipped and named', not (copies / 'reports/huge.log').exists() and manifest['textFilesSkippedForSize'] == ['reports/huge.log'])
    check('symlink recorded without following', entries['reports/link-to-blob']['type'] == 'symlink' and entries['reports/link-to-blob']['target'] == str(blob))
    check('symlinked text outside scratch not copied', not (copies / 'reports/link-outside.txt').exists())
    check('copied directory is private', stat.S_IMODE(copies.stat().st_mode) == 0o700)
    evidence_bytes = sum(path.stat().st_size for path in evidence.rglob('*') if path.is_file() and not path.is_symlink())
    check('evidence far smaller than scene', evidence_bytes < 200 * 1024)
    check('return value points to manifest', retained['manifestSha256'] == hashlib.sha256((evidence / 'scratch-failure-manifest.json').read_bytes()).hexdigest() and retained['sceneLeftInPlace'] is True)
    try:
        scene.retain_failure_scene(scratch, evidence)
        check('second call refuses to overwrite', False)
    except FileExistsError:
        check('second call refuses to overwrite', True)

with tempfile.TemporaryDirectory(prefix='hfv') as root:
    root = Path(root)
    scratch = root / 'scratch'
    evidence = root / 'evidence'
    scratch.mkdir(mode=0o700)
    evidence.mkdir(mode=0o700)
    (scratch / 'kept.log').write_text('kept\n')
    vanishing = scratch / 'node-compile-cache.tmp.json'
    vanishing.write_text('{}\n')
    original_sha256 = scene.file_sha256

    def sha256_then_vanish(filename):
        if filename == vanishing:
            vanishing.unlink()
        return original_sha256(filename)

    scene.file_sha256 = sha256_then_vanish
    try:
        scene.retain_failure_scene(scratch, evidence)
        vanished_manifest = json.loads((evidence / 'scratch-failure-manifest.json').read_text())
        vanished_entries = {entry['path']: entry for entry in vanished_manifest['entries']}
        check('file vanishing mid-walk is marked vanished', vanished_entries.get('node-compile-cache.tmp.json') == {'path': 'node-compile-cache.tmp.json', 'type': 'vanished'})
        check('other entries still recorded after a vanished file', vanished_entries.get('kept.log', {}).get('copied') is True)
    except FileNotFoundError:
        check('file vanishing mid-walk is marked vanished', False)
    finally:
        scene.file_sha256 = original_sha256

passed = all(result['passed'] for result in results)
print(json.dumps({'schema': 'himawari-__PKT_LABEL__-failure-scene-fixtures.v1', 'passed': passed, 'results': results}, indent=1))
sys.exit(0 if passed else 1)
