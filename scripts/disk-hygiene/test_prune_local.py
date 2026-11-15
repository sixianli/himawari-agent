import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'prune-local.py'
NOW = time.time()
OLD = NOW - 10 * 86400


def write(path, size=10, mtime=OLD):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x' * size)
    os.utime(path, (mtime, mtime))
    return path


def age(path, mtime=OLD):
    for directory, subdirectories, files in os.walk(path):
        for name in files + subdirectories:
            os.utime(os.path.join(directory, name), (mtime, mtime), follow_symlinks=False)
    os.utime(path, (mtime, mtime))


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


class PruneLocalTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.base = Path(self.directory.name)
        self.cache = self.base / 'cache'
        self.tmp = self.base / 'tmp'
        self.tmp.mkdir()
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'main')
        git(self.repo, 'config', 'user.email', 'test@example.invalid')
        git(self.repo, 'config', 'user.name', 'test')
        (self.repo / '.gitignore').write_text('node_modules/\n.ci-output/\nnotes/\n')
        (self.repo / 'README.md').write_text('hi\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'base')
        git(self.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        config = json.loads((HERE / 'retention.json').read_text())
        config['appleCache'] = str(self.cache)
        self.config = self.base / 'retention.json'
        self.config.write_text(json.dumps(config))

    def tearDown(self):
        self.directory.cleanup()

    def worktree(self, name, branch=None):
        path = self.repo / '.agents/local/worktrees' / name
        git(self.repo, 'worktree', 'add', '-q', '-b', branch or f'wt-{name}', str(path), 'main')
        return path

    def run_prune(self, *arguments, check=True):
        child = subprocess.run(
            [sys.executable, '-I', str(SCRIPT), '--config', str(self.config), '--repo', str(self.repo), '--tmp', str(self.tmp), *arguments],
            capture_output=True, text=True, check=False,
        )
        if check:
            self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        result = next(line for line in child.stdout.splitlines() if line.startswith('PRUNE_LOCAL_RESULT '))
        return json.loads(result.split(' ', 1)[1]), child.stdout

    def test_old_xcode_caches_go_and_recent_or_locked_ones_stay(self):
        old = write(self.cache / 'DerivedData/ios/Build/a.o', 100).parents[1]
        age(old)
        recent = write(self.cache / 'DerivedData/mac/Build/a.o', 100, mtime=NOW).parents[1]
        locked = write(self.cache / 'DerivedData/watch/Build/a.o', 100).parents[1]
        age(locked)
        (self.cache / 'DerivedData/watch.lock').mkdir()
        per_pr = write(self.tmp / 'dd-518-ios/Build/a.o', 100).parents[1]
        age(per_pr)
        legacy = write(self.repo / 'clients/apple/ui-review/DerivedData/Build/a.o', 100).parents[1]
        age(legacy)
        unrelated = write(self.tmp / 'other/Build/a.o', 100).parents[1]
        age(unrelated)

        result, output = self.run_prune()
        self.assertEqual(result['mode'], 'dry-run')
        self.assertTrue(old.exists())
        for path in (old, per_pr, legacy):
            self.assertIn(f'WOULD_DELETE 100 xcode {path}', output)
        self.assertIn(f'KEEP xcode recent {recent}', output)
        self.assertIn(f'KEEP xcode locked {locked}', output)
        self.assertNotIn(str(unrelated), output)

        self.run_prune('--apply')
        self.assertFalse(old.exists())
        self.assertFalse(per_pr.exists())
        self.assertFalse(legacy.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(locked.exists())
        self.assertTrue(unrelated.exists())

    def test_only_merged_clean_idle_worktrees_are_removed(self):
        done = self.worktree('done')
        write(done / 'node_modules/pkg/index.js')
        age(done)
        unmerged = self.worktree('unmerged')
        (unmerged / 'new.txt').write_text('x')
        git(unmerged, 'add', '-A')
        git(unmerged, 'commit', '-q', '-m', 'work')
        age(unmerged)
        dirty = self.worktree('dirty')
        (dirty / 'README.md').write_text('changed\n')
        age(dirty)
        untracked = self.worktree('untracked')
        (untracked / 'scratch.txt').write_text('x')
        age(untracked)
        ignored = self.worktree('ignored')
        write(ignored / 'notes/plan.md')
        age(ignored)
        locked = self.worktree('locked')
        git(self.repo, 'worktree', 'lock', str(locked))
        age(locked)
        recent = self.worktree('recent')
        deploy = self.repo.parent / 'himawari-deploy-wt'
        git(self.repo, 'worktree', 'add', '-q', '-b', 'deploy', str(deploy), 'main')
        age(deploy)
        loose = self.repo / '.cb-delegate/copy-1'
        write(loose / 'file.txt')
        for name in ('done', 'unmerged', 'dirty', 'untracked', 'ignored', 'locked', 'recent'):
            gitdir = self.repo / '.git/worktrees' / name
            age(gitdir)
        age(self.repo / '.git/worktrees/himawari-deploy-wt')

        result, output = self.run_prune('--now', str(NOW))
        self.assertRegex(output, rf'WOULD_DELETE \d+ worktree {done}\n')
        for reason, path in (
            ('unmerged-commits', unmerged), ('uncommitted-changes', dirty), ('uncommitted-changes', untracked),
            ('ignored-files', ignored), ('locked', locked), ('recent', recent), ('keep-list', deploy),
            ('not-a-registered-worktree', loose),
        ):
            self.assertIn(f'KEEP worktree {reason} {path}', output)

        self.run_prune('--apply', '--now', str(NOW))
        self.assertFalse(done.exists())
        for path in (unmerged, dirty, untracked, ignored, locked, recent, deploy, loose):
            self.assertTrue(path.exists(), path)
        self.assertIn('wt-unmerged', git(self.repo, 'branch'))

    def test_vanished_worktree_records_are_pruned(self):
        gone = self.worktree('gone')
        subprocess.run(['rm', '-rf', str(gone)], check=True)
        _, output = self.run_prune()
        self.assertIn('WOULD_PRUNE_WORKTREE_RECORD', output)
        self.run_prune('--apply')
        self.assertNotIn('gone', git(self.repo, 'worktree', 'list'))

    def test_old_packets_lose_only_large_non_log_files(self):
        production = self.repo / '.ci-output/production'
        names = ['2026-10-01-a', '2026-10-02-b', '2026-10-03-c', '2026-10-04-d']
        for name in names:
            write(production / name / 'materials/source.tar.gz', 2 * 1024 * 1024)
            write(production / name / 'run-logs/deploy.log', 2 * 1024 * 1024)
            write(production / name / 'packet-checks.json', 100)
        write(production / '2026-10-01-a/materials/fresh.tar.gz', 2 * 1024 * 1024, mtime=NOW)
        _, output = self.run_prune('--apply')
        self.assertFalse((production / '2026-10-01-a/materials/source.tar.gz').exists())
        self.assertTrue((production / '2026-10-01-a/materials/fresh.tar.gz').exists())
        self.assertTrue((production / '2026-10-01-a/run-logs/deploy.log').exists())
        self.assertTrue((production / '2026-10-01-a/packet-checks.json').exists())
        for name in names[1:]:
            self.assertTrue((production / name / 'materials/source.tar.gz').exists(), name)

    def test_keep_packets_comes_from_the_config(self):
        config = json.loads(self.config.read_text())
        config['keepPackets'] = 1
        self.config.write_text(json.dumps(config))
        production = self.repo / '.ci-output/production'
        for name in ('2026-10-01-a', '2026-10-02-b'):
            write(production / name / 'materials/source.tar.gz', 2 * 1024 * 1024)
        self.run_prune('--apply')
        self.assertFalse((production / '2026-10-01-a/materials/source.tar.gz').exists())
        self.assertTrue((production / '2026-10-02-b/materials/source.tar.gz').exists())

    def test_a_deployed_packet_keeps_its_files_however_many_packets_follow_it(self):
        production = self.repo / '.ci-output/production'
        names = ['2026-10-01-a', '2026-10-02-b', '2026-10-03-c', '2026-10-04-d', '2026-10-05-e']
        for name in names:
            write(production / name / 'materials/source.tar.gz', 2 * 1024 * 1024)
        write(production / '2026-10-02-b/run-logs/deploy-20261002T000000Z.log').write_text('DEPLOY_RESULT {"result":"passed","stoppedAt":"","exit":0}\n')
        write(production / '2026-10-01-a/run-logs/deploy-20261001T000000Z.log').write_text('DEPLOY_RESULT {"result":"recovered","stoppedAt":"S3","exit":1}\n')
        _, output = self.run_prune('--apply')
        self.assertIn(f'KEEP packet deployed {production / "2026-10-02-b"}', output)
        self.assertTrue((production / '2026-10-02-b/materials/source.tar.gz').exists())
        self.assertFalse((production / '2026-10-01-a/materials/source.tar.gz').exists())

    def test_the_repository_given_as_repo_is_never_removed_as_a_worktree(self):
        linked = self.worktree('self')
        age(linked)
        age(self.repo / '.git/worktrees/self')
        child = subprocess.run(
            [sys.executable, '-I', str(SCRIPT), '--config', str(self.config), '--repo', str(linked), '--tmp', str(self.tmp), '--apply', '--now', str(NOW)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertIn(f'KEEP worktree current-repo {linked}', child.stdout)
        self.assertTrue(linked.exists())

    def test_a_running_xcode_build_skips_the_whole_round(self):
        done = self.worktree('done')
        age(done)
        age(self.repo / '.git/worktrees/done')
        marker = 'xcodebuild-prune-local-test-' + str(os.getpid())
        sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', marker])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        deadline = time.time() + 5
        while marker not in Path('/proc', str(sleeper.pid), 'cmdline').read_text() and time.time() < deadline:
            time.sleep(0.02)
        result, _ = self.run_prune('--apply', '--skip-if-busy', '--now', str(NOW), '--proc-root', str(self.base / 'proc'))
        self.assertEqual(result['mode'], 'skipped-busy')
        self.assertTrue(done.exists())

    def test_config_paths_that_leave_their_root_are_refused(self):
        outside = write(self.base / 'outside/Build/a.o').parents[1]
        age(outside)
        for key, value in (('legacyXcodeDirs', ['../outside']), ('legacyXcodeDirs', ['/tmp']), ('appleCache', '~'), ('appleCache', 'relative/cache'), ('tmpXcodePrefix', '../dd-')):
            with self.subTest(key=key, value=value):
                config = json.loads((HERE / 'retention.json').read_text())
                config['appleCache'] = str(self.cache)
                config[key] = value
                self.config.write_text(json.dumps(config))
                child = subprocess.run([sys.executable, '-I', str(SCRIPT), '--config', str(self.config), '--repo', str(self.repo), '--tmp', str(self.tmp), '--apply'], capture_output=True, text=True, check=False)
                self.assertNotEqual(child.returncode, 0)
                self.assertIn(f'PRUNE_CONFIG_INVALID {self.config} {key}', child.stderr)
                self.assertTrue(outside.exists())

    def test_bad_config_stops_before_touching_anything(self):
        old = write(self.tmp / 'dd-1-ios/a.o').parent
        age(old)
        config = json.loads(self.config.read_text())
        config['xcodeIdleDays'] = 0
        self.config.write_text(json.dumps(config))
        child = subprocess.run([sys.executable, '-I', str(SCRIPT), '--config', str(self.config), '--tmp', str(self.tmp), '--apply'], capture_output=True, text=True, check=False)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('PRUNE_CONFIG_INVALID', child.stderr)
        self.assertTrue(old.exists())


if __name__ == '__main__':
    unittest.main()
