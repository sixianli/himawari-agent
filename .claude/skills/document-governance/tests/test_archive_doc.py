"""Black-box tests for scripts/archive_doc.py."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SKILL_ROOT = Path(__file__).resolve().parents[1]
ARCHIVER = SKILL_ROOT / "scripts" / "archive_doc.py"
RUNBOOK = SKILL_ROOT / "scripts" / "runbook.py"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

import archive_doc


class ArchiveDocTests(unittest.TestCase):
    """Exercise successful, dry-run, boundary, and ADR-refusal behavior."""

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.sandbox = Path(self.temporary_directory.name)
        self.root = self.sandbox / "project"
        self.root.mkdir()

    def write_document(self, relative: str, document_type: str) -> Path:
        """Write one active document fixture."""

        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "\n".join(
                [
                    "---",
                    "status: active",
                    f"document_type: {document_type}",
                    'supersedes: ""',
                    'superseded_by: ""',
                    'date: "2026-07-19"',
                    "---",
                    "",
                    f"# {document_type.title()}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        return path

    def run_archiver(self, doc: str, *extra: str) -> subprocess.CompletedProcess[str]:
        """Run the archive CLI."""

        return subprocess.run(
            [
                sys.executable,
                str(ARCHIVER),
                str(self.root),
                doc,
                *extra,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def write_active_runbook(
        self,
        name: str,
        *,
        supersedes: str = "",
        seal: bool = True,
    ) -> Path:
        """Fill the bundled active Runbook template and optionally seal it."""

        source = self.root / "runbook-source.txt"
        source.write_text("authoritative\n", encoding="utf-8")
        template = (
            SKILL_ROOT / "assets/templates/runbook-template.md"
        ).read_text(encoding="utf-8")
        content = (
            template.replace("YYYY-MM-DD", "2026-08-23")
            .replace("<repo-relative-authoritative-path>", "runbook-source.txt")
            .replace('supersedes: ""', f'supersedes: "{supersedes}"')
        )
        path = self.root / f"docs/runbooks/{name}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if seal:
            result = subprocess.run(
                [
                    sys.executable,
                    str(RUNBOOK),
                    "seal",
                    str(self.root),
                    str(path),
                    "--confirm-reconciled",
                    "--apply",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        return path

    def test_archives_closed_spec_and_rewrites_frontmatter(self) -> None:
        """Move a Spec and preserve its optional supersession link."""

        source = self.write_document(
            "docs/execution/specs/closed.md", "spec"
        )
        self.write_document("docs/execution/specs/replacement.md", "spec")

        result = self.run_archiver(
            "docs/execution/specs/closed.md",
            "--superseded-by",
            "docs/execution/specs/replacement.md",
        )

        destination = self.root / "docs/archive/specs/closed.md"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(source.exists())
        self.assertTrue(destination.is_file())
        archived = destination.read_text(encoding="utf-8")
        self.assertIn('status: "archived"', archived)
        self.assertIn(
            'superseded_by: "docs/execution/specs/replacement.md"', archived
        )

    def test_refuses_to_archive_adr(self) -> None:
        """ADRs must remain in docs/adr and be superseded in place."""

        source = self.write_document("docs/adr/0001-decision.md", "adr")

        result = self.run_archiver("docs/adr/0001-decision.md")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("supersede it in place", result.stderr)
        self.assertTrue(source.is_file())
        self.assertFalse(
            (self.root / "docs/archive/adr/0001-decision.md").exists()
        )

    def test_dry_run_does_not_modify_plan(self) -> None:
        """Dry-run must leave the source and destination untouched."""

        source = self.write_document(
            "docs/execution/plans/closed.md", "plan"
        )
        before = source.read_text(encoding="utf-8")

        result = self.run_archiver(
            "docs/execution/plans/closed.md", "--dry-run"
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(source.read_text(encoding="utf-8"), before)
        self.assertFalse(
            (self.root / "docs/archive/plans/closed.md").exists()
        )

    def test_superseded_by_target_must_exist(self) -> None:
        """Reject a dangling supersession relationship before moving a Spec."""

        source = self.write_document(
            "docs/execution/specs/closed.md", "spec"
        )

        result = self.run_archiver(
            "docs/execution/specs/closed.md",
            "--superseded-by",
            "docs/execution/specs/missing.md",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("target does not exist", result.stderr)
        self.assertTrue(source.is_file())

    def test_refuses_document_outside_project_root_without_traceback(self) -> None:
        """Reject an absolute external target cleanly and without mutation."""

        outside = self.sandbox / "outside.md"
        outside.write_text("outside", encoding="utf-8")

        result = self.run_archiver(str(outside))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside project root", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertTrue(outside.is_file())

    def test_runbook_snapshot_preserves_stable_path_and_invalidates_seal(self) -> None:
        """Create reciprocal history without silently trusting the changed active file."""

        source = self.write_active_runbook("deploy-runbook.md")
        before = source.read_text(encoding="utf-8")
        dry_run = self.run_archiver(
            "docs/runbooks/deploy-runbook.md",
            "--snapshot",
            "--archive-date",
            "2026-08-23",
            "--dry-run",
        )
        destination = self.root / "docs/archive/runbooks/2026-08-23-deploy-runbook.md"
        self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
        self.assertEqual(source.read_text(encoding="utf-8"), before)
        self.assertFalse(destination.exists())

        applied = self.run_archiver(
            "docs/runbooks/deploy-runbook.md",
            "--snapshot",
            "--archive-date",
            "2026-08-23",
        )
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertTrue(source.is_file())
        self.assertTrue(destination.is_file())
        self.assertIn(
            'supersedes: "docs/archive/runbooks/2026-08-23-deploy-runbook.md"',
            source.read_text(encoding="utf-8"),
        )
        archived = destination.read_text(encoding="utf-8")
        self.assertIn('status: "archived"', archived)
        self.assertIn(
            'superseded_by: "docs/runbooks/deploy-runbook.md"', archived
        )
        self.assertIn("seal is now invalid", applied.stdout)

        failed_check = subprocess.run(
            [sys.executable, str(RUNBOOK), "check", str(self.root), str(source)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(failed_check.returncode, 0)
        resealed = subprocess.run(
            [
                sys.executable,
                str(RUNBOOK),
                "seal",
                str(self.root),
                str(source),
                "--confirm-reconciled",
                "--apply",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(resealed.returncode, 0, resealed.stderr)

    def test_runbook_successor_moves_old_and_updates_both_directions(self) -> None:
        """Archive a replaced stable entry and invalidate the successor seal."""

        old = self.write_active_runbook("old-runbook.md")
        successor = self.write_active_runbook("new-runbook.md")

        result = self.run_archiver(
            "docs/runbooks/old-runbook.md",
            "--superseded-by",
            "docs/runbooks/new-runbook.md",
            "--archive-date",
            "2026-08-23",
        )

        archived_path = self.root / "docs/archive/runbooks/2026-08-23-old-runbook.md"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old.exists())
        self.assertIn(
            'superseded_by: "docs/runbooks/new-runbook.md"',
            archived_path.read_text(encoding="utf-8"),
        )
        self.assertIn(
            "docs/archive/runbooks/2026-08-23-old-runbook.md",
            successor.read_text(encoding="utf-8"),
        )
        check = subprocess.run(
            [
                sys.executable,
                str(RUNBOOK),
                "check",
                str(self.root),
                str(successor),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(check.returncode, 0)

    def test_runbook_retire_requires_reason_and_has_no_successor(self) -> None:
        """Retire without inventing a successor or leaving an active stub."""

        source = self.write_active_runbook("retired-runbook.md")
        missing_reason = self.run_archiver(
            "docs/runbooks/retired-runbook.md",
            "--retire",
            "--archive-date",
            "2026-08-23",
        )
        self.assertNotEqual(missing_reason.returncode, 0)
        self.assertTrue(source.exists())

        result = self.run_archiver(
            "docs/runbooks/retired-runbook.md",
            "--retire",
            "--reason",
            "Service removed",
            "--archive-date",
            "2026-08-23",
        )
        destination = self.root / "docs/archive/runbooks/2026-08-23-retired-runbook.md"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(source.exists())
        archived = destination.read_text(encoding="utf-8")
        self.assertIn('archive_reason: "Service removed"', archived)
        self.assertIn('superseded_by: ""', archived)

    def test_snapshot_retargets_existing_predecessor_chain(self) -> None:
        """Keep every direct Runbook lineage edge reciprocal after path movement."""

        predecessor_relative = "docs/archive/runbooks/previous.md"
        active_relative = "docs/runbooks/deploy-runbook.md"
        predecessor = self.write_document(predecessor_relative, "runbook")
        predecessor.write_text(
            predecessor.read_text(encoding="utf-8")
            .replace("status: active", "status: archived")
            .replace('superseded_by: ""', f'superseded_by: "{active_relative}"'),
            encoding="utf-8",
        )
        active = self.write_active_runbook(
            "deploy-runbook.md", supersedes=predecessor_relative
        )

        result = self.run_archiver(
            active_relative,
            "--snapshot",
            "--archive-date",
            "2026-08-23",
        )

        new_archive = "docs/archive/runbooks/2026-08-23-deploy-runbook.md"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            f'superseded_by: "{new_archive}"',
            predecessor.read_text(encoding="utf-8"),
        )
        self.assertIn(
            f'supersedes: "{new_archive}"', active.read_text(encoding="utf-8")
        )
        self.assertIn(
            f'supersedes: "{predecessor_relative}"',
            (self.root / new_archive).read_text(encoding="utf-8"),
        )

    def test_runbook_archive_refuses_invalid_date_and_target_conflict(self) -> None:
        """Reject malformed dates and overwrite before mutating the source."""

        source = self.write_active_runbook("deploy-runbook.md")
        invalid_date = self.run_archiver(
            "docs/runbooks/deploy-runbook.md",
            "--snapshot",
            "--archive-date",
            "2026-02-30",
        )
        self.assertNotEqual(invalid_date.returncode, 0)
        self.assertTrue(source.exists())

        conflict = self.root / "docs/archive/runbooks/2026-08-23-deploy-runbook.md"
        conflict.parent.mkdir(parents=True, exist_ok=True)
        conflict.write_text("occupied\n", encoding="utf-8")
        collision = self.run_archiver(
            "docs/runbooks/deploy-runbook.md",
            "--snapshot",
            "--archive-date",
            "2026-08-23",
        )
        self.assertNotEqual(collision.returncode, 0)
        self.assertEqual(conflict.read_text(encoding="utf-8"), "occupied\n")
        self.assertTrue(source.exists())

    def test_compensating_transaction_restores_all_files_on_write_failure(self) -> None:
        """Do not leave half-updated relationships after an ordinary failure."""

        first = self.root / "first.md"
        second = self.root / "second.md"
        first.write_text("first-before\n", encoding="utf-8")
        second.write_text("second-before\n", encoding="utf-8")
        writes = [
            archive_doc.PlannedWrite(first, "first-after\n", 0o644),
            archive_doc.PlannedWrite(second, "second-after\n", 0o644),
        ]
        original_write = archive_doc._write_atomic
        calls = 0

        def fail_second(path: Path, content: bytes, mode: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected failure")
            original_write(path, content, mode)

        with (
            mock.patch.object(
                archive_doc, "_write_atomic", side_effect=fail_second
            ),
            self.assertRaises(SystemExit),
        ):
            archive_doc.apply_transaction(writes, [])

        self.assertEqual(first.read_text(encoding="utf-8"), "first-before\n")
        self.assertEqual(second.read_text(encoding="utf-8"), "second-before\n")


if __name__ == "__main__":
    unittest.main()
