import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'prune-rebuildable.py'
OLD = time.time() - 3 * 86400


def write(path, size=10, mtime=OLD):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x' * size)
    os.utime(path, (mtime, mtime))
    return path


def age_directory(path, mtime=OLD):
    os.utime(path, (mtime, mtime))


class PruneTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / '.ci-output'
        production = self.root / 'production'
        self.packets = {}
        for name in ('2026-10-07-first-deploy-packet-01', '2026-10-25-ninth-change-packet-01', '2026-10-26-tenth-change-packet-01'):
            packet = production / name
            self.packets[name] = packet
            write(packet / 'materials' / 'node-modules.tar.gz', 100)
            write(packet / 'materials' / 'source-abc1234.bundle', 100)
            write(packet / 'materials' / 'linux-x64-abi127-abc-1-1.tar.gz', 100)
            write(packet / 'materials' / 'python-3.12.10.tar.gz', 100)
            write(packet / 'materials' / 'node-modules.json')
            write(packet / 'run-logs' / 'deploy-1.log')
        write(self.root / 'tools' / 'downloads' / 'python-3.12.10.tar.gz', 100)
        write(self.root / 'local-1' / 'test-macos-arm64' / 'macos-arm64-abi127-abc-1-1.tar.gz', 100)
        write(self.root / 'local-1' / 'local-summary.json')
        write(self.root / 'local-2' / 'macos-arm64-abi127-def-1-1.tar.gz', 100, mtime=time.time())
        write(self.root / 'evidence' / 'trace.zip', 100)
        write(self.root / 'doc-check' / 'seal.abcd' / 'package.json')
        age_directory(self.root / 'doc-check' / 'seal.abcd')
        write(self.root / 'doc-check' / 'val.young' / 'package.json', mtime=time.time())

    def tearDown(self):
        self.directory.cleanup()

    def run_prune(self, *arguments):
        child = subprocess.run([sys.executable, '-I', str(SCRIPT), *arguments, str(self.root)], capture_output=True, text=True, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        line = next(line for line in child.stdout.splitlines() if line.startswith('PRUNE_RESULT '))
        return json.loads(line.split(' ', 1)[1]), child.stdout

    def remaining(self):
        return {str(path.relative_to(self.root)) for path in self.root.rglob('*') if path.is_file()}

    def test_dry_run_lists_without_deleting(self):
        before = self.remaining()
        result, output = self.run_prune()
        self.assertEqual(result['mode'], 'dry-run')
        self.assertEqual(self.remaining(), before)
        self.assertIn('first-deploy-packet-01/materials/node-modules.tar.gz', output)
        self.assertGreater(result['bytes'], 0)

    def test_apply_deletes_only_old_rebuildable_files(self):
        result, _ = self.run_prune('--apply')
        left = self.remaining()
        first = 'production/2026-10-07-first-deploy-packet-01/'
        for name in ('node-modules.tar.gz', 'source-abc1234.bundle', 'linux-x64-abi127-abc-1-1.tar.gz', 'python-3.12.10.tar.gz'):
            self.assertNotIn(first + 'materials/' + name, left)
        self.assertIn(first + 'materials/node-modules.json', left)
        self.assertIn(first + 'run-logs/deploy-1.log', left)
        self.assertNotIn('local-1/test-macos-arm64/macos-arm64-abi127-abc-1-1.tar.gz', left)
        self.assertIn('local-1/local-summary.json', left)
        self.assertIn('evidence/trace.zip', left)
        self.assertEqual(result['mode'], 'apply')
        self.assertEqual((result['files'], result['directories']), (5, 1))

    def test_newest_packets_toolchain_and_young_files_are_kept(self):
        self.run_prune('--apply')
        left = self.remaining()
        for name in ('2026-10-25-ninth-change-packet-01', '2026-10-26-tenth-change-packet-01'):
            self.assertIn(f'production/{name}/materials/node-modules.tar.gz', left)
            self.assertIn(f'production/{name}/materials/source-abc1234.bundle', left)
        self.assertIn('tools/downloads/python-3.12.10.tar.gz', left)
        self.assertIn('local-2/macos-arm64-abi127-def-1-1.tar.gz', left)

    def test_keep_packets_and_explicit_keep_widen_protection(self):
        first = self.packets['2026-10-07-first-deploy-packet-01']
        self.run_prune('--apply', '--keep-packets', '1', '--keep', str(first))
        left = self.remaining()
        self.assertIn('production/2026-10-07-first-deploy-packet-01/materials/node-modules.tar.gz', left)
        self.assertNotIn('production/2026-10-25-ninth-change-packet-01/materials/node-modules.tar.gz', left)
        self.assertIn('production/2026-10-26-tenth-change-packet-01/materials/node-modules.tar.gz', left)

    def test_old_temporary_repository_copies_are_removed(self):
        self.run_prune('--apply')
        self.assertFalse((self.root / 'doc-check' / 'seal.abcd').exists())
        self.assertTrue((self.root / 'doc-check' / 'val.young' / 'package.json').exists())

    def test_low_free_space_is_reported(self):
        result, output = self.run_prune('--low-free-gb', '1000000')
        self.assertTrue(result['lowDisk'])
        self.assertIn('PRUNE_LOW_DISK', output)

    def test_busy_host_skips_the_round(self):
        marker = 'prune-busy-test-' + str(os.getpid())
        sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', marker])
        try:
            before = self.remaining()
            result, output = self.run_prune('--apply', '--skip-if-busy', '--busy-pattern', marker)
            self.assertEqual(result['mode'], 'skipped-busy')
            self.assertEqual(self.remaining(), before)
        finally:
            sleeper.kill()
            sleeper.wait()

    def run_busy_round_with_cgroup(self, cgroup):
        marker = 'prune-container-test-' + str(os.getpid())
        sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', marker])
        proc_root = Path(self.directory.name) / 'proc'
        write(proc_root / str(sleeper.pid) / 'cgroup', 0).write_text(cgroup)
        try:
            result, _ = self.run_prune('--apply', '--skip-if-busy', '--busy-pattern', marker, '--proc-root', str(proc_root))
            return result
        finally:
            sleeper.kill()
            sleeper.wait()

    def test_matching_process_inside_a_container_does_not_block_the_round(self):
        before = self.remaining()
        result = self.run_busy_round_with_cgroup('0::/system.slice/docker-d08fb19eba5d.scope\n')
        self.assertEqual(result['mode'], 'apply')
        self.assertNotEqual(self.remaining(), before)

    def test_matching_process_outside_a_container_still_blocks_the_round(self):
        before = self.remaining()
        result = self.run_busy_round_with_cgroup('0::/user.slice/user-1000.slice/session-1.scope\n')
        self.assertEqual(result['mode'], 'skipped-busy')
        self.assertEqual(self.remaining(), before)


if __name__ == '__main__':
    unittest.main()
