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


def remote_command(action, frozen):
    freeze_sha = frozen['freezeSha256']
    guard = 'set -eu; test "$(hostname)" = __PKT_HOSTNAME__; test "$(id -u)" = 0; '
    if action == 'S1_TRANSPORT':
        common_encoded = base64.b64encode(common.read(base / 'packet-common.py', os.getuid())).decode()
        receiver_encoded = base64.b64encode(common.read(base / 'transport-packet.py', os.getuid())).decode()
        bootstrap = 'import base64,sys,types; common=types.ModuleType("packet_common"); exec(compile(base64.b64decode(' + repr(common_encoded) + '),"<frozen-packet-common>","exec"),common.__dict__); namespace={"__name__":"packet_transport"}; exec(compile(base64.b64decode(' + repr(receiver_encoded) + '),"<frozen-packet-transport>","exec"),namespace); raise SystemExit(namespace["production_main"](sys.argv[2],common))'
        return 'steps/transport-packet.py', guard + 'exec /usr/bin/python3 -I -c ' + shlex.quote(bootstrap) + ' --approved-r2l13-__PKT_LABEL__-transport ' + shlex.quote(freeze_sha)
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


def stream_packet(stdin, frozen):
    with tarfile.open(fileobj=stdin, mode='w|') as archive:
        for member in ['freeze-manifest.json', *sorted(frozen['members'])]:
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
    relative, remote = remote_command(action, frozen)
    logs = packet.parent / '__PKT_DATE__-__PKT_LABEL__-change-execution-01'
    logs.mkdir(mode=0o700, exist_ok=True)
    name = action + '.' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', HOST, remote]
    transport = action == 'S1_TRANSPORT'
    archive_error = None
    with (logs / (name + '.console.txt')).open('xb') as output:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE if transport else subprocess.DEVNULL)
        if transport:
            try:
                stream_packet(child.stdin, frozen)
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
    receipt = {'action': action, 'command': command, 'exitCode': code, 'localFreezeSha256': frozen['freezeSha256'], 'entry': relative, 'entrySha256': frozen['members'][relative]['sha256'], 'archiveError': archive_error, 'console': str(logs / (name + '.console.txt'))}
    with (logs / (name + '.json')).open('x') as output:
        json.dump(receipt, output, indent=2)
        output.write('\n')
    return code if 0 <= code <= 255 else 1


if __name__ == '__main__':
    sys.exit(main())
