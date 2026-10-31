import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('check_layer0_tests', HERE / 'check-layer0-tests.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def run(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()


class NewCommitsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.directory.name)
        run('init', '-q', '-b', 'main')
        run('config', 'user.email', 'a@b.c')
        run('config', 'user.name', 'n')
        self.commits = []
        for index in range(4):
            run('commit', '-q', '--allow-empty', '-m', 'c' + str(index))
            self.commits.append(run('rev-parse', 'HEAD'))

    def tearDown(self):
        os.chdir(self.previous)
        self.directory.cleanup()

    def test_commits_already_on_a_remote_branch_are_not_checked_for_a_branch_that_lags_behind(self):
        run('update-ref', 'refs/remotes/origin/main', self.commits[2])
        run('update-ref', 'refs/remotes/origin/work', self.commits[0])
        self.assertEqual(checker.new_commits(self.commits[3], self.commits[0]), [self.commits[3]])

    def test_commits_on_no_remote_branch_are_all_checked(self):
        run('update-ref', 'refs/remotes/origin/work', self.commits[0])
        self.assertEqual(checker.new_commits(self.commits[3], self.commits[0]), [self.commits[3], self.commits[2], self.commits[1]])

    def test_a_new_branch_checks_only_commits_no_remote_has(self):
        run('update-ref', 'refs/remotes/origin/main', self.commits[1])
        self.assertEqual(checker.new_commits(self.commits[3], checker.ZERO), [self.commits[3], self.commits[2]])


if __name__ == '__main__':
    unittest.main()
