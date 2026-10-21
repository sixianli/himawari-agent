# Himawari Agent Project Instructions

## Documentation Governance

This repository explicitly adopts the `document-governance` skill for all governed project documentation under `docs/`.

## Code and Documentation Consistency

The user asked on 2026-09-29 that code and documentation never drift apart. Documentation drift already happened once: commit `51fe7f6` changed `apps/control-center/src` without resealing `docs/runbooks/hermes-control-center-upgrade-runbook.md`, and strict validation failed from then on.

- Every commit that changes behavior, interfaces, configuration, tests' required environment, or operational steps updates the affected documentation in the same commit: specs, plans, the architecture document, Runbooks, Backlog items, and ADR follow-up (supersede an ADR instead of rewriting it). If no document is affected, say so in the delivery notes with the reason.
- Before every commit, run strict documentation validation, for example `python3 <document-governance skill>/scripts/validate_docs.py . --strict`. A commit must not introduce a new validation error. When a change touches a Runbook's contract sources, review the Runbook against the new code, then reseal it with `runbook.py seal ... --confirm-reconciled --apply` in the same commit.
- Documentation validation and Runbook checks are read-only scripts that finish in seconds; they may run on the MacBook. This does not extend to builds or tests.
- When fixing a defect, also correct documentation that describes the old behavior. When a document records a decision, keep its status fields and links current.
- Commit messages and delivery reports list the documents updated and the result of strict validation.

## Repeated Mistakes

The rule is in [ADR 0060](docs/adr/0060-hard-constraint-on-third-repeat.md): when the same mistake happens for the third time, by Claude or by any agent it directs, stop the current work, find why the earlier prevention failed, and add a hard constraint (an automated test, a commit or CI gate, a check a script runs on every use, a deny rule, a hook or plugin, or a refusal in the host wrappers) that blocks the mistake for every agent alike. Prove it by showing it fail on a reproduction and pass once the mistake is removed; when it needs a change only the user can make, prepare it, ask, and keep that mistake's work paused. A single mistake needs no record.

- Count occurrences across sessions and agents with `docs/lessons.md`, handoff files, stop files, and commit messages as the history. A session handoff names any mistake that has happened twice.
- Record the result where it belongs: a mistake coding agents repeat, with its constraint, in `docs/lessons.md` (extend an existing entry when one covers it; an entry that reached three occurrences names its constraint and where it runs); a way of briefing, reviewing, or driving opencode and Grok in the `opencode-orchestration` skill; a product defect fixed in the task or filed as a Backlog item; a change to how a test, deployment, or operation runs in its Runbook, plan, or spec; a user preference about how Claude works in Claude's memory.
- Delivery reports name the root cause found and where it was recorded.

## Project Instruction Commits

- Changes to this project-level `AGENTS.md` may be committed separately after review and applicable checks, without asking the user for confirmation. Stage only this file in such a commit and preserve unrelated work. Push it like every other commit (see "Pushing Commits" below).

## Documentation Language and Clarity

- Keep this `AGENTS.md` entirely in English. Write all other project documentation content in Simplified Chinese.

## Document Readability and Navigation

- When creating or revising project documentation, provide convenient navigation links wherever practical. Place a clickable table of contents or review summary at the beginning of long documents; do not add unnecessary structure solely for navigation in short documents.
- When referring to sections within the same document, use internal links with descriptive section titles rather than bare references such as "Sections 2 and 9" or "5.1 and 5.4". References to detailed rules in summary tables should also link directly to the relevant sections.
- Where useful, provide "Back to contents" or "Back to review summary" links in longer sections reached from the table of contents or review summary, so readers can easily navigate back and forth.
- When referring to other project documents, use meaningful link text and repository-relative paths. Link to the relevant section whenever practical if a specific passage is intended. Preserve the SOURCE markers required by documentation governance; navigation links must not replace source declarations.
- Use heading anchors or explicit anchors supported by the target Markdown reader. Update related links when headings, sections, or paths change. Before delivery, check that targets exist and anchors are unique; do not claim that navigation works in the reader unless it has been verified by actually clicking the links.
- Improve navigation incrementally within the scope of the current documentation task. Do not rewrite unrelated documents or reorganize historical content in bulk merely to add links.

## Approved Web Design Baselines

- Before changing the control center's visual design, chat interactions, or brand assets, read the [current v4 interaction and visual baseline](docs/execution/specs/2026-09-15-control-center-v4-design.md) and the [original logo baseline](docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md), and open the interactive prototypes and visual mockups referenced in them.
- `assets/brand/himawari/v1/` and `docs/assets/control-center/2026-09-10-v1/` preserve the original design approved by the user on 2026-09-10. Check subsequent implementations against these references for layout, themes, per-turn execution processes, and tool displays; do not overwrite the baseline files. When the user approves a design change, save it as a new version and update the documentation references.
- The current chat page must follow the frozen prototype in `docs/assets/control-center/2026-09-15-v4/`, plus the execution environment status line and sidebar running marker approved on 2026-09-27 in `docs/assets/control-center/2026-09-27-v5/`; retain v1 as a historical reference and the source for brand assets. Changes must not reintroduce a standalone approval entry point, a general-purpose details sidebar, or conversation deletion actions.
- Messages, models, thinking summaries, tool outputs, timings, and approvals in the prototypes are all demonstration data. They are not evidence that production features have been implemented or that real execution has succeeded.

## Code Comments

- Never write code comments, and delete the existing comments in every file you edit (user decision G149, 2026-10-21: comments mislead the model). Express intent through naming, structure, and tests; put rationale and verification evidence in commit messages and delivery notes. Keep only what is not a comment in effect: shebang lines, tool directives (`eslint-disable`, `biome-ignore`, `noqa`, `type: ignore`, `/// <reference>`, `@ts-expect-error` and the like), and license or copyright headers that must stay; never touch third-party, vendored, or generated code for this. Cleaning files that a task does not otherwise edit is a task of its own. This applies to Claude, opencode, and every other agent; see [the lesson on new code comments](docs/lessons.md#new-code-comments).

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

Every commit is pushed to the remote as soon as it is created (user decision 2026-09-30, kept by [ADR 0057](docs/adr/0057-batch-layers-one-two-for-small-defects.md#unchanged)).

- Push each commit to the same-named branch on `origin` right after creating it, setting the upstream on the first push. This applies to Claude, Codex, and opencode alike, including commits made during delegated tasks.
- Never force-push, rewrite pushed history, or bypass hooks. If a push is rejected or fails, stop and report the error.
- A pushed commit is not a fully tested commit. Commit messages must still state which test layers actually ran; Layer 3 runs before a PR or merge, not before each push.
- Creating branches or tags, opening PRs, and merging still require an explicit user request.

## Delegated Coding Agents

The roles are in [ADR 0062](docs/adr/0062-claude-writes-complex-code-opencode-routine.md) (which keeps the unchanged parts of [ADR 0058](docs/adr/0058-agent-collaboration-and-review-roles.md)) and the model rules in [ADR 0061](docs/adr/0061-opencode-model-table.md); this section lists what every agent must obey. The decisions' history is in those ADRs and in `.agents/tasks/round2-tool-execution/goal.md`.

- Work is split by the nature of the code (G148, 2026-10-21): opencode writes the routine code whose approach every programmer knows (tests for a settled design, mechanical edits, scripts, fixtures, running verification and collecting evidence), including uncommitted operation packet tools and production entry scripts; Claude writes the code that needs architectural judgment (complex modules, abstraction layers, protocol and cross-process contracts, authority and sandbox code) and decides, with the reason in the brief or commit message, when a task is not clearly one or the other. Claude also plans, writes briefs, dispatches, reviews every opencode change line by line, compares proposals and decides, runs or schedules verification, commits, pushes, and keeps records. Claude runs mechanical scripts itself; only operations that need the user's authorization go to the user.
- Each side reviews only the other's code: opencode reviews every line of code, tests, and scripts Claude writes, Claude reviews everything opencode writes, and an author's review of their own work never counts. This includes uncommitted operation packet tools and production entry scripts, reviewed before they are frozen or run. Any code Claude wrote also runs the same test layers on the same hosts. Documents and briefs are outside this rule and go through documentation validation; Claude may still ask opencode to review a document it wrote. A long-task review record (`longtask.py record --review`) names the reviewing side in `--by`.
- Before settling a design or a fix, Claude asks an opencode DeepSeek V4.1 Flash session for an independent proposal, compares it with its own, and records in the plan or commit message which ideas were taken and why. When several models are asked for independent proposals, ask only free models; when both are rate-limited, ask `opencode-go/deepseek-v4.1-flash` alone and do not open a second Go session on `opencode-go/glm-5.3-flash`. When neither side can settle it, bring the options and a recommendation to the user; collect decisions that already need the user (production deployments and frozen packets, new downloads, reducing evidence, sudo changes) and ask once. opencode never talks to the user; Claude answers its stop files within the authority described in the `opencode-orchestration` skill.
- Model choice for opencode follows [ADR 0061](docs/adr/0061-opencode-model-table.md): the allowed models, their order, variants and context limits live in the table `.agents/opencode-models.toml`, and `python3 .agents/opencode-models.py export --all` regenerates the launcher's allowlist from it (`check --all` verifies they agree, `order` prints the switch order); a new session starts on the first free model in the table and moves on only after a second HTTP 429 from both free models about 30 seconds after the first, when a free model is withdrawn or unavailable, or when the task needs more than about 200K tokens of context (then skip the models the table marks `skip_for_context`); the reasoning variant (`#low` or `#high`; the Go DeepSeek model also offers `#max`, and no model offers `#medium`) is chosen per new session by difficulty and not changed inside a session; after two failures of the same task on DeepSeek V4.1 Flash, the GLM escalation and return to the default follow ADR 0059; report one line per new session with the model ID, the variant, the Tokyo time (`TZ=Asia/Tokyo date '+%a %H:%M'`; DeepSeek peak hours are 10:00-12:59 and 15:00-18:59 on weekdays), and the reason. The generated, uncommitted `.opencode/allowed-models.txt` is what `oc-launch.sh` reads; it refuses any other model. When the Go allowance is used up only the free models remain; when they fail too, stop and tell the user; never turn on Extra Usage or buy allowance. Grok runs only through the user's own Grok subscription via the `grok-build` plugin (how: the `opencode-orchestration` skill's `references/grok.md`) and is paused until the user resumes it; `opencode-go/grok-*` and `opencode/grok-*` are forbidden.
- opencode and Grok follow every rule in this file: tests only on Hermes or as `himawari-ci` on the cloud server `84.247.157.41`, never on the MacBook; no other login to the cloud server; no production commands; no reading of secrets; commit and push rules unchanged. Production steps of a deployment (the frozen packet, user-run scripts, and anything on `84.247.157.41`) stay with Claude and the user and are never delegated.
- The local tooling (the deny lists in the uncommitted `.opencode/opencode.json` and `.grok/config.toml`, the `wait-guard` plugin and `required-plugins.txt`, the Hermes and cloud wrappers `hermes-ssh.sh`, `hermes-upload.sh`, `hermes-wait.sh`, `ci-ssh.sh`, `ci-upload.sh`, their refusal codes 67-71, the detached-start form, and the launcher's refusals) is described in the [agent tooling Runbook](docs/runbooks/agent-tooling-runbook.md). The boundaries: opencode and Grok reach the test hosts only through those wrappers (always `himawari-ci` on the cloud server), start anything longer than a few minutes detached with `setsid -f` and wait with `hermes-wait.sh`, never match processes by command-line text, never write standard input to a remote file, and never mask a pipeline's exit status; a brief that names text a deny rule matches carries a `本地禁止规则：` line, and a read-only brief carries `只读任务：是`. Claude's local commands get the same pipeline check from the `PreToolUse` hook `~/.claude/hooks/zsh_word_guard.py`.
- The free DeepSeek model may train on request data; the user agreed on 2026-10-15 that this project's requests may be used for training and turned the setting on in the opencode console. `opencode/glm-5.3-flash-free` does not retain or train on requests according to opencode.

## Test and Production Hosts

The rules are in [ADR 0057](docs/adr/0057-batch-layers-one-two-for-small-defects.md), which keeps every host rule of [ADR 0056](docs/adr/0056-cloud-server-also-test-host.md); the step-by-step procedure (connection, directory layout, scratch root, run mode, monitoring, cleanup) is the [test host operations Runbook](docs/runbooks/test-host-operations-runbook.md). The earlier moves between hosts and the one-time acceptance exceptions for the first three production deployments (G51, G65, G75) are recorded in the superseded ADRs 0041-0047 and 0049-0052 and are history, not standing permissions. The hard boundaries:

- Never run Himawari tests on the user's MacBook: no builds, `npm run check`, `npm test`, any Vitest project, or product-path qualification. Use the MacBook only for editing, review, and commits; stop any such process found running there.
- Run Layers 0-4 on Hermes or on the cloud server `84.247.157.41` as the ordinary account `himawari-ci` (uid 1001, no sudo) under `/srv/himawari-ci/`; routine test work there needs no further asking. Never use root or production accounts, never read production secrets, never touch `/opt/himawari`, `/etc/himawari`, `/var/lib/himawari` or the production service (no stop, restart, or requests). Anything that needs sudo or changes Hermes system settings or services goes to the user as an executable script with each step explained.
- On the cloud server, watch `himawari-prod.service` before, every 30 seconds during, and after each heavy run with read-only queries; if it stops being `active`, its restart count rises, or the test account records an `oom_kill`, stop the run at once, keep the records, and tell the user; never raise the limit.
- `himawari-ci` results never replace a production deployment's limited host acceptance or signing. A fourth or later deployment has no standing acceptance exception: its frozen operation packet (installation, users/permissions, signing, acceptance, cleanup, service startup) needs the user's own authorization.
- Keep checkouts on the NVMe root disk, test output in the checkout's `.ci-output/`, evidence on `/data`, and scratch in a 10-byte `mktemp -d /tmp/hXXXX` root passed as `HIMAWARI_TEST_TEMP_ROOT` and `TMPDIR`; run with `umask 022`; give the root-disk space back after every run and explain any shortfall. Details and reasons: the Runbook.
- Every comparison measurement starts with `.ci-output/handoff/scripts/require-quiet-host.sh hermes|cloud` and runs only after `QUIET_HOST_OK`; Claude rejects comparison results whose evidence lacks that line.
- Do not relax test time limits and do not set `HIMAWARI_TEST_TIMEOUT_MS`; a timeout on a test host is a defect to diagnose and fix.
- Hermes also runs unrelated services, including the existing Himawari service under `/data/hermes/himawari/releases/`; tests must not read or write their directories or data, or stop or restart them.
- Mac remains a supported product platform, but the user postponed all Mac verification indefinitely on 2026-09-30: do not schedule or propose a Mac run until the user brings it back, and report Mac behavior as unverified. When it returns, Mac-specific verification (macOS sandbox, Mac installer, Mac bundled Bash, and other Mac-only runtime behavior) runs on the MacBook only when a change affects Mac-specific behavior or before a release, and only after the user approves that specific run, its scope, expected duration, and timing.
- Production runs on the cloud server `84.247.157.41`; every production deployment and every start or change of production services there needs the user's explicit authorization for that deployment.
- Results from one platform never stand in for another: Mac and Linux do not verify each other; Hermes (Ubuntu 22.04, bwrap 0.6.1) does not verify the production server (Ubuntu 24.04 with its AppArmor user-namespace restriction) for timing, concurrency, or sandbox conclusions; `himawari-ci` results show the test account's own install on Ubuntu 24.04, not a verified production installation, and cloud-server test results from before 2026-10-14 are historical record only.

## Test Trigger Timing

The current rules are in [ADR 0057](docs/adr/0057-batch-layers-one-two-for-small-defects.md#batch-layers). Run each layer on the host given in "Test and Production Hosts". These rules take precedence over any per-defect full-test requirement in task briefs written before 2026-09-29.

- Layer 0, targeted tests (the reproducing test and directly related test files): run before changing production code to show the failure, then after every change.
- Layer 1, `npm run check`: before every commit; for a delivery batch of independent defects, once on the top of the stacked batch (see Layer 2).
- Layer 2, affected-module tests (the whole Vitest project containing the change, such as `unit`, plus integration test files that exercise the changed modules): when a defect or feature is stable and about to be committed. Each independent defect is still committed separately after its own Layer 0 run. When a delivery batch holds more than one independent defect, Layers 1-2 run once on the top of the fully stacked batch, and the defects are then committed in order; if Layers 1-2 fail, return to the failing defect's Layer 0, fix it, and rerun Layers 1-2 on the new top. Each commit message names the revision Layers 1-2 ran on and says the commit itself did not run them alone. A batch of one defect or feature runs Layers 1-2 before its commit.
- Layer 3, build plus the full `npm test`: once per delivery batch (a group of changes handed over together for review or acceptance, normally no more than three independent defects), before opening a PR or merging, and at the end of a work round. Run it for the individual change instead when it touches the SQLite schema or migrations, the Agent-Worker protocol, authentication, or handshake, build or packaging configuration, dependency manifests or lockfiles, or the test runner itself (Vitest configuration, `scripts/ci/`, `ci/policy.json`).
- Finish Layers 0-2 and a self-review before starting Layer 3. If Layer 3 fails, return to Layer 0, fix, pass Layers 0-2, then rerun Layer 3 once on the batch's final revision.
- Layer 4, the real product path (Linux on Hermes, installed under the test account's own directories; Mac only under the approval rule above): run only the affected scenarios when a change affects installation, upgrade, process management, or sandbox runtime behavior; run the unfiltered qualification only at the end of a work round or before a release.
- Layer 5, production deployment to `84.247.157.41`: only with the user's explicit authorization for each deployment.
- Documentation-only changes run documentation validation and Runbook checks only.
- Reuse passing results while code, dependencies, test configuration, and relevant environment are unchanged. Commit messages and delivery reports must state which layers actually ran and which revision the full test covered; never describe an intermediate commit as fully tested when it was not.
- These rules govern development testing only. The required GitHub CI checks in `ci/policy.json` are unchanged.
- Before adding a test, answer the six test-value questions; keep tests within the speed and isolation budgets; storage, recovery, and model-facing changes carry the tests [ADR 0063](docs/adr/0063-test-value-gate-speed-budget-hygiene.md) names; the rules themselves are the `verification-discipline` skill's, and the hygiene gate is Backlog BL-20261021-001.

## Hermes Test Server Connectivity

- Connect over Tailscale first: `ssh -o BatchMode=yes -o ConnectTimeout=20 -o ProxyCommand=none -o HostName=100.64.53.104 hermes '<command>'`; fall back to the `hermes-ssh` skill's Cloudflare route (`ssh -o BatchMode=yes -o ConnectTimeout=15 hermes '<command>'`) only when Tailscale is unavailable. On either route check the exit code and that the remote hostname is `hermes-home`. Toolchain `PATH`, environment variables, `umask 022`, and code sync by `git bundle` are in the [test host operations Runbook](docs/runbooks/test-host-operations-runbook.md#live-state-preflight).
- New downloads, including a newer toolchain or bubblewrap, need the user's approval first. Do not edit code on the server.
- Do not change SSH configuration, credentials, the Cloudflare setup, firewall, or host-key verification to bypass a failure; report it to the user.

## Disk Space Hygiene

Disk space is scarce on the development Mac and on the Hermes root disk, which is shared with Hermes's other services; the cloud server is reserved for production. The cleanup procedure, what counts as evidence, and the user-run-script process for root-owned paths are in the [test host operations Runbook](docs/runbooks/test-host-operations-runbook.md#evidence). The boundaries:

- Check free space with `df -h` before a full build, a full `npm test`, a product-path qualification, or a deployment, and report it when it is below what the step needs.
- Delete rebuildable artifacts as soon as the verification that used them is recorded (on the Mac: `build-macos-arm64/` and `public-build-macos-arm64/` package directories and tarballs under `.ci-output/`, finished `/tmp/hma-pp-*` installs, temporary checkouts and `node_modules` copies; on Hermes: superseded builds, finished `/tmp/h*` scratch, abandoned qualification copies). Before deleting, confirm nothing still uses the path and search the repository and `.ci-output/` for it; keep anything a document, handoff file, evidence README, or test report names as retained evidence or as the only record of an open failure. A report that records a rebuildable package's path and SHA-256 does not make the package evidence. Delete only what the current task or an earlier test run created, never user-owned files.
- Always keep test reports, logs, state readbacks, traces, screenshots, everything referenced as evidence, backups and recovery points, and on the cloud server every production release plus the one before it. Prefer deleting rebuildable artifacts over evidence; ask before reducing evidence.
- Capture failure evidence deliberately, never by packing whole directories (see [the lesson on bulky evidence](docs/lessons.md#bulky-evidence)); task briefs for coding agents repeat this rule.
- When the task ends, report which paths were deleted, how much space was freed, and which large artifacts were intentionally kept and why.
