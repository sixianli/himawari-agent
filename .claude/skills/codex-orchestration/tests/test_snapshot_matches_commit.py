import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "snapshot-matches-commit.py"
NAME = "docs/回到-快的.md"


class SnapshotMatchesCommitTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="snapshot-match-test-"))
        home = self.root / "home"
        home.mkdir()
        self.gitconfig = home / ".gitconfig"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update({
            "HOME": str(home),
            "GIT_CONFIG_GLOBAL": str(self.gitconfig),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CEILING_DIRECTORIES": str(self.root),
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        })
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        (self.repo / "docs").mkdir()
        (self.repo / NAME).write_text("one\n", encoding="utf-8")
        (self.repo / "plain.txt").write_text("a\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "base")

    def tearDown(self):
        shutil.rmtree(self.root)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True,
                              capture_output=True, text=True).stdout

    def change_and_snapshot(self, snapshot_text):
        (self.repo / NAME).write_text("two\n", encoding="utf-8")
        (self.repo / "plain.txt").write_text("b\n", encoding="utf-8")
        patch = self.root / "snapshot.patch"
        patch.write_text(self.git("-c", "core.quotepath=true", "diff"), encoding="utf-8")
        self.git("commit", "-qam", "change")
        if snapshot_text is not None:
            (self.repo / NAME).write_text(snapshot_text, encoding="utf-8")
            patch.write_text(self.git("-c", "core.quotepath=true", "diff", "HEAD~1"), encoding="utf-8")
            self.git("checkout", "-q", "--", ".")
        return patch

    def run_script(self, patch):
        self.gitconfig.write_text("[core]\n\tquotepath = false\n")
        return subprocess.run([sys.executable, str(SCRIPT), "HEAD", str(patch)], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, check=False)

    def test_quoted_non_ascii_path_matches_unquoted_commit(self):
        result = self.run_script(self.change_and_snapshot(None))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"{NAME}: same", result.stdout)
        self.assertIn("plain.txt: same", result.stdout)

    def test_quoted_non_ascii_path_with_other_content_is_different(self):
        result = self.run_script(self.change_and_snapshot("three\n"))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"{NAME}: DIFFERENT", result.stdout)


if __name__ == "__main__":
    unittest.main()
