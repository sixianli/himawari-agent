# Himawari Agent Project Instructions

## Documentation Governance

This repository explicitly adopts the `document-governance` skill for all governed project documentation under `docs/`.

## Project Instruction Commits

- Changes to this project-level `AGENTS.md` may be committed separately after review and applicable checks, without asking the user for confirmation. Stage only this file in such a commit and preserve unrelated work. This does not authorize pushing or other remote changes.

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

## Test and Production Hosts

The user decided on 2026-09-29 where tests run and where production lives; the rationale is in [ADR 0041](docs/adr/0041-test-hosts-and-production-server.md).

- Never run Himawari tests on the user's MacBook. This includes builds, `npm run check`, `npm test`, any Vitest project, and product-path qualification. Use the MacBook only for editing, review, and commits. If a test, build, or qualification process is found running on the MacBook, stop it.
- Run Layers 0-3 and the Linux product path on Hermes over SSH, following "Hermes Connectivity" below. Keep checkouts, dependencies, builds, logs, and test installs in a task-owned directory under `/data`. This decision authorizes routine test work on Hermes; sudo and changes to Hermes services still require a user-run script.
- Mac remains a supported product platform. Run Mac-specific verification (macOS sandbox, Mac installer, Mac bundled Bash, and other Mac-only runtime behavior) on the MacBook only when a change affects Mac-specific behavior or before a release, and only after the user approves that specific run, its scope, expected duration, and timing.
- Production runs on the cloud server `84.247.157.41`. Every deployment or change there is a production operation and needs the user's explicit authorization for that deployment. Ask the user for access details instead of probing the host.
- Results from one platform never stand in for the other: Mac results do not verify Linux behavior, and Linux results do not verify Mac behavior.

## Test Trigger Timing

The user decided on 2026-09-29 how test layers are triggered during development; the rationale is in [ADR 0041](docs/adr/0041-test-hosts-and-production-server.md), which supersedes ADR 0038 and keeps its timing rules. Run each layer on the host given in "Test and Production Hosts". These rules take precedence over any per-defect full-test requirement in task briefs written before that date.

- Layer 0, targeted tests (the reproducing test and directly related test files): run before changing production code to show the failure, then after every change.
- Layer 1, `npm run check`: before every commit.
- Layer 2, affected-module tests (the whole Vitest project containing the change, such as `unit`, plus integration test files that exercise the changed modules): when a defect or feature is stable and about to be committed. Each independent defect is still committed separately after Layers 0-2 pass.
- Layer 3, build plus the full `npm test`: once per delivery batch (a group of changes handed over together for review or acceptance, normally no more than three independent defects), before push, PR, or merge, and at the end of a work round. Run it for the individual change instead when it touches the SQLite schema or migrations, the Agent-Worker protocol, authentication, or handshake, build or packaging configuration, dependency manifests or lockfiles, or the test runner itself (Vitest configuration, `scripts/ci/`, `ci/policy.json`).
- Finish Layers 0-2 and a self-review before starting Layer 3. If Layer 3 fails, return to Layer 0, fix, pass Layers 0-2, then rerun Layer 3 once on the batch's final revision.
- Layer 4, the real product path (Linux on Hermes; Mac only under the approval rule above): run only the affected scenarios when a change affects installation, upgrade, process management, or sandbox runtime behavior; run the unfiltered qualification only at the end of a work round or before a release.
- Layer 5, production deployment to `84.247.157.41`: only with the user's explicit authorization for each deployment.
- Documentation-only changes run documentation validation and Runbook checks only.
- Reuse passing results while code, dependencies, test configuration, and relevant environment are unchanged. Commit messages and delivery reports must state which layers actually ran and which revision the full test covered; never describe an intermediate commit as fully tested when it was not.
- These rules govern development testing only. The required GitHub CI checks in `ci/policy.json` are unchanged.

## Hermes Connectivity

- For authorized Hermes work, prefer `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 hermes-tailscale-breakglass`. This existing SSH alias connects as `andy` to the Tailscale address `100.64.53.104` (`hermes-home`); successful access was verified on 2026-09-21.
- The `hermes`, `hermes-home`, and `hermes-cloudflare` SSH aliases currently use Cloudflare Access through `ssh-hermes.sinimite.work`. A timeout on that route does not establish that Hermes is offline. Inspect `ssh -G <alias>` and try the existing Tailscale route before asking the user about connectivity. If the Tailscale alias is unavailable, use `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 andy@100.64.53.104` with the existing credentials and host-key checks.
- Diagnose configured routes autonomously within the authorized task. Ask the user only if available routes fail and a concrete network or access change requires their action; do not change SSH configuration, credentials, Tailscale settings, or host-key verification to bypass a failure.
- Before substantial writes, read `/Users/triggerjames/.codex/references/hermes-operations.md` and verify `/data` with `findmnt` and `df`. Keep test checkouts, dependencies, build artifacts, and logs in a task-owned directory on that mounted data disk. Recheck runtime paths: noninteractive SSH may not have Node.js on `PATH`.

## Disk Space Hygiene

Disk space is scarce on both the development Mac and Hermes (the Hermes root disk that holds `/opt` had about 11 GiB free on 2026-09-28, and Hermes qualification requires more than 10 GiB free on `/opt`). Build, install, and test work in this project must not let unused artifacts accumulate.

- Check free space with `df -h` before a full build, a full `npm test`, a product-path qualification, or a Hermes deployment, and report it when it is below what the step needs.
- As soon as the verification that used them has finished and its results are recorded, delete rebuildable artifacts that nothing needs anymore. On the Mac this includes `build-macos-arm64/` and `public-build-macos-arm64/` package directories and tarballs under `.ci-output/`, finished product-path test installs under `/tmp/hma-pp-*`, and other temporary checkouts, `node_modules` copies, or packages the task created. On Hermes this includes superseded build directories under `/data/hermes/himawari/builds/` and candidate releases or qualification copies left by failed or abandoned attempts.
- Before deleting anything, confirm that no running process, pending command, or unfinished task still uses it, and search the repository and `.ci-output/` recursively for the path or directory name. Keep it when a document, handoff file, evidence README, or test report says it is retained evidence, is needed to inspect an open failure, or is the only copy of recorded results. A report that merely records a rebuildable package's path and SHA-256 as the tested input does not make the package itself evidence; the recorded commit and digest are enough to rebuild and verify it. Delete only artifacts that the current task or an earlier test run created; do not delete user-owned files.
- Always keep: test reports, console and service logs, database or state readbacks, traces, screenshots, and any other verification evidence; everything referenced as evidence by documents or handoff files; backups and recovery points; the live Hermes release under `/opt/himawari/releases/` and at least the release immediately before it for rollback.
- Prefer deleting artifacts that can be rebuilt from a commit over deleting evidence. When evidence itself must be reduced, ask first.
- On Hermes, deleting root-owned paths (for example under `/opt/himawari/releases/` or `/etc/himawari/`) follows the existing sudo process: give the user an executable script, explain exactly what each command deletes and why, and wait for the user to run it.
- When the task ends, report which paths were deleted, how much space was freed, and which large artifacts were intentionally kept and why.
