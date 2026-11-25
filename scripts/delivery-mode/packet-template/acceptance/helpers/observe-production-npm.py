import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--approved-__PKT_LABEL__-production-npm-readonly-observation', action='store_true', required=True)
parser.add_argument('--expected')
arguments = parser.parse_args()
if sys.platform != 'linux' or socket.gethostname() != '__PKT_HOSTNAME__' or os.getuid() != 0 or sys.executable != '/usr/bin/python3' or sys.flags.isolated != 1:
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_APPROVED_ROOT_ISOLATED_PRODUCTION_OBSERVATION_REQUIRED')

prefix = Path('/opt/himawari/node')
node = prefix / 'bin/node'
requested = prefix / 'bin/npm'
npm_cli = prefix / 'lib/node_modules/npm/bin/npm-cli.js'
npm_root = npm_cli.parent.parent
global_configuration = prefix / '.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def require_absent(filename):
    try:
        filename.lstat()
    except FileNotFoundError:
        return True
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_GLOBAL_CONFIGURATION_MUST_BE_ABSENT')

def trusted_info(filename, expected_gid=0):
    info = filename.lstat()
    if info.st_uid != 0 or info.st_gid != expected_gid or not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022:
        raise RuntimeError('__PKT_LABEL_UPPER___NPM_PUBLIC_PATH_UNSAFE')
    return info

def regular_bytes(filename, expected_gid=0):
    before = trusted_info(filename, expected_gid)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or filename.resolve() != filename:
        raise RuntimeError('__PKT_LABEL_UPPER___NPM_REGULAR_CANONICAL_FILE_REQUIRED')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            data = source.read()
        if identity(before) != identity(os.fstat(descriptor)) or identity(before) != identity(filename.lstat()):
            raise RuntimeError('__PKT_LABEL_UPPER___NPM_PUBLIC_FILE_CHANGED_DURING_READ')
        return data
    finally:
        os.close(descriptor)

def path_chain(filename):
    chain = []
    for entry in list(reversed(filename.parents)) + [filename]:
        info = trusted_info(entry)
        value = {'path': str(entry), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'device': str(info.st_dev), 'inode': str(info.st_ino)}
        if stat.S_ISLNK(info.st_mode):
            if entry != requested:
                raise RuntimeError('__PKT_LABEL_UPPER___NPM_PARENT_LINK_UNEXPECTED')
            value.update({'type': 'symlink', 'link': os.readlink(entry), 'realpath': str(entry.resolve(strict=True))})
        elif stat.S_ISDIR(info.st_mode):
            if entry.resolve() != entry:
                raise RuntimeError('__PKT_LABEL_UPPER___NPM_PARENT_NOT_CANONICAL')
            value['type'] = 'directory'
        elif stat.S_ISREG(info.st_mode):
            value['type'] = 'file'
        else:
            raise RuntimeError('__PKT_LABEL_UPPER___NPM_PUBLIC_PATH_TYPE_INVALID')
        chain.append(value)
    return chain

def package_entries():
    entries = []
    def observe(entry):
        info = trusted_info(entry)
        value = {'path': '.' if entry == npm_root else str(entry.relative_to(npm_root)), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            value['type'] = 'directory'
            entries.append(value)
            for child in sorted(entry.iterdir()):
                observe(child)
        elif stat.S_ISREG(info.st_mode):
            data = regular_bytes(entry)
            value.update({'type': 'file', 'bytes': len(data), 'sha256': sha(data)})
            entries.append(value)
        elif stat.S_ISLNK(info.st_mode):
            resolved = entry.resolve(strict=True)
            if resolved != npm_root and npm_root not in resolved.parents:
                raise RuntimeError('__PKT_LABEL_UPPER___NPM_PACKAGE_LINK_ESCAPES_PUBLIC_ROOT')
            value.update({'type': 'symlink', 'link': os.readlink(entry), 'realpath': str(resolved)})
            entries.append(value)
        else:
            raise RuntimeError('__PKT_LABEL_UPPER___NPM_PACKAGE_SPECIAL_FILE_REJECTED')
    observe(npm_root)
    return sorted(entries, key=lambda value: value['path'])

requested_chain = path_chain(requested)
path_chain(npm_cli)
path_chain(node)
if node.resolve(strict=True) != node or requested.resolve(strict=True) != npm_cli or npm_cli.resolve(strict=True) != npm_cli:
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_FIXED_PUBLIC_TOOL_LAYOUT_CHANGED')
node_bytes = regular_bytes(node)
if sha(node_bytes) != '__PKT_NODE_SHA256__':
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_LOCKED_NODE_CHANGED')
package = json.loads(regular_bytes(npm_root / 'package.json'))
if package['name'] != 'npm' or not isinstance(package['version'], str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', package['version']):
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_PUBLIC_PACKAGE_VERSION_INVALID')
entries = package_entries()
global_absent_before = require_absent(global_configuration)
environment = {'PATH': '/opt/himawari/node/bin:/usr/bin:/bin', 'HOME': '/dev/null', 'LANG': 'C.UTF-8', 'NPM_CONFIG_USERCONFIG': '/dev/null', 'NPM_CONFIG_GLOBALCONFIG': str(global_configuration), 'NPM_CONFIG_CACHE': '/dev/null', 'NPM_CONFIG_LOGS_MAX': '0', 'NPM_CONFIG_OFFLINE': 'true', 'NPM_CONFIG_IGNORE_SCRIPTS': 'true'}
node_version = subprocess.run([str(node), '--version'], cwd=npm_root, env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
if node_version.returncode != 0 or node_version.stdout.decode().strip() != 'v22.22.3':
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_LOCKED_NODE_VERSION_CHANGED')
command = [str(node), '--experimental-permission', '--allow-fs-read=' + str(prefix), '--allow-fs-read=/dev/null', '--no-global-search-paths', str(npm_cli), '--version', '--offline', '--ignore-scripts', '--logs-max=0', '--userconfig=/dev/null', '--globalconfig=' + str(global_configuration), '--cache=/dev/null']
version = subprocess.run(command, cwd=npm_root, env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
global_absent_after = require_absent(global_configuration)
if version.returncode != 0 or version.stdout.decode().strip() != package['version']:
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_READONLY_CLI_VERSION_FAILED')
if entries != package_entries() or requested_chain != path_chain(requested) or node_bytes != regular_bytes(node):
    raise RuntimeError('__PKT_LABEL_UPPER___NPM_PUBLIC_TOOL_CHANGED_DURING_OBSERVATION')
report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-npm-observation.v1', 'passed': True, 'hostname': socket.gethostname(), 'actorUid': os.getuid(), 'readOnly': True, 'networkCommandsIssued': False, 'node': {'path': str(node), 'realpath': str(node), 'version': 'v22.22.3', 'sha256': sha(node_bytes)}, 'npm': {'requestedPath': str(requested), 'realpath': str(npm_cli), 'packageRoot': str(npm_root), 'version': package['version'], 'packageManifestVersion': package['version'], 'cliSha256': sha(regular_bytes(npm_cli)), 'entriesSha256': sha(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()), 'entryCount': len(entries), 'bytes': sum(value.get('bytes', 0) for value in entries), 'entries': entries, 'requestedPathChain': requested_chain}, 'versionCommand': {'argv': command, 'exitCode': version.returncode, 'stdoutSha256': sha(version.stdout), 'stderrSha256': sha(version.stderr), 'filesystemWritesAllowed': False, 'configFiles': {'user': '/dev/null', 'global': str(global_configuration), 'globalAbsentBefore': global_absent_before, 'globalAbsentAfter': global_absent_after}, 'offline': True}, 'observedAt': datetime.now(timezone.utc).isoformat()}
if arguments.expected:
    expected_path = Path(arguments.expected)
    if expected_path != Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet/inputs/npm-observed.json'):
        raise RuntimeError('__PKT_LABEL_UPPER___NPM_FROZEN_OBSERVATION_PATH_REQUIRED')
    expected_bytes = regular_bytes(expected_path, __PKT_SERVICE_GID__)
    expected = json.loads(expected_bytes)
    for key in ['schemaVersion', 'passed', 'hostname', 'actorUid', 'readOnly', 'networkCommandsIssued', 'node', 'npm']:
        if report[key] != expected[key]:
            raise RuntimeError('__PKT_LABEL_UPPER___NPM_FROZEN_OBSERVATION_CHANGED:' + key)
    for key in ['argv', 'exitCode', 'stdoutSha256', 'filesystemWritesAllowed', 'configFiles', 'offline']:
        if report['versionCommand'][key] != expected['versionCommand'][key]:
            raise RuntimeError('__PKT_LABEL_UPPER___NPM_FROZEN_VERSION_COMMAND_CHANGED:' + key)
    report['expectedObservationSha256'] = sha(expected_bytes)
    report['matchedFrozenObservation'] = True
print(json.dumps(report, indent=2))
