import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys

stage = Path('/var/tmp/himawari-twelfth-20261026')
base = stage / 'packet/acceptance/cloud'
runtime = Path('/opt/himawari/releases/2026-10-26-twelfth/lib/himawari-agent')
node = Path('/opt/himawari/node/bin/node')
source = stage / 'validation/source'
account = pwd.getpwnam('himawari-prod')
if sys.platform != 'linux' or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1 or os.geteuid() != 0 or socket.gethostname() != 'vmi3618928' or sys.argv[1:] != ['--approved-s6-manifest-publication'] or account.pw_uid <= 0:
    raise RuntimeError('EXPLICIT_CLOUD_ROOT_MANIFEST_APPROVAL_REQUIRED')
os.umask(0o077)

def directory(filename, uid, mode=None):
    info = filename.lstat()
    if not stat.S_ISDIR(info.st_mode) or filename.resolve() != filename or filename.is_symlink() or info.st_uid != uid or info.st_mode & 0o022 or mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('PUBLIC_DIRECTORY_UNSAFE:' + str(filename))
    return info

def read(filename, uid):
    before = filename.lstat()
    if not stat.S_ISREG(before.st_mode) or filename.resolve() != filename or filename.is_symlink() or before.st_uid != uid or before.st_nlink != 1 or before.st_mode & 0o022:
        raise RuntimeError('PUBLIC_FILE_UNSAFE:' + str(filename))
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as input_file:
            data = input_file.read()
        after = os.fstat(descriptor)
        current = filename.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(after) or identity(after) != identity(current):
            raise RuntimeError('PUBLIC_FILE_CHANGED_DURING_READ:' + str(filename))
        return data
    finally:
        os.close(descriptor)

def sha(data):
    return hashlib.sha256(data).hexdigest()

for filename in [stage, stage / 'packet', stage / 'packet/acceptance', base, stage / 'input', stage / 'validation']:
    directory(filename, 0)
directory(runtime, 0)
directory(source, 0)
directory(stage / 'acceptance', account.pw_uid, 0o700)
manifest = json.loads(read(base / 'cloud-inputs.draft.json', 0))
if manifest['schema'] != 'himawari-twelfth-cloud-acceptance-inputs.v1' or manifest['profile'] != 'cloud-twelfth-change' or manifest['runtime'] != str(runtime) or manifest['node'] != str(node) or manifest['sourceRoot'] != str(source) or manifest['rehearsalRoot'] is not None or manifest['evidenceRoot'] != str(stage / 'acceptance') or manifest['acceptanceAccount'] != account.pw_name or manifest['productionQualificationIssued'] is not False:
    raise RuntimeError('FIXED_CLOUD_MANIFEST_REQUIRED')
if manifest['bwrapPaths'] != {'srt': '/usr/bin/bwrap', 'program': '/usr/local/libexec/bubblewrap-0.11.2/bwrap'} or manifest['compositionEntry']['status'] != 'ready' or manifest['compositionEntry']['argv'] != [str(source / 'packages/runtime-sandbox/scripts/qualify-production.mjs'), '--v2'] or manifest['compositionEntry']['precompiled'] is not False:
    raise RuntimeError('FIXED_CLOUD_COMPOSITION_REQUIRED')
expected_candidate = {'artifact': str(stage / 'input/candidate.tar.gz'), 'artifactSha256': '4b341bf8a592fef141c4bf50b13c8fa081cffc9055d5afa4e9f7b0a6de3f8bdc', 'artifactBytes': 64137729, 'context': str(stage / 'input/context.json'), 'contextSha256': 'fbaa323e556c7e243263334fc554c1bb6e438027841b95bfb3cace775c5f29af', 'revision': '470b6d30a8664d5f85da2a8b261b59a4f5f18704'}
if manifest['candidate'] != expected_candidate or manifest['compositionEntry']['sourceRevision'] != expected_candidate['revision']:
    raise RuntimeError('FIXED_CANDIDATE_IDENTITY_REQUIRED')
for relative, expected in manifest['files'].items():
    filename = base / relative
    if not relative or Path(relative).is_absolute() or '..' in Path(relative).parts or sha(read(filename, 0)) != expected:
        raise RuntimeError('BOUND_ACCEPTANCE_SOURCE_CHANGED:' + relative)
validator = stage / 'packet/acceptance/helpers/validate-r2l6-installed.mjs'
if sha(read(validator, 0)) != manifest['r2l6ValidatorSha256']:
    raise RuntimeError('BOUND_R2L6_VALIDATOR_CHANGED')
helper = stage / 'packet/acceptance/helpers/check-p5-scratch-cleanup.py'
if manifest['cleanupHelper']['path'] != str(helper) or sha(read(helper, 0)) != manifest['cleanupHelper']['sha256']:
    raise RuntimeError('BOUND_CLEANUP_HELPER_CHANGED')
for name in ['artifact', 'context']:
    filename = stage / 'input' / ('candidate.tar.gz' if name == 'artifact' else 'context.json')
    data = read(filename, 0)
    if manifest['candidate'][name] != str(filename) or sha(data) != manifest['candidate'][name + 'Sha256'] or name == 'artifact' and len(data) != manifest['candidate']['artifactBytes']:
        raise RuntimeError('CANDIDATE_INPUT_CHANGED:' + name)
proof_path = stage / 'input/node-modules.json'
proof_bytes = read(proof_path, 0)
proof = json.loads(proof_bytes)
if proof['schemaVersion'] != 2 or proof['scope'] != 'whole-locked-node-modules' or proof['sourceHead'] != manifest['candidate']['revision'] or proof['node'] != 'v22.22.3' or proof['lockCheck']['exitCode'] != 0 or not proof['packages'] or not proof['entries'] or proof['packageLockSha256'] != sha(read(source / 'package-lock.json', 0)):
    raise RuntimeError('ACTUAL_WHOLE_LOCKED_NODE_MODULES_PROOF_REQUIRED')
if manifest['compositionEntry']['nodeModulesProof']['path'] != str(proof_path):
    raise RuntimeError('FIXED_WHOLE_MODULES_PROOF_PATH_REQUIRED')
manifest['compositionEntry']['nodeModulesProof']['sha256'] = sha(proof_bytes)
downloads = stage / 'acceptance/question-12-downloads'
if manifest['question12Downloads']['root'] != str(downloads):
    raise RuntimeError('FIXED_REFERENCE_DOWNLOAD_ROOT_REQUIRED')
directory(downloads, account.pw_uid, 0o700)
download_report = json.loads(read(downloads / 'download-report.json', account.pw_uid))
if download_report['passed'] is not True:
    raise RuntimeError('ACTUAL_REFERENCE_DOWNLOAD_REPORT_REQUIRED')
for name, expected in manifest['question12Downloads']['files'].items():
    if sha(read(downloads / name, account.pw_uid)) != expected:
        raise RuntimeError('REFERENCE_DOWNLOAD_CHANGED:' + name)
if sha(read(downloads / 'fd', account.pw_uid)) != download_report['fdBinarySha256'] or sha(read(downloads / 'is-number-7.0.0.tgz', account.pw_uid)) != manifest['question12Downloads']['referenceSha256']:
    raise RuntimeError('REFERENCE_DOWNLOAD_REPORT_MISMATCH')
tool_report_path = stage / 'acceptance/runtime-tool-preparation.json'
tool_report = json.loads(read(tool_report_path, 0))
if tool_report['passed'] is not True or tool_report['profile'] != 'cloud-twelfth-change' or tool_report['runtime'] != str(runtime) or tool_report['productionQualificationIssued'] is not False or [entry['name'] for entry in tool_report['runtimeTools']] != ['node', 'bash', 'rg', 'fd']:
    raise RuntimeError('ACTUAL_FORMAL_TOOL_PREPARATION_REQUIRED')
tools = []
for entry in tool_report['runtimeTools']:
    filename = runtime / 'pi-tools/bin' / entry['name']
    if entry['target'] != str(filename) or not filename.lstat().st_mode & 0o111 or sha(read(filename, 0)) != entry['sha256']:
        raise RuntimeError('ACTUAL_INSTALLED_TOOL_CHANGED:' + entry['name'])
    tools.append({'name': entry['name'], 'sha256': entry['sha256']})
if tool_report['runtimeTools'][0]['version'] != 'v22.22.3' or tool_report['runtimeTools'][3]['version'] != 'fd 10.5.0' or sha(read(node, 0)) != tools[0]['sha256']:
    raise RuntimeError('ACTUAL_LOCKED_TOOLCHAIN_MISMATCH')
manifest.update({'status': 'public-site-inputs-not-acceptance-proof', 'expectedHostname': socket.gethostname(), 'acceptanceUid': account.pw_uid, 'runtimeTools': tools})
if 'REPLACE_' in json.dumps(manifest):
    raise RuntimeError('UNRESOLVED_PUBLIC_MANIFEST_FIELD')
target = base / 'cloud-inputs.json'
payload = (json.dumps(manifest, indent=2) + '\n').encode()
with target.open('xb') as output:
    output.write(payload)
os.chown(target, 0, account.pw_gid, follow_symlinks=False)
target.chmod(0o640)
if read(target, 0) != payload or target.stat().st_gid != account.pw_gid or stat.S_IMODE(target.stat().st_mode) != 0o640:
    raise RuntimeError('PUBLISHED_CLOUD_INPUTS_READBACK_FAILED')
print(json.dumps({'passed': True, 'productionQualificationIssued': False, 'hostname': socket.gethostname(), 'acceptanceAccount': account.pw_name, 'acceptanceUid': account.pw_uid, 'output': {'path': str(target), 'bytes': len(payload), 'sha256': sha(payload), 'uid': target.stat().st_uid, 'gid': target.stat().st_gid, 'mode': '0640'}, 'toolPreparationSha256': sha(read(tool_report_path, 0)), 'nodeModulesProofSha256': sha(proof_bytes)}))
