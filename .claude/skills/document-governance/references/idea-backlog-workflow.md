# Idea and Backlog Workflow

Use this reference only when preserving an idea or managing future work.

## Routing

- “记录这个想法”“保留这段思路” or equivalent preservation intent creates an
  Idea under `docs/ideas/`.
- “以后要做”“加入待办”“记录优化点” creates a Backlog item under
  `docs/backlog/`.
- “列出/评审待办” queries records with `idea_backlog.py list` or `review`.
- “开始处理这条待办” changes an open or deferred Backlog to `in_progress`.
- “推进/落地/转成正式工作” promotes a record to a linked Backlog, Spec, Plan,
  ADR, or other appropriate governed artifact.
- Casual brainstorming without persistence intent creates no file.

Implicit invocation remains enabled, but only act inside the user-authorized
repository and only when the preservation or governance intent is clear.

## Capture Quality

An Idea preserves the insight, the trajectory that produced it, useful
verbatim quotes when they exist, and open questions. Quotes are optional; do
not invent them or reject a short but meaningful thought because it has fewer
than two quotes.

A Backlog item states the desired outcome, source or rationale, priority,
review timing when deferred, and eventual result or rejection reason. Keep
file boundaries, ordered implementation tasks, and verification commands in a
Plan, not in Backlog.

## Frontmatter and States

Both types use `status: active`, a type-specific `document_type`, a globally
unique `record_id`, `record_state`, `date`, `updated`, `promoted_to`,
`supersedes`, and `superseded_by`.

- Idea: `document_type: idea`; states are `captured`, `promoted`, `closed`, and
  `superseded`.
- Backlog: `document_type: backlog`; states are `open`, `in_progress`,
  `deferred`, `converted`, `done`, `rejected`, and `superseded`.

Every Backlog keeps the complete flat header from
`assets/templates/backlog-item-template.md`, including `priority`,
`item_type`, `source_idea`, `review_after`, `promoted_to`, `result`, and
`reason`, even when an optional value is empty. `priority` is one of `urgent`,
`high`, `normal`, or `low`. `item_type` is a non-empty project-defined label;
this skill does not impose a cross-project item-type enumeration.

Required transition evidence:

- `promoted` and `converted` require `promoted_to`.
- `deferred` requires `review_after` or `reason`.
- `done` requires `result`; `rejected` requires `reason`.
- `closed` requires `result` or `reason`.
- `superseded` requires `superseded_by` and `status: superseded`.

Open or overdue items do not fail strict validation. They are surfaced by the
review command so CI validates structure without pretending all future work
must be completed.

Backlog `review_after` schedules reconsideration of future work. It is not a
Runbook trust or execution-freshness field.

## Deterministic Commands

Resolve this skill's actual source directory, verify Python 3.10+, and invoke
`scripts/idea_backlog.py` by absolute path.

```text
idea_backlog.py --root <project> idea capture ...
idea_backlog.py --root <project> backlog capture ...
idea_backlog.py --root <project> list --kind all
idea_backlog.py --root <project> review
idea_backlog.py --root <project> start <BL-ID>
idea_backlog.py --root <project> defer <BL-ID> --review-after YYYY-MM-DD
idea_backlog.py --root <project> promote <ID> --target docs/...
idea_backlog.py --root <project> close <ID> --state ...
```

`idea capture` and `backlog capture` name the new file `<record_id>-<slug>.md`.
The slug takes ASCII alphanumeric words and contiguous CJK character runs from
`--title`, joins them with `-`, and keeps at most 8 segments and 120 bytes. To
name the file with different text (for example an English short name for a
Chinese title), pass `--slug`; the title stored in the record stays `--title`.

When a Backlog is captured with `--source-idea`, the script promotes the Idea
and writes bidirectional links. A promotion target must already exist; the
script will not fabricate the semantic content of a Spec, ADR, or Plan.
