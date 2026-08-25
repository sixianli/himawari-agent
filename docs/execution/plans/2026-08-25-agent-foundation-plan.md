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

- [x] Write event-envelope tests for Run-local ordering, parent, causation and correlation relationships.
- [x] Write tests for model payload, tool payload and approval payload references.
- [x] Write secret-redaction tests covering structured values, headers, URLs, errors and nested tool results.
- [x] Implement append-only Trace events, encrypted-payload port semantics and minimal audit records.
- [x] Implement deletion propagation state covering Payload, search, cache and archive adapters.
- [x] Test that partial deletion remains visible as incomplete and cannot be reported as verified.

#### Task 6 evidence — 2026-08-25

- Failure-first baseline: all 5 new integration scenarios failed because `SessionTraceRecorder`, deletion coordination and Trace ordering enforcement did not exist.
- `SessionTraceRecorder` now assigns strict Run-local sequences, persists model/tool/approval detail only through protected Payload references, preserves parent/causation/correlation relationships and emits explicitly requested minimal audit records without copying payloads.
- The reference Trace Store rejects duplicate identities, sequence gaps, cross-Run parents, mismatched Run scope and cross-correlation causes. It supports Run-local resume and deterministic Session timeline reads while remaining append-only.
- Trace payloads are converted to product JSON and redacted before protection. Tests cover named secret fields, authorization headers, secret URL query parameters, `Error` values, nested tool results and caller-supplied sensitive literals. Cyclic or otherwise unverifiable payloads are not persisted; a payload-free `trace.redaction_failed` event and minimal failed audit record remain visible.
- `PayloadStorePort` now accepts ciphertext plus algorithm, key reference and digest metadata. The deterministic `test-xor-v1` protector exists only as a test double and does not claim production cryptographic security.
- `SessionDeletionCoordinator` durably tracks Payload, search, cache and archive targets with per-target attempts, failure codes and verification timestamps. An injected archive failure leaves the operation `incomplete`; a coordinator reconstructed over the same state retries only unfinished targets and reaches `verified` after all four adapters confirm absence. `assertVerified()` rejects every partial state.
- `npm run check` passed formatting, lint, strict TypeScript and all 9 workspace boundaries. The focused Task 6 suite passed 5 integration tests, and the existing 54 contract tests passed after the Payload contract migration.

### Task 7: Implement deterministic Permission and Grant handling

- [x] Write decision-table tests for `ALLOW`, `ASK` and `DENY`.
- [x] Write tests for one-time grants, long-term grants, scope mismatch, expiration, budget exhaustion and revocation.
- [x] Define Action Intent and semantic approval snapshots.
- [x] Implement fail-closed policy evaluation outside model-facing code.
- [x] Implement durable approval waiting and resume without holding an in-process Promise.
- [x] Verify no-UI `ASK` remains pending and cannot become `ALLOW` through timeout or retry.

#### Task 7 evidence — 2026-08-25

- Failure-first baseline: all 9 new integration cases failed at the missing `PermissionService` boundary.
- Product-owned `ActionIntent` now freezes capability, operation, resource, data classification, side effect, estimated cost, proposed frequency, idempotency and reversibility into a semantic approval snapshot with a stable hash. A response carrying a different hash is rejected with `PORT_CONFLICT`.
- `PermissionService` evaluates explicit deny rules before allow rules and otherwise creates `ASK`; any Authorization Store read or mutation failure returns fail-closed `DENY` with `permission_component_error`. The service has no model or Pi dependency.
- One-time approval creates an exact intent-bound Grant with one use. Long-term Grants bound capability, operations, resource prefixes, maximum classification, side effects, per-use and total cost, proposed frequency, use count, expiry and revocation. Integration tests cover mismatched resource/frequency/cost, exhausted total/use budgets, expiry and owner revocation.
- `ApprovalRequest` and `GrantRecord` are durable port values. A new `PermissionService` over the same reference Authorization Store resumes the same pending no-UI request; repeated evaluation returns the same request. Deadline expiry records `expired` and later retries return `DENY`, never `ALLOW`.
- `AuthorizationStorePort` resolves an approval and creates its Grant in one adapter mutation boundary, then uses revision-checked atomic Grant accounting. Its reusable conformance suite covers semantic-hash conflict, approval/Grant visibility and exhausted consumption.
- `npm run check` passed all engineering checks. `npm run test:contracts` passed 56 tests, including 2 new Authorization Store conformance cases; the focused Task 7 suite passed 9 integration tests.

### Task 8: Implement Capability Registry and execution isolation contracts

- [x] Write lifecycle tests for discovery, proposed installation, approval, activation, update, permission expansion, disable and uninstall.
- [x] Write integrity and version-pinning tests for executable capabilities.
- [x] Implement capability declarations separately from grants and short-lived execution handles.
- [x] Implement the execution-worker boundary with cancellation, timeout, progress and result events.
- [x] Provide deterministic test capabilities for restaurant search and reservation.
- [x] Verify a worker cannot access undelegated context, capabilities or secret references.

#### Task 8 evidence — 2026-08-25

- Failure-first baseline: all 11 new integration cases failed because the Capability Registry, Registry Store, execution Handle and Worker service did not exist.
- `CapabilityRegistryService` now requires exact semantic versions, `sha256:<64 lowercase hex>` integrity, a fixed source locator, at least one operation and non-duplicated permission declarations. Lifecycle tests cover discovery, install proposal, approval, activation, update proposal, permission expansion detection, update approval, reactivation, disable and uninstall.
- Updates pin an exact new version and a verified integrity value. Installation and every update require an explicit approval reference before activation; a permission-expanding update remains `update_proposed` and cannot activate directly.
- Capability declarations, Permission/Grant decisions and `CapabilityExecutionHandle` values are separate types and stores. A Handle contains only one Run's allowed operation, input refs, delegated context refs, declared secret refs, maximum classification, authorization reference and expiry; active version changes, disable, revoke or expiry invalidate it.
- `ExecutionWorkerService` accepts existing `execution.v1` execute/cancel messages, rechecks Owner/Agent/Run, capability/version/operation, input, delegated context, secret reference and classification against the Handle, issues only scoped secret handles, revokes them after settlement, and maps progress, success, failure, unknown result, cancellation and timeout to schema-valid Worker events.
- Deterministic restaurant-search and restaurant-reservation capabilities emit one progress event and a reference-only result. Tests prove cancellation and pre-execution deadline expiry do not invoke them, and undelegated capability, context or secret requests fail with `PORT_NOT_AUTHORITATIVE` before invocation.
- `npm run check` passed all engineering checks. `npm run test:contracts` passed 58 tests, including 2 new Registry/Handle conformance cases; the focused Task 8 suite passed 11 integration tests without external network or account access.

### Task 9: Implement Memory Port and context formation

- [x] Write conformance tests for search, provenance, write proposal, correction and deletion.
- [x] Implement a deterministic memory adapter used only for tests and local architecture verification.
- [x] Implement context formation from Thread messages, trigger payload, policies, memory candidates and capability summaries.
- [x] Emit separate Trace events for query, candidates, selection and final injected content.
- [x] Verify all trigger types use the same context-formation pipeline.
- [x] Verify the Pi adapter cannot write the memory backend directly.

#### Task 9 evidence — 2026-08-25

- Failure-first baseline: all 4 new integration cases failed because `ContextFormationService` did not exist.
- Memory records, write proposals and corrections now carry provider-neutral search terms plus the existing Payload and source Trace references. The deterministic reference adapter normalizes terms, excludes non-matches, scores overlap and breaks ties by stable memory ID; it remains under `packages/testing` and is not a product memory engine.
- The reusable Memory conformance suite now has 3 cases covering proposal isolation, commit/search with provenance, correction, deletion and deterministic relevance. `npm run test:contracts` passed 59 tests.
- `ContextFormationService` receives only `Pick<MemoryPort, "search">`. It combines ordered Thread message refs, the trigger payload, policy refs, classification-filtered memory selections and capability summary refs into one final protected context Payload reference.
- Every formation emits four linked Trace events: `memory.query`, `memory.candidates`, `memory.selection` and `context.formed`. Candidate Trace data preserves source references; selection Trace records explicit inclusion and classification/limit exclusion reasons.
- User-message, schedule and external-event tests call the same `form()` method and produce the same four-event pipeline. A restricted higher-score candidate remains visible in retrieval Trace but is excluded from a private context.
- `@himawari-agent/application/runtime-port` exports only Agent Runtime request/event types. The dependency checker now rejects every other application import from `packages/runtime-pi`; a temporary `MemoryPort` import probe failed with the expected runtime-only-import error and was removed.
- `npm run check` passed formatting, lint, strict TypeScript and all workspace boundaries. The focused Task 9 suite passed 4 integration tests without Pi execution or external memory services.

### Task 10: Implement Model Router and secret-mediated provider access

- [x] Write routing tests for primary, specialist, local and fallback candidates.
- [x] Write tests proving a fallback cannot lower privacy or expand disclosure silently.
- [x] Implement data-classification and route-decision records before provider execution.
- [x] Implement secret handles that resolve only inside trusted provider adapters.
- [x] Ensure provider failures, retries, token usage, cost and latency become product Trace events.
- [x] Use deterministic faux providers for all automated tests; do not require paid API calls.

#### Task 10 evidence — 2026-08-25

- Failure-first baseline: all 6 new integration cases failed at the missing `ModelRouterService` and `TrustedModelProviderAdapter` boundaries.
- Model descriptors now freeze routing class, deterministic priority, disclosure boundary, capabilities, allowed data classifications and an optional secret reference/version/purpose. `ModelRouterService` first evaluates and records all candidate allow/deny reasons, then fixes provider, model, version and disclosure before issuing any Provider request.
- Primary, specialist and local profiles select only their approved class, with priority and stable model reference as deterministic tie-breakers. A retryable primary failure can select only a separately declared fallback that still satisfies capability, classification and request disclosure constraints.
- Fallback evaluation additionally compares the failed route's disclosure against the candidate. When policy forbids disclosure expansion, a trusted-remote failure cannot silently fall back to an external-remote model even if the request's broad ceiling would otherwise permit it; the Run ends with `MODEL_FALLBACK_DISCLOSURE_BLOCKED` and no second Provider invocation.
- Each invocation emits linked `model.route_decided`, `model.request`, Provider lifecycle, failure/retry and terminal Trace events. Protected payloads retain model identity, data classification, disclosure policy reference, output references, stable error/retry fields, token counts, cost and latency without embedding model input or output bodies.
- `TrustedModelProviderAdapter` validates a Run- and invocation-scoped opaque Secret Handle against the descriptor's exact reference, version, purpose, expiry and revocation state. Only this trusted `platform-node` boundary resolves the raw value into transport memory; its resolution log remains reference-only, and the Router revokes the handle after settlement.
- All tests use scripted providers, an in-memory handle store and deterministic transport; no network, account, paid model or production credential was used. `npm run check` passed all engineering checks, and `npm run test` passed 87 unit, 59 contract and 42 integration tests including the focused 6-case Task 10 suite.

### Task 11: Implement the Pi Agent Runtime adapter

- [x] Write adapter contract tests with a deterministic Pi-compatible model provider and custom tools.
- [x] Instantiate `createAgentSession()` with an in-memory or controlled SessionManager, explicit model input and product-controlled resources.
- [x] Disable default coding tools and expose only capability wrappers authorized for the current Run.
- [x] Map Pi message, turn, tool, settled, abort and error events into product Runtime events.
- [x] Map product cancellation to Pi abort and verify listeners settle before reporting runtime completion.
- [x] Use Pi tool preflight as the final enforcement point for already-computed Permission decisions.
- [x] Capture observable provider request/response data through supported hooks with pre-write redaction.
- [x] Verify Pi compaction output can be proposed back to product state without making Pi Session authoritative.
- [x] Add an exact-version compatibility test and fail clearly on unknown upstream events.

#### Task 11 evidence — 2026-08-25

- `PiAgentRuntimeAdapter` constructs `createAgentSession()` with an explicit product-selected model binding, `SessionManager.inMemory()`, in-memory settings and a resource loader that disables project context, Skills, prompts, themes and discovered Extensions. `noTools: "all"` removes Pi coding tools; the only enabled names are wrappers returned by `RuntimeToolPort.listAuthorized()` for the current Run.
- The product Runtime boundary now carries Owner, Agent, Thread, data classification and product Payload references. `RuntimeProjectionPort` resolves only the current Run projection, captures redacted message/tool/provider observations and receives compaction output as a proposal reference; no Pi Session entry becomes product state.
- Pi agent, message, turn, tool, compaction and settled events map to product-only Runtime events. Stable product errors cover model failure, unknown upstream event, incomplete settlement and generic runtime failure. Product cancellation calls `AgentSession.abort()`, waits for Pi idle plus queued listener work, and emits `runtime.cancelled` instead of completion.
- Custom tool execution performs the product preflight after Pi schema validation and immediately before execution. Denial returns a tool error without invoking the capability. The port contract requires completed external actions to deduplicate by Run and Pi tool-call ID; the durable reference implementation is completed with Task 13.
- Supported `before_provider_request` and `after_provider_response` hooks capture redacted observations before product persistence. Secret-like keys and URL query parameters are removed locally; provider/model error text is not copied into product Runtime errors.
- `@earendil-works/pi-coding-agent` is pinned to `0.84.2`; the compatibility test resolves the matching `pi-ai` faux provider from that published package's locked dependency graph rather than adding a second product runtime dependency. `npm run check:pi-compat` ran six tests against the real published Pi session, faux provider and custom tool loop. `npm run check` passed; `npm run test` passed 87 unit, 59 contract and 42 integration tests, while e2e remains the explicit empty baseline.

### Task 12: Add local Pi source learning and debugging mode

- [x] Write a check that locates the sibling `../pi-mono` checkout and verifies its package version and build artifacts without modifying it.
- [x] Implement opt-in link and unlink scripts that never change committed dependency declarations or lockfiles.
- [x] Ensure the normal install path always resolves the pinned published Pi package.
- [x] Document debugger source-map setup and the exact Pi source files corresponding to each adapter operation.
- [x] Verify local linking changes only developer-local installation state and is reversible.
- [x] Verify the repository returns to the published dependency after unlinking.

#### Task 12 evidence — 2026-08-25

- `npm run check:local-pi` resolves the exact sibling `../pi-mono`, compares `packages/coding-agent/package.json` against the committed `packages/runtime-pi` pin, verifies seven coding-agent/core dependency JS and declaration entrypoints, and reports whether Node currently resolves the local or published package. The check performs no writes.
- `link:local-pi` moves the installed published package to a developer-local backup under `node_modules`, installs one symlink to the checked sibling package and records recovery state under `node_modules`. It refuses missing artifacts, version mismatch, unmanaged links and conflicting recovery state. `unlink:local-pi` verifies the managed target, restores the exact published backup and verifies its package name/version.
- Both link and unlink hash `packages/runtime-pi/package.json` and `package-lock.json` before and after mutation. The 2-case integration suite uses an isolated filesystem fixture to prove the only changed state is `node_modules`, the operation is reversible and a mismatched sibling version fails closed.
- The real sibling was clean at preflight and matched `0.84.2` but initially lacked generated build inputs and `dist`. `npm ci --ignore-scripts` succeeded with 0 vulnerabilities. The live model catalog had drifted beyond the `0.84.2` source types, so the debug build used model data from the already pinned published `0.84.2` dependency graph and TypeScript `--noCheck` only for the ignored `packages/ai/dist` emission; all other Pi workspaces used their normal build scripts. No tracked Pi file changed.
- Real-mode verification passed in both directions: published mode 6/6 Pi compatibility tests, local-source mode 6/6, then restored published mode 6/6. The final resolver readback is `mode: "published"`; Himawari manifests and lockfile remained unchanged by link/unlink.
- README documents source-map debugger configuration and maps adapter operations to the exact `pi-mono` source files. A normal `npm ci --ignore-scripts` continues to resolve the committed npm `0.84.2` dependency and does not opt into local mode.

### Task 13: Implement Run Coordinator and worker delegation

- [x] Write a full Run-state integration test from accepted trigger through context, model, tool and completion.
- [x] Write tests for worker parent-child Trace relationships, budgets, cancellation and result aggregation.
- [x] Implement Run Coordinator orchestration using product ports only.
- [x] Implement one primary Agent with scoped worker runs and no inherited undelegated grants.
- [x] Persist every suspension point needed for crash-safe resume.
- [x] Verify a runtime or worker crash cannot duplicate a completed external action.

#### Task 13 evidence — 2026-08-25

- `RunCoordinator` now owns the product orchestration path from an admitted Run through `ContextFormationPort`, explicitly delegated `WorkerRunPort` calls and `AgentRuntimePort`, while all Run mutations still pass through `RunStateCommitCoordinator` with the current Authority Fence. It maps settlement to the domain Run state machine and propagates owner cancellation to active runtime and worker calls.
- Worker requests must match the parent Owner, Agent and Run and may contain only an explicit subset of delegable context and capability-handle references. Worker secret references are rejected at this boundary rather than inherited. Duration, cost and progress budgets are checked by the coordinator, and worker results are added to the runtime message-reference projection.
- Context completion, worker results, runtime event count, latest Trace event and terminal outcome are persisted under a product checkpoint after each suspension point. A restarted coordinator skips completed context/worker work and replays deterministic runtime events only beyond the recorded count.
- Worker delegation, progress, terminal settlement and every Runtime event are appended to the parent Run Trace with linked parent and causation identifiers. An unknown external worker result moves the Run to `reconciling_external_result`; budget failure and cancellation settle it explicitly.
- `ScriptedWorkerRunPort` and `IdempotentRuntimeToolPort` add reusable conformance coverage. Tool execution caches a completed result by `RunId + toolCallId`, and the crash integration case proves an external action completed immediately before a simulated runtime crash executes only once after coordinator reconstruction.
- Five focused integration cases cover completion and result aggregation, undelegated authority rejection, worker-budget failure, crash-safe resume and active-runtime cancellation. `npm run typecheck` and the focused integration suite passed; full Task 13 validation is recorded with the implementation commit.

### Task 14: Implement Scheduler and unified trigger ingestion

- [x] Write contract tests proving user, timer and external-event triggers normalize to the same trigger envelope.
- [x] Implement scheduled jobs with stable idempotency keys and authority-lease checks.
- [x] Implement long-term task scope, frequency, expiration and revocation checks before each run.
- [x] Test duplicate timer delivery and clock jumps.
- [x] Verify scheduling does not bypass context formation, Permission or Trace.

#### Task 14 evidence — 2026-08-25

- `UnifiedTriggerIngestionService` normalizes user messages, scheduled timers and external events into the existing strict `gateway.v1 trigger.admit` command and delegates to one `TriggerAdmissionPort`. Three contract cases prove the sources share the same envelope fields, schema validation and downstream admission boundary.
- Scheduled jobs now persist revision, Owner/Agent/Thread scope, Payload and source-proof references, task semantic scope, long-term authorization reference, interval/minimum interval, expiry, revocation marker, next occurrence and status. `InMemoryScheduler` enforces revision-checked create, advance and cancellation.
- `SchedulerService` requires the current Agent Authority Lease ID and fencing token before each due job. It also rereads the current long-term Grant and checks kind, ownership, validity, revocation, capability, operation, resource prefix, data classification, side effect, per-use/total cost, remaining uses, frequency and schedule expiry before admission; failures disable the task without producing a Trigger.
- Every occurrence derives stable message, correlation, Trigger and command idempotency references from job ID plus occurrence. Concurrent timer delivery reaches the unified admission boundary twice with the same key, creates one downstream result, and advances the schedule once through CAS.
- A forward clock jump emits one due Trigger and advances directly to the first future occurrence instead of replaying a burst of missed intervals. The scheduled occurrence time remains the Trigger `occurredAt`, preserving source chronology.
- The eight integration cases verify unified downstream context/Permission/Trace routing, stable timer deduplication, clock-jump coalescing, local and current-Grant expiry/revocation/frequency/scope checks, and stale Authority Fence rejection. `npm run check`, 64 contract tests and 57 integration tests passed before commit.

### Task 15: Implement centralized Attention Policy

- [x] Write policy tests for `SILENT`, `INBOX`, `DIGEST`, `NOTIFY` and `INTERRUPT`.
- [x] Test quiet hours, duplicate results, rate limits, explicit interrupt grants and missing client delivery.
- [x] Implement Result Candidate to Delivery Request conversion.
- [x] Implement delivery idempotency and acknowledgements independent of Run completion.
- [x] Provide a deterministic test delivery adapter, not a fixed product UI.
- [x] Verify two clients cannot produce duplicate or conflicting delivery decisions.

#### Task 15 evidence — 2026-08-25

- `AttentionPolicyService` is the single deterministic decision point for Result Candidates. Fixed urgency/confidence thresholds produce all five levels; duplicate-window state, rate limits, quiet hours and known device availability can only reduce disruption. `INTERRUPT` additionally requires a matching reference from the injected active interrupt-authorization set.
- Candidate identity and semantic fingerprint are committed under one Owner/Agent policy revision. Concurrent decisions retry after CAS; the first result for a duplicate key receives its normal level while a concurrent duplicate becomes `SILENT`. Reusing one candidate ID with different content is rejected.
- Every non-silent decision atomically creates one product `DeliveryRequest`; silent decisions create none. Delivery state has its own revision, `pending → delivering → delivered` lifecycle, client claim, attempt count, acknowledgement reference and retryable failure state, without any Run mutation.
- `InMemoryAttentionStatePort` enforces decision/request consistency and only one active client claim. An unavailable or failed adapter settlement reopens the request as `pending`; an acknowledged settlement is terminal and subsequent client claims return the existing delivery instead of rendering again.
- `DeterministicDeliveryPort` is a client-keyed test adapter with observable reference-only attempts, not a product UI. Integration coverage proves an offline client leaves delivery pending, another client can acknowledge it later, and the source Run remains `completed` throughout.
- Ten focused policy tests cover every level, explicit interrupt authorization, quiet hours, concurrent duplicate suppression, frequency limits, device availability and idempotent candidate replay. Two integration cases cover missing-client retry and concurrent two-client claim/ack; three additional conformance cases cover atomic state, delivery claims and deterministic adapters. `npm run check`, 97 unit, 67 contract, 59 integration and 6 Pi compatibility tests passed before commit; e2e remains the explicit empty baseline.

### Task 16: Implement Agent Gateway application service

- [x] Write tests for authentication-context propagation, command admission, idempotency and authorization failures.
- [x] Implement in-process Gateway transport first against the stable contracts.
- [x] Implement snapshot query and resumable ordered event subscription semantics.
- [x] Keep transport authentication as an adapter responsibility while enforcing product owner/device authorization in the application layer.
- [x] Verify all state mutations pass through Control Plane use cases.
- [x] Verify no Gateway contract exposes Pi or infrastructure-specific types.

#### Task 16 evidence — 2026-08-25

- Failure-first baseline: all 3 new Gateway integration cases failed because `AgentGatewayService` did not exist.
- `AgentGatewayService` accepts only the existing `gateway.v1` command, query and subscription types. It compares authenticated Owner/actor scope, delegates device authorization to `GatewayAccessPolicyPort`, rejects failures before dispatch and never receives transport credentials.
- Every mutation crosses only `GatewayControlPlanePort.execute()` with the verified authentication context and original idempotent command. The service has no state-mutation dependency; duplicate behavior remains a Control Plane responsibility and the focused test returns the original result reference on replay.
- Thread/Run snapshot and Trace query calls cross the read-only `GatewayReadModelPort`. Resumable subscriptions preserve `afterCursor`, reject out-of-scope events, duplicate cursors and non-increasing Run-local sequence values.
- `InProcessGatewayTransport` authenticates adapter-specific credentials, strictly parses the stable Gateway contract and propagates only `GatewayAuthenticationContext`. It refuses response-only and malformed inputs before application dispatch.
- Existing Gateway fixtures still prove that wire types contain neither Pi nor infrastructure-specific types or raw-secret fields. `npm run check` passed all engineering checks; `npm run test:contracts` passed 69 tests and the focused Task 16 integration suite passed 3 tests.

### Task 17: Build the local composition root

- [x] Compose trusted components for a foreground local process using reference adapters.
- [x] Start the execution-worker boundary separately, even if its first transport is local.
- [x] Keep Secret Port replaceable and ensure reference secrets never enter logs or Trace.
- [x] Add startup diagnostics that report adapter identity, schema version and readiness without exposing credentials.
- [x] Add graceful shutdown and in-flight Run settlement tests.
- [x] Verify the same application contracts can be wired to remote adapters without domain changes.

#### Task 17 evidence — 2026-08-25

- Failure-first baseline: all 4 new local-process unit cases failed because neither composition root nor independently managed Execution Worker process existed.
- `createLocalAgentServiceComposition()` wires Gateway, Trace, Run state/outbox, context, model routing, Permission, Capability Registry, Attention Policy and Run Coordinator around the reference ports. `SecretPort` remains an explicit replacement input and is used by the composed model service rather than captured from a fixed global.
- `createLocalExecutionWorkerProcess()` owns `ExecutionWorkerService` behind a strictly parsed `execution.v1` dispatch boundary. The Agent process only accepts a ready structural client and never starts the Worker itself; local in-process and remote HTTP-shaped clients use the same request/event contract.
- Startup diagnostics contain only component, adapter identity, schema version and readiness. A custom Secret Port test proves it is the injected instance; a protected Trace test preserves `secretRef` but writes `[REDACTED]` instead of the supplied raw value. Neither diagnostic output nor Trace contains the credential.
- `LocalAgentServiceProcess.shutdown()` first changes to draining, rejects new requests and waits for registered in-flight Run settlements. The focused test holds one Run open, proves shutdown remains pending, then completes the Run and observes a clean stopped state.
- App manifests and the boundary checker now permit the deployable local composition profile to consume `@himawari-agent/testing` reference adapters without adding reverse dependencies or cycles. `npm run check` passed all engineering checks and all 101 unit tests passed, including the 4 focused Task 17 cases.

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
