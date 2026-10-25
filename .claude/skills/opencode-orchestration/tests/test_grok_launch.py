import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "grok-launch.sh"
SESSION = "ses_fixture0002"
TEXT = json.dumps({"type": "text", "timestamp": 1700000000000, "sessionID": SESSION, "part": {"type": "text", "text": "ok"}})


class GrokLaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prefix = self.root / "runs" / "run-01"
        self.brief = self.root / "brief.md"
        self.brief.write_text(f"# brief\n\nStop file: {self.root / 'run-stop.md'}\n")
        self.reply = self.root / "reply.md"
        self.reply.write_text("# reply\n")
        self.args_file = self.root / "args.txt"
        fake = self.root / "fake-opencode"
        live = (
            '{"data":[{"id":"grok-build-0.1","providerID":"xai","variants":[]},'
            '{"id":"grok-4.7","providerID":"xai","variants":[{"id":"low"},{"id":"high"}]}]}'
        )
        fake.write_text(
            "#!/bin/sh\n"
            f'if [ "$1" = api ]; then case "$*" in *"GET /api/model"*) echo \'{live}\'; exit 0 ;; esac; fi\n'
            f'printf "%s\\n" "$@" > {self.args_file}\necho \'{TEXT}\'\n'
        )
        fake.chmod(0o755)
        self.env = dict(os.environ, OC_OPENCODE=str(fake), OC_STARTUP_SECONDS="6", OC_AUTO_RESUMES="0")

    def tearDown(self):
        pid_file = Path(str(self.prefix) + ".pid")
        if pid_file.exists():
            subprocess.run(["kill", pid_file.read_text().strip()], capture_output=True, check=False)
        self.tmp.cleanup()

    def run_launch(self, *args):
        return subprocess.run(
            ["bash", str(SCRIPT), *args], cwd=self.root, env=self.env, capture_output=True, text=True, check=False, timeout=60
        )

    def new(self, model, *extra):
        return self.run_launch("new", str(self.brief), str(self.prefix), model, *extra)

    def resume(self, model):
        return self.run_launch("resume", SESSION, str(self.reply), str(self.root / "stop.md"), str(self.prefix), model)

    def passed_args(self):
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.args_file.exists():
                return self.args_file.read_text().splitlines()
            time.sleep(0.2)
        self.fail("opencode was never started")

    def assert_refused(self, result):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("xai/", result.stderr)
        self.assertFalse(self.prefix.parent.exists(), "a refused launch must not create run files")
        self.assertFalse(self.args_file.exists(), "a refused launch must not start opencode")

    def test_refuses_grok_resold_by_opencode_go(self):
        self.assert_refused(self.new("opencode-go/grok-4.7"))

    def test_refuses_grok_resold_by_opencode_zen_on_resume(self):
        self.assert_refused(self.resume("opencode/grok-build-0.1"))

    def test_refuses_model_without_provider(self):
        self.assert_refused(self.new("grok-build-0.1"))

    def test_refuses_lookalike_providers(self):
        self.assert_refused(self.new("xai-proxy/grok-4.7"))
        self.assert_refused(self.new("opencode-go/xai/grok-4.7"))

    def test_missing_arguments_print_usage(self):
        result = self.run_launch("new", str(self.brief))
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage", result.stderr)
        self.assertFalse(self.args_file.exists())

    def test_new_with_subscription_model_delegates_to_oc_launch(self):
        result = self.new("xai/grok-build-0.1", "custom-title")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"session={SESSION}", result.stdout)
        args = self.passed_args()
        self.assertEqual(args[args.index("-m") + 1], "xai/grok-build-0.1")
        self.assertEqual(args[args.index("--title") + 1], "custom-title")

    def test_resume_keeps_variant_suffix(self):
        result = self.resume("xai/grok-4.7#high")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = self.passed_args()
        self.assertEqual(args[args.index("-m") + 1], "xai/grok-4.7#high")
        self.assertEqual(args[args.index("-s") + 1], SESSION)


if __name__ == "__main__":
    unittest.main()
