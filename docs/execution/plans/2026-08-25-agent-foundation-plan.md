---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# Himawari Agent 基础平台 Implementation Plan

**Source Spec:** [SOURCE: docs/execution/specs/2026-08-25-agent-foundation-design.md]

**Goal:** 建立独立、无头、单一逻辑权威的 Himawari Agent 基础平台，并以确定性适配器贯通“牛肉餐厅”端到端架构基准。

**Architecture:** 使用 TypeScript 与 Node.js workspace monorepo。领域和应用层只依赖产品端口，Pi、存储、模型、记忆、能力执行和 Gateway 都位于适配器侧；产品状态是唯一权威，Pi Session 是每次 Run 的可重建运行时投影。本地配置允许可信组件同进程组合，不可信执行和秘密边界保持可分离。

---

## File Boundaries

### Create

- Root workspace and engineering controls:
  - `package.json`
  - `package-lock.json`
  - `tsconfig.json`
  - `tsconfig.base.json`
  - `vitest.workspace.ts`
  - `biome.json`
  - `.gitignore`
  - `README.md`
- Deployable applications:
  - `apps/agent-service/`
  - `apps/execution-worker/`
- Product packages:
  - `packages/domain/`
  - `packages/application/`
  - `packages/gateway-contracts/`
  - `packages/execution-contracts/`
  - `packages/runtime-pi/`
  - `packages/platform-node/`
  - `packages/testing/`
- Local source-learning support:
  - `scripts/check-local-pi.mjs`
  - `scripts/link-local-pi.mjs`
  - `scripts/unlink-local-pi.mjs`
- Current-truth documentation after implementation exists:
  - `docs/architecture-v0.1.md`

### Modify

- `AGENTS.md` for code, validation and repository-boundary rules discovered during implementation.
- `README.md` as verified setup and architecture entrypoint.
- Accepted ADRs only for non-semantic link or status repairs; new decisions require new ADRs.
- Source Spec only when implementation discovers a genuine design conflict and the user confirms reconciliation.
- This Plan for progress evidence and closure status.

### Test

- `packages/domain/test/`
- `packages/application/test/`
- `packages/gateway-contracts/test/`
- `packages/execution-contracts/test/`
- `packages/runtime-pi/test/`
- `packages/platform-node/test/`
- `packages/testing/src/` for reusable conformance fixtures and deterministic fakes.
- `apps/agent-service/test/`
- `apps/execution-worker/test/`
- `test/integration/`
- `test/e2e/beef-restaurant.test.ts`

### Dependency rules

```text
apps/* → application + contracts + selected adapters
platform-node → application ports + domain + contracts
runtime-pi → application runtime port + Pi packages
application → domain + product contracts
contracts → serializable product types only
domain → no infrastructure, Pi, transport, UI, database or Node-specific dependency
testing → product ports and public package APIs
```

Automated checks must reject reverse dependencies, package cycles and direct Pi imports outside `packages/runtime-pi`.

## Implementation Tasks

### Task 1: Establish repository and toolchain contracts

- [x] Record the installed Node.js and npm versions; require Node.js `>=22.19.0` to match the accepted Pi runtime floor.
- [x] Create the workspace manifests and pin all direct external dependencies to exact versions.
- [x] Pin `@earendil-works/pi-coding-agent` to the reviewed published version; do not commit a `file:` dependency on `../pi-mono`.
- [x] Configure erasable TypeScript syntax, strict type checking, formatting, linting and Vitest workspaces.
- [x] Add scripts for `check`, focused unit tests, contract tests, integration tests and the end-to-end reference journey.
- [x] Add a dependency-boundary check that rejects Pi imports outside `packages/runtime-pi`.
- [x] Run the empty-workspace checks and record the baseline.

#### Task 1 evidence — 2026-08-25

- Local toolchain: Node.js `v25.6.0`, npm `11.8.0`; root `engines.node` requires `>=22.19.0`.
- Direct external versions are exact: `@earendil-works/pi-coding-agent` `0.84.2`, TypeScript `5.9.3`, Biome `2.3.5`, Vitest `4.1.9` and `@types/node` `22.19.19`.
- npm registry readback confirmed Pi `0.84.2`, Node.js engine `>=22.19.0` and integrity `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`.
- `npm ci --ignore-scripts`: installed 199 packages; npm audit reported 0 vulnerabilities.
- `npm run check`: format, lint, strict TypeScript and dependency boundaries passed for all 9 workspaces.
- `npm run test:unit`: 1 file and 1 test passed. Contract, integration, e2e and Pi compatibility projects reported no test files and exited 0 under the explicitly configured empty-workspace baseline.
- Negative probes confirmed the boundary check rejects a direct Pi import from `packages/domain`, an illegal `domain → application` dependency and the resulting workspace cycle, a ranged direct dependency, and a pure-layer `node:` import. The probes were removed before final validation.
- `docs/architecture-v0.1.md` records only the implemented toolchain and workspace state; product behavior remains unimplemented.
- Strict document-governance validation passed with 0 warnings; `git diff --check` passed after non-semantic EOF formatting repairs to existing ADR files.

### Task 2: Implement immutable identities and domain state machines

- [x] Write tests for stable identifiers and ownership rules for Owner, Agent, Thread, Session, Run, Turn and Trigger.
- [x] Write table-driven tests for all legal and illegal Run transitions, including repeated approval waits and terminal-state immutability.
- [x] Write tests proving one Agent cannot have two simultaneous logical authority leases.
- [x] Implement domain values and transition functions without infrastructure dependencies.
- [x] Implement domain errors with stable machine-readable codes.
- [x] Run domain tests and dependency checks.

#### Task 2 evidence — 2026-08-25

- Failure-first baseline: the new domain suites initially reported 14 failures because the public domain API did not exist.
- `packages/domain/src` now contains branded identity factories, immutable ownership-derived entities, the exhaustive Run transition table, pure Agent authority lease rules and seven stable `DOMAIN_*` error codes. A compile-only type test proves Agent/Owner and Run/Thread IDs are not interchangeable.
- `npm run test:unit`: 4 files and 87 tests passed. The suite enumerates every Run status pair, repeated approval waits, every terminal status against every requested next status, ownership mismatches and authority lease conflicts.
- `npm run check` passed format, lint, strict TypeScript and all 9 workspace boundaries; `packages/domain` still has no direct dependency and imports no Node.js, Pi, database or transport module.
- `npm run test`, `npm run check:pi-compat` and strict document-governance validation passed. Contract, integration, e2e and Pi compatibility projects remain explicit empty baselines and do not count as Task 2 functional coverage.
- `docs/architecture-v0.1.md` records the implemented identity, state-machine and lease semantics together with the intentionally unimplemented expiry, fencing and persistence boundaries.

### Task 3: Define versioned Gateway and execution contracts

- [x] Write schema round-trip and invalid-input tests for commands, queries, snapshots and streaming events.
- [x] Define trigger admission, Thread commands, Run commands, approval responses, Trace queries and event subscription contracts.
- [x] Define execution-worker request, progress, result, cancellation and reconciliation contracts.
- [x] Include schema version, correlation, causation, idempotency and data-classification fields where required by the Spec.
- [x] Ensure serialized contracts contain no Pi types and no secret values.
- [x] Add compatibility fixtures for the first protocol version.

#### Task 3 evidence — 2026-08-25

- Failure-first baseline: two round-trip tests failed because neither contract package exposed a runtime schema; the new invalid-input cases were then exercised against the implemented schemas.
- `packages/gateway-contracts` now publishes `gateway.v1` with 12 message shapes spanning Trigger admission, Thread and Run commands, semantic approval responses, snapshot and Trace queries, resumable subscription, snapshots and ordered streaming events. Run creation remains part of Trigger admission; the direct Run command is cancellation.
- `packages/execution-contracts` now publishes `execution.v1` with seven message shapes spanning execute, cancel and reconciliation requests plus progress, result, cancellation and reconciliation events. Result and reconciliation outcomes enforce matching payload/error/external-action references, and execution deadlines must follow request time.
- Both protocols carry version, message, correlation, causation, data-classification and product-scope fields; state-changing Gateway commands and all Worker requests carry idempotency keys. Parsers reject unknown fields and versions with stable `CONTRACT_VALIDATION_ERROR` details.
- Committed v1 JSON fixtures contain only machine values and references. Contract tests recursively reject raw-secret field names and scan serialized fixtures for Pi runtime types; secret access is represented only by reference, version and purpose.
- `npm run test:contracts`: 2 files and 23 tests passed. `npm run typecheck` and `npm run check:boundaries` passed; both contract packages retain zero internal and zero external dependencies.

### Task 4: Implement product ports and adapter conformance suites

- [x] Define application ports for state, reliable events, Trace, Payload, audit, memory, models, runtime, capabilities, secrets, scheduler, attention, authority leases and clocks.
- [x] For each port, write a reusable conformance suite before implementing an adapter.
- [x] Provide deterministic in-memory reference adapters in `packages/testing` that pass the same suites future production adapters must pass.
- [x] Test injected clock, ID generation and failure scheduling so crash and retry paths are deterministic.
- [x] Verify domain and application packages depend only on ports, not reference adapters.

#### Task 4 evidence — 2026-08-25

- `packages/application` now exposes 15 product-owned ports: the 14 named boundaries plus `IdGeneratorPort`. Shared contracts include product JSON values and references, data classification, complete Trace envelopes and stable `PORT_*` errors; there are no database, provider, transport, Node.js or Pi imports.
- Failure-first baseline: 25 reusable conformance cases were registered before reference behavior existed, and all 25 failed at the explicit `Reference adapters are not implemented` boundary.
- `@himawari-agent/testing/conformance` exports factory-based harnesses for State, Reliable Event, Trace, Payload, Audit, Memory, Model, Agent Runtime, Capability, Secret, Scheduler, Attention, Authority Lease, Clock and ID adapters. Configured and async factories let future production adapters run the same suites with their own setup and teardown.
- `createReferenceAdapterSet()` now supplies defensive-copy in-memory implementations for every port. Scripted Model, Runtime, Capability and Attention adapters emit product types only; Secret handles carry reference/version/purpose and Owner/Agent/Run scope without secret material.
- `ManualClock`, namespace-local `DeterministicIdGenerator` and checkpoint-based `DeterministicFailureScheduler` make time, identity and pre-mutation failures repeatable. Contract coverage proves a scheduled first write failure leaves no state and the next attempt creates revision 1; Authority Lease coverage proves expiry, renewal, conflict and monotonic fencing tokens under an injected clock.
- `npm run test:contracts`: 3 files and 51 tests passed, comprising the prior 23 protocol tests, 25 port cases and 3 deterministic-control cases. `npm run typecheck` and `npm run check:boundaries` passed. A temporary negative probe confirmed that `application → ../../testing/src` is rejected for escaping its workspace root; the probe was removed before final validation.
- This task deliberately does not claim Task 5 transaction/outbox semantics or the deeper production behavior assigned to Tasks 6–15; the reference adapters are test doubles, not production persistence or isolation.

### Task 5: Implement product-state commit and reliable-event semantics

- [x] Write tests for atomic Run-state and business-event visibility.
- [x] Write tests simulating failure before commit, after commit but before publish, and during duplicate publish.
- [x] Implement a state repository and reliable-event abstraction supporting transaction/outbox-equivalent semantics.
- [x] Implement idempotent command admission and stable result lookup.
- [x] Implement authority-lease checks on every command that mutates Agent state.
- [x] Demonstrate coordinator restart using the same reference state adapter without relying on a Pi Session file.

#### Task 5 evidence — 2026-08-25

- Failure-first baseline: all 6 initial integration scenarios failed at the missing `RunStateCommitCoordinator`; the implemented suite was then expanded with a concurrent duplicate-admission case.
- `packages/application` now exposes `ProductStateRepositoryPort`, `ReliableEventSinkPort`, `RunStateCommitCoordinator` and `ReliableEventPublisher`. State changes still use the domain transition table; this is a narrow commit/recovery slice rather than the full Task 13 Run Coordinator.
- The reference Product State Repository atomically records one State revision, the stable command result and pending outbox events after revision, event-identity and current authority-fence checks. An injected `productState.commit.before` failure leaves all three absent.
- Command results are keyed by Owner, Agent and idempotency key. Equal command type/fingerprint replays the original commit result without another write; mismatched reuse returns `PORT_CONFLICT`, and concurrent duplicates converge on one State revision and one event.
- Every new Agent-state commit requires the current authority lease ID and fencing token. The integration suite proves an expired/replaced fence returns `PORT_NOT_AUTHORITATIVE` without advancing State, while the current fence succeeds.
- Reliable publication remains separate from the state transaction. Tests prove a sink failure leaves the event pending, and a failure after sink delivery but before `markPublished` causes one duplicate attempt that the Sink deduplicates by event ID.
- A newly constructed coordinator reads and advances the Run using the same reference Product State Repository with two pending events and no Pi Session artifact or runtime dependency.
- `npm run check` passed formatting, lint, strict TypeScript and dependency boundaries for all 9 workspaces. `npm run test` passed 87 unit, 54 contract and 7 integration tests; e2e remains an explicit empty baseline. `npm run check:pi-compat` also remains an explicit empty baseline.
- Strict document-governance validation passed with 0 warnings, and `git diff --check` passed.

### Task 6: Implement Session Trace, Payload and audit separation

- [ ] Write event-envelope tests for Run-local ordering, parent, causation and correlation relationships.
- [ ] Write tests for model payload, tool payload and approval payload references.
- [ ] Write secret-redaction tests covering structured values, headers, URLs, errors and nested tool results.
- [ ] Implement append-only Trace events, encrypted-payload port semantics and minimal audit records.
- [ ] Implement deletion propagation state covering Payload, search, cache and archive adapters.
- [ ] Test that partial deletion remains visible as incomplete and cannot be reported as verified.

### Task 7: Implement deterministic Permission and Grant handling

- [ ] Write decision-table tests for `ALLOW`, `ASK` and `DENY`.
- [ ] Write tests for one-time grants, long-term grants, scope mismatch, expiration, budget exhaustion and revocation.
- [ ] Define Action Intent and semantic approval snapshots.
- [ ] Implement fail-closed policy evaluation outside model-facing code.
- [ ] Implement durable approval waiting and resume without holding an in-process Promise.
- [ ] Verify no-UI `ASK` remains pending and cannot become `ALLOW` through timeout or retry.

### Task 8: Implement Capability Registry and execution isolation contracts

- [ ] Write lifecycle tests for discovery, proposed installation, approval, activation, update, permission expansion, disable and uninstall.
- [ ] Write integrity and version-pinning tests for executable capabilities.
- [ ] Implement capability declarations separately from grants and short-lived execution handles.
- [ ] Implement the execution-worker boundary with cancellation, timeout, progress and result events.
- [ ] Provide deterministic test capabilities for restaurant search and reservation.
- [ ] Verify a worker cannot access undelegated context, capabilities or secret references.

### Task 9: Implement Memory Port and context formation

- [ ] Write conformance tests for search, provenance, write proposal, correction and deletion.
- [ ] Implement a deterministic memory adapter used only for tests and local architecture verification.
- [ ] Implement context formation from Thread messages, trigger payload, policies, memory candidates and capability summaries.
- [ ] Emit separate Trace events for query, candidates, selection and final injected content.
- [ ] Verify all trigger types use the same context-formation pipeline.
- [ ] Verify the Pi adapter cannot write the memory backend directly.

### Task 10: Implement Model Router and secret-mediated provider access

- [ ] Write routing tests for primary, specialist, local and fallback candidates.
- [ ] Write tests proving a fallback cannot lower privacy or expand disclosure silently.
- [ ] Implement data-classification and route-decision records before provider execution.
- [ ] Implement secret handles that resolve only inside trusted provider adapters.
- [ ] Ensure provider failures, retries, token usage, cost and latency become product Trace events.
- [ ] Use deterministic faux providers for all automated tests; do not require paid API calls.

### Task 11: Implement the Pi Agent Runtime adapter

- [ ] Write adapter contract tests with a deterministic Pi-compatible model provider and custom tools.
- [ ] Instantiate `createAgentSession()` with an in-memory or controlled SessionManager, explicit model input and product-controlled resources.
- [ ] Disable default coding tools and expose only capability wrappers authorized for the current Run.
- [ ] Map Pi message, turn, tool, settled, abort and error events into product Runtime events.
- [ ] Map product cancellation to Pi abort and verify listeners settle before reporting runtime completion.
- [ ] Use Pi tool preflight as the final enforcement point for already-computed Permission decisions.
- [ ] Capture observable provider request/response data through supported hooks with pre-write redaction.
- [ ] Verify Pi compaction output can be proposed back to product state without making Pi Session authoritative.
- [ ] Add an exact-version compatibility test and fail clearly on unknown upstream events.

### Task 12: Add local Pi source learning and debugging mode

- [ ] Write a check that locates the sibling `../pi-mono` checkout and verifies its package version and build artifacts without modifying it.
- [ ] Implement opt-in link and unlink scripts that never change committed dependency declarations or lockfiles.
- [ ] Ensure the normal install path always resolves the pinned published Pi package.
- [ ] Document debugger source-map setup and the exact Pi source files corresponding to each adapter operation.
- [ ] Verify local linking changes only developer-local installation state and is reversible.
- [ ] Verify the repository returns to the published dependency after unlinking.

### Task 13: Implement Run Coordinator and worker delegation

- [ ] Write a full Run-state integration test from accepted trigger through context, model, tool and completion.
- [ ] Write tests for worker parent-child Trace relationships, budgets, cancellation and result aggregation.
- [ ] Implement Run Coordinator orchestration using product ports only.
- [ ] Implement one primary Agent with scoped worker runs and no inherited undelegated grants.
- [ ] Persist every suspension point needed for crash-safe resume.
- [ ] Verify a runtime or worker crash cannot duplicate a completed external action.

### Task 14: Implement Scheduler and unified trigger ingestion

- [ ] Write contract tests proving user, timer and external-event triggers normalize to the same trigger envelope.
- [ ] Implement scheduled jobs with stable idempotency keys and authority-lease checks.
- [ ] Implement long-term task scope, frequency, expiration and revocation checks before each run.
- [ ] Test duplicate timer delivery and clock jumps.
- [ ] Verify scheduling does not bypass context formation, Permission or Trace.

### Task 15: Implement centralized Attention Policy

- [ ] Write policy tests for `SILENT`, `INBOX`, `DIGEST`, `NOTIFY` and `INTERRUPT`.
- [ ] Test quiet hours, duplicate results, rate limits, explicit interrupt grants and missing client delivery.
- [ ] Implement Result Candidate to Delivery Request conversion.
- [ ] Implement delivery idempotency and acknowledgements independent of Run completion.
- [ ] Provide a deterministic test delivery adapter, not a fixed product UI.
- [ ] Verify two clients cannot produce duplicate or conflicting delivery decisions.

### Task 16: Implement Agent Gateway application service

- [ ] Write tests for authentication-context propagation, command admission, idempotency and authorization failures.
- [ ] Implement in-process Gateway transport first against the stable contracts.
- [ ] Implement snapshot query and resumable ordered event subscription semantics.
- [ ] Keep transport authentication as an adapter responsibility while enforcing product owner/device authorization in the application layer.
- [ ] Verify all state mutations pass through Control Plane use cases.
- [ ] Verify no Gateway contract exposes Pi or infrastructure-specific types.

### Task 17: Build the local composition root

- [ ] Compose trusted components for a foreground local process using reference adapters.
- [ ] Start the execution-worker boundary separately, even if its first transport is local.
- [ ] Keep Secret Port replaceable and ensure reference secrets never enter logs or Trace.
- [ ] Add startup diagnostics that report adapter identity, schema version and readiness without exposing credentials.
- [ ] Add graceful shutdown and in-flight Run settlement tests.
- [ ] Verify the same application contracts can be wired to remote adapters without domain changes.

### Task 18: Implement the beef-restaurant end-to-end baseline

- [ ] Create deterministic fixtures for owner profile, location, beef preference, restaurant search, monitoring schedule and reservation result.
- [ ] Test memory write and provenance.
- [ ] Test a new Thread retrieving the preference and producing a relevant recommendation.
- [ ] Test proposed monitoring task, Human-in-the-Loop approval and durable Grant.
- [ ] Test timer-triggered worker research and Attention Policy delivery.
- [ ] Test reservation Action Intent, semantic approval, secret handle use and external result reconciliation.
- [ ] Test a second client resuming the Thread and reading the complete Session Trace.
- [ ] Assert the full expected event graph, not only the final assistant text.

### Task 19: Exercise failure and recovery matrix

- [ ] Simulate restart before Run-state commit.
- [ ] Simulate restart after state commit but before event publication.
- [ ] Simulate restart while awaiting approval.
- [ ] Simulate model stream interruption and privacy-incompatible fallback.
- [ ] Simulate worker crash before and after external side effect.
- [ ] Simulate unknown external action result and reconciliation.
- [ ] Simulate authority-lease loss mid-Run.
- [ ] Simulate partial Trace deletion and delayed third-party cleanup.
- [ ] Verify every case has a terminal or explicitly pending state visible in Trace.

### Task 20: Reconcile current-truth documentation

- [ ] Create `docs/architecture-v0.1.md` from the official template only after implementation exists.
- [ ] Describe only implemented packages, adapters, deployment profile, data flow and known limitations.
- [ ] Add SOURCE links to accepted ADRs and the source Spec without duplicating their rationale.
- [ ] Update README with verified setup, local Pi debugging and validation commands.
- [ ] Report any Spec acceptance criterion not fully implemented as unverified; do not present target design as current truth.
- [ ] Run strict document-governance validation.

## Verification

- `npm ci --ignore-scripts`
- `npm run check`
- `npm run test:unit`
- `npm run test:contracts`
- `npm run test:integration`
- `npm run test:e2e -- beef-restaurant`
- `npm run check:boundaries`
- `npm run check:pi-compat`
- `python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .`
- `git diff --check`

Validation must use deterministic model, memory, tool and delivery adapters. Real provider smoke tests, paid APIs, production deployment and external-account mutations require separate explicit authorization and an applicable Runbook or focused verification agreement.

## Closure Checklist

- [ ] Verification has been run and recorded.
- [ ] Affected current-truth documents are reconciled.
- [ ] Remaining future work is recorded in Backlog when needed.
- [ ] This Plan is moved to `docs/archive/plans/` when closed.
- [ ] Source Spec acceptance criteria are mapped to fresh verification evidence.
- [ ] `docs/architecture-v0.1.md` reflects only the implemented state.
- [ ] All accepted ADR links are valid and no new durable decision is hidden only in code or Plan prose.
- [ ] Pi published-version and local-source modes have both been verified, with local linking fully reversible.
- [ ] No secrets, paid-provider credentials or user-private production data are present in fixtures, logs or committed artifacts.
