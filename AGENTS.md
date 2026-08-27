# Himawari Agent Project Instructions

## Documentation Governance

This repository explicitly adopts the `document-governance` skill for all governed project documentation under `docs/`.

- Product scope and business rules belong in the PRD.
- Current implemented system truth belongs in Architecture.
- Durable technical decisions belong in one-decision ADRs.
- Confirmed change design belongs in Specs.
- Implementation sequencing begins only after the source Spec is confirmed.
- Operational procedures belong in active Runbooks.
- Persistent future work belongs in Backlog; do not create `docs/TODO.md`.
- Use the skill templates and validation scripts for creation, reconciliation, closure, supersession, and archival.
- Keep code and affected current-truth documentation consistent in the same authorized change set.

## Documentation Language and Clarity

- Write all project documentation content in Simplified Chinese.
- Avoid ambiguous technical jargon; use clear, plain-language wording instead.

## Development Effort and Time

- This project is developed end-to-end by AI Coding Agents. Treat developer workload, labor cost, and implementation time as non-material constraints when making design decisions.
- Optimize for long-term system quality. Prefer robust, comprehensive, maintainable, and extensible designs over temporary workarounds, shortcuts, or minimum implementations.
- When a stronger long-term design requires broader foundational work, prefer it when the added complexity is technically justified.

## Repository Boundary

- Product code and product documentation belong in this repository.
- The sibling `pi-mono` repository is an upstream source reference and debugging checkout.
- Do not place Himawari-specific product logic in `pi-mono`.

## Pi-First Development Principle

- Himawari is built on Pi Coding Agent and the other reusable modules in `pi-mono`. Before designing or implementing any capability related to model connections, providers, routing, streaming, model runtime, Agent Loop, tools, sessions, or extensions, inspect the current `pi-mono` source and the pinned `@earendil-works/pi-*` API first.
- Reuse, compose, configure, or minimally adapt an existing Pi capability whenever it already satisfies the requirement. Do not reimplement a Pi module or protocol in Himawari merely to create a product-local version.
- Himawari-owned code should add product-specific concerns that Pi does not own, such as authority and approval, data classification and disclosure, secret handles and host secret sources, protected Payloads, durable state and audit, product-level model selection/fallback policy, budget enforcement, and Gateway/Worker/Memory integration.
- Before keeping a duplicate implementation, record the exact Pi capability that is missing, verify that a thin adapter or an upstream-compatible extension cannot satisfy the requirement, and explain why the duplicate is necessary. Prefer a Pi adapter or a small upstream extension over a second protocol implementation.
- Every design or code review for a Pi-related capability must include a reuse map: which Pi module is reused, which boundary Himawari owns, and why any remaining Himawari code is not duplicating Pi behavior.

## Workspace Contract

- Require Node.js `>=22.19.0` and use the committed npm lockfile for reproducible installs.
- Keep all direct external dependency versions exact; do not introduce ranges for direct dependencies.
- Preserve the dependency directions documented in `docs/architecture-v0.1.md` and run `npm run check:boundaries` after changing manifests or imports.
- Import `@earendil-works/pi-*` packages only from `packages/runtime-pi`; product domain, contracts, application code and entrypoints depend on product-owned types.
- Keep published Pi dependencies in committed manifests and lockfiles. Local `../pi-mono` source linking must be opt-in, reversible and must not change committed dependency declarations.
- Use `*.unit.test.ts`, `*.contract.test.ts`, `test/integration/**/*.test.ts`, `test/e2e/**/*.test.ts` and `*.compat.test.ts` for the configured Vitest projects.
- Run `npm run check` and the smallest relevant test projects before committing code changes.

## others

+ Hermes is a Linux host on the user's home network and can be accessed directly with the `ssh Hermes` command. It is trusted and secure, so there is no need to worry about its security.
