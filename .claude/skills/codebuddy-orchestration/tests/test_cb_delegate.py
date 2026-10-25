import hashlib
import json
import os
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "cb-delegate.sh"

STUB = textwrap.dedent(
    r"""
    #!/usr/bin/env bash
    if [ "$1" = "--version" ]; then echo "0.0.0-stub"; exit 0; fi
    if [ "$1" = "--help" ]; then echo "--model <id> deepseek-v4.1-flash hy3"; exit 0; fi
    cat >/dev/null
    RESULT='{"type":"result","session_id":"sess-1","total_cost_usd":0,"is_error":false,"num_turns":3,"result":"","structured_output":{"status":"done","summary":"stub","files_changed":["src/order/A.java"],"commands_run":[],"acceptance_passed":true,"open_issues":[]}}'
    printf '%s\n' "$@" >"$STUB_ARGS"
    env | grep '^CODEBUDDY_' | sort >"$STUB_ENV"
    call() {
      printf '{"type":"function_call","callId":"%s","name":"%s","arguments":%s},' "$1" "$2" "$(jq -cn --argjson a "$3" '$a|tostring')"
      printf '{"type":"function_call_result","callId":"%s","name":"%s","status":"%s","output":{}},' "$1" "$2" "$4"
    }
    case "${STUB_MODE:-inscope}" in
      inscope)  mkdir -p src/order; echo "class A {}" > src/order/A.java ;;
      outscope) mkdir -p src/order; echo "class A {}" > src/order/A.java; echo x > build.gradle ;;
      rename)   mkdir -p src/order; git mv README.md src/order/README.md ;;
      commit)   mkdir -p src/order; echo c > src/order/C.java; git add -A
                git -c user.name=stub -c user.email=stub@example.com commit -qm stub ;;
      hang)     sleep 30 & echo $! > "$STUB_CHILD"; wait ;;
      nojson)   echo "Error: not logged in" >&2; exit 3 ;;
      maxturns) printf 'warning: retrying model request\nMax turns (60) exceeded\n\n' >&2; exit 0 ;;
      failresult)
                printf '[{"type":"message","role":"user"},{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
                exit 5 ;;
      noop)     ;;
      noresult) echo '[{"type":"message","role":"user"}]'; exit 0 ;;
      object)   printf '%s\n' "$RESULT"; exit 0 ;;
      probe)    printf '[{"type":"message","role":"user"},'
                call c1 Read "{\"file_path\":\"$PWD/README.md\"}" completed
                call c2 Read '{"file_path":"/etc/hosts"}' completed
                call c3 Read '{"file_path":"../../secret.txt"}' incomplete
                call c4 Write '{"file_path":"/tmp/x","content":"x"}' incomplete
                call c5 Glob '{"pattern":"**/*.java"}' completed
                call c6 Glob '{"pattern":"*.txt","path":"/var"}' completed
                call c7 Bash '{"command":"git status","description":"s"}' completed
                callid="c8-$$-$RANDOM"
                call "$callid" Bash '{"command":"true"}' completed
                printf '%s]\n' "$RESULT"; exit 0 ;;
      rewritten)
                cid="b-$$-$RANDOM"
                printf '[{"type":"message","role":"user"},'
                call "$cid" Bash '{"command":"true 2>&1 | tail -5"}' incomplete
                printf '{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
                exit 0 ;;
      denied)
                cid="b-$$-$RANDOM"
                printf '[{"type":"message","role":"user"},'
                call "$cid" Bash '{"command":"true"}' incomplete
                printf '{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
                exit 0 ;;
      history)
                printf '[{"type":"message","role":"user"},'
                call h-1 Bash '{"command":"true"}' completed
                printf '{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
                exit 0 ;;
      multiline)
                cid="b-$$-$RANDOM"
                printf '[{"type":"message","role":"user"},'
                call "$cid" Bash '{"command":"echo x\ntrue"}' incomplete
                printf '{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
                exit 0 ;;
    esac
    cid="b-$$-$RANDOM"
    printf '[{"type":"message","role":"user"},'
    call "$cid" Bash '{"command":"true"}' completed
    printf '{"type":"function_call","name":"StructuredOutput"},%s]\n' "$RESULT"
    """
).lstrip()

BRIEF = textwrap.dedent(
    """
    # Task: stub

    ## Allowed paths
    - src/order/*   # comment is ignored
    - `README.md`

    ## Acceptance
    - true
    """
).lstrip()

REVIEW_BRIEF = textwrap.dedent(
    """
    # Review: stub

    ## What to review
    - README.md
    """
).lstrip()


class CbDelegateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.stub = root / "codebuddy"
        self.stub.write_text(STUB)
        self.stub.chmod(0o755)
        self.brief = root / "brief.md"
        self.brief.write_text(BRIEF)
        self.review_brief = root / "review-brief.md"
        self.review_brief.write_text(REVIEW_BRIEF)
        self.home = root / "cb-home"
        self.env = {
            **{key: value for key, value in os.environ.items() if not key.startswith("CB_")},
            "CB_BIN": str(self.stub),
            "CB_HOME": str(self.home),
            "STUB_ARGS": str(root / "args"),
            "STUB_CHILD": str(root / "child.pid"),
            "STUB_ENV": str(root / "env"),
            "GIT_AUTHOR_NAME": "test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        }
        self.git("init", "-q")
        (self.repo / "README.md").write_text("hi\n")
        self.git("add", "README.md")
        self.git("commit", "-qm", "init")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True
        ).stdout

    def cb(self, *args, mode="inscope", cwd=None, **extra_env):
        if cwd is None:
            cwd = self.repo
        env = {**self.env, "STUB_MODE": mode, **extra_env}
        return subprocess.run(
            ["bash", str(SCRIPT), *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60, check=False
        )

    def linked_worktree(self):
        linked = Path(self.tmp.name) / "linked"
        self.git("worktree", "add", "-q", "--detach", str(linked), "HEAD")
        return linked

    def remove_linked_worktree(self, linked):
        self.git("worktree", "remove", "--force", str(linked))

    def worktree(self, task_id):
        return next(self.home.glob(f"*/{task_id}/wt"))

    def ledger(self):
        return [json.loads(line) for line in (self.home / "ledger.jsonl").read_text().splitlines()]

    def stub_args(self):
        return Path(self.env["STUB_ARGS"]).read_text()

    def template(self, name):
        return (SCRIPT.parent.parent / "templates" / name).read_text().rstrip("\n")

    def task_dir(self, task_id):
        return self.worktree(task_id).parent

    def test_start_check_land_clean(self):
        start = self.cb("start", "t1", str(self.brief), "--allow", "Bash(./mvnw:*)", "--deny", "Read(/opt/private/**)")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn('"status": "done"', start.stdout)
        self.assertIn("?? src/order/A.java", start.stdout)

        args = Path(self.env["STUB_ARGS"]).read_text().splitlines()
        self.assertEqual(args[args.index("--permission-mode") + 1], "dontAsk")
        allowed = args[args.index("--allowedTools") + 1 : args.index("--disallowedTools")]
        denied = args[args.index("--disallowedTools") + 1 : args.index("--max-turns")]
        wt = self.worktree("t1").resolve()
        self.assertIn("Bash(./mvnw:*)", allowed)
        self.assertIn("Bash(git status:*)", allowed)
        self.assertIn(f"Write({wt}/**)", allowed)
        self.assertIn(f"Edit({wt}/**)", allowed)
        self.assertNotIn("Write", allowed)
        self.assertNotIn("Edit", allowed)
        self.assertIn("Bash(git commit:*)", denied)
        self.assertIn("Bash(git grep:*)", allowed)
        self.assertIn("Grep", denied)
        self.assertIn("Read(~/.ssh/**)", denied)
        self.assertIn("Bash(git grep --no-index:*)", denied)
        self.assertIn("Bash(git diff --no-index:*)", denied)
        self.assertIn("Read(/opt/private/**)", denied)
        self.assertIn("WebFetch", denied)
        self.assertFalse(any("," in rule for rule in allowed + denied))
        self.assertNotIn("--fallback-model", args)
        worker_env = Path(self.env["STUB_ENV"]).read_text().splitlines()
        self.assertIn("CODEBUDDY_CODE_DISABLE_AUTO_MEMORY=1", worker_env)
        self.assertIn("CODEBUDDY_DISABLE_AUTO_MEMORY=1", worker_env)
        self.assertIn("CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1", worker_env)
        self.assertEqual(self.ledger()[0]["cost_usd"], 0)
        self.assertIn('"session_id": "sess-1"', start.stdout)

        check = self.cb("check", "t1")
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertIn("SCOPE PASS", check.stdout)

        land = self.cb("land", "t1")
        self.assertEqual(land.returncode, 0, land.stderr)
        self.assertEqual(self.git("status", "--porcelain", "-uall"), "?? src/order/A.java\n")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")

        clean = self.cb("clean", "t1")
        self.assertEqual(clean.returncode, 0, clean.stderr)
        self.assertNotIn("wt", self.git("worktree", "list"))
        self.assertEqual([entry["event"] for entry in self.ledger()], ["run", "landed"])

    def test_out_of_scope_change_blocks_landing(self):
        self.cb("start", "t2", str(self.brief), mode="outscope")
        check = self.cb("check", "t2")
        self.assertEqual(check.returncode, 1)
        self.assertIn("OUT   build.gradle", check.stdout)
        land = self.cb("land", "t2")
        self.assertNotEqual(land.returncode, 0)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_rename_checks_both_paths(self):
        narrow = self.brief.parent / "narrow.md"
        narrow.write_text(BRIEF.replace("- `README.md`\n", ""))
        self.cb("start", "t3", str(narrow), mode="rename")
        check = self.cb("check", "t3")
        self.assertEqual(check.returncode, 1)
        self.assertIn("ok    src/order/README.md", check.stdout)
        self.assertIn("OUT   README.md", check.stdout)

    def test_worker_commit_is_detected(self):
        self.cb("start", "t4", str(self.brief), mode="commit")
        check = self.cb("check", "t4")
        self.assertEqual(check.returncode, 1)
        self.assertIn("worker moved HEAD", check.stdout)

    def test_missing_json_shows_stderr_and_logs_run(self):
        start = self.cb("start", "t5", str(self.brief), mode="nojson")
        self.assertIn("exit 3", start.stdout)
        self.assertIn("Error: not logged in", start.stdout)
        self.assertEqual(self.ledger()[-1]["exit_code"], 3)
        self.assertIsNone(self.ledger()[-1]["cost_usd"])

    def test_single_result_object_is_accepted(self):
        start = self.cb("start", "t10", str(self.brief), mode="object")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn('"summary": "stub"', start.stdout)
        self.assertEqual((self.worktree("t10").parent / "session_id").read_text(), "sess-1")

    def test_doctor_reads_structured_output_without_memory(self):
        doctor = self.cb("doctor")
        self.assertEqual(doctor.returncode, 0, doctor.stderr)
        self.assertIn('"summary": "stub"', doctor.stdout)
        self.assertNotIn("no JSON output", doctor.stdout)
        self.assertIn("CODEBUDDY_CODE_DISABLE_AUTO_MEMORY=1", Path(self.env["STUB_ENV"]).read_text())

    def test_output_without_result_is_reported_as_invalid(self):
        start = self.cb("start", "t9", str(self.brief), mode="noresult")
        self.assertEqual(start.returncode, 3, start.stderr)
        self.assertIn("worker produced no valid JSON", start.stdout)
        self.assertIsNone(self.ledger()[-1]["cost_usd"])
        self.assertIn("no valid JSON", self.cb("status", "t9").stdout)

    def test_builtin_watchdog_stops_worker_and_children(self):
        began = time.monotonic()
        start = self.cb("start", "t6", str(self.brief), mode="hang", CB_TIMEOUT="3", CB_TIMEOUT_IMPL="builtin")
        self.assertLess(time.monotonic() - began, 20)
        self.assertEqual(start.returncode, 124, start.stdout)
        self.assertIn("exit 124", start.stdout)
        self.assertIn("TIMED OUT", start.stdout)
        child = int(Path(self.env["STUB_CHILD"]).read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_outside_tool_calls_are_listed(self):
        start = self.cb("start", "t11", str(self.brief), mode="probe")
        self.assertEqual(start.returncode, 0, start.stderr)
        outside = start.stdout.split("-- tool calls outside the worktree:")[1].split("-- shell commands:")[0]
        self.assertEqual(
            outside.strip().splitlines(),
            ["ok      Read /etc/hosts", "failed  Read ../../secret.txt", "failed  Write /tmp/x", "ok      Glob /var"],
        )
        shell = start.stdout.split("-- shell commands:")[1].split("-- worktree changes")[0]
        self.assertEqual(shell.strip().splitlines(), ["ok      git status", "ok      true"])
        self.assertIn("ok      Read /etc/hosts", self.cb("status", "t11").stdout)

    def test_resume_limit(self):
        self.cb("start", "t7", str(self.brief), "--deny", "Read(/opt/private/**)")
        feedback = self.brief.parent / "feedback.md"
        feedback.write_text("fix it\n")
        for _ in range(2):
            self.assertEqual(self.cb("resume", "t7", str(feedback)).returncode, 0)
        args = Path(self.env["STUB_ARGS"]).read_text().splitlines()
        self.assertEqual(args[args.index("--resume") + 1], "sess-1")
        self.assertIn("Read(/opt/private/**)", args)
        third = self.cb("resume", "t7", str(feedback))
        self.assertNotEqual(third.returncode, 0)
        self.assertIn("resume limit reached", third.stderr)

    def test_model_must_be_on_allowed_list(self):
        refused = self.cb("start", "m1", str(self.brief), CB_MODEL="paid-model")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("MODEL_NOT_ALLOWED: paid-model", refused.stderr)
        self.assertFalse(Path(self.env["STUB_ARGS"]).exists())
        self.assertFalse(list(self.home.glob("*/m1")))
        self.assertIn("MODEL_NOT_ALLOWED", self.cb("doctor", CB_MODEL="paid-model").stderr)
        self.assertFalse(Path(self.env["STUB_ARGS"]).exists())

        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "allowed-models.txt").write_text("# free models\nhy3  \n\n")
        self.assertEqual(self.cb("start", "m2", str(self.brief), CB_MODEL="hy3").returncode, 0)
        args = Path(self.env["STUB_ARGS"]).read_text().splitlines()
        self.assertEqual(args[args.index("--model") + 1], "hy3")
        self.assertIn("MODEL_NOT_ALLOWED", self.cb("start", "m3", str(self.brief)).stderr)

        feedback = self.brief.parent / "feedback.md"
        feedback.write_text("fix it\n")
        resumed = self.cb("resume", "m2", str(feedback), CB_MODEL="paid-model")
        self.assertEqual(resumed.returncode, 2)
        self.assertIn("MODEL_NOT_ALLOWED", resumed.stderr)

        missing = self.cb("start", "m4", str(self.brief), CB_ALLOWED_MODELS=str(self.home / "nope.txt"))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("MODEL_LIST_MISSING", missing.stderr)

    def test_guards(self):
        no_scope = self.brief.parent / "no-scope.md"
        no_scope.write_text("# Task\n\n## Goal\n")
        self.assertIn("no '## Allowed paths'", self.cb("start", "t8", str(no_scope)).stderr)
        self.assertIn("invalid task id", self.cb("start", "Bad", str(self.brief)).stderr)

        (self.repo / "README.md").write_text("dirty\n")
        start = self.cb("start", "t9", str(self.brief))
        self.assertIn("will NOT see them", start.stderr)
        self.assertIn("already exists", self.cb("start", "t9", str(self.brief)).stderr)

        refused = self.cb("clean", "t9")
        self.assertNotEqual(refused.returncode, 0)
        self.assertTrue(self.worktree("t9").is_dir())
        self.assertEqual(self.cb("clean", "t9", "--discard").returncode, 0)
        self.assertEqual(self.ledger()[-1]["event"], "discarded")

    def assertLookedFor(self, stderr, path):
        self.assertTrue(
            f"looked for {path}" in stderr
            or f"looked for {os.path.realpath(path)}" in stderr,
            stderr,
        )

    def test_start_missing_relative_brief_reports_looked_for_path(self):
        start = self.cb("start", "t12", "missing-brief.md")
        self.assertNotEqual(start.returncode, 0)
        self.assertIn("brief not found: missing-brief.md", start.stderr)
        self.assertLookedFor(start.stderr, str(self.repo / "missing-brief.md"))

    def test_start_missing_absolute_brief_reports_looked_for_path(self):
        missing = self.brief.parent / "no-such-brief.md"
        start = self.cb("start", "t13", str(missing))
        self.assertNotEqual(start.returncode, 0)
        self.assertIn(f"brief not found: {missing}", start.stderr)
        self.assertLookedFor(start.stderr, str(missing))

    def test_resume_missing_feedback_reports_looked_for_path(self):
        self.assertEqual(self.cb("start", "t14", str(self.brief)).returncode, 0)
        resume = self.cb("resume", "t14", "missing-feedback.md")
        self.assertNotEqual(resume.returncode, 0)
        self.assertIn("feedback file not found: missing-feedback.md", resume.stderr)
        self.assertIn("looked for", resume.stderr)

    def test_start_warns_about_references_missing_from_worktree(self):
        (self.repo / ".gitignore").write_text("build/\n")
        self.git("add", ".gitignore")
        self.git("commit", "-qm", "ignore build")
        (self.repo / "build").mkdir()
        (self.repo / "build" / "out.txt").write_text("x\n")
        (self.repo / "notes").mkdir()
        (self.repo / "notes" / "todo.md").write_text("x\n")

        brief = self.brief.parent / "refs.md"
        brief.write_text(
            BRIEF
            + textwrap.dedent(
                """
                ## References
                - `README.md:1-3` committed file
                - build/out.txt ignored file
                - notes/todo.md
                - /etc/hosts
                - ~/x/y.txt
                - <optional: placeholder>
                - none (all needed files are in the worktree)
                - src/*.java
                - https://example.com/a.b
                """
            )
        )

        start = self.cb("start", "t15", str(brief))
        self.assertEqual(start.returncode, 0, start.stderr)
        lines = [line for line in start.stderr.splitlines() if "References path" in line]
        self.assertEqual(len(lines), 2, start.stderr)
        words = [line.split("References path '")[1].split("'")[0] for line in lines]
        self.assertEqual(words, ["build/out.txt", "notes/todo.md"])
        self.assertIn("is not in the worker's worktree", lines[0])
        self.assertIn("uncommitted or ignored by git", lines[0])
        self.assertIn("list it by absolute path", lines[0])
        self.assertFalse(any("README.md" in line for line in lines))

    def test_start_without_references_section_prints_no_reference_warning(self):
        start = self.cb("start", "t16", str(self.brief))
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertNotIn("References path", start.stderr)

    def test_review_start_uses_review_templates_and_review_mode(self):
        start = self.cb("start", "r1", str(self.review_brief), "--review", mode="noop")
        self.assertEqual(start.returncode, 0, start.stderr)
        args = self.stub_args().splitlines()
        allowed = args[args.index("--allowedTools") + 1 : args.index("--disallowedTools")]
        denied = args[args.index("--disallowedTools") + 1 : args.index("--max-turns")]
        self.assertEqual(
            [rule for rule in allowed if rule.startswith(("Edit(", "MultiEdit(", "Write("))], []
        )
        for tool in ("Edit", "MultiEdit", "Write", "NotebookEdit", "DeferExecuteTool"):
            self.assertIn(tool, denied)
        text = self.stub_args()
        self.assertIn(self.template("review-rules.md"), text)
        self.assertIn(self.template("review.schema.json"), text)
        self.assertNotIn(self.template("worker-rules.md"), text)
        self.assertNotIn(self.template("report.schema.json"), text)
        self.assertEqual((self.task_dir("r1") / "mode").read_text(), "review")
        self.assertEqual(self.ledger()[-1]["mode"], "review")
        self.assertIn("(review task, round 0, exit 0)", start.stdout)
        self.assertNotIn("Allowed paths", start.stderr)

    def test_change_start_rejects_brief_without_allowed_paths(self):
        start = self.cb("start", "c4", str(self.review_brief), mode="noop")
        self.assertNotEqual(start.returncode, 0)
        self.assertIn("no '## Allowed paths'", start.stderr)

    def test_change_start_keeps_worker_templates_and_change_mode(self):
        start = self.cb("start", "c1", str(self.brief), mode="noop")
        self.assertEqual(start.returncode, 0, start.stderr)
        text = self.stub_args()
        self.assertIn(self.template("worker-rules.md"), text)
        self.assertIn(self.template("report.schema.json"), text)
        self.assertNotIn(self.template("review-rules.md"), text)
        self.assertNotIn(self.template("review.schema.json"), text)
        self.assertEqual((self.task_dir("c1") / "mode").read_text(), "change")
        self.assertEqual(self.ledger()[-1]["mode"], "change")
        args = text.splitlines()
        denied = args[args.index("--disallowedTools") + 1 : args.index("--max-turns")]
        self.assertIn("DeferExecuteTool", denied)
        self.assertNotIn("review task", start.stdout)

    def test_review_start_ignores_allowed_paths_section(self):
        start = self.cb("start", "r6", str(self.brief), "--review", mode="noop")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn("'## Allowed paths' section is ignored", start.stderr)

    def test_review_check_passes_when_nothing_changed(self):
        start = self.cb("start", "r2", str(self.review_brief), "--review", mode="noop")
        self.assertEqual(start.returncode, 0, start.stderr)
        check = self.cb("check", "r2", mode="noop")
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertIn("SCOPE PASS (review task, no changes)", check.stdout)

    def test_review_check_fails_on_any_change(self):
        self.cb("start", "r3", str(self.review_brief), "--review", mode="inscope")
        check = self.cb("check", "r3")
        self.assertEqual(check.returncode, 1)
        self.assertIn("OUT   src/order/A.java", check.stdout)
        self.assertIn("SCOPE FAIL", check.stdout)

    def test_review_task_cannot_land_and_cleans_without_discard(self):
        self.cb("start", "r4", str(self.review_brief), "--review", mode="noop")
        land = self.cb("land", "r4")
        self.assertNotEqual(land.returncode, 0)
        self.assertIn("is a review task and has nothing to land", land.stderr)
        self.assertEqual(self.git("status", "--porcelain", "-uall"), "")
        wt = self.worktree("r4")
        clean = self.cb("clean", "r4")
        self.assertEqual(clean.returncode, 0, clean.stderr)
        self.assertNotIn(str(wt), self.git("worktree", "list"))
        self.assertEqual((wt.parent / "status").read_text(), "cleaned")
        self.assertEqual([entry["event"] for entry in self.ledger()], ["run"])

    def test_review_resume_keeps_review_mode(self):
        self.cb("start", "r5", str(self.review_brief), "--review", mode="noop")
        feedback = self.brief.parent / "review-feedback.md"
        feedback.write_text("add evidence\n")
        resume = self.cb("resume", "r5", str(feedback), mode="noop")
        self.assertEqual(resume.returncode, 0, resume.stderr)
        text = self.stub_args()
        self.assertIn(self.template("review-rules.md"), text)
        args = text.splitlines()
        denied = args[args.index("--disallowedTools") + 1 : args.index("--max-turns")]
        self.assertIn("Write", denied)
        self.assertEqual(args[args.index("--resume") + 1], "sess-1")
        self.assertEqual([entry["mode"] for entry in self.ledger()], ["review", "review"])
        self.assertIn("(review task, round 1", self.cb("status", "r5").stdout)

    def test_resume_rejects_extra_options(self):
        self.cb("start", "c2", str(self.brief), mode="noop")
        feedback = self.brief.parent / "feedback-extra.md"
        feedback.write_text("fix\n")
        resume = self.cb("resume", "c2", str(feedback), "--allow", "Bash(x:*)", mode="noop")
        self.assertNotEqual(resume.returncode, 0)
        self.assertIn("usage: resume <id> <feedback.md>", resume.stderr)
        self.assertIn("settings from start are reused", resume.stderr)

    def test_missing_mode_file_is_treated_as_change(self):
        self.assertEqual(self.cb("start", "c3", str(self.brief)).returncode, 0)
        (self.task_dir("c3") / "mode").unlink()
        check = self.cb("check", "c3")
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertIn("SCOPE PASS", check.stdout)

    def test_max_turns_exits_three_and_reports_missing_records(self):
        start = self.cb("start", "t17", str(self.brief), mode="maxturns")
        self.assertEqual(start.returncode, 3, start.stderr)
        self.assertIn("tool-call and command records are missing", start.stdout)
        self.assertIn("(last stderr line: Max turns (60) exceeded)", start.stdout)
        self.assertNotIn("-- tool calls outside the worktree:", start.stdout)
        self.assertNotIn("-- shell commands:", start.stdout)
        lines = start.stdout.splitlines()
        title = next(i for i, line in enumerate(lines) if line.startswith("== cb-delegate report:"))
        self.assertTrue(lines[title + 1].startswith("!! tool-call and command records are missing"), lines[title + 1])
        self.assertEqual(self.ledger()[-1]["exit_code"], 0)
        status = self.cb("status", "t17")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("tool-call and command records are missing", status.stdout)

    def test_resume_max_turns_exits_three_and_reports_missing_records(self):
        self.assertEqual(self.cb("start", "t18", str(self.brief)).returncode, 0)
        feedback = self.brief.parent / "feedback-maxturns.md"
        feedback.write_text("fix it\n")
        resume = self.cb("resume", "t18", str(feedback), mode="maxturns")
        self.assertEqual(resume.returncode, 3, resume.stderr)
        self.assertIn("tool-call and command records are missing", resume.stdout)

    def test_worker_failure_with_result_returns_worker_exit_code(self):
        start = self.cb("start", "t19", str(self.brief), mode="failresult")
        self.assertEqual(start.returncode, 5, start.stderr)
        self.assertIn('"summary": "stub"', start.stdout)
        self.assertNotIn("tool-call and command records are missing", start.stdout)
        self.assertIn("-- tool calls outside the worktree:", start.stdout)

    def test_single_result_object_reports_missing_records_without_stderr(self):
        start = self.cb("start", "t20", str(self.brief), mode="object")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn("tool-call and command records are missing", start.stdout)
        self.assertIn("(last stderr line: none)", start.stdout)

    def test_conversation_output_keeps_record_sections(self):
        start = self.cb("start", "t21", str(self.brief))
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertNotIn("tool-call and command records are missing", start.stdout)
        self.assertIn("-- tool calls outside the worktree:", start.stdout)
        self.assertIn("-- shell commands:", start.stdout)

    def test_rewritten_acceptance_command_reruns_acceptance_once(self):
        start = self.cb("start", "t30", str(self.brief), mode="rewritten")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertEqual(
            start.stdout.count("!! acceptance command not run exactly as written in this round: true"), 2
        )
        self.assertEqual(start.stdout.count("(round 1, automatic rerun"), 1)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 2)
        self.assertEqual([e["auto"] for e in runs], [False, True])
        self.assertEqual((self.task_dir("t30") / "round").read_text(), "1")
        rerun = self.task_dir("t30") / "rerun-1.md"
        self.assertTrue(rerun.exists())
        self.assertIn("- true", rerun.read_text())
        self.assertIn("exactly as written", rerun.read_text())
        args = Path(self.env["STUB_ARGS"]).read_text().splitlines()
        self.assertEqual(args[args.index("--resume") + 1], "sess-1")

    def test_exact_acceptance_attempt_counts_even_when_denied(self):
        start = self.cb("start", "t31", str(self.brief), mode="denied")
        self.assertEqual(start.returncode, 0, start.stderr)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 1)
        self.assertNotIn("!! acceptance command", start.stdout)
        self.assertEqual(len(list(self.task_dir("t31").glob("rerun-*.md"))), 0)

    def test_acceptance_calls_from_earlier_rounds_do_not_count(self):
        start = self.cb("start", "t32", str(self.brief), mode="history")
        self.assertEqual(start.returncode, 0, start.stderr)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 1)
        self.assertNotIn("!! acceptance command", start.stdout)

        feedback = self.brief.parent / "fb.md"
        feedback.write_text("redo\n")
        resume = self.cb("resume", "t32", str(feedback), mode="history")
        self.assertEqual(resume.returncode, 0, resume.stderr)
        self.assertIn("!! acceptance command not run exactly as written in this round: true", resume.stdout)
        self.assertIn("automatic rerun", resume.stdout)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 3)
        self.assertEqual((self.task_dir("t32") / "round").read_text(), "2")
        self.assertTrue((self.task_dir("t32") / "rerun-2.md").exists())

    def test_automatic_rerun_does_not_count_toward_resume_limit(self):
        start = self.cb("start", "t33", str(self.brief), mode="rewritten", CB_MAX_ROUNDS="1")
        self.assertEqual(start.returncode, 0, start.stderr)
        feedback = self.brief.parent / "fb.md"
        feedback.write_text("redo\n")
        resume = self.cb("resume", "t33", str(feedback), mode="inscope", CB_MAX_ROUNDS="1")
        self.assertEqual(resume.returncode, 0, resume.stderr)
        self.assertEqual((self.task_dir("t33") / "round").read_text(), "2")
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual([e["auto"] for e in runs], [False, True, False])
        feedback2 = self.brief.parent / "fb2.md"
        feedback2.write_text("redo again\n")
        third = self.cb("resume", "t33", str(feedback2), mode="inscope", CB_MAX_ROUNDS="1")
        self.assertNotEqual(third.returncode, 0)
        self.assertIn("resume limit reached", third.stderr)

    def test_review_task_skips_the_acceptance_check(self):
        start = self.cb("start", "r7", str(self.brief), "--review", mode="rewritten")
        self.assertEqual(start.returncode, 0, start.stderr)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 1)
        self.assertNotIn("!! acceptance command", start.stdout)
        self.assertEqual(len(list(self.task_dir("r7").glob("rerun-*.md"))), 0)

    def test_acceptance_command_inside_a_multiline_command_does_not_count(self):
        start = self.cb("start", "t34", str(self.brief), mode="multiline")
        self.assertEqual(start.returncode, 0, start.stderr)
        self.assertIn("!! acceptance command not run exactly as written in this round: true", start.stdout)
        runs = [e for e in self.ledger() if e["event"] == "run"]
        self.assertEqual(len(runs), 2)

    def test_failed_run_without_json_reports_last_stderr_line(self):
        start = self.cb("start", "t22", str(self.brief), mode="nojson")
        self.assertEqual(start.returncode, 3, start.stderr)
        self.assertIn("(last stderr line: Error: not logged in)", start.stdout)

    def test_main_worktree_key_is_unchanged(self):
        start = self.cb("start", "k1", str(self.brief))
        self.assertEqual(start.returncode, 0, start.stderr)
        top = self.git("rev-parse", "--show-toplevel").strip()
        key = f"{Path(top).name}-{hashlib.sha1(top.encode()).hexdigest()[:8]}"
        wt = self.home / key / "k1" / "wt"
        self.assertTrue(wt.is_dir(), wt)

    def test_clean_works_after_starting_worktree_deleted(self):
        linked = self.linked_worktree()
        start = self.cb("start", "cw1", str(self.brief), cwd=linked)
        self.assertEqual(start.returncode, 0, start.stderr)
        land = self.cb("land", "cw1", cwd=linked)
        self.assertEqual(land.returncode, 0, land.stderr)
        wt = self.worktree("cw1")
        self.remove_linked_worktree(linked)
        clean = self.cb("clean", "cw1")
        self.assertEqual(clean.returncode, 0, clean.stderr)
        listing = self.git("worktree", "list", "--porcelain")
        listed = {os.path.realpath(p.split(" ", 1)[1]) for p in listing.splitlines() if p.startswith("worktree ")}
        self.assertNotIn(os.path.realpath(str(wt)), listed)
        self.assertFalse(Path(os.path.realpath(str(wt))).exists())
        self.assertEqual((wt.parent / "status").read_text(), "cleaned")

    def test_task_started_in_linked_worktree_found_in_main(self):
        linked = self.linked_worktree()
        start = self.cb("start", "lf1", str(self.brief), cwd=linked)
        self.assertEqual(start.returncode, 0, start.stderr)
        status = self.cb("status", "lf1")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("== cb-delegate report: lf1", status.stdout)
        check = self.cb("check", "lf1")
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertIn("SCOPE PASS", check.stdout)
        listing = self.cb("list")
        self.assertIn("lf1", listing.stdout)

    def test_task_started_in_main_found_in_linked_worktree(self):
        linked = self.linked_worktree()
        start = self.cb("start", "mf1", str(self.brief))
        self.assertEqual(start.returncode, 0, start.stderr)
        status = self.cb("status", "mf1", cwd=linked)
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("== cb-delegate report: mf1", status.stdout)
        listing = self.cb("list", cwd=linked)
        self.assertIn("mf1", listing.stdout)

    def test_same_id_cannot_run_in_two_worktrees(self):
        linked = self.linked_worktree()
        first = self.cb("start", "dup1", str(self.brief))
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.cb("start", "dup1", str(self.brief), cwd=linked)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("already exists", second.stderr)

    def test_land_errors_when_starting_worktree_deleted(self):
        linked = self.linked_worktree()
        start = self.cb("start", "ld1", str(self.brief), cwd=linked)
        self.assertEqual(start.returncode, 0, start.stderr)
        self.remove_linked_worktree(linked)
        land = self.cb("land", "ld1")
        self.assertNotEqual(land.returncode, 0)
        self.assertIn("no longer exists", land.stderr)
        self.assertIn("linked", land.stderr)
        self.assertEqual(self.git("status", "--porcelain", "-uall"), "")
        self.assertEqual((self.worktree("ld1").parent / "status").read_text(), "ran")

    def test_caller_cb_variables_do_not_reach_the_script(self):
        with mock.patch.dict(
            os.environ,
            {
                "CB_MODEL": "paid-model",
                "CB_ALLOWED_MODELS": str(Path(self.tmp.name) / "missing-allowed-models.txt"),
                "CB_MAX_ROUNDS": "0",
            },
        ):
            result = unittest.TestResult()
            CbDelegateTest("test_model_must_be_on_allowed_list").run(result)
            CbDelegateTest("test_resume_limit").run(result)
        self.assertEqual(result.testsRun, 2)
        self.assertTrue(result.wasSuccessful(), result.failures + result.errors)


if __name__ == "__main__":
    unittest.main()
