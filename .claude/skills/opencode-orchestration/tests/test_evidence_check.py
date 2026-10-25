import io
import os
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
CHECK = SCRIPTS / "evidence-check.py"


def write(path, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def tar_with(path, names):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w:gz") as archive:
        for name in names:
            info = tarfile.TarInfo(name)
            info.size = 2
            archive.addfile(info, io.BytesIO(b"{}"))


class EvidenceCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "evidence"
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, *args, since=0):
        return subprocess.run(
            [sys.executable, str(CHECK), "--since", str(since), *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

    def test_reports_and_logs_pass(self):
        write(self.root / "run-01" / "report.json", b"{}")
        write(self.root / "run-01" / "console.log", b"ok")
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("EVIDENCE_OK", result.stdout)

    def test_dependency_directory_fails(self):
        write(self.root / "run-01" / "scratch" / "node_modules" / "pkg" / "index.js")
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn("EVIDENCE_VIOLATION dependency-or-git-directory", result.stdout)
        self.assertIn("node_modules", result.stdout)

    def test_git_directory_fails(self):
        write(self.root / "run-01" / "source" / ".git" / "HEAD", b"ref: refs/heads/main\n")
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn(".git", result.stdout)

    def test_large_file_without_reason_fails(self):
        write(self.root / "run-01" / "core.bin", b"x" * 2000)
        result = self.check("--max-file-bytes", "1000", str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn("EVIDENCE_VIOLATION large-file-without-reason", result.stdout)

    def test_large_file_with_reason_passes(self):
        write(self.root / "run-01" / "core.bin", b"x" * 2000)
        write(self.root / "run-01" / "EVIDENCE-REASONS.txt", b"core.bin: core dump of the crashed worker\n")
        result = self.check("--max-file-bytes", "1000", str(self.root))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_large_file_with_empty_reason_fails(self):
        write(self.root / "run-01" / "core.bin", b"x" * 2000)
        write(self.root / "run-01" / "EVIDENCE-REASONS.txt", b"core.bin:\n")
        result = self.check("--max-file-bytes", "1000", str(self.root))
        self.assertEqual(result.returncode, 1)

    def test_archive_holding_dependencies_fails(self):
        tar_with(self.root / "run-01" / "scratch-failure.tar.gz", ["h1/source/report.json", "h1/source/node_modules/pkg/index.js"])
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn("EVIDENCE_VIOLATION archive-holds-dependency-or-git", result.stdout)

    def test_archive_fixture_with_reason_passes(self):
        tar_with(self.root / "run-01" / "fictitious-node-modules.tar.gz", ["node_modules/pkg/index.js"])
        write(self.root / "run-01" / "EVIDENCE-REASONS.txt", b"fictitious-node-modules.tar.gz: test fixture with a fake dependency tree\n")
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_dependency_directory_with_reason_passes(self):
        write(self.root / "run-01" / "node_modules" / "pkg" / "index.js")
        write(self.root / "run-01" / "EVIDENCE-REASONS.txt", b"node_modules: the failure is a corrupted install of this tree\n")
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_archive_of_reports_passes(self):
        tar_with(self.root / "run-01" / "reports.tar.gz", ["reports/junit.xml", "reports/vitest.json"])
        result = self.check(str(self.root))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_entries_that_arrived_before_since_are_ignored(self):
        write(self.root / "old" / "node_modules" / "pkg" / "index.js")
        tar_with(self.root / "old" / "scratch.tar.gz", ["x/node_modules/a.js"])
        time.sleep(1.2)
        since = int(time.time())
        write(self.root / "new" / "report.json", b"{}")
        result = self.check(str(self.root), since=since)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_copy_that_keeps_old_modification_times_is_still_new(self):
        since = int(time.time()) - 1
        module = write(self.root / "run-01" / "node_modules" / "pkg" / "index.js")
        old = time.time() - 86400
        for path in [module, module.parent, module.parent.parent]:
            os.utime(path, (old, old))
        result = self.check(str(self.root), since=since)
        self.assertEqual(result.returncode, 1)

    def test_missing_root_is_an_error_not_a_pass(self):
        result = self.check(str(self.root / "absent"))
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("EVIDENCE_OK", result.stdout)

    def test_runs_from_stdin_like_a_remote_host(self):
        write(self.root / "run-01" / "node_modules" / "a.js")
        with CHECK.open("rb") as script:
            result = subprocess.run(
                ["sh", "-c", f"python3 - --since 0 '{self.root}'"],
                stdin=script,
                capture_output=True,
                check=False,
                timeout=60,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"EVIDENCE_VIOLATION", result.stdout)


if __name__ == "__main__":
    unittest.main()


GATE = SCRIPTS / "evidence-gate.sh"


class EvidenceGateQuietRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.handoff = base / "handoff"
        self.handoff.mkdir()
        self.home = base / "home"
        self.home.mkdir()
        self.remote_root = base / "remote-evidence"
        self.remote_root.mkdir()
        self.ran = base / "python3-ran"
        stubs = base / "stubs"
        stubs.mkdir()
        python = stubs / "python3"
        python.write_text(f'#!/bin/sh\necho ran >> "{self.ran}"\nexit 0\n')
        python.chmod(0o755)
        fake = base / "fakessh"
        fake.write_text(
            "#!/bin/sh\n"
            "for a; do last=$a; done\n"
            f'HOME="{self.home}" PATH="{stubs}:/usr/bin:/bin" exec sh -c "$last"\n'
        )
        fake.chmod(0o755)
        (self.handoff / "evidence-roots.txt").write_text(
            f"{fake} testhost|{self.remote_root}\n"
        )
        self.sleeper = None

    def tearDown(self):
        if self.sleeper:
            self.sleeper.kill()
            self.sleeper.wait()
        self.tmp.cleanup()

    def gate(self):
        return subprocess.run(
            ["bash", str(GATE), str(self.handoff), "0"],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_remote_check_runs_without_a_quiet_run(self):
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.ran.exists())

    def test_remote_check_is_deferred_while_a_quiet_run_is_active(self):
        self.sleeper = subprocess.Popen(["sleep", "30"])
        (self.home / ".agent-quiet-run").write_text(f"{self.sleeper.pid} layer4-full\n")
        result = self.gate()
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("EVIDENCE_REMOTE_DEFERRED", result.stdout + result.stderr)
        self.assertIn("layer4-full", result.stdout + result.stderr)
        self.assertFalse(self.ran.exists())

    def test_marker_left_by_a_finished_run_does_not_block(self):
        finished = subprocess.Popen(["true"])
        finished.wait()
        (self.home / ".agent-quiet-run").write_text(f"{finished.pid} old-run\n")
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.ran.exists())
