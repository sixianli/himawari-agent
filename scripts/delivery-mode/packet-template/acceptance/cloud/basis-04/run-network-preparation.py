import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request

base = Path('/data/hermes/himawari/tool-audit-round2/r30')
evidence = base / 'evidence/r64/host-acceptance-preparation-04'
source = Path('/home/andy/himawari-tests/round2/source')
node = base / 'tools/bin/node'
fd_url = 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-__PKT_FD_TRIPLE__.tar.gz'
fd_sha256 = '__PKT_FD_SHA256__'
package_url = 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'
package_integrity = '41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=='
report = {'productionQualificationIssued': False, 'cloudOperations': False, 'commands': [], 'assertions': [], 'downloads': []}
environment = dict(os.environ)

def digest(value):
    return hashlib.sha256(Path(value).read_bytes()).hexdigest()

class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != 'https' or target.hostname not in ['github.com', 'release-assets.githubusercontent.com', 'registry.npmjs.org']:
            raise RuntimeError('DOWNLOAD_REDIRECT_NOT_APPROVED')
        return super().redirect_request(request, fp, code, message, headers, newurl)

def download(url, limit):
    opener = urllib.request.build_opener(ReleaseRedirect())
    started = time.monotonic()
    with opener.open(url, timeout=15) as response:
        chunks = []
        size = 0
        while True:
            if time.monotonic() - started >= 120:
                raise RuntimeError('DOWNLOAD_DEADLINE_EXCEEDED')
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise RuntimeError('DOWNLOAD_SIZE_EXCEEDED')
            chunks.append(chunk)
    data = b''.join(chunks)
    report['downloads'].append({'url': url, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'durationSeconds': round(time.monotonic() - started, 3)})
    return data

def invoke(name, argv, timeout=900):
    started = time.monotonic()
    with (evidence / (name + '.stdout')).open('x') as out, (evidence / (name + '.stderr')).open('x') as err:
        result = subprocess.run(list(map(str, argv)), cwd=source, env=environment, stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=timeout)
    item = {'name': name, 'argv': list(map(str, argv)), 'exitCode': result.returncode, 'durationSeconds': round(time.monotonic() - started, 3), 'stdoutSha256': digest(evidence / (name + '.stdout')), 'stderrSha256': digest(evidence / (name + '.stderr'))}
    report['commands'].append(item)
    print(json.dumps(item), flush=True)
    if result.returncode:
        raise RuntimeError('SUBCOMMAND_FAILED:' + name)
    return (evidence / (name + '.stdout')).read_text()

if sys.argv[1:] == ['--check-plan-only']:
    print(json.dumps({'fd': {'url': fd_url, 'sha256': fd_sha256, 'compressedLimitBytes': 4 * 1024**2}, 'isNumber': {'url': package_url, 'sha512': package_integrity, 'referenceDownloadLimitBytes': 1024**2}, 'executionEnabled': False}))
    sys.exit(0)
if len(sys.argv) != 3 or sys.argv[1] != '--approved-question-12':
    raise RuntimeError('QUESTION_12_APPROVAL_REQUIRED')
if socket.gethostname() != 'hermes-home' or os.geteuid() == 0:
    raise RuntimeError('HERMES_ORDINARY_ACCOUNT_REQUIRED')
scratch = Path(sys.argv[2])
environment.update({'HIMAWARI_LIVE_SANDBOX_PROBE': '1', 'HIMAWARI_PROBE_SCRATCH': str(scratch)})

try:
    invoke('network-preparation-guard', [node, evidence / 'scratch-root-check.mjs', scratch], timeout=30)
    if Path('/data').stat().st_dev == Path('/').stat().st_dev or shutil.disk_usage('/').free < 10 * 1024**3:
        raise RuntimeError('DISK_PREFLIGHT_FAILED')
    inputs = json.loads((evidence / 'candidate-inputs.json').read_text())
    if digest(inputs['artifact']) != inputs['artifactSha256'] or digest(inputs['context']) != inputs['contextSha256']:
        raise RuntimeError('CANDIDATE_CHANGED')
    manifest = json.loads((evidence / 'adaptation-manifest.json').read_text())
    if digest(evidence / 'scratch-root.mjs') != manifest['scratchValidatorSha256']:
        raise RuntimeError('GUARD_CHANGED')
    for item in manifest['adapters']:
        if digest(source / item['source']) != item['sourceSha256'] or digest(evidence / item['adapter']) != item['adapterSha256']:
            raise RuntimeError('ADAPTER_CHANGED')
    fd_archive = download(fd_url, 4 * 1024**2)
    if hashlib.sha256(fd_archive).hexdigest() != fd_sha256:
        raise RuntimeError('FD_RELEASE_DIGEST_MISMATCH')
    fd_payload = None
    with tarfile.open(fileobj=io.BytesIO(fd_archive), mode='r:gz') as archive:
        total = 0
        members = archive.getmembers()
        if len(members) > 100:
            raise RuntimeError('FD_ARCHIVE_MEMBER_LIMIT')
        for member in members:
            name = Path(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('FD_ARCHIVE_UNSAFE')
            total += member.size
            if total > 8 * 1024**2:
                raise RuntimeError('FD_ARCHIVE_SIZE_LIMIT')
            if member.name == 'fd-v10.5.0-__PKT_FD_TRIPLE__/fd':
                if fd_payload is not None or not member.isfile():
                    raise RuntimeError('FD_ARCHIVE_BINARY_AMBIGUOUS')
                fd_payload = archive.extractfile(member).read()
    if not fd_payload or not fd_payload.startswith(b'\x7fELF'):
        raise RuntimeError('FD_BINARY_MISSING')
    reference = download(package_url, 1024**2)
    if base64.b64encode(hashlib.sha512(reference).digest()).decode() != package_integrity:
        raise RuntimeError('IS_NUMBER_INTEGRITY_MISMATCH')
    download_root = evidence / 'question-12-downloads'
    download_root.mkdir(mode=0o700)
    (download_root / 'fd-v10.5.0-__PKT_FD_TRIPLE__.tar.gz').write_bytes(fd_archive)
    fd_file = download_root / 'fd'
    fd_file.write_bytes(fd_payload)
    fd_file.chmod(0o755)
    (download_root / 'is-number-7.0.0.tgz').write_bytes(reference)
    if invoke('network-preparation-fd-version', [fd_file, '--version'], timeout=15).strip() != 'fd 10.5.0':
        raise RuntimeError('FD_VERSION_MISMATCH')
    prefix = scratch / 'i'
    invoke('network-preparation-install', [node, source / 'scripts/install-node-runtime.mjs', '--prefix', prefix, '--artifact', inputs['artifact'], '--context', inputs['context'], '--expected-sha256', inputs['artifactSha256']], timeout=180)
    runtime = prefix / 'lib/himawari-agent'
    binaries = runtime / 'pi-tools/bin'
    binaries.mkdir(mode=0o755, parents=True)
    tools = []
    for name, original in [('bash', Path('/usr/bin/bash')), ('rg', Path('/usr/bin/rg')), ('fd', fd_file)]:
        if not original.is_file() or original.is_symlink() or original.resolve() != original:
            raise RuntimeError('TOOL_SOURCE_UNSAFE')
        target = binaries / name
        shutil.copyfile(original, target)
        target.chmod(0o755)
        if digest(target) != digest(original) or target.is_symlink():
            raise RuntimeError('COPIED_TOOL_CHANGED')
        tools.append({'name': name, 'source': str(original), 'target': str(target), 'sha256': digest(target), 'version': invoke('network-preparation-tool-' + name, [target, '--version'], timeout=15).splitlines()[0]})
    environment['HIMAWARI_PROBE_RUNTIME'] = str(runtime)
    report['runtimeTools'] = tools
    before = json.loads(invoke('network-preparation-runtime-before', [node, evidence / 'digest-installed-runtime.mjs', runtime], timeout=180))
    report['runtimeDigestBefore'] = before['runtimeDigest']
    pi = json.loads(invoke('network-preparation-pi', [node, evidence / 'probe-foreground.mjs']))
    if pi['passed'] != 22 or pi['qualification'] or not all(row['namespaceState'] == 'released' for row in pi['reports']):
        raise RuntimeError('PI_ASSERTIONS_NOT_SATISFIED')
    for tool in tools:
        if pi['toolDigests'][tool['name']] != tool['sha256']:
            raise RuntimeError('PI_TOOL_DIGEST_MISMATCH')
    report['assertions'].append({'name': 'installed-pi-22-scenarios', 'passed': True, 'scenarioCount': 22})
    network = json.loads(invoke('network-preparation-network', [node, evidence / 'probe-authorized-network.mjs']))
    if not network['passed'] or network['productionSuitable'] or len(network['evidence']) != 10 or not all(row['passed'] and row['namespaceState'] == 'released' and row['network']['closed'] for row in network['evidence']):
        raise RuntimeError('NETWORK_ASSERTIONS_NOT_SATISFIED')
    for row in network['evidence']:
        if row['scenario'] in ['download', 'socks-download'] and row['artifactSha256'] != hashlib.sha256(reference).hexdigest():
            raise RuntimeError('NETWORK_DOWNLOAD_BYTES_MISMATCH')
    report['assertions'].append({'name': 'authorized-network-ten-scenarios', 'passed': True, 'scenarioCount': 10})
    after = json.loads(invoke('network-preparation-runtime-after', [node, evidence / 'digest-installed-runtime.mjs', runtime], timeout=180))
    if before['runtimeDigest'] != after['runtimeDigest'] or any(digest(tool['target']) != tool['sha256'] for tool in tools) or digest(inputs['artifact']) != inputs['artifactSha256'] or digest(inputs['context']) != inputs['contextSha256']:
        raise RuntimeError('INSTALLED_INPUTS_CHANGED_DURING_PROBES')
    report['runtimeDigestAfter'] = after['runtimeDigest']
    report['assertions'].append({'name': 'installation-bytes-unchanged', 'passed': True})
    report['passed'] = True
finally:
    (evidence / 'network-preparation-report.json').write_text(json.dumps(report, indent=2) + '\n')
