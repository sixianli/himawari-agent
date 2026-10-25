import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


class GrokWaitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.handoff = self.root / "handoff"
        self.handoff.mkdir()
        self.state = self.root / "phase.txt"
        self.state.write_text("Phase: running\n")
        self.bridge = self.root / "fake-bridge"
        self.bridge.write_text(f'#!/bin/sh\n[ "$1" = runs ] && [ "$2" = run-1 ] && cat {self.state}\n')
        self.bridge.chmod(0o755)
        self.stop = self.handoff / "stop.md"
        self.since = str(int(time.time()) - 1)

    def tearDown(self):
        self.tmp.cleanup()

    def wait(self):
        return subprocess.run(
            ["bash", str(SCRIPTS / "grok-wait.sh"), "run-1", str(self.stop), str(self.handoff), self.since],
            env=dict(os.environ, GROK_BRIDGE_COMMAND=str(self.bridge), GROK_WAIT_POLL_SECONDS="1"),
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

    def later(self, action):
        timer = threading.Timer(2, action)
        timer.start()
        return timer

    def test_stop_file_with_clean_evidence_exits_0(self):
        self.later(lambda: self.stop.write_text("done"))
        result = self.wait()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("WAKE stop-file", result.stdout)
        self.assertIn("EVIDENCE_OK", result.stdout)

    def test_finished_run_with_dependency_copy_exits_3(self):
        def finish():
            bad = self.handoff / "run-02" / "scratch" / "node_modules"
            bad.mkdir(parents=True)
            (bad / "a.js").write_text("x")
            self.state.write_text("Phase: done\n")

        self.later(finish)
        result = self.wait()
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("WAKE run-phase", result.stdout)
        self.assertIn("EVIDENCE_VIOLATION", result.stdout)

    def test_run_unknown_to_the_bridge_is_reported_not_treated_as_finished(self):
        self.bridge.write_text("#!/bin/sh\necho 'Run not found'\n")
        result = self.wait()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
