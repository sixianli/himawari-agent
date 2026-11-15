import base64
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

fd_url = 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz'
fd_sha256 = '761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7'
package_url = 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'
package_integrity = '41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=='
report = {'schema': 'himawari-__PKT_LABEL__-cloud-question12-downloads.v1', 'productionQualificationIssued': False, 'downloads': [], 'passed': False}
os.umask(0o022)

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

RETRY_DELAYS_SECONDS = (1, 3)

def transient(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500
    if isinstance(error, urllib.error.URLError):
        error = error.reason
    return isinstance(error, (socket.gaierror, ConnectionResetError, TimeoutError))

def download_with_retry(url, limit, sleep=time.sleep):
    for delay in RETRY_DELAYS_SECONDS + (None,):
        try:
            return download(url, limit)
        except Exception as error:
            if delay is None or not transient(error):
                raise
            report.setdefault('downloadRetries', []).append({'url': url, 'type': type(error).__name__, 'message': str(error), 'delaySeconds': delay})
            sleep(delay)

cached = len(sys.argv) == 5 and sys.argv[1] == '--cached-question-12-inputs'
if not cached and (len(sys.argv) != 3 or sys.argv[1] != '--approved-question-12-downloads'):
    raise RuntimeError('EXPLICIT_QUESTION12_DOWNLOAD_APPROVAL_REQUIRED')
if sys.platform != 'linux' or os.getuid() == 0:
    raise RuntimeError('LINUX_ORDINARY_ACCOUNT_REQUIRED')
evidence = Path(sys.argv[4] if cached else sys.argv[2])
if not evidence.is_absolute() or evidence.resolve() != evidence or evidence.is_symlink() or not evidence.is_dir():
    raise RuntimeError('DOWNLOAD_OUTPUT_UNSAFE')
if evidence.stat().st_uid != os.getuid() or evidence.stat().st_mode & 0o7777 != 0o700:
    raise RuntimeError('DOWNLOAD_OUTPUT_OWNER_OR_MODE_UNSAFE')
if any(evidence.iterdir()):
    raise RuntimeError('DOWNLOAD_OUTPUT_NOT_EMPTY')
try:
    if cached:
        source_paths = list(map(Path, sys.argv[2:4]))
        if any(value.resolve() != value or value.is_symlink() or not value.is_file() for value in source_paths):
            raise RuntimeError('CACHED_REFERENCE_INPUT_UNSAFE')
        fd_archive = source_paths[0].read_bytes()
        if len(fd_archive) > 4 * 1024**2:
            raise RuntimeError('FD_CACHED_ARCHIVE_SIZE_EXCEEDED')
        report['inputMode'] = 'existing-hash-verified-copies'
        report['cachedInputs'] = [{'path': str(value), 'sha256': hashlib.sha256(value.read_bytes()).hexdigest(), 'bytes': value.stat().st_size} for value in source_paths]
    else:
        fd_archive = download_with_retry(fd_url, 4 * 1024**2)
        report['inputMode'] = 'explicit-approved-two-source-downloads'
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
            if member.name == 'fd-v10.5.0-x86_64-unknown-linux-musl/fd':
                if fd_payload is not None or not member.isfile():
                    raise RuntimeError('FD_ARCHIVE_BINARY_AMBIGUOUS')
                fd_payload = archive.extractfile(member).read()
    if not fd_payload or not fd_payload.startswith(b'\x7fELF'):
        raise RuntimeError('FD_BINARY_MISSING')
    reference = source_paths[1].read_bytes() if cached else download_with_retry(package_url, 1024**2)
    if len(reference) > 1024**2:
        raise RuntimeError('IS_NUMBER_REFERENCE_SIZE_EXCEEDED')
    if base64.b64encode(hashlib.sha512(reference).digest()).decode() != package_integrity:
        raise RuntimeError('IS_NUMBER_INTEGRITY_MISMATCH')
    download_root = evidence
    (download_root / 'fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz').write_bytes(fd_archive)
    fd_file = download_root / 'fd'
    fd_file.write_bytes(fd_payload)
    fd_file.chmod(0o755)
    (download_root / 'is-number-7.0.0.tgz').write_bytes(reference)
    if subprocess.check_output([str(fd_file), '--version'], timeout=15, text=True).strip() != 'fd 10.5.0':
        raise RuntimeError('FD_VERSION_MISMATCH')
    report['fdBinarySha256'] = hashlib.sha256(fd_payload).hexdigest()
    report['referenceSha256'] = hashlib.sha256(reference).hexdigest()
    report['passed'] = True
finally:
    (evidence / 'download-report.json').write_text(json.dumps(report, indent=2) + '\n')
