import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys

runtime = Path('/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent')
node = Path('/opt/himawari/node/bin/node')
os.umask(0o022)
profile = 'cloud-__PKT_LABEL__-change'
if len(sys.argv) == 5 and sys.argv[1] == '--approved-rehearsal-tool-preparation':
    profile = 'hermes-rehearsal'
    runtime, node, manifest_path = map(Path, sys.argv[2:])
    if manifest_path.resolve() != manifest_path or manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError('REHEARSAL_TEMPLATE_UNSAFE')
    manifest = json.loads(manifest_path.read_text())
    download_root = Path(manifest['question12Downloads']['root'])
    owner_uid = os.getuid()
    roots = [value for value in runtime.parents if str(value).startswith('/tmp/h') and len(str(value).encode()) == 10]
    if sys.platform != 'linux' or socket.gethostname() != 'hermes-home' or owner_uid == 0 or len(roots) != 1 or roots[0] not in node.parents:
        raise RuntimeError('HERMES_OWNED_TOOL_PREPARATION_REQUIRED')
elif len(sys.argv) == 3 and sys.argv[1] == '--approved-s6-tool-preparation':
    owner_uid = 0
    download_root = Path(sys.argv[2])
    if sys.platform != 'linux' or os.geteuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__':
        raise RuntimeError('EXPLICIT_ROOT_TOOL_PREPARATION_APPROVAL_REQUIRED')
else:
    raise RuntimeError('EXPLICIT_TOOL_PREPARATION_PROFILE_REQUIRED')
if download_root.resolve() != download_root or download_root.is_symlink():
    raise RuntimeError('DOWNLOAD_ROOT_UNSAFE')
report = json.loads((download_root / 'download-report.json').read_text())
if not report['passed']:
    raise RuntimeError('DOWNLOAD_REPORT_NOT_PASSED')
if profile == 'hermes-rehearsal':
    for name, expected in manifest['question12Downloads']['files'].items():
        source = download_root / name
        if source.resolve() != source or source.is_symlink() or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise RuntimeError('REHEARSAL_CACHED_INPUT_CHANGED:' + name)
if runtime.resolve() != runtime or not runtime.is_dir() or runtime.stat().st_uid != owner_uid:
    raise RuntimeError('FORMAL_RUNTIME_UNSAFE')
binaries = runtime / 'pi-tools/bin'
if binaries.exists() and (binaries.resolve() != binaries or not binaries.is_dir() or binaries.stat().st_uid != owner_uid):
    raise RuntimeError('TOOL_DIRECTORY_UNSAFE')
binaries.mkdir(mode=0o755, parents=True, exist_ok=True)
sources = [('node', node), ('bash', Path('/usr/bin/bash')), ('rg', Path('/usr/bin/rg')), ('fd', download_root / 'fd')]
records = []
for name, source in sources:
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or source.is_symlink() or source.resolve() != source:
        raise RuntimeError('TOOL_SOURCE_UNSAFE:' + name)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    if name == 'fd' and before != report['fdBinarySha256']:
        raise RuntimeError('FD_DOWNLOAD_CHANGED')
    target = binaries / name
    with target.open('xb') as output, source.open('rb') as input_file:
        shutil.copyfileobj(input_file, output)
    target.chmod(0o755)
    after = hashlib.sha256(target.read_bytes()).hexdigest()
    if after != before or source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != before:
        raise RuntimeError('COPIED_TOOL_CHANGED:' + name)
    version = subprocess.check_output([str(target), '--version'], timeout=15, text=True).splitlines()[0]
    if name == 'node' and version != 'v22.22.3':
        raise RuntimeError('NODE_VERSION_MISMATCH')
    if name == 'fd' and version != 'fd 10.5.0':
        raise RuntimeError('FD_VERSION_MISMATCH')
    records.append({'name': name, 'source': str(source), 'target': str(target), 'sha256': after, 'version': version})
print(json.dumps({'passed': True, 'profile': profile, 'productionQualificationIssued': False, 'runtime': str(runtime), 'runtimeTools': records}))
