import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentRuntimePort,
  ContextFormationService,
  claimFromRunExecutionLease,
  type ExecuteCoordinatedRunInput,
  PORT_ERROR_CODES,
  type RunCompletionInput,
  RunCoordinator,
  RunExecutionInputService,
  type RunDispatchPort,
  type RunExecutionLease,
  type RunLifecyclePort,
  RunStateCommitCoordinator,
  type RuntimeEvent,
  SessionTraceRecorder,
  ThreadCommandService,
  type TransitionRunStateInput,
  type WorkerRunEvent,
  type WorkerRunPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
  type RunId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import {
  createReferenceAdapterSet,
  ManualClock,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
} from "@himawari-agent/testing";
import { afterEach, expect, it, vi } from "vitest";
import { ProductionRunDispatcher } from "../../apps/agent-service/src/production-run-dispatcher.js";

const ownerId = createOwnerId("owner-run-lifecycle");
const agentId = createAgentId("agent-run-lifecycle");
const deploymentId = createDeploymentId("deployment-run-lifecycle");
const authority: ProductAuthorityFence = { deploymentId, authorityEpoch: 1, fencingToken: 1 };
const lease = { leaseId: createAuthorityLeaseId("lease-run-lifecycle"), fencingToken: 1 };
const roots: string[] = [];
const repositories: SqliteProductStateRepository[] = [];
const clock = new ManualClock("2026-09-04T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FixtureOptions {
  readonly executionLeaseExpiresAt?: string;
}

async function fixture(options: FixtureOptions = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-run-"));
  roots.push(stateRoot);
  await mkdir(path.join(stateRoot, "data"));
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(`INSERT INTO deployments
    (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
    VALUES (?, ?, ?, 0, 'active', 1, 1)`)
    .run(deploymentId, ownerId, agentId);
  database
    .prepare(`INSERT INTO payloads
    (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at)
    VALUES ('payload-run-lifecycle', ?, ?, 'private', 'sqlite_blob', X'00',
      'sha256:fixture', 'active', ?)`)
    .run(ownerId, agentId, clock.now());
  database
    .prepare(`INSERT INTO authority_leases
    (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, 'holder-run-lifecycle', 1, 1, ?, '2026-09-05T00:00:00.000Z')`)
    .run(lease.leaseId, ownerId, agentId, deploymentId, clock.now());
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(repository);
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock,
    authority: () => authority,
  });
  const created = await commands.create({
    ownerId,
    agentId,
    idempotencyKey: "thread-create",
    resultRef: "payload-run-lifecycle",
  });
  const admitted = await commands.admitOwnerMessage({
    ownerId,
    agentId,
    threadId: created.thread.id,
    expectedThreadRevision: created.thread.revision,
    sessionId: createSessionId("session-run-lifecycle"),
    idempotencyKey: "thread-submit",
    contentRef: "payload-run-lifecycle",
    sourceProofRef: "proof:owner",
    dataClassification: "private",
    resultRef: "payload-run-lifecycle",
  });
  const runId = admitted.message.runId;
  if (!runId) throw new Error("Thread admission did not create a Run");
  await repository.runDispatch(ownerId, agentId, authority, lease, "thread-run-lifecycle").claim({
    runId,
    expectedRunRevision: 1,
    expectedLeaseRevision: 0,
    executionLeaseId: createRunExecutionLeaseId(`execution-${runId}`),
    claimedAt: clock.now(),
    expiresAt: options.executionLeaseExpiresAt ?? "2026-09-05T00:00:00.000Z",
  });
  return { repository, commands, admitted, runId, stateRoot, databasePath };
}

function executionLease(runId: RunId) {
  return Object.freeze({
    executionLeaseId: createRunExecutionLeaseId(`execution-${runId}`),
    expectedLeaseRevision: 1,
    authorityLeaseId: lease.leaseId,
    authorityFencingToken: lease.fencingToken,
    deploymentId,
    authorityEpoch: authority.authorityEpoch,
    fencingToken: authority.fencingToken,
    consumerId: "thread-run-lifecycle",
  } as const);
}

async function executionFixture(options: FixtureOptions = {}) {
  const setup = await fixture(options);
  const adapters = createReferenceAdapterSet({ clock });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "completion-key@v1": new Uint8Array(32).fill(17) }),
    activeKey: { keyRef: "completion-key", kekVersion: "v1", dekVersion: "v1" },
  });
  const payloads = setup.repository.payloadStore(ownerId, agentId);
  await payloads.put(
    await protector.protect({
      ownerId,
      agentId,
      ref: "payload-final-answer",
      dataClassification: "private",
      contentType: "text/plain",
      createdAt: clock.now(),
      plaintext: new TextEncoder().encode("这是最终回答。\n无需 JSON 引号。"),
    }),
  );
  const trace = new SessionTraceRecorder({
    trace: setup.repository.traceStore(),
    artifacts: setup.repository.runPayloadArtifactPort(ownerId, agentId, {
      product: authority,
      lease,
    }),
    protector,
    audit: setup.repository.auditLedger(),
    clock,
    ids: adapters.ids,
  });
  const runs = setup.repository.runLifecycle(ownerId, agentId, authority);
  const checkpoints = setup.repository.runCheckpointStore(ownerId, agentId, authority);
  const artifacts = setup.repository.runPayloadArtifactPort(ownerId, agentId, {
    product: authority,
    lease,
  });
  const stored = await runs.readRun(setup.runId);
  if (!stored) throw new Error("Missing admitted Run");
  const input: ExecuteCoordinatedRunInput = {
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    executionLease: executionLease(setup.runId),
    context: {
      ownerId,
      agentId,
      runId: setup.runId,
      sessionId: stored.run.sessionId,
      threadId: setup.admitted.thread.id,
      trigger: {
        id: stored.run.triggerId,
        sourceType: "user_message",
        payloadRef: "payload-run-lifecycle",
        occurredAt: clock.now(),
      },
      threadMessages: [],
      sourceWatermark: null,
      policyVersion: "context-policy-v1",
      policies: [],
      memoryQueryRef: "payload-run-lifecycle",
      memoryQueryTerms: [],
      memoryLimit: 1,
      maxSelectedMemories: 0,
      maxMemoryClassification: "private",
      capabilities: [],
      correlationId: "completion-correlation",
      causationId: "completion-cause",
      parentEventId: null,
      actorId: "completion-test",
      dataClassification: "private",
    },
    runtime: {
      ownerId,
      agentId,
      runId: setup.runId,
      sessionId: stored.run.sessionId,
      threadId: setup.admitted.thread.id,
      modelRef: "deterministic-completion",
      systemInstructionRef: "payload-run-lifecycle",
      capabilityHandleRefs: [],
      budget: {},
      correlationId: "completion-correlation",
      dataClassification: "private",
    },
    workers: [],
    delegableCapabilityHandleRefs: [],
    delegableContextRefs: [],
    commands: {
      buildingContext: transition(setup.runId, "building_context", 1),
      running: transition(setup.runId, "running", 2),
      reconcilingExternalResult: transition(setup.runId, "reconciling_external_result", 3),
      completed: transition(setup.runId, "completed", 3),
      failed: transition(setup.runId, "failed", 3),
      cancelled: transition(setup.runId, "cancelled", 3),
    },
  };
  let attempts = 0;
  const runtime: AgentRuntimePort = {
    async *run() {
      attempts += 1;
      yield {
        type: "runtime.completed" as const,
        runId: setup.runId,
        occurredAt: clock.now(),
        output: { kind: "assistant-answer" as const, contentRef: "payload-final-answer" },
      };
    },
    async cancel() {},
  };
  const context = new ContextFormationService({
    memory: adapters.memory,
    trace,
    artifacts,
    payloads,
    protector,
    clock,
    ids: adapters.ids,
    threads: setup.repository.threadRepository(),
  });
  const coordinator = new RunCoordinator({
    runs,
    checkpoints,
    context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace,
  });
  return {
    ...setup,
    runs,
    checkpoints,
    input,
    runtime,
    context,
    trace,
    coordinator,
    protector,
    attempts: () => attempts,
  };
}

it("keeps the real lifecycle writer valid after renewing beyond the original lease TTL", async () => {
  const initialTime = clock.now();
  const setup = await executionFixture({
    executionLeaseExpiresAt: "2026-09-04T00:00:01.000Z",
  });
  try {
    const dispatch = setup.repository.runDispatch(
      ownerId,
      agentId,
      authority,
      lease,
      "thread-run-lifecycle",
    );
    const claim = executionLease(setup.runId);
    const renewed = await dispatch.renew({
      runId: setup.runId,
      expectedLeaseRevision: claim.expectedLeaseRevision,
      executionLeaseId: claim.executionLeaseId,
      renewedAt: clock.now(),
      expiresAt: "2026-09-04T00:00:02.000Z",
    });
    expect(renewed).toMatchObject({
      executionLeaseId: claim.executionLeaseId,
      revision: claim.expectedLeaseRevision,
      expiresAt: "2026-09-04T00:00:02.000Z",
      replayed: false,
    });

    clock.set("2026-09-04T00:00:01.500Z");
    await expect(setup.coordinator.execute(setup.input)).resolves.toMatchObject({
      run: { run: { status: "completed" } },
    });
    expect(setup.attempts()).toBe(1);
    await expect(setup.runs.readRun(setup.runId)).resolves.toMatchObject({
      run: { status: "completed" },
    });
    await expect(setup.checkpoints.read(setup.runId)).resolves.toMatchObject({
      checkpoint: {
        phase: "completed",
        terminalStatus: "completed",
        output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      },
    });
    const messages = await setup.repository
      .threadRepository()
      .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10);
    expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  } finally {
    clock.set(initialTime);
  }
});

it("executes only once when two real SQLite dispatch pumps claim concurrently", async () => {
  const setup = await executionFixture();
  const initialDispatch = setup.repository.runDispatch(
    ownerId,
    agentId,
    authority,
    lease,
    "thread-run-lifecycle",
  );
  const initialClaim = executionLease(setup.runId);
  await initialDispatch.release({
    runId: setup.runId,
    expectedLeaseRevision: initialClaim.expectedLeaseRevision,
    executionLeaseId: initialClaim.executionLeaseId,
    releasedAt: clock.now(),
  });

  let listed = 0;
  let releaseLists!: () => void;
  const listsReady = new Promise<void>((resolve) => {
    releaseLists = resolve;
  });
  const wrapDispatch = (dispatch: RunDispatchPort): RunDispatchPort => ({
    listClaimable: async (input) => {
      const candidates = await dispatch.listClaimable(input);
      listed += 1;
      if (listed === 2) releaseLists();
      await listsReady;
      return candidates;
    },
    listReconciliationRequired: (input) => dispatch.listReconciliationRequired(input),
    claim: (input) => dispatch.claim(input),
    renew: (input) => dispatch.renew(input),
    release: (input) => dispatch.release(input),
    assertHeld: (input) => dispatch.assertHeld(input),
  });
  const input = async ({
    candidate,
    lease: claimed,
  }: {
    readonly candidate: Awaited<ReturnType<RunDispatchPort["listClaimable"]>>[number];
    readonly lease: RunExecutionLease;
  }) => ({
    ...setup.input,
    ownerId: claimed.ownerId,
    agentId: claimed.agentId,
    runId: candidate.runId,
    authority: {
      leaseId: claimed.authorityLeaseId,
      fencingToken: claimed.fencingToken,
    },
    executionLease: claimFromRunExecutionLease(claimed),
  });
  const coordinator = {
    execute: (value: typeof setup.input) => setup.coordinator.execute(value),
    interruptExecution: (value: Parameters<typeof setup.coordinator.interruptExecution>[0]) =>
      setup.coordinator.interruptExecution(value),
  };
  const authorityPort = {
    assertActive: async () => {
      await setup.repository.deploymentAuthorityPort().assertCurrent(authority);
    },
    isAccepting: () => true,
  };
  const createDispatcher = (consumerId: string, instanceId: string) =>
    new ProductionRunDispatcher({
      authority: authorityPort,
      dispatch: wrapDispatch(
        setup.repository.runDispatch(ownerId, agentId, authority, lease, consumerId),
      ),
      coordinator,
      input,
      reconcile: async () => undefined,
      clock,
      executionLeaseDurationMs: 60_000,
      maximumRunsPerPump: 1,
      instanceId,
    });
  const first = createDispatcher("dispatch-consumer-one", "dispatch-pump-one");
  const second = createDispatcher("dispatch-consumer-two", "dispatch-pump-two");

  const [firstResult, secondResult] = await Promise.all([first.pump(), second.pump()]);
  expect(firstResult.claimed + secondResult.claimed).toBe(1);
  expect(firstResult.settled + secondResult.settled).toBe(1);
  expect(firstResult.conflicts + secondResult.conflicts).toBe(1);
  expect(setup.attempts()).toBe(1);
});

it("does not dispatch an external action after an attempt is interrupted at context", async () => {
  const setup = await executionFixture();
  let contextStarted!: () => void;
  const contextReady = new Promise<void>((resolve) => {
    contextStarted = resolve;
  });
  let releaseContext!: () => void;
  const contextReleased = new Promise<void>((resolve) => {
    releaseContext = resolve;
  });
  const context = {
    async form(request: Parameters<typeof setup.context.form>[0]) {
      contextStarted();
      await contextReleased;
      return setup.context.form(request);
    },
  };
  let runtimeRuns = 0;
  const runtime: AgentRuntimePort = {
    async *run() {
      runtimeRuns += 1;
      yield {
        type: "runtime.completed" as const,
        runId: setup.runId,
        occurredAt: clock.now(),
        output: { kind: "assistant-answer" as const, contentRef: "payload-final-answer" },
      };
    },
    async cancel() {},
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  const executionLease = setup.input.executionLease;
  if (!executionLease) throw new Error("Missing execution lease claim");
  const execution = coordinator.execute(setup.input);
  await contextReady;
  let interruptError: unknown;
  try {
    await coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: executionLease.executionLeaseId,
      reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
    });
  } catch (error) {
    interruptError = error;
  } finally {
    releaseContext();
  }
  let executionError: unknown;
  try {
    await execution;
  } catch (error) {
    executionError = error;
  }
  expect(interruptError).toBeUndefined();
  expect(executionError).toMatchObject({
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
  expect(runtimeRuns).toBe(0);
});

it("cancels a started runtime once for its exact execution attempt", async () => {
  const setup = await executionFixture();
  let runtimeStarted!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    runtimeStarted = resolve;
  });
  let releaseRuntime!: () => void;
  const runtimeReleased = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  let runtimeRuns = 0;
  let runtimeCancellations = 0;
  let cancelled = false;
  const runtime: AgentRuntimePort = {
    async *run() {
      runtimeRuns += 1;
      runtimeStarted();
      await runtimeReleased;
      if (cancelled) {
        yield {
          type: "runtime.cancelled" as const,
          runId: setup.runId,
          reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
          occurredAt: clock.now(),
        };
      }
    },
    async cancel() {
      runtimeCancellations += 1;
      cancelled = true;
      releaseRuntime();
    },
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  const executionLease = setup.input.executionLease;
  if (!executionLease) throw new Error("Missing execution lease claim");
  const execution = coordinator.execute(setup.input);
  await runtimeReady;
  let interruptError: unknown;
  try {
    await coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: executionLease.executionLeaseId,
      reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
    });
    await coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: executionLease.executionLeaseId,
      reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
    });
  } catch (error) {
    interruptError = error;
  } finally {
    releaseRuntime();
  }
  let executionError: unknown;
  try {
    await execution;
  } catch (error) {
    executionError = error;
  }
  expect(interruptError).toBeUndefined();
  expect(executionError).toMatchObject({
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
  expect(runtimeRuns).toBe(1);
  expect(runtimeCancellations).toBe(1);
});

it("keeps the Run attempt occupied until deferred cancellation finishes", async () => {
  const setup = await executionFixture();
  let runtimeStarted!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    runtimeStarted = resolve;
  });
  let releaseRuntime!: () => void;
  const runtimeReleased = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  let releaseCancellation!: () => void;
  const cancellationReleased = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let runtimeIteratorFinished!: () => void;
  const runtimeIteratorFinishedReady = new Promise<void>((resolve) => {
    runtimeIteratorFinished = resolve;
  });
  const runtime: AgentRuntimePort = {
    run(): AsyncIterable<RuntimeEvent> {
      let done = false;
      const iterator: AsyncIterator<RuntimeEvent> & AsyncIterable<RuntimeEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<RuntimeEvent>> {
          if (done) return { done: true, value: undefined };
          done = true;
          runtimeStarted();
          try {
            await runtimeReleased;
          } finally {
            runtimeIteratorFinished();
          }
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    async cancel() {
      cancellationStarted();
      await cancellationReleased;
      throw new Error("RUNTIME_CANCEL_FAILED");
    },
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  const executionLease = setup.input.executionLease;
  if (!executionLease) throw new Error("Missing execution lease claim");

  const execution = coordinator.execute(setup.input);
  await runtimeReady;
  const interruption = coordinator.interruptExecution({
    runId: setup.runId,
    executionLeaseId: executionLease.executionLeaseId,
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
  await cancellationReady;
  releaseRuntime();
  await runtimeIteratorFinishedReady;
  await new Promise<void>((resolve) => setImmediate(resolve));

  await expect(coordinator.execute(setup.input)).rejects.toMatchObject({
    code: PORT_ERROR_CODES.CONFLICT,
  });

  releaseCancellation();
  await expect(interruption).resolves.toMatchObject({
    runId: setup.runId,
    executionLeaseId: executionLease.executionLeaseId,
    failures: [{ target: "runtime", error: { message: "RUNTIME_CANCEL_FAILED" } }],
  });
  await expect(execution).rejects.toMatchObject({
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
});

it("rejects a second active attempt and isolates an ended lease from the next attempt", async () => {
  const setup = await executionFixture();
  await setup.coordinator.execute(setup.input);
  const previousLease = setup.input.executionLease;
  if (!previousLease) throw new Error("Missing execution lease claim");

  let firstReadStarted!: () => void;
  const firstReadReady = new Promise<void>((resolve) => {
    firstReadStarted = resolve;
  });
  let releaseFirstRead!: () => void;
  const firstReadReleased = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let secondReadStarted!: () => void;
  const secondReadReady = new Promise<void>((resolve) => {
    secondReadStarted = resolve;
  });
  let releaseSecondRead!: () => void;
  const secondReadReleased = new Promise<void>((resolve) => {
    releaseSecondRead = resolve;
  });
  let reads = 0;
  const checkpoints = {
    read: async (runId: Parameters<typeof setup.checkpoints.read>[0]) => {
      reads += 1;
      if (reads === 1) {
        firstReadStarted();
        await firstReadReleased;
      } else if (reads === 2) {
        secondReadStarted();
        await secondReadReleased;
      }
      return setup.checkpoints.read(runId);
    },
    compareAndSet: async (input: Parameters<typeof setup.checkpoints.compareAndSet>[0]) =>
      setup.checkpoints.compareAndSet(input),
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints,
    context: setup.context,
    runtime: setup.runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });

  const first = coordinator.execute(setup.input);
  await firstReadReady;
  await expect(coordinator.execute(setup.input)).rejects.toMatchObject({
    code: PORT_ERROR_CODES.CONFLICT,
  });
  await expect(
    coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: previousLease.executionLeaseId,
      reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
    }),
  ).resolves.toMatchObject({
    executionLeaseId: previousLease.executionLeaseId,
  });
  releaseFirstRead();
  await expect(first).rejects.toMatchObject({
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });

  const nextLease = Object.freeze({
    ...previousLease,
    executionLeaseId: createRunExecutionLeaseId(`execution-next-${setup.runId}`),
  });
  const next = coordinator.execute({ ...setup.input, executionLease: nextLease });
  await secondReadReady;
  await expect(
    coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: previousLease.executionLeaseId,
      reasonCode: "STALE_EXECUTION_LEASE",
    }),
  ).resolves.toBeUndefined();
  releaseSecondRead();
  await expect(next).resolves.toMatchObject({
    run: { run: { status: "completed" } },
  });
});

it("attempts worker cancellation once and retains its failure diagnostic", async () => {
  const setup = await executionFixture();
  const workerRunId = "worker-interruption-failure";
  const worker = {
    workerRunId,
    idempotencyKey: "worker-interruption-failure-command",
    ownerId: setup.input.ownerId,
    agentId: setup.input.agentId,
    parentRunId: setup.runId,
    taskRef: setup.input.context.trigger.payloadRef,
    selectedModelRef: "model-worker-interruption",
    allowedModelRefs: ["model-worker-interruption"],
    outputSchema: { type: "object" },
    delegatedContextRefs: [setup.input.context.trigger.payloadRef],
    capabilityHandleRefs: [],
    secretRefs: [],
    dataClassification: "private" as const,
    budget: { maxDurationMs: 1_000, maxCostMicros: 1_000, maxProgressEvents: 1 },
    deadlineAt: "2026-09-04T00:01:00.000Z",
  };
  let workerStarted!: () => void;
  const workerReady = new Promise<void>((resolve) => {
    workerStarted = resolve;
  });
  let releaseWorker!: () => void;
  const workerReleased = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  let cancellations = 0;
  const workers: WorkerRunPort = {
    run(): AsyncIterable<WorkerRunEvent> {
      let done = false;
      const iterator: AsyncIterator<WorkerRunEvent> & AsyncIterable<WorkerRunEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<WorkerRunEvent>> {
          if (done) return { done: true, value: undefined };
          done = true;
          workerStarted();
          await workerReleased;
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    async cancel(cancelledWorkerRunId) {
      expect(cancelledWorkerRunId).toBe(workerRunId);
      cancellations += 1;
      throw new Error("WORKER_CANCEL_FAILED");
    },
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime: setup.runtime,
    workers,
    trace: setup.trace,
  });
  const executionLease = setup.input.executionLease;
  if (!executionLease) throw new Error("Missing execution lease claim");
  const execution = coordinator.execute({ ...setup.input, workers: [{ request: worker }] });
  await workerReady;
  const interruption = coordinator.interruptExecution({
    runId: setup.runId,
    executionLeaseId: executionLease.executionLeaseId,
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
  await expect(interruption).resolves.toMatchObject({
    workerRunIds: [workerRunId],
    failures: [{ target: "worker", workerRunId, error: { message: "WORKER_CANCEL_FAILED" } }],
  });
  await expect(
    coordinator.interruptExecution({
      runId: setup.runId,
      executionLeaseId: executionLease.executionLeaseId,
      reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
    }),
  ).resolves.toMatchObject({
    failures: [{ target: "worker", workerRunId, error: { message: "WORKER_CANCEL_FAILED" } }],
  });
  expect(cancellations).toBe(1);
  releaseWorker();
  await expect(execution).rejects.toMatchObject({
    reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
  });
});

it("commits one protected final assistant through the coordinator and reads it after reopen", async () => {
  const setup = await executionFixture();
  await expect(setup.coordinator.execute(setup.input)).resolves.toMatchObject({
    run: { run: { status: "completed" } },
  });
  await setup.coordinator.execute(setup.input);
  expect(setup.attempts()).toBe(1);
  await setup.repository.close();
  const reopened = await SqliteProductStateRepository.open({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(reopened);
  const messages = await reopened
    .threadRepository()
    .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10);
  expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  const answer = messages.find((message) => message.role === "agent");
  if (!answer) throw new Error("Missing assistant answer");
  const payload = await reopened.payloadStore(ownerId, agentId).get(answer.contentRef);
  if (!payload) throw new Error("Missing protected answer");
  expect(payload.contentType).toBe("text/plain");
  expect(
    new TextDecoder().decode(await setup.protector.unprotect({ ownerId, agentId, payload })),
  ).toBe("这是最终回答。\n无需 JSON 引号。");
  expect(answer.turnId).toBe(setup.admitted.message.turnId);
});

function completionInput(setup: Awaited<ReturnType<typeof executionFixture>>): RunCompletionInput {
  return {
    ...setup.input.commands.completed,
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    executionLease: executionLease(setup.runId),
    expectedRevision: 3,
    dataClassification: "private",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  };
}

it.each([
  { objectType: "thread", shared: false },
  { objectType: "run", shared: false },
  { objectType: "thread", shared: true },
  { objectType: "run", shared: true },
] as const)(
  "removes settled completion projections on $objectType deletion while shared=$shared",
  async ({ objectType, shared }) => {
    const setup = await executionFixture();
    const crashing = new RunCoordinator({
      runs: {
        ...setup.runs,
        completeRun: async () => {
          throw new Error("crash-before-completion");
        },
      },
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    await expect(crashing.execute(setup.input)).rejects.toThrow("crash-before-completion");
    expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
      phase: "runtime_settled",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
    });
    if (shared) {
      const created = await setup.commands.create({
        ownerId,
        agentId,
        idempotencyKey: "retained-thread",
        resultRef: "payload-run-lifecycle",
      });
      await setup.commands.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedThreadRevision: created.thread.revision,
        sessionId: createSessionId("retained-session"),
        idempotencyKey: "retained-answer",
        contentRef: "payload-final-answer",
        sourceProofRef: "proof:owner",
        dataClassification: "private",
        resultRef: "payload-run-lifecycle",
      });
    }
    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot: setup.stateRoot,
      databasePath: setup.databasePath,
      ownerId,
      agentId,
      now: () => clock.now(),
    });
    await setup.repository.close();
    const result = await deletion.deleteImmediately({
      objectType,
      objectId: objectType === "thread" ? setup.admitted.thread.id : setup.runId,
    });
    expect(result.lifecycle).toBe("deleted_verified");
    const database = openQualifiedDatabase(setup.databasePath);
    expect
      .soft(
        database
          .prepare("SELECT run_id FROM run_coordination_checkpoints WHERE run_id = ?")
          .get(setup.runId),
      )
      .toBeUndefined();
    const answer = database
      .prepare("SELECT ref FROM payloads WHERE ref = 'payload-final-answer'")
      .get();
    if (shared) expect.soft(answer).toBeDefined();
    else expect.soft(answer).toBeUndefined();
    database.close();
  },
);

async function runningFixture() {
  const setup = await executionFixture();
  await setup.runs.transitionRun(transition(setup.runId, "building_context", 1));
  await setup.runs.transitionRun(transition(setup.runId, "running", 2));
  return setup;
}

it("retains a Payload referenced only by a surviving completion checkpoint", async () => {
  const setup = await executionFixture();
  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    executionLease: executionLease(setup.runId),
    checkpoint: {
      phase: "runtime_settled",
      contextRef: null,
      workerResults: {},
      runtimeEventCount: 1,
      lastTraceEventId: null,
      terminalStatus: "completed",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      diagnosticCode: null,
    },
  });
  await setup.repository.close();
  const deletion = new SqliteGovernedDeletionAdapter({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    ownerId,
    agentId,
    now: () => clock.now(),
  });
  await expect(
    deletion.deleteImmediately({ objectType: "payload", objectId: "payload-final-answer" }),
  ).rejects.toThrow("referenced Payload");
});

it.each(["before", "after"] as const)(
  "recovers a crash %s the assistant transaction without another model attempt",
  async (boundary) => {
    const setup = await executionFixture();
    const runs: RunLifecyclePort = {
      ...setup.runs,
      completeRun: async (input) => {
        if (boundary === "after") await setup.runs.completeRun(input);
        throw new Error(`crash-${boundary}-completion`);
      },
    };
    const crashing = new RunCoordinator({
      runs,
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    await expect(crashing.execute(setup.input)).rejects.toThrow(`crash-${boundary}-completion`);
    expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
      phase: "runtime_settled",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
    });
    await setup.repository.close();
    const reopened = await SqliteProductStateRepository.open({
      stateRoot: setup.stateRoot,
      databasePath: setup.databasePath,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    repositories.push(reopened);
    const resumed = new RunCoordinator({
      runs: reopened.runLifecycle(ownerId, agentId, authority),
      checkpoints: reopened.runCheckpointStore(ownerId, agentId, authority),
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    expect((await resumed.execute(setup.input)).run.run.status).toBe("completed");
    expect(setup.attempts()).toBe(1);
    expect(
      (
        await reopened
          .threadRepository()
          .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
      ).filter((message) => message.role === "agent"),
    ).toHaveLength(1);
  },
);

it("replays completion receipts after outbox cleanup and rejects changed completion semantics", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const receipt = await setup.runs.completeRun(input);
  const database = openQualifiedDatabase(setup.databasePath);
  database.prepare("DELETE FROM reliable_events WHERE topic = 'run.completed'").run();
  database.close();
  expect(await setup.runs.completeRun(input)).toEqual({ ...receipt, replayed: true });
  await expect(
    setup.runs.completeRun({ ...input, output: { kind: "no-answer" } }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
});

it("replays a pre-execution-lease completion receipt with its legacy fingerprint", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const legacyFingerprint = `run-transition:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        ownerId,
        agentId,
        setup.runId,
        [input.output, input.dataClassification],
        input.payloadRef,
        input.commandFingerprint,
      ]),
    )
    .digest("hex")}`;
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, input.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare(`INSERT INTO command_results
      (id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint,
       deployment_id, authority_epoch, fencing_token, result_ref, state_key, state_revision,
       committed_at)
      VALUES (?, ?, ?, ?, 'run.complete', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `legacy-run-command:${identity}`,
      ownerId,
      agentId,
      input.idempotencyKey,
      legacyFingerprint,
      deploymentId,
      authority.authorityEpoch,
      authority.fencingToken,
      setup.runId,
      setup.runId,
      input.expectedRevision + 1,
      clock.now(),
    );
  database.close();

  await expect(setup.runs.completeRun(input)).resolves.toEqual({
    replayed: true,
    commandResult: {
      ownerId,
      agentId,
      idempotencyKey: input.idempotencyKey,
      commandType: "run.complete",
      commandFingerprint: legacyFingerprint,
      stateKey: setup.runId,
      stateRevision: input.expectedRevision + 1,
      resultRef: setup.runId,
      committedAt: clock.now(),
    },
  });
});

it("keeps completion atomic when its last reliable event insert fails", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, input.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare(`INSERT INTO reliable_events (id, owner_id, agent_id, idempotency_key, topic,
    payload_ref, publication_state, occurred_at) VALUES (?, ?, ?, 'collision', 'collision',
    'payload-run-lifecycle', 'pending', ?)`)
    .run(`run-event:${identity}`, ownerId, agentId, clock.now());
  const beforeThread = database
    .prepare("SELECT revision FROM threads WHERE id = ?")
    .get(setup.admitted.thread.id);
  await expect(setup.runs.completeRun(input)).rejects.toThrow();
  expect(await setup.runs.readRun(setup.runId)).toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  expect(
    database.prepare("SELECT revision FROM threads WHERE id = ?").get(setup.admitted.thread.id),
  ).toEqual(beforeThread);
  expect(
    database.prepare("SELECT committed_at FROM turns WHERE run_id = ?").get(setup.runId),
  ).toEqual({ committed_at: null });
  expect(
    database
      .prepare("SELECT id FROM thread_messages WHERE run_id = ? AND role = 'agent'")
      .all(setup.runId),
  ).toEqual([]);
  expect(
    database.prepare("SELECT id FROM command_results WHERE idempotency_key IN (?, ?)").all(
      input.idempotencyKey,
      `runtime-assistant:${createHash("sha256")
        .update(
          JSON.stringify([
            "runtime-assistant",
            ownerId,
            agentId,
            setup.runId,
            input.idempotencyKey,
          ]),
        )
        .digest("hex")}`,
    ),
  ).toEqual([]);
  database.close();
});

it("allows a concurrent rename but refuses completion after Trash", async () => {
  const setup = await runningFixture();
  await setup.commands.rename({
    ownerId,
    agentId,
    threadId: setup.admitted.thread.id,
    expectedRevision: setup.admitted.thread.revision,
    titleRef: "payload-run-lifecycle",
    source: "owner",
    idempotencyKey: "completion-rename",
    resultRef: "payload-run-lifecycle",
  });
  await expect(setup.runs.completeRun(completionInput(setup))).resolves.toMatchObject({
    replayed: false,
  });
  const trashed = await runningFixture();
  const database = openQualifiedDatabase(trashed.databasePath);
  database
    .prepare("UPDATE threads SET status = 'trashed' WHERE id = ?")
    .run(trashed.admitted.thread.id);
  database.close();
  await expect(trashed.runs.completeRun(completionInput(trashed))).rejects.toThrow();
  expect((await trashed.runs.readRun(trashed.runId))?.run.status).toBe("running");
});

it("does not overwrite a completed checkpoint when cancellation arrives later", async () => {
  const setup = await executionFixture();
  await setup.coordinator.execute(setup.input);
  const checkpoint = await setup.checkpoints.read(setup.runId);
  expect(
    (
      await setup.coordinator.cancel({
        ownerId,
        agentId,
        runId: setup.runId,
        authority: lease,
        command: setup.input.commands.cancelled,
        reasonCode: "LATE_CANCEL",
      })
    ).run.status,
  ).toBe("completed");
  expect(await setup.checkpoints.read(setup.runId)).toEqual(checkpoint);
});

it("reconciles an old successful checkpoint without output without calling the model", async () => {
  const setup = await runningFixture();
  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    executionLease: executionLease(setup.runId),
    checkpoint: {
      phase: "runtime_settled",
      contextRef: "payload-run-lifecycle",
      workerResults: {},
      runtimeEventCount: 1,
      lastTraceEventId: null,
      terminalStatus: "completed",
      output: null,
      diagnosticCode: null,
    },
  });
  const result = await setup.coordinator.execute(setup.input);
  expect(result.run.run.status).toBe("reconciling_external_result");
  expect(result.checkpoint.diagnosticCode).toBe("RUNTIME_COMPLETION_OUTPUT_MISSING");
  expect(setup.attempts()).toBe(0);
});

it.each(["no-answer", "empty-ref"] as const)(
  "fails a Thread runtime with invalid successful output: %s",
  async (kind) => {
    const setup = await executionFixture();
    const runtime = new ScriptedAgentRuntime(
      () => clock.now(),
      [
        {
          type: "runtime.completed",
          runId: setup.runId,
          occurredAt: clock.now(),
          output:
            kind === "no-answer"
              ? { kind: "no-answer" }
              : { kind: "assistant-answer", contentRef: "" },
        },
      ],
    );
    const coordinator = new RunCoordinator({
      runs: setup.runs,
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    const result = await coordinator.execute(setup.input);
    expect(result.run.run.status).toBe("failed");
    expect(result.checkpoint.diagnosticCode).toBe("RUNTIME_FINAL_ANSWER_INVALID");
  },
);

it("rejects completion scope, stale fences, stale CAS, and insufficient final Payload classification", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  await expect(
    setup.runs.completeRun({ ...input, ownerId: createOwnerId("other-owner") }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    setup.runs.completeRun({ ...input, authority: { ...lease, fencingToken: 2 } }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(setup.runs.completeRun({ ...input, expectedRevision: 2 })).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(
    setup.runs.completeRun({ ...input, dataClassification: "sensitive" }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  await expect(
    setup.runs.completeRun({
      ...input,
      output: { kind: "assistant-answer", contentRef: "missing-answer" },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare("UPDATE payloads SET classification = 'public' WHERE ref = 'payload-final-answer'")
    .run();
  database.close();
  await expect(setup.runs.completeRun(input)).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  await setup.repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(setup.runs.completeRun(input)).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
  expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("running");
});

it("enforces typed checkpoint CAS, active Payload scope, Trace scope, and deployment fencing", async () => {
  const setup = await runningFixture();
  const checkpoint = {
    phase: "runtime_running" as const,
    contextRef: "payload-run-lifecycle",
    workerResults: Object.fromEntries([["__proto__", "payload-run-lifecycle"]]),
    runtimeEventCount: 0,
    lastTraceEventId: null,
    terminalStatus: null,
    output: null,
    diagnosticCode: null,
  };
  const saved = await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    executionLease: executionLease(setup.runId),
    checkpoint,
  });
  expect(saved.revision).toBe(1);
  expect(Object.hasOwn(saved.checkpoint.workerResults, "__proto__")).toBe(true);
  expect(saved.checkpoint.workerResults["__proto__"]).toBe("payload-run-lifecycle");
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: null,
      executionLease: executionLease(setup.runId),
      checkpoint,
    }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  await expect(
    setup.repository
      .runCheckpointStore(createOwnerId("owner-other"), agentId, authority)
      .read(setup.runId),
  ).resolves.toBeUndefined();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      executionLease: executionLease(setup.runId),
      checkpoint: { ...checkpoint, lastTraceEventId: "trace-outside-run" },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare("UPDATE payloads SET lifecycle_state = 'trashed' WHERE ref = ?")
    .run("payload-run-lifecycle");
  database.close();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      executionLease: executionLease(setup.runId),
      checkpoint: { ...checkpoint, runtimeEventCount: 1 },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const restoredDatabase = openQualifiedDatabase(setup.databasePath);
  restoredDatabase
    .prepare("UPDATE payloads SET lifecycle_state = 'active' WHERE ref = ?")
    .run("payload-run-lifecycle");
  restoredDatabase
    .prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?")
    .run(deploymentId);
  restoredDatabase.close();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      executionLease: executionLease(setup.runId),
      checkpoint: { ...checkpoint, runtimeEventCount: 1 },
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
});

it("preserves completion and its receipt for an authorized replay after lease release", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const receipt = await setup.runs.completeRun(input);
  await setup.repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(setup.runs.completeRun(input)).resolves.toEqual({ ...receipt, replayed: true });
});

it("rejects cross-scope cancellation before touching the runtime", async () => {
  const setup = await executionFixture();
  const cancel = vi.spyOn(setup.runtime, "cancel");
  await expect(
    setup.coordinator.cancel({
      ownerId: createOwnerId("other-owner"),
      agentId,
      runId: setup.runId,
      authority: lease,
      command: setup.input.commands.cancelled,
      reasonCode: "WRONG_SCOPE",
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  expect(cancel).not.toHaveBeenCalled();
  await expect(
    setup.coordinator.cancel({
      ownerId,
      agentId,
      runId: setup.runId,
      authority: { ...lease, fencingToken: 2 },
      command: setup.input.commands.cancelled,
      reasonCode: "STALE_AUTHORITY",
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  expect(cancel).not.toHaveBeenCalled();
  expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("accepted");
});

it("keeps cancellation authoritative when successful runtime output races with it", async () => {
  const setup = await executionFixture();
  const runtime: AgentRuntimePort = {
    async *run() {
      await setup.runs.transitionRun(transition(setup.runId, "cancelled", 3));
      yield {
        type: "runtime.completed",
        runId: setup.runId,
        occurredAt: clock.now(),
        output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      };
    },
    async cancel() {},
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  const result = await coordinator.execute(setup.input);
  expect(result.run.run.status).toBe("cancelled");
  expect(result.checkpoint).toMatchObject({
    phase: "cancelled",
    terminalStatus: "cancelled",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  });
  expect(
    (
      await setup.repository
        .threadRepository()
        .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
    ).filter((message) => message.role === "agent"),
  ).toHaveLength(0);
});

it("retains observed output through cancellation until governed Run deletion", async () => {
  const setup = await executionFixture();
  const crashing = new RunCoordinator({
    runs: {
      ...setup.runs,
      completeRun: async () => {
        throw new Error("crash-before-completion");
      },
    },
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime: setup.runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  await expect(crashing.execute(setup.input)).rejects.toThrow("crash-before-completion");

  const workerPayload = await setup.protector.protect({
    ownerId,
    agentId,
    ref: "payload-cancelled-worker-only",
    dataClassification: "private",
    contentType: "text/plain",
    createdAt: clock.now(),
    plaintext: new TextEncoder().encode("worker result"),
  });
  await setup.repository.payloadStore(ownerId, agentId).put(workerPayload);

  const beforeCancellation = await setup.checkpoints.read(setup.runId);
  if (!beforeCancellation) throw new Error("Missing pre-cancellation checkpoint");
  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: beforeCancellation.revision,
    executionLease: executionLease(setup.runId),
    checkpoint: {
      ...beforeCancellation.checkpoint,
      workerResults: Object.fromEntries([["__proto__", "payload-cancelled-worker-only"]]),
    },
  });

  const cancelled = await setup.coordinator.cancel({
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    command: setup.input.commands.cancelled,
    reasonCode: "OWNER_CANCELLED",
  });
  expect(cancelled.run.status).toBe("cancelled");
  const cancelledCheckpoint = await setup.checkpoints.read(setup.runId);
  expect(cancelledCheckpoint?.checkpoint).toMatchObject({
    phase: "cancelled",
    terminalStatus: "cancelled",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  });
  if (!cancelledCheckpoint) throw new Error("Missing cancelled checkpoint");

  expect(
    (
      await setup.repository
        .threadRepository()
        .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
    ).filter((message) => message.role === "agent"),
  ).toHaveLength(0);

  const deletion = new SqliteGovernedDeletionAdapter({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    ownerId,
    agentId,
    now: () => clock.now(),
  });
  await setup.repository.close();
  const result = await deletion.deleteImmediately({ objectType: "run", objectId: setup.runId });
  expect(result.lifecycle).toBe("deleted_verified");
  const database = openQualifiedDatabase(setup.databasePath);
  expect(
    database
      .prepare("SELECT run_id FROM run_coordination_checkpoints WHERE run_id = ?")
      .get(setup.runId),
  ).toBeUndefined();
  expect(
    database
      .prepare("SELECT ref FROM payloads WHERE ref IN (?, ?)")
      .all("payload-final-answer", "payload-cancelled-worker-only"),
  ).toEqual([]);
  database.close();
});

it.each(["no-answer", "assistant-answer"] as const)(
  "completes a non-Thread Run with explicit %s output",
  async (kind) => {
    const setup = await executionFixture();
    const runId = createRunId(`background-${kind}`);
    const database = openQualifiedDatabase(setup.databasePath);
    database
      .prepare(`INSERT INTO triggers (id, owner_id, agent_id, idempotency_key, source_type,
    source_id, payload_ref, source_proof_ref, occurred_at) VALUES (?, ?, ?, ?, 'schedule',
    'schedule-test', 'payload-run-lifecycle', 'proof:schedule', ?)`)
      .run(`trigger-${kind}`, ownerId, agentId, `trigger-${kind}`, clock.now());
    database
      .prepare(`INSERT INTO runs (id, owner_id, agent_id, session_id, trigger_id, revision,
    status, created_at, updated_at) VALUES (?, ?, ?, 'background-session', ?, 3, 'running', ?, ?)`)
      .run(runId, ownerId, agentId, `trigger-${kind}`, clock.now(), clock.now());
    database
      .prepare(`INSERT INTO run_coordination_checkpoints
        (run_id, owner_id, agent_id, revision, phase, runtime_event_count, updated_at)
        VALUES (?, ?, ?, 1, 'accepted', 0, ?)`)
      .run(runId, ownerId, agentId, clock.now());
    database.close();
    await setup.repository
      .runDispatch(ownerId, agentId, authority, lease, "thread-run-lifecycle")
      .claim({
        runId,
        expectedRunRevision: 3,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId(`execution-${runId}`),
        claimedAt: clock.now(),
        expiresAt: "2026-09-05T00:00:00.000Z",
      });
    await expect(
      setup.runs.completeRun({
        ...completionInput(setup),
        runId,
        executionLease: executionLease(runId),
        output:
          kind === "no-answer"
            ? { kind: "no-answer" }
            : { kind: "assistant-answer", contentRef: "payload-final-answer" },
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect((await setup.runs.readRun(runId))?.run.status).toBe("completed");
    expect(
      (
        await setup.repository
          .threadRepository()
          .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
      ).filter((message) => message.role === "agent"),
    ).toHaveLength(0);
  },
);

it("makes an admitted Thread Run visible to the production Run lifecycle", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 1,
    run: { id: runId, ownerId, agentId, status: "accepted" },
  });
  await expect(
    new RunStateCommitCoordinator(repository, clock).readRun(runId),
  ).resolves.toBeUndefined();
});

function transition(
  runId: RunId,
  nextStatus: TransitionRunStateInput["nextStatus"],
  expectedRevision: number,
  key: string = nextStatus,
): TransitionRunStateInput {
  return {
    ownerId,
    agentId,
    runId,
    nextStatus,
    expectedRevision,
    idempotencyKey: createIdempotencyKey(`transition-${key}`),
    commandFingerprint: `transition:${key}`,
    authority: lease,
    payloadRef: "payload-run-lifecycle",
    executionLease: executionLease(runId),
  };
}

it("transitions the relational Run with durable receipts/events and idempotent replay after reopen", async () => {
  const { repository, runId, databasePath, stateRoot } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  expect(result).toMatchObject({ replayed: false, commandResult: { stateRevision: 2 } });
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  await runs.transitionRun(transition(runId, "running", 2));
  await repository.close();
  const reopened = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(reopened);
  const recovered = reopened.runLifecycle(ownerId, agentId, authority);
  await expect(recovered.readRun(runId)).resolves.toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  await expect(recovered.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  expect(
    (await reopened.listPending(100)).filter((event) => event.topic.startsWith("run.")),
  ).toHaveLength(2);
  await expect(reopened.read(`run:${runId}`)).resolves.toBeUndefined();
});

it("rejects stale CAS, illegal transitions and mutated replay semantics without additional events", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  await expect(runs.transitionRun(transition(runId, "running", 1))).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  await runs.transitionRun(input);
  await expect(runs.transitionRun(transition(runId, "running", 1))).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(runs.transitionRun({ ...input, nextStatus: "running" })).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(
    runs.transitionRun({ ...input, payloadRef: "different-payload" }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect(
    (await repository.listPending(100)).filter((event) => event.topic.startsWith("run.")),
  ).toHaveLength(1);
});

it("fails closed on cross-scope reads, commands and deployment or lease fences", async () => {
  const { repository, runId } = await fixture();
  const otherOwner = createOwnerId("owner-other");
  await expect(
    repository.runLifecycle(otherOwner, agentId, authority).readRun(runId),
  ).resolves.toBeUndefined();
  await expect(
    repository.runLifecycle(ownerId, createAgentId("agent-other"), authority).readRun(runId),
  ).resolves.toBeUndefined();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  await expect(runs.transitionRun({ ...input, ownerId: otherOwner })).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
  await expect(
    runs.transitionRun({ ...input, authority: { ...lease, fencingToken: 2 } }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    repository
      .runLifecycle(ownerId, agentId, { ...authority, authorityEpoch: 2 })
      .transitionRun(input),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(runs.transitionRun(input)).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(runs.readRun(runId)).resolves.toMatchObject({ revision: 1 });
});

it("replays a committed receipt after authority release without allowing a new transition", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  await repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  await expect(runs.transitionRun(transition(runId, "running", 2))).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
});

it("reserves Thread completion for atomic assistant/Turn/Run commit", async () => {
  const { repository, runId, commands, admitted } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await runs.transitionRun(transition(runId, "building_context", 1));
  await runs.transitionRun(transition(runId, "running", 2));
  await expect(runs.transitionRun(transition(runId, "completed", 3))).rejects.toThrow(
    "atomic assistant commit",
  );
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  const turnId = admitted.message.turnId;
  if (!turnId) throw new Error("Missing admitted Turn");
  const input = {
    ownerId,
    agentId,
    threadId: admitted.thread.id,
    expectedThreadRevision: admitted.thread.revision,
    turnId,
    runId,
    idempotencyKey: "assistant-commit",
    contentRef: "payload-run-lifecycle",
    dataClassification: "private",
    resultRef: "payload-run-lifecycle",
  } as const;
  await commands.commitAssistantMessage(input);
  await commands.commitAssistantMessage(input);
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 4,
    run: { status: "completed" },
  });
  const messages = await repository
    .threadRepository()
    .listMessages(ownerId, agentId, admitted.thread.id, 0, 10);
  expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  await expect(runs.transitionRun(transition(runId, "failed", 4))).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
});

it.each(["failed", "cancelled"] as const)(
  "persists %s without fabricating an assistant",
  async (nextStatus) => {
    const { repository, runId, admitted } = await fixture();
    const runs = repository.runLifecycle(ownerId, agentId, authority);
    await runs.transitionRun(transition(runId, nextStatus, 1));
    await expect(runs.readRun(runId)).resolves.toMatchObject({
      revision: 2,
      run: { status: nextStatus },
    });
    const messages = await repository
      .threadRepository()
      .listMessages(ownerId, agentId, admitted.thread.id, 0, 10);
    expect(messages.map((message) => message.role)).toEqual(["owner"]);
  },
);

it("rolls back Run and receipt when the reliable event insert fails", async () => {
  const { repository, runId, databasePath } = await fixture();
  const input = transition(runId, "building_context", 1);
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, input.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(databasePath);
  database
    .prepare(`INSERT INTO reliable_events
    (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at)
    VALUES (?, ?, ?, 'conflicting-event', 'fixture', 'payload-run-lifecycle', 'pending', ?)`)
    .run(`run-event:${identity}`, ownerId, agentId, clock.now());
  database.close();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await expect(runs.transitionRun(input)).rejects.toThrow();
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 1,
    run: { status: "accepted" },
  });
  await expect(repository.findCommandResult(input)).resolves.toBeUndefined();
});

it.each(["session_id", "trigger_id"])(
  "does not expose a Run whose %s breaks relational admission scope",
  async (column) => {
    const { repository, runId, databasePath } = await fixture();
    const database = openQualifiedDatabase(databasePath);
    if (column === "session_id")
      database.prepare("UPDATE runs SET session_id = 'session-other' WHERE id = ?").run(runId);
    else {
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-other', ?, 0)")
        .run(ownerId);
      database
        .prepare(
          "UPDATE triggers SET agent_id = 'agent-other' WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
        )
        .run(runId);
    }
    database.close();
    await expect(
      repository.runLifecycle(ownerId, agentId, authority).readRun(runId),
    ).resolves.toBeUndefined();
  },
);

it("accepts a Thread-bound Run from a trigger without a Thread before any Turn exists", async () => {
  const { repository, runId, databasePath } = await fixture();
  const database = openQualifiedDatabase(databasePath);
  database
    .prepare(
      "UPDATE triggers SET thread_id = NULL WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
    )
    .run(runId);
  database.prepare("DELETE FROM thread_messages WHERE run_id = ?").run(runId);
  database.prepare("DELETE FROM turns WHERE run_id = ?").run(runId);
  database.close();
  await expect(
    repository.runLifecycle(ownerId, agentId, authority).readRun(runId),
  ).resolves.toMatchObject({ revision: 1 });
});

it("replays durable transition receipts independently of outbox retention", async () => {
  const { repository, runId, databasePath } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  const database = openQualifiedDatabase(databasePath);
  database.prepare("DELETE FROM reliable_events WHERE topic = 'run.building_context'").run();
  database.close();
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
});

it("prevents creating a second product-state truth for an admitted relational Run", async () => {
  const { repository, runId } = await fixture();
  const stored = await repository.runLifecycle(ownerId, agentId, authority).readRun(runId);
  if (!stored) throw new Error("Missing relational Run");
  const legacy = new RunStateCommitCoordinator(repository, clock);
  await expect(
    legacy.admitRun({
      run: stored.run,
      authority: lease,
      idempotencyKey: createIdempotencyKey("legacy-duplicate"),
      commandFingerprint: "legacy-duplicate",
      payloadRef: "payload-run-lifecycle",
    }),
  ).rejects.toThrow("cannot also be stored");
  await expect(legacy.readRun(runId)).resolves.toBeUndefined();
});

it("rejects Thread admission when the requested Run already belongs to product state", async () => {
  const { repository, runId, commands, admitted } = await fixture();
  const stored = await repository.runLifecycle(ownerId, agentId, authority).readRun(runId);
  if (!stored) throw new Error("Missing relational Run");
  const duplicateId = createRunId("run-existing-reference");
  await new RunStateCommitCoordinator(repository, clock).admitRun({
    run: { ...stored.run, id: duplicateId },
    authority: lease,
    idempotencyKey: createIdempotencyKey("existing-reference"),
    commandFingerprint: "existing-reference",
    payloadRef: "payload-run-lifecycle",
  });
  await expect(
    commands.admitOwnerMessage({
      ownerId,
      agentId,
      runId: duplicateId,
      threadId: admitted.thread.id,
      expectedThreadRevision: admitted.thread.revision,
      sessionId: stored.run.sessionId,
      idempotencyKey: "duplicate-thread-submit",
      contentRef: "payload-run-lifecycle",
      sourceProofRef: "proof:owner",
      dataClassification: "private",
      resultRef: "payload-run-lifecycle",
    }),
  ).rejects.toThrow("cannot duplicate a product-state Run");
  await expect(
    repository.runLifecycle(ownerId, agentId, authority).readRun(duplicateId),
  ).resolves.toBeUndefined();
});

it("lets the existing RunCoordinator cancel the admitted relational Run with a durable checkpoint", async () => {
  const { repository, runId } = await fixture();
  const adapters = createReferenceAdapterSet({ clock });
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const checkpoints = repository.runCheckpointStore(ownerId, agentId, authority);
  const coordinator = new RunCoordinator({
    runs,
    checkpoints,
    context: new ContextFormationService({
      memory: adapters.memory,
      trace,
      artifacts: adapters.runPayloadArtifacts,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      clock: adapters.clock,
      ids: adapters.ids,
    }),
    runtime: new ScriptedAgentRuntime(() => clock.now(), []),
    workers: new ScriptedWorkerRunPort(),
    trace,
  });
  const command = transition(runId, "cancelled", 1);
  await expect(
    coordinator.cancel({
      ownerId,
      agentId,
      runId,
      authority: lease,
      command,
      reasonCode: "OWNER_CANCELLED",
    }),
  ).resolves.toMatchObject({ run: { status: "cancelled" }, revision: 2 });
  await expect(checkpoints.read(runId)).resolves.toMatchObject({
    checkpoint: { phase: "cancelled", terminalStatus: "cancelled" },
  });
  await expect(repository.read(`run:${runId}`)).resolves.toBeUndefined();
});

it("cancels the relational Run atomically with checkpoint, lease and receipt", async () => {
  const setup = await fixture();
  const runs = setup.repository.runLifecycle(ownerId, agentId, authority);
  const command = transition(setup.runId, "cancelled", 1);
  const cancellation = {
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    expectedRevision: 1,
    idempotencyKey: command.idempotencyKey,
    commandFingerprint: command.commandFingerprint,
    payloadRef: command.payloadRef,
  };
  const result = await runs.cancelRun(cancellation);
  expect(result).toMatchObject({
    replayed: false,
    commandResult: { commandType: "run.transition", stateRevision: 2 },
  });
  await expect(runs.cancelRun(cancellation)).resolves.toEqual({ ...result, replayed: true });
  const database = openQualifiedDatabase(setup.databasePath);
  expect(
    database.prepare("SELECT status, revision FROM runs WHERE id = ?").get(setup.runId),
  ).toEqual({
    status: "cancelled",
    revision: 2,
  });
  expect(
    database
      .prepare(
        "SELECT phase, terminal_status, revision FROM run_coordination_checkpoints WHERE run_id = ?",
      )
      .get(setup.runId),
  ).toEqual({ phase: "cancelled", terminal_status: "cancelled", revision: 1 });
  expect(
    database
      .prepare("SELECT revision, released_at FROM run_execution_leases WHERE run_id = ?")
      .get(setup.runId),
  ).toEqual({ revision: 2, released_at: clock.now() });
  expect(
    database
      .prepare("SELECT topic FROM reliable_events WHERE idempotency_key = ?")
      .get(command.idempotencyKey),
  ).toEqual({ topic: "run.cancelled" });
  database.close();
});

it("rolls back cancellation state, checkpoint, lease and receipt when outbox insertion fails", async () => {
  const setup = await fixture();
  const command = transition(setup.runId, "cancelled", 1, "cancel-rollback");
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, command.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare(`INSERT INTO reliable_events
      (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at)
      VALUES (?, ?, ?, 'cancel-rollback-blocker', 'blocker', 'payload-run-lifecycle', 'pending', ?)`)
    .run(`run-event:${identity}`, ownerId, agentId, clock.now());
  database.close();
  const cancellation = {
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    expectedRevision: 1,
    idempotencyKey: command.idempotencyKey,
    commandFingerprint: command.commandFingerprint,
    payloadRef: command.payloadRef,
  };
  await expect(
    setup.repository.runLifecycle(ownerId, agentId, authority).cancelRun(cancellation),
  ).rejects.toThrow();
  const reopened = openQualifiedDatabase(setup.databasePath);
  expect(
    reopened.prepare("SELECT status, revision FROM runs WHERE id = ?").get(setup.runId),
  ).toEqual({
    status: "accepted",
    revision: 1,
  });
  expect(
    reopened
      .prepare("SELECT 1 FROM run_coordination_checkpoints WHERE run_id = ?")
      .get(setup.runId),
  ).toBeUndefined();
  expect(
    reopened
      .prepare("SELECT revision, released_at FROM run_execution_leases WHERE run_id = ?")
      .get(setup.runId),
  ).toEqual({ revision: 1, released_at: null });
  expect(
    reopened
      .prepare("SELECT 1 FROM command_results WHERE idempotency_key = ?")
      .get(command.idempotencyKey),
  ).toBeUndefined();
  reopened.close();
});

it("resolves a claimed Run from its original trigger after a later Owner message", async () => {
  const setup = await fixture();
  const sourcePort = setup.repository.runExecutionSource(ownerId, agentId);
  const first = await sourcePort.read(setup.runId);
  expect(first).toMatchObject({
    runId: setup.runId,
    sourceId: setup.admitted.message.id,
    sourceType: "user_message",
    payloadRef: "payload-run-lifecycle",
  });
  const later = await setup.commands.admitOwnerMessage({
    ownerId,
    agentId,
    threadId: setup.admitted.thread.id,
    expectedThreadRevision: setup.admitted.thread.revision,
    sessionId: createSessionId("session-run-lifecycle-later"),
    idempotencyKey: "later-message",
    contentRef: "payload-run-lifecycle",
    sourceProofRef: "proof:later-owner",
    dataClassification: "private",
    resultRef: "payload-run-lifecycle",
  });
  expect(later.message.runId).not.toBe(setup.runId);
  expect(await sourcePort.read(setup.runId)).toEqual(first);
  await expect(
    setup.repository.runExecutionSource(createOwnerId("other-owner"), agentId).read(setup.runId),
  ).resolves.toBeUndefined();
  await expect(
    setup.repository.runExecutionSource(ownerId, createAgentId("other-agent")).read(setup.runId),
  ).resolves.toBeUndefined();
});

it("freezes execution policy across factory recreation and rejects a different claimed source", async () => {
  const setup = await executionFixture();
  const source = await setup.repository.runExecutionSource(ownerId, agentId).read(setup.runId);
  if (!source) throw new Error("Missing execution source");
  const dispatch = setup.repository.runDispatch(
    ownerId,
    agentId,
    authority,
    lease,
    "thread-run-lifecycle",
  );
  const held = await dispatch.assertHeld({
    runId: setup.runId,
    expectedLeaseRevision: 1,
    executionLeaseId: executionLease(setup.runId).executionLeaseId,
    at: clock.now(),
  });
  const candidate = {
    ...source,
    runRevision: 1,
    runStatus: "accepted" as const,
    checkpointPhase: null,
    leaseRevision: 0,
    action: "start" as const,
  };
  const adapters = createReferenceAdapterSet({ clock });
  const policy = vi.fn(async () => ({
    modelRef: "primary-frozen",
    systemInstructionRef: "payload-final-answer",
    policyVersion: "production-policy-v1",
    policies: [],
    capabilities: [],
    capabilityHandleRefs: [],
    maxMemoryClassification: "private" as const,
    memoryLimit: 10,
    maxSelectedMemories: 5,
  }));
  const options = {
    source: setup.repository.runExecutionSource(ownerId, agentId),
    artifacts: setup.repository.runPayloadArtifactPort(ownerId, agentId, {
      product: authority,
      lease,
    }),
    payloads: setup.repository.payloadStore(ownerId, agentId),
    protector: setup.protector,
    clock,
    ids: adapters.ids,
    dispatch,
    policy,
  };
  const original = await new RunExecutionInputService(options).create({ candidate, lease: held });
  expect(original.context.trigger).toMatchObject({
    id: source.triggerId,
    payloadRef: source.payloadRef,
  });
  expect(original.executionLease).toEqual(claimFromRunExecutionLease(held));
  const changedPolicy = vi.fn(async () => {
    throw new Error("Must not reselect policy");
  });
  const restored = await new RunExecutionInputService({ ...options, policy: changedPolicy }).create(
    { candidate, lease: held },
  );
  expect(restored).toEqual(original);
  expect(policy).toHaveBeenCalledTimes(1);
  expect(changedPolicy).not.toHaveBeenCalled();
  await expect(
    new RunExecutionInputService(options).create({
      candidate: { ...candidate, sessionId: createSessionId("other-session") },
      lease: held,
    }),
  ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
  await expect(setup.coordinator.execute(original)).resolves.toMatchObject({
    run: { run: { status: "completed" } },
  });
  const messages = await setup.repository
    .threadRepository()
    .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 100);
  expect(messages.filter((message) => message.role === "agent")).toMatchObject([
    { runId: setup.runId, contentRef: "payload-final-answer", status: "committed" },
  ]);
});
