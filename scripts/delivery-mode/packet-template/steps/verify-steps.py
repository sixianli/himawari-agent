import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
if len(sys.argv) != 2 or sys.platform != 'linux' or os.getuid() == 0 or socket.gethostname() != 'hermes-home':
    raise RuntimeError('HERMES_STEP_FIXTURE_REQUIRED')
scratch = Path(sys.argv[1])
if scratch.resolve() != scratch or scratch.stat().st_uid != os.getuid() or stat.S_IMODE(scratch.stat().st_mode) != 0o700 or len(str(scratch)) != 10:
    raise RuntimeError('HERMES_STEP_FIXTURE_SCRATCH_UNSAFE')
base = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


steps = load('packet_steps', base / 'run-step.py')
common = steps.common
transport = load('packet_transport', base / 'transport-packet.py')
sha = lambda value: hashlib.sha256(value).hexdigest()
results = []


def case(name, function, **extra):
    try:
        function()
        results.append({'name': name, 'passed': True, **extra})
    except Exception as error:
        results.append({'name': name, 'passed': False, 'error': repr(error)})


def rejects(code, function):
    try:
        function()
    except RuntimeError as error:
        assert str(error).startswith(code), str(error)
        return
    raise AssertionError('accepted; expected ' + code)


APPROVED = sorted(steps.MAINTENANCE_ACTIONS | {'S2_STOP', 'S2_INSPECT', 'S6_ACCEPTANCE', 'S6_PUBLISH_MATERIALS', 'S6_FINALIZE_BINDINGS', 'S6_SIGN', 'S6_RUNTIME_PROTECTION', 'S6_READ', 'S7_SWITCH_START', 'S9_RAW_CONTROL51', 'S9_TRANSPORT_PREFLIGHT', 'S9_TRANSPORT_APPLY'})
for action in APPROVED:
    def mapped(action=action):
        argv = steps.command_for(action)
        assert argv and all(isinstance(value, str) and value for value in argv)
        if action == 'S2_INSPECT':
            assert argv[-1] == '--inspect-only'
        if action == 'S2_STOP':
            assert argv[-1].endswith('systemd/S2-stop-and-inspect.py')
        if action in steps.MAINTENANCE_ACTIONS:
            assert argv[-1] == action and argv[0] == '/usr/sbin/runuser'
        for value in argv:
            if value.startswith('/opt/himawari/operations/') or value.startswith('/var/tmp/'):
                assert value.startswith(str(common.OPERATIONS) + '/') or value.startswith(str(common.STAGE) + '/'), value
    case('step runner maps ' + action, mapped)
for action in ['S1', 'S2', 'S3_BACKUP49', 'S3_COPY49', 'S3_COPY50', 'S7_MIGRATE51', 'S9_RAW_RESTORE50', 'S9_RAW_CONTROL50', 'S4_MIGRATE50_COPY50', 'S5_ADMIN_CLEANUP', 'S5_RENEW_WORKSPACE_GRANT', 'S6_PREPARE_SNAPSHOT', 'S5_CREATE_WORKSPACE', 'S5_GRANT_WORKSPACE', 's7_catalog_upgrade', 'S7_CATALOG_UPGRADE --force', 'S7_MIGRATE50', 'S9_SIDECAR_TIDY50', 'S9_RAW_RESTORE49', 'S9_RAW_CONTROL49', 'S9_RESTORE50', 'PUBLISH_REVISION02', 'TRANSPORT_REVISION02', 'S10', 'S7_SWITCH_START;echo unsafe']:
    case('step runner refuses unapproved action ' + action, lambda action=action: rejects('__PKT_LABEL_UPPER___STEP_ACTION_INVALID', lambda: steps.command_for(action)))


def build_packet(root):
    packet = root / '__PKT_DATE__-__PKT_LABEL__-change-packet-01'
    (packet / 'steps').mkdir(parents=True)
    for name in ['packet-common.py', 'run-step.py', 'run-local-step.py', 'run-user-step.sh', 'transport-packet.py']:
        shutil.copyfile(base / name, packet / 'steps' / name)
    (packet / 'install').mkdir()
    (packet / 'install/S1-publish-and-install.py').write_text('fixture S1 entry\n')
    (packet / 'materials').mkdir()
    (packet / 'materials/immutable.tar.gz').write_bytes(os.urandom(3 * transport.CHUNK + 17))
    (packet / 'inputs').mkdir()
    binding = {'schemaVersion': 'himawari.__PKT_LABEL__-change-bindings.v1', 'status': 'frozen-approved', 'approvals': {'packageRef': common.APPROVED_REF}}
    (packet / 'inputs/bindings.json').write_text(json.dumps(binding))
    for path in packet.rglob('*'):
        path.chmod(0o750 if path.is_dir() else 0o640)
    packet.chmod(0o750)
    files = [{'path': str(path.relative_to(packet)), 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())} for path in sorted(packet.rglob('*')) if path.is_file()]
    manifest = packet / 'freeze-manifest.json'
    manifest.write_text(json.dumps({'schemaVersion': 'himawari.__PKT_LABEL__-change-freeze.v1', 'status': 'frozen-approved', 'approvalRef': common.APPROVED_REF, 'files': files}))
    manifest.chmod(0o640)
    return packet


with tempfile.TemporaryDirectory(prefix='steps-', dir=scratch) as temporary:
    root = Path(temporary)
    packet = build_packet(root)
    freeze = sha((packet / 'freeze-manifest.json').read_bytes())
    binaries = root / 'bin'
    binaries.mkdir()
    record = root / 'ssh-call.json'
    captured = root / 'ssh-stdin.tar'
    fake = binaries / 'ssh'
    fake.write_text('#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\nPath(os.environ["STEP_FIXTURE_STDIN"]).write_bytes(sys.stdin.buffer.read())\nPath(os.environ["STEP_FIXTURE_RECORD"]).write_text(json.dumps(sys.argv[1:]))\nsys.exit(17)\n')
    fake.chmod(0o700)
    environment = {**os.environ, 'PATH': str(binaries) + ':/usr/bin:/bin', 'STEP_FIXTURE_RECORD': str(record), 'STEP_FIXTURE_STDIN': str(captured)}
    logs = root / '__PKT_DATE__-__PKT_LABEL__-change-execution-01'

    def wrapper(action):
        return subprocess.run(['/bin/bash', str(packet / 'steps/run-user-step.sh'), action], env=environment, text=True, capture_output=True)

    def receipt_for(action):
        receipts = sorted(logs.glob(action + '.*.json'))
        assert len(receipts) == 1, receipts
        return json.loads(receipts[0].read_text())

    def step_wrapper():
        run = wrapper('S2_INSPECT')
        assert run.returncode == 17, run.stderr
        argv = json.loads(record.read_text())
        assert argv[:9] == ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', 'root@__PKT_ADDRESS__']
        remote = argv[-1]
        assert freeze in remote and '/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet/freeze-manifest.json' in remote
        assert '/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/steps/run-step.py' in remote
        assert '--approved-r2l13-__PKT_LABEL__-step S2_INSPECT ' + freeze in remote
        assert 'test "$(hostname)" = __PKT_HOSTNAME__' in remote and 'test "$(id -u)" = 0' in remote
        assert sha((packet / 'steps/run-step.py').read_bytes()) in remote
        assert captured.read_bytes() == b''
        receipt = receipt_for('S2_INSPECT')
        assert receipt['exitCode'] == 17 and receipt['entry'] == 'steps/run-step.py' and Path(receipt['console']).read_text().endswith('exit=17\n')
    case('step wrapper keeps the failed SSH exit and sends exact freeze and entry SHA guards', step_wrapper, externalBoundary='fixture SSH executable only; no network')

    def remote_step_entry():
        assert steps.ENTRY == common.OPERATIONS / 'steps' / 'run-step.py', steps.ENTRY
        assert steps.ENTRY.parent != common.OPERATIONS / 'revision', steps.ENTRY.parent
        run = wrapper('S2_INSPECT')
        assert run.returncode == 17, run.stderr
        remote = json.loads(record.read_text())[-1]
        assert str(steps.ENTRY) in remote, remote
    case('the remote step entry is the exact path run-step accepts', remote_step_entry, externalBoundary='fixture SSH executable only; no network')

    def install_wrapper():
        run = wrapper('S1_INSTALL')
        assert run.returncode == 17, run.stderr
        remote = json.loads(record.read_text())[-1]
        upload = '/var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01'
        assert upload + '/freeze-manifest.json' in remote and freeze in remote
        assert upload + '/install/S1-publish-and-install.py --approved-frozen-__PKT_LABEL__-packet ' + upload in remote
        assert sha((packet / 'install/S1-publish-and-install.py').read_bytes()) in remote
        assert receipt_for('S1_INSTALL')['exitCode'] == 17
    case('S1 install wrapper targets the exclusive upload copy with SHA guards', install_wrapper, externalBoundary='fixture SSH executable only; no network')

    def transport_wrapper():
        run = wrapper('S1_TRANSPORT')
        assert run.returncode == 17, run.stderr
        argv = json.loads(record.read_text())
        assert 'ServerAliveCountMax=40' in argv, argv
        remote = argv[-1]
        assert remote.endswith('--approved-r2l13-__PKT_LABEL__-transport ' + freeze)
        with tarfile.open(captured, mode='r:') as archive:
            names = archive.getnames()
        assert names[0] == 'freeze-manifest.json' and 'materials/immutable.tar.gz' in names and len(names) == len(set(names))
        assert receipt_for('S1_TRANSPORT')['exitCode'] == 17
    case('S1 transport wrapper streams the whole frozen packet over stdin and keeps the remote failure', transport_wrapper, externalBoundary='fixture SSH executable only; no network')

    def bootstrap_matches():
        remote = json.loads(record.read_text())[-1]
        assert 'production_main' in remote and '<frozen-packet-common>' in remote
    case('S1 transport bootstrap embeds the frozen common and receiver modules', bootstrap_matches)

    upload_parent = root / 'upload'
    upload_parent.mkdir(mode=0o700)
    uid, gid = os.getuid(), os.getgid()

    def receive(archive_bytes, target_name, expected=freeze):
        return transport.receive_archive(io.BytesIO(archive_bytes), upload_parent / target_name, expected, uid, gid, common)

    good = captured.read_bytes()

    def accepts():
        result = receive(good, 'accepted')
        assert result['passed'] and result['freezeSha256'] == freeze
        target = upload_parent / 'accepted'
        for name in ['materials/immutable.tar.gz', 'inputs/bindings.json', 'steps/run-step.py']:
            assert (target / name).read_bytes() == (packet / name).read_bytes()
            assert stat.S_IMODE((target / name).stat().st_mode) == 0o640
        assert stat.S_IMODE(target.stat().st_mode) == 0o700
    case('receiver writes every frozen member with exact bytes and 0640 files', accepts)

    def deploy_logs_ignored():
        logs_directory = packet / common.DEPLOY_LOGS
        logs_directory.mkdir(mode=0o700)
        (logs_directory / 'deploy-20261026T000000Z.log').write_text('DEPLOY_PREFLIGHT_START\n')
        try:
            assert common.verify_frozen(packet, common.APPROVED_REF, os.getuid())['freezeSha256'] == freeze
            stray = packet / 'inputs' / common.DEPLOY_LOGS
            stray.mkdir()
            (stray / 'deploy.log').write_text('x\n')
            try:
                rejects('__PKT_LABEL_UPPER___PACKET_FROZEN_MEMBER_SET_CHANGED', lambda: common.verify_frozen(packet, common.APPROVED_REF, os.getuid()))
            finally:
                shutil.rmtree(stray)
            (packet / 'extra.log').write_text('x\n')
            try:
                rejects('__PKT_LABEL_UPPER___PACKET_FROZEN_MEMBER_SET_CHANGED', lambda: common.verify_frozen(packet, common.APPROVED_REF, os.getuid()))
            finally:
                (packet / 'extra.log').unlink()
        finally:
            shutil.rmtree(logs_directory)
    case('local frozen check ignores only the top-level deploy log directory that deploy.sh writes', deploy_logs_ignored)

    def rewritten(mutate):
        output = io.BytesIO()
        with tarfile.open(captured, mode='r:') as source, tarfile.open(fileobj=output, mode='w') as target:
            for member in source.getmembers():
                payload = source.extractfile(member).read()
                for name, data in mutate(member.name, payload):
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    target.addfile(info, io.BytesIO(data))
        return output.getvalue()

    def flip(name, payload):
        if name == 'materials/immutable.tar.gz':
            payload = bytes([payload[0] ^ 1]) + payload[1:]
        return [(name, payload)]
    case('receiver rejects a changed material byte', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_MEMBER_BYTES_CHANGED', lambda: receive(rewritten(flip), 'flipped')))
    case('receiver rejects an unexpected extra member', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_MEMBER', lambda: receive(rewritten(lambda name, payload: [(name, payload)] + ([('steps/extra.py', b'x')] if name == 'inputs/bindings.json' else [])), 'extra')))
    case('receiver rejects a missing member', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_MEMBERS_INCOMPLETE', lambda: receive(rewritten(lambda name, payload: [] if name == 'steps/run-step.py' else [(name, payload)]), 'missing')))
    case('receiver rejects a duplicate member', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_MEMBER', lambda: receive(rewritten(lambda name, payload: [(name, payload)] * (2 if name == 'inputs/bindings.json' else 1)), 'duplicate')))
    case('receiver rejects a path escape', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_MEMBER', lambda: receive(rewritten(lambda name, payload: [('../escape' if name == 'steps/run-step.py' else name, payload)]), 'escape')))
    case('receiver rejects a different expected freeze', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_EXPECTED_FREEZE_CHANGED', lambda: receive(good, 'wrong-freeze', '0' * 64)))
    case('receiver refuses an existing target', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_TARGET_NOT_EXCLUSIVE', lambda: receive(good, 'accepted')))
    case('receiver rejects a manifest that is not first', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_MEMBER_INVALID', lambda: receive(rewritten(lambda name, payload: [] if name == 'freeze-manifest.json' else [(name, payload)]), 'no-manifest')))

    def unsafe_parent():
        loose = root / 'loose'
        loose.mkdir(mode=0o755)
        rejects('__PKT_LABEL_UPPER___PACKET_DIRECTORY_UNSAFE', lambda: transport.receive_archive(io.BytesIO(good), loose / 'target', freeze, uid, gid, common))
    case('receiver requires a private 0700 upload parent', unsafe_parent)

    cache_root = root / 'material-cache'
    entries = cache_root / 'sha256'
    material = 'materials/immutable.tar.gz'
    material_sha = sha((packet / material).read_bytes())
    small = transport.CHUNK

    def spec(fill=(), max_bytes=1 << 30):
        return {'fill': list(fill), 'minBytes': small, 'maxBytes': max_bytes}

    def receive_cached(archive_bytes, target_name, fill=(), max_bytes=1 << 30):
        return transport.receive_archive(io.BytesIO(archive_bytes), upload_parent / target_name, freeze, uid, gid, common, cache_root, spec(fill, max_bytes))

    def without(*names):
        return rewritten(lambda name, payload: [] if name in names else [(name, payload)])

    def stores_large_members():
        result = receive_cached(good, 'cache-store')
        stored = entries / material_sha
        assert result['cache']['stored'] == [material_sha], result
        assert stored.read_bytes() == (packet / material).read_bytes()
        assert stat.S_IMODE(stored.stat().st_mode) == 0o600 and stat.S_IMODE(cache_root.stat().st_mode) == 0o700
        assert not any(name.startswith('.incoming-') for name in os.listdir(entries))
    case('receiver stores large frozen members in a private content-addressed cache', stores_large_members)

    def fills_from_cache():
        result = receive_cached(without(material), 'cache-fill', [material])
        assert result['passed'] and result['cacheFilled'] == [material], result
        assert (upload_parent / 'cache-fill' / material).read_bytes() == (packet / material).read_bytes()
        assert stat.S_IMODE((upload_parent / 'cache-fill' / material).stat().st_mode) == 0o640
    case('receiver fills a declared member from the cache and still checks the whole freeze', fills_from_cache)

    case('receiver still rejects a member that is missing and not declared', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_MEMBERS_INCOMPLETE', lambda: receive_cached(without(material, 'steps/run-step.py'), 'cache-undeclared', [material])))
    case('receiver rejects a declared member that is also streamed', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_UNEXPECTED_MEMBER', lambda: receive_cached(good, 'cache-twice', [material])))
    case('receiver rejects a declared member that is not frozen', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_FILL_NOT_FROZEN', lambda: receive_cached(without(material), 'cache-unfrozen', ['materials/other.tar.gz'])))

    def tampered_entry_is_dropped():
        stored = entries / material_sha
        data = bytearray(stored.read_bytes())
        data[-1] ^= 1
        stored.write_bytes(bytes(data))
        rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID', lambda: receive_cached(without(material), 'cache-tampered', [material]))
        assert not os.path.lexists(stored)
        result = receive_cached(good, 'cache-refill')
        assert result['passed'] and stored.read_bytes() == (packet / material).read_bytes()
    case('a changed cache entry is refused and removed so the next transport sends it in full', tampered_entry_is_dropped)

    def linked_entry_is_dropped():
        stored = entries / material_sha
        real = root / 'elsewhere.bin'
        shutil.copyfile(stored, real)
        stored.unlink()
        stored.symlink_to(real)
        rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_ENTRY_INVALID', lambda: receive_cached(without(material), 'cache-link', [material]))
        assert not os.path.lexists(stored) and real.exists()
    case('a cache entry that is a symbolic link is refused and removed', linked_entry_is_dropped)

    case('a declared member missing from the cache fails the transport', lambda: rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_MISS_AFTER_QUERY', lambda: receive_cached(without(material), 'cache-miss', [material])))

    def prunes_old_entries():
        receive_cached(good, 'cache-prune-seed')
        old = entries / ('f' * 64)
        old.write_bytes(b'x' * (2 * small))
        os.chmod(old, 0o600)
        os.utime(old, (1, 1))
        size = (packet / material).stat().st_size
        result = receive_cached(good, 'cache-prune', max_bytes=size + 1)
        assert not old.exists() and (entries / material_sha).exists(), result
        assert result['cache']['removed'] == ['f' * 64]
    case('the cache drops the oldest entries the current packet does not use once it is over its byte limit', prunes_old_entries)

    def unsafe_cache_directory():
        os.chmod(cache_root, 0o755)
        try:
            result = receive_cached(good, 'cache-unsafe')
            assert result['passed'] and 'CACHE_DIRECTORY_UNSAFE' in result['cacheStoreError'], result
            rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_DIRECTORY_UNSAFE', lambda: receive_cached(without(material), 'cache-unsafe-fill', [material]))
        finally:
            os.chmod(cache_root, 0o700)
    case('an unsafe cache directory never blocks a full transport but refuses to fill from it', unsafe_cache_directory)

    def cache_spec_checked():
        encoded = lambda value: __import__('base64').b64encode(json.dumps(value).encode()).decode()
        assert transport.cache_spec(encoded(spec([material]))) == spec([material])
        for broken in ({'fill': ['../x'], 'minBytes': 1, 'maxBytes': 1}, {'fill': [material, material], 'minBytes': 1, 'maxBytes': 1}, {'fill': [], 'minBytes': 0, 'maxBytes': 1}, {'fill': []}):
            rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_SPEC_INVALID', lambda broken=broken: transport.cache_spec(encoded(broken)))
        rejects('__PKT_LABEL_UPPER___TRANSPORT_CACHE_SPEC_INVALID', lambda: transport.cache_spec('not base64!'))
    case('the cache instructions passed to the receiver are validated', cache_spec_checked)

    def local_side_skips_cached_members():
        local = load('packet_local_step', packet / 'steps/run-local-step.py')
        frozen = common.verify_frozen(packet, common.APPROVED_REF, os.getuid())
        output = io.BytesIO()
        local.stream_packet(output, frozen, [material])
        output.seek(0)
        with tarfile.open(fileobj=output, mode='r:') as archive:
            names = archive.getnames()
        assert material not in names and names[0] == 'freeze-manifest.json' and len(names) == len(frozen['members'])
        relative, remote = local.remote_command('S1_TRANSPORT', frozen, spec([material]))
        assert transport.cache_spec(__import__('shlex').split(remote)[-1]) == spec([material])
        assert local.remote_command('S1_TRANSPORT', frozen)[1].endswith(' ' + freeze)
    case('the local side leaves cached members out of the stream and tells the receiver which ones', local_side_skips_cached_members)

    def local_tamper():
        (packet / 'steps/run-step.py').write_text((packet / 'steps/run-step.py').read_text() + '\n')
        before = sorted(logs.glob('*.json'))
        run = wrapper('S2_INSPECT')
        assert run.returncode != 0 and '__PKT_LABEL_UPPER___PACKET_FROZEN_BYTES_CHANGED' in run.stderr, run.stderr
        assert sorted(logs.glob('*.json')) == before
    case('wrapper refuses to contact the host when local frozen bytes changed', local_tamper)

report = {'schemaVersion': 'himawari.__PKT_LABEL__-change-step-fixtures.v1', 'passed': all(item['passed'] for item in results), 'total': len(results), 'failed': sum(not item['passed'] for item in results), 'sources': {name: sha((base / name).read_bytes()) for name in ['packet-common.py', 'run-step.py', 'run-local-step.py', 'run-user-step.sh', 'transport-packet.py']}, 'productionHostOrRootExecuted': False, 'results': results}
print(json.dumps(report, indent=2))
sys.exit(0 if report['passed'] else 1)
