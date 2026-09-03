# Validation Rules

Read this file before running, interpreting, or modifying
`scripts/validate_docs.py`.

## Modes

The validator defaults to migration-friendly mode. Structural adoption issues
are warnings so an existing repository can be assessed without immediately
blocking all work.

- `--strict` (alias `--ci`) promotes every migration-friendly warning to an
  error and returns a nonzero exit code. Use it for governed repositories, CI,
  and completion checks.
- `--format=json` emits one JSON object without changing exit behavior.
- `scripts/runbook.py check` is an execution gate, not a migration audit. It
  treats every Runbook finding as blocking and has no compatibility mode.

## Always-Error Checks

These conditions fail in every mode:

- `status` is present but is not `active`, `superseded`, or `archived`.
- An archived document has `status: active`.
- An active Spec or Plan has `status: archived`.
- A local SOURCE target is absolute or contains `..` path traversal.
- A governed Markdown file or SOURCE compatibility target resolves through a
  symbolic link outside the project's `docs/` directory.
- The supplied project root does not exist or is not a directory.
- An active Runbook declares an invalid `execution_risk` or malformed
  `contract_sha256`.
- A declared active Runbook fingerprint does not match its current Runbook and
  selected repository sources.
- A Runbook contract has multiple or malformed blocks; an absolute, traversing,
  missing, secret-bearing, cache/build/VCS/evidence, unsupported, broken, or
  repository-escaping selector; or another unsafe object.
- An active Runbook uses `last_reviewed` or `review_after` as calendar trust.

## Migration Warnings / Strict Errors

- A required governance directory is missing.
- `docs/ideas/` and `docs/backlog/` are created on first use;
  empty optional directories are not required because Git does not preserve
  them.
- A governed Markdown document has missing, unterminated, malformed, nested,
  duplicate, or multiline frontmatter.
- Frontmatter lacks `status`, `supersedes`, `superseded_by`, or `date`.
- A document in archive is not marked `status: archived`.
- An active Spec or Plan is marked `status: superseded` instead of being
  closed and archived.
- A `document_type`, when present, conflicts with the document's governed
  directory.
- A structured Idea/Backlog record has a missing, duplicate, malformed, or
  path-inconsistent `record_id`, `document_type`, or `record_state`.
- A Backlog omits any field in its complete template header, uses a priority
  other than `urgent`, `high`, `normal`, or `low`, or has an empty
  `item_type`.
- A promoted/converted record lacks a valid `promoted_to`; a deferred Backlog
  lacks `review_after` or `reason`; or a terminal record lacks its required
  result, reason, or successor.
- An ADR lacks `decision_status`, uses an invalid decision status, or has
  inconsistent `status`, `decision_status`, and supersession links.
- A Plan lacks a Source Spec section or SOURCE reference.
- A SOURCE target does not exist under `docs/`.
- An old active Runbook lacks `document_type: runbook`, `execution_risk`,
  `contract_sha256`, its unique contract block, or a required Runbook section.
- `docs/runbooks/` contains a superseded or archived Runbook rather than only
  active entries.
- An archived Runbook lacks `document_type: runbook`, has a broken reciprocal
  relationship, or has neither a successor nor `archive_reason`.

Strict mode must leave these findings in `errors`, not `warnings`; a strict run
with any such finding must report `ok: false` and return exit code 1.

## SOURCE Resolution

- Resolve `docs/...` from the project root.
- Resolve paths without the `docs/` prefix from the project `docs/` directory.
- Never fall back to a same-named file at the project root.
- Recognize active Spec/Plan paths whose files moved to the corresponding
  archive directory.
- Recognize a missing legacy active Runbook path when there is an exact
  undated archive match or exactly one dated archive match. Multiple dated
  matches are ambiguous and require an exact archive SOURCE path.
- Recognize legacy ADR paths whose files already live in `docs/archive/adr/`,
  but do not archive ADRs going forward.
- Skip external HTTP(S) URLs and explicit template placeholders after enforcing
  local path-boundary rules.
- Do not validate heading anchors.

## Files Considered

- Scan all `*.md` files under the target project's `docs/` tree.
- Skip `docs/templates/**` because it may contain unfilled placeholders.
- Do not scan the skill's own `assets/templates/**` when validating a project.
- Open records and overdue `review_after` dates are work state, not validation
  failures. Use `scripts/idea_backlog.py review` to surface them.
- The validator can enforce the location and frontmatter shape of
  `docs/lessons.md`, but it cannot prove that an entry represents a repeated
  Codex mistake. Review that semantic boundary manually.
- Fully validate active Runbooks using the shared `runbook.py` contract logic.
  For archived Runbooks, validate historical location, status, type, and
  relationships but do not recompute old hashes against current sources.
- There is no date-based Runbook expiration. Backlog `review_after` remains a
  work-state field and is not a Runbook trust signal.

## What the Validator Cannot Prove

The validator cannot prove semantic consistency between code and prose,
confirm that a Spec matches its Plan, determine whether a code change required
a PRD update, or prove that work is truly closed. Inspect repository evidence
and complete the workflow checklist before declaring semantic or release
readiness.

The validator also cannot classify the real commands or live target for an
execution. `execution_risk` is only a declared protection floor. The executing
agent must raise risk from current commands and preflight and enforce the
mutation-boundary authorization described in `references/runbook-workflow.md`.
