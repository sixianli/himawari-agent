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

The user decided on 2026-09-30 that every commit is pushed to the remote as soon as it is created; the rule is kept in [ADR 0047](docs/adr/0047-test-checkout-on-hermes-nvme.md), which supersedes ADR 0046 and its predecessors.

- Push each commit to the same-named branch on `origin` right after creating it, setting the upstream on the first push. This applies to Claude and Codex alike, including commits made during delegated tasks.
- Never force-push, rewrite pushed history, or bypass hooks. If a push is rejected or fails, stop and report the error.
- A pushed commit is not a fully tested commit. Commit messages must still state which test layers actually ran; Layer 3 runs before a PR or merge, not before each push.
- Creating branches or tags, opening PRs, and merging still require an explicit user request.

## Test and Production Hosts

The user decided on 2026-09-29 where tests run and where production lives. Testing moved to the cloud server `84.247.157.41` on 2026-10-01; on 2026-10-02 the user moved it back to Hermes and reserved the cloud server for production only; on 2026-10-04, after an NVMe-versus-`/data` comparison, test checkouts and their dependencies moved to the NVMe root disk. The current rules are in [ADR 0047](docs/adr/0047-test-checkout-on-hermes-nvme.md), which supersedes ADR 0046 and its predecessors.

- Never run Himawari tests on the user's MacBook. This includes builds, `npm run check`, `npm test`, any Vitest project, and product-path qualification. Use the MacBook only for editing, review, and commits. If a test, build, or qualification process is found running on the MacBook, stop it.
- Run Layers 0-3 and the Linux product path on Hermes, following "Hermes Test Server Connectivity" below. This decision authorizes routine test work there without asking each time. Anything that needs sudo or changes Hermes system settings or services goes to the user as an executable script with each step explained; the user runs it.
- Never run tests, builds, or qualification on the cloud server `84.247.157.41`; it is for production only. Leave its old test environment (the `himawari-test` account and `/srv/himawari-test/`) untouched: do not log in, change, or write to it until the user decides how to clean it up before the first production deployment. Keep bubblewrap 0.11.2 and its AppArmor profile there; production needs them.
- Keep the source checkout and its `node_modules` in a task-owned directory under the login account's home on the NVMe root disk (for example `~/himawari-tests/round2/source`, about 1 GiB); cold reads of tens of thousands of small files on the `/data` mechanical disk made first tests time out. Build and test output stays in the checkout's `.ci-output/` (the CI entry rejects output paths outside it with `CI_OUTPUT_OUTSIDE_RUN_DIRECTORY`); delete superseded builds there as soon as their results are recorded. Keep toolchains, browsers, logs, reports, and retained evidence in a task-owned directory on the `/data` mechanical disk (for example `/data/hermes/himawari/tool-audit-round2/`), copying retained reports and failure evidence there from `.ci-output/`. Delete the NVMe checkout when its task ends. Put scratch data created while tests run (SQLite files, sockets, product-path test installs, the test `TMPDIR`) on the NVMe root disk in a per-run directory created with `mktemp -d /tmp/hXXXX`; check that it is owned by the test account, has mode 0700, and resolves to itself, then pass it as both `HIMAWARI_TEST_TEMP_ROOT` and `TMPDIR`. Keep this root at 10 bytes: Unix socket paths are limited to 107 bytes on Linux, and the product-path fixture refuses longer roots. Delete only the `/tmp/h*` directories the run created. Before each run, check the root disk and do not start if less than 10 GiB is free; record the scratch directory's peak size and the lowest root free space; after the run, copy retained failure evidence into the task's evidence directory on `/data` and delete the scratch directory.
- Do not relax test time limits. Do not set `HIMAWARI_TEST_TIMEOUT_MS`; it is being removed per [BL-20261001-002](docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md). Treat a timeout on Hermes as a defect to diagnose and fix (user decision, 2026-10-02).
- Hermes also runs unrelated services, including the existing Himawari service under `/data/hermes/himawari/releases/`. Tests must not read or write their directories or data, or stop or restart them.
- Tests must not read or write production locations (such as `/opt/himawari`, `/etc/himawari`, `/var/lib/himawari`) or use production service accounts.
- Mac remains a supported product platform. Run Mac-specific verification (macOS sandbox, Mac installer, Mac bundled Bash, and other Mac-only runtime behavior) on the MacBook only when a change affects Mac-specific behavior or before a release, and only after the user approves that specific run, its scope, expected duration, and timing. On 2026-09-30 the user postponed all Mac verification indefinitely: do not schedule or propose a Mac run until the user brings it back, and report Mac behavior as unverified.
- Production runs on the cloud server `84.247.157.41`. Every production deployment, and every start or change of production services there, needs the user's explicit authorization for that deployment.
- Results from one platform never stand in for the other: Mac results do not verify Linux behavior, and Linux results do not verify Mac behavior. Hermes results (Ubuntu 22.04, bwrap 0.6.1, different hardware) do not verify production-server behavior (Ubuntu 24.04 with its AppArmor user-namespace restriction) for timing, concurrency, or sandbox conclusions; earlier cloud-server test results are historical record only.

## Test Trigger Timing

The user decided on 2026-09-29 how test layers are triggered during development; the current rules are in [ADR 0047](docs/adr/0047-test-checkout-on-hermes-nvme.md), which keeps the timing rules of ADR 0043 and changes only the host and storage. Run each layer on the host given in "Test and Production Hosts". These rules take precedence over any per-defect full-test requirement in task briefs written before that date.

- Layer 0, targeted tests (the reproducing test and directly related test files): run before changing production code to show the failure, then after every change.
- Layer 1, `npm run check`: before every commit.
- Layer 2, affected-module tests (the whole Vitest project containing the change, such as `unit`, plus integration test files that exercise the changed modules): when a defect or feature is stable and about to be committed. Each independent defect is still committed separately after Layers 0-2 pass.
- Layer 3, build plus the full `npm test`: once per delivery batch (a group of changes handed over together for review or acceptance, normally no more than three independent defects), before opening a PR or merging, and at the end of a work round. Run it for the individual change instead when it touches the SQLite schema or migrations, the Agent-Worker protocol, authentication, or handshake, build or packaging configuration, dependency manifests or lockfiles, or the test runner itself (Vitest configuration, `scripts/ci/`, `ci/policy.json`).
- Finish Layers 0-2 and a self-review before starting Layer 3. If Layer 3 fails, return to Layer 0, fix, pass Layers 0-2, then rerun Layer 3 once on the batch's final revision.
- Layer 4, the real product path (Linux on Hermes, installed under the test account's own directories; Mac only under the approval rule above): run only the affected scenarios when a change affects installation, upgrade, process management, or sandbox runtime behavior; run the unfiltered qualification only at the end of a work round or before a release.
- Layer 5, production deployment to `84.247.157.41`: only with the user's explicit authorization for each deployment.
- Documentation-only changes run documentation validation and Runbook checks only.
- Reuse passing results while code, dependencies, test configuration, and relevant environment are unchanged. Commit messages and delivery reports must state which layers actually ran and which revision the full test covered; never describe an intermediate commit as fully tested when it was not.
- These rules govern development testing only. The required GitHub CI checks in `ci/policy.json` are unchanged.

## Hermes Test Server Connectivity

- Connect as the `hermes-ssh` skill describes: use the Mac's existing SSH alias `hermes`, which goes through `cloudflared` and Cloudflare Access, for example `ssh -o BatchMode=yes -o ConnectTimeout=15 hermes '<command>'`. Check the exit code and that the remote hostname is `hermes-home`. When Cloudflare needs a browser login, ask the user to complete it, then retry the same command.
- Noninteractive SSH may not have the locked Node.js on `PATH`. Put the task's locked toolchain first, for example `PATH=/data/hermes/himawari/tool-audit-round2/r30/tools/bin:/usr/bin:/bin`, and set `HIMAWARI_CI_TOOLS`, `HIMAWARI_CI_PYTHON`, `PLAYWRIGHT_BROWSERS_PATH`, and `TMPDIR` to the task's directories. New downloads, including a newer toolchain or bubblewrap, need the user's approval first.
- Run tests with `umask 022`. The login account's default umask is `0002`, which makes test-created directories group-writable; the sandbox then refuses them as unsafe host paths (`SANDBOX_HOST_PATH_UNSAFE`), which failed about 100 tests on 2026-10-01 without any product defect.
- Sync code with `git bundle` and patches from the Mac; do not edit code on the server.
- Do not change SSH configuration, credentials, the Cloudflare setup, firewall, or host-key verification to bypass a failure; report it to the user.

## Disk Space Hygiene

Disk space is scarce on the development Mac and on the Hermes root disk (about 14 GiB free on 2026-10-02); the cloud server is reserved for production. Build, install, and test work in this project must not let unused artifacts accumulate.

- Check free space with `df -h` before a full build, a full `npm test`, a product-path qualification, or a deployment, and report it when it is below what the step needs.
- As soon as the verification that used them has finished and its results are recorded, delete rebuildable artifacts that nothing needs anymore. On the Mac this includes `build-macos-arm64/` and `public-build-macos-arm64/` package directories and tarballs under `.ci-output/`, finished product-path test installs under `/tmp/hma-pp-*`, and other temporary checkouts, `node_modules` copies, or packages the task created. On Hermes this includes superseded build directories under the task's `/data` directory, finished `/tmp/h*` scratch directories, and qualification copies left by failed or abandoned attempts.
- Before deleting anything, confirm that no running process, pending command, or unfinished task still uses it, and search the repository and `.ci-output/` recursively for the path or directory name. Keep it when a document, handoff file, evidence README, or test report says it is retained evidence, is needed to inspect an open failure, or is the only copy of recorded results. A report that merely records a rebuildable package's path and SHA-256 as the tested input does not make the package itself evidence; the recorded commit and digest are enough to rebuild and verify it. Delete only artifacts that the current task or an earlier test run created; do not delete user-owned files.
- Always keep: test reports, console and service logs, database or state readbacks, traces, screenshots, and any other verification evidence; everything referenced as evidence by documents or handoff files; backups and recovery points; any production release on the cloud server and at least the release immediately before it for rollback.
- Prefer deleting artifacts that can be rebuilt from a commit over deleting evidence. When evidence itself must be reduced, ask first.
- On the cloud server, deleting root-owned paths (for example production paths under `/opt/himawari/` or `/etc/himawari/`) follows the user-run script process: give the user an executable script, explain exactly what each command deletes and why, and wait for the user to run it.
- When the task ends, report which paths were deleted, how much space was freed, and which large artifacts were intentionally kept and why.
