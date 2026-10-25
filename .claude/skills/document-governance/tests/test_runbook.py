"""Black-box and policy tests for scripts/runbook.py."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = SKILL_ROOT / "scripts"
RUNBOOK_CLI = SCRIPT_DIR / "runbook.py"
FIXTURE = SKILL_ROOT / "tests/fixtures/runbook-contract-v1"
sys.path.insert(0, str(SCRIPT_DIR))

from runbook import (
    RunbookContractError,
    compute_contract_fingerprint,
    execution_gate,
)

REQUIRED_SECTIONS = [
    "Scope",
    "Authoritative Sources",
    "Safety and Preconditions",
    "Live-State Preflight",
    "Procedure",
    "Verification",
    "Evidence",
    "Rollback",
    "Stop Conditions",
    "Troubleshooting",
]


class RunbookFixture:
    root: Path

    def write_runbook(
        self,
        *,
        contract: list[str] | None = None,
        status: str = "active",
        risk: str = "critical",
        contract_hash: str = "sha256:<64-hex>",
        sections: list[str] | None = None,
        extra_frontmatter: list[str] | None = None,
        extra_body: str = "",
    ) -> Path:
        """Write one structurally complete active Runbook fixture."""

        fields = [
            "---",
            f"status: {status}",
            "document_type: runbook",
            f"execution_risk: {risk}",
            f'contract_sha256: "{contract_hash}"',
            'supersedes: ""',
            'superseded_by: ""',
            'date: "2026-08-23"',
        ]
        fields.extend(extra_frontmatter or [])
        fields.extend(["---", "", "# Test Runbook", ""])
        selectors = contract if contract is not None else ["contract.txt"]
        fields.extend(
            [
                "<!-- runbook-contract:",
                *[f"- {value}" for value in selectors],
                "-->",
                "",
            ]
        )
        for section in sections if sections is not None else REQUIRED_SECTIONS:
            fields.extend([f"## {section}", "", f"Content for {section}.", ""])
        if extra_body:
            fields.extend([extra_body, ""])
        path = self.root / "docs/runbooks/test-runbook.md"
        path.write_text("\n".join(fields), encoding="utf-8")
        return path

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        """Run the public CLI in a subprocess."""

        return subprocess.run(
            [sys.executable, str(RUNBOOK_CLI), *arguments],
            check=False,
            capture_output=True,
            text=True,
        )

    def seal(self, path: Path) -> subprocess.CompletedProcess[str]:
        """Explicitly seal a reconciled fixture."""

        return self.run_cli(
            "seal",
            str(self.root),
            str(path),
            "--confirm-reconciled",
            "--apply",
        )


class RunbookTests(RunbookFixture, unittest.TestCase):
    """Exercise deterministic hashing, safety, sealing, and policy gates."""

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.sandbox = Path(self.temporary_directory.name)
        self.root = self.sandbox / "project"
        (self.root / "docs/runbooks").mkdir(parents=True)

    def test_fixed_version_one_vector(self) -> None:
        """Pin an implementation-independent digest for repository checkers."""

        shutil.copytree(FIXTURE / "project", self.root, dirs_exist_ok=True)
        path = self.root / "docs/runbooks/vector-runbook.md"
        result = compute_contract_fingerprint(self.root, path)
        expected = (FIXTURE / "expected.sha256").read_text(
            encoding="utf-8"
        ).strip()

        self.assertEqual(result.fingerprint, expected)

    def test_seal_is_dry_run_until_both_write_flags_are_present(self) -> None:
        """No implicit write, force, date refresh, or half-confirmed write exists."""

        (self.root / "contract.txt").write_text("v1\n", encoding="utf-8")
        path = self.write_runbook()
        before = path.read_text(encoding="utf-8")

        dry_run = self.run_cli("seal", str(self.root), str(path))
        self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
        self.assertIn("mode: dry-run", dry_run.stdout)
        self.assertEqual(path.read_text(encoding="utf-8"), before)

        missing_confirmation = self.run_cli(
            "seal", str(self.root), str(path), "--apply"
        )
        self.assertNotEqual(missing_confirmation.returncode, 0)
        self.assertIn("requires both", missing_confirmation.stderr)
        self.assertEqual(path.read_text(encoding="utf-8"), before)

        applied = self.seal(path)
        checked = self.run_cli(
            "check", str(self.root), str(path), "--format=json"
        )

        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertNotEqual(path.read_text(encoding="utf-8"), before)
        payload = json.loads(checked.stdout)
        self.assertEqual(checked.returncode, 0, payload)
        self.assertTrue(payload["ok"])
        self.assertIn("does not authorize", payload["notice"])

    def test_content_directory_and_mode_changes_invalidate_seal(self) -> None:
        """Cover body, file bytes, directory membership, and executable bits."""

        cases = ("body", "file", "addition", "deletion", "mode")
        for case in cases:
            with self.subTest(case=case):
                root = self.sandbox / case
                (root / "docs/runbooks").mkdir(parents=True)
                (root / "sources").mkdir()
                source = root / "sources/input.txt"
                source.write_text("v1\n", encoding="utf-8")
                extra = root / "sources/extra.txt"
                extra.write_text("extra\n", encoding="utf-8")
                original_root = self.root
                self.root = root
                path = self.write_runbook(contract=["sources"])
                sealed = self.seal(path)
                self.assertEqual(sealed.returncode, 0, sealed.stderr)

                if case == "body":
                    path.write_text(
                        path.read_text(encoding="utf-8") + "changed body\n",
                        encoding="utf-8",
                    )
                elif case == "file":
                    source.write_text("v2\n", encoding="utf-8")
                elif case == "addition":
                    (root / "sources/new.txt").write_text("new\n", encoding="utf-8")
                elif case == "deletion":
                    extra.unlink()
                else:
                    source.chmod(source.stat().st_mode | 0o100)

                checked = self.run_cli("check", str(root), str(path))
                self.assertNotEqual(checked.returncode, 0)
                self.assertIn("does not match", checked.stderr)
                self.root = original_root

    def test_internal_symlink_target_change_invalidates_seal(self) -> None:
        """Hash the repository-internal link target string without traversal."""

        (self.root / "targets").mkdir()
        (self.root / "targets/a.txt").write_text("same\n", encoding="utf-8")
        (self.root / "targets/b.txt").write_text("same\n", encoding="utf-8")
        link = self.root / "current"
        link.symlink_to("targets/a.txt")
        path = self.write_runbook(contract=["current"])
        self.assertEqual(self.seal(path).returncode, 0)

        link.unlink()
        link.symlink_to("targets/b.txt")
        checked = self.run_cli("check", str(self.root), str(path))

        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("does not match", checked.stderr)

    def test_contract_traversal_order_is_deterministic(self) -> None:
        """Filesystem creation order must not change the versioned digest."""

        fingerprints: list[str] = []
        for index, order in enumerate((("a", "b"), ("b", "a"))):
            root = self.sandbox / f"order-{index}"
            (root / "docs/runbooks").mkdir(parents=True)
            (root / "sources").mkdir()
            for name in order:
                (root / f"sources/{name}.txt").write_text(
                    f"{name}\n", encoding="utf-8"
                )
            original_root = self.root
            self.root = root
            path = self.write_runbook(contract=["sources"])
            fingerprints.append(
                compute_contract_fingerprint(root, path).fingerprint
            )
            self.root = original_root

        self.assertEqual(fingerprints[0], fingerprints[1])

    def test_unsafe_contract_inputs_are_rejected_without_tracebacks(self) -> None:
        """Reject traversal, external links, secrets, caches, and evidence roots."""

        outside = self.sandbox / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        unsafe_values = [
            ("../outside.txt", None),
            (str(outside), None),
            ("C:\\secrets\\key.txt", None),
            (".env", "secret"),
            (".git", "directory"),
            (".cache", "directory"),
            ("build", "directory"),
            ("evidence", "directory"),
            ("external-link", "symlink"),
        ]
        for index, (selector, object_kind) in enumerate(unsafe_values):
            with self.subTest(selector=selector):
                root = self.sandbox / f"unsafe-{index}"
                (root / "docs/runbooks").mkdir(parents=True)
                if object_kind == "secret":
                    (root / selector).write_text("TOKEN=x\n", encoding="utf-8")
                elif object_kind == "directory":
                    (root / selector).mkdir()
                elif object_kind == "symlink":
                    (root / selector).symlink_to(outside)
                original_root = self.root
                self.root = root
                path = self.write_runbook(contract=[selector])
                result = self.run_cli("seal", str(root), str(path))
                self.root = original_root

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)

    def test_example_env_is_allowed_and_nested_cache_is_ignored(self) -> None:
        """Allow example config while keeping local cache bytes out of contracts."""

        (self.root / "src").mkdir()
        (self.root / "src/.env.example").write_text("TOKEN=example\n", encoding="utf-8")
        path = self.write_runbook(contract=["src"])
        self.assertEqual(self.seal(path).returncode, 0)

        (self.root / "src/.cache").mkdir()
        (self.root / "src/.cache/local.bin").write_bytes(b"machine cache")
        (self.root / "src/.DS_Store").write_bytes(b"host metadata")
        checked = self.run_cli("check", str(self.root), str(path))

        self.assertEqual(checked.returncode, 0, checked.stderr)

        (self.root / "src/credentials.json").write_text(
            '{"token":"' + 'secret' + '"}\n', encoding="utf-8"
        )
        secret_check = self.run_cli("check", str(self.root), str(path))
        self.assertNotEqual(secret_check.returncode, 0)
        self.assertIn("secret or credential", secret_check.stderr)

    def test_fenced_or_duplicate_structure_cannot_satisfy_contract(self) -> None:
        """Ignore examples and reject duplicate executable sections."""

        (self.root / "contract.txt").write_text("v1\n", encoding="utf-8")
        sections = [
            section for section in REQUIRED_SECTIONS if section != "Procedure"
        ]
        fenced = self.write_runbook(
            sections=sections,
            extra_body="```markdown\n## Procedure\n```",
        )
        missing = self.run_cli("seal", str(self.root), str(fenced))
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("missing required section: Procedure", missing.stderr)

        duplicate = self.write_runbook(extra_body="## Procedure\n\nSecond procedure.")
        duplicated = self.run_cli("seal", str(self.root), str(duplicate))
        self.assertNotEqual(duplicated.returncode, 0)
        self.assertIn("duplicate required section: Procedure", duplicated.stderr)

    def test_archived_superseded_and_calendar_trust_are_never_checkable(self) -> None:
        """Block inactive status and Runbook-specific date trust fields."""

        (self.root / "contract.txt").write_text("v1\n", encoding="utf-8")
        for status in ("archived", "superseded"):
            with self.subTest(status=status):
                path = self.write_runbook(status=status)
                result = self.run_cli("check", str(self.root), str(path))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("status: active", result.stderr)

        path = self.write_runbook(extra_frontmatter=['review_after: "2026-09-01"'])
        result = self.run_cli("seal", str(self.root), str(path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("calendar trust field review_after", result.stderr)

    def test_effective_risk_only_rises_and_preflight_precedes_authorization(self) -> None:
        """Expose observable risk-floor and mutation-boundary policy behavior."""

        preflight = execution_gate("critical", "standard", "critical", "preflight")
        mutation = execution_gate("standard", "critical", "critical", "mutation")
        unknown = execution_gate("standard", "unknown", "standard", "mutation")

        self.assertEqual(preflight.effective_risk, "critical")
        self.assertEqual(preflight.authorization, "read-only-preflight")
        self.assertEqual(mutation.effective_risk, "critical")
        self.assertEqual(
            mutation.authorization, "immediate-explicit-authorization"
        )
        self.assertEqual(unknown.effective_risk, "critical")


class GitWorkTreeContractTests(RunbookFixture, unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.sandbox = Path(self.temporary_directory.name).resolve()
        empty_config = self.sandbox / "empty.gitconfig"
        empty_config.write_text("", encoding="utf-8")
        environment = mock.patch.dict(
            os.environ,
            {"GIT_CONFIG_GLOBAL": str(empty_config), "GIT_CONFIG_NOSYSTEM": "1"},
        )
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
            os.environ.pop(name, None)
        self.root = self.sandbox / "repo"
        (self.root / "docs/runbooks").mkdir(parents=True)
        (self.root / "src/nested").mkdir(parents=True)
        (self.root / "src/app.py").write_text("APP = 1\n", encoding="utf-8")
        (self.root / "src/nested/module.py").write_text("VALUE = 1\n", encoding="utf-8")
        (self.root / ".gitignore").write_text(
            "*.log\n.claude/\ngenerated/\nscratch/\n.env\ncredentials.json\n",
            encoding="utf-8",
        )
        self.runbook = self.write_runbook(contract=["src"])
        self.git("init", "-q")
        self.git("add", "--all")
        self.git("commit", "-q", "-m", "initial")
        self.baseline = self.fingerprint()

    def git(self, *arguments: str, cwd: Path | None = None) -> str:
        result = subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "init.defaultBranch=main",
                *arguments,
            ],
            cwd=cwd or self.root,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout

    def fingerprint(self, root: Path | None = None, runbook: Path | None = None) -> str:
        return compute_contract_fingerprint(
            root or self.root, runbook or self.runbook
        ).fingerprint

    def add_ignored_local_files(self, root: Path) -> None:
        (root / "src/debug.log").write_text("local log\n", encoding="utf-8")
        (root / "src/nested/.claude/.cc-writes").mkdir(parents=True)
        (root / "src/generated").mkdir()
        (root / "src/generated/out.js").write_text("built\n", encoding="utf-8")

    def test_ignored_files_and_directories_do_not_change_the_fingerprint(self) -> None:
        self.add_ignored_local_files(self.root)

        self.assertEqual(self.fingerprint(), self.baseline)

    def test_untracked_and_force_added_files_change_the_fingerprint(self) -> None:
        (self.root / "src/new.py").write_text("NEW = 1\n", encoding="utf-8")
        with_new = self.fingerprint()
        self.assertNotEqual(with_new, self.baseline)

        forced = self.root / "src/generated/kept.js"
        forced.parent.mkdir()
        forced.write_text("v1\n", encoding="utf-8")
        self.git("add", "--force", "src/generated/kept.js")
        with_forced = self.fingerprint()
        self.assertNotEqual(with_forced, with_new)

        forced.write_text("v2\n", encoding="utf-8")
        self.assertNotEqual(self.fingerprint(), with_forced)

    def test_work_tree_matches_a_copy_of_its_visible_files(self) -> None:
        self.add_ignored_local_files(self.root)
        (self.root / "src/new.py").write_text("NEW = 1\n", encoding="utf-8")
        (self.root / "src/nested/module.py").unlink()
        copy = self.sandbox / "copy"
        listed = self.git(
            "ls-files", "-z", "--cached", "--others", "--exclude-standard"
        ).split("\0")
        for name in filter(None, listed):
            source = self.root / name
            if not source.exists():
                continue
            target = copy / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        self.assertEqual(
            self.fingerprint(copy, copy / "docs/runbooks/test-runbook.md"),
            self.fingerprint(),
        )

    def test_ignored_secret_material_still_fails_the_contract(self) -> None:
        for relative in ("src/.env", "src/generated/credentials.json"):
            with self.subTest(path=relative):
                secret = self.root / relative
                secret.parent.mkdir(parents=True, exist_ok=True)
                secret.write_text("TOKEN=x\n", encoding="utf-8")
                with self.assertRaisesRegex(
                    RunbookContractError, "secret or credential"
                ):
                    self.fingerprint()
                secret.unlink()

    def test_pathspec_characters_in_selectors_are_literal(self) -> None:
        (self.root / "src1").mkdir()
        (self.root / "src1/b.py").write_text("B = 1\n", encoding="utf-8")
        for selector in ("src[1]", ":/lib"):
            with self.subTest(selector=selector):
                source = self.root / selector / "a.py"
                source.parent.mkdir(parents=True)
                source.write_text("A = 1\n", encoding="utf-8")
                runbook = self.write_runbook(contract=[selector])
                before = self.fingerprint(runbook=runbook)

                source.write_text("A = 2\n", encoding="utf-8")

                self.assertNotEqual(self.fingerprint(runbook=runbook), before)

    def test_selectors_hidden_by_git_ignore_rules_are_rejected(self) -> None:
        self.add_ignored_local_files(self.root)
        for contract in (["src/debug.log"], ["src/generated"]):
            with self.subTest(contract=contract):
                runbook = self.write_runbook(contract=contract)
                with self.assertRaisesRegex(RunbookContractError, "ignored by Git"):
                    self.fingerprint(runbook=runbook)

    def test_project_copies_in_ignored_directories_use_the_disk_rule(self) -> None:
        expected = (FIXTURE / "expected.sha256").read_text(encoding="utf-8").strip()
        (self.root / ".git/info/exclude").write_text("local-only/\n", encoding="utf-8")
        for ignored_by, parent in ((".gitignore", "scratch"), (".git/info/exclude", "local-only")):
            with self.subTest(ignored_by=ignored_by):
                copy = self.root / parent / "vector"
                shutil.copytree(FIXTURE / "project", copy)
                runbook = copy / "docs/runbooks/vector-runbook.md"
                leftover = copy / "contract/debug.log"

                self.assertEqual(self.fingerprint(copy, runbook), expected)
                leftover.write_text("local log\n", encoding="utf-8")
                self.assertNotEqual(self.fingerprint(copy, runbook), expected)

                leftover.unlink()
                self.git("add", "--force", f"{parent}/vector")
                self.git("commit", "-q", "-m", f"tracked below {ignored_by}")
                leftover.write_text("local log\n", encoding="utf-8")
                self.assertEqual(self.fingerprint(copy, runbook), expected)

    def test_project_root_below_the_work_tree_top_level(self) -> None:
        site = self.root / "site"
        (site / "docs/runbooks").mkdir(parents=True)
        (site / "src/nested").mkdir(parents=True)
        (site / "src/app.py").write_text("SITE = 1\n", encoding="utf-8")
        (site / "src/nested/module.py").write_text("VALUE = 2\n", encoding="utf-8")
        original_root = self.root
        self.root = site
        runbook = self.write_runbook(contract=["src"])
        self.root = original_root
        self.git("add", "--all")
        self.git("commit", "-q", "-m", "site")
        before = self.fingerprint(site, runbook)

        self.add_ignored_local_files(site)
        self.assertEqual(self.fingerprint(site, runbook), before)

        (site / "src/new.py").write_text("NEW = 1\n", encoding="utf-8")
        self.assertNotEqual(self.fingerprint(site, runbook), before)

    def test_inherited_git_location_variables_are_ignored(self) -> None:
        other = self.sandbox / "other"
        other.mkdir()
        self.git("init", "-q", cwd=other)
        os.environ["GIT_DIR"] = str(other / ".git")
        os.environ["GIT_WORK_TREE"] = str(other)
        self.add_ignored_local_files(self.root)

        self.assertEqual(self.fingerprint(), self.baseline)

    def file_system_matches(self, created: str, looked_up: str) -> bool:
        probe = self.sandbox / created
        probe.write_text("", encoding="utf-8")
        try:
            return os.path.lexists(self.sandbox / looked_up)
        finally:
            probe.unlink()

    def test_fixed_version_one_vector_in_a_work_tree_with_leftovers(self) -> None:
        vector = self.sandbox / "vector"
        shutil.copytree(FIXTURE / "project", vector)
        self.git("init", "-q", cwd=vector)
        self.git("add", "--all", cwd=vector)
        self.git("commit", "-q", "-m", "vector", cwd=vector)
        (vector / ".git/info/exclude").write_text("*.log\n", encoding="utf-8")
        (vector / "contract/debug.log").write_text("local log\n", encoding="utf-8")
        (vector / "contract/nested/.claude/.cc-writes").mkdir(parents=True)
        expected = (FIXTURE / "expected.sha256").read_text(encoding="utf-8").strip()

        self.assertEqual(
            self.fingerprint(vector, vector / "docs/runbooks/vector-runbook.md"),
            expected,
        )

    def test_nested_repositories_and_submodules_are_rejected(self) -> None:
        nested = self.root / "src/nested-repo"
        nested.mkdir()
        (nested / "inner.py").write_text("INNER = 1\n", encoding="utf-8")
        self.git("init", "-q", cwd=nested)
        self.git("add", "--all", cwd=nested)
        self.git("commit", "-q", "-m", "inner", cwd=nested)
        message = "Git lists src/nested-repo as one entry, but the work tree holds a directory"
        with self.subTest(case="untracked nested repository"), self.assertRaisesRegex(
            RunbookContractError, message
        ):
            self.fingerprint()

        self.git("add", "src/nested-repo")
        self.git("commit", "-q", "-m", "gitlink")
        with self.subTest(case="submodule entry"), self.assertRaisesRegex(
            RunbookContractError, message
        ):
            self.fingerprint()

    def test_tracked_files_replaced_by_directories_are_rejected(self) -> None:
        replaced = self.root / "src/app.py"
        replaced.unlink()
        replaced.mkdir()
        (replaced / "inner.py").write_text("INNER = 1\n", encoding="utf-8")

        with self.assertRaisesRegex(
            RunbookContractError,
            "Git lists src/app.py as one entry, but the work tree holds a directory",
        ):
            self.fingerprint()

    def test_names_that_differ_from_git_fail_instead_of_being_skipped(self) -> None:
        cases = (
            ("letter case", "CaseProbe", "caseprobe", "Mixed.py", "mixed.py", "Mixed.py"),
            (
                "Unicode normalization",
                "e\u0301-probe",
                "\u00e9-probe",
                "cafe\u0301.py",
                None,
                "caf\u00e9.py",
            ),
        )
        for label, created, looked_up, written, renamed_to, listed_name in cases:
            with self.subTest(case=label):
                if not self.file_system_matches(created, looked_up):
                    self.skipTest(f"the file system tells names apart by {label}")
                source = self.root / "src" / written
                source.write_text("NAMED = 1\n", encoding="utf-8")
                try:
                    self.git("add", "--all")
                    self.git("commit", "-q", "-m", label)
                    if renamed_to is not None:
                        os.rename(source, self.root / "src" / renamed_to)
                    listed = self.git("ls-files", "-z", "src").split("\0")
                    if f"src/{listed_name}" not in listed:
                        self.skipTest(f"Git stores the {label} of the name as written on disk")

                    with self.assertRaisesRegex(
                        RunbookContractError, f"src/{listed_name}, .*different name"
                    ):
                        self.fingerprint()
                finally:
                    for name in {written, renamed_to} - {None}:
                        if os.path.lexists(self.root / "src" / name):
                            (self.root / "src" / name).unlink()
                    self.git("add", "--all")
                    self.git("commit", "-q", "--allow-empty", "-m", f"remove {label}")

    def test_tracked_files_under_excluded_names_stay_out_without_errors(self) -> None:
        (self.root / "src/build").mkdir()
        (self.root / "src/build/out.py").write_text("OUT = 1\n", encoding="utf-8")
        (self.root / "src/.DS_Store").write_bytes(b"\0")
        self.git("add", "--all")
        self.git("commit", "-q", "-m", "excluded names")

        self.assertEqual(self.fingerprint(), self.baseline)

    def test_inherited_discovery_config_and_pathspec_variables_are_ignored(self) -> None:
        site = self.root / "site"
        (site / "docs/runbooks").mkdir(parents=True)
        (site / "src").mkdir()
        (site / "src/app.py").write_text("SITE = 1\n", encoding="utf-8")
        original_root = self.root
        self.root = site
        runbook = self.write_runbook(contract=["src"])
        self.root = original_root
        self.git("add", "--all")
        self.git("commit", "-q", "-m", "site")
        self.add_ignored_local_files(site)
        (site / "src/new.py").write_text("NEW = 1\n", encoding="utf-8")
        excludes = self.sandbox / "excludes"
        excludes.write_text("new.py\n", encoding="utf-8")
        expected = self.fingerprint(site, runbook)
        cases = {
            "ceiling": {"GIT_CEILING_DIRECTORIES": str(self.root)},
            "parameters": {"GIT_CONFIG_PARAMETERS": f"'core.excludesFile={excludes}'"},
            "count": {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "core.excludesFile",
                "GIT_CONFIG_VALUE_0": str(excludes),
            },
            "glob pathspecs": {"GIT_GLOB_PATHSPECS": "1"},
            "case-insensitive pathspecs": {"GIT_ICASE_PATHSPECS": "1"},
            "literal pathspecs": {"GIT_LITERAL_PATHSPECS": "1"},
            "no-glob pathspecs": {"GIT_NOGLOB_PATHSPECS": "1"},
        }
        for label, variables in cases.items():
            with self.subTest(case=label), mock.patch.dict(os.environ, variables):
                self.assertEqual(self.fingerprint(site, runbook), expected)

    def test_git_failures_inside_a_repository_are_errors(self) -> None:
        self.add_ignored_local_files(self.root)
        empty_path = self.sandbox / "no-git"
        empty_path.mkdir()
        with self.subTest(case="git missing"), mock.patch.dict(
            os.environ, {"PATH": str(empty_path)}
        ), self.assertRaisesRegex(
            RunbookContractError, re.escape(f"{self.root / '.git'} exists, but Git is not available")
        ):
            self.fingerprint()

        stray = self.sandbox / "stray"
        (stray / ".git").mkdir(parents=True)
        inside = self.root / ".git/project"
        expectations = (
            (stray / "project", re.escape(f"{stray / '.git'} exists, but Git could not inspect")),
            (inside, "Git reports that the project root is not in a work tree"),
        )
        for project, message in expectations:
            shutil.copytree(self.root / "src", project / "src")
            shutil.copytree(self.root / "docs", project / "docs")
            with self.subTest(root=project.relative_to(self.sandbox).as_posix()), self.assertRaisesRegex(
                RunbookContractError, message
            ):
                self.fingerprint(project, project / "docs/runbooks/test-runbook.md")

        config = self.root / ".git/config"
        config.write_text(
            config.read_text(encoding="utf-8").replace(
                "repositoryformatversion = 0", "repositoryformatversion = 99"
            ),
            encoding="utf-8",
        )
        with self.subTest(case="repository refused"), self.assertRaisesRegex(
            RunbookContractError, re.escape(f"{self.root / '.git'} exists, but Git could not inspect")
        ):
            self.fingerprint()

    def test_missing_git_outside_a_repository_keeps_the_disk_rule(self) -> None:
        plain = self.sandbox / "plain"
        shutil.copytree(self.root / "src", plain / "src")
        shutil.copytree(self.root / "docs", plain / "docs")
        runbook = plain / "docs/runbooks/test-runbook.md"
        expected = self.fingerprint(plain, runbook)
        empty_path = self.sandbox / "no-git"
        empty_path.mkdir()

        with mock.patch.dict(os.environ, {"PATH": str(empty_path)}):
            self.assertEqual(self.fingerprint(plain, runbook), expected)

    def test_deleted_tracked_files_name_the_work_tree(self) -> None:
        (self.root / "src/app.py").unlink()
        (self.root / "src/nested/module.py").unlink()

        with self.assertRaisesRegex(RunbookContractError, "in the work tree: src"):
            self.fingerprint()


if __name__ == "__main__":
    unittest.main()
