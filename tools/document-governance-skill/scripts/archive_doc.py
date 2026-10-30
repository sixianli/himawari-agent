#!/usr/bin/env python3
"""Archive governed Spec, Plan, or Runbook documents.

ADRs are never archived. Runbooks use explicit snapshot, successor, or retire
modes and update reciprocal lineage without silently resealing active files.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from runbook import audit_active_runbook, parse_frontmatter_text

ACTIVE_TO_ARCHIVE = {
    "docs/execution/specs": "docs/archive/specs",
    "docs/execution/plans": "docs/archive/plans",
}
RUNBOOK_ACTIVE_DIR = "docs/runbooks"
RUNBOOK_ARCHIVE_DIR = "docs/archive/runbooks"


@dataclass(frozen=True)
class PlannedWrite:
    """One fully rendered file update in a compensating transaction."""

    path: Path
    text: str
    mode: int


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse archive modes while retaining the existing Spec/Plan interface."""

    parser = argparse.ArgumentParser(
        description="Archive a closed Spec, Plan, or governed Runbook."
    )
    parser.add_argument("root", help="Target project root.")
    parser.add_argument(
        "doc", help="Document path, repository-relative or absolute."
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--snapshot",
        action="store_true",
        help="Snapshot a stable active Runbook before a major revision.",
    )
    modes.add_argument(
        "--superseded-by",
        default=None,
        help=(
            "Successor path. For Runbooks this is a distinct active Runbook; "
            "for Spec/Plan it preserves the existing optional metadata behavior."
        ),
    )
    modes.add_argument(
        "--retire",
        action="store_true",
        help="Retire an active Runbook without a successor.",
    )
    parser.add_argument(
        "--reason", default=None, help="Required safe single-line retire reason."
    )
    parser.add_argument(
        "--archive-date",
        default=None,
        help="Required YYYY-MM-DD date for newly archived Runbooks.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print all planned file and frontmatter changes without applying.",
    )
    return parser.parse_args(argv)


def _is_within(path: Path, directory: Path) -> bool:
    """Return whether a resolved path remains within a directory."""

    try:
        path.relative_to(directory)
    except ValueError:
        return False
    return True


def resolve_doc(root: Path, doc: str) -> Path:
    """Resolve a source document and reject project-root escape."""

    candidate = Path(doc)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    if not _is_within(candidate, root):
        raise SystemExit(
            f"refusing to archive: document is outside project root: {candidate}"
        )
    return candidate


def _relative(root: Path, path: Path) -> str:
    """Return a repository-relative POSIX path."""

    return path.relative_to(root).as_posix()


def _is_under(root: Path, path: Path, relative_dir: str) -> bool:
    """Return whether a path is within a repository-relative directory."""

    return _is_within(path, (root / relative_dir).resolve())


def _safe_scalar(value: str, option: str) -> str:
    """Reject values that cannot be safely rendered as one quoted field."""

    if not value.strip() or any(character in value for character in ('\n', '\r', '"')):
        raise SystemExit(f"invalid {option}: expected a non-empty safe single line")
    return value.strip()


def _validate_archive_date(value: str | None) -> str:
    """Require an exact, real ISO date for a Runbook archive name."""

    if value is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise SystemExit("Runbook modes require --archive-date YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(
            "invalid --archive-date: expected a real YYYY-MM-DD date"
        ) from exc
    return value


def _normalize_docs_target(root: Path, value: str) -> tuple[Path, str]:
    """Resolve one safe docs-relative relationship target."""

    _safe_scalar(value, "--superseded-by")
    raw = Path(value)
    if raw.is_absolute() or ".." in raw.parts:
        raise SystemExit(
            "invalid --superseded-by: path must be repository-relative and must not traverse '..'"
        )
    normalized = raw.as_posix()
    if not normalized.startswith("docs/"):
        normalized = f"docs/{normalized}"
    resolved = (root / normalized).resolve()
    docs_root = (root / "docs").resolve()
    if not _is_within(resolved, docs_root):
        raise SystemExit(
            "invalid --superseded-by: path must remain inside project docs/"
        )
    if not resolved.is_file():
        raise SystemExit(
            f"invalid --superseded-by: target does not exist: {resolved}"
        )
    return resolved, normalized


def _frontmatter(text: str, owner: str) -> dict[str, str]:
    """Parse safe governance frontmatter or fail before any write."""

    fields, _, problems = parse_frontmatter_text(text)
    if problems:
        raise SystemExit(f"refusing to archive {owner}: {problems[0]}")
    return fields


def _set_field(frontmatter: list[str], key: str, value: str) -> list[str]:
    """Set one single-line quoted frontmatter field."""

    pattern = re.compile(rf"^{re.escape(key)}\s*:\s*.*$")
    rendered = f'{key}: "{value}"'
    for index, line in enumerate(frontmatter):
        if pattern.match(line):
            frontmatter[index] = rendered
            return frontmatter
    frontmatter.append(rendered)
    return frontmatter


def _remove_field(frontmatter: list[str], key: str) -> list[str]:
    """Remove a single-line frontmatter field when changing lifecycle mode."""

    pattern = re.compile(rf"^{re.escape(key)}\s*:")
    return [line for line in frontmatter if not pattern.match(line)]


def rewrite_frontmatter(
    text: str,
    updates: dict[str, str],
    *,
    remove: tuple[str, ...] = (),
) -> str:
    """Render fully validated frontmatter updates in memory."""

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SystemExit("refusing to archive: document is missing frontmatter")
    end_index: int | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = index
            break
    if end_index is None:
        raise SystemExit("refusing to archive: unterminated frontmatter")

    frontmatter = lines[1:end_index]
    for key in remove:
        frontmatter = _remove_field(frontmatter, key)
    for key, value in updates.items():
        frontmatter = _set_field(frontmatter, key, value)
    rendered = "\n".join(
        ["---", *frontmatter, "---", *lines[end_index + 1 :]]
    )
    return rendered + ("\n" if text.endswith(("\n", "\r")) else "")


def _split_relationships(value: str) -> list[str]:
    """Split comma-separated repository-relative relationship paths."""

    return [item.strip() for item in value.split(",") if item.strip()]


def _render_relationships(values: list[str]) -> str:
    """Render unique relationship paths while preserving meaningful order."""

    return ", ".join(dict.fromkeys(values))


def _replace_relationship(value: str, old: str, new: str) -> str:
    """Replace one exact relationship target and require it to exist."""

    values = _split_relationships(value)
    if old not in values:
        raise SystemExit(
            f"refusing inconsistent Runbook lineage: expected reverse link to {old}"
        )
    return _render_relationships(
        [new if item == old else item for item in values]
    )


def _append_or_replace_relationship(value: str, old: str, new: str) -> str:
    """Replace a predeclared old path or append the newly archived path."""

    values = _split_relationships(value)
    if old in values:
        values = [new if item == old else item for item in values]
    elif new not in values:
        values.append(new)
    return _render_relationships(values)


def _load_runbook(
    root: Path, path: Path, *, active: bool
) -> tuple[str, dict[str, str]]:
    """Load and validate a Runbook at an expected lifecycle location."""

    expected_dir = RUNBOOK_ACTIVE_DIR if active else RUNBOOK_ARCHIVE_DIR
    if not _is_under(root, path, expected_dir):
        raise SystemExit(
            f"refusing Runbook operation: {_relative(root, path)} is not under {expected_dir}/"
        )
    text = path.read_text(encoding="utf-8")
    fields = _frontmatter(text, _relative(root, path))
    expected_status = "active" if active else "archived"
    if fields.get("status") != expected_status:
        raise SystemExit(
            f"refusing Runbook operation: {_relative(root, path)} must set status: {expected_status}"
        )
    if fields.get("document_type") != "runbook":
        raise SystemExit(
            f"refusing Runbook operation: {_relative(root, path)} must set document_type: runbook"
        )
    return text, fields


def _archive_target(root: Path, source: Path, archive_date: str) -> Path:
    """Build a dated, non-overwriting Runbook archive target."""

    target = root / RUNBOOK_ARCHIVE_DIR / f"{archive_date}-{source.name}"
    if target.exists():
        raise SystemExit(
            f"refusing to overwrite existing archive target: {target}"
        )
    return target


def _predecessor_writes(
    root: Path,
    source_relative: str,
    archive_relative: str,
    source_fields: dict[str, str],
) -> list[PlannedWrite]:
    """Retarget direct predecessors when the active path moves into archive."""

    writes: list[PlannedWrite] = []
    for predecessor_value in _split_relationships(
        source_fields.get("supersedes", "")
    ):
        predecessor, normalized = _normalize_docs_target(root, predecessor_value)
        text, fields = _load_runbook(root, predecessor, active=False)
        replacement = _replace_relationship(
            fields.get("superseded_by", ""),
            source_relative,
            archive_relative,
        )
        updated = rewrite_frontmatter(text, {"superseded_by": replacement})
        writes.append(
            PlannedWrite(
                predecessor,
                updated,
                stat.S_IMODE(predecessor.stat().st_mode),
            )
        )
        if normalized != predecessor_value:
            raise SystemExit(
                "refusing non-canonical Runbook lineage; use repository-relative docs/ paths"
            )
    return writes


def _write_atomic(path: Path, content: bytes, mode: int) -> None:
    """Replace one file from a same-directory fsynced temporary file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def apply_transaction(writes: list[PlannedWrite], removals: list[Path]) -> None:
    """Apply validated writes and compensate ordinary process-level failures."""

    paths = {write.path for write in writes} | set(removals)
    originals: dict[Path, tuple[bytes, int] | None] = {}
    for path in paths:
        if path.exists():
            originals[path] = (
                path.read_bytes(),
                stat.S_IMODE(path.stat().st_mode),
            )
        else:
            originals[path] = None

    try:
        for write in writes:
            _write_atomic(write.path, write.text.encode("utf-8"), write.mode)
        for path in removals:
            path.unlink()
    except OSError as exc:
        rollback_errors: list[str] = []
        for path, original in originals.items():
            try:
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    _write_atomic(path, original[0], original[1])
            except OSError as rollback_exc:
                rollback_errors.append(f"{path}: {rollback_exc}")
        detail = f"archive transaction failed and was compensated: {exc}"
        if rollback_errors:
            detail += "; manual recovery required for " + "; ".join(
                rollback_errors
            )
        raise SystemExit(detail) from exc


def _print_plan(
    root: Path,
    source: Path,
    destination: Path,
    writes: list[PlannedWrite],
    *,
    move_source: bool,
    dry_run: bool,
    invalidated_active: list[Path] | None = None,
) -> None:
    """Print every affected path and the explicit reseal boundary."""

    action = "move" if move_source else "snapshot"
    print(f"will {action}: {_relative(root, source)}")
    print(f"          -> {_relative(root, destination)}")
    for write in writes:
        print(f"will write: {_relative(root, write.path)}")
        fields, _, _ = parse_frontmatter_text(write.text)
        for key in (
            "status",
            "supersedes",
            "superseded_by",
            "archive_reason",
        ):
            if key in fields:
                print(f"  {key}: {fields[key]}")
    if invalidated_active:
        for path in invalidated_active:
            print(
                "NOTICE: active Runbook lineage changed and its seal is now invalid: "
                f"{_relative(root, path)}"
            )
        print(
            "Reconcile and explicitly run runbook.py seal --confirm-reconciled --apply; "
            "the archive tool never reseals automatically."
        )
    if dry_run:
        print("(dry-run; no changes applied)")


def archive_spec_or_plan(
    root: Path, source: Path, args: argparse.Namespace
) -> int:
    """Preserve the existing closed Spec/Plan archive behavior safely."""

    if (
        args.snapshot
        or args.retire
        or args.reason is not None
        or args.archive_date is not None
    ):
        raise SystemExit(
            "--snapshot, --retire, --reason, and --archive-date are Runbook-only options"
        )
    relative = _relative(root, source)
    if relative.startswith("docs/adr/"):
        raise SystemExit(
            "refusing to archive ADR: supersede it in place under docs/adr/"
        )
    destination: Path | None = None
    for active_prefix, archive_prefix in ACTIVE_TO_ARCHIVE.items():
        if relative.startswith(active_prefix + "/"):
            destination = root / relative.replace(active_prefix, archive_prefix, 1)
            break
    if destination is None:
        raise SystemExit(
            f"refusing to archive: {relative} is not under "
            f"{', '.join(ACTIVE_TO_ARCHIVE.keys())}"
        )
    if destination.exists():
        raise SystemExit(
            f"refusing to overwrite existing archive target: {destination}"
        )

    successor: str | None = None
    if args.superseded_by is not None:
        _, successor = _normalize_docs_target(root, args.superseded_by)
    text = source.read_text(encoding="utf-8")
    updates = {"status": "archived"}
    if successor is not None:
        updates["superseded_by"] = successor
    archived = rewrite_frontmatter(text, updates)
    writes = [
        PlannedWrite(
            destination, archived, stat.S_IMODE(source.stat().st_mode)
        )
    ]
    _print_plan(
        root,
        source,
        destination,
        writes,
        move_source=True,
        dry_run=args.dry_run,
    )
    if not args.dry_run:
        apply_transaction(writes, [source])
        print("archived.")
    return 0


def archive_runbook(
    root: Path, source: Path, args: argparse.Namespace
) -> int:
    """Plan and apply one explicit Runbook lifecycle transition."""

    selected_modes = (
        int(args.snapshot)
        + int(args.retire)
        + int(args.superseded_by is not None)
    )
    if selected_modes != 1:
        raise SystemExit(
            "Runbook archive requires exactly one of --snapshot, --superseded-by, or --retire"
        )
    archive_date = _validate_archive_date(args.archive_date)
    if args.retire:
        if args.reason is None:
            raise SystemExit("--retire requires --reason TEXT")
        reason = _safe_scalar(args.reason, "--reason")
    elif args.reason is not None:
        raise SystemExit("--reason is only valid with --retire")
    else:
        reason = ""

    source_text, source_fields = _load_runbook(root, source, active=True)
    if source_fields.get("superseded_by"):
        raise SystemExit(
            "refusing Runbook operation: active source already names a successor"
        )
    source_relative = _relative(root, source)
    destination = _archive_target(root, source, archive_date)
    destination_relative = _relative(root, destination)
    source_mode = stat.S_IMODE(source.stat().st_mode)
    predecessor_writes = _predecessor_writes(
        root, source_relative, destination_relative, source_fields
    )

    writes = list(predecessor_writes)
    removals: list[Path] = []
    invalidated_active: list[Path] = []
    if args.snapshot:
        archived = rewrite_frontmatter(
            source_text,
            {"status": "archived", "superseded_by": source_relative},
            remove=("archive_reason",),
        )
        active = rewrite_frontmatter(
            source_text,
            {"supersedes": destination_relative, "superseded_by": ""},
            remove=("archive_reason",),
        )
        writes.extend(
            [
                PlannedWrite(destination, archived, source_mode),
                PlannedWrite(source, active, source_mode),
            ]
        )
        invalidated_active.append(source)
    elif args.superseded_by is not None:
        successor, successor_relative = _normalize_docs_target(
            root, args.superseded_by
        )
        if successor == source:
            raise SystemExit("a Runbook cannot supersede itself")
        successor_text, successor_fields = _load_runbook(
            root, successor, active=True
        )
        successor_audit = audit_active_runbook(root, successor)
        if successor_audit.findings:
            raise SystemExit(
                "refusing invalid active Runbook successor: "
                + successor_audit.findings[0].message
            )
        if successor_fields.get("superseded_by"):
            raise SystemExit(
                "refusing invalid active Runbook successor: it already names a successor"
            )
        successor_lineage = _append_or_replace_relationship(
            successor_fields.get("supersedes", ""),
            source_relative,
            destination_relative,
        )
        archived = rewrite_frontmatter(
            source_text,
            {"status": "archived", "superseded_by": successor_relative},
            remove=("archive_reason",),
        )
        successor_updated = rewrite_frontmatter(
            successor_text, {"supersedes": successor_lineage}
        )
        writes.extend(
            [
                PlannedWrite(destination, archived, source_mode),
                PlannedWrite(
                    successor,
                    successor_updated,
                    stat.S_IMODE(successor.stat().st_mode),
                ),
            ]
        )
        removals.append(source)
        invalidated_active.append(successor)
    else:
        archived = rewrite_frontmatter(
            source_text,
            {
                "status": "archived",
                "superseded_by": "",
                "archive_reason": reason,
            },
        )
        writes.append(PlannedWrite(destination, archived, source_mode))
        removals.append(source)

    _print_plan(
        root,
        source,
        destination,
        writes,
        move_source=not args.snapshot,
        dry_run=args.dry_run,
        invalidated_active=invalidated_active,
    )
    if not args.dry_run:
        apply_transaction(writes, removals)
        print("archived.")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Archive one governed document without leaking tracebacks."""

    args = parse_args(argv)
    root = Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit(f"project root is not a directory: {root}")
    source = resolve_doc(root, args.doc)
    if not source.is_file():
        raise SystemExit(f"document not found: {source}")
    if _is_under(root, source, RUNBOOK_ACTIVE_DIR):
        return archive_runbook(root, source, args)
    return archive_spec_or_plan(root, source, args)


if __name__ == "__main__":
    raise SystemExit(main())
