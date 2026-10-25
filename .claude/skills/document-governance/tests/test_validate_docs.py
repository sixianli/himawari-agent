from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = SKILL_ROOT / "scripts" / "validate_docs.py"
RUNBOOK = SKILL_ROOT / "scripts" / "runbook.py"
REQUIRED_DIRS = [
    "docs/adr",
    "docs/execution/specs",
    "docs/execution/plans",
    "docs/archive/specs",
    "docs/archive/plans",
    "docs/archive/runbooks",
    "docs/runbooks",
]


class ValidateDocsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.sandbox = Path(self.temporary_directory.name)
        self.root = self.sandbox / "project"
        for relative in REQUIRED_DIRS:
            (self.root / relative).mkdir(parents=True, exist_ok=True)

    def write_document(
        self,
        relative: str,
        body: str,
        *,
        status: str = "active",
        document_type: str | None = None,
        decision_status: str | None = None,
        supersedes: str = "",
        superseded_by: str = "",
        extra_fields: dict[str, str] | None = None,
    ) -> Path:
        fields = [
            "---",
            f"status: {status}",
        ]
        if document_type is not None:
            fields.append(f"document_type: {document_type}")
        if decision_status is not None:
            fields.append(f"decision_status: {decision_status}")
        if extra_fields:
            fields.extend(f'{key}: "{value}"' for key, value in extra_fields.items())
        fields.extend(
            [
                f'supersedes: "{supersedes}"',
                f'superseded_by: "{superseded_by}"',
                'date: "2026-07-19"',
                "---",
                "",
                body,
                "",
            ]
        )
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(fields), encoding="utf-8")
        return path

    def run_validator(
        self, *, strict: bool = True
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        command = [
            sys.executable,
            str(VALIDATOR),
            str(self.root),
            "--format=json",
        ]
        if strict:
            command.append("--strict")
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        payload = json.loads(result.stdout)
        return result, payload

    def write_sealed_runbook(
        self, relative: str = "docs/runbooks/active-runbook.md"
    ) -> Path:
        (self.root / "runbook-source.txt").write_text(
            "authoritative\n", encoding="utf-8"
        )
        template = (
            SKILL_ROOT / "assets/templates/runbook-template.md"
        ).read_text(encoding="utf-8")
        content = template.replace("YYYY-MM-DD", "2026-07-19").replace(
            "<repo-relative-authoritative-path>", "runbook-source.txt"
        )
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        sealed = subprocess.run(
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
        self.assertEqual(sealed.returncode, 0, sealed.stderr)
        return path

    def test_strict_mode_promotes_every_soft_rule(self) -> None:
        self.write_document(
            "docs/archive/specs/old.md",
            "# Old spec",
            status="superseded",
            document_type="spec",
        )
        self.write_document(
            "docs/adr/0001-missing-decision-status.md",
            "# ADR without decision status",
        )
        self.write_document(
            "docs/execution/plans/no-source.md",
            "# Plan without source spec",
            document_type="plan",
        )
        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["warnings"], [])
        rendered = "\n".join(payload["errors"])
        self.assertIn("archive document is not marked archived", rendered)
        self.assertIn("ADR should include decision_status", rendered)
        self.assertIn("plan should link to its source spec", rendered)

    def test_source_paths_cannot_escape_or_fall_back_to_project_root(self) -> None:
        outside = self.sandbox / "outside.md"
        outside.write_text("outside", encoding="utf-8")
        (self.root / "README.md").write_text("root only", encoding="utf-8")
        self.write_document(
            "docs/prd-v0.1.md",
            "\n".join(
                [
                    "# Links",
                    "",
                    "- [SOURCE: ../outside.md]",
                    f"- [SOURCE: {outside}]",
                    "- [SOURCE: README.md]",
                ]
            ),
            document_type="prd",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("must not contain '..' traversal", rendered)
        self.assertIn("must be repository-relative", rendered)
        self.assertIn("missing SOURCE target README.md", rendered)

    def test_closed_spec_reference_resolves_through_archive_mapping(self) -> None:
        self.write_document(
            "docs/archive/specs/closed.md",
            "# Closed spec",
            status="archived",
            document_type="spec",
        )
        self.write_document(
            "docs/prd-v0.1.md",
            "# Links\n\n- [SOURCE: docs/execution/specs/closed.md]",
            document_type="prd",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["errors"], [])

    def test_superseded_adrs_remain_in_place_with_bidirectional_links(self) -> None:
        self.write_document(
            "docs/adr/0001-old.md",
            "# Old ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-new.md",
        )
        self.write_document(
            "docs/adr/0002-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="accepted",
            supersedes="docs/adr/0001-old.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["errors"], [])

    def test_proposed_replacement_does_not_supersede_old_adr_early(self) -> None:
        self.write_document(
            "docs/adr/0001-existing.md",
            "# Current ADR",
            document_type="adr",
            decision_status="accepted",
        )
        self.write_document(
            "docs/adr/0002-proposed.md",
            "# Proposed ADR",
            document_type="adr",
            decision_status="proposed",
            supersedes="docs/adr/0001-existing.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0)
        self.assertTrue(payload["ok"])

    def test_accepted_replacement_requires_old_adr_to_be_superseded(self) -> None:
        self.write_document(
            "docs/adr/0001-existing.md",
            "# Current ADR",
            document_type="adr",
            decision_status="accepted",
            superseded_by="docs/adr/0002-new.md",
        )
        self.write_document(
            "docs/adr/0002-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="accepted",
            supersedes="docs/adr/0001-existing.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("accepted replacement requires", rendered)

    def test_superseded_by_chain_reaches_active_accepted_decision(self) -> None:
        self.write_document(
            "docs/adr/0001-old.md",
            "# Old ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-middle.md",
        )
        self.write_document(
            "docs/adr/0002-middle.md",
            "# Middle ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0001-old.md",
            superseded_by="docs/adr/0003-new.md",
        )
        self.write_document(
            "docs/adr/0003-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="accepted",
            supersedes="docs/adr/0002-middle.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["errors"], [])

    def test_superseded_by_chain_accepts_four_adr_history(self) -> None:
        self.write_document(
            "docs/adr/0001-oldest.md",
            "# Oldest ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-older.md",
        )
        self.write_document(
            "docs/adr/0002-older.md",
            "# Older ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0001-oldest.md",
            superseded_by="docs/adr/0003-middle.md",
        )
        self.write_document(
            "docs/adr/0003-middle.md",
            "# Middle ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0002-older.md",
            superseded_by="docs/adr/0004-new.md",
        )
        self.write_document(
            "docs/adr/0004-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="accepted",
            supersedes="docs/adr/0003-middle.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["errors"], [])

    def test_superseded_by_chain_terminal_must_be_accepted(self) -> None:
        self.write_document(
            "docs/adr/0001-old.md",
            "# Old ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-middle.md",
        )
        self.write_document(
            "docs/adr/0002-middle.md",
            "# Middle ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0001-old.md",
            superseded_by="docs/adr/0003-new.md",
        )
        self.write_document(
            "docs/adr/0003-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="proposed",
            supersedes="docs/adr/0002-middle.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("superseded_by chain through docs/adr/0002", rendered)
        self.assertIn("ends at docs/adr/0003", rendered)

    def test_superseded_by_chain_cycle_is_reported_without_hanging(self) -> None:
        self.write_document(
            "docs/adr/0001-first.md",
            "# First ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0002-second.md",
            superseded_by="docs/adr/0002-second.md",
        )
        self.write_document(
            "docs/adr/0002-second.md",
            "# Second ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0001-first.md",
            superseded_by="docs/adr/0001-first.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        self.assertIn("loops back to", "\n".join(payload["errors"]))

    def test_direct_superseded_by_target_still_requires_active_accepted(self) -> None:
        self.write_document(
            "docs/adr/0001-old.md",
            "# Old ADR",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-new.md",
        )
        self.write_document(
            "docs/adr/0002-new.md",
            "# New ADR",
            document_type="adr",
            decision_status="proposed",
            supersedes="docs/adr/0001-old.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("superseding ADR docs/adr/0002", rendered)
        self.assertIn("must be active and accepted", rendered)
        self.assertNotIn("chain through", rendered)

    def test_superseded_by_chains_may_converge_without_a_loop(self) -> None:
        self.write_document(
            "docs/adr/0001-a.md",
            "# A",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            superseded_by="docs/adr/0002-b.md",
        )
        self.write_document(
            "docs/adr/0002-b.md",
            "# B",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0001-a.md",
            superseded_by="docs/adr/0003-c.md, docs/adr/0004-d.md",
        )
        self.write_document(
            "docs/adr/0003-c.md",
            "# C",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0002-b.md",
            superseded_by="docs/adr/0005-e.md",
        )
        self.write_document(
            "docs/adr/0004-d.md",
            "# D",
            status="superseded",
            document_type="adr",
            decision_status="superseded",
            supersedes="docs/adr/0002-b.md",
            superseded_by="docs/adr/0005-e.md",
        )
        self.write_document(
            "docs/adr/0005-e.md",
            "# E",
            document_type="adr",
            decision_status="accepted",
            supersedes="docs/adr/0003-c.md, docs/adr/0004-d.md",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["errors"], [])

    def test_structured_idea_and_backlog_are_strictly_valid(self) -> None:
        idea_path = "docs/ideas/IDEA-20260719-001-useful-thought.md"
        backlog_path = "docs/backlog/BL-20260719-001-evaluate-thought.md"
        self.write_document(
            idea_path,
            "# Useful thought",
            document_type="idea",
            extra_fields={
                "record_id": "IDEA-20260719-001",
                "record_state": "promoted",
                "updated": "2026-07-19",
                "promoted_to": backlog_path,
            },
        )
        self.write_document(
            backlog_path,
            f"# Evaluate thought\n\n- [SOURCE: {idea_path}]",
            document_type="backlog",
            extra_fields={
                "record_id": "BL-20260719-001",
                "record_state": "in_progress",
                "updated": "2026-07-19",
                "priority": "high",
                "item_type": "evaluation",
                "source_idea": idea_path,
                "review_after": "",
                "promoted_to": "",
                "result": "",
                "reason": "",
            },
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])

    def test_backlog_header_priority_and_item_type_follow_template_contract(self) -> None:
        self.write_document(
            "docs/backlog/BL-20260719-003-invalid-contract.md",
            "# Invalid contract",
            document_type="backlog",
            extra_fields={
                "record_id": "BL-20260719-003",
                "record_state": "open",
                "updated": "2026-07-19",
                "priority": "medium",
                "item_type": "",
            },
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["warnings"], [])
        rendered = "\n".join(payload["errors"])
        self.assertIn("missing Backlog frontmatter fields", rendered)
        self.assertIn("invalid Backlog priority 'medium'", rendered)
        self.assertIn("Backlog item_type must be non-empty", rendered)

    def test_backlog_contract_violations_are_migration_warnings_normally(self) -> None:
        self.write_document(
            "docs/backlog/BL-20260719-004-migration-warning.md",
            "# Migration warning",
            document_type="backlog",
            extra_fields={
                "record_id": "BL-20260719-004",
                "record_state": "open",
                "updated": "2026-07-19",
            },
        )

        result, payload = self.run_validator(strict=False)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])
        rendered = "\n".join(payload["warnings"])
        self.assertIn("missing Backlog frontmatter fields", rendered)
        self.assertIn("invalid Backlog priority ''", rendered)
        self.assertIn("Backlog item_type must be non-empty", rendered)

    def test_record_id_state_and_path_invariants_fail_strict_mode(self) -> None:
        self.write_document(
            "docs/ideas/wrong-name.md",
            "# Broken Idea",
            document_type="backlog",
            extra_fields={
                "record_id": "BAD-1",
                "record_state": "captured",
                "updated": "not-a-date",
                "promoted_to": "",
            },
        )
        self.write_document(
            "docs/backlog/BL-20260719-002-missing-target.md",
            "# Missing target",
            document_type="backlog",
            extra_fields={
                "record_id": "BL-20260719-002",
                "record_state": "converted",
                "updated": "2026-07-19",
                "promoted_to": "",
            },
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("conflicts with record path kind", rendered)
        self.assertIn("invalid record_id", rendered)
        self.assertIn("invalid record_state", rendered)
        self.assertIn("must set promoted_to", rendered)
        self.assertIn("updated must be YYYY-MM-DD", rendered)

    def test_duplicate_record_ids_and_terminal_evidence_are_rejected(self) -> None:
        common = {
            "record_id": "BL-20260719-001",
            "record_state": "done",
            "updated": "2026-07-19",
            "promoted_to": "",
            "result": "",
            "reason": "",
        }
        self.write_document(
            "docs/backlog/BL-20260719-001-first.md",
            "# First",
            document_type="backlog",
            extra_fields=common,
        )
        self.write_document(
            "docs/backlog/BL-20260719-001-second.md",
            "# Second",
            document_type="backlog",
            extra_fields=common,
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        rendered = "\n".join(payload["errors"])
        self.assertIn("duplicate record_id", rendered)
        self.assertIn("done Backlog requires result", rendered)

    def test_codex_lessons_is_a_distinct_governed_document(self) -> None:
        self.write_document(
            "docs/lessons.md",
            "# Agent Lessons\n\n## Repeated mistake\n\n- Prevention rule: verify first.",
            document_type="lessons",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])

    def test_legacy_runbook_is_warning_normally_and_error_in_strict_mode(self) -> None:
        self.write_document(
            "docs/runbooks/legacy.md",
            "# Legacy\n\n## Procedure\n\n1. Old step.",
            document_type="runbook",
        )

        normal_result, normal_payload = self.run_validator(strict=False)
        strict_result, strict_payload = self.run_validator(strict=True)

        self.assertEqual(normal_result.returncode, 0, normal_payload)
        self.assertTrue(normal_payload["warnings"])
        rendered_warnings = "\n".join(normal_payload["warnings"])
        self.assertIn("missing execution_risk", rendered_warnings)
        self.assertIn("missing required section: Scope", rendered_warnings)
        self.assertEqual(strict_result.returncode, 1)
        self.assertEqual(strict_payload["warnings"], [])

    def test_malformed_or_mismatched_declared_contract_always_errors(self) -> None:
        path = self.write_sealed_runbook()
        sealed_text = path.read_text(encoding="utf-8")
        path.write_text(
            sealed_text.replace("execution_risk: critical", "execution_risk: unsafe")
            .replace("contract_sha256: \"sha256:", "contract_sha256: \"bad-sha256:"),
            encoding="utf-8",
        )
        result, payload = self.run_validator(strict=False)
        rendered = "\n".join(payload["errors"])
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid execution_risk", rendered)
        self.assertIn("invalid contract_sha256", rendered)

        path.write_text(sealed_text, encoding="utf-8")
        (self.root / "runbook-source.txt").write_text("drift\n", encoding="utf-8")
        mismatch_result, mismatch_payload = self.run_validator(strict=False)
        self.assertEqual(mismatch_result.returncode, 1)
        self.assertIn(
            "does not match",
            "\n".join(mismatch_payload["errors"]),
        )

    def test_archived_runbook_hash_is_not_recomputed_against_current_sources(self) -> None:
        archived = self.write_document(
            "docs/archive/runbooks/legacy.md",
            "# Archived Runbook\n\nHistorical content.",
            status="archived",
            document_type="runbook",
            extra_fields={
                "execution_risk": "critical",
                "contract_sha256": "sha256:" + "a" * 64,
                "archive_reason": "Historical retirement",
            },
        )
        self.assertTrue(archived.is_file())

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])

    def test_legacy_active_runbook_source_resolves_to_unique_archive(self) -> None:
        self.write_document(
            "docs/archive/runbooks/old-runbook.md",
            "# Archived",
            status="archived",
            document_type="runbook",
            extra_fields={"archive_reason": "Legacy history"},
        )
        self.write_document(
            "docs/prd-v0.1.md",
            "# Product\n\n[SOURCE: docs/runbooks/old-runbook.md]",
            document_type="prd",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)

    def test_legacy_runbook_source_requires_one_unambiguous_dated_archive(self) -> None:
        for archive_date in ("2026-07-18",):
            self.write_document(
                f"docs/archive/runbooks/{archive_date}-old-runbook.md",
                "# Archived",
                status="archived",
                document_type="runbook",
                extra_fields={"archive_reason": "Historical retirement"},
            )
        self.write_document(
            "docs/prd-v0.1.md",
            "# Product\n\n[SOURCE: docs/runbooks/old-runbook.md]",
            document_type="prd",
        )

        unique_result, unique_payload = self.run_validator(strict=True)
        self.assertEqual(unique_result.returncode, 0, unique_payload)

        self.write_document(
            "docs/archive/runbooks/2026-07-19-old-runbook.md",
            "# Another archive",
            status="archived",
            document_type="runbook",
            extra_fields={"archive_reason": "Historical retirement"},
        )
        ambiguous_result, ambiguous_payload = self.run_validator(strict=True)

        self.assertEqual(ambiguous_result.returncode, 1)
        self.assertIn(
            "ambiguous archived Runbook SOURCE target",
            "\n".join(ambiguous_payload["errors"]),
        )

    def test_archive_source_compatibility_rejects_symlink_escape(self) -> None:
        outside = self.sandbox / "outside.md"
        outside.write_text("outside\n", encoding="utf-8")
        archive = self.root / "docs/archive/runbooks/old-runbook.md"
        archive.symlink_to(outside)
        self.write_document(
            "docs/prd-v0.1.md",
            "# Product\n\n[SOURCE: docs/runbooks/old-runbook.md]",
            document_type="prd",
        )

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "missing SOURCE target",
            "\n".join(payload["errors"]),
        )

    def test_bundled_templates_form_a_strictly_valid_project(self) -> None:
        templates = SKILL_ROOT / "assets" / "templates"
        destinations = {
            "prd-template.md": "docs/prd-v0.1.md",
            "architecture-template.md": "docs/architecture-v0.1.md",
            "adr-template.md": "docs/adr/0001-decision.md",
            "spec-template.md": "docs/execution/specs/2026-07-19-topic-design.md",
            "plan-template.md": "docs/execution/plans/2026-07-19-topic-plan.md",
            "runbook-template.md": "docs/runbooks/topic-runbook.md",
            "idea-note-template.md": "docs/ideas/IDEA-20260719-001-idea.md",
            "backlog-item-template.md": "docs/backlog/BL-20260719-001-item.md",
            "lessons-template.md": "docs/lessons.md",
        }
        for source_name, destination_name in destinations.items():
            content = (templates / source_name).read_text(encoding="utf-8")
            content = (
                content.replace("IDEA-YYYYMMDD-NNN", "IDEA-20260719-001")
                .replace("BL-YYYYMMDD-NNN", "BL-20260719-001")
                .replace("YYYY-MM-DD", "2026-07-19")
                .replace("<project>", "demo")
                .replace("<repo-relative-authoritative-path>", "README.md")
            )
            destination = self.root / destination_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8")

        (self.root / "README.md").write_text("# Demo\n", encoding="utf-8")
        sealed = subprocess.run(
            [
                sys.executable,
                str(RUNBOOK),
                "seal",
                str(self.root),
                "docs/runbooks/topic-runbook.md",
                "--confirm-reconciled",
                "--apply",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(sealed.returncode, 0, sealed.stderr)
        checked = subprocess.run(
            [
                sys.executable,
                str(RUNBOOK),
                "check",
                str(self.root),
                "docs/runbooks/topic-runbook.md",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(checked.returncode, 0, checked.stderr)

        result, payload = self.run_validator(strict=True)

        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["ok"])


if __name__ == "__main__":
    unittest.main()
