import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class InstallScheduleTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.home = base / 'home'
        self.home.mkdir()
        self.root = base / 'himawari-tests'
        self.root.mkdir()
        self.calls = base / 'calls'
        bin_directory = base / 'bin'
        bin_directory.mkdir()
        (bin_directory / 'launchctl').write_text(f'#!/bin/bash\necho "launchctl $*" >> {self.calls}\n')
        os.chmod(bin_directory / 'launchctl', 0o755)
        self.environment = {**os.environ, 'HOME': str(self.home), 'PATH': str(bin_directory) + ':' + os.environ['PATH']}

    def tearDown(self):
        self.directory.cleanup()

    def install(self, *arguments):
        child = subprocess.run(['bash', str(HERE / 'install-schedule.sh'), *arguments], capture_output=True, text=True, env=self.environment, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        return child.stdout

    def test_mac_schedule_writes_a_daily_launch_agent(self):
        self.install('mac', str(self.root))
        plist = self.home / 'Library/LaunchAgents/com.himawari.prune-rebuildable.plist'
        text = plist.read_text()
        self.assertIn('<integer>4</integer>', text)
        self.assertIn(f'<string>{self.root}</string>', text)
        self.assertIn('<string>--skip-if-busy</string>', text)
        self.assertIn('launchctl bootstrap', self.calls.read_text())
        self.install('remove-mac')
        self.assertFalse(plist.exists())

    def make_repo(self):
        repo = self.root.parent / 'repo'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(repo)], check=True)
        return repo

    def test_mac_local_schedule_copies_new_scripts_and_reports_only_until_asked(self):
        repo = self.make_repo()
        output = self.install('mac', '--repo', str(repo), str(self.root))
        share = self.home / '.local/share/himawari'
        for name in ('prune-local.py', 'retention.json', 'prune-rebuildable.py'):
            self.assertTrue((share / name).exists(), name)
        self.assertIn('PRUNE_LOCAL_RESULT', output)
        self.assertIn('"mode": "dry-run"', output)
        self.assertIn('mode=report-only', output)
        local_plist = self.home / 'Library/LaunchAgents/com.himawari.prune-local.plist'
        text = local_plist.read_text()
        self.assertIn(f'<string>{repo}</string>', text)
        self.assertIn(f'<string>{share / "retention.json"}</string>', text)
        self.assertNotIn('<string>--apply</string>', text)
        output = self.install('mac', '--repo', str(repo), '--apply-local', str(self.root))
        self.assertIn('"mode": "dry-run"', output)
        self.assertIn('<string>--apply</string>', local_plist.read_text())
        self.install('remove-mac')
        self.assertFalse(local_plist.exists())

    def test_apply_local_without_repo_is_refused(self):
        child = subprocess.run(['bash', str(HERE / 'install-schedule.sh'), 'mac', '--apply-local', str(self.root)], capture_output=True, text=True, env=self.environment, check=False)
        self.assertNotEqual(child.returncode, 0)

    def test_missing_root_is_refused(self):
        child = subprocess.run(['bash', str(HERE / 'install-schedule.sh'), 'mac', str(self.root / 'missing')], capture_output=True, text=True, env=self.environment, check=False)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('PRUNE_SCHEDULE_ROOT_MISSING', child.stderr)


if __name__ == '__main__':
    unittest.main()
