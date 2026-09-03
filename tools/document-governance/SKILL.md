---
name: document-governance
description: "Govern the project's documentation system under the repository's `docs/` root, including creating, reconciling, validating, superseding, archiving, and closing PRDs, Architecture documents, ADRs, Specs, Plans, Runbooks, user-authored Ideas, and Backlog items. Use this skill when the user explicitly requests documentation governance or any of these document-lifecycle operations, when an adopted Runbook is being checked, sealed, or used to guide an operation, when the user wants to persist one of their own ideas as project documentation, or proactively when there is clear evidence that governed project documentation has drifted out of sync with the project's current state. Do not use this skill for ordinary code or documentation edits that do not require documentation governance or lifecycle management, casual brainstorming with no intent to persist the outcome, or routine project-status or progress reporting."
---
# document-governance

This skill governs only project documentation that has explicitly adopted its rules. Do not apply this skill’s document classification and lifecycle system merely because the repository contains a `docs/` directory. The system may be considered adopted within the relevant scope if any of the following conditions is met: project-level instructions explicitly require this workflow; existing documents already use the structures or frontmatter conventions defined by this skill; or the user explicitly requests that this skill be used for the current task. When determining the project's current state or restoring work context, derive state from the latest repository contents, test results, build artifacts, and runtime evidence rather than maintaining a separate manually synchronized copy of project state.

## Load Only What Is Needed

* To understand document hierarchy, frontmatter, naming, authority, ADR supersession, and SOURCE path rules,
  read `references/sop.md`.
* To understand creation, reconciliation, closure, rollback, and conflict handling, read `references/workflows.md`.
* When capturing, reviewing, advancing, closing, or migrating Idea and Backlog items, read
  `references/idea-backlog-workflow.md`.
* Before creating, reconciling, sealing, checking, executing from, snapshotting,
  superseding, or retiring a Runbook, read `references/runbook-workflow.md`.
* Before explaining or modifying the validator, read `references/validation-rules.md`.
* When creating documents, copy the corresponding files from `assets/templates/`.
* Run `scripts/validate_docs.py` to validate the project.
* Run `scripts/idea_backlog.py` for deterministic Idea/Backlog file operations.
  Do not create manually maintained indexes.
* Run `scripts/runbook.py check` before using an active Runbook and
  `scripts/runbook.py seal` only after semantic reconciliation and relevant tests.
* Use only `scripts/archive_doc.py` to archive closed Specs or Plans and to
  snapshot, supersede, or retire Runbooks. Never use it for ADRs.

## Required Workflow

1. Before governing `docs/`, require the repository to explicitly adopt or already have adopted this system.
2. Check the user-defined scope and project instructions such as `AGENTS.md`, `CLAUDE.md`, and `README.md`.
   If those instructions differ from this skill, follow the repository conventions.
3. Inspect the relevant diff, files, or existing documents; do not infer documentation impact solely from the wording of the request.
4. Classify the work and read only the reference sections that match it.
5. Preserve answer-only or review-only scope. Once editing is authorized, keep affected code and documentation
   consistent within the same change set.
6. Supersede ADRs in place within `docs/adr/`; never archive ADRs. Archive Specs and Plans only after
   closure. Keep only active Runbooks in `docs/runbooks/` and use the dedicated Runbook archive modes.
7. Resolve the directory of the currently enabled skill from the source path provided by the skill inventory or runtime framework. Do not assume
   `CODEX_SKILL_DIR` exists. Before running scripts bundled with the skill, confirm that Python 3.10 or later is
   available via `python3`, then invoke the scripts using the resolved absolute path.
8. Use a migration-friendly validation mode for audits during initial adoption of this system. Use `--strict` for governed projects,
   CI, and completion checks; resolve all errors before claiming that structural validation has passed.
9. Report which documents were updated and intentionally left unchanged, which checks were skipped, any unresolved drift,
   and any required ADR follow-up work.
10. When a Runbook guides an operation, apply all three execution gates from
    `references/runbook-workflow.md`: current static contract, fresh target
    preflight, and the authorization required by effective risk.

## Non-Negotiable Rules

* Keep `policy.allow_implicit_invocation: true` while honoring the adoption conditions and scope boundaries in this file.
* Do not silently rewrite decisions, context, options, or consequences already recorded in an ADR. Follow the
  supersession workflow in `references/workflows.md`.
* Keep superseded ADRs in `docs/adr/`, keep lifecycle fields consistent, and maintain bidirectional
  `supersedes` / `superseded_by` links.
* Store Ideas that need to be persisted under `docs/ideas/`, and store future work under
  `docs/backlog/`. Do not create `INDEX.md`.
* Treat the Backlog as a persistent work list. Do not invent Backlog items merely to justify
  a temporary status report.
* Do not create or maintain `docs/TODO.md`; all persistent future work belongs in the Backlog.
* `docs/lessons.md` records only mistakes that Codex makes frequently or repeatedly, along with explicit rules
  that prevent the same class of mistake from recurring. Do not record one-off issues, project state, or general knowledge there.
* Do not create or maintain a separate project-root state cache. Derive state from the current repository, documentation, tests, artifacts, and
  runtime evidence.
* Restrict local SOURCE references to the target project's `docs/` tree.
* If code is rolled back, correct the related documentation that reflects the current facts within the same change set.
* Never execute an archived or superseded Runbook. `status: active` and a
  passing static hash do not prove live applicability and do not authorize an operation.
* Do not use Runbook `last_reviewed`, Runbook `review_after`, periodic review
  windows, or refreshed dates as trust. Every execution must prove current
  repository and target state.
* Treat `execution_risk` as a minimum protection level. Actual commands and
  live targets can raise risk, never lower it; unknown risk is critical.
* Never let validation or archive tooling automatically reseal a Runbook.
