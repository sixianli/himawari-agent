import base64
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
base = Path(__file__).resolve().parent
packet = base.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, base / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load('packet_common', 'packet-common.py')
steps = load('packet_steps', 'run-step.py')
HOST = 'root@__PKT_ADDRESS__'
LOCAL_ACTIONS = {'S1_TRANSPORT', 'S1_INSTALL'}
TRANSPORT_ALIVE_COUNT_MAX = '40'
DEFAULT_ALIVE_COUNT_MAX = '4'


CACHE_QUERY = (
    'import json, os, stat, sys\n'
    'root = sys.argv[1]\n'
    'wanted = json.loads(sys.argv[2])\n'
    'found = []\n'
    'try:\n'
    '    safe = all(stat.S_ISDIR(os.lstat(path).st_mode) and os.lstat(path).st_uid == 0 and stat.S_IMODE(os.lstat(path).st_mode) == 0o700 for path in (root, root + "/sha256"))\n'
    'except FileNotFoundError:\n'
    '    safe = False\n'
    'for digest, size in wanted if safe else []:\n'
    '    try:\n'
    '        info = os.lstat(root + "/sha256/" + digest)\n'
    '    except FileNotFoundError:\n'
    '        continue\n'
    '    if stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not stat.S_IMODE(info.st_mode) & 0o077 and info.st_size == size:\n'
    '        found.append(digest)\n'
    'print("CACHE_PRESENT " + json.dumps(found))\n'
)


def cache_settings(frozen):
    if 'packet-parameters.json' not in frozen['members']:
        return None
    settings = json.loads(json.loads(common.read(packet / 'packet-parameters.json', os.getuid())).get('MATERIAL_CACHE_JSON', 'null'))
    if settings is None:
        return None
    common.require(isinstance(settings, dict) and set(settings) == {'minBytes', 'maxBytes'} and all(type(settings[key]) is int and settings[key] > 0 for key in settings), '__PKT_LABEL_UPPER___STEP_CACHE_SETTINGS_INVALID')
    return settings


def cached_members(frozen, settings, ssh_options):
    wanted = {name: item for name, item in frozen['members'].items() if item['bytes'] >= settings['minBytes']}
    if not wanted:
        return []
    query = [[item['sha256'], item['bytes']] for name, item in sorted(wanted.items())]
    remote = 'set -eu; test "$(hostname)" = __PKT_HOSTNAME__; test "$(id -u)" = 0; exec /usr/bin/python3 -I -c ' + shlex.quote(CACHE_QUERY) + ' ' + shlex.quote(str(common.MATERIAL_CACHE)) + ' ' + shlex.quote(json.dumps(query))
    try:
        child = subprocess.run(['ssh', *ssh_options, HOST, remote], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return []
    line = next((line for line in child.stdout.splitlines() if line.startswith('CACHE_PRESENT ')), None)
    if child.returncode != 0 or line is None:
        return []
    try:
        present = set(json.loads(line.split(' ', 1)[1]))
    except ValueError:
        return []
    return sorted(name for name, item in wanted.items() if item['sha256'] in present)


def remote_command(action, frozen, cache=None):
    freeze_sha = frozen['freezeSha256']
    guard = 'set -eu; test "$(hostname)" = __PKT_HOSTNAME__; test "$(id -u)" = 0; '
    if action == 'S1_TRANSPORT':
        common_encoded = base64.b64encode(common.read(base / 'packet-common.py', os.getuid())).decode()
        receiver_encoded = base64.b64encode(common.read(base / 'transport-packet.py', os.getuid())).decode()
        bootstrap = 'import base64,sys,types; common=types.ModuleType("packet_common"); exec(compile(base64.b64decode(' + repr(common_encoded) + '),"<frozen-packet-common>","exec"),common.__dict__); namespace={"__name__":"packet_transport"}; exec(compile(base64.b64decode(' + repr(receiver_encoded) + '),"<frozen-packet-transport>","exec"),namespace); raise SystemExit(namespace["production_main"](sys.argv[2],common))'
        spec = '' if cache is None else ' ' + shlex.quote(base64.b64encode(json.dumps(cache, sort_keys=True).encode()).decode())
        return 'steps/transport-packet.py', guard + 'exec /usr/bin/python3 -I -c ' + shlex.quote(bootstrap) + ' --approved-r2l13-__PKT_LABEL__-transport ' + shlex.quote(freeze_sha) + spec
    if action == 'S1_INSTALL':
        root = common.UPLOAD
        relative = 'install/S1-publish-and-install.py'
        entry = root / relative
        arguments = ['--approved-frozen-__PKT_LABEL__-packet', str(root)]
    else:
        steps.command_for(action)
        root = common.STAGE
        relative = 'steps/run-step.py'
        entry = steps.ENTRY
        common.require(entry == common.OPERATIONS / relative, '__PKT_LABEL_UPPER___STEP_ENTRY_PATH_CHANGED')
        arguments = ['--approved-r2l13-__PKT_LABEL__-step', action, freeze_sha]
    entry_sha = frozen['members'][relative]['sha256']
    checks = 'test "$(sha256sum ' + shlex.quote(str(root / 'freeze-manifest.json')) + " | cut -d' ' -f1)\" = " + shlex.quote(freeze_sha) + '; test "$(sha256sum ' + shlex.quote(str(entry)) + " | cut -d' ' -f1)\" = " + shlex.quote(entry_sha) + '; '
    return relative, guard + checks + 'exec /usr/bin/python3 -I ' + ' '.join(shlex.quote(value) for value in [str(entry), *arguments])


def stream_packet(stdin, frozen, skipped=()):
    with tarfile.open(fileobj=stdin, mode='w|') as archive:
        for member in ['freeze-manifest.json', *sorted(set(frozen['members']) - set(skipped))]:
            filename = packet / member
            info = tarfile.TarInfo(member)
            info.size = filename.stat().st_size
            info.mode = 0o640
            with filename.open('rb') as source:
                archive.addfile(info, source)


def main():
    common.require(len(sys.argv) == 2, '__PKT_LABEL_UPPER___STEP_SINGLE_EXPLICIT_STEP_REQUIRED')
    action = sys.argv[1]
    if action not in LOCAL_ACTIONS:
        steps.command_for(action)
    frozen = common.verify_frozen(packet, common.APPROVED_REF, os.getuid())
    transport = action == 'S1_TRANSPORT'
    ssh_options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=' + (TRANSPORT_ALIVE_COUNT_MAX if transport else DEFAULT_ALIVE_COUNT_MAX)]
    settings = cache_settings(frozen) if transport else None
    cache = None if settings is None else {**settings, 'fill': cached_members(frozen, settings, ssh_options)}
    relative, remote = remote_command(action, frozen, cache)
    logs = packet.parent / '__PKT_DATE__-__PKT_LABEL__-change-execution-01'
    logs.mkdir(mode=0o700, exist_ok=True)
    name = action + '.' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    command = ['ssh', *ssh_options, HOST, remote]
    archive_error = None
    with (logs / (name + '.console.txt')).open('xb') as output:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE if transport else subprocess.DEVNULL)
        if transport:
            try:
                stream_packet(child.stdin, frozen, cache['fill'] if cache else ())
            except Exception as error:
                archive_error = type(error).__name__
            finally:
                try:
                    child.stdin.close()
                except BrokenPipeError:
                    archive_error = archive_error or 'BrokenPipeError'
        for chunk in iter(lambda: child.stdout.read1(65536), b''):
            output.write(chunk)
            output.flush()
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        code = child.wait()
        if archive_error is not None:
            code = code or 1
            output.write(('archiveError=' + archive_error + '\n').encode())
        output.write(('exit=' + str(code) + '\n').encode())
    print('exit=' + str(code))
    receipt = {'action': action, 'command': command, 'cacheFilled': cache['fill'] if cache else [], 'exitCode': code, 'localFreezeSha256': frozen['freezeSha256'], 'entry': relative, 'entrySha256': frozen['members'][relative]['sha256'], 'archiveError': archive_error, 'console': str(logs / (name + '.console.txt'))}
    with (logs / (name + '.json')).open('x') as output:
        json.dump(receipt, output, indent=2)
        output.write('\n')
    return code if 0 <= code <= 255 else 1


if __name__ == '__main__':
    sys.exit(main())
