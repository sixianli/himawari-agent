#!/usr/bin/env python3
"""Validate and seal executable Runbook static contracts.

This module is both the public ``runbook.py`` CLI and the shared source of
truth used by ``validate_docs.py``.  It deliberately performs no live-system
commands: a valid static contract is only the first Runbook execution gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

HASH_DOMAIN = b"document-governance/runbook-contract/v1\0"
HASH_SENTINEL = "sha256:<runbook-contract>"
HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
PROVISIONAL_HASHES = {"", "sha256:<64-hex>"}
VALID_EXECUTION_RISKS = ("standard", "high", "critical")
RISK_ORDER = {risk: index for index, risk in enumerate(VALID_EXECUTION_RISKS)}
REQUIRED_SECTIONS = (
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
)
CONTRACT_START = "<!-- runbook-contract:"
CONTRACT_PATTERN = re.compile(
    r"<!-- runbook-contract:\s*\n(?P<body>.*?)\n-->",
    re.DOTALL,
)
FRONTMATTER_FIELD_PATTERN = re.compile(
    r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$"
)
CONTRACT_HASH_LINE_PATTERN = re.compile(
    r"^contract_sha256:\s*.*$", re.MULTILINE
)

# These names are never contract inputs.  Selecting one explicitly is an
# error; when one appears below a selected source directory it is ignored so
# local caches and build products cannot make a clean source contract
# machine-dependent.
EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "evidence",
    "evidence-runs",
    "htmlcov",
    "node_modules",
    "run-evidence",
    "target",
}
EXCLUDED_CACHE_FILE_NAMES = {".coverage", ".ds_store"}
SECRET_FILE_NAMES = {
    "credentials.json",
    "secrets.json",
}
SECRET_SUFFIXES = {".jks", ".key", ".p12", ".pem", ".pfx"}
SECRET_EXACT_NAMES = {"id_dsa", "id_ed25519", "id_ecdsa", "id_rsa"}
ALLOWED_ENV_SUFFIXES = (".example", ".sample", ".template")

FindingKind = Literal["migration", "error"]
Risk = Literal["standard", "high", "critical"]
ExecutionPhase = Literal["preflight", "mutation"]


class RunbookContractError(ValueError):
    """Raised when a Runbook contract cannot be safely fingerprinted."""


@dataclass(frozen=True)
class Finding:
    """One reusable Runbook validation finding."""

    code: str
    message: str
    kind: FindingKind


@dataclass(frozen=True)
class ContractRecord:
    """One normalized object included in the versioned fingerprint."""

    path: str
    object_type: str
    executable: bool
    payload: bytes

    def summary(self) -> dict[str, object]:
        """Return a non-secret, JSON-safe description of the record."""

        result: dict[str, object] = {
            "path": self.path,
            "type": self.object_type,
            "executable": self.executable,
        }
        if self.object_type == "symlink":
            result["target"] = self.payload.decode("utf-8", errors="replace")
        elif self.object_type == "file":
            result["bytes"] = len(self.payload)
        return result


@dataclass(frozen=True)
class ContractResult:
    """Fingerprint plus the normalized inputs used to calculate it."""

    fingerprint: str
    runbook_path: str
    contract_paths: tuple[str, ...]
    records: tuple[ContractRecord, ...]


@dataclass(frozen=True)
class RunbookAudit:
    """Reusable result for validator, check, and seal callers."""

    fields: dict[str, str]
    body: str
    findings: tuple[Finding, ...]
    contract: ContractResult | None


@dataclass(frozen=True)
class ExecutionGate:
    """Pure policy result for an execution phase.

    The CLI does not execute this gate.  Agents apply it after classifying the
    actual commands and live target during the per-execution preflight.
    """

    effective_risk: Risk
    phase: ExecutionPhase
    authorization: str


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the public Runbook CLI."""

    parser = argparse.ArgumentParser(
        description="Check or seal a governed Runbook static contract."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("check", "seal"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("root", help="Target project root.")
        subparser.add_argument(
            "runbook", help="Active Runbook path, repository-relative or absolute."
        )
        subparser.add_argument(
            "--format",
            choices=("text", "json"),
            default="text",
            help="Output format.",
        )

    seal_parser = subparsers.choices["seal"]
    seal_parser.add_argument(
        "--confirm-reconciled",
        action="store_true",
        help="Confirm semantic reconciliation and relevant tests are complete.",
    )
    seal_parser.add_argument(
        "--apply",
        action="store_true",
        help="Write only the calculated contract_sha256 value.",
    )
    return parser.parse_args(argv)


def _parse_scalar(value: str) -> str:
    """Parse the governance subset of single-line YAML scalars."""

    value = value.strip()
    quoted = re.match(r"^([\"'])(.*?)\1(?:\s+#.*)?$", value)
    if quoted:
        return quoted.group(2)
    return re.sub(r"\s+#.*$", "", value).strip()


def parse_frontmatter_text(text: str) -> tuple[dict[str, str], str, list[str]]:
    """Parse the governance subset of frontmatter without external YAML."""

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text, ["missing frontmatter"]

    end_index: int | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = index
            break
    if end_index is None:
        return {}, text, ["unterminated frontmatter"]

    fields: dict[str, str] = {}
    problems: list[str] = []
    for index, line in enumerate(lines[1:end_index], start=2):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line[:1].isspace() or stripped.startswith("-"):
            problems.append(
                f"unsupported nested or multiline frontmatter at line {index}"
            )
            continue
        match = FRONTMATTER_FIELD_PATTERN.fullmatch(line)
        if not match:
            problems.append(f"malformed frontmatter at line {index}")
            continue
        key, raw_value = match.groups()
        if key in fields:
            problems.append(f"duplicate frontmatter field {key!r} at line {index}")
            continue
        if raw_value.strip() in {"|", ">", "|-", "|+", ">-", ">+"} or raw_value.strip().startswith(
            ("[", "{")
        ):
            problems.append(
                f"unsupported nested, array, or multiline value for {key!r} at line {index}"
            )
            continue
        fields[key] = _parse_scalar(raw_value)

    body = "\n".join(lines[end_index + 1 :])
    return fields, body, problems


def _is_within(path: Path, root: Path) -> bool:
    """Return whether a resolved path stays within a resolved root."""

    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def resolve_runbook(root: Path, runbook: str | Path) -> Path:
    """Resolve a Runbook and reject project-root escape."""

    candidate = Path(runbook)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    if not _is_within(candidate, root):
        raise RunbookContractError(
            f"Runbook is outside project root: {candidate}"
        )
    if not candidate.is_file():
        raise RunbookContractError(f"Runbook not found: {candidate}")
    return candidate


def _normalized_repo_path(root: Path, path: Path) -> str:
    """Return a stable POSIX path within root."""

    return path.relative_to(root).as_posix()


def _is_secret_path(relative: Path) -> bool:
    """Conservatively identify actual credential material."""

    name = relative.name.lower()
    if name == ".env":
        return True
    if name.startswith(".env.") and not name.endswith(ALLOWED_ENV_SUFFIXES):
        return True
    if name in SECRET_FILE_NAMES or name in SECRET_EXACT_NAMES:
        return True
    return relative.suffix.lower() in SECRET_SUFFIXES


def _explicit_path_problem(relative: Path) -> str | None:
    """Return why a selected contract path is unsafe, if applicable."""

    if relative.as_posix() in {"", "."}:
        return "repository root is too broad for a safe Runbook contract"
    lowered_parts = {part.lower() for part in relative.parts}
    excluded = lowered_parts & EXCLUDED_DIRECTORY_NAMES
    if excluded:
        return f"path selects excluded cache, build, VCS, or evidence scope: {min(excluded)}"
    if _is_secret_path(relative):
        return "path selects real secret or credential material"
    return None


def parse_contract_paths(body: str) -> tuple[tuple[str, ...], list[Finding]]:
    """Parse exactly one runbook-contract block."""

    structural_body = _without_fenced_code(body)
    matches = list(CONTRACT_PATTERN.finditer(structural_body))
    starts = structural_body.count(CONTRACT_START)
    if starts == 0:
        return (), [
            Finding(
                "missing-contract-block",
                "missing runbook-contract block",
                "migration",
            )
        ]
    if starts != 1 or len(matches) != 1:
        return (), [
            Finding(
                "invalid-contract-block-count",
                "Runbook must contain exactly one well-formed runbook-contract block",
                "error",
            )
        ]

    paths: list[str] = []
    findings: list[Finding] = []
    for line_number, raw_line in enumerate(
        matches[0].group("body").splitlines(), start=1
    ):
        stripped = raw_line.strip()
        if not stripped:
            continue
        match = re.fullmatch(r"-\s+(.+?)\s*", stripped)
        if not match:
            findings.append(
                Finding(
                    "malformed-contract-entry",
                    f"malformed runbook-contract entry at block line {line_number}",
                    "error",
                )
            )
            continue
        value = match.group(1)
        if "\x00" in value:
            findings.append(
                Finding(
                    "invalid-contract-entry",
                    "runbook-contract path contains a NUL byte",
                    "error",
                )
            )
            continue
        paths.append(value)

    if not paths:
        findings.append(
            Finding(
                "empty-contract-block",
                "runbook-contract block must list at least one repository path",
                "error",
            )
        )
    duplicates = sorted({value for value in paths if paths.count(value) > 1})
    if duplicates:
        findings.append(
            Finding(
                "duplicate-contract-entry",
                f"duplicate runbook-contract path: {duplicates[0]}",
                "error",
            )
        )
    return tuple(paths), findings


def _validate_selector(root: Path, value: str) -> tuple[Path, Path]:
    """Validate one repository-relative contract selector."""

    if "\\" in value or re.match(r"^[A-Za-z]:", value):
        raise RunbookContractError(
            f"contract path must use repository-relative POSIX syntax: {value}"
        )
    raw = Path(value)
    if raw.is_absolute():
        raise RunbookContractError(
            f"contract path must be repository-relative: {value}"
        )
    if ".." in raw.parts:
        raise RunbookContractError(
            f"contract path must not traverse '..': {value}"
        )
    normalized = Path(os.path.normpath(value))
    problem = _explicit_path_problem(normalized)
    if problem:
        raise RunbookContractError(f"unsafe contract path {value!r}: {problem}")

    lexical = root / normalized
    try:
        lexical.lstat()
    except FileNotFoundError as exc:
        raise RunbookContractError(
            f"contract path does not exist: {value}"
        ) from exc
    resolved = lexical.resolve(strict=True)
    if not _is_within(resolved, root):
        raise RunbookContractError(
            f"contract path escapes project root through symlink: {value}"
        )
    return lexical, normalized


def _record_for_path(root: Path, path: Path, logical: Path) -> ContractRecord:
    """Create a normalized record without following symbolic links."""

    mode = path.lstat().st_mode
    executable = bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
    relative = logical.as_posix()
    if stat.S_ISLNK(mode):
        target = os.readlink(path)
        target_path = Path(target)
        if target_path.is_absolute():
            raise RunbookContractError(
                f"contract symlink target must be repository-relative: {relative} -> {target}"
            )
        resolved = path.resolve(strict=True)
        if not _is_within(resolved, root):
            raise RunbookContractError(
                f"contract symlink escapes project root: {relative} -> {target}"
            )
        return ContractRecord(relative, "symlink", executable, target.encode("utf-8"))
    if stat.S_ISREG(mode):
        if _is_secret_path(logical):
            raise RunbookContractError(
                f"contract contains real secret or credential material: {relative}"
            )
        return ContractRecord(relative, "file", executable, path.read_bytes())
    if stat.S_ISDIR(mode):
        return ContractRecord(relative, "directory", executable, b"")
    raise RunbookContractError(
        f"unsupported contract object type (only file, directory, symlink): {relative}"
    )


def _walk_contract_path(
    root: Path, path: Path, logical: Path
) -> list[ContractRecord]:
    """Walk one selector deterministically without following symlink dirs."""

    first = _record_for_path(root, path, logical)
    records = [first]
    if first.object_type != "directory":
        return records

    children = sorted(path.iterdir(), key=lambda item: item.name.encode("utf-8"))
    for child in children:
        child_logical = logical / child.name
        if child.name.lower() in EXCLUDED_DIRECTORY_NAMES:
            continue
        if child.name.lower() in EXCLUDED_CACHE_FILE_NAMES:
            continue
        records.extend(_walk_contract_path(root, child, child_logical))
    return records


def _replace_frontmatter_hash(text: str, value: str) -> str:
    """Replace the unique hash field only inside the opening frontmatter."""

    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise RunbookContractError("Runbook is missing frontmatter")
    end_index: int | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = index
            break
    if end_index is None:
        raise RunbookContractError("Runbook has unterminated frontmatter")
    matches = [
        index
        for index, line in enumerate(lines[1:end_index], start=1)
        if CONTRACT_HASH_LINE_PATTERN.fullmatch(line.rstrip("\r\n"))
    ]
    if len(matches) != 1:
        raise RunbookContractError(
            "frontmatter must contain exactly one contract_sha256 field before sealing"
        )
    index = matches[0]
    newline = "\r\n" if lines[index].endswith("\r\n") else (
        "\n" if lines[index].endswith("\n") else ""
    )
    lines[index] = f'contract_sha256: "{value}"{newline}'
    return "".join(lines)


def normalize_runbook_content(text: str) -> bytes:
    """Normalize newlines and replace the self-referential hash value."""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _replace_frontmatter_hash(normalized, HASH_SENTINEL)
    return normalized.encode("utf-8")


def _feed_field(hasher: hashlib._Hash, value: bytes) -> None:
    """Feed a length-framed field to avoid concatenation ambiguity."""

    hasher.update(len(value).to_bytes(8, "big"))
    hasher.update(value)


def _feed_record(hasher: hashlib._Hash, record: ContractRecord) -> None:
    """Feed one canonical record into the versioned digest."""

    _feed_field(hasher, record.path.encode("utf-8"))
    _feed_field(hasher, record.object_type.encode("ascii"))
    _feed_field(hasher, b"1" if record.executable else b"0")
    _feed_field(hasher, record.payload)


def compute_contract_fingerprint(
    root: Path, runbook_path: Path, text: str | None = None
) -> ContractResult:
    """Compute the versioned deterministic Runbook contract fingerprint."""

    root = root.resolve()
    runbook_path = runbook_path.resolve()
    if not _is_within(runbook_path, root):
        raise RunbookContractError("Runbook is outside project root")
    if text is None:
        text = runbook_path.read_text(encoding="utf-8")
    _, body, problems = parse_frontmatter_text(text)
    if problems:
        raise RunbookContractError(problems[0])
    contract_paths, findings = parse_contract_paths(body)
    errors = [finding.message for finding in findings if finding.kind == "error"]
    if errors:
        raise RunbookContractError(errors[0])
    if not contract_paths:
        raise RunbookContractError("missing runbook-contract block")

    record_map: dict[tuple[str, str], ContractRecord] = {}
    for value in sorted(contract_paths, key=lambda item: item.encode("utf-8")):
        lexical, logical = _validate_selector(root, value)
        for record in _walk_contract_path(root, lexical, logical):
            record_map[(record.path, record.object_type)] = record
    records = tuple(
        record_map[key]
        for key in sorted(
            record_map,
            key=lambda item: (item[0].encode("utf-8"), item[1]),
        )
    )

    runbook_relative = _normalized_repo_path(root, runbook_path)
    runbook_mode = runbook_path.stat().st_mode
    runbook_record = ContractRecord(
        runbook_relative,
        "runbook",
        bool(runbook_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)),
        normalize_runbook_content(text),
    )
    hasher = hashlib.sha256()
    hasher.update(HASH_DOMAIN)
    _feed_record(hasher, runbook_record)
    for record in records:
        _feed_record(hasher, record)
    return ContractResult(
        fingerprint=f"sha256:{hasher.hexdigest()}",
        runbook_path=runbook_relative,
        contract_paths=tuple(contract_paths),
        records=records,
    )


def _without_fenced_code(body: str) -> str:
    """Blank fenced code while preserving line structure for Markdown scans."""

    output: list[str] = []
    fence_character: str | None = None
    fence_length = 0
    for line in body.splitlines():
        match = re.match(r"^\s*(`{3,}|~{3,})", line)
        if match:
            marker = match.group(1)
            if fence_character is None:
                fence_character = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length:
                fence_character = None
                fence_length = 0
            output.append("")
        elif fence_character is None:
            output.append(line)
        else:
            output.append("")
    return "\n".join(output)


def _heading_counts(body: str) -> dict[str, int]:
    """Return exact level-two heading counts outside fenced examples."""

    counts: dict[str, int] = {}
    for match in re.finditer(
        r"^##\s+(.+?)\s*$", _without_fenced_code(body), re.MULTILINE
    ):
        heading = match.group(1).strip()
        counts[heading] = counts.get(heading, 0) + 1
    return counts


def audit_active_runbook(
    root: Path,
    runbook_path: Path,
    *,
    allow_provisional_hash: bool = False,
    compare_fingerprint: bool = True,
) -> RunbookAudit:
    """Audit one active Runbook using shared migration/error semantics."""

    root = root.resolve()
    runbook_path = runbook_path.resolve()
    text = runbook_path.read_text(encoding="utf-8")
    fields, body, frontmatter_problems = parse_frontmatter_text(text)
    findings: list[Finding] = []
    for problem in frontmatter_problems:
        findings.append(Finding("frontmatter", problem, "migration"))

    active_root = (root / "docs/runbooks").resolve()
    if not _is_within(runbook_path, active_root):
        findings.append(
            Finding(
                "inactive-location",
                "executable Runbook must be under docs/runbooks/",
                "error",
            )
        )
    if fields.get("status") != "active":
        findings.append(
            Finding(
                "inactive-status",
                "Runbook under docs/runbooks/ must have status: active",
                "migration",
            )
        )
    if fields.get("document_type") != "runbook":
        findings.append(
            Finding(
                "missing-runbook-type",
                "active Runbook must set document_type: runbook",
                "migration",
            )
        )

    declared_risk = fields.get("execution_risk")
    if declared_risk is None:
        findings.append(
            Finding(
                "missing-execution-risk",
                "active Runbook is missing execution_risk",
                "migration",
            )
        )
    elif declared_risk not in VALID_EXECUTION_RISKS:
        findings.append(
            Finding(
                "invalid-execution-risk",
                f"invalid execution_risk {declared_risk!r}",
                "error",
            )
        )

    for forbidden_field in ("last_reviewed", "review_after"):
        if forbidden_field in fields:
            findings.append(
                Finding(
                    "calendar-trust-field",
                    f"Runbook must not use calendar trust field {forbidden_field}",
                    "error",
                )
            )

    declared_hash = fields.get("contract_sha256")
    if declared_hash is None:
        findings.append(
            Finding(
                "missing-contract-sha256",
                "active Runbook is missing contract_sha256",
                "migration",
            )
        )
    elif not HASH_PATTERN.fullmatch(declared_hash) and not (
        allow_provisional_hash and declared_hash in PROVISIONAL_HASHES
    ):
        findings.append(
            Finding(
                "invalid-contract-sha256",
                f"invalid contract_sha256 {declared_hash!r}",
                "error",
            )
        )

    headings = _heading_counts(body)
    for section in REQUIRED_SECTIONS:
        if section not in headings:
            findings.append(
                Finding(
                    "missing-runbook-section",
                    f"active Runbook is missing required section: {section}",
                    "migration",
                )
            )
        elif headings[section] > 1:
            findings.append(
                Finding(
                    "duplicate-runbook-section",
                    f"active Runbook has duplicate required section: {section}",
                    "error",
                )
            )
    _, contract_findings = parse_contract_paths(body)
    findings.extend(contract_findings)
    contract: ContractResult | None = None
    blocking_codes = {
        "frontmatter",
        "invalid-contract-block-count",
        "malformed-contract-entry",
        "invalid-contract-entry",
        "empty-contract-block",
        "duplicate-contract-entry",
        "missing-contract-block",
        "missing-contract-sha256",
        "inactive-location",
        "inactive-status",
    }
    if not any(finding.code in blocking_codes for finding in findings):
        try:
            contract = compute_contract_fingerprint(root, runbook_path, text)
        except (OSError, UnicodeError, RunbookContractError) as exc:
            findings.append(
                Finding("unsafe-contract", str(exc), "error")
            )
        else:
            if (
                compare_fingerprint
                and declared_hash is not None
                and HASH_PATTERN.fullmatch(declared_hash)
                and declared_hash != contract.fingerprint
            ):
                findings.append(
                    Finding(
                        "contract-mismatch",
                        "contract_sha256 does not match the current Runbook and contract sources",
                        "error",
                    )
                )
    return RunbookAudit(fields, body, tuple(findings), contract)


def effective_execution_risk(
    declared: str, command_risk: str, live_target_risk: str
) -> Risk:
    """Return the maximum risk, treating unknown classifications as critical."""

    values = (declared, command_risk, live_target_risk)
    if any(value not in RISK_ORDER for value in values):
        return "critical"
    return max(values, key=RISK_ORDER.__getitem__)  # type: ignore[return-value]


def execution_gate(
    declared: str,
    command_risk: str,
    live_target_risk: str,
    phase: ExecutionPhase,
) -> ExecutionGate:
    """Apply the risk floor and authorization rule at a phase boundary."""

    risk = effective_execution_risk(declared, command_risk, live_target_risk)
    if phase == "preflight":
        authorization = "read-only-preflight"
    elif risk == "critical":
        authorization = "immediate-explicit-authorization"
    elif risk == "high":
        authorization = "covering-explicit-authorization"
    else:
        authorization = "current-request-authorization"
    return ExecutionGate(risk, phase, authorization)


def replace_contract_hash(text: str, fingerprint: str) -> str:
    """Replace only the single contract_sha256 line, preserving newline style."""

    return _replace_frontmatter_hash(text, fingerprint)


def _finding_payload(path: Path, audit: RunbookAudit) -> dict[str, object]:
    """Build common machine-readable output."""

    return {
        "runbook": str(path),
        "ok": not audit.findings,
        "errors": [finding.message for finding in audit.findings],
        "static_contract_only": True,
        "notice": (
            "Static contract success does not prove Live-State Preflight and "
            "does not authorize any operation."
        ),
    }


def _emit(payload: dict[str, object], output_format: str) -> None:
    """Emit deterministic text or JSON output."""

    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    for error in payload.get("errors", []):
        print(f"ERROR: {error}", file=sys.stderr)
    rendered_runbook = payload.get("runbook", "<unresolved>")
    if payload.get("ok"):
        print(f"Runbook static contract passed: {rendered_runbook}")
    else:
        print(
            f"Runbook static contract failed: {rendered_runbook}",
            file=sys.stderr,
        )
    if payload.get("fingerprint"):
        print(f"fingerprint: {payload['fingerprint']}")
    if payload.get("mode"):
        print(f"mode: {payload['mode']}")
    print(str(payload["notice"]))


def _root_and_runbook(args: argparse.Namespace) -> tuple[Path, Path]:
    """Resolve common CLI inputs."""

    root = Path(args.root).resolve()
    if not root.is_dir():
        raise RunbookContractError(f"project root is not a directory: {root}")
    return root, resolve_runbook(root, args.runbook)


def run_check(args: argparse.Namespace) -> int:
    """Run fail-closed execution-level static validation."""

    root, path = _root_and_runbook(args)
    audit = audit_active_runbook(root, path)
    payload = _finding_payload(path, audit)
    if audit.contract is not None:
        payload["fingerprint"] = audit.contract.fingerprint
    _emit(payload, args.format)
    return 0 if payload["ok"] else 1


def run_seal(args: argparse.Namespace) -> int:
    """Calculate a fingerprint and optionally write only its frontmatter field."""

    if args.apply != args.confirm_reconciled:
        raise RunbookContractError(
            "writing a seal requires both --confirm-reconciled and --apply"
        )
    root, path = _root_and_runbook(args)
    audit = audit_active_runbook(
        root,
        path,
        allow_provisional_hash=True,
        compare_fingerprint=False,
    )
    if audit.findings:
        payload = _finding_payload(path, audit)
        payload["mode"] = "apply" if args.apply else "dry-run"
        _emit(payload, args.format)
        return 1
    assert audit.contract is not None

    payload = _finding_payload(path, audit)
    payload.update(
        {
            "ok": True,
            "mode": "apply" if args.apply else "dry-run",
            "fingerprint": audit.contract.fingerprint,
            "runbook_path": audit.contract.runbook_path,
            "contract_paths": list(audit.contract.contract_paths),
            "records": [record.summary() for record in audit.contract.records],
        }
    )
    if args.apply:
        before = path.read_text(encoding="utf-8")
        fresh = audit_active_runbook(
            root,
            path,
            allow_provisional_hash=True,
            compare_fingerprint=False,
        )
        if fresh.findings or fresh.contract is None:
            payload["ok"] = False
            payload["errors"] = [
                "Runbook changed or became invalid before seal write",
                *[finding.message for finding in fresh.findings],
            ]
            _emit(payload, args.format)
            return 1
        if path.read_text(encoding="utf-8") != before:
            payload["ok"] = False
            payload["errors"] = [
                "Runbook changed while preparing the seal; no write applied"
            ]
            _emit(payload, args.format)
            return 1
        payload["fingerprint"] = fresh.contract.fingerprint
        after = replace_contract_hash(before, fresh.contract.fingerprint)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(after)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        verified = audit_active_runbook(root, path)
        if verified.findings:
            path.write_text(before, encoding="utf-8")
            payload["ok"] = False
            payload["errors"] = [
                "post-write verification failed; original Runbook restored",
                *[finding.message for finding in verified.findings],
            ]
        else:
            payload["applied"] = True
    _emit(payload, args.format)
    return 0 if payload["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    """Run the CLI without leaking tracebacks for user input failures."""

    args = parse_args(argv)
    try:
        if args.command == "check":
            return run_check(args)
        return run_seal(args)
    except (OSError, UnicodeError, RunbookContractError) as exc:
        payload = {
            "ok": False,
            "errors": [str(exc)],
            "static_contract_only": True,
            "notice": (
                "Static contract success does not prove Live-State Preflight and "
                "does not authorize any operation."
            ),
        }
        _emit(payload, args.format)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
