import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "longtask.py"
NOW = "2026-10-02T10:00:00+08:00"
TASK = Path(".agents/tasks/demo")
CONTEXT_BUDGET = 1600


def write(base, rel, text):
    path = Path(base) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def item(item_id, checks, **extra):
    data = {
        "id": item_id,
        "title": f"标题 {item_id}",
        "goal_ref": ["G1"],
        "done_when": checks,
        "added": {"by": "claude", "on": "2026-10-01"},
    }
    data.update(extra)
    return data


def tag_check(tag, **extra):
    return {"type": "test", "tag": tag, **extra}


def goal_text(entries):
    lines = ["# 目标：demo", ""]
    for gid, date, source, quote in entries:
        lines += [f"## {gid} {date} {source}", "", f"> {quote}", ""]
    return "\n".join(lines)


def plan_text(batch=(), later=(), log=("- 2026-10-02 10:00 建立任务。",), surprises=(), decisions=()):
    parts = ["# 计划：demo", "", "## 当前批次", "", *batch, "", "## 之后", "", *later, "",
             "## 计划改动记录", "", *log, "", "## 意外和发现", "", *surprises, "", "## 决定", "", *decisions, ""]
    return "\n".join(parts)


def vitest_report(path, results):
    suites = {}
    for file_name, full_name, status in results:
        suites.setdefault(file_name, []).append({
            "ancestorTitles": [],
            "fullName": full_name,
            "status": status,
            "title": full_name,
            "failureMessages": [],
        })
    report = {
        "numTotalTests": len(results),
        "testResults": [
            {"name": name, "status": "passed", "assertionResults": assertions}
            for name, assertions in suites.items()
        ],
    }
    Path(path).write_text(json.dumps(report), encoding="utf-8")


def reorder_evidence(repo, order):
    path = Path(repo) / TASK / "evidence.jsonl"
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    path.write_text("".join(lines[index] + "\n" for index in order), encoding="utf-8")


def touch_later(path, seconds=120):
    stamp = path.stat().st_mtime + seconds
    os.utime(path, (stamp, stamp))


def git_snapshot(repo):
    git_dir = repo / ".git"
    return {
        str(path.relative_to(git_dir)): path.read_bytes()
        for path in sorted(git_dir.rglob("*"))
        if path.is_file() and path.relative_to(git_dir).parts[0] != "longtask"
    }


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="longtask-test-"))
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
            "LONGTASK_NOW": NOW,
            "LONGTASK_HOST": "mac-test",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.counter = 0

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def git(self, cwd, *args):
        result = subprocess.run(["git", *args], cwd=cwd, env=self.env, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def cli(self, cwd, *args, stdin=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=cwd, env=self.env, input=stdin, capture_output=True, text=True, timeout=120, check=False,
        )

    def ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def make_repo(self, name="repo"):
        repo = self.root / name
        repo.mkdir()
        self.git(repo, "init", "-q", "-b", "main")
        write(repo, "src/app.ts", "export const x = 1;\n")
        write(repo, "test/app.test.ts", 'it("[T-A1] adds", () => {});\n')
        write(repo, ".gitignore", "build/\n")
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-q", "-m", "init")
        return repo

    def init_task(self, repo, items=(), goal_entries=None, plan=None, commit=True, extra=None):
        self.ok(self.cli(repo, "init", "demo", "--prefix", "T", "--goal", "修完所有发现的缺陷", "--date", "2026-10-01"))
        task = repo / TASK
        data = json.loads((task / "items.json").read_text(encoding="utf-8"))
        if not extra or "decisions" not in extra:
            data.pop("decisions", None)
        data["items"] = list(items)
        if extra:
            data.update(extra)
        (task / "items.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        if goal_entries is not None:
            (task / "goal.md").write_text(goal_text(goal_entries), encoding="utf-8")
        if plan is not None:
            (task / "plan.md").write_text(plan, encoding="utf-8")
        if commit:
            self.commit_all(repo, "task")
        return task

    def commit_all(self, repo, message):
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-q", "-m", message)

    def set_items(self, repo, items, extra=None):
        path = repo / TASK / "items.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["items"] = list(items)
        if extra:
            data.update(extra)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def records(self, repo):
        text = (repo / TASK / "evidence.jsonl").read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def report_path(self, suffix="json"):
        self.counter += 1
        return self.root / f"report-{self.counter}.{suffix}"

    def record_vitest(self, repo, results, *extra):
        report = self.report_path()
        vitest_report(report, results)
        self.ok(self.cli(repo, "record", "--vitest", str(report), "--by", "helper-agent", *extra))
        return self.records(repo)[-1]

    def fingerprint(self, repo, *args):
        result = self.ok(self.cli(repo, "fingerprint", "--json", *args))
        return json.loads(result.stdout)

    def fingerprint_file(self, repo, host="cloud"):
        data = self.fingerprint(repo)
        data["host"] = host
        path = self.report_path("fp.json")
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def status(self, repo, *args):
        result = self.cli(repo, "status", "--json", "--no-save", *args)
        self.assertIn(result.returncode, (0, 2), result.stdout + result.stderr)
        return result.returncode, json.loads(result.stdout)

    def item_of(self, data, item_id):
        return next(entry for entry in data["items"] if entry["id"] == item_id)

    def status_of(self, repo, item_id):
        return self.item_of(self.status(repo)[1], item_id)["status"]

    def lint(self, repo):
        result = self.cli(repo, "lint")
        return result.returncode, result.stdout + result.stderr

    def passing(self, repo, name="[T-A1] adds", rel="test/app.test.ts"):
        return [(str(repo / rel), name, "passed")]


class InitTests(Base):
    def test_init_reminds_to_skip_task_files_when_a_formatter_is_configured(self):
        plain = self.make_repo("plain")
        output = self.ok(self.cli(plain, "init", "demo", "--prefix", "T", "--goal", "目标")).stdout
        self.assertNotIn("提醒", output)
        for index, config in enumerate(("biome.json", "biome.jsonc", ".prettierrc", "prettier.config.mjs", "dprint.json", ".dprint.jsonc")):
            with self.subTest(config=config):
                repo = self.make_repo(f"repo{index}")
                write(repo, config, "{}\n")
                output = self.ok(self.cli(repo, "init", "demo", "--prefix", "T", "--goal", "目标")).stdout
                self.assertIn(f"提醒：项目有格式化工具配置 {config}", output)
                self.assertIn("把 .agents/tasks/ 加进它的忽略列表", output)
                self.assertTrue((repo / TASK / "items.json").is_file())

    def test_init_creates_files_and_refuses_overwrite(self):
        repo = self.make_repo()
        self.ok(self.cli(repo, "init", "demo", "--prefix", "T", "--goal", "修完所有发现的缺陷", "--date", "2026-10-01"))
        task = repo / TASK
        for name in ("goal.md", "items.json", "plan.md", "evidence.jsonl"):
            self.assertTrue((task / name).exists(), name)
        goal = (task / "goal.md").read_text(encoding="utf-8")
        self.assertIn("## G1 2026-10-01 用户原话", goal)
        self.assertIn("> 修完所有发现的缺陷", goal)
        plan = (task / "plan.md").read_text(encoding="utf-8")
        self.assertIn("- 2026-10-02 10:00 建立任务。", plan)
        items = json.loads((task / "items.json").read_text(encoding="utf-8"))
        self.assertEqual(items["task"], "demo")
        self.assertEqual(items["prefix"], "T")
        self.assertEqual(items["items"], [])
        again = self.cli(repo, "init", "demo", "--prefix", "T", "--goal", "x")
        self.assertEqual(again.returncode, 1)

    def test_init_outside_a_repository_names_the_directory(self):
        outside = self.root / "plain"
        outside.mkdir()
        result = self.cli(self.root, "--repo", str(outside), "init", "demo", "--prefix", "T", "--goal", "x")
        self.assertEqual(result.returncode, 1)
        self.assertIn(str(outside), result.stderr)
        self.assertIn("git 仓库", result.stderr)
        self.assertFalse((outside / ".agents").exists())

    def test_fresh_task_passes_lint(self):
        repo = self.make_repo()
        self.init_task(repo, commit=False)
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)


class DecisionTests(Base):
    def goals(self):
        return [("G1", "2026-10-01", "用户原话", "修完所有发现的缺陷"),
                ("G2", "2026-10-02", "用户原话", "所有测试都在云端跑")]

    def doc_item(self, path="docs/adr/0001-cloud-tests.md", quotes="G2", **extra):
        check = {"type": "doc", "path": path}
        if quotes is not None:
            check["quotes"] = quotes
        return item("T-D1", [check], goal_ref=["G2"], **extra)

    def decisions_task(self, repo, items=(), decisions=None, goal_entries=None, plan=None, commit=True, extra=None):
        data = dict(extra or {})
        data["decisions"] = {"G1": "once"} if decisions is None else decisions
        return self.init_task(repo, items, goal_entries=goal_entries, plan=plan, commit=commit, extra=data)

    def test_init_writes_durable_decision_default(self):
        repo = self.make_repo()
        result = self.ok(self.cli(repo, "init", "demo", "--prefix", "T", "--goal", "修完所有发现的缺陷",
                                  "--date", "2026-10-01"))
        data = json.loads((repo / TASK / "items.json").read_text(encoding="utf-8"))
        self.assertEqual(data.get("decisions"), {"G1": "once"})
        self.assertIn("G1 先记为 once", result.stdout)
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)

    def test_unclassified_durable_decision_is_reported(self):
        repo = self.make_repo()
        self.decisions_task(repo, goal_entries=self.goals())
        code, output = self.lint(repo)
        self.assertEqual(code, 1, output)
        self.assertIn("G2", output)
        self.assertIn("decisions", output)
        _code, data = self.status(repo)
        self.assertTrue(any("G2" in warning for warning in data["warnings"]), data["warnings"])
        context = self.ok(self.cli(repo, "context")).stdout
        self.assertIn("长期决定", context)
        self.assertIn("G2", context)

    def test_invalid_durable_decision_fields_fail_lint(self):
        cases = (
            ("value", {"decisions": {"G1": "maybe"}}, "maybe"),
            ("key", {"decisions": {"G1": "once", "G9": "once"}}, "G9"),
            ("docs", {"decisions": {"G1": "once"}, "decision_docs": "docs/adr/"}, "decision_docs"),
        )
        for index, (label, extra, token) in enumerate(cases):
            with self.subTest(case=label):
                repo = self.make_repo(f"invalid-{index}")
                self.init_task(repo, goal_entries=[("G1", "2026-10-01", "用户原话", "修完所有发现的缺陷")],
                               extra=extra)
                code, output = self.lint(repo)
                self.assertEqual(code, 1, output)
                self.assertIn(token, output)

    def test_durable_decision_needs_a_qualified_item(self):
        cases = (
            ("no item", []),
            ("path outside", [self.doc_item(path="notes/rules.md")]),
            ("no quotes", [self.doc_item(quotes=None)]),
            ("withdrawn", [self.doc_item(withdrawn={"on": "2026-10-03", "ref": "G1"})]),
        )
        repo = self.make_repo("durable")
        decisions = {"G1": "once", "G2": "durable"}
        self.decisions_task(repo, [], decisions, self.goals(), commit=False)
        for label, items in cases:
            with self.subTest(case=label):
                self.set_items(repo, items, extra={"decisions": decisions})
                code, output = self.lint(repo)
                self.assertEqual(code, 1, output)
                self.assertIn("G2", output)
                self.assertIn("文档条目", output)
                if label == "no item":
                    _code, data = self.status(repo)
                    self.assertTrue(any("G2" in warning for warning in data["warnings"]), data["warnings"])
                    context = self.ok(self.cli(repo, "context")).stdout
                    self.assertIn("长期决定", context)
                    self.assertIn("G2", context)
        self.set_items(repo, [self.doc_item()], extra={"decisions": decisions})
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)

    def test_durable_decision_quote_must_appear_verbatim(self):
        repo = self.make_repo()
        self.decisions_task(repo, [self.doc_item()], {"G1": "once", "G2": "durable"}, self.goals())
        self.assertEqual(self.status_of(repo, "T-D1"), "not_done")
        path = "docs/adr/0001-cloud-tests.md"
        write(repo, path, "# ADR\n\n我们决定用云端测试。\n")
        entry = self.item_of(self.status(repo)[1], "T-D1")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn("G2", entry["checks"][0]["reason"])
        self.assertIn("原话", entry["checks"][0]["reason"])
        write(repo, path, "# ADR\n\n用户原话，2026-10-02：\n\n> 所有测试都在\n>   云端跑\n")
        self.assertEqual(self.status_of(repo, "T-D1"), "verified")

    def test_durable_decision_quote_needs_a_known_goal(self):
        repo = self.make_repo()
        self.decisions_task(repo, [self.doc_item(quotes="G8")], {"G1": "once", "G2": "durable"}, self.goals())
        write(repo, "docs/adr/0001-cloud-tests.md", "# ADR\n\n用户原话，2026-10-02：所有测试都在云端跑。\n")
        _code, data = self.status(repo)
        entry = self.item_of(data, "T-D1")
        self.assertEqual(entry["status"], "unknown")
        self.assertIn("G8", entry["checks"][0]["reason"])

    def test_durable_decision_docs_prefix(self):
        custom = self.make_repo("docs-custom")
        self.decisions_task(custom, [self.doc_item(path="AGENTS.md")], {"G1": "once", "G2": "durable"},
                            self.goals(), extra={"decision_docs": ["AGENTS.md"]})
        code, output = self.lint(custom)
        self.assertEqual(code, 0, output)
        default = self.make_repo("docs-default")
        self.decisions_task(default, [self.doc_item(path="AGENTS.md")], {"G1": "once", "G2": "durable"},
                            self.goals())
        code, output = self.lint(default)
        self.assertEqual(code, 1, output)
        self.assertIn("G2", output)

    def test_durable_decision_downgrade_needs_a_plan_record(self):
        repo = self.make_repo()
        self.decisions_task(repo, [self.doc_item()], {"G1": "once", "G2": "durable"}, self.goals())
        self.set_items(repo, [self.doc_item()], extra={"decisions": {"G1": "once", "G2": "once"}})
        plan = repo / TASK / "plan.md"
        for log, expected in (
            (["- 2026-10-02 10:00 建立任务。"], 1),
            (["- 2026-10-02 10:00 建立任务。", "- 2026-10-02 G21 的完成条件调整。"], 1),
            (["- 2026-10-02 10:00 建立任务。", "- 2026-10-02 G2 改为一次性决定。"], 0),
        ):
            with self.subTest(log=log[-1]):
                plan.write_text(plan_text(log=log), encoding="utf-8")
                code, output = self.lint(repo)
                self.assertEqual(code, expected, output)
                if expected:
                    self.assertIn("G2", output)

    def test_removing_durable_decision_key_needs_a_plan_record(self):
        repo = self.make_repo()
        self.decisions_task(repo, goal_entries=self.goals())
        path = repo / TASK / "items.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        del data["decisions"]
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        plan = repo / TASK / "plan.md"
        code, output = self.lint(repo)
        self.assertEqual(code, 1, output)
        self.assertIn("decisions", output)
        plan.write_text(plan_text(log=["- 2026-10-02 10:00 建立任务。",
                                       "- 2026-10-02 删掉 decisions：本任务不启用分类。"]), encoding="utf-8")
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)

    def test_task_without_durable_decision_key_keeps_old_behaviour(self):
        repo = self.make_repo()
        self.init_task(repo, goal_entries=self.goals())
        data = json.loads((repo / TASK / "items.json").read_text(encoding="utf-8"))
        self.assertNotIn("decisions", data)
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)

    def test_selected_durable_decision_quote_uses_the_answer(self):
        repo = self.make_repo()
        self.decisions_task(repo, [self.doc_item()], {"G1": "once", "G2": "durable"},
                            [("G1", "2026-10-01", "用户原话", "修完所有发现的缺陷")], commit=False)
        write(repo, TASK / "goal.md",
              "# 目标：demo\n\n## G1 2026-10-01 用户原话\n\n> 修完所有发现的缺陷\n\n"
              "## G2 2026-10-02 用户选择\n\n问题：长期规则放在哪里？\n\n> 放 docs/adr/\n> 每个决定一个文件。\n")
        self.commit_all(repo, "task")
        path = "docs/adr/0001-cloud-tests.md"
        write(repo, path, "# ADR\n\n问题：长期规则放在哪里？\n")
        entry = self.item_of(self.status(repo)[1], "T-D1")
        self.assertEqual(entry["status"], "not_done")
        write(repo, path, "# ADR\n\n问题：长期规则放在哪里？\n\n> 放 docs/adr/\n> 每个决定一个文件。\n")
        self.assertEqual(self.status_of(repo, "T-D1"), "verified")


class FingerprintTests(Base):
    def test_same_content_same_fingerprint_whether_committed_or_not(self):
        first = self.make_repo("a")
        second = self.root / "b"
        self.git(self.root, "clone", "-q", str(first), str(second))
        write(first, "src/app.ts", "export const x = 2;\n")
        write(second, "src/app.ts", "export const x = 2;\n")
        self.git(second, "commit", "-q", "-am", "change")
        a, b = self.fingerprint(first), self.fingerprint(second)
        self.assertEqual(a["fingerprint"], b["fingerprint"])
        self.assertTrue(a["dirty"])
        self.assertFalse(b["dirty"])
        self.assertNotEqual(a["commit"], b["commit"])

    def test_tracked_change_changes_fingerprint(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        write(repo, "src/app.ts", "export const x = 3;\n")
        self.assertNotEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_untracked_file_counts_and_ignored_file_does_not(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        write(repo, "build/out.js", "generated\n")
        self.assertEqual(before, self.fingerprint(repo)["fingerprint"])
        write(repo, "notes.txt", "new\n")
        self.assertNotEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_task_directory_does_not_count(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        self.init_task(repo, commit=False)
        self.assertEqual(before, self.fingerprint(repo)["fingerprint"])
        self.commit_all(repo, "task")
        self.assertEqual(before, self.fingerprint(repo)["fingerprint"])
        with open(repo / TASK / "plan.md", "a", encoding="utf-8") as handle:
            handle.write("- 2026-10-02 追加一行。\n")
        self.assertEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_configured_exclude_is_ignored(self):
        repo = self.make_repo()
        write(repo, "docs/guide.md", "# guide\n")
        self.commit_all(repo, "docs")
        self.init_task(repo, extra={"fingerprint": {"exclude": ["docs/"]}})
        before = self.fingerprint(repo)
        self.assertEqual(before["excludes"], ["docs/"])
        write(repo, "docs/guide.md", "# guide v2\n")
        self.assertEqual(before["fingerprint"], self.fingerprint(repo)["fingerprint"])
        write(repo, "src/app.ts", "export const x = 4;\n")
        self.assertNotEqual(before["fingerprint"], self.fingerprint(repo)["fingerprint"])

    def test_finder_files_are_ignored_without_global_excludes(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        write(repo, ".DS_Store", "x")
        write(repo, "src/.DS_Store", "x")
        write(repo, "src/._app.ts", "x")
        self.assertEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_deleted_tracked_file_changes_fingerprint(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        (repo / "src/app.ts").unlink()
        self.assertNotEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_mode_change_changes_fingerprint(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)["fingerprint"]
        os.chmod(repo / "src/app.ts", 0o755)
        self.assertNotEqual(before, self.fingerprint(repo)["fingerprint"])

    def test_fingerprint_does_not_write_into_git_directory(self):
        repo = self.make_repo()
        write(repo, "src/app.ts", "export const x = 5;\n")
        write(repo, "src/new.ts", "export const y = 1;\n")
        touch_later(repo / "test/app.test.ts")
        before = git_snapshot(repo)
        data = self.fingerprint(repo)
        self.assertEqual(before, git_snapshot(repo))
        self.assertTrue(data["dirty"])

    def test_global_ignore_rules_apply_like_git_status(self):
        repo = self.make_repo()
        before = self.fingerprint(repo)
        ignore = self.root / "home" / "global-ignore"
        ignore.write_text("*.tmp\n", encoding="utf-8")
        self.git(repo, "config", "--global", "core.excludesFile", str(ignore))
        write(repo, "notes.tmp", "scratch\n")
        after = self.fingerprint(repo)
        self.assertEqual(before["fingerprint"], after["fingerprint"])
        self.assertFalse(after["dirty"])

    def test_list_prints_the_lines_the_fingerprint_hashes(self):
        repo = self.make_repo()
        write(repo, "src/app.ts", "export const x = 7;\n")
        os.chmod(repo / "src/app.ts", 0o755)
        write(repo, "notes.txt", "new\n")
        lines = self.ok(self.cli(repo, "fingerprint", "--list")).stdout.splitlines()
        self.assertEqual([line.split(" ", 2)[2] for line in lines],
                         [".gitignore", "notes.txt", "src/app.ts", "test/app.test.ts"])
        blob = self.git(repo, "hash-object", "src/app.ts").strip()
        self.assertEqual(lines[2], f"100755 {blob} src/app.ts")
        digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
        self.assertEqual(digest, self.fingerprint(repo)["fingerprint"])


class IncludeTests(Base):
    def include_repo(self, checks=None, scope=None):
        repo = self.make_repo()
        write(repo, "other/x.txt", "x\n")
        write(repo, "src/gen/z.ts", "z\n")
        self.commit_all(repo, "more")
        extra = {"fingerprint": scope} if scope else None
        self.init_task(repo, [item("T-A1", checks or [tag_check("T-A1")])], extra=extra)
        return repo

    def host_checkout(self, repo):
        checkout = self.root / "checkout"
        self.git(self.root, "clone", "-q", str(repo), str(checkout))
        shutil.rmtree(checkout / ".agents")
        write(checkout, "other/x.txt", "changed on the test host\n")
        return checkout

    def fingerprint_file_from(self, checkout, *args):
        data = self.fingerprint(checkout, *args)
        data["host"] = "cloud"
        path = self.report_path("fp.json")
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_include_limits_the_fingerprint_to_listed_paths(self):
        repo = self.include_repo(scope={"include": ["src", "test/"], "exclude": ["src/gen/"]})
        lines = self.ok(self.cli(repo, "fingerprint", "--list")).stdout.splitlines()
        self.assertEqual([line.split(" ", 2)[2] for line in lines], ["src/app.ts", "test/app.test.ts"])
        self.record_vitest(repo, self.passing(repo))
        before = self.fingerprint(repo)["fingerprint"]
        write(repo, "other/x.txt", "x2\n")
        write(repo, "third/y.txt", "y\n")
        write(repo, "src/gen/z.ts", "z2\n")
        write(repo, "srcx/a.txt", "a\n")
        self.assertEqual(self.fingerprint(repo)["fingerprint"], before)
        self.assertEqual(self.status_of(repo, "T-A1"), "verified")
        write(repo, "src/app.ts", "export const x = 9;\n")
        entry = self.item_of(self.status(repo)[1], "T-A1")
        self.assertEqual(entry["status"], "older")
        self.assertEqual(entry["changed_files"], ["src/app.ts"])

    def test_include_paths_must_exist(self):
        repo = self.include_repo(scope={"include": ["src/", "scr/"]})
        code, output = self.lint(repo)
        self.assertEqual(code, 1, output)
        self.assertIn("fingerprint.include 里的 scr/", output)
        self.assertNotIn("fingerprint.include 里的 src/", output)
        warnings = self.status(repo)[1]["warnings"]
        self.assertTrue(any("scr/" in warning for warning in warnings), warnings)
        self.set_items(repo, [item("T-A1", [tag_check("T-A1")])], extra={"fingerprint": {"include": "src/"}})
        code, output = self.lint(repo)
        self.assertEqual(code, 1, output)
        self.assertIn("fingerprint.include", output)
        self.set_items(repo, [item("T-A1", [tag_check("T-A1")])], extra={"fingerprint": {"include": ["src/", "test/app.test.ts"]}})
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)

    def test_fingerprint_command_reads_include_and_accepts_the_flag(self):
        repo = self.include_repo(scope={"include": ["src/", "test/"]})
        local = self.fingerprint(repo)
        self.assertEqual(local["includes"], ["src/", "test/"])
        checkout = self.host_checkout(repo)
        self.assertNotEqual(self.fingerprint(checkout)["fingerprint"], local["fingerprint"])
        flagged = self.fingerprint(checkout, "--include", "src/", "--include", "test/")
        self.assertEqual(flagged["fingerprint"], local["fingerprint"])
        self.assertEqual(flagged["includes"], ["src/", "test/"])

    def test_status_shows_the_include_paths(self):
        repo = self.include_repo(scope={"include": ["src/", "test/"]})
        text = self.ok(self.cli(repo, "status", "--no-save")).stdout
        self.assertIn("指纹只看：src/、test/", text)
        self.assertEqual(self.status(repo)[1]["include"], ["src/", "test/"])
        self.set_items(repo, [item("T-A1", [tag_check("T-A1")])], extra={"fingerprint": {}})
        self.assertNotIn("指纹只看", self.ok(self.cli(repo, "status", "--no-save")).stdout)

    def test_scope_change_is_named_instead_of_code_change(self):
        checks = [{"type": "command", "run": "make check"}]
        repo = self.include_repo(checks=checks)
        self.ok(self.cli(repo, "record", "--command", "make check", "--exit-code", "0"))
        self.assertEqual(self.records(repo)[-1]["scope"], {"include": [], "exclude": []})
        self.assertEqual(self.status_of(repo, "T-A1"), "verified")
        self.set_items(repo, [item("T-A1", checks)], extra={"fingerprint": {"include": ["test/", "src/"], "exclude": ["src/gen/"]}})
        entry = self.item_of(self.status(repo)[1], "T-A1")
        self.assertEqual(entry["status"], "older")
        reasons = " ".join(entry["reasons"])
        self.assertIn("指纹范围", reasons)
        self.assertIn("只看 src/、test/，不算 src/gen/", reasons)
        self.assertNotIn("之后代码改过", reasons)
        self.assertEqual(entry["changed_files"], [])
        path = repo / TASK / "evidence.jsonl"
        record = json.loads(path.read_text(encoding="utf-8").splitlines()[-1])
        del record["scope"]
        path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
        reasons = " ".join(self.item_of(self.status(repo)[1], "T-A1")["reasons"])
        self.assertIn("没有文件差别", reasons)

    def test_remote_fingerprint_with_other_scope_is_named(self):
        repo = self.include_repo(scope={"include": ["src/", "test/"]})
        checkout = self.host_checkout(repo)
        record = self.record_vitest(repo, self.passing(repo), "--fingerprint-file", str(self.fingerprint_file_from(checkout)))
        self.assertEqual(record["scope"], {"include": [], "exclude": []})
        entry = self.item_of(self.status(repo)[1], "T-A1")
        self.assertEqual(entry["status"], "older")
        reasons = " ".join(entry["reasons"])
        self.assertIn("指纹范围", reasons)
        self.assertIn("--include", reasons)
        fp_file = self.fingerprint_file_from(checkout, "--include", "src/", "--include", "test/")
        self.record_vitest(repo, self.passing(repo), "--fingerprint-file", str(fp_file))
        self.assertEqual(self.status_of(repo, "T-A1"), "verified")


class RecordTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()
        self.task = self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])

    def test_fingerprint_file_error_lists_required_fields(self):
        report = self.report_path()
        vitest_report(report, self.passing(self.repo))
        fp_file = self.report_path("fp.json")
        fp_file.write_text(json.dumps({"fingerprint": "unknown", "commit": "abc1234", "host": "cloud"}), encoding="utf-8")
        result = self.cli(self.repo, "record", "--vitest", str(report), "--fingerprint-file", str(fp_file), "--by", "helper-agent")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("缺少字段：dirty", result.stderr)
        self.assertIn("必需字段是 fingerprint、commit、dirty", result.stderr)
        example = result.stderr[result.stderr.index("{"):result.stderr.rindex("}") + 1]
        self.assertEqual(set(json.loads(example)), {"fingerprint", "commit", "dirty", "host"})
        self.assertEqual(self.records(self.repo), [])

    def test_vitest_report_counts_tags_with_repository_paths(self):
        fp_file = self.fingerprint_file(self.repo, host="cloud")
        record = self.record_vitest(self.repo, [
            ("/srv/x/source/test/app.test.ts", "suite [T-A1] adds", "passed"),
            ("/srv/x/source/test/app.test.ts", "suite [T-A1] edge", "failed"),
            ("/srv/x/source/test/app.test.ts", "suite [T-A1] later", "skipped"),
            ("/srv/x/source/test/app.test.ts", "plain", "passed"),
        ], "--fingerprint-file", str(fp_file))
        self.assertEqual(record["kind"], "test")
        self.assertEqual(record["counts"], {"passed": 2, "failed": 1, "skipped": 1})
        self.assertEqual(record["tags"]["T-A1"], {"passed": 1, "failed": 1, "files": ["test/app.test.ts"]})
        self.assertEqual(record["host"], "cloud")
        self.assertEqual(record["by"], "helper-agent")
        self.assertEqual(len(record["artifacts"]), 1)
        self.assertEqual(len(record["artifacts"][0]["sha256"]), 64)

    def test_record_uses_fingerprint_file(self):
        fp_file = self.report_path("fp.json")
        fp_file.write_text(json.dumps({"fingerprint": "f" * 64, "commit": "c" * 40, "dirty": True, "host": "cloud"}))
        record = self.record_vitest(self.repo, self.passing(self.repo), "--fingerprint-file", str(fp_file))
        self.assertEqual(record["fingerprint"], "f" * 64)
        self.assertEqual(record["commit"], "c" * 40)
        self.assertTrue(record["dirty"])
        self.assertEqual(record["host"], "cloud")

    def test_remote_host_without_fingerprint_file_is_refused(self):
        report = self.report_path()
        vitest_report(report, self.passing(self.repo))
        result = self.cli(self.repo, "record", "--vitest", str(report), "--host", "cloud")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records(self.repo), [])

    def test_local_record_uses_current_fingerprint(self):
        record = self.record_vitest(self.repo, self.passing(self.repo))
        self.assertEqual(record["fingerprint"], self.fingerprint(self.repo)["fingerprint"])
        self.assertEqual(record["host"], "mac-test")

    def test_junit_report_is_parsed(self):
        report = self.report_path("xml")
        report.write_text(
            '<testsuites><testsuite name="s">'
            '<testcase classname="test/app.test.ts" name="[T-A1] adds"/>'
            '<testcase classname="test/app.test.ts" name="[T-A1] fails"><failure message="x"/></testcase>'
            '<testcase classname="test/app.test.ts" name="[T-A1] crashes"><error message="boom"/></testcase>'
            '<testcase classname="test/app.test.ts" name="[T-A1] later"><skipped/></testcase>'
            '</testsuite></testsuites>', encoding="utf-8")
        self.ok(self.cli(self.repo, "record", "--junit", str(report)))
        record = self.records(self.repo)[-1]
        self.assertEqual(record["counts"], {"passed": 1, "failed": 2, "skipped": 1})
        self.assertEqual(record["tags"]["T-A1"], {"passed": 1, "failed": 2, "files": ["test/app.test.ts"]})

    def test_pytest_junit_report_maps_module_names_to_files(self):
        write(self.repo, "py/tests/test_app.py", "# [T-A1]\ndef test_adds():\n    pass\n")
        report = self.report_path("xml")
        report.write_text(
            '<testsuites><testsuite name="pytest">'
            '<testcase classname="tests.test_app" name="test_adds[T-A1]"/>'
            '<testcase classname="tests.test_app.TestGroup" name="test_more[T-A1]"/>'
            '</testsuite></testsuites>', encoding="utf-8")
        self.ok(self.cli(self.repo, "record", "--junit", str(report)))
        record = self.records(self.repo)[-1]
        self.assertEqual(record["tags"]["T-A1"], {"passed": 2, "failed": 0, "files": ["py/tests/test_app.py"]})
        self.assertNotIn("unresolved_files", record)

    def test_command_record(self):
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0", "--by", "claude"))
        record = self.records(self.repo)[-1]
        self.assertEqual(record["kind"], "command")
        self.assertEqual(record["command"], "make check")
        self.assertEqual(record["exit_code"], 0)
        self.assertEqual(record["fingerprint"], self.fingerprint(self.repo)["fingerprint"])

    def test_review_record_stores_file_hashes(self):
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-A1", "--verdict", "approved",
                         "--files", "src/app.ts", "--by", "claude"))
        record = self.records(self.repo)[-1]
        blob = self.git(self.repo, "hash-object", "src/app.ts").strip()
        self.assertEqual(record["kind"], "review")
        self.assertEqual(record["items"], ["T-A1"])
        self.assertEqual(record["verdict"], "approved")
        self.assertEqual(record["files"], {"src/app.ts": blob})

    def test_evidence_file_is_only_appended(self):
        self.record_vitest(self.repo, self.passing(self.repo))
        first = (self.repo / TASK / "evidence.jsonl").read_bytes()
        self.record_vitest(self.repo, self.passing(self.repo))
        second = (self.repo / TASK / "evidence.jsonl").read_bytes()
        self.assertTrue(second.startswith(first))
        self.assertEqual(len(self.records(self.repo)), 2)

    def test_report_run_time_is_recorded(self):
        self.env["TZ"] = "UTC"
        report = self.report_path()
        vitest_report(report, self.passing(self.repo))
        data = json.loads(report.read_text(encoding="utf-8"))
        data["startTime"] = 1790700000000
        report.write_text(json.dumps(data), encoding="utf-8")
        self.ok(self.cli(self.repo, "record", "--vitest", str(report)))
        self.assertEqual(self.records(self.repo)[-1]["ran_at"], "2026-09-29T16:40:00+00:00")
        junit = self.report_path("xml")
        junit.write_text(
            '<testsuites>'
            '<testsuite name="b" timestamp="2026-09-29T17:05:00.250Z"><testcase classname="test/app.test.ts" name="[T-A1] b"/></testsuite>'
            '<testsuite name="a" timestamp="2026-09-29T16:59:02.137Z"><testcase classname="test/app.test.ts" name="[T-A1] a"/></testsuite>'
            '</testsuites>', encoding="utf-8")
        self.ok(self.cli(self.repo, "record", "--junit", str(junit)))
        self.assertEqual(self.records(self.repo)[-1]["ran_at"], "2026-09-29T16:59:02+00:00")
        self.record_vitest(self.repo, self.passing(self.repo))
        self.assertNotIn("ran_at", self.records(self.repo)[-1])

    def test_selected_tests_are_recorded_for_selector_checks(self):
        self.set_items(self.repo, [item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds"}])])
        record = self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "suite adds", "passed")])
        self.assertEqual(record["selected"], [{"file": "test/app.test.ts", "name": "adds", "passed": 1, "failed": 0}])

    def test_retract_record(self):
        target = self.record_vitest(self.repo, self.passing(self.repo))
        self.ok(self.cli(self.repo, "record", "--retract", target["id"], "--reason", "环境问题"))
        record = self.records(self.repo)[-1]
        self.assertEqual(record["kind"], "retract")
        self.assertEqual(record["target"], target["id"])
        self.assertEqual(record["reason"], "环境问题")

    def test_retract_unknown_record_is_refused(self):
        result = self.cli(self.repo, "record", "--retract", "E-missing", "--reason", "x")
        self.assertEqual(result.returncode, 1)


class StatusTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()

    def test_verified_then_older_after_code_change(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        code, data = self.status(self.repo)
        self.assertEqual(code, 0)
        self.assertEqual(self.item_of(data, "T-A1")["status"], "verified")
        write(self.repo, "src/app.ts", "export const x = 9;\n")
        code, data = self.status(self.repo)
        self.assertEqual(code, 0)
        entry = self.item_of(data, "T-A1")
        self.assertEqual(entry["status"], "older")
        self.assertIn("src/app.ts", entry["changed_files"])

    def test_reading_commands_do_not_write_into_git_directory(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.commit_all(self.repo, "evidence")
        write(self.repo, "src/app.ts", "export const x = 6;\n")
        self.commit_all(self.repo, "change")
        touch_later(self.repo / "test/app.test.ts")
        before = git_snapshot(self.repo)
        self.assertEqual(self.status_of(self.repo, "T-A1"), "older")
        self.ok(self.cli(self.repo, "status"))
        self.lint(self.repo)
        self.ok(self.cli(self.repo, "context"))
        self.ok(self.cli(self.repo, "hook", stdin=json.dumps({"source": "startup", "cwd": str(self.repo)})))
        self.assertEqual(before, git_snapshot(self.repo))

    def test_task_directory_edits_keep_verified(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.commit_all(self.repo, "evidence")
        with open(self.repo / TASK / "plan.md", "a", encoding="utf-8") as handle:
            handle.write("- 2026-10-02 追加。\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")

    def test_tag_never_seen_is_not_done(self):
        self.init_task(self.repo, [item("T-A2", [tag_check("T-A2")])])
        code, data = self.status(self.repo)
        self.assertEqual(code, 0)
        entry = self.item_of(data, "T-A2")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn("[T-A2]", " ".join(entry["reasons"]))

    def test_tag_seen_before_but_missing_now_is_unknown(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "test/app.test.ts", 'it("adds", () => {});\n')
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        entry = self.item_of(data, "T-A1")
        self.assertEqual(entry["status"], "unknown")
        self.assertIn("[T-A1]", " ".join(entry["reasons"]))

    def test_tag_in_docs_does_not_count_as_test_file(self):
        write(self.repo, "docs/notes.md", "修复 [T-A1] 的说明\n")
        self.commit_all(self.repo, "docs")
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")

    def test_every_tagged_file_must_run_on_current_code(self):
        write(self.repo, "test/other.test.ts", 'it("[T-A1] other", () => {});\n')
        self.commit_all(self.repo, "other")
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn("test/other.test.ts", " ".join(entry["reasons"]))
        self.record_vitest(self.repo, self.passing(self.repo, "[T-A1] other", "test/other.test.ts"))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")

    def test_failure_on_current_code_blocks_until_retracted(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        failed = self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "[T-A1] adds", "failed")])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "not_done")
        self.ok(self.cli(self.repo, "record", "--retract", failed["id"], "--reason", "磁盘满导致的环境失败"))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")

    def test_host_restriction(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1", host="cloud")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "not_done")
        fp_file = self.fingerprint_file(self.repo, host="cloud")
        self.record_vitest(self.repo, self.passing(self.repo), "--fingerprint-file", str(fp_file))
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")

    def test_status_names_passes_on_other_hosts(self):
        self.init_task(self.repo, [
            item("T-A1", [tag_check("T-A1", host="cloud")]),
            item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds", "host": "cloud"}]),
            item("T-C1", [{"type": "command", "run": "make check", "host": "cloud"}]),
        ])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        code, data = self.status(self.repo)
        self.assertEqual(code, 0)
        for tid in ("T-A1", "T-S1", "T-C1"):
            entry = self.item_of(data, tid)
            self.assertEqual(entry["status"], "not_done")
            reasons = " ".join(entry["reasons"])
            self.assertIn("另有 1 条通过记录在 mac-test 上", reasons)
            self.assertIn("这条检查只认 cloud", reasons)
        reasons_s = " ".join(self.item_of(data, "T-S1")["reasons"])
        self.assertIn("（只认 cloud 上的结果）", reasons_s)
        self.set_items(self.repo, [
            item("T-A1", [tag_check("T-A1", host="cloud")]),
            item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds", "host": "cloud"}]),
            item("T-C1", [{"type": "command", "run": "make check", "host": "cloud"}]),
            item("T-A2", [tag_check("T-A1", host="mac-test")]),
        ])
        code, data = self.status(self.repo)
        entry_a2 = self.item_of(data, "T-A2")
        self.assertEqual(entry_a2["status"], "verified")
        self.assertNotIn("另有", " ".join(entry_a2["reasons"]))

    def test_user_decision_states(self):
        self.init_task(self.repo, [
            item("T-U1", [{"type": "user", "ref": None, "question": "要不要做 X？"}]),
            item("T-U2", [{"type": "user", "ref": "G2"}]),
        ])
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        self.assertEqual(self.item_of(data, "T-U1")["status"], "waiting")
        self.assertIn("要不要做 X？", " ".join(self.item_of(data, "T-U1")["reasons"]))
        self.assertEqual(self.item_of(data, "T-U2")["status"], "unknown")
        with open(self.repo / TASK / "goal.md", "a", encoding="utf-8") as handle:
            handle.write("\n## G2 2026-10-02 用户原话\n\n> 做 X\n")
        code, data = self.status(self.repo)
        self.assertEqual(code, 0)
        self.assertEqual(self.item_of(data, "T-U2")["status"], "verified")

    def test_review_check_follows_reviewed_file_contents(self):
        self.init_task(self.repo, [item("T-R1", [{"type": "review"}])])
        self.assertEqual(self.status_of(self.repo, "T-R1"), "not_done")
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "approved",
                         "--files", "src/app.ts"))
        self.assertEqual(self.status_of(self.repo, "T-R1"), "verified")
        write(self.repo, "test/app.test.ts", 'it("[T-A1] adds more", () => {});\n')
        self.assertEqual(self.status_of(self.repo, "T-R1"), "verified")
        write(self.repo, "src/app.ts", "export const x = 7;\n")
        entry = self.item_of(self.status(self.repo)[1], "T-R1")
        self.assertEqual(entry["status"], "older")
        self.assertIn("src/app.ts", entry["changed_files"])

    def test_rejected_review_is_not_done(self):
        self.init_task(self.repo, [item("T-R1", [{"type": "review"}])])
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "rejected",
                         "--files", "src/app.ts"))
        self.assertEqual(self.status_of(self.repo, "T-R1"), "not_done")

    def test_command_check(self):
        self.init_task(self.repo, [item("T-C1", [{"type": "command", "run": "make check"}])])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        self.assertEqual(self.status_of(self.repo, "T-C1"), "verified")
        write(self.repo, "src/app.ts", "export const x = 8;\n")
        self.assertEqual(self.status_of(self.repo, "T-C1"), "older")
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "1"))
        self.assertEqual(self.status_of(self.repo, "T-C1"), "not_done")

    def test_withdrawn_items(self):
        self.init_task(self.repo, [
            item("T-W1", [tag_check("T-W1")], withdrawn={"on": "2026-10-02", "ref": "G1"}),
            item("T-W2", [tag_check("T-W2")], withdrawn={"on": "2026-10-02", "ref": "G9"}),
        ])
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        self.assertEqual(self.item_of(data, "T-W1")["status"], "withdrawn")
        self.assertEqual(self.item_of(data, "T-W2")["status"], "unknown")
        self.assertEqual(data["counts"]["withdrawn"], 1)

    def test_combined_checks_use_priority(self):
        self.init_task(self.repo, [
            item("T-M1", [tag_check("T-A1"), {"type": "user", "ref": None, "question": "确认？"}]),
            item("T-M2", [tag_check("T-A1"), tag_check("T-M2")]),
            item("T-M3", [tag_check("T-A1"), {"type": "command", "run": "make check"}]),
        ])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        write(self.repo, "src/app.ts", "export const x = 6;\n")
        self.record_vitest(self.repo, self.passing(self.repo))
        _, data = self.status(self.repo)
        self.assertEqual(self.item_of(data, "T-M1")["status"], "waiting")
        self.assertEqual(self.item_of(data, "T-M2")["status"], "not_done")
        self.assertEqual(self.item_of(data, "T-M3")["status"], "older")

    def test_missing_goal_reference_is_unknown(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")], goal_ref=["G7"])])
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        entry = self.item_of(data, "T-A1")
        self.assertEqual(entry["status"], "unknown")
        self.assertIn("G7", " ".join(entry["reasons"]))

    def test_doc_check(self):
        self.init_task(self.repo, [item("T-D1", [{"type": "doc", "path": "docs/guide.md", "heading": "安装"}])])
        self.assertEqual(self.status_of(self.repo, "T-D1"), "not_done")
        write(self.repo, "docs/guide.md", "# 指南\n\n安装步骤待写\n")
        self.assertEqual(self.status_of(self.repo, "T-D1"), "not_done")
        write(self.repo, "docs/guide.md", "# 指南\n\n## 安装\n\n步骤\n")
        self.assertEqual(self.status_of(self.repo, "T-D1"), "verified")

    def test_selector_check_states(self):
        self.init_task(self.repo, [item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds"}])])
        self.assertEqual(self.status_of(self.repo, "T-S1"), "not_done")
        self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "suite adds", "passed")])
        self.assertEqual(self.status_of(self.repo, "T-S1"), "verified")
        write(self.repo, "test/app.test.ts", 'it("[T-A1] plus", () => {});\n')
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        self.assertEqual(self.item_of(data, "T-S1")["status"], "unknown")

    def test_selector_name_must_appear_verbatim_in_the_source(self):
        write(self.repo, "test/each.test.ts", 'it.each(["one", "two"])("adds %s twice", () => {});\n')
        self.init_task(self.repo, [
            item("T-S1", [{"type": "test", "file": "test/each.test.ts", "name": "adds one twice"}]),
            item("T-S2", [{"type": "test", "file": "test/each.test.ts", "name": "adds"}]),
        ])
        check = self.item_of(self.status(self.repo)[1], "T-S1")["checks"][0]
        self.assertEqual(check["status"], "not_done")
        self.assertIn("原样", check["reason"])
        self.record_vitest(self.repo, [(str(self.repo / "test/each.test.ts"), "adds one twice", "passed"),
                                       (str(self.repo / "test/each.test.ts"), "adds two twice", "passed")])
        code, data = self.status(self.repo)
        check = self.item_of(data, "T-S1")["checks"][0]
        self.assertEqual(code, 2)
        self.assertEqual(check["status"], "unknown")
        self.assertIn("原样", check["reason"])
        self.assertEqual(self.item_of(data, "T-S2")["status"], "verified")

    def test_backfilled_reports_with_unknown_fingerprints_are_not_merged(self):
        for order in (("failed", "passed"), ("passed", "failed")):
            with self.subTest(order=order):
                repo = self.make_repo(f"repo-{order[0]}")
                self.init_task(repo, [item("T-A1", [tag_check("T-A1")]),
                                      item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds"}])])
                fp_file = self.report_path("fp.json")
                fp_file.write_text(json.dumps({"fingerprint": "unknown", "dirty": True, "host": "cloud",
                                               "commit": self.git(repo, "rev-parse", "HEAD").strip()}), encoding="utf-8")
                for result in order:
                    self.record_vitest(repo, [(str(repo / "test/app.test.ts"), "suite [T-A1] adds", result)],
                                       "--fingerprint-file", str(fp_file))
                self.assertEqual(self.status_of(repo, "T-A1"), "older")
                self.assertEqual(self.status_of(repo, "T-S1"), "older")

    def test_pass_and_failure_on_the_same_older_code_do_not_count_as_passed(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "[T-A1] adds", "failed")])
        write(self.repo, "src/app.ts", "export const x = 11;\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "not_done")

    def test_older_evidence_shows_when_the_tests_ran(self):
        self.env["TZ"] = "UTC"
        write(self.repo, "test/sub.test.ts", 'it("[T-B1] subtracts", () => {});\n')
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-B1", [tag_check("T-B1")])])
        report = self.report_path()
        vitest_report(report, self.passing(self.repo))
        data = json.loads(report.read_text(encoding="utf-8"))
        data["startTime"] = 1790700000000
        report.write_text(json.dumps(data), encoding="utf-8")
        self.ok(self.cli(self.repo, "record", "--vitest", str(report)))
        self.record_vitest(self.repo, self.passing(self.repo, name="[T-B1] subtracts", rel="test/sub.test.ts"))
        write(self.repo, "src/app.ts", "export const x = 12;\n")
        data = self.status(self.repo)[1]
        ran = self.item_of(data, "T-A1")["checks"][0]
        recorded = self.item_of(data, "T-B1")["checks"][0]
        self.assertEqual((ran["status"], recorded["status"]), ("older", "older"))
        self.assertIn("2026-09-29 16:40", ran["reason"])
        self.assertNotIn("记录于", ran["reason"])
        self.assertIn("记录于 2026-10-02 10:00", recorded["reason"])

    def test_unfinished_item_lists_every_check_still_needed(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1"), {"type": "review", "by": "claude"},
                                                 {"type": "doc", "path": ".gitignore"}])])
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "src/app.ts", "export const x = 13;\n")
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "not_done")
        self.assertEqual([check["status"] for check in entry["checks"]], ["older", "not_done", "verified"])
        self.assertEqual(len(entry["reasons"]), 2)
        self.assertIn("审核", entry["reasons"][0])
        self.assertIn("[T-A1]", entry["reasons"][1])
        self.assertIn("src/app.ts", entry["changed_files"])

    def test_changes_since_last_saved_status(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.ok(self.cli(self.repo, "status", "--json"))
        write(self.repo, "src/app.ts", "export const x = 10;\n")
        result = self.ok(self.cli(self.repo, "status", "--json"))
        data = json.loads(result.stdout)
        self.assertIn({"id": "T-A1", "from": "verified", "to": "older"}, data["changes_since_last"])

    def test_human_output_uses_plain_labels(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-A2", [tag_check("T-A2")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        result = self.ok(self.cli(self.repo, "status", "--no-save"))
        self.assertIn("当前版本已验证", result.stdout)
        self.assertIn("未完成", result.stdout)
        self.assertIn("共 2 项", result.stdout)

    def test_total_counts_withdrawn_items(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]),
                                   item("T-W1", [tag_check("T-W1")], withdrawn={"on": "2026-10-02", "ref": "G1"})])
        for command in ("status", "context"):
            with self.subTest(command=command):
                output = self.ok(self.cli(self.repo, command, *(["--no-save"] if command == "status" else []))).stdout
                self.assertIn("共 2 项", output)
                self.assertIn("不做 1", output)

    def test_brief_status_prints_one_line_per_item(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-B1", [tag_check("T-B1")]),
                                   item("T-W1", [tag_check("T-W1")], withdrawn={"on": "2026-10-02", "ref": "G1"})])
        self.record_vitest(self.repo, self.passing(self.repo))
        full = self.ok(self.cli(self.repo, "status", "--no-save")).stdout
        self.assertIn("还没有带 [T-B1] 的测试", full)
        lines = self.ok(self.cli(self.repo, "status", "--brief", "--no-save")).stdout.splitlines()
        self.assertEqual(len(lines), 4, lines)
        self.assertIn("共 3 项：当前版本已验证 1 · 未完成 1 · 不做 1", lines[0])
        self.assertEqual(lines[1:], ["T-B1  未完成  标题 T-B1", "T-A1  当前版本已验证  标题 T-A1", "T-W1  不做  标题 T-W1"])
        both = self.cli(self.repo, "status", "--brief", "--json", "--no-save")
        self.assertNotEqual(both.returncode, 0)
        self.assertIn("--brief", both.stderr)


class ReviewTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()
        self.init_task(self.repo, [item("T-R1", [{"type": "review", "by": "claude"}])])

    def review(self, *args):
        return self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "approved", "--by", "claude", *args)

    def test_backfilled_review_binds_to_the_reviewed_commit(self):
        reviewed = self.git(self.repo, "rev-parse", "HEAD").strip()
        reviewed_blob = self.git(self.repo, "rev-parse", f"{reviewed}:src/app.ts").strip()
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        self.commit_all(self.repo, "change after the review")
        result = self.ok(self.review("--files", "src/app.ts", "--commit", reviewed[:7]))
        self.assertIn(reviewed[:7], result.stdout)
        record = self.records(self.repo)[-1]
        self.assertEqual(record["files"], {"src/app.ts": reviewed_blob})
        self.assertEqual(record["reviewed_commit"], reviewed)
        entry = self.item_of(self.status(self.repo)[1], "T-R1")
        self.assertEqual(entry["status"], "older")
        self.assertEqual(entry["changed_files"], ["src/app.ts"])

    def test_review_commit_must_contain_the_files(self):
        reviewed = self.git(self.repo, "rev-parse", "HEAD").strip()
        write(self.repo, "src/new.ts", "export const y = 1;\n")
        result = self.review("--files", "src/new.ts", "--commit", reviewed)
        self.assertEqual(result.returncode, 1)
        self.assertIn("src/new.ts", result.stderr)
        self.assertIn("不存在", result.stderr)
        result = self.review("--files", "src/app.ts", "--commit", "0" * 40)
        self.assertEqual(result.returncode, 1)
        self.assertIn("不存在", result.stderr)
        result = self.review("--files", "src", "--commit", reviewed)
        self.assertEqual(result.returncode, 1)
        self.assertIn("不存在", result.stderr)
        result = self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0", "--commit", reviewed)
        self.assertEqual(result.returncode, 1)
        self.assertIn("--review", result.stderr)
        self.assertEqual(self.records(self.repo), [])

    def test_review_without_files_needs_a_note(self):
        result = self.review()
        self.assertEqual(result.returncode, 1)
        self.assertIn("--no-files", result.stderr)
        result = self.review("--no-files")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--note", result.stderr)
        for extra in (("--files", "src/app.ts"), ("--commit", "HEAD")):
            with self.subTest(extra=extra):
                result = self.review("--no-files", "--note", "测试环境问题", *extra)
                self.assertEqual(result.returncode, 1)
                self.assertIn("--no-files", result.stderr)
        self.assertEqual(self.records(self.repo), [])

    def test_review_without_files_ignores_code_changes(self):
        self.ok(self.review("--no-files", "--note", "测试环境的 umask 问题，和代码无关"))
        self.assertEqual(self.records(self.repo)[-1]["files"], {})
        entry = self.item_of(self.status(self.repo)[1], "T-R1")
        self.assertEqual(entry["status"], "verified")
        self.assertIn("测试环境的 umask 问题", " ".join(entry["reasons"]))
        write(self.repo, "src/app.ts", "export const x = 5;\n")
        self.assertEqual(self.status_of(self.repo, "T-R1"), "verified")
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "rejected", "--by", "claude",
                         "--no-files", "--note", "复查发现还有问题"))
        self.assertEqual(self.status_of(self.repo, "T-R1"), "not_done")

    def test_latest_review_is_chosen_by_time_not_line_order(self):
        for first, second, expected in (("rejected", "approved", "verified"), ("approved", "rejected", "not_done")):
            with self.subTest(order=(first, second)):
                path = self.repo / TASK / "evidence.jsonl"
                path.write_text("", encoding="utf-8")
                for verdict, when in ((first, "2026-10-02T10:00:00+08:00"), (second, "2026-10-02T10:05:00+08:00")):
                    self.env["LONGTASK_NOW"] = when
                    self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", verdict,
                                     "--by", "claude", "--no-files", "--note", verdict))
                self.assertEqual(self.status_of(self.repo, "T-R1"), expected)
                reorder_evidence(self.repo, [1, 0])
                self.assertEqual(self.status_of(self.repo, "T-R1"), expected)


class EnvironmentCheckTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()

    def env_check(self, **extra):
        return {"type": "command", "run": "bwrap --version", "scope": "environment", "host": "mac-test",
                "max_age_days": 7, **extra}

    def record_run(self, exit_code, when):
        self.env["LONGTASK_NOW"] = when
        self.ok(self.cli(self.repo, "record", "--command", "bwrap --version", "--exit-code", str(exit_code)))

    def test_environment_check_names_passes_on_other_hosts(self):
        self.init_task(self.repo, [item("T-E1", [self.env_check(host="cloud")])])
        self.record_run(0, "2026-10-02T10:00:00+08:00")
        entry = self.item_of(self.status(self.repo)[1], "T-E1")
        self.assertEqual(entry["status"], "not_done")
        reasons = " ".join(entry["reasons"])
        self.assertIn("还没有在 cloud 上跑", reasons)
        self.assertIn("另有 1 条通过记录在 mac-test 上", reasons)

    def test_environment_command_check_follows_age_not_code(self):
        self.init_task(self.repo, [item("T-E1", [self.env_check()]), item("T-E2", [self.env_check(host="cloud")])])
        entry = self.item_of(self.status(self.repo)[1], "T-E1")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn("mac-test", " ".join(entry["reasons"]))
        self.record_run(0, "2026-10-02T10:00:00+08:00")
        self.assertEqual(self.status_of(self.repo, "T-E1"), "verified")
        self.assertEqual(self.status_of(self.repo, "T-E2"), "not_done")
        write(self.repo, "src/app.ts", "export const x = 3;\n")
        self.commit_all(self.repo, "code")
        self.env["LONGTASK_NOW"] = "2026-10-09T09:00:00+08:00"
        self.assertEqual(self.status_of(self.repo, "T-E1"), "verified")
        self.env["LONGTASK_NOW"] = "2026-10-09T11:00:00+08:00"
        entry = self.item_of(self.status(self.repo)[1], "T-E1")
        self.assertEqual(entry["status"], "older")
        self.assertIn("7 天", " ".join(entry["reasons"]))
        self.record_run(1, "2026-10-09T11:00:00+08:00")
        self.assertEqual(self.status_of(self.repo, "T-E1"), "not_done")
        self.record_run(0, "2026-10-09T12:00:00+08:00")
        self.assertEqual(self.status_of(self.repo, "T-E1"), "verified")

    def test_latest_environment_record_is_chosen_by_time_not_line_order(self):
        self.init_task(self.repo, [item("T-E1", [self.env_check()])])
        self.record_run(1, "2026-10-02T10:00:00+08:00")
        self.record_run(0, "2026-10-02T11:00:00+08:00")
        self.env["LONGTASK_NOW"] = "2026-10-02T12:00:00+08:00"
        self.assertEqual(self.status_of(self.repo, "T-E1"), "verified")
        reorder_evidence(self.repo, [1, 0])
        self.assertEqual(self.status_of(self.repo, "T-E1"), "verified")
        self.record_run(1, "2026-10-02T03:30:00+00:00")
        reorder_evidence(self.repo, [2, 0, 1])
        self.env["LONGTASK_NOW"] = "2026-10-02T12:00:00+08:00"
        entry = self.item_of(self.status(self.repo)[1], "T-E1")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn("失败", " ".join(entry["reasons"]))

    def test_environment_command_check_needs_host_and_max_age(self):
        without_host = self.env_check()
        without_host.pop("host")
        cases = [
            ("T-B1", without_host, "host"),
            ("T-B2", self.env_check(max_age_days=0), "max_age_days"),
            ("T-B3", self.env_check(max_age_days="7"), "max_age_days"),
            ("T-B4", self.env_check(scope="global"), "scope"),
        ]
        self.init_task(self.repo, [item(item_id, [check]) for item_id, check, _ in cases])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        for item_id, _, word in cases:
            with self.subTest(item=item_id):
                lines = [line for line in output.splitlines() if item_id in line]
                self.assertTrue(lines, output)
                self.assertIn(word, " ".join(lines))
        code, data = self.status(self.repo)
        self.assertEqual(code, 2)
        self.assertEqual({entry["status"] for entry in data["items"]}, {"unknown"})


class TestExcludeTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()
        write(self.repo, "docs/guide.md", "# 指南\n")
        self.commit_all(self.repo, "docs")

    def task_with(self, items):
        return self.init_task(self.repo, items, extra={"fingerprint": {"test_exclude": ["docs/"]}})

    def head(self):
        return self.git(self.repo, "rev-parse", "HEAD").strip()

    def fresh_repo(self, name):
        repo = self.make_repo(name)
        write(repo, "docs/guide.md", "# 指南\n")
        self.commit_all(repo, "docs")
        return repo

    def test_doc_only_change_keeps_test_evidence_current(self):
        self.task_with([item("T-A1", [tag_check("T-A1")]),
                        item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds"}]),
                        item("T-H1", [tag_check("T-A1", host="cloud")])])
        tested = self.head()
        self.record_vitest(self.repo, self.passing(self.repo))
        fp_file = self.fingerprint_file(self.repo, host="cloud")
        self.record_vitest(self.repo, self.passing(self.repo), "--fingerprint-file", str(fp_file))
        write(self.repo, "docs/guide.md", "# 指南\n\n新的一段\n")
        for stage in ("uncommitted", "committed"):
            with self.subTest(stage=stage):
                if stage == "committed":
                    self.commit_all(self.repo, "docs only")
                data = self.status(self.repo)[1]
                for item_id in ("T-A1", "T-S1", "T-H1"):
                    entry = self.item_of(data, item_id)
                    self.assertEqual(entry["status"], "verified", entry)
                    self.assertEqual(entry["changed_files"], [])
                    check = entry["checks"][0]
                    self.assertIn(tested[:7], check["reason"])
                    self.assertIn("测试不读", check["reason"])
                    self.assertEqual(check["changed_files"], ["docs/guide.md"])
                output = self.ok(self.cli(self.repo, "status", "--no-save")).stdout
                self.assertIn(tested[:7], output)
                self.assertIn("docs/guide.md", output)

    def test_evidence_recorded_before_its_commit_is_relaxed_from_that_commit(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        recorded = self.record_vitest(self.repo, self.passing(self.repo))
        self.commit_all(self.repo, "code and evidence")
        tested = self.head()
        self.assertNotEqual(recorded["commit"], tested)
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.commit_all(self.repo, "docs only")
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "verified", entry)
        self.assertIn(f"测试跑在 {tested[:7]} 上", entry["checks"][0]["reason"])
        self.assertEqual(entry["checks"][0]["changed_files"], ["docs/guide.md"])
        write(self.repo, "src/app.ts", "export const x = 3;\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "older")

    def test_code_change_after_doc_only_change_is_older(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "older")
        self.assertIn("src/app.ts", entry["changed_files"])

    def test_failure_then_doc_only_change_stays_not_done(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        self.commit_all(self.repo, "code")
        failed = self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "[T-A1] adds", "failed")])
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "not_done")
        self.assertIn(failed["id"], " ".join(entry["reasons"]))

    def test_uncommitted_or_unknown_test_records_are_not_relaxed(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "src/app.ts", "export const x = 1;\n")
        fp_file = self.report_path("fp.json")
        fp_file.write_text(json.dumps({"fingerprint": "unknown", "commit": self.head(), "dirty": False, "host": "cloud"}),
                           encoding="utf-8")
        self.record_vitest(self.repo, self.passing(self.repo), "--fingerprint-file", str(fp_file))
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "older")

    def test_never_committed_alone_doc_change_keeps_evidence_current(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        recorded = self.record_vitest(self.repo, self.passing(self.repo))
        self.assertEqual(recorded["test_exclude"], ["docs/"])
        self.assertIn("code_fingerprint", recorded)
        write(self.repo, "docs/guide.md", "# 指南\n\n新的一段\n")
        for stage in ("uncommitted", "committed"):
            with self.subTest(stage=stage):
                if stage == "committed":
                    self.commit_all(self.repo, "code and docs")
                entry = self.item_of(self.status(self.repo)[1], "T-A1")
                self.assertEqual(entry["status"], "verified", entry)
                self.assertEqual(entry["changed_files"], [])
                check = entry["checks"][0]
                self.assertIn("测试不读", check["reason"])
                self.assertIn("加记录时未提交的改动", check["reason"])
                self.assertEqual(check["changed_files"], ["docs/guide.md"])

    def test_never_committed_alone_later_code_change_is_older(self):
        for label, change_docs in (("code", False), ("code and docs", True)):
            with self.subTest(change=label):
                repo = self.fresh_repo(f"repo-{label.replace(' ', '-')}")
                self.init_task(repo, [item("T-A1", [tag_check("T-A1")])],
                               extra={"fingerprint": {"test_exclude": ["docs/"]}})
                write(repo, "src/app.ts", "export const x = 2;\n")
                self.record_vitest(repo, self.passing(repo))
                write(repo, "src/app.ts", "export const x = 3;\n")
                if change_docs:
                    write(repo, "docs/guide.md", "# 改了文档\n")
                entry = self.item_of(self.status(repo)[1], "T-A1")
                self.assertEqual(entry["status"], "older", entry)
                self.assertIn("src/app.ts", entry["changed_files"])

    def test_never_committed_alone_changed_test_exclude_is_older(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        self.record_vitest(self.repo, self.passing(self.repo))
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "verified")
        self.set_items(self.repo, [item("T-A1", [tag_check("T-A1")])],
                       extra={"fingerprint": {"test_exclude": ["docs/", "CHANGELOG.md"]}})
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "older", entry)

    def test_never_committed_alone_without_test_exclude_records_no_fields(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        recorded = self.record_vitest(self.repo, self.passing(self.repo))
        self.assertNotIn("code_fingerprint", recorded)
        self.assertNotIn("test_exclude", recorded)
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.assertEqual(self.status_of(self.repo, "T-A1"), "older")

    def test_never_committed_alone_failure_survives_doc_change(self):
        self.task_with([item("T-A1", [tag_check("T-A1")])])
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        failed = self.record_vitest(self.repo, [(str(self.repo / "test/app.test.ts"), "[T-A1] adds", "failed")])
        write(self.repo, "docs/guide.md", "# 只改文档\n")
        self.commit_all(self.repo, "code and docs")
        entry = self.item_of(self.status(self.repo)[1], "T-A1")
        self.assertEqual(entry["status"], "not_done", entry)
        self.assertIn(failed["id"], " ".join(entry["reasons"]))

    def test_ignore_test_exclude_command_follows_doc_only_change(self):
        self.task_with([item("T-C1", [{"type": "command", "run": "make check", "ignore_test_exclude": True}]),
                        item("T-C2", [{"type": "command", "run": "make check"}])])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        write(self.repo, "docs/guide.md", "# 改了文档\n")
        data = self.status(self.repo)[1]
        entry = self.item_of(data, "T-C1")
        self.assertEqual(entry["status"], "verified", entry)
        self.assertIn("测试不读", entry["checks"][0]["reason"])
        self.assertEqual(entry["checks"][0]["changed_files"], ["docs/guide.md"])
        self.assertEqual(self.item_of(data, "T-C2")["status"], "older")

    def test_ignore_test_exclude_command_ages_with_code_changes(self):
        self.task_with([item("T-C1", [{"type": "command", "run": "make check", "ignore_test_exclude": True}])])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        write(self.repo, "src/app.ts", "export const x = 2;\n")
        entry = self.item_of(self.status(self.repo)[1], "T-C1")
        self.assertEqual(entry["status"], "older", entry)
        self.assertIn("src/app.ts", entry["changed_files"])

    def test_ignore_test_exclude_command_failure_survives_doc_change(self):
        self.task_with([item("T-C1", [{"type": "command", "run": "make check", "ignore_test_exclude": True}])])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "1"))
        recorded = self.records(self.repo)[-1]
        write(self.repo, "docs/guide.md", "# 改了文档\n")
        entry = self.item_of(self.status(self.repo)[1], "T-C1")
        self.assertEqual(entry["status"], "not_done", entry)
        self.assertIn(recorded["id"], " ".join(entry["reasons"]))

    def test_commands_and_reviews_ignore_test_exclude(self):
        self.task_with([item("T-C1", [{"type": "command", "run": "make check"}]), item("T-R1", [{"type": "review"}])])
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0"))
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "approved",
                         "--files", "docs/guide.md"))
        write(self.repo, "docs/guide.md", "# 改了文档\n")
        self.assertEqual(self.status_of(self.repo, "T-C1"), "older")
        self.assertEqual(self.status_of(self.repo, "T-R1"), "older")

    def test_test_exclude_must_be_a_list_of_paths(self):
        items = [item("T-A1", [tag_check("T-A1")])]
        self.init_task(self.repo, items)
        for value in ("docs/", ["docs/", 3]):
            with self.subTest(value=value):
                self.set_items(self.repo, items, extra={"fingerprint": {"test_exclude": value}})
                code, output = self.lint(self.repo)
                self.assertEqual(code, 1, output)
                self.assertIn("test_exclude", output)
        self.set_items(self.repo, items, extra={"fingerprint": {"test_exclude": ["docs/"]}})
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)


DESCRIBE = "calculator operations"
MATH_SPEC = """describe("calculator operations", () => {
  it("adds [T-A1] numbers", () => {});
  it("subtracts numbers", () => {});
  it.each(["one", "two"])("parses %s value", () => {});
});
"""
STATE_SPEC = """it.each([["idle", "running"], ["running", "idle"]])("allows %s -> %s", () => {});
it.each([["running", "running"]])("rejects %s -> %s", () => {});
it("keeps running after a retry", () => {});
"""


class FindTestsTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()
        write(self.repo, "test/math.test.ts", MATH_SPEC)
        self.commit_all(self.repo, "math tests")

    def find(self, *args):
        return self.cli(self.repo, "find-tests", *args)

    def names(self, *args):
        result = self.find(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [json.loads(line)["name"] for line in result.stdout.splitlines()]

    def math_results(self):
        spec = str(self.repo / "test/math.test.ts")
        return [(spec, f"{DESCRIBE} {title}", "passed") for title in ("adds [T-A1] numbers", "subtracts numbers", "parses one value", "parses two value")]

    def write_report(self, results):
        report = self.report_path()
        vitest_report(report, results)
        data = json.loads(report.read_text(encoding="utf-8"))
        for suite in data["testResults"]:
            for assertion in suite["assertionResults"]:
                if assertion["fullName"].startswith(DESCRIBE + " "):
                    assertion.update(ancestorTitles=[DESCRIBE], title=assertion["fullName"].removeprefix(DESCRIBE + " "))
        report.write_text(json.dumps(data), encoding="utf-8")
        return report

    def test_find_tests_prints_checks_that_verify_after_recording(self):
        report = self.write_report(self.math_results())
        result = self.find("--vitest", str(report))
        self.assertEqual(result.returncode, 0, result.stderr)
        checks = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(checks, [
            {"type": "test", "file": "test/math.test.ts", "name": "adds [T-A1] numbers"},
            {"type": "test", "file": "test/math.test.ts", "name": "subtracts numbers"},
            {"type": "test", "file": "test/math.test.ts", "name": "parses"},
        ])
        self.assertIn("“parses”同时对应报告里这个文件的 2 个测试", result.stderr)
        self.init_task(self.repo, [item(f"T-S{n}", [check]) for n, check in enumerate(checks, 1)])
        self.ok(self.cli(self.repo, "record", "--vitest", str(report), "--by", "helper-agent"))
        data = self.status(self.repo)[1]
        self.assertEqual([self.item_of(data, f"T-S{n}")["status"] for n in (1, 2, 3)], ["verified"] * 3)

    def test_find_tests_prefers_template_words_to_parameter_values(self):
        write(self.repo, "test/state.test.ts", STATE_SPEC)
        self.commit_all(self.repo, "state tests")
        spec = str(self.repo / "test/state.test.ts")
        report = self.write_report([*[(spec, title, "passed") for title in ("allows idle -> running", "allows running -> idle", "rejects running -> running")],
                                    (spec, "keeps running after a retry", "failed")])
        result = self.find("--vitest", str(report), "--commit", "HEAD")
        self.assertEqual(result.returncode, 0, result.stderr)
        checks = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([check["name"] for check in checks], ["allows", "rejects", "keeps running after a retry"])
        self.assertIn("“allows”同时对应报告里这个文件的 2 个测试", result.stderr)
        self.init_task(self.repo, [item(f"T-S{n}", [check]) for n, check in enumerate(checks, 1)])
        self.ok(self.cli(self.repo, "record", "--vitest", str(report), "--by", "helper-agent"))
        data = self.status(self.repo)[1]
        self.assertEqual([self.item_of(data, f"T-S{n}")["status"] for n in (1, 2, 3)], ["verified", "verified", "not_done"])

    def test_find_tests_filters_by_commit_and_word(self):
        write(self.repo, "test/text.test.ts", 'it("trims [T-B1] spaces", () => {});\nit("Joins words", () => {});\n')
        self.commit_all(self.repo, "text tests")
        text_commit = self.git(self.repo, "rev-parse", "HEAD").strip()
        text = str(self.repo / "test/text.test.ts")
        report = self.write_report([*self.math_results()[:2], (text, "trims [T-B1] spaces", "passed"), (text, "Joins words", "failed"),
                                    (text, "ignores case", "skipped"), ("/elsewhere/gone.test.ts", "gone", "passed")])
        result = self.find("--vitest", str(report), "--commit", text_commit)
        self.assertEqual([json.loads(line)["name"] for line in result.stdout.splitlines()], ["trims [T-B1] spaces", "Joins words"])
        self.assertIn("1 个测试被跳过（skipped），没有列出", result.stderr)
        self.assertIn("报告里的文件 /elsewhere/gone.test.ts 在仓库里找不到", result.stderr)
        self.assertEqual(self.names("--vitest", str(report), "--grep", "NUMBERS"), ["adds [T-A1] numbers", "subtracts numbers"])
        self.assertEqual(self.names("--vitest", str(report), "--commit", text_commit, "--grep", "join"), ["Joins words"])
        nothing = self.find("--vitest", str(report), "--grep", "no such words")
        self.assertEqual((nothing.returncode, nothing.stdout), (0, ""))
        self.assertIn("报告里没有符合条件的测试，没有列出任何检查", nothing.stderr)
        self.assertNotIn("没有列出任何检查", self.find("--vitest", str(report), "--grep", "join").stderr)
        missing = self.find("--vitest", str(report), "--commit", "0000000")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("提交 0000000 不存在", missing.stderr)
        write(self.repo, "test/test_util.py", "class UtilTests:\n    def test_rounds_half_up(self):\n        pass\n")
        junit = self.report_path("xml")
        junit.write_text('<testsuite><testcase classname="test_util.UtilTests" name="test_rounds_half_up" file="test/test_util.py"/></testsuite>',
                         encoding="utf-8")
        result = self.find("--junit", str(junit))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"type": "test", "file": "test/test_util.py", "name": "test_rounds_half_up"})


class LintTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()

    def test_goal_must_only_grow(self):
        self.init_task(self.repo)
        goal = self.repo / TASK / "goal.md"
        original = goal.read_text(encoding="utf-8")
        with open(goal, "a", encoding="utf-8") as handle:
            handle.write("\n## G2 2026-10-02 用户原话\n\n> 新决定\n")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)
        goal.write_text(original.replace("修完所有发现的缺陷", "修完一部分缺陷"), encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("goal.md", output)

    def test_committed_goal_rewrite_is_found_in_history(self):
        self.init_task(self.repo)
        goal = self.repo / TASK / "goal.md"
        goal.write_text(goal.read_text(encoding="utf-8").replace("修完所有发现的缺陷", "修一部分"), encoding="utf-8")
        self.commit_all(self.repo, "rewrite goal")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("goal.md", output)

    def test_evidence_must_only_grow(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.record_vitest(self.repo, self.passing(self.repo))
        self.commit_all(self.repo, "evidence")
        path = self.repo / TASK / "evidence.jsonl"
        path.write_text(path.read_text(encoding="utf-8").replace('"passed": 1', '"passed": 2'), encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("evidence.jsonl", output)

    def record_command(self, by):
        self.ok(self.cli(self.repo, "record", "--command", "make check", "--exit-code", "0", "--by", by))
        return (self.repo / TASK / "evidence.jsonl").read_text(encoding="utf-8").splitlines()[-1]

    def commit_lines(self, lines, message):
        staged = self.root / "staged.jsonl"
        staged.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        blob = self.git(self.repo, "hash-object", "-w", str(staged)).strip()
        self.git(self.repo, "update-index", "--cacheinfo", f"100644,{blob},{TASK / 'evidence.jsonl'}")
        self.git(self.repo, "commit", "-q", "-m", message)

    def test_evidence_lines_inserted_between_committed_lines_pass(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        first = self.record_command("helper-agent")
        self.commit_all(self.repo, "first evidence")
        other = self.record_command("claude")
        own = self.record_command("helper-agent")
        self.commit_lines([first, own], "helper agent commits only its own line")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)
        self.commit_all(self.repo, "claude commits its line")
        self.assertEqual(self.git(self.repo, "show", f"HEAD:{TASK / 'evidence.jsonl'}").splitlines(), [first, other, own])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)

    def test_evidence_reordered_or_removed_committed_lines_fail(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        lines = [self.record_command("helper-agent") for _ in range(3)]
        self.commit_all(self.repo, "evidence")
        path = self.repo / TASK / "evidence.jsonl"
        for name, changed in (("swapped", [lines[1], lines[0], lines[2]]), ("removed", [lines[0], lines[2]]),
                              ("moved to the end", [lines[1], lines[2], lines[0]])):
            with self.subTest(change=name):
                path.write_text("".join(line + "\n" for line in changed), encoding="utf-8")
                code, output = self.lint(self.repo)
                self.assertEqual(code, 1, output)
                self.assertIn("evidence.jsonl 不是只追加", output)
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        self.assertEqual(self.lint(self.repo)[0], 0)

    def test_goal_line_inserted_between_old_lines_fails(self):
        self.init_task(self.repo, goal_entries=[("G1", "2026-10-01", "用户原话", "修完所有发现的缺陷"),
                                                ("G2", "2026-10-02", "用户原话", "先修 A")],
                       plan=plan_text(surprises=["- 2026-10-01 发现 A。", "- 2026-10-02 发现 B。"]))
        goal = self.repo / TASK / "goal.md"
        original = goal.read_text(encoding="utf-8")
        goal.write_text(original.replace("> 修完所有发现的缺陷\n", "> 修完所有发现的缺陷\n> 但是不修 B\n"), encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1, output)
        self.assertIn("goal.md 不是只追加", output)
        goal.write_text(original, encoding="utf-8")
        plan = self.repo / TASK / "plan.md"
        plan.write_text(plan_text(surprises=["- 2026-10-01 发现 A。", "- 2026-10-01 补一条。", "- 2026-10-02 发现 B。"]),
                        encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1, output)
        self.assertIn("意外和发现", output)

    def test_evidence_time_must_be_readable(self):
        self.init_task(self.repo, [item("T-R1", [{"type": "review", "by": "claude"}])])
        self.ok(self.cli(self.repo, "record", "--review", "--items", "T-R1", "--verdict", "approved", "--by", "claude",
                         "--no-files", "--note", "看过"))
        path = self.repo / TASK / "evidence.jsonl"
        record = json.loads(path.read_text(encoding="utf-8").splitlines()[-1])
        record.update(id="E-hand-written", time="昨天下午")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1, output)
        self.assertIn("evidence.jsonl 第 2 行的时间", output)
        self.assertIn("昨天下午", output)
        code, data = self.status(self.repo)
        self.assertTrue(any("第 2 行的时间" in warning for warning in data["warnings"]), data["warnings"])
        self.assertEqual(self.item_of(data, "T-R1")["status"], "verified")

    def test_status_words_and_checkboxes_only_allowed_in_logs(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        plan = self.repo / TASK / "plan.md"
        plan.write_text(plan_text(batch=["- T-A1：已完成"]), encoding="utf-8")
        self.assertEqual(self.lint(self.repo)[0], 1)
        plan.write_text(plan_text(batch=["- [x] T-A1：先写红测试"]), encoding="utf-8")
        self.assertEqual(self.lint(self.repo)[0], 1)
        plan.write_text(plan_text(batch=["- T-A1：先写红测试，再修"],
                                  log=["- 2026-10-02 10:00 建立任务。", "- 2026-10-02 T-A1 的红测试已完成，转入修复。"]),
                        encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)

    def test_withdrawn_item_may_have_no_completion_conditions(self):
        withdrawn = {"on": "2026-10-02", "ref": "G1"}
        without_key = item("T-W2", [], withdrawn=withdrawn)
        del without_key["done_when"]
        items = [item("T-A1", [tag_check("T-A1")]), item("T-W1", [], withdrawn=withdrawn), without_key]
        self.init_task(self.repo, items)
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)
        data = self.status(self.repo)[1]
        self.assertEqual([self.item_of(data, value)["status"] for value in ("T-W1", "T-W2")], ["withdrawn", "withdrawn"])
        self.set_items(self.repo, [*items, item("T-B1", [])])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1, output)
        self.assertIn("条目 T-B1 没有完成条件", output)
        self.assertNotIn("T-W1 没有完成条件", output)
        self.assertNotIn("T-W2 没有完成条件", output)

    def test_commit_and_review_progress_words_are_refused(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        plan = self.repo / TASK / "plan.md"
        for line, word in (("- T-A1：修复已提交（325ef03）", "已提交"), ("- T-A1：已修，等完整测试", "已修"),
                           ("- T-A1：分支已合并", "已合并"), ("- T-A1：已审核", "已审核"), ("- T-A1：已推送", "已推送"),
                           ("- T-A1：待验证", "待验证"), ("- T-A1：待审核", "待审核"), ("- T-A1：已做完", "已做完")):
            with self.subTest(word=word):
                plan.write_text(plan_text(batch=[line]), encoding="utf-8")
                code, output = self.lint(self.repo)
                self.assertEqual(code, 1, output)
                self.assertIn(f"“{word}”", output)
                self.assertIn("只写做什么、用什么证据", output)
        plan.write_text(plan_text(batch=["- T-A1：修好后提交，推送前由 Claude 审核；证据：提交里跑过的单元测试全过"]), encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)

    def test_changed_completion_condition_needs_a_log_line(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.set_items(self.repo, [item("T-A1", [tag_check("T-A1", host="cloud")])])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("T-A1", output)
        plan = self.repo / TASK / "plan.md"
        plan.write_text(plan_text(log=["- 2026-10-02 10:00 建立任务。",
                                       "- 2026-10-02 T-A1 的完成条件改为只认云服务器结果，因为 Mac 不跑测试。"]),
                        encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)

    def test_removing_an_item_is_refused(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-A2", [tag_check("T-A2")])])
        self.set_items(self.repo, [item("T-A1", [tag_check("T-A1")])])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("T-A2", output)

    def test_current_batch_is_limited_to_three_items(self):
        items = [item(f"T-A{n}", [tag_check(f"T-A{n}")]) for n in range(1, 5)]
        self.init_task(self.repo, items, plan=plan_text(batch=[f"- T-A{n}：做法" for n in range(1, 5)]))
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("当前批次", output)

    def test_batch_counts_only_lines_that_start_with_an_item(self):
        items = [item(f"T-A{n}", [tag_check(f"T-A{n}")]) for n in range(1, 6)]
        batch = [f"- T-A{n}：做法，和 T-A5 共用夹具" for n in range(1, 4)]
        batch.append("- 顺带验证（不占名额）：T-A4、T-A5、T-A9 由同一次完整测试提供证据")
        self.init_task(self.repo, items, plan=plan_text(batch=batch))
        code, output = self.lint(self.repo)
        self.assertEqual(code, 0, output)
        self.assertIn("当前批次里的 T-A9 在 items.json 里不存在", output)
        self.assertNotIn("T-A4 在 items.json", output)

    def test_invalid_items_are_reported(self):
        self.init_task(self.repo, [
            item("T-A1", [tag_check("T-A1")]),
            item("T-A1", [tag_check("T-A1")]),
            item("T-B1", [{"type": "magic"}]),
            item("T-C1", [tag_check("T-C1")], goal_ref=["G9"]),
            item("X-1", [tag_check("X-1")]),
            item("T-E1", []),
        ], commit=False)
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        for token in ("T-A1", "magic", "G9", "X-1", "T-E1"):
            self.assertIn(token, output)

    def test_selector_name_with_a_template_placeholder_is_refused(self):
        self.init_task(self.repo, [item("T-S1", [{"type": "test", "file": "test/app.test.ts", "name": "adds %s twice"}])],
                       commit=False)
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("T-S1", output)
        self.assertIn("%s", output)
        self.assertEqual(self.status_of(self.repo, "T-S1"), "unknown")

    def test_log_sections_must_only_grow(self):
        self.init_task(self.repo, plan=plan_text(surprises=["- 2026-10-01 发现 A。"]))
        plan = self.repo / TASK / "plan.md"
        plan.write_text(plan_text(surprises=["- 2026-10-01 发现 B。"]), encoding="utf-8")
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1)
        self.assertIn("意外和发现", output)

    def test_ignore_test_exclude_lint_requires_a_boolean(self):
        for index, value in enumerate(("yes", 1)):
            with self.subTest(value=value):
                repo = self.make_repo(f"lint-bool-{index}")
                self.init_task(repo, [item("T-C1", [
                    {"type": "command", "run": "make check", "ignore_test_exclude": value}])], commit=False)
                code, output = self.lint(repo)
                self.assertEqual(code, 1, output)
                self.assertIn("ignore_test_exclude", output)
                self.assertIn("true", output)
        valid = self.make_repo("lint-bool-valid")
        self.init_task(valid, [item("T-C1", [
            {"type": "command", "run": "make check", "ignore_test_exclude": True}])])
        code, output = self.lint(valid)
        self.assertEqual(code, 0, output)

    def test_ignore_test_exclude_lint_refuses_environment_scope(self):
        check = {"type": "command", "run": "make check", "scope": "environment", "host": "test-server",
                 "max_age_days": 7, "ignore_test_exclude": True}
        self.init_task(self.repo, [item("T-C1", [check])])
        code, output = self.lint(self.repo)
        self.assertEqual(code, 1, output)
        self.assertIn("ignore_test_exclude", output)
        self.assertIn("scope", output)
        self.assertIn("删掉", output)


class ContextHookTests(Base):
    def hook(self, cwd, source, process_cwd=None):
        payload = json.dumps({"source": source, "cwd": str(cwd), "hook_event_name": "SessionStart"})
        result = self.cli(process_cwd or cwd, "hook", stdin=payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_outside_a_repository_prints_nothing(self):
        outside = self.root / "plain"
        outside.mkdir()
        self.assertEqual(self.hook(outside, "compact"), "")

    def test_repository_without_task_reminds_only_after_compact_or_resume(self):
        repo = self.make_repo()
        self.assertEqual(self.hook(repo, "startup"), "")
        self.assertEqual(self.hook(repo, "clear"), "")
        for source in ("compact", "resume"):
            output = self.hook(repo, source)
            self.assertIn("长任务", output)
            self.assertIn("升级", output)

    def test_active_task_context(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])],
                       plan=plan_text(batch=["- T-A1：先写红测试"],
                                      log=["- 2026-10-02 10:00 建立任务。", "- 2026-10-02 09:00 把 T-A1 放进当前批次。"]))
        self.record_vitest(repo, self.passing(repo))
        output = self.hook(repo, "startup")
        self.assertIn("修完所有发现的缺陷", output)
        self.assertIn("T-A1：先写红测试", output)
        self.assertIn("共 1 项", output)
        self.assertIn("把 T-A1 放进当前批次", output)
        self.assertLessEqual(len(output), CONTEXT_BUDGET)

    def test_context_shows_the_question_with_the_answer(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])])
        with open(repo / TASK / "goal.md", "a", encoding="utf-8") as handle:
            handle.write("\n## G2 2026-10-02 用户选择\n\n问题：D12 要不要算进第二轮？\n\n> 算进去 (Recommended)\n> 和其他缺陷一起修。\n"
                         "\n## G3 2026-10-02 转述：会话记录\n\n问题：要不要现在发布？\n先不发\n")
        code, output = self.lint(repo)
        self.assertEqual(code, 0, output)
        output = self.hook(repo, "startup")
        self.assertIn("G2 2026-10-02（用户选择）：问：D12 要不要算进第二轮？ 答：算进去 (Recommended) 和其他缺陷一起修。", output)
        self.assertIn("G1 2026-10-01（用户原话）：修完所有发现的缺陷\n", output)
        self.assertIn("G3 2026-10-02（转述：会话记录）：问：要不要现在发布？ 答：先不发\n", output)

    def test_context_drops_questions_before_goals(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])])
        with open(repo / TASK / "goal.md", "a", encoding="utf-8") as handle:
            handle.writelines(f"\n## G{number} 2026-10-02 用户选择\n\n问题：{'很长的问题说明' * 25}\n\n> 选项{number}：{'回答说明' * 20}\n"
                              for number in range(2, 7))
        output = self.hook(repo, "startup")
        self.assertLessEqual(len(output), CONTEXT_BUDGET)
        for number in range(2, 7):
            self.assertIn(f"G{number} 2026-10-02（用户选择）：选项{number}：", output)
        self.assertNotIn("……中间", output)
        self.assertNotIn("问：", output)

    def test_context_orders_goals_by_date_after_the_first(self):
        repo = self.make_repo()
        dates = {"G1": "2026-10-01", "G2": "2026-10-05", "G3": "2026-09-30", "G4": "2026-10-02",
                 "G5": "2026-10-03", "G6": "2026-10-03", "G7": "2026-09-29"}
        entries = [(gid, date, "用户原话", f"目标{gid}内容") for gid, date in dates.items()]
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])], goal_entries=entries)
        output = self.hook(repo, "startup")
        shown = [line.split()[0] for line in output.splitlines() if line.startswith("  G")]
        self.assertEqual(shown, ["G1", "G3", "G4", "G5", "G6", "G2"])
        self.assertIn("……中间 1 条见 goal.md", output)
        self.assertNotIn("目标G7内容", output)

    def test_symlinked_install_reports_the_install_path(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])])
        skills = self.root / "home" / "agent-home" / "skills"
        skills.mkdir(parents=True)
        (skills / "long-task-planning").symlink_to(SCRIPT.parents[1], target_is_directory=True)
        installed = skills / "long-task-planning" / "scripts" / "longtask.py"
        result = subprocess.run([sys.executable, str(installed), "context"], cwd=repo, env=self.env,
                                capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("`python3 ~/agent-home/skills/long-task-planning/scripts/longtask.py status`", result.stdout)
        self.assertIn("先读 ~/agent-home/skills/long-task-planning/SKILL.md", result.stdout)
        self.assertNotIn(str(SCRIPT.parents[1]), result.stdout)

    def test_context_stays_within_budget(self):
        repo = self.make_repo()
        entries = [(f"G{n}", "2026-10-01", "用户原话", f"第 {n} 条目标" + "很长的说明" * 40) for n in range(1, 31)]
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])], goal_entries=entries)
        output = self.hook(repo, "compact")
        self.assertLessEqual(len(output), CONTEXT_BUDGET)
        self.assertIn("第 1 条目标", output)
        self.assertIn("第 30 条目标", output)

    def test_closed_task_is_not_injected(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])])
        with open(repo / TASK / "goal.md", "a", encoding="utf-8") as handle:
            handle.write("\n## CLOSED 2026-10-03 用户原话\n\n> 验收通过\n")
        self.assertEqual(self.hook(repo, "startup"), "")
        self.assertIn("升级", self.hook(repo, "compact"))

    def test_broken_task_warns_without_failing(self):
        repo = self.make_repo()
        self.init_task(repo)
        (repo / TASK / "items.json").write_text("{not json", encoding="utf-8")
        output = self.hook(repo, "startup")
        self.assertIn("items.json", output)

    def test_hook_uses_cwd_from_input(self):
        repo = self.make_repo()
        self.init_task(repo, [item("T-A1", [tag_check("T-A1")])])
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        output = self.hook(repo, "startup", process_cwd=elsewhere)
        self.assertIn("修完所有发现的缺陷", output)


class CheckBriefTests(Base):
    def setUp(self):
        super().setUp()
        self.repo = self.make_repo()

    def brief(self, text):
        path = self.root / "brief.md"
        path.write_text(text, encoding="utf-8")
        return self.cli(self.repo, "check-brief", str(path))

    def scoped(self, *batch, background="", accept="- 跑 `make check`。"):
        return "\n".join(["# 任务说明", "", "## 1. 为什么做", "", background, "", "## 2. 范围", "", "- 本批条目：",
                          *batch, "- 不做：其他条目", "", "## 3. 验收", "", accept, ""])

    def make_task(self, name, prefix, items):
        self.ok(self.cli(self.repo, "init", name, "--prefix", prefix, "--goal", "目标", "--date", "2026-10-01"))
        task = self.repo / ".agents/tasks" / name
        data = json.loads((task / "items.json").read_text(encoding="utf-8"))
        data.pop("decisions", None)
        data["items"] = list(items)
        (task / "items.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return task

    def test_brief_naming_known_items_passes(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        result = self.brief(self.scoped("  - `T-A1` 标题。"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("本批条目 T-A1", result.stdout)
        self.assertNotIn("进行中的任务", result.stdout)

    def test_brief_without_items_fails(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        self.assertEqual(self.brief("修一下那个问题").returncode, 1)
        result = self.brief(self.scoped(*[f"  - `T-A{n}` 标题。" for n in range(1, 5)]))
        self.assertEqual(result.returncode, 1)
        self.assertIn("错误：本批条目有 4 个", result.stdout)
        self.assertNotIn("请用 --task", result.stdout)

    def test_brief_with_unknown_item_fails(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        result = self.brief(self.scoped("  - `T-A1` 标题。", background="和 T-Z9 有关。"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("T-Z9", result.stdout + result.stderr)

    def test_brief_with_withdrawn_item_fails(self):
        withdrawn = {"on": "2026-10-02", "ref": "G1"}
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-W1", [], withdrawn=withdrawn)])
        result = self.brief(self.scoped("  - `T-A1` 标题。", "  - T-W1 标题。"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("本批条目 T-W1 已决定不做", result.stdout)

    def test_batch_is_the_id_led_bullets_in_the_scope_section(self):
        self.init_task(self.repo, [item(f"T-A{n}", [tag_check(f"T-A{n}")]) for n in range(1, 6)])
        text = ("# 任务说明\n\n## 1. 为什么做\n\n- T-A3 上次已经做完，T-A4 的夹具可以复用。\n\n"
                "## 2. 范围\n\n- 本批条目：\n  - `T-A1` 第一项，和 T-A5 共用夹具。\n\n"
                "```bash\n# 先跑一遍\nmake check\n```\n\n"
                "### 第二组\n\n* T-A2 第二项。\n"
                "- 顺带验证（不占名额）：`T-A3`、T-A4\n\n"
                "## 3. 验收\n\n- `T-A5` 跑它的测试。\n")
        result = self.brief(text)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("简报检查通过：本批条目 T-A1、T-A2", result.stdout)
        self.assertNotIn("T-A3", result.stdout)
        self.assertNotIn("T-A5", result.stdout)

    def test_withdrawn_item_outside_the_batch_only_warns(self):
        withdrawn = {"on": "2026-10-02", "ref": "G1"}
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")]), item("T-W1", [], withdrawn=withdrawn)])
        result = self.brief(self.scoped("  - `T-A1` 标题。", background="上一个会话做到一半的 T-W1 已撤回，不要重做。"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("本批条目 T-A1", result.stdout)
        self.assertIn("警告", result.stdout)
        self.assertIn("T-W1", result.stdout)

    def test_item_mentioned_only_outside_the_scope_section_is_not_a_batch(self):
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        cases = {
            "no batch bullet": self.scoped("  - 本批没有新条目。", background="上次已经做完 T-A1。"),
            "no scope section": "# 任务说明\n\n## 3. 验收\n\n- `T-A1` 跑测试。\n",
            "bullet not led by the ID": self.scoped("  - 继续 `T-A1`。"),
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                result = self.brief(text)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("“范围”一节", result.stdout)
                self.assertNotIn("检查通过", result.stdout)

    def test_brief_batch_is_limited_to_three_items(self):
        self.init_task(self.repo, [item(f"T-A{n}", [tag_check(f"T-A{n}")]) for n in range(1, 5)])
        result = self.brief(self.scoped(*[f"  - `T-A{n}` 标题。" for n in (1, 2, 3, 1)]))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("本批条目 T-A1、T-A2、T-A3", result.stdout)
        result = self.brief(self.scoped(*[f"  - `T-A{n}` 标题。" for n in range(1, 5)]))
        self.assertEqual(result.returncode, 1)
        self.assertIn("最多 3 个", result.stdout)

    def test_check_brief_infers_the_only_task_whose_items_match(self):
        self.make_task("demo", "T", [item("T-A1", [tag_check("T-A1")])])
        self.make_task("other", "U", [item("U-A1", [tag_check("U-A1")])])
        broken = self.make_task("broken", "X", [item("X-A1", [tag_check("X-A1")])])
        (broken / "items.json").write_text("{not json", encoding="utf-8")
        result = self.brief(self.scoped("  - `T-A1` 标题。"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("按简报里的条目用", result.stdout)
        self.assertIn("demo", result.stdout)
        self.assertIn("简报检查通过", result.stdout)

    def test_check_brief_refuses_when_several_tasks_accept_or_none_does(self):
        self.make_task("demo", "T", [item("T-A1", [tag_check("T-A1")])])
        self.make_task("other", "T", [item("T-A1", [tag_check("T-A1")])])
        result = self.brief(self.scoped("  - `T-A1` 标题。"))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("demo：通过", result.stdout)
        self.assertIn("other：通过", result.stdout)
        self.assertIn("--task", result.stdout)
        result = self.brief(self.scoped("  - `T-Z9` 标题。"))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("--task", result.stdout)
        for name in ("demo", "other"):
            line = next(ln for ln in result.stdout.splitlines() if ln.startswith(f"- {name}："))
            self.assertFalse(line.endswith("：通过"), line)

    def test_check_brief_without_open_task_passes_with_a_note(self):
        result = self.brief(self.scoped("  - `T-A1` 标题。"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("没有进行中的长任务，不检查条目", result.stdout)
        self.init_task(self.repo, [item("T-A1", [tag_check("T-A1")])])
        with open(self.repo / TASK / "goal.md", "a", encoding="utf-8") as handle:
            handle.write("\n## CLOSED 2026-10-03 用户原话\n\n> 验收通过\n")
        result = self.brief(self.scoped("  - `T-A1` 标题。"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("没有进行中的长任务，不检查条目", result.stdout)
        brief_file = self.root / "missing.md"
        brief_file.write_text(self.scoped("  - `T-A1` 标题。"), encoding="utf-8")
        result = self.cli(self.repo, "check-brief", str(brief_file), "--task", "nope")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
