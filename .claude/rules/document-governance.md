# Document Governance in Every Session

The user asked on 2026-10-26 that every later cloud thread actually apply the `document-governance` skill to this project ([ADR 0080](../../docs/adr/0080-document-governance-in-fast-mode.md)). The repository keeps no copy of the skill ([ADR 0132](../../docs/adr/0132-owner-skills-from-the-claude-ai-account.md)). Cloud threads get it from the owner's claude.ai account and Mac sessions from `~/.claude/skills/`; either way it comes through the Skill tool, and the project rules below still apply.

## Where the Skill Is

- Load `document-governance` through the Skill tool before governed documentation work, then read only the reference under `references/` that matches the work, as the skill's "Load Only What Is Needed" list says.
- Run its scripts from the repository root as `python3 -B <skill directory>/scripts/<script>.py ...`, with the directory the Skill tool reports. Do not add `-I`: the scripts import each other from their own folder.
- When the Skill tool does not list `document-governance`, say so in the plan, and copy the frontmatter and structure of the newest existing document of the same type instead of inventing a format.

## When to Use It

These triggers apply in fast mode and in full mode:

- A durable technical, product, or process decision gets a new ADR from `assets/templates/adr-template.md` in `docs/adr/`, numbered after the highest existing ADR. A changed decision supersedes the earlier ADR in place (the skill's `references/workflows.md`, "ADR Supersession"); never rewrite the earlier ADR's decision.
- Future work that the user or a thread decides to keep becomes a Backlog item through `idea_backlog.py backlog capture`. Never create `docs/TODO.md` or a hand-maintained index.
- When the user asks to keep an idea (for example "记下这个想法"), capture it with `idea_backlog.py idea capture`.
- When a change makes a current-truth document plainly wrong (the PRD, the architecture document, an active Spec or Plan, a Runbook's steps), correct it in the same commit.
- A closed Spec or Plan is archived only with `archive_doc.py`. ADRs are never archived.
- An incident and its gate go to `docs/incidents-and-gates.md`, and a mistake that coding agents repeat goes to `docs/lessons.md`, both under [ADR 0107](../../docs/adr/0107-every-incident-gets-an-automatic-gate.md) ([incident-gates.md](incident-gates.md)); project status never does.

## The Documentation Check

- Since 2026-10-31 the repository has no documentation check: `npm run check:docs` and its script were removed, and no commit is blocked by documentation findings (user decision, [ADR 0133](../../docs/adr/0133-docs-check-removed-from-npm-run-check.md)).
- When the skill is loaded, its strict validation (`python3 -B <skill directory>/scripts/validate_docs.py . --strict`, about one second, read-only) can be run by hand after changing governed documents. In fast mode, findings that only say an active Runbook's `contract_sha256 does not match` or `contract path does not exist` may be left for full mode.
- In fast mode, when a commit changes a Runbook's contract sources and leaves its seal stale, write `Docs: deferred (fast mode)` in the commit message and name the Runbook. Reconcile and reseal deferred Runbooks when the user switches back to full mode, or when a thread is about to follow that Runbook.
- Never reseal a Runbook only to make the check pass. `runbook.py seal ... --confirm-reconciled --apply` comes after the Runbook was reviewed against the current code.

## Runbooks That Guide an Operation

Before following an active Runbook for a real operation, apply the three gates in the skill's `references/runbook-workflow.md`. In fast mode, production deployment and rollback follow [delivery-mode.md](../../.agents/instructions/delivery-mode.md) (`scripts/delivery-mode/deploy.sh` and `rollback.sh`), not a Runbook.

## The Engineering Casebook

[docs/engineering-casebook.md](../../docs/engineering-casebook.md) is not one of the skill's document types; the `Engineering Casebook` section of [AGENTS.md](../../AGENTS.md) governs it. The ADR records the decision and its rationale; the case tells the interview story and links to the ADR, and the ADR's references link back to the case.

## Delivery Reports

Each delivery report names the documents updated, the documents intentionally left unchanged and why, the result of the skill's strict validation when it ran, with the number of deferred Runbook findings, and any Backlog items or ADRs created. Defects found in the skill go under a "Skill feedback" heading, as [the owner's global instructions](owner-global-instructions.md) say.
