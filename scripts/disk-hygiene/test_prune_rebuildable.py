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

    def start_sleeper(self, marker):
        sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', marker])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        deadline = time.time() + 5
        while marker not in Path('/proc', str(sleeper.pid), 'cmdline').read_text() and time.time() < deadline:
            time.sleep(0.02)
        return sleeper

    def busy_round(self, marker, *sleepers):
        proc_root = Path(self.directory.name) / 'proc'
        for sleeper, cgroup in sleepers:
            write(proc_root / str(sleeper.pid) / 'cgroup', 0).write_text(cgroup)
        return self.run_prune('--apply', '--skip-if-busy', '--busy-pattern', marker, '--proc-root', str(proc_root))

    HOST = '0::/user.slice/user-1000.slice/session-1.scope\n'
    CONTAINERS = {
        'docker v2': '0::/system.slice/docker-d08fb19eba5d0123456789abcdef0123456789abcdef0123456789abcdef0123.scope\n',
        'docker v1': '12:cpu,cpuacct:/docker/d08fb19eba5d0123456789abcdef0123456789abcdef0123456789abcdef0123\n',
        'libpod': '0::/machine.slice/libpod-d08fb19eba5d0123456789abcdef0123456789abcdef0123456789abcdef0123.scope\n',
        'containerd': '0::/system.slice/cri-containerd-d08fb19eba5d0123456789abcdef0123456789abcdef0123456789abcdef0123.scope\n',
        'kubepods': '0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1.slice/cri-containerd-d08fb19eba5d.scope\n',
    }

    def test_matching_process_on_the_host_blocks_the_round(self):
        marker = 'prune-busy-test-' + str(os.getpid())
        sleeper = self.start_sleeper(marker)
        before = self.remaining()
        result, _ = self.busy_round(marker, (sleeper, self.HOST))
        self.assertEqual(result['mode'], 'skipped-busy')
        self.assertEqual(self.remaining(), before)

    def test_matching_process_inside_a_container_does_not_block_the_round_and_is_reported(self):
        for name, cgroup in self.CONTAINERS.items():
            with self.subTest(runtime=name):
                marker = 'prune-container-test-%s-%d' % (name.replace(' ', ''), os.getpid())
                sleeper = self.start_sleeper(marker)
                result, output = self.busy_round(marker, (sleeper, cgroup))
                self.assertEqual(result['mode'], 'apply')
                self.assertIn('PRUNE_IGNORED_CONTAINER_PROCESSES', output)

    def test_a_host_process_next_to_a_container_process_still_blocks_the_round(self):
        marker = 'prune-mixed-test-' + str(os.getpid())
        in_container = self.start_sleeper(marker)
        on_host = self.start_sleeper(marker)
        before = self.remaining()
        result, _ = self.busy_round(marker, (in_container, self.CONTAINERS['docker v2']), (on_host, self.HOST))
        self.assertEqual(result['mode'], 'skipped-busy')
        self.assertEqual(self.remaining(), before)

    def test_host_services_with_container_words_in_their_names_still_block_the_round(self):
        for cgroup in (
            '0::/system.slice/docker.service\n',
            '0::/system.slice/containerd.service\n',
            '0::/system.slice/docker-build-runner.service\n',
            '0::/user.slice/libpod-workspace.slice/run.scope\n',
        ):
            with self.subTest(cgroup=cgroup):
                marker = 'prune-hostword-test-%d' % time.monotonic_ns()
                sleeper = self.start_sleeper(marker)
                result, _ = self.busy_round(marker, (sleeper, cgroup))
                self.assertEqual(result['mode'], 'skipped-busy')

    def test_unreadable_cgroup_is_treated_as_a_host_process(self):
        marker = 'prune-unreadable-test-' + str(os.getpid())
        self.start_sleeper(marker)
        result, _ = self.busy_round(marker)
        self.assertEqual(result['mode'], 'skipped-busy')


if __name__ == '__main__':
    unittest.main()
