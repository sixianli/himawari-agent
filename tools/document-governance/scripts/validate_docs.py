#!/usr/bin/env python3
"""验证项目文档是否符合 document-governance SOP。

详细规则参见 references/validation-rules.md。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

from idea_backlog import BACKLOG_HEADER_FIELDS, VALID_BACKLOG_PRIORITIES
from runbook import (
    HASH_PATTERN,
    VALID_EXECUTION_RISKS,
    audit_active_runbook,
)

REQUIRED_DIRS = [
    "docs/adr",
    "docs/execution/specs",
    "docs/execution/plans",
    "docs/archive/specs",
    "docs/archive/plans",
    "docs/archive/runbooks",
    "docs/runbooks",
]
REQUIRED_FRONTMATTER = {"status", "supersedes", "superseded_by", "date"}
VALID_STATUSES = {"active", "superseded", "archived"}
VALID_DOCUMENT_TYPES = {
    "prd",
    "architecture",
    "adr",
    "spec",
    "plan",
    "runbook",
    "idea",
    "backlog",
    "lessons",
}
VALID_DECISION_STATUSES = {"proposed", "accepted", "superseded"}
IDEA_DIR = "docs/ideas"
BACKLOG_DIR = "docs/backlog"
IDEA_ID_PATTERN = re.compile(r"^IDEA-(\d{8})-(\d{3})$")
BACKLOG_ID_PATTERN = re.compile(r"^BL-(\d{8})-(\d{3})$")
VALID_IDEA_STATES = {"captured", "promoted", "closed", "superseded"}
VALID_BACKLOG_STATES = {
    "open",
    "in_progress",
    "deferred",
    "converted",
    "done",
    "rejected",
    "superseded",
}
SOURCE_PATTERN = re.compile(r"\[SOURCE:\s*([^\]#]+)(?:#[^\]]+)?\]")
TEMPLATE_PLACEHOLDER_TOKENS = ("YYYY", "NNNN", "<", ">", "{{", "X.Y")
ARCHIVE_COMPATIBILITY = {
    "execution/specs/": "archive/specs/",
    "execution/plans/": "archive/plans/",
    "adr/": "archive/adr/",
}


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""

    parser = argparse.ArgumentParser(
        description="Validate project document governance.",
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="Target project root to validate.",
    )
    parser.add_argument(
        "--strict",
        "--ci",
        dest="strict",
        action="store_true",
        help="Promote every migration warning to an error. --ci is an alias.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format. JSON is suitable for higher-level automation.",
    )
    return parser.parse_args()


def rel_path(path: Path, root: Path) -> str:
    """返回面向输出的 POSIX 相对路径。"""

    return path.relative_to(root).as_posix()


def is_under(path: Path, root: Path, relative_dir: str) -> bool:
    """判断文件是否位于指定相对目录下。"""

    target = root / relative_dir
    try:
        path.relative_to(target)
    except ValueError:
        return False
    return True


def is_within(path: Path, directory: Path) -> bool:
    """判断解析后的路径是否仍位于指定目录。"""

    try:
        path.relative_to(directory)
    except ValueError:
        return False
    return True


def iter_markdown_files(root: Path) -> list[Path]:
    """列出 docs/ 下所有受治理的 Markdown 文档。"""

    docs = root / "docs"
    if not docs.exists():
        return []
    files: list[Path] = []
    for path in docs.rglob("*.md"):
        if not path.is_file() or is_under(path, root, "docs/templates"):
            continue
        files.append(path)
    return sorted(files)


def parse_scalar(value: str) -> str:
    """解析 SOP 支持的单行标量并移除行尾注释。"""

    value = value.strip()
    quoted = re.match(r"^([\"'])(.*?)\1(?:\s+#.*)?$", value)
    if quoted:
        return quoted.group(2)
    return re.sub(r"\s+#.*$", "", value).strip()


def read_frontmatter(path: Path) -> tuple[dict[str, str], str, list[str]]:
    """读取并校验 SOP 支持的单行 frontmatter。"""

    text = path.read_text(encoding="utf-8")
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
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)", line)
        if not match:
            problems.append(f"malformed frontmatter at line {index}")
            continue
        key, raw_value = match.groups()
        if key in fields:
            problems.append(f"duplicate frontmatter field {key!r} at line {index}")
            continue
        value = raw_value.strip()
        if value in {"|", ">", "|-", "|+", ">-", ">+"} or value.startswith(
            ("[", "{")
        ):
            problems.append(
                f"unsupported nested, array, or multiline value for {key!r} at line {index}"
            )
            continue
        fields[key] = parse_scalar(value)

    body = "\n".join(lines[end_index + 1 :])
    return fields, body, problems


def report_compat(
    message: str,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """在严格模式下把迁移警告统一升级为错误。"""

    if strict:
        errors.append(message)
    else:
        warnings.append(message)


def validate_required_dirs(
    root: Path,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """校验必需目录是否存在。"""

    for relative_dir in REQUIRED_DIRS:
        if not (root / relative_dir).is_dir():
            report_compat(
                f"missing required directory: {relative_dir}",
                strict,
                warnings,
                errors,
            )


def inferred_document_type(path: Path, root: Path) -> str | None:
    """根据受治理目录和文件名推断文档类型。"""

    relative = rel_path(path, root)
    if is_under(path, root, "docs/adr") or is_under(
        path, root, "docs/archive/adr"
    ):
        return "adr"
    if is_under(path, root, "docs/execution/specs") or is_under(
        path, root, "docs/archive/specs"
    ):
        return "spec"
    if is_under(path, root, "docs/execution/plans") or is_under(
        path, root, "docs/archive/plans"
    ):
        return "plan"
    if is_under(path, root, "docs/runbooks") or is_under(
        path, root, "docs/archive/runbooks"
    ):
        return "runbook"
    if is_under(path, root, IDEA_DIR):
        return "idea"
    if is_under(path, root, BACKLOG_DIR):
        return "backlog"
    if relative == "docs/lessons.md":
        return "lessons"
    if re.fullmatch(r"docs/prd-v[^/]+\.md", relative):
        return "prd"
    if re.fullmatch(r"docs/architecture-v[^/]+\.md", relative):
        return "architecture"
    return None


def validate_frontmatter(
    root: Path,
    path: Path,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> tuple[dict[str, str], str]:
    """校验单个 Markdown 文件的 frontmatter。"""

    fields, body, problems = read_frontmatter(path)
    relative = rel_path(path, root)
    if problems:
        for problem in problems:
            report_compat(f"{relative}: {problem}", strict, warnings, errors)
        if not fields:
            return fields, body

    missing = sorted(REQUIRED_FRONTMATTER - fields.keys())
    if missing:
        report_compat(
            f"{relative}: missing frontmatter fields: {', '.join(missing)}",
            strict,
            warnings,
            errors,
        )

    status = fields.get("status", "")
    if status and status not in VALID_STATUSES:
        errors.append(f"{relative}: invalid status {status!r}")

    in_archive = is_under(path, root, "docs/archive")
    if in_archive and status == "active":
        errors.append(f"{relative}: archived documents must not be active")
    elif in_archive and status and status != "archived":
        report_compat(
            f"{relative}: archive document is not marked archived",
            strict,
            warnings,
            errors,
        )

    in_active_execution = is_under(
        path, root, "docs/execution/specs"
    ) or is_under(path, root, "docs/execution/plans")
    if in_active_execution and status == "archived":
        errors.append(
            f"{relative}: active execution directory contains archived document"
        )
    elif in_active_execution and status == "superseded":
        report_compat(
            f"{relative}: superseded execution document should move to archive",
            strict,
            warnings,
            errors,
        )

    in_active_runbooks = is_under(path, root, "docs/runbooks")
    if in_active_runbooks and status in {"superseded", "archived"}:
        report_compat(
            f"{relative}: non-active Runbook should move to docs/archive/runbooks/",
            strict,
            warnings,
            errors,
        )

    inferred_type = inferred_document_type(path, root)
    declared_type = fields.get("document_type", "")
    if declared_type and declared_type not in VALID_DOCUMENT_TYPES:
        report_compat(
            f"{relative}: invalid document_type {declared_type!r}",
            strict,
            warnings,
            errors,
        )
    elif declared_type and inferred_type and declared_type != inferred_type:
        report_compat(
            f"{relative}: document_type {declared_type!r} conflicts with "
            f"path type {inferred_type!r}",
            strict,
            warnings,
            errors,
        )

    if inferred_type == "adr" or declared_type == "adr":
        decision_status = fields.get("decision_status", "")
        if not decision_status:
            report_compat(
                f"{relative}: ADR should include decision_status",
                strict,
                warnings,
                errors,
            )
        elif decision_status not in VALID_DECISION_STATUSES:
            report_compat(
                f"{relative}: invalid decision_status {decision_status!r}",
                strict,
                warnings,
                errors,
            )
        if decision_status == "superseded":
            if status != "superseded":
                report_compat(
                    f"{relative}: superseded ADR must set status: superseded",
                    strict,
                    warnings,
                    errors,
                )
            if not fields.get("superseded_by"):
                report_compat(
                    f"{relative}: superseded ADR must set superseded_by",
                    strict,
                    warnings,
                    errors,
                )
        elif status == "superseded":
            report_compat(
                f"{relative}: ADR with status: superseded must set decision_status: superseded",
                strict,
                warnings,
                errors,
            )

    return fields, body


def is_iso_date(value: str) -> bool:
    """判断值是否为有效的 YYYY-MM-DD 日期。"""

    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))


def validate_record_target(
    root: Path,
    path: Path,
    field_name: str,
    value: str,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> Path | None:
    """校验 Idea/Backlog 关系字段指向 docs/ 内的现有文件。"""

    if not value:
        return None
    candidate, problem = normalize_local_target(root, value)
    relative = rel_path(path, root)
    if problem:
        errors.append(f"{relative}: invalid {field_name} target {value}: {problem}")
        return None
    assert candidate is not None
    if not candidate.is_file():
        report_compat(
            f"{relative}: {field_name} target does not exist: {value}",
            strict,
            warnings,
            errors,
        )
        return None
    return candidate


def validate_structured_record(
    root: Path,
    path: Path,
    fields: dict[str, str],
    strict: bool,
    warnings: list[str],
    errors: list[str],
    seen_ids: dict[str, Path],
) -> None:
    """校验 Idea/Backlog 的路径、ID、状态转换证据和关系字段。"""

    path_kind: str | None = None
    if is_under(path, root, IDEA_DIR):
        path_kind = "idea"
    elif is_under(path, root, BACKLOG_DIR):
        path_kind = "backlog"

    declared_kind = fields.get("document_type", "")
    if path_kind is None and declared_kind not in {"idea", "backlog"}:
        return
    relative = rel_path(path, root)

    required = {"record_id", "record_state", "updated"}
    missing = sorted(key for key in required if not fields.get(key))
    if missing:
        report_compat(
            f"{relative}: missing structured record fields: {', '.join(missing)}",
            strict,
            warnings,
            errors,
        )
    if declared_kind not in {"idea", "backlog"}:
        report_compat(
            f"{relative}: invalid record document_type {declared_kind!r}",
            strict,
            warnings,
            errors,
        )
        return
    if path_kind != declared_kind:
        report_compat(
            f"{relative}: document_type {declared_kind!r} conflicts with "
            f"record path kind {path_kind!r}",
            strict,
            warnings,
            errors,
        )

    if declared_kind == "backlog":
        missing_header = sorted(BACKLOG_HEADER_FIELDS - fields.keys())
        if missing_header:
            report_compat(
                f"{relative}: missing Backlog frontmatter fields: "
                f"{', '.join(missing_header)}",
                strict,
                warnings,
                errors,
            )
        priority = fields.get("priority", "")
        if priority not in VALID_BACKLOG_PRIORITIES:
            report_compat(
                f"{relative}: invalid Backlog priority {priority!r}",
                strict,
                warnings,
                errors,
            )
        if not fields.get("item_type"):
            report_compat(
                f"{relative}: Backlog item_type must be non-empty",
                strict,
                warnings,
                errors,
            )

    record_id = fields.get("record_id", "")
    pattern = IDEA_ID_PATTERN if declared_kind == "idea" else BACKLOG_ID_PATTERN
    match = pattern.fullmatch(record_id)
    if not match:
        report_compat(
            f"{relative}: invalid record_id {record_id!r}",
            strict,
            warnings,
            errors,
        )
    else:
        if not path.name.startswith(f"{record_id}-"):
            report_compat(
                f"{relative}: filename must start with {record_id}-",
                strict,
                warnings,
                errors,
            )
        id_date = f"{match.group(1)[:4]}-{match.group(1)[4:6]}-{match.group(1)[6:]}"
        if fields.get("date") and fields.get("date") != id_date:
            report_compat(
                f"{relative}: record_id date {id_date} conflicts with date {fields.get('date')!r}",
                strict,
                warnings,
                errors,
            )
    if record_id:
        previous = seen_ids.get(record_id)
        if previous is not None and previous != path.resolve():
            report_compat(
                f"{relative}: duplicate record_id {record_id!r}; first used by {rel_path(previous, root)}",
                strict,
                warnings,
                errors,
            )
        else:
            seen_ids[record_id] = path.resolve()

    updated = fields.get("updated", "")
    if updated and not is_iso_date(updated):
        report_compat(
            f"{relative}: updated must be YYYY-MM-DD, found {updated!r}",
            strict,
            warnings,
            errors,
        )
    review_after = fields.get("review_after", "")
    if review_after and not is_iso_date(review_after):
        report_compat(
            f"{relative}: review_after must be YYYY-MM-DD, found {review_after!r}",
            strict,
            warnings,
            errors,
        )

    state = fields.get("record_state", "")
    valid_states = VALID_IDEA_STATES if declared_kind == "idea" else VALID_BACKLOG_STATES
    if state not in valid_states:
        report_compat(
            f"{relative}: invalid record_state {state!r} for {declared_kind}",
            strict,
            warnings,
            errors,
        )

    promoted_target = validate_record_target(
        root,
        path,
        "promoted_to",
        fields.get("promoted_to", ""),
        strict,
        warnings,
        errors,
    )
    if state in {"promoted", "converted"} and promoted_target is None:
        report_compat(
            f"{relative}: {state} record must set promoted_to to an existing document",
            strict,
            warnings,
            errors,
        )

    source_idea = validate_record_target(
        root,
        path,
        "source_idea",
        fields.get("source_idea", ""),
        strict,
        warnings,
        errors,
    )
    if source_idea is not None and not is_under(source_idea, root, IDEA_DIR):
        report_compat(
            f"{relative}: source_idea must point under {IDEA_DIR}",
            strict,
            warnings,
            errors,
        )

    if state == "deferred" and not (review_after or fields.get("reason")):
        report_compat(
            f"{relative}: deferred Backlog requires review_after or reason",
            strict,
            warnings,
            errors,
        )
    if state == "done" and not fields.get("result"):
        report_compat(
            f"{relative}: done Backlog requires result",
            strict,
            warnings,
            errors,
        )
    if state == "rejected" and not fields.get("reason"):
        report_compat(
            f"{relative}: rejected Backlog requires reason",
            strict,
            warnings,
            errors,
        )
    if state == "closed" and not (fields.get("result") or fields.get("reason")):
        report_compat(
            f"{relative}: closed Idea requires result or reason",
            strict,
            warnings,
            errors,
        )
    if state == "superseded":
        successor = validate_record_target(
            root,
            path,
            "superseded_by",
            fields.get("superseded_by", ""),
            strict,
            warnings,
            errors,
        )
        if successor is None:
            report_compat(
                f"{relative}: superseded record must set superseded_by",
                strict,
                warnings,
                errors,
            )
        if fields.get("status") != "superseded":
            report_compat(
                f"{relative}: superseded record must set status: superseded",
                strict,
                warnings,
                errors,
            )
    elif fields.get("status") == "superseded":
        report_compat(
            f"{relative}: status: superseded requires record_state: superseded",
            strict,
            warnings,
            errors,
        )


def validate_plan(
    root: Path,
    path: Path,
    body: str,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """检查 Plan 是否具有 Source Spec 入口。"""

    if inferred_document_type(path, root) != "plan":
        return
    if "Source Spec" not in body and "[SOURCE:" not in body:
        report_compat(
            f"{rel_path(path, root)}: plan should link to its source spec",
            strict,
            warnings,
            errors,
        )


def validate_active_runbook(
    root: Path,
    path: Path,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """Apply the shared Runbook contract rules with migration semantics."""

    if not is_under(path, root, "docs/runbooks"):
        return
    relative = rel_path(path, root)
    audit = audit_active_runbook(root, path)
    for finding in audit.findings:
        if finding.code in {"frontmatter", "inactive-status"}:
            # Generic frontmatter and directory lifecycle checks above own
            # these messages; the shared audit still enforces them for check.
            continue
        message = f"{relative}: {finding.message}"
        if finding.kind == "error":
            errors.append(message)
        else:
            report_compat(message, strict, warnings, errors)


def validate_archived_runbook(
    root: Path,
    path: Path,
    fields: dict[str, str],
    errors: list[str],
) -> None:
    """Validate declared archive fields without recomputing historical hashes."""

    if not is_under(path, root, "docs/archive/runbooks"):
        return
    relative = rel_path(path, root)
    risk = fields.get("execution_risk")
    if risk is not None and risk not in VALID_EXECUTION_RISKS:
        errors.append(f"{relative}: invalid execution_risk {risk!r}")
    contract_hash = fields.get("contract_sha256")
    if contract_hash is not None and not HASH_PATTERN.fullmatch(contract_hash):
        errors.append(f"{relative}: invalid contract_sha256 {contract_hash!r}")


def normalize_local_target(root: Path, target: str) -> tuple[Path | None, str | None]:
    """把本地引用解析到 docs/ 内，并返回路径边界错误。"""

    raw_path = Path(target)
    if raw_path.is_absolute():
        return None, "local target must be repository-relative"
    if ".." in raw_path.parts:
        return None, "local target must not contain '..' traversal"

    normalized = raw_path.as_posix()
    if normalized == "docs":
        relative = Path()
    elif normalized.startswith("docs/"):
        relative = Path(normalized[len("docs/") :])
    else:
        relative = raw_path

    docs_root = (root / "docs").resolve()
    candidate = (docs_root / relative).resolve()
    if not is_within(candidate, docs_root):
        return None, "local target resolves outside the project docs directory"
    return candidate, None


def source_target_result(root: Path, target: str) -> tuple[str, str]:
    """返回 SOURCE 目标的状态：ok、invalid 或 missing。"""

    candidate, problem = normalize_local_target(root, target)
    if problem:
        return "invalid", problem
    assert candidate is not None

    if any(token in target for token in TEMPLATE_PLACEHOLDER_TOKENS):
        return "ok", ""
    if candidate.is_file():
        return "ok", ""

    docs_root = (root / "docs").resolve()

    def safe_docs_file(path: Path) -> bool:
        """Accept compatibility targets only when they still resolve inside docs/."""

        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):
            return False
        return is_within(resolved, docs_root) and resolved.is_file()

    relative = candidate.relative_to(docs_root).as_posix()
    for active_prefix, archive_prefix in ARCHIVE_COMPATIBILITY.items():
        if relative.startswith(active_prefix):
            archived = docs_root / relative.replace(
                active_prefix, archive_prefix, 1
            )
            if safe_docs_file(archived):
                return "ok", ""
    if relative.startswith("runbooks/"):
        basename = Path(relative).name
        archive_root = docs_root / "archive/runbooks"
        legacy = archive_root / basename
        if safe_docs_file(legacy):
            return "ok", ""
        dated_matches = sorted(archive_root.glob(f"????-??-??-{basename}"))
        dated_files = [path for path in dated_matches if safe_docs_file(path)]
        if len(dated_files) == 1:
            return "ok", ""
        if len(dated_files) > 1:
            return (
                "missing",
                f"ambiguous archived Runbook SOURCE target {target}; update it to an exact archive path",
            )
    return "missing", f"missing SOURCE target {target}"


def validate_source_links(
    root: Path,
    path: Path,
    body: str,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """校验本地 SOURCE 引用的边界与存在性。"""

    relative = rel_path(path, root)
    for match in SOURCE_PATTERN.finditer(body):
        target = match.group(1).strip()
        if target.startswith(("http://", "https://")):
            continue
        result, detail = source_target_result(root, target)
        if result == "invalid":
            errors.append(f"{relative}: invalid SOURCE target {target}: {detail}")
        elif result == "missing":
            report_compat(
                f"{relative}: {detail}",
                strict,
                warnings,
                errors,
            )


def split_relationships(value: str) -> list[str]:
    """拆分逗号分隔的 supersession 路径。"""

    return [item.strip() for item in value.split(",") if item.strip()]


def resolved_relationships(
    root: Path,
    owner: Path,
    field_name: str,
    value: str,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> list[Path]:
    """解析 ADR 关系字段并报告无效或缺失的目标。"""

    resolved: list[Path] = []
    for target in split_relationships(value):
        candidate, problem = normalize_local_target(root, target)
        prefix = f"{rel_path(owner, root)}: {field_name} target {target}"
        if problem:
            errors.append(f"{prefix} is invalid: {problem}")
            continue
        assert candidate is not None
        if not candidate.is_file():
            report_compat(
                f"{prefix} does not exist",
                strict,
                warnings,
                errors,
            )
            continue
        resolved.append(candidate)
    return resolved


def validate_adr_relationships(
    root: Path,
    documents: dict[Path, dict[str, str]],
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """校验 ADR supersedes/superseded_by 双向关系。"""

    for path, fields in documents.items():
        if inferred_document_type(path, root) != "adr" and fields.get(
            "document_type"
        ) != "adr":
            continue

        owner_relative = rel_path(path, root)

        old_targets = resolved_relationships(
            root,
            path,
            "supersedes",
            fields.get("supersedes", ""),
            strict,
            warnings,
            errors,
        )
        new_targets = resolved_relationships(
            root,
            path,
            "superseded_by",
            fields.get("superseded_by", ""),
            strict,
            warnings,
            errors,
        )

        for old_path in old_targets:
            old_fields = documents.get(old_path)
            if old_fields is None:
                continue
            if inferred_document_type(old_path, root) != "adr" and old_fields.get(
                "document_type"
            ) != "adr":
                old_relative = rel_path(old_path, root)
                report_compat(
                    f"{owner_relative}: supersedes target {old_relative} "
                    "is not an ADR",
                    strict,
                    warnings,
                    errors,
                )
                continue
            if fields.get("decision_status") == "proposed":
                continue
            reverse = resolved_relationships(
                root,
                old_path,
                "superseded_by",
                old_fields.get("superseded_by", ""),
                strict,
                warnings,
                errors,
            )
            if path not in reverse:
                old_relative = rel_path(old_path, root)
                report_compat(
                    f"{owner_relative}: supersedes link is not reciprocated "
                    f"by {old_relative}",
                    strict,
                    warnings,
                    errors,
                )
            if old_fields.get("status") != "superseded" or old_fields.get(
                "decision_status"
            ) != "superseded":
                old_relative = rel_path(old_path, root)
                report_compat(
                    f"{owner_relative}: accepted replacement requires "
                    f"{old_relative} to be superseded",
                    strict,
                    warnings,
                    errors,
                )

        for new_path in new_targets:
            new_fields = documents.get(new_path)
            if new_fields is None:
                continue
            if inferred_document_type(new_path, root) != "adr" and new_fields.get(
                "document_type"
            ) != "adr":
                new_relative = rel_path(new_path, root)
                report_compat(
                    f"{owner_relative}: superseded_by target {new_relative} "
                    "is not an ADR",
                    strict,
                    warnings,
                    errors,
                )
                continue
            reverse = resolved_relationships(
                root,
                new_path,
                "supersedes",
                new_fields.get("supersedes", ""),
                strict,
                warnings,
                errors,
            )
            if path not in reverse:
                new_relative = rel_path(new_path, root)
                report_compat(
                    f"{owner_relative}: superseded_by link is not reciprocated "
                    f"by {new_relative}",
                    strict,
                    warnings,
                    errors,
                )
            if new_fields.get("status") != "active" or new_fields.get(
                "decision_status"
            ) != "accepted":
                new_relative = rel_path(new_path, root)
                report_compat(
                    f"{owner_relative}: superseding ADR {new_relative} must "
                    "be active and accepted",
                    strict,
                    warnings,
                    errors,
                )


def _is_runbook_document(
    root: Path, path: Path, fields: dict[str, str]
) -> bool:
    """Return whether path or frontmatter identifies a Runbook."""

    return (
        inferred_document_type(path, root) == "runbook"
        or fields.get("document_type") == "runbook"
    )


def validate_runbook_relationships(
    root: Path,
    documents: dict[Path, dict[str, str]],
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """Validate active/archive Runbook placement and reciprocal lineage."""

    for path, fields in documents.items():
        if not _is_runbook_document(root, path, fields):
            continue
        owner_relative = rel_path(path, root)
        in_archive = is_under(path, root, "docs/archive/runbooks")
        if in_archive and fields.get("document_type") != "runbook":
            report_compat(
                f"{owner_relative}: archived Runbook should set document_type: runbook",
                strict,
                warnings,
                errors,
            )
        if (
            in_archive
            and fields.get("status") == "archived"
            and not fields.get("superseded_by")
            and not fields.get("archive_reason")
        ):
            report_compat(
                f"{owner_relative}: archived Runbook without a successor should set archive_reason",
                strict,
                warnings,
                errors,
            )
        if is_under(path, root, "docs/runbooks") and fields.get("superseded_by"):
            report_compat(
                f"{owner_relative}: active Runbook must not name a successor",
                strict,
                warnings,
                errors,
            )

        old_targets = resolved_relationships(
            root,
            path,
            "supersedes",
            fields.get("supersedes", ""),
            strict,
            warnings,
            errors,
        )
        new_targets = resolved_relationships(
            root,
            path,
            "superseded_by",
            fields.get("superseded_by", ""),
            strict,
            warnings,
            errors,
        )

        for old_path in old_targets:
            old_fields = documents.get(old_path)
            if old_fields is None:
                continue
            if not _is_runbook_document(root, old_path, old_fields):
                report_compat(
                    f"{owner_relative}: supersedes target {rel_path(old_path, root)} is not a Runbook",
                    strict,
                    warnings,
                    errors,
                )
                continue
            reverse = resolved_relationships(
                root,
                old_path,
                "superseded_by",
                old_fields.get("superseded_by", ""),
                strict,
                warnings,
                errors,
            )
            if path not in reverse:
                report_compat(
                    f"{owner_relative}: supersedes link is not reciprocated by {rel_path(old_path, root)}",
                    strict,
                    warnings,
                    errors,
                )

        for new_path in new_targets:
            new_fields = documents.get(new_path)
            if new_fields is None:
                continue
            if not _is_runbook_document(root, new_path, new_fields):
                report_compat(
                    f"{owner_relative}: superseded_by target {rel_path(new_path, root)} is not a Runbook",
                    strict,
                    warnings,
                    errors,
                )
                continue
            reverse = resolved_relationships(
                root,
                new_path,
                "supersedes",
                new_fields.get("supersedes", ""),
                strict,
                warnings,
                errors,
            )
            if path not in reverse:
                report_compat(
                    f"{owner_relative}: superseded_by link is not reciprocated by {rel_path(new_path, root)}",
                    strict,
                    warnings,
                    errors,
                )


def emit_text(warnings: list[str], errors: list[str]) -> None:
    """以人类可读格式输出结果。"""

    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)

    if errors:
        print(
            f"Document governance validation failed: "
            f"{len(errors)} error(s), {len(warnings)} warning(s).",
            file=sys.stderr,
        )
    else:
        print(
            f"Document governance validation passed: "
            f"{len(warnings)} warning(s)."
        )


def emit_json(
    root: Path,
    strict: bool,
    warnings: list[str],
    errors: list[str],
) -> None:
    """以 JSON 格式输出结果。"""

    payload = {
        "root": str(root),
        "strict": strict,
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "errors": len(errors),
            "warnings": len(warnings),
        },
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main() -> int:
    """执行文档治理校验。"""

    args = parse_args()
    root = Path(args.root).resolve()
    errors: list[str] = []
    warnings: list[str] = []

    if not root.is_dir():
        errors.append(f"project root is not a directory: {root}")
    else:
        validate_required_dirs(root, args.strict, warnings, errors)
        documents: dict[Path, dict[str, str]] = {}
        seen_record_ids: dict[str, Path] = {}
        docs_root = (root / "docs").resolve()
        for path in iter_markdown_files(root):
            resolved_path = path.resolve()
            if not is_within(resolved_path, docs_root):
                errors.append(
                    f"{rel_path(path, root)}: governed Markdown resolves outside docs/"
                )
                continue
            fields, body = validate_frontmatter(
                root, path, args.strict, warnings, errors
            )
            documents[resolved_path] = fields
            validate_structured_record(
                root,
                path,
                fields,
                args.strict,
                warnings,
                errors,
                seen_record_ids,
            )
            validate_plan(
                root, path, body, args.strict, warnings, errors
            )
            validate_active_runbook(
                root, path, args.strict, warnings, errors
            )
            validate_archived_runbook(
                root, path, fields, errors
            )
            validate_source_links(
                root,
                path,
                body,
                args.strict,
                warnings,
                errors,
            )
        validate_adr_relationships(
            root, documents, args.strict, warnings, errors
        )
        validate_runbook_relationships(
            root, documents, args.strict, warnings, errors
        )

    if args.format == "json":
        emit_json(root, args.strict, warnings, errors)
    else:
        emit_text(warnings, errors)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
