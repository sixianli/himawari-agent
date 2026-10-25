# Document Governance Workflows

Use this reference for creation, reconciliation, ADR supersession, closure,
rollback, and conflict handling.

## Contents

- [New Feature Workflow](#new-feature-workflow)
- [Drift Reconciliation](#drift-reconciliation)
- [ADR Supersession](#adr-supersession)
- [Spec and Plan Closure](#spec-and-plan-closure)
- [Runbook Lifecycle and Execution](#runbook-lifecycle-and-execution)
- [Rollback](#rollback)
- [Ideas and Backlog](#ideas-and-backlog)
- [Agent Lessons](#agent-lessons)
- [Conflict Handling](#conflict-handling)

## New Feature Workflow

1. Update or create the PRD when product scope changes.
2. Update or create Architecture when current system behavior changes.
3. Create or supersede an ADR for a durable technical decision.
4. Write an Execution Spec under `docs/execution/specs/`.
5. Confirm the Spec before writing an Implementation Plan under
   `docs/execution/plans/`.
6. Implement and verify the change.
7. Reconcile affected long-lived and operational documents.
8. Archive the closed Spec and Plan only after completing closure.

## Drift Reconciliation

Use this mapping after inspecting the actual diff or changed configuration:

- Public API, schema, or data contract: update PRD scope, Architecture data
  model, and contract artifacts when present.
- Feature behavior or user-visible flow: update PRD acceptance boundaries,
  README feature status, and operational Runbooks when affected.
- Environment variable, configuration, secrets handling, or deployment
  assumption: update Architecture deployment boundaries, Runbook setup, and
  README setup when affected.
- Feature-flag semantics: update PRD visibility, Architecture rollout design,
  and Runbook activation/rollback procedures.
- Compatibility, versioning, deprecation, or supported-client policy: update
  PRD scope and record durable choices in an ADR.
- Operational procedure: update the Runbook; update other layers only when the
  procedure changes product or architectural truth.
- Architectural shift, technology replacement, or durable trade-off: create a
  superseding ADR and update Architecture.

Update affected documents in the same authorized change set. If future work
remains, record it in Backlog. If current evidence cannot resolve a material
conflict, report the uncertainty and request human direction instead of
inventing project state. Report intentionally unchanged documents and why.

## ADR Supersession

Do not archive ADRs. Supersede them in place:

1. Create the replacement ADR under `docs/adr/` with `status: active`, a valid
   `decision_status`, and `supersedes: docs/adr/<old-adr>.md`.
2. Review and accept the replacement decision before changing the old ADR.
3. Update the old ADR in place to `status: superseded`,
   `decision_status: superseded`, and
   `superseded_by: docs/adr/<new-adr>.md`.
4. When the superseded ADR itself superseded an older one, keep its
   `supersedes` field and the older ADR's `superseded_by` field unchanged;
   record each link exactly once. The validator follows `superseded_by` until
   it reaches an `active`, `accepted` ADR, and fails when the chain loops or
   ends anywhere else.
5. Preserve the old ADR's recorded context, options, decision, and
   consequences; change only lifecycle metadata and cross-references.
6. Update Architecture to describe the new current behavior.
7. Validate both directions of the relationship and all affected SOURCE links.

A three-ADR chain records one link per pair:

- `docs/adr/0001-old.md`: `status: superseded`,
  `decision_status: superseded`, `superseded_by: docs/adr/0002-middle.md`
- `docs/adr/0002-middle.md`: `status: superseded`,
  `decision_status: superseded`, `supersedes: docs/adr/0001-old.md`,
  `superseded_by: docs/adr/0003-new.md`
- `docs/adr/0003-new.md`: `status: active`, `decision_status: accepted`,
  `supersedes: docs/adr/0002-middle.md`

## Spec and Plan Closure

Before archiving a Spec or Plan:

- Confirm the work is merged, rejected, superseded, or otherwise closed.
- Run and record relevant verification.
- Update PRD, Architecture, README, and Runbooks where the completed work
  changed their truth.
- Update or close affected Backlog items when the work changes their state.
- Preserve links to current truth.
- Run `scripts/archive_doc.py` for the closed Spec or Plan.
- Run strict validation after the move.

Never use the archive script on an ADR.

## Runbook Lifecycle and Execution

Runbooks use event-driven reconciliation, not calendar renewal:

1. Create or revise the stable active file under `docs/runbooks/` from the
   Runbook template.
2. Inspect current repository facts, selected contract sources, tests, and
   protected configuration. Write target-read-only preflight, evidence,
   rollback, and stop rules that do not hard-code temporary live claims.
3. Run relevant tests, inspect the diff, then use `scripts/runbook.py seal` in
   dry-run mode. Only after semantic reconciliation use
   `--confirm-reconciled --apply`, followed by `runbook.py check`.
4. For every actual operation, rerun the static check, current Git/worktree
   readback, target-read-only Live-State Preflight, effective-risk decision,
   and required authorization before bounded execution and verification.
5. Stop on any mismatch, ambiguous target, missing evidence root, failed
   safety prerequisite, or authorization boundary. A Runbook never grants
   authority to continue.

When operational truth changes, reconcile and reseal because of the event.
Never refresh a date, invent a review window, force a seal, or let a validator
write the hash.

Use `scripts/archive_doc.py` with exactly one Runbook mode:

- `--snapshot --archive-date DATE` before a major revision at the same stable
  path;
- `--superseded-by ACTIVE_PATH --archive-date DATE` when another active
  Runbook replaces it;
- `--retire --reason TEXT --archive-date DATE` when it has no successor.

Runbook archive operations validate reciprocal lineage and refuse overwrite.
Snapshot and successor modes change an active Runbook's frontmatter, so its
existing seal becomes invalid. Reconcile and explicitly seal that active file;
the archive tool never does so automatically. Historical archives are never
executed or fingerprinted again against current sources.

Read `references/runbook-workflow.md` for the complete risk, fingerprint,
Live-State Preflight, evidence, mutation-boundary, and archive rules.

## Rollback

- Correct current-truth documents so they do not claim reverted behavior still
  exists.
- Describe the exact remaining behavior after a partial rollback.
- Preserve ADR history; create a new ADR when rollback represents a new durable
  decision rather than rewriting an earlier ADR.
- Add or reopen a Backlog item when rollback creates future work.

## Ideas and Backlog

- Preserve a meaningful thought without committing to work as an Idea.
- Record intended future work as a Backlog item.
- Link an Idea to a derived Backlog item or formal governed artifact when it is
  promoted; do not duplicate the original reasoning.
- Query source files with `scripts/idea_backlog.py`; do not maintain `INDEX.md`.
- See `references/idea-backlog-workflow.md` for capture quality, transitions,
  review behavior, and closure evidence.

## Agent Lessons

Maintain `docs/lessons.md` only when evidence shows that coding agents
frequently or repeatedly make the same mistake. Each lesson must describe the recurring
pattern, why it matters, and a concrete prevention rule. Do not add project
status, general knowledge, one-off incidents, or future work. Put future work
in Backlog instead.

## Conflict Handling

1. Inspect current code and repository evidence.
2. Apply the authority order in `references/sop.md` to the document domains.
3. Treat ADRs as decision history rather than current implementation inventory.
4. Reconcile stale current-truth documents with verified implementation.
5. Stop and request human direction only when available evidence cannot resolve
   a material product or decision conflict.
