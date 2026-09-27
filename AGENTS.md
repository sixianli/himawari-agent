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

## Hermes Connectivity

- For authorized Hermes work, prefer `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 hermes-tailscale-breakglass`. This existing SSH alias connects as `andy` to the Tailscale address `100.64.53.104` (`hermes-home`); successful access was verified on 2026-09-21.
- The `hermes`, `hermes-home`, and `hermes-cloudflare` SSH aliases currently use Cloudflare Access through `ssh-hermes.sinimite.work`. A timeout on that route does not establish that Hermes is offline. Inspect `ssh -G <alias>` and try the existing Tailscale route before asking the user about connectivity. If the Tailscale alias is unavailable, use `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 andy@100.64.53.104` with the existing credentials and host-key checks.
- Diagnose configured routes autonomously within the authorized task. Ask the user only if available routes fail and a concrete network or access change requires their action; do not change SSH configuration, credentials, Tailscale settings, or host-key verification to bypass a failure.
- Before substantial writes, read `/Users/triggerjames/.codex/references/hermes-operations.md` and verify `/data` with `findmnt` and `df`. Keep test checkouts, dependencies, build artifacts, and logs in a task-owned directory on that mounted data disk. Recheck runtime paths: noninteractive SSH may not have Node.js on `PATH`.
