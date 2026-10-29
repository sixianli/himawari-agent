# Himawari Agent Project Instructions

## Delivery Mode

Read `DELIVERY_MODE` at the repository root before deciding which tests, documentation steps, merge checks, or production steps a change needs. While it says `fast`, [.agents/instructions/delivery-mode.md](.agents/instructions/delivery-mode.md) replaces the rules it names in this file and in the files under `.agents/instructions/` (user decision, 2026-10-25). Only the user switches the mode. GitHub Actions is turned off ([ADR 0092](docs/adr/0092-pause-github-actions.md)): no CI runs, so the local fast-mode checks are the only quality gate, and a missing CI result on a PR is expected.

## Product Vision

[docs/product-vision.md](docs/product-vision.md) is the top-level product document for the whole development cycle (user decision, 2026-10-28, [ADR 0101](docs/adr/0101-adopt-product-vision-v2-1.md)). Every session, including cloud threads, reads it before designing or changing a user-facing feature, memory, proactive behavior, tools, permissions, or self-improvement.

- Its principles decide conflicts in this order: owner sovereignty, then boundaries and reversibility, then memory reliability, then proactivity and efficiency. Name the principle a design relies on when it trades one against another.
- "Owned first, data held by the owner" (自有优先、数据自持) replaces the earlier "local-first" wording: the owner controls where Himawari runs and where its data lives, which may be a server the owner rents. Do not describe Himawari as local-first.
- A PRD sets the scope of one version and may postpone parts of the vision, but must not contradict it. Only the user changes the vision text; a new version replaces the whole document and records its changes in the appendix.

## Owner's Global Instructions and Skills

The owner's global instructions are copied into [.claude/rules/owner-global-instructions.md](.claude/rules/owner-global-instructions.md). Claude Code loads that file on its own; any other agent whose session did not load the owner's global instructions from the owner's machine, such as a cloud session, reads it before starting work. The owner's skills are copied under `.claude/skills/`; [.claude/rules/owner-skills.md](.claude/rules/owner-skills.md) lists them and says how to use a copy when the Skill tool does not list that skill.

## Documentation Governance

This repository explicitly adopts the `document-governance` skill for all governed project documentation under `docs/`. Every session, including cloud threads that do not load `.claude/skills/`, follows [.claude/rules/document-governance.md](.claude/rules/document-governance.md): where the skill is, when to use it, and the `npm run check:docs` check that runs in both delivery modes ([ADR 0080](docs/adr/0080-document-governance-in-fast-mode.md)).

## Code and Documentation Consistency

In fast mode this section is replaced by the lighter rules in [.claude/rules/document-governance.md](.claude/rules/document-governance.md) and [Delivery Mode](#delivery-mode): strict validation still runs before every commit through `npm run check:docs`, and only Runbook reseals are deferred.

The user asked on 2026-09-29 that code and documentation never drift apart. Documentation drift already happened once: commit `51fe7f6` changed `apps/control-center/src` without resealing `docs/runbooks/hermes-control-center-upgrade-runbook.md`, and strict validation failed from then on.

- Every commit that changes behavior, interfaces, configuration, tests' required environment, or operational steps updates the affected documentation in the same commit: specs, plans, the architecture document, Runbooks, Backlog items, and ADR follow-up (supersede an ADR instead of rewriting it). If no document is affected, say so in the delivery notes with the reason.
- Before every commit, run strict documentation validation, for example `python3 <document-governance skill>/scripts/validate_docs.py . --strict`. A commit must not introduce a new validation error. When a change touches a Runbook's contract sources, review the Runbook against the new code, then reseal it with `runbook.py seal ... --confirm-reconciled --apply` in the same commit.
- Documentation validation and Runbook checks are read-only scripts that finish in seconds; they may run on the MacBook. This does not extend to builds or tests.
- When fixing a defect, also correct documentation that describes the old behavior. When a document records a decision, keep its status fields and links current.
- Commit messages and delivery reports list the documents updated and the result of strict validation.

## Incidents and Repeated Mistakes

The rules are in [ADR 0107](docs/adr/0107-every-incident-gets-an-automatic-gate.md), which supersedes ADR 0060 and keeps all of its rules (user decision, 2026-10-29). Every session, including cloud threads, follows [.claude/rules/incident-gates.md](.claude/rules/incident-gates.md). In short:

- Every incident (a production failure, a failed or rolled-back release, a problem blocked only late in packet generation, or a defect the user found that a check could have caught) is closed only when an automatic check exists that would have failed on it: a deploy preflight, a packet check, a test, a step of `npm run check`, a hook, or a script that checks itself on every use. Documentation, casebook entries, and reminders alone do not close it.
- When the same mistake happens for the third time, by Claude, by any agent it directs, or as a repeated incident, a hard gate (any test or executable logic) must block the fourth. Stop the current work, find why the earlier prevention failed, add the gate, and prove it by showing it fail on a reproduction and pass once the mistake is removed; when it needs a change only the user can make, prepare it, ask, and keep that work paused.
- [docs/incidents-and-gates.md](docs/incidents-and-gates.md) lists every incident with its date, symptom, root cause, occurrence count, gate, and state. Read it when a thread starts; update it before the thread's delivery report. `npm run check` runs `scripts/check-incident-gates.mjs` on it.
- Count occurrences across sessions and agents with `docs/incidents-and-gates.md`, `docs/lessons.md`, handoff files, stop files, and commit messages as the history. A session handoff names any mistake that has happened twice.
- Record the result where it belongs: an incident and its gate in `docs/incidents-and-gates.md`; a mistake coding agents repeat, with its constraint, in `docs/lessons.md` (extend an existing entry when one covers it; an entry that reached three occurrences names its constraint and where it runs); a way of briefing, reviewing, or driving opencode and Grok in the `opencode-orchestration` skill; a product defect fixed in the task or filed as a Backlog item; a change to how a test, deployment, or operation runs in its Runbook, plan, or spec; a user preference about how Claude works in Claude's memory.
- Delivery reports name the root cause found, the gate added for each incident (file or command) or why none was needed, and where it was recorded.

## Engineering Casebook

The user asked on 2026-10-26 that every hard problem and important decision of this project be kept as a case for the user's AI Application Engineer and AI Agent Engineer interviews. [docs/engineering-casebook.md](docs/engineering-casebook.md) is that record. This rule applies in fast mode and in full mode.

- After a thread or delegated agent solves a notable hard problem or bug, or makes an important architecture or design decision (anything that gets an ADR, changes a measured latency or reliability figure, or fixes a production incident), add a case to the casebook, or extend the existing case, in the same delivery.
- Use the casebook's case template and keep every section: background and symptoms, root cause, our solution, alternatives discussed and what was given up, industry practice, comparison and trade-offs, measured results, related ADRs and PRs, and the 30-second interview version. Write it in Simplified Chinese; English terms are allowed and are explained at first use.
- Cite only first-party sources that were actually opened, with a short quote, and mark each one with the casebook's source legend. Take every number from a commit message, ADR, test record, or log, name where it came from, and write "未测量" when there is no measurement.
- Add the case to the casebook's table of contents and competency map. When a later change alters a case's outcome, append a dated follow-up to that case instead of rewriting its conclusion.
- Delivery reports name the case added or updated, or say why the work did not need one.

## Project Instruction Commits

- Changes to this project-level `AGENTS.md` may be committed separately after review and applicable checks, without asking the user for confirmation. The same holds for the instruction files under `.agents/instructions/` that this file points to. Stage only those files in such a commit and preserve unrelated work. Push it like every other commit (see "Pushing Commits" below).

## Documentation Language and Clarity

- Keep this `AGENTS.md` and the instruction files under `.agents/instructions/` entirely in English. Write all other project documentation content in Simplified Chinese.

## Document Readability and Navigation

- When creating or revising project documentation, provide convenient navigation links wherever practical. Place a clickable table of contents or review summary at the beginning of long documents; do not add unnecessary structure solely for navigation in short documents.
- When referring to sections within the same document, use internal links with descriptive section titles rather than bare references such as "Sections 2 and 9" or "5.1 and 5.4". References to detailed rules in summary tables should also link directly to the relevant sections.
- Where useful, provide "Back to contents" or "Back to review summary" links in longer sections reached from the table of contents or review summary, so readers can easily navigate back and forth.
- When referring to other project documents, use meaningful link text and repository-relative paths. Link to the relevant section whenever practical if a specific passage is intended. Preserve the SOURCE markers required by documentation governance; navigation links must not replace source declarations.
- Use heading anchors or explicit anchors supported by the target Markdown reader. Update related links when headings, sections, or paths change. Before delivery, check that targets exist and anchors are unique; do not claim that navigation works in the reader unless it has been verified by actually clicking the links.
- Improve navigation incrementally within the scope of the current documentation task. Do not rewrite unrelated documents or reorganize historical content in bulk merely to add links.

## Approved Web Design Baselines

- Every session that designs or changes the web page, including the coordinator and cloud threads, reads [docs/ui-ux-design-guide.md](docs/ui-ux-design-guide.md) first: its rules, the designs the user approved and liked, and the bad designs already met (user decision, 2026-10-29). At delivery, add each new UI or UX problem to its bad designs, each design the user approved to its good designs, and any rule they teach to its rules; a rule that can be checked automatically also gets a check, such as a scene or detector in `scripts/check-layout-audit.mjs` (`npm run check:layout`).
- Before changing the control center's visual design, chat interactions, or brand assets, read the [current v4 interaction and visual baseline](docs/execution/specs/2026-09-15-control-center-v4-design.md) and the [original logo baseline](docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md), and open the interactive prototypes and visual mockups referenced in them.
- `assets/brand/himawari/v1/` and `docs/assets/control-center/2026-09-10-v1/` preserve the original design approved by the user on 2026-09-10. Check subsequent implementations against these references for layout, themes, per-turn execution processes, and tool displays; do not overwrite the baseline files. When the user approves a design change, save it as a new version and update the documentation references.
- The current chat page must follow the frozen prototype in `docs/assets/control-center/2026-09-15-v4/`, plus the execution environment status line and sidebar running marker approved on 2026-09-27 in `docs/assets/control-center/2026-09-27-v5/`, plus the time-bar process area and sunflower-disc mark approved on 2026-10-26 in `docs/assets/control-center/2026-10-26-v6/` ([ADR 0087](docs/adr/0087-chat-ui-v6-process-timeline.md); the rest of that prototype is not yet approved, and brand assets for the new mark are in `assets/brand/himawari/v2/`), plus the phone chat page approved on 2026-10-27 in `docs/assets/control-center/2026-10-27-v7/` ([ADR 0096](docs/adr/0096-phone-chat-page-safe-area-and-quiet-answer-line.md): no model name under the answer, a one-line memory note, safe-area insets, and a round send button), plus the conversation "more" panel approved on 2026-10-28 in `docs/assets/control-center/2026-10-28-v8/` ([ADR 0100](docs/adr/0100-conversation-more-panel-files-and-background-commands.md): one title-bar button that shows only the running background command count, a Files tab and a Background tab grouped by turn, a right column on desktop and a bottom sheet on phones), plus the UI batch approved on 2026-10-28 in `docs/assets/control-center/2026-10-28-v9/` ([ADR 0105](docs/adr/0105-ui-batch-2026-10-28-show-what-the-owner-needs.md): a one-sentence process summary with total time, only token total and KV cache hit rate below the steps, actions only under the answer, separate memory and reminders pages, and a four-tab settings dialog), plus the Gmail reminders, decision log, daily owner review list and connected-apps settings approved on 2026-10-29 in `docs/assets/control-center/2026-10-29-v10/` ([ADR 0106](docs/adr/0106-proactive-loop-v1-gmail-read-only.md): color carries meaning only, with red for what needs the owner, amber for a look or a self-recovered condition, and purple only for what can be clicked), plus the UI batch approved on 2026-10-29 in `docs/assets/control-center/2026-10-29-v11/` ([ADR 0110](docs/adr/0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md): a top bar of two separate groups of floating round buttons with the title centered and settings at the sidebar bottom, a branched chat that shows its source turns and origin, a command step that hides the command under command details, the page's own dropdown, and uploads on the files page); retain v1 as a historical reference and the source for brand assets. Changes must not reintroduce a standalone approval entry point or conversation deletion actions, and must not add a generic panel or page that piles up internal run information (models, tokens, steps, approvals, internal records). A panel or page with a specific purpose may be added once the user approves its prototype and it is saved as a new baseline version (narrowed by the user on 2026-10-28, [ADR 0100](docs/adr/0100-conversation-more-panel-files-and-background-commands.md#baseline-rule)).
- Messages, models, thinking summaries, tool outputs, timings, and approvals in the prototypes are all demonstration data. They are not evidence that production features have been implemented or that real execution has succeeded.

## Code Comments

The user's global rule against code comments (user decision G149, 2026-10-21) applies here: write none, and delete existing ones in every file you edit. Project additions: it binds Claude, opencode, Grok, and every other agent; put rationale and verification evidence in commit messages as well as delivery notes; `biome-ignore` counts as a tool directive to keep; see [the lesson on new code comments](docs/lessons.md#new-code-comments).

## Engineering Diagrams

- Do not use the `archify` skill to generate any engineering diagrams for this project, including flowcharts, architecture diagrams, sequence diagrams, state diagrams, and data-flow diagrams, unless the user explicitly requests its use. A general request to create a diagram does not authorize using `archify`.

## Repository Boundary

- Product code and product documentation belong in this repository.
- The sibling `pi-mono` repository is an upstream source reference and debugging checkout.
- Use `/Users/triggerjames/DoNotDeleteThis/documents/sxl_code_work_space/pi-mono` as the canonical read-only Pi source checkout; do not rediscover other checkouts, and report if it is unavailable. This does not authorize local dependency linking or committed dependency changes.
- Do not place Himawari-specific product logic in `pi-mono`.

## Pi-First Development Principle

- Himawari is built on Pi Coding Agent and the other reusable modules in `pi-mono`. Before designing or implementing any capability related to model connections, providers, routing, streaming, model runtime, Agent Loop, tools, sessions, or extensions, inspect the current `pi-mono` source and the pinned `@earendil-works/pi-*` API first.
- Scope Pi inspection to the modules, interfaces, and callers relevant to the current change. Expand the inspection when dependencies or unresolved evidence require it.
- Reuse, compose, configure, or minimally adapt an existing Pi capability whenever it already satisfies the requirement. Do not reimplement a Pi module or protocol in Himawari merely to create a product-local version.
- Himawari-owned code should add product-specific concerns that Pi does not own, such as authority and approval, data classification and disclosure, secret handles and host secret sources, protected Payloads, durable state and audit, product-level model selection/fallback policy, budget enforcement, and Gateway/Worker/Memory integration.
- Before keeping a duplicate implementation, record the exact Pi capability that is missing, verify that a thin adapter or an upstream-compatible extension cannot satisfy the requirement, and explain why the duplicate is necessary. Prefer a Pi adapter or a small upstream extension over a second protocol implementation.
- For Pi-related design or code review, explain which Pi capability is reused, which responsibility Himawari owns, and why any additional implementation is necessary. Keep this reuse explanation proportional to the change; a small adaptation may need only a short paragraph.

## Workspace Contract

- Keep all direct external dependency versions exact; do not introduce ranges for direct dependencies.
- Import `@earendil-works/pi-*` packages only from `packages/runtime-pi`; product domain, contracts, application code and entrypoints depend on product-owned types.
- Keep published Pi dependencies in committed manifests and lockfiles. Local `../pi-mono` source linking must be opt-in, reversible and must not change committed dependency declarations.

## Pushing Commits

The user's global push rule (push every commit to the same-named `origin` branch at once, user decision 2026-09-30) is kept by [ADR 0057](docs/adr/0057-batch-layers-one-two-for-small-defects.md#unchanged). Project additions:

- It applies to Claude, Codex, and opencode alike, including commits made during delegated tasks.
- A pushed commit is not a fully tested commit. Commit messages must still state which test layers actually ran; Layer 3 runs before a PR or merge, not before each push.

## Delegated Coding Agents

Before briefing, dispatching, reviewing, or answering opencode, Grok, or any other coding agent, and before choosing an opencode model, read [.agents/instructions/delegated-coding-agents.md](.agents/instructions/delegated-coding-agents.md).

## Test and Production Hosts

Before running, scheduling, or delegating any build, test, qualification, or deployment, or logging in to Hermes or the cloud server `84.247.157.41`, read [.agents/instructions/test-and-production-hosts.md](.agents/instructions/test-and-production-hosts.md). In short: never run Himawari tests on the MacBook.

## Test Trigger Timing

Before deciding which test layers to run, writing the test layers into a commit message, or adding a test, read [.agents/instructions/test-trigger-timing.md](.agents/instructions/test-trigger-timing.md). It defines Layers 0-5 and the `Layer-0-tests:` commit lines that the shared hooks enforce.

## Hermes Test Server Connectivity

- Run every Hermes command through `.ci-output/handoff/scripts/hermes-ssh.sh '<command>'` and every upload through `.ci-output/handoff/scripts/hermes-upload.sh <local file> <remote path>`; never call `ssh`, `scp`, `sftp`, or `rsync` to Hermes directly. The wrappers connect over Tailscale (`ProxyCommand=none`, `HostName=100.64.53.104`), check that the remote hostname is `hermes-home`, cap one call at 300 seconds, and allow only read-only commands while a guarded Layer 3 or Layer 4 run is in progress, because any other process on Hermes voids that run. The `hermes_direct_ssh_guard.py` PreToolUse hook refuses direct calls ([lesson](docs/lessons.md#measurement-not-isolated)). When Tailscale is unavailable, report it to the user instead of switching to the `hermes-ssh` skill's Cloudflare route by hand. Toolchain `PATH`, environment variables, `umask 022`, and code sync by `git bundle` are in the [test host operations Runbook](docs/runbooks/test-host-operations-runbook.md#live-state-preflight).
- New downloads, including a newer toolchain or bubblewrap, need the user's approval first. Do not edit code on the server.
- Do not change SSH configuration, credentials, the Cloudflare setup, firewall, or host-key verification to bypass a failure; report it to the user.

## Disk Space Hygiene

Before a full build, a full `npm test`, a product-path qualification, or a deployment, and before deleting build output, scratch, or evidence on the Mac or a test host, read [.agents/instructions/disk-space-hygiene.md](.agents/instructions/disk-space-hygiene.md).
