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
        self.crontab = base / 'crontab'
        self.crontab.write_text('15 3 * * * /usr/bin/true # unrelated\n')
        bin_directory = base / 'bin'
        bin_directory.mkdir()
        (bin_directory / 'launchctl').write_text(f'#!/bin/bash\necho "launchctl $*" >> {self.calls}\n')
        (bin_directory / 'crontab').write_text(f'#!/bin/bash\nif [[ "$1" == -l ]]; then cat {self.crontab}; else cat > {self.crontab}.new && mv {self.crontab}.new {self.crontab}; fi\n')
        for name in ('launchctl', 'crontab'):
            os.chmod(bin_directory / name, 0o755)
        self.environment = {**os.environ, 'HOME': str(self.home), 'PATH': str(bin_directory) + ':' + os.environ['PATH']}

    def tearDown(self):
        self.directory.cleanup()

    def install(self, *arguments):
        child = subprocess.run(['bash', str(HERE / 'install-schedule.sh'), *arguments], capture_output=True, text=True, env=self.environment, check=False)
        self.assertEqual(child.returncode, 0, child.stderr)
        return child.stdout

    def test_hermes_schedule_is_idempotent_and_keeps_other_entries(self):
        self.install('hermes', str(self.root))
        output = self.install('hermes', str(self.root))
        lines = self.crontab.read_text().splitlines()
        self.assertIn('PRUNE_RESULT', output)
        self.assertIn('# unrelated', lines[0])
        prune_lines = [line for line in lines if 'himawari-prune-rebuildable' in line]
        self.assertEqual(len(prune_lines), 1)
        self.assertIn('--apply --skip-if-busy', prune_lines[0])
        self.assertIn(str(self.root), prune_lines[0])
        self.assertTrue((self.home / '.local/share/himawari/prune-rebuildable.py').exists())
        self.install('remove-hermes')
        self.assertEqual(self.crontab.read_text().splitlines(), lines[:1])

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

    def test_missing_root_is_refused(self):
        child = subprocess.run(['bash', str(HERE / 'install-schedule.sh'), 'hermes', str(self.root / 'missing')], capture_output=True, text=True, env=self.environment, check=False)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('PRUNE_SCHEDULE_ROOT_MISSING', child.stderr)


if __name__ == '__main__':
    unittest.main()
