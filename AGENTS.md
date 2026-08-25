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

## Repository Boundary

- Product code and product documentation belong in this repository.
- The sibling `pi-mono` repository is an upstream source reference and debugging checkout.
- Do not place Himawari-specific product logic in `pi-mono`.

## Workspace Contract

- Require Node.js `>=22.19.0` and use the committed npm lockfile for reproducible installs.
- Keep all direct external dependency versions exact; do not introduce ranges for direct dependencies.
- Preserve the dependency directions documented in `docs/architecture-v0.1.md` and run `npm run check:boundaries` after changing manifests or imports.
- Import `@earendil-works/pi-*` packages only from `packages/runtime-pi`; product domain, contracts, application code and entrypoints depend on product-owned types.
- Keep published Pi dependencies in committed manifests and lockfiles. Local `../pi-mono` source linking must be opt-in, reversible and must not change committed dependency declarations.
- Use `*.unit.test.ts`, `*.contract.test.ts`, `test/integration/**/*.test.ts`, `test/e2e/**/*.test.ts` and `*.compat.test.ts` for the configured Vitest projects.
- Run `npm run check` and the smallest relevant test projects before committing code changes.
