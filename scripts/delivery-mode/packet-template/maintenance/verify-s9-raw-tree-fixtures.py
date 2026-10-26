import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('second_s9_raw_tree', Path(__file__).with_name('S9-control-files.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = []


def check(name, operation):
    try:
        operation()
        cases.append({'name': name, 'passed': True})
    except Exception as error:
        cases.append({'name': name, 'passed': False, 'error': str(error)})


def fixture(root, name):
    directory = root / name
    directory.mkdir(mode=0o700)
    (directory / 'payload-ciphertext').mkdir(mode=0o700)
    (directory / 'payload-ciphertext/nested').mkdir(mode=0o700)
    (directory / 'payload-ciphertext/empty').mkdir(mode=0o700)
    with sqlite3.connect(directory / 'product.sqlite') as database:
        database.execute('CREATE TABLE fixture(value TEXT)')
        database.execute("INSERT INTO fixture VALUES('FICTITIOUS_SQLITE')")
    os.chmod(directory / 'product.sqlite', 0o600)
    for relative, value in [('payload-ciphertext/one', b'\x00\x01\xff'), ('payload-ciphertext/nested/two', b'ciphertext-two')]:
        (directory / relative).write_bytes(value)
        os.chmod(directory / relative, 0o600)
    return directory


def accepts(root):
    directory = fixture(root, 'accepted')
    members = module.read_data_members(directory, os.getuid())
    expected = []
    for relative in ['payload-ciphertext', 'payload-ciphertext/empty', 'payload-ciphertext/nested']:
        expected.append({'path': relative, 'kind': 'directory'})
    for relative in ['product.sqlite', 'payload-ciphertext/one', 'payload-ciphertext/nested/two']:
        data = (directory / relative).read_bytes()
        expected.append({'path': relative, 'kind': 'file', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if members != sorted(expected, key=lambda item: item['path']):
        raise RuntimeError('S9_RAW_TREE_MEMBERS_DIFFER')


def rejects(root, name, mutate):
    directory = fixture(root, 'rejected-' + name.replace(' ', '-'))
    mutate(directory)
    try:
        module.read_data_members(directory, os.getuid())
    except RuntimeError:
        return
    raise RuntimeError('S9_RAW_UNSAFE_TREE_NOT_REJECTED')


with tempfile.TemporaryDirectory(prefix='s9-raw-tree-', dir=os.environ['HIMAWARI_TEST_TEMP_ROOT']) as temporary:
    root = Path(temporary)
    check('S9 independent readback includes all ciphertext bytes and empty directories', lambda: accepts(root))
    for name, mutate in [
        ('empty WAL', lambda directory: (directory / 'product.sqlite-wal').touch()),
        ('empty SHM', lambda directory: (directory / 'product.sqlite-shm').touch()),
        ('payload symlink', lambda directory: (directory / 'payload-ciphertext/link').symlink_to(directory / 'product.sqlite')),
        ('payload hardlink', lambda directory: os.link(directory / 'payload-ciphertext/one', directory / 'payload-ciphertext/hard')),
        ('payload FIFO', lambda directory: os.mkfifo(directory / 'payload-ciphertext/fifo', 0o600)),
        ('group writable file', lambda directory: os.chmod(directory / 'payload-ciphertext/one', 0o620)),
        ('world writable directory', lambda directory: os.chmod(directory / 'payload-ciphertext/nested', 0o702)),
    ]:
        check('S9 independent readback rejects ' + name, lambda name=name, mutate=mutate: rejects(root, name, mutate))
    def wrong_owner():
        directory = fixture(root, 'wrong-owner')
        try:
            module.read_data_members(directory, os.getuid() + 1)
        except RuntimeError:
            return
        raise RuntimeError('S9_RAW_WRONG_OWNER_NOT_REJECTED')
    check('S9 independent readback rejects wrong owner', wrong_owner)
report = {'passed': all(item['passed'] for item in cases), 'scope': 'S9-independent-python-whole-tree-readback-safety', 'total': len(cases), 'failed': sum(not item['passed'] for item in cases), 'cases': cases, 'sourceSha256': hashlib.sha256(Path(__file__).with_name('S9-control-files.py').read_bytes()).hexdigest(), 'fixtureSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'productionExecutionProved': False}
print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)
