import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[1] / "scripts" / "codex-launch.sh"
LONGTASK = Path(__file__).resolve().parents[2] / "long-task-planning" / "scripts" / "longtask.py"


class CodexLaunchTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="codex-launch-test-"))
        home = self.root / "home"
        home.mkdir()
        (home / ".gitconfig").write_text("")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "LONGTASK_"))}
        self.env.update({
            "HOME": str(home),
            "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CEILING_DIRECTORIES": str(self.root),
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
            "LONGTASK_NOW": "2026-10-02T10:00:00+08:00",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        self.args_file = self.root / "codex-args.txt"
        fake = bin_dir / "codex"
        fake.write_text(f'#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "{self.args_file}"\n')
        fake.chmod(0o755)
        self.env["PATH"] = f"{bin_dir}:{self.env.get('PATH', '/usr/bin:/bin')}"
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.run_ok(["git", "init", "-q", "-b", "main"])
        (self.repo / "README.md").write_text("demo\n")
        self.run_ok([sys.executable, str(LONGTASK), "init", "demo", "--prefix", "T", "--goal", "修完缺陷", "--date", "2026-10-01"])
        items = self.repo / ".agents/tasks/demo/items.json"
        data = json.loads(items.read_text(encoding="utf-8"))
        data["items"] = [{
            "id": "T-A1", "title": "缺陷 A1", "goal_ref": ["G1"],
            "done_when": [{"type": "test", "tag": "T-A1"}],
            "added": {"by": "claude", "on": "2026-10-01"},
        }]
        items.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        self.run_ok(["git", "add", "-A"])
        self.run_ok(["git", "commit", "-q", "-m", "init"])

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_ok(self, command):
        result = subprocess.run(command, cwd=self.repo, env=self.env, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def launch(self, *args):
        return subprocess.run(["bash", str(LAUNCHER), *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=60, check=False)

    def brief(self, text):
        path = self.root / "brief.md"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def add_second_task(self):
        self.run_ok([sys.executable, str(LONGTASK), "init", "other", "--prefix", "U", "--goal", "另一个目标", "--date", "2026-10-01"])
        items = self.repo / ".agents/tasks/other/items.json"
        data = json.loads(items.read_text(encoding="utf-8"))
        data["items"] = [{
            "id": "U-B1", "title": "缺陷 B1", "goal_ref": ["G1"],
            "done_when": [{"type": "test", "tag": "U-B1"}],
            "added": {"by": "claude", "on": "2026-10-01"},
        }]
        items.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        self.run_ok(["git", "add", "-A"])
        self.run_ok(["git", "commit", "-q", "-m", "other"])

    def test_valid_brief_launches_codex_with_the_given_options(self):
        brief = self.brief("# 任务说明\n\n## 2. 范围\n\n- 本批条目：\n  - `T-A1` 先写红测试\n")
        result = self.launch(brief, "handoff/stop-1.md", "--", "-m", "gpt-x", "-c", 'model_reasoning_effort="xhigh"')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.args_file.read_text().splitlines(), [
            "-m", "gpt-x", "-c", 'model_reasoning_effort="xhigh"',
            f"Read {brief} fully, then work per it. The first stop file is handoff/stop-1.md.",
        ])

    def test_brief_without_valid_items_does_not_launch(self):
        for text in ("# 任务说明\n\n## 2. 范围\n\n没有写条目编号\n", "# 任务说明\n\n## 2. 范围\n\n- `T-Z9` 不存在的条目\n"):
            result = self.launch(self.brief(text), "handoff/stop-1.md", "--", "-m", "gpt-x")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.args_file.exists())
            self.assertIn("简报", result.stdout + result.stderr)

    def test_missing_separator_shows_usage_and_does_not_launch(self):
        result = self.launch(self.brief("- T-A1\n"), "handoff/stop-1.md", "-m", "gpt-x")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage", result.stderr)
        self.assertFalse(self.args_file.exists())

    def test_two_open_tasks_infer_the_task_from_the_brief(self):
        self.add_second_task()
        brief = self.brief("# 任务说明\n\n## 2. 范围\n\n- 本批条目：\n  - `T-A1` 先写红测试\n")
        result = self.launch(brief, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.args_file.exists())

    def test_two_open_tasks_refuse_a_brief_matching_neither(self):
        self.add_second_task()
        brief = self.brief("# 任务说明\n\n## 2. 范围\n\n- 本批条目：\n  - `T-Z9` 不存在的条目\n")
        result = self.launch(brief, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.args_file.exists())
        self.assertIn("--task", result.stdout + result.stderr)

    def test_read_only_brief_launches_without_items(self):
        brief = self.brief("只读任务：是\n")
        result = self.launch(brief, "handoff/stop-1.md", "--", "-m", "gpt-x", "-c", 'model_reasoning_effort="xhigh"')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.args_file.read_text().splitlines(), [
            "-m", "gpt-x", "-c", 'model_reasoning_effort="xhigh"',
            f"Read {brief} fully, then work per it. The first stop file is handoff/stop-1.md.",
        ])
        self.assertIn("READ_ONLY_BRIEF", result.stdout)
        self.args_file.unlink()
        fenced = self.brief("```\n只读任务：是\n```\n")
        result = self.launch(fenced, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.args_file.exists())
        indented = self.brief("  只读任务：是\n")
        result = self.launch(indented, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.args_file.exists())
        read_only = self.brief("只读任务：是\n")
        with_task =self.launch("--task", "demo", read_only, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertEqual(with_task.returncode, 0, with_task.stdout + with_task.stderr)
        self.assertIn("READ_ONLY_BRIEF", with_task.stdout)
        self.assertEqual(self.args_file.read_text().splitlines(), [
            "-m", "gpt-x",
            f"Read {read_only} fully, then work per it. The first stop file is handoff/stop-1.md.",
        ])

    def test_without_open_task_launches_a_plain_batch(self):
        with open(self.repo / ".agents/tasks/demo/goal.md", "a", encoding="utf-8") as handle:
            handle.write("\n## CLOSED 2026-10-03 用户原话\n\n> 验收通过\n")
        brief = self.brief("# 任务说明\n\n没有写条目编号\n")
        result = self.launch(brief, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.args_file.exists())

    def test_task_flag_selects_the_task_and_is_not_passed_to_codex(self):
        self.add_second_task()
        brief = self.brief("# 任务说明\n\n## 2. 范围\n\n- 本批条目：\n  - `T-A1` 先写红测试\n")
        result = self.launch("--task", "demo", brief, "handoff/stop-1.md", "--", "-m", "gpt-x",
                             "-c", 'model_reasoning_effort="xhigh"')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.args_file.read_text().splitlines(), [
            "-m", "gpt-x", "-c", 'model_reasoning_effort="xhigh"',
            f"Read {brief} fully, then work per it. The first stop file is handoff/stop-1.md.",
        ])

    def test_task_flag_naming_another_task_checks_the_brief_against_it(self):
        self.add_second_task()
        brief = self.brief("# 任务说明\n\n## 2. 范围\n\n- 本批条目：\n  - `T-A1` 先写红测试\n")
        result = self.launch("--task", "other", brief, "handoff/stop-1.md", "--", "-m", "gpt-x")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.args_file.exists())
        self.assertIn("U-A1", result.stdout + result.stderr)

    def test_task_flag_without_a_value_shows_usage(self):
        brief = self.brief("- T-A1\n")
        for args in (["--task"], ["--task", "", brief, "handoff/stop-1.md", "--", "-m", "gpt-x"]):
            with self.subTest(args=args):
                result = self.launch(*args)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("usage", result.stderr)
                self.assertFalse(self.args_file.exists())


if __name__ == "__main__":
    unittest.main()
