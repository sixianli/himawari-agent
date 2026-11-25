import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentRuntimePort,
  ContextFormationService,
  claimFromRunExecutionLease,
  type ExecuteCoordinatedRunInput,
  type ModelInvocationAdmissionPort,
  PORT_ERROR_CODES,
  type ProductMemoryRecord,
  ProductThreadGatewayAdapter,
  type RunCompletionInput,
  RunCoordinator,
  type RunDispatchPort,
  RunExecutionInputService,
  type RunExecutionSource,
  type RunExecutionLease,
  type RunLifecyclePort,
  type RunModelSelection,
  RunStateCommitCoordinator,
  type RuntimeEvent,
  type RuntimeRequest,
  SessionTraceRecorder,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadExecutionProjection,
  ThreadForkService,
  ThreadQueryService,
  type TransitionRunStateInput,
  type WorkerRunEvent,
  type WorkerRunPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createMemoryId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
  type RunId,
  type ThreadId,
} from "@himawari-agent/domain";
import {
  threadExecutionRecordSchema,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  BrowserTextPayloadReader,
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import {
  createReferenceAdapterSet,
  ManualClock,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
  testModelEgress,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionRunDispatcher } from "../../apps/agent-service/src/production-run-dispatcher.js";
import { createProductionRunReconciler } from "../../apps/agent-service/src/production-run-reconciler.js";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

describe.each(["worker", "direct"] as const)("thread-run-lifecycle through %s", (execution) => {
  useSqliteContractExecution(execution);

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
    readonly modelSelection?: RunModelSelection;
    readonly executionLeaseExpiresAt?: string;
  }

  async function fixture(options: FixtureOptions = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-run-"));
    roots.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"));
    const databasePath = path.join(stateRoot, "data", "product.sqlite");
    await copyMigratedDatabase(databasePath);
    const database = openQualifiedDatabase(databasePath);
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
      ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
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
      keys: new InMemoryDevelopmentSecretSource({
        "completion-key@v1": new Uint8Array(32).fill(17),
      }),
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
      clock,
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

  it.each([
    "delivered",
    "cancelled",
    "input-rejected",
    "crash-after-output",
    "crash-before-transition",
    "checkpoint-race",
  ] as const)(
    "[R2-D21] recovers original answer delivery after the execution deadline: %s",
    async (outcome) => {
      const initialTime = clock.now();
      const setup = await executionFixture();
      try {
        const dispatch = setup.repository.runDispatch(
          ownerId,
          agentId,
          authority,
          lease,
          "thread-run-lifecycle",
        );
        const originalLease = await dispatch.assertHeld({
          runId: setup.runId,
          expectedLeaseRevision: 1,
          executionLeaseId: executionLease(setup.runId).executionLeaseId,
          at: clock.now(),
        });
        const policy = vi.fn(async () => ({
          modelRef: setup.input.runtime.modelRef,
          systemInstructionRef: setup.input.runtime.systemInstructionRef,
          policyVersion: setup.input.context.policyVersion,
          policies: setup.input.context.policies,
          capabilities: setup.input.context.capabilities,
          capabilityHandleRefs: [],
          memoryLimit: 10,
          maxSelectedMemories: 0,
        }));
        const inputService = new RunExecutionInputService({
          maximumRunDurationMs: 1000,
          source: setup.repository.runExecutionSource(ownerId, agentId),
          artifacts: setup.repository.runPayloadArtifactPort(ownerId, agentId, {
            product: authority,
            lease,
          }),
          payloads: setup.repository.payloadStore(ownerId, agentId),
          protector: setup.protector,
          clock,
          ids: createReferenceAdapterSet({ clock }).ids,
          dispatch,
          policy,
        });
        const source = await setup.repository
          .runExecutionSource(ownerId, agentId)
          .read(setup.runId);
        if (!source || source.threadId === null) throw new Error("missing canonical Thread source");
        const originalInput = await inputService.create({
          candidate: {
            ...source,
            action: "start",
            runRevision: 1,
            runStatus: "accepted",
            checkpointPhase: null,
            leaseRevision: 0,
          },
          lease: originalLease,
        });
        const stopRun = vi.fn(async () => ({ released: false }));
        let checkpointRaced = false;
        let firstCheckpointRead = true;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const coordinator = new RunCoordinator({
          clock,
          runs: {
            readRun: (id) => setup.runs.readRun(id),
            transitionRun: (value) => {
              if (
                outcome === "crash-before-transition" &&
                value.nextStatus === "reconciling_external_result"
              )
                throw new Error("fixture crash before Run transition");
              return setup.runs.transitionRun(value);
            },
            cancelRun: (value) => setup.runs.cancelRun(value),
            completeRun: async (value) => {
              if (outcome === "cancelled") {
                const latest = await setup.runs.readRun(setup.runId);
                if (!latest) throw new Error("missing Run before cancel");
                await setup.runs.cancelRun({
                  ...originalInput.commands.cancelled,
                  ownerId,
                  agentId,
                  runId: setup.runId,
                  authority: lease,
                  expectedRevision: latest.revision,
                });
              }
              if (outcome === "checkpoint-race" && !checkpointRaced) {
                checkpointRaced = true;
                const current = await setup.checkpoints.read(setup.runId);
                if (!current || !value.executionLease)
                  throw new Error("missing recovery checkpoint or lease");
                await setup.checkpoints.compareAndSet({
                  runId: setup.runId,
                  expectedRevision: current.revision,
                  checkpoint: current.checkpoint,
                  executionLease: value.executionLease,
                });
              }
              return setup.runs.completeRun(value);
            },
          },
          checkpoints: {
            read: async (id) => {
              if (firstCheckpointRead && outcome.startsWith("crash-")) {
                firstCheckpointRead = false;
                await delay(1100);
              }
              return setup.checkpoints.read(id);
            },
            compareAndSet: async (value) => {
              const saved = await setup.checkpoints.compareAndSet(value);
              if (
                outcome === "crash-after-output" &&
                value.checkpoint.phase === "runtime_settled" &&
                value.checkpoint.terminalStatus === "completed"
              )
                throw new Error("fixture crash after output checkpoint");
              return saved;
            },
          },
          context: setup.context,
          runtime: setup.runtime,
          trace: setup.trace,
          resources: { stopRun },
        });
        if (outcome.startsWith("crash-"))
          await expect(coordinator.execute(originalInput)).rejects.toThrow("fixture crash");
        else
          expect((await coordinator.execute(originalInput)).run.run.status).toBe(
            "reconciling_external_result",
          );
        vi.useRealTimers();
        expect(originalInput.executionDeadlineAt).toBe(
          new Date(Date.parse(initialTime) + 1000).toISOString(),
        );
        expect(Date.parse(clock.now())).toBeLessThan(
          Date.parse(originalInput.executionDeadlineAt ?? ""),
        );
        await dispatch.release({
          runId: setup.runId,
          expectedLeaseRevision: originalLease.revision,
          executionLeaseId: originalLease.executionLeaseId,
          releasedAt: clock.now(),
        });
        const before = await setup.repository
          .threadRepository()
          .listMessages(ownerId, agentId, source.threadId, 0, 20);
        expect(before.filter((message) => message.role === "agent")).toHaveLength(0);
        clock.set(new Date(Date.parse(initialTime) + 2000).toISOString());
        expect(Date.parse(clock.now())).toBeGreaterThan(
          Date.parse(originalInput.executionDeadlineAt ?? ""),
        );
        stopRun.mockResolvedValue({ released: true });
        expect(await dispatch.listClaimable({ now: clock.now(), limit: 10 })).toEqual([
          expect.objectContaining({ runId: setup.runId, action: "deliver_completed" }),
        ]);
        const dispatcher = new ProductionRunDispatcher({
          authority: {
            assertActive: async () => {
              await setup.repository.deploymentAuthorityPort().assertCurrent(authority);
            },
            isAccepting: () => true,
          },
          dispatch,
          coordinator,
          input: (value) => {
            if (outcome === "input-rejected") throw new Error("fixture recovery input unavailable");
            return inputService.create(value);
          },
          reconcile: createProductionRunReconciler({
            ownerId,
            agentId,
            runs: setup.runs,
            recovery: setup.repository.runReconciliation(
              ownerId,
              agentId,
              authority,
              lease,
              "thread-run-lifecycle",
            ),
            clock,
          }),
          clock,
          executionLeaseDurationMs: 60_000,
          maximumRunsPerPump: 1,
          instanceId: "result-delivery",
        });
        if (outcome === "input-rejected") {
          await expect(dispatcher.pump()).rejects.toThrow("fixture recovery input unavailable");
          expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
            diagnosticCode: "RUN_COMPLETION_DELIVERY_REJECTED",
            output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
          });
          expect(await dispatcher.pump()).toMatchObject({ claimed: 0 });
          expect(setup.attempts()).toBe(1);
          expect(policy).toHaveBeenCalledOnce();
          expect(
            (
              await setup.repository
                .threadRepository()
                .listMessages(ownerId, agentId, source.threadId, 0, 20)
            ).filter((message) => message.role === "agent"),
          ).toHaveLength(0);
          return;
        }
        expect(await dispatcher.pump()).toMatchObject({
          claimed: 1,
          settled: outcome !== "cancelled" && outcome !== "checkpoint-race" ? 1 : 0,
          conflicts: outcome !== "cancelled" && outcome !== "checkpoint-race" ? 0 : 1,
          unknown: 0,
        });
        if (outcome === "checkpoint-race")
          expect(await dispatcher.pump()).toMatchObject({ claimed: 1, settled: 1, conflicts: 0 });
        expect(await dispatcher.pump()).toMatchObject({ claimed: 0 });
        expect(setup.attempts()).toBe(1);
        expect(policy).toHaveBeenCalledOnce();
        const messages = await setup.repository
          .threadRepository()
          .listMessages(ownerId, agentId, source.threadId, 0, 20);
        expect(messages.filter((message) => message.role === "agent")).toEqual(
          outcome !== "cancelled"
            ? [expect.objectContaining({ contentRef: "payload-final-answer" })]
            : [],
        );
        expect((await setup.runs.readRun(setup.runId))?.run.status).toBe(
          outcome !== "cancelled" ? "completed" : "cancelled",
        );
        expect(stopRun).toHaveBeenCalledTimes(outcome === "crash-after-output" ? 0 : 1);
        expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
          phase: outcome !== "cancelled" ? "completed" : "cancelled",
          output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
        });
      } finally {
        vi.useRealTimers();
        clock.set(initialTime);
      }
    },
  );

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
      recoverCompleted: (value: typeof setup.input) => setup.coordinator.recoverCompleted(value),
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
      clock,
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
      clock,
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
      clock,
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
      clock,
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
      clock,
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

  function completionInput(
    setup: Awaited<ReturnType<typeof executionFixture>>,
  ): RunCompletionInput {
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
        clock,
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
        clock,
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
        clock,
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
    const currentThread = await setup.repository
      .threadRepository()
      .read(ownerId, agentId, setup.admitted.thread.id);
    if (!currentThread) throw new Error("Thread missing");
    await setup.commands.rename({
      ownerId,
      agentId,
      threadId: setup.admitted.thread.id,
      expectedRevision: currentThread.revision,
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
        clock,
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
      clock,
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
      clock,
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
    await expect(runs.transitionRun(input)).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
    });
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
    const currentThread = await repository
      .threadRepository()
      .read(ownerId, agentId, admitted.thread.id);
    if (!currentThread) throw new Error("Thread missing");
    const input = {
      ownerId,
      agentId,
      threadId: admitted.thread.id,
      expectedThreadRevision: currentThread.revision,
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
      clock,
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
      memoryLimit: 10,
      maxSelectedMemories: 5,
    }));
    const options = {
      maximumRunDurationMs: 60_000,
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
    const restored = await new RunExecutionInputService({
      ...options,
      policy: changedPolicy,
    }).create({ candidate, lease: held });
    expect(restored).toEqual(original);
    const laterClock = { now: () => new Date(Date.parse(clock.now()) + 1000).toISOString() };
    const larger = await new RunExecutionInputService({
      ...options,
      clock: laterClock,
      maximumRunDurationMs: 120_000,
    }).create({ candidate, lease: held });
    expect(larger.executionDeadlineAt).toBe(original.executionDeadlineAt);
    const tighter = await new RunExecutionInputService({
      ...options,
      maximumRunDurationMs: 30_000,
    }).create({ candidate, lease: held });
    expect(tighter.executionDeadlineAt).toBe(
      new Date(Date.parse(clock.now()) + 30_000).toISOString(),
    );
    const legacyProtector = {
      ...setup.protector,
      protect: setup.protector.protect.bind(setup.protector),
      rewrap: setup.protector.rewrap.bind(setup.protector),
      unprotect: async (input: Parameters<typeof setup.protector.unprotect>[0]) => {
        const current = JSON.parse(
          new TextDecoder().decode(await setup.protector.unprotect(input)),
        );
        delete current.deadlineAt;
        return new TextEncoder().encode(JSON.stringify(current));
      },
    };
    await expect(
      new RunExecutionInputService({ ...options, protector: legacyProtector }).create({
        candidate,
        lease: held,
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });

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

  it.each([
    { unknown: false, denied: false },
    { unknown: false, denied: true },
    { unknown: true, denied: false },
  ])(
    "executes persistent dispatch through the real Pi loop (unknown=$unknown, denied=$denied)",
    async ({ unknown, denied }) => {
      const { createFauxModelFixture } = await import(
        "../../packages/runtime-pi/test/faux-model-fixture.js"
      );
      const { createProductionRunComposition } = await import(
        "../../apps/agent-service/src/production-run-composition.js"
      );
      const setup = await executionFixture();
      const adapters = createReferenceAdapterSet({ clock });
      const model = await createFauxModelFixture(
        "这是 Pi 执行后持久保存的回答。",
        unknown || denied
          ? {
              name: "uncertain_tool",
              id: "real-pi-unknown-call",
              arguments: {},
            }
          : undefined,
      );
      let toolCalls = 0;
      const payloads = setup.repository.payloadStore(ownerId, agentId);
      for (const [ref, text] of [
        ["pi-prompt", "请回答本次请求。"],
        ["pi-system", "你是助手。"],
      ]) {
        if (!ref || !text) throw new Error("Invalid test content");
        await payloads.put(
          await setup.protector.protect({
            ownerId,
            agentId,
            ref,
            dataClassification: "private",
            contentType: "text/plain",
            plaintext: new TextEncoder().encode(text),
            createdAt: clock.now(),
          }),
        );
      }
      const thread = await setup.commands.create({
        ownerId,
        agentId,
        idempotencyKey: "pi-thread",
        resultRef: "pi-prompt",
      });
      const admitted = await setup.commands.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: thread.thread.id,
        expectedThreadRevision: thread.thread.revision,
        sessionId: createSessionId("pi-session"),
        idempotencyKey: "pi-message",
        contentRef: "pi-prompt",
        sourceProofRef: "owner:pi-test",
        dataClassification: "private",
        resultRef: "pi-prompt",
      });
      const failure = vi.fn();
      const titleFailure = vi.fn();
      let onTitleRequested = () => {};
      const titleRequested = new Promise<void>((resolve) => {
        onTitleRequested = resolve;
      });
      let allowTitleAdmission = () => {};
      const titleAdmissionGate = new Promise<void>((resolve) => {
        allowTitleAdmission = resolve;
      });
      let releaseTitle: (() => void) | undefined;
      const titleGate = new Promise<void>((resolve) => {
        releaseTitle = resolve;
      });
      let titleOperationKey: string | undefined;
      const generateTitle = vi.fn(
        async (request: RuntimeRequest, _prompt: string, gate: ModelInvocationAdmissionPort) => {
          onTitleRequested();
          await titleAdmissionGate;
          const admittedTitle = await gate.begin({
            modelRef: model.descriptor.ref,
            provider: model.descriptor.provider,
            model: model.descriptor.model,
            modelVersion: model.descriptor.version,
            dataClassification: request.dataClassification,
            logicalSlot: "thread-title:integration",
            source: "model-port",
            ordinal: 1,
            pricing: model.descriptor.pricing,
            estimatedCostMicros: model.descriptor.estimatedCostMicros,
          });
          if (admittedTitle.disposition !== "fresh") throw new Error("Title admission was denied");
          titleOperationKey = admittedTitle.identity.budgetOperationKey;
          await admittedTitle.permit.markStarted();
          await titleGate;
          await admittedTitle.permit.settle({
            inputTokens: 20,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
          return "自动生成的对话标题";
        },
      );
      let queuePrepared = false;
      const prepareQueuedSandboxExecutions = vi.fn(async () => {
        queuePrepared = true;
      });
      const compositionOptions: Parameters<typeof createProductionRunComposition>[0] = {
        egress: testModelEgress(),
        prepareQueuedSandboxExecutions,
        configuration: {
          ownerId,
          agentId,
          concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
          deadlines: { runMs: 60_000, workerRequestMs: 10_000, providerRequestMs: 10_000 },
        },
        repository: setup.repository,
        authority: {
          authorityFence: () => authority,
          authorityLease: () => lease,
          assertActive: async () => undefined,
          isAccepting: () => true,
        },
        models: model.models,
        modelRegistry: [model.descriptor],
        protector: setup.protector,
        memory: adapters.memory,
        tools: {
          listAuthorized: async () => {
            expect(queuePrepared).toBe(true);
            return unknown || denied
              ? [
                  {
                    name: "uncertain_tool",
                    capabilityRef: "test-tool",
                    capabilityHandleRef: "test-handle",
                    description: "test",
                    parameters: { type: "object", properties: {} },
                  },
                ]
              : [];
          },
          preflight: async () => {
            if (!unknown && !denied) throw new Error("No tools are authorized in this test");
            return { allowed: true, permissionDecisionRef: "test-policy", reasonCode: "test" };
          },
          execute: async () => {
            if (!unknown && !denied) throw new Error("No tools are authorized in this test");
            toolCalls += 1;
            return {
              outcome: denied ? ("failed" as const) : ("result_unknown" as const),
              resultRef: null,
              errorCode: denied ? "approval_denied" : null,
              externalActionId: denied ? null : "test-external-action",
              modelContent: denied ? "用户拒绝，未执行" : "结果未知",
            };
          },
        },
        workers: new ScriptedWorkerRunPort(),
        policy: async () => ({
          modelRef: model.descriptor.ref,
          systemInstructionRef: "pi-system",
          policyVersion: "pi-test-policy",
          policies: [],
          capabilities: [],
          capabilityHandleRefs: unknown || denied ? ["test-handle"] : [],
          memoryLimit: 5,
          maxSelectedMemories: 0,
        }),
        clock,
        ids: adapters.ids,
        instanceId: "pi-composition-test",
        cwd: setup.stateRoot,
        agentDir: path.join(setup.stateRoot, "pi-agent"),
        onFailure: failure,
        generateTitle,
        onTitleFailure: titleFailure,
      };
      await setup.repository.ownerPreferences().write({
        ownerId,
        agentId,
        name: "小安",
        locale: null,
        accent: null,
        theme: null,
        modelRef: null,
        thinkingLevel: null,
        expectedRevision: 0,
        now: clock.now(),
      });
      const composed = createProductionRunComposition(compositionOptions);
      let settledBeforeTitleAdmission = false;
      const pumping = composed.dispatcher.pump().then((result) => {
        settledBeforeTitleAdmission = true;
        return result;
      });
      let prematurelySettled = false;
      const pumped = await (async () => {
        try {
          await Promise.race([
            titleRequested,
            pumping.then(() => {
              throw new Error("Run settled without requesting its title");
            }),
          ]);
          expect(generateTitle).toHaveBeenCalledTimes(1);
          await new Promise<void>((resolve) => setImmediate(resolve));
          prematurelySettled = settledBeforeTitleAdmission;
          allowTitleAdmission();
          return await pumping;
        } finally {
          allowTitleAdmission();
          releaseTitle?.();
          await pumping;
          await composed.titles?.stop();
        }
      })();
      expect(prematurelySettled).toBe(false);
      expect(titleFailure).not.toHaveBeenCalled();
      expect(generateTitle).toHaveBeenCalledTimes(1);
      expect(
        await setup.repository.threadRepository().read(ownerId, agentId, thread.thread.id),
      ).toMatchObject({ titleSource: "automatic" });
      const runId = admitted.message.runId;
      if (!runId || !titleOperationKey) throw new Error("Missing title budget identity");
      const budgets = setup.repository.modelBudgetPort(ownerId, agentId, authority, lease);
      await expect(
        budgets.read({ parent: { kind: "thread-title", runId }, limit: 10 }),
      ).resolves.toMatchObject({
        account: { status: "active", reservedCostMicros: 0 },
        allocations: [{ operationKey: titleOperationKey, status: "settled" }],
      });
      const runBudget = await budgets.read({ parent: { kind: "run", runId }, limit: 100 });
      expect(runBudget?.allocations.map(({ operationKey }) => operationKey)).not.toContain(
        titleOperationKey,
      );
      expect(pumped).toMatchObject({
        claimed: 1,
        settled: unknown ? 0 : 1,
        unknown: unknown ? 1 : 0,
      });
      const messages = await setup.repository
        .threadRepository()
        .listMessages(ownerId, agentId, thread.thread.id, 0, 100);
      const answer = messages.find((message) => message.role === "agent");
      if (unknown) {
        expect(model.observed).toHaveLength(1);
        expect(toolCalls).toBe(1);
        expect(answer).toBeUndefined();
        if (!admitted.message.runId) throw new Error("Missing Run");
        await expect(setup.runs.readRun(admitted.message.runId)).resolves.toMatchObject({
          run: { status: "reconciling_external_result" },
        });
        await composed.dispatcher.pump();
        expect(model.observed).toHaveLength(1);
        expect(toolCalls).toBe(1);
      } else {
        expect(model.observed).toHaveLength(denied ? 2 : 1);
        expect(JSON.stringify(model.observed)).toContain("请回答本次请求。");
        const [first] = model.observed as { messages: readonly unknown[] }[];
        expect(JSON.stringify(first?.messages.at(-1))).toContain("称呼是「小安」");
        for (const observed of model.observed as {
          systemPrompt?: string;
          messages: readonly unknown[];
        }[]) {
          expect(JSON.stringify(observed.messages)).toContain("称呼是「小安」");
          expect(observed.systemPrompt ?? "").not.toContain("小安");
        }
        expect(answer?.runId).toBe(admitted.message.runId);
        const payload = await payloads.get(answer?.contentRef ?? "missing");
        if (!payload) throw new Error("Missing durable Pi answer");
        const reader = new BrowserTextPayloadReader({
          payloads: (requestedOwner, requestedAgent) =>
            setup.repository.payloadStore(
              createOwnerId(requestedOwner),
              createAgentId(requestedAgent),
            ),
          protector: setup.protector,
        });
        await expect(
          reader.read({
            authentication: {
              ownerId,
              subjectId: "owner:pi-test",
              deviceId: "device:pi-test",
              authenticatedAt: clock.now(),
              authenticationRef: "session:pi-test",
            },
            agentId,
            payloadRef: payload.ref,
          }),
        ).resolves.toMatchObject({
          content: "这是 Pi 执行后持久保存的回答。",
          contentType: "text/plain",
        });
        expect(
          new TextDecoder().decode(await setup.protector.unprotect({ ownerId, agentId, payload })),
        ).toBe("这是 Pi 执行后持久保存的回答。");
        await composed.loop.stop(1000);
        const nextModel = await createFauxModelFixture("这是新问题的回答。");
        const nextPrompt = "现在的天气怎么样？只处理本轮请求。";
        await payloads.put(
          await setup.protector.protect({
            ownerId,
            agentId,
            ref: "pi-next-prompt",
            dataClassification: "private",
            contentType: "text/plain",
            plaintext: new TextEncoder().encode(nextPrompt),
            createdAt: clock.now(),
          }),
        );
        const current = await setup.repository
          .threadRepository()
          .read(ownerId, agentId, thread.thread.id);
        if (!current) throw new Error("Missing thread");
        await setup.commands.admitOwnerMessage({
          ownerId,
          agentId,
          threadId: current.id,
          expectedThreadRevision: current.revision,
          sessionId: createSessionId("pi-session-next"),
          idempotencyKey: "pi-next-message",
          contentRef: "pi-next-prompt",
          sourceProofRef: "owner:pi-test",
          dataClassification: "private",
          resultRef: "pi-next-prompt",
        });
        const restarted = createProductionRunComposition({
          ...compositionOptions,
          models: nextModel.models,
          instanceId: "pi-composition-restarted",
        });
        expect(await restarted.dispatcher.pump()).toMatchObject({ claimed: 1, settled: 1 });
        expect(nextModel.observed).toHaveLength(1);
        const submitted = nextModel.observed[0] as {
          messages: { role: string; content: unknown }[];
        };
        expect(submitted.messages.map((message) => message.role)).toEqual(
          denied
            ? ["user", "assistant", "toolResult", "assistant", "user"]
            : ["user", "assistant", "user"],
        );
        if (denied) {
          expect(JSON.stringify(submitted.messages)).toContain("approval_denied");
          expect(toolCalls).toBe(1);
        }
        expect(JSON.stringify(submitted.messages.at(-2)?.content)).toContain(
          "这是 Pi 执行后持久保存的回答。",
        );
        const lastContent = submitted.messages.at(-1)?.content as { type: string; text: string }[];
        expect(lastContent).toHaveLength(1);
        expect(lastContent[0]?.type).toBe("text");
        expect(lastContent[0]?.text.startsWith("<himawari-context>\n")).toBe(true);
        expect(
          lastContent[0]?.text.endsWith(`<owner-message>\n${nextPrompt}\n</owner-message>`),
        ).toBe(true);
        const sentBefore = model.observed.at(-1) as {
          systemPrompt: string;
          messages: unknown[];
        };
        expect(JSON.stringify(sentBefore.messages.at(0))).toContain("<himawari-context>");
        expect((nextModel.observed[0] as { systemPrompt: string }).systemPrompt).toBe(
          sentBefore.systemPrompt,
        );
        expect(JSON.stringify(submitted.messages.slice(0, sentBefore.messages.length))).toBe(
          JSON.stringify(sentBefore.messages),
        );
        await restarted.loop.stop(1000);
        await restarted.titles?.stop();

        const database = openQualifiedDatabase(setup.databasePath);
        try {
          expect(
            database
              .prepare(
                "SELECT status FROM model_invocation_identities WHERE run_id = ? AND source = 'agent-stream'",
              )
              .all(admitted.message.runId),
          ).toEqual(
            denied ? [{ status: "settled" }, { status: "settled" }] : [{ status: "settled" }],
          );
          expect(
            database
              .prepare(
                "SELECT status FROM model_invocation_identities WHERE run_id = ? AND source = 'model-port'",
              )
              .all(admitted.message.runId),
          ).toEqual([{ status: "settled" }]);
        } finally {
          database.close();
        }
      }
      if (unknown) {
        const db = openQualifiedDatabase(setup.databasePath);
        try {
          expect(
            db
              .prepare("SELECT released_at FROM run_execution_leases WHERE run_id = ?")
              .get(admitted.message.runId),
          ).toMatchObject({ released_at: expect.any(String) });
        } finally {
          db.close();
        }
      }
      expect(failure).not.toHaveBeenCalled();
      await expect(composed.loop.stop(1000)).resolves.toMatchObject({ drained: true });
    },
    30_000,
  );

  it("publishes approval, resume and cancellation as durable Thread events without duplicate replay", async () => {
    const setup = await runningFixture();
    const waiting = transition(setup.runId, "awaiting_approval", 3, "await-hitl");
    await setup.runs.transitionRun(waiting);
    await setup.runs.transitionRun(waiting);
    await setup.runs.transitionRun(transition(setup.runId, "running", 4, "resume-hitl"));
    await setup.runs.transitionRun(transition(setup.runId, "cancelled", 5, "cancel-hitl"));
    const database = openQualifiedDatabase(setup.databasePath);
    try {
      const events = database
        .prepare(`SELECT event_type, thread_revision, payload_ref
      FROM thread_gateway_events WHERE thread_id = ? AND event_type IN
      ('run.awaiting_approval', 'run.running', 'run.cancelled') ORDER BY cursor_sequence`)
        .all(setup.admitted.thread.id);
      expect(events.map((event) => (event as { event_type: string }).event_type)).toEqual([
        "run.running",
        "run.awaiting_approval",
        "run.running",
        "run.cancelled",
      ]);
      expect(events).toEqual(events.map(() => expect.objectContaining({ payload_ref: null })));
      const thread = await setup.repository
        .threadRepository()
        .read(ownerId, agentId, setup.admitted.thread.id);
      expect(events.at(-1)).toMatchObject({ thread_revision: thread?.revision });
    } finally {
      database.close();
    }
  });

  it("persists selected model and depth at admission across repository reopen", async () => {
    const selection = { modelRef: "configured-model:v2", thinkingLevel: "high" as const };
    const setup = await fixture({ modelSelection: selection });
    expect(
      (await setup.repository.runExecutionSource(ownerId, agentId).read(setup.runId))
        ?.modelSelection,
    ).toEqual(selection);
    await setup.repository.close();
    repositories.splice(repositories.indexOf(setup.repository), 1);
    const reopened = await SqliteProductStateRepository.open({
      stateRoot: setup.stateRoot,
      databasePath: setup.databasePath,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    repositories.push(reopened);
    expect(
      (await reopened.runExecutionSource(ownerId, agentId).read(setup.runId))?.modelSelection,
    ).toEqual(selection);
  });

  it.each([
    {
      name: "file conflict before dispatch",
      outcome: "failed",
      code: "FILE_VERSION_CONFLICT",
      phase: "failed",
      marker: "not_dispatched",
    },
    {
      name: "failed product without Pi error",
      outcome: "failed",
      code: null,
      phase: "failed",
      marker: null,
    },
    {
      name: "strict mode refusal before dispatch",
      outcome: "failed",
      dispatchState: "not_sent",
      code: "SANDBOX_STRICT_MODE_UNAVAILABLE",
      phase: "failed",
      marker: "not_dispatched",
      reasonCode: "SANDBOX_STRICT_MODE_UNAVAILABLE",
    },
    {
      name: "structured pre-dispatch rejection with a new reason",
      outcome: "failed",
      dispatchState: "not_sent",
      code: "CODING_PATH_REQUIRED",
      phase: "failed",
      marker: "not_dispatched",
    },
    {
      name: "unknown result contradicts not sent evidence",
      outcome: "result_unknown",
      dispatchState: "not_sent",
      code: null,
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "accepted dispatch contradicts legacy not dispatched reason",
      outcome: "failed",
      dispatchState: "accepted",
      code: "WORKER_NOT_DISPATCHED",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "unknown dispatch evidence is not a successful effect",
      outcome: "succeeded",
      dispatchState: "future_state",
      code: null,
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "invalid dispatch evidence is not a successful effect",
      outcome: "succeeded",
      dispatchState: 42,
      code: null,
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "not sent evidence without an outcome is not successful",
      outcome: undefined,
      dispatchState: "not_sent",
      code: null,
      phase: "failed",
      marker: "not_dispatched",
    },
    {
      name: "success contradicts not sent evidence",
      outcome: "succeeded",
      dispatchState: "not_sent",
      code: null,
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "unknown product without Pi error",
      outcome: "result_unknown",
      code: null,
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "unknown result outranks admission code",
      outcome: "result_unknown",
      code: "WORKER_NOT_DISPATCHED",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "unknown result outranks file conflict",
      outcome: "result_unknown",
      code: "FILE_VERSION_CONFLICT",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "legacy unknown error code",
      outcome: undefined,
      code: "WORKER_RESULT_RECONCILIATION_REQUIRED",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "confirmed product success",
      outcome: "succeeded",
      code: null,
      phase: "completed",
      marker: null,
    },
    {
      name: "success contradicts admission code",
      outcome: "succeeded",
      code: "WORKER_NOT_DISPATCHED",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "success contradicts file conflict",
      outcome: "succeeded",
      code: "FILE_VERSION_CONFLICT",
      phase: "failed",
      marker: "unresolved",
    },
    {
      name: "legacy tool success",
      outcome: undefined,
      code: null,
      phase: "completed",
      marker: null,
    },
  ])("preserves product outcome evidence: $name", async (item) => {
    const { outcome, code, phase, marker } = item;
    const dispatchState = "dispatchState" in item ? item.dispatchState : undefined;
    const reasonCode = "reasonCode" in item ? item.reasonCode : undefined;
    const setup = await executionFixture();
    const payloadRef = "outcome-evidence";
    await setup.repository
      .runPayloadArtifactPort(ownerId, agentId, {
        product: authority,
        lease,
      })
      .commit({
        runId: setup.runId,
        purpose: "trace",
        operationKey: "outcome-evidence",
        payload: await setup.protector.protect({
          ownerId,
          agentId,
          ref: payloadRef,
          dataClassification: "private",
          contentType: "application/json",
          plaintext: new TextEncoder().encode(
            JSON.stringify({
              toolCallId: "outcome-call",
              toolName: "write",
              isError: false,
              result: {
                details: { productOutcome: outcome, errorCode: code, dispatchState },
                content: [{ type: "text", text: "Preserved result evidence" }],
              },
            }),
          ),
          createdAt: clock.now(),
        }),
      });
    await setup.trace.record({
      ownerId,
      agentId,
      sessionId: setup.input.runtime.sessionId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: "outcome-test",
      actorId: "outcome-test",
      dataClassification: "private",
      eventType: "runtime.tool_result",
      payload: { payloadRef },
    });
    const projection = new ThreadExecutionProjection({
      threads: setup.repository.threadRepository(),
      trace: setup.repository.traceStore(),
      payloads: (owner, agent) =>
        setup.repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
      protector: setup.protector,
    });
    const query = {
      ownerId,
      agentId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      afterSequence: 0,
      limit: 100,
    };
    const page = await projection.read(query);
    const tool = page.records.find((record) => record.kind === "tool");
    expect(tool).toMatchObject({ phase, output: "Preserved result evidence" });
    const states = page.records.filter((record) => record.name.startsWith("runtime.tool_outcome."));
    if (marker)
      expect(states).toEqual([
        expect.objectContaining({
          itemId: tool?.itemId,
          sequence: tool?.sequence,
          name: `runtime.tool_outcome.${marker}`,
        }),
      ]);
    else expect(states).toEqual([]);
    expect(page.records.some((record) => record.name.startsWith("runtime.tool_execution."))).toBe(
      false,
    );
    const state = await projection.readState({ ...query, canCancelRun: true });
    expect(state.operations).toEqual([
      expect.objectContaining({
        itemId: tool?.itemId,
        displayPhase: marker ?? phase,
        executionMilliseconds: null,
        ...(reasonCode ? { reasonCode } : {}),
      }),
    ]);
    expect(state.effectSummary).toEqual([
      {
        itemId: tool?.itemId,
        outcome:
          marker === "unresolved"
            ? "unknown"
            : marker === "not_dispatched"
              ? "not_dispatched"
              : phase === "completed"
                ? "succeeded"
                : "failed",
      },
    ]);
    expect(await projection.readState({ ...query, canCancelRun: true })).toEqual(state);
    const threads = setup.repository.threadRepository();
    const gateway = new ProductThreadGatewayAdapter({
      repository: threads,
      checkpoints: setup.repository.threadDistillationState(),
      commands: new ThreadCommandService({
        repository: threads,
        clock,
        authority: () => authority,
      }),
      queries: new ThreadQueryService(threads),
      forks: new ThreadForkService({ repository: threads, clock, authority: () => authority }),
      deletion: new ThreadDeletionCoordinationService({
        repository: threads,
        clock,
        authority: () => authority,
      }),
      clock,
      execution: projection,
    });
    const request = threadGatewayMessageSchema.parse({
      schemaVersion: "gateway.thread.v3",
      kind: "query",
      type: "thread.execution_state",
      messageId: "execution-state-query",
      correlationId: "execution-state-query",
      causationId: null,
      scope: { ownerId, agentId },
      authority,
      actor: { actorType: "owner", actorId: ownerId },
      payload: { threadId: query.threadId, runId: query.runId },
    });
    if (request.kind !== "query") throw new Error("EXPECTED_QUERY");
    const snapshot = await gateway.query({
      authentication: {
        subjectId: ownerId,
        ownerId,
        deviceId: "state-test-device",
        authenticatedAt: clock.now(),
        authenticationRef: "state-test-session",
      },
      query: request,
    });
    expect(snapshot).toMatchObject({
      type: "thread.execution_state_snapshot",
      payload: {
        threadId: query.threadId,
        runId: query.runId,
        state: await projection.readState({ ...query, canCancelRun: false }),
      },
    });

    await expect(
      projection.readState({ ...query, ownerId: "other-owner", canCancelRun: true }),
    ).rejects.toThrow("THREAD_EXECUTION_NOT_FOUND");
    expect(await projection.read(query)).toEqual(page);
  });

  it("shows the owner which memories the context formation brought to the model", async () => {
    const setup = await executionFixture();
    const payloads = setup.repository.payloadStore(ownerId, agentId);
    const storeText = async (
      ref: string,
      text: string,
      dataClassification: "private" | "sensitive",
    ) =>
      payloads.put(
        await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification,
          contentType: "text/plain",
          createdAt: clock.now(),
          plaintext: new TextEncoder().encode(text),
        }),
      );
    const memory = (
      id: string,
      status: ProductMemoryRecord["status"],
      dataClassification: ProductMemoryRecord["dataClassification"] = "private",
    ): ProductMemoryRecord => ({
      id: createMemoryId(id),
      ownerId,
      agentId,
      revision: 1,
      status,
      contentRef: `payload-${id}`,
      dataClassification,
      sourceThreadId: null,
      sourceRefs: [],
      inference: false,
      confidencePermille: 900,
      policyVersion: "memory-test",
      providerRecordId: null,
      lastUsedAt: null,
      updatedAt: clock.now(),
    });
    const stored = new Map(
      [
        memory("memory-color", "active"),
        memory("memory-city", "trashed"),
        memory("memory-tea", "active"),
        memory("memory-health", "active", "sensitive"),
      ].map((record) => [record.id as string, record]),
    );
    await storeText("payload-memory-color", "主人最喜欢的颜色是\n蓝色", "private");
    await storeText("payload-memory-city", "主人住在 PRIVATE_DELETED_CITY", "private");
    await storeText("payload-memory-tea", "主人喜欢喝乌龙茶", "private");
    await storeText("payload-memory-health", "PRIVATE_SENSITIVE_HEALTH", "sensitive");
    await storeText(
      "payload-owner-profile",
      "主人档案（由已确认的长期记忆整理）：\n- 主人最喜欢的颜色是 蓝色",
      "private",
    );
    let issued = 0;
    const context = new ContextFormationService({
      memory: {
        search: async () => [
          {
            id: "memory-tea",
            ownerId,
            agentId,
            contentRef: "payload-memory-tea",
            sourceRef: "trace-tea",
            searchTerms: ["tea"],
            dataClassification: "private",
            updatedAt: clock.now(),
            score: 0.9,
          },
        ],
      },
      trace: setup.trace,
      artifacts: setup.repository.runPayloadArtifactPort(ownerId, agentId, {
        product: authority,
        lease,
      }),
      payloads,
      protector: setup.protector,
      clock,
      ids: {
        next: (kind: string) => {
          issued += 1;
          return `memory-step-${kind}-${issued}`;
        },
      },
      threads: setup.repository.threadRepository(),
      profile: {
        compose: async () => {
          const memoryIds = ["memory-color", "memory-city", "memory-health"].map(createMemoryId);
          return {
            blocks: [
              {
                kind: "memory-snapshot" as const,
                ref: `memory-snapshot:${agentId}`,
                payloadRef: "payload-owner-profile",
                dataClassification: "private" as const,
                memoryIds,
              },
            ],
            memoryIds,
          };
        },
      },
    });
    await context.form({ ...setup.input.context, maxSelectedMemories: 2 });
    const reads: string[][] = [];
    const projection = new ThreadExecutionProjection({
      threads: setup.repository.threadRepository(),
      trace: setup.repository.traceStore(),
      payloads: (owner, agent) =>
        setup.repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
      protector: setup.protector,
      memories: {
        readMany: async (input) => {
          reads.push([...input.memoryIds]);
          return input.memoryIds.flatMap((id) => stored.get(id) ?? []);
        },
      },
    });
    const { records } = await projection.read({
      ownerId,
      agentId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      afterSequence: 0,
      limit: 100,
    });
    expect(records.find((record) => record.name === "memory.selection")).toMatchObject({
      kind: "status",
      phase: "completed",
      text: "1",
      output: "- 主人喜欢喝乌龙茶",
    });
    expect(records.find((record) => record.name === "context.formed")).toMatchObject({
      kind: "status",
      phase: "completed",
      text: "3",
      output: "- 主人最喜欢的颜色是 蓝色",
    });
    expect(reads).toEqual([["memory-tea"], ["memory-color", "memory-city", "memory-health"]]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("[UI-9] projects encrypted execution history with owner isolation and no raw reasoning or credentials", async () => {
    const setup = await executionFixture();
    const artifactPort = setup.repository.runPayloadArtifactPort(ownerId, agentId, {
      product: authority,
      lease,
    });
    const scope = {
      ownerId,
      agentId,
      sessionId: setup.input.runtime.sessionId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: "display-test",
      actorId: "display-test",
      dataClassification: "private" as const,
    };
    const capture = async (kind: string, value: unknown) => {
      const ref = `display:${kind}`;
      await artifactPort.commit({
        runId: setup.runId,
        purpose: "trace",
        operationKey: `runtime:${setup.runId}:${kind}:${ref}`,
        payload: await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification: "private",
          contentType: "application/json",
          plaintext: new TextEncoder().encode(JSON.stringify(value)),
          createdAt: clock.now(),
        }),
      });
      return ref;
    };
    const messageRef = await capture("message", {
      role: "assistant",
      timestamp: 1,
      model: "actual-model",
      content: [
        {
          type: "thinking",
          thinking: "PRIVATE_REASONING_MUST_NOT_LEAK",
          signature: "PRIVATE_SIGNATURE",
        },
        { type: "text", text: "Visible answer" },
      ],
      providerMetadata: "PRIVATE_PROVIDER_DATA",
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { role: "assistant", phase: "ended", payloadRef: messageRef },
    });
    const toolRef = await capture("tool_intent", {
      toolCallId: "provider|call",
      toolName: "read",
      arguments: { path: "README.md", authorization: "PRIVATE_CREDENTIAL" },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.tool_intent",
      payload: { capabilityRef: "project.read", payloadRef: toolRef },
    });
    const resultRef = await capture("tool_result", {
      toolCallId: "provider|call",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "Allowed file content" }],
        internal: "PRIVATE_INTERNAL_DATA",
      },
      isError: false,
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.tool_result",
      payload: { capabilityRef: "project.read", payloadRef: resultRef },
    });
    const projection = new ThreadExecutionProjection({
      threads: setup.repository.threadRepository(),
      trace: setup.repository.traceStore(),
      payloads: (owner, agent) =>
        setup.repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
      protector: setup.protector,
    });
    const query = {
      ownerId,
      agentId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      afterSequence: 0,
      limit: 100,
    };
    const displayed = await projection.read(query);
    expect(displayed.records).toHaveLength(5);
    expect(displayed.records[0]?.text).toBe("Visible answer");
    expect(displayed.records[1]).toMatchObject({
      name: "runtime.activity.text",
      text: "thinking_observed",
      phase: "updated",
    });
    expect(displayed.records[2]).toMatchObject({
      kind: "status",
      name: "runtime.tool_outcome.preparing",
    });
    expect(displayed.records[3]?.input).toContain("PRIVATE_CREDENTIAL");
    expect(displayed.records[3]?.itemId).toBe(displayed.records[4]?.itemId);
    expect(displayed.records[4]?.output).toBe("Allowed file content");
    const displayedText = JSON.stringify(displayed);
    for (const hidden of [
      "PRIVATE_REASONING_MUST_NOT_LEAK",
      "PRIVATE_SIGNATURE",
      "PRIVATE_PROVIDER_DATA",
      "PRIVATE_INTERNAL_DATA",
    ]) {
      expect(displayedText).not.toContain(hidden);
    }
    expect(await projection.read(query)).toEqual(displayed);
    await expect(projection.read({ ...query, ownerId: "other-owner" })).rejects.toThrow(
      "THREAD_EXECUTION_NOT_FOUND",
    );
    const after = await projection.read({
      ...query,
      afterSequence: displayed.records[0]?.sequence ?? 0,
    });
    expect(after.records).toHaveLength(3);
    const events = await setup.repository
      .threadRepository()
      .listGatewayEvents(ownerId, agentId, null, 100);
    expect(events.filter((event) => event.eventType === "thread.execution.updated")).toHaveLength(
      3,
    );
    const failedMessageRef = await capture("failed-message", {
      role: "assistant",
      timestamp: 2,
      model: "actual-model",
      content: [],
      stopReason: "error",
      errorMessage: "429: PRIVATE_PROVIDER_DATA",
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: {
        role: "assistant",
        phase: "ended",
        payloadRef: failedMessageRef,
      },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.failed",
      payload: {
        errorCode: "PI_MODEL_RATE_LIMITED",
        errorMessage: "PRIVATE_PROVIDER_DATA",
      },
    });
    const failed = await projection.read(query);
    expect(failed.records.at(-2)).toMatchObject({ kind: "message", phase: "failed", text: "" });
    expect(failed.records.at(-1)).toMatchObject({
      kind: "status",
      phase: "failed",
      text: "PI_MODEL_RATE_LIMITED",
    });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_PROVIDER_DATA");
    const callOnlyRef = await capture("call-only", {
      role: "assistant",
      timestamp: 3,
      model: "actual-model",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "new-call",
          name: "web_search",
          arguments: { query: "Tokyo", authorization: "PRIVATE_CREDENTIAL" },
        },
      ],
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { role: "assistant", phase: "ended", payloadRef: callOnlyRef },
    });
    const pendingCall = (await projection.read(query)).records.find(
      (item) => item.kind === "tool" && item.name === "web_search",
    );
    expect(pendingCall).toMatchObject({ phase: "updated" });
    expect(pendingCall?.input).toContain("Tokyo");
    expect(pendingCall?.input).toContain("PRIVATE_CREDENTIAL");
    const intentRef = await capture("new-call-intent", {
      toolCallId: "new-call",
      toolName: "web_search",
      arguments: { query: "Tokyo" },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.tool_intent",
      payload: { payloadRef: intentRef },
    });
    expect((await projection.read(query)).records.at(-1)?.itemId).toBe(pendingCall?.itemId);
    for (const eventType of [
      "memory.query",
      "memory.candidates",
      "memory.selection",
      "context.formed",
      "runtime.turn_started",
    ]) {
      await setup.trace.record({
        ...scope,
        eventType,
        payload: { privateContext: "PRIVATE_MEMORY_DATA" },
      });
      expect((await projection.read(query)).records.at(-1)).toMatchObject({
        name: eventType,
        kind: "status",
        phase: "updated",
        text: "",
      });
    }
    expect(JSON.stringify(await projection.read(query))).not.toContain("PRIVATE_MEMORY_DATA");
    const timedRef = await capture("timed-tool", {
      toolCallId: "timed-call",
      toolName: "read",
      isError: false,
      result: {
        content: [{ type: "text", text: "file contents" }],
        details: {
          executionTiming: {
            startedAt: "2026-09-14T00:00:01.000Z",
            endedAt: "2026-09-14T00:00:03.250Z",
          },
        },
      },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.tool_result",
      payload: { capabilityRef: "project.read", payloadRef: timedRef },
    });
    const timed = (await projection.read(query)).records;
    expect(timed.filter((item) => item.name.startsWith("runtime.tool_execution."))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime.tool_execution.started",
          occurredAt: "2026-09-14T00:00:01.000Z",
        }),
        expect.objectContaining({
          name: "runtime.tool_execution.ended",
          occurredAt: "2026-09-14T00:00:03.250Z",
        }),
      ]),
    );
    for (const [errorCode, state] of [
      ["WORKER_ADMISSION_CONFLICT", "not_dispatched"],
      ["WORKER_NOT_DISPATCHED", "not_dispatched"],
      ["RUNTIME_TOOL_CHECKPOINT_FAILED", "not_dispatched"],
      ["WORKER_RESULT_RECONCILIATION_REQUIRED", "unresolved"],
    ]) {
      const outcomeRef = await capture(`outcome-${errorCode}`, {
        toolCallId: `call-${errorCode}`,
        toolName: "write",
        isError: true,
        result: { details: { errorCode }, content: [] },
      });
      await setup.trace.record({
        ...scope,
        eventType: "runtime.tool_result",
        payload: { payloadRef: outcomeRef },
      });
      const projected = (await projection.read(query)).records;
      const resultItem = projected.at(-1);
      expect(resultItem).toMatchObject({ kind: "tool", phase: "failed" });
      expect(projected).toContainEqual(
        expect.objectContaining({
          itemId: resultItem?.itemId,
          sequence: resultItem?.sequence,
          kind: "status",
          name: `runtime.tool_outcome.${state}`,
          phase: "updated",
          text: "",
        }),
      );
    }
    const boundaryRef = await capture("thinking-boundary", {
      thinkingBoundary: { phase: "started", contentIndex: 0 },
      role: "assistant",
      content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT" }],
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { payloadRef: boundaryRef, role: "assistant", phase: "updated" },
    });
    expect((await projection.read(query)).records).toContainEqual(
      expect.objectContaining({ name: "runtime.thinking.started" }),
    );
    expect(JSON.stringify(await projection.read(query))).not.toContain("PRIVATE_THOUGHT");
    for (const [kind, name] of [
      ["text", "runtime.text.started"],
      ["toolCall", "runtime.tool_call.started"],
    ] as const) {
      const outputRef = await capture(`output-boundary-${kind}`, {
        outputBoundary: { kind, contentIndex: 1 },
        role: "assistant",
        timestamp: 789,
        content: [],
      });
      await setup.trace.record({
        ...scope,
        eventType: "runtime.message",
        payload: { payloadRef: outputRef, role: "assistant", phase: "updated" },
      });
      expect((await projection.read(query)).records).toContainEqual(
        expect.objectContaining({ kind: "status", phase: "updated", name }),
      );
    }
    const usageRef = await capture("usage-message", {
      role: "assistant",
      timestamp: 790,
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 800,
        cacheWrite: 0,
        reasoning: 120,
        totalTokens: 2340,
        cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00001, cacheWrite: 0, total: 0.00031 },
      },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { payloadRef: usageRef, role: "assistant", phase: "ended" },
    });
    expect((await projection.read(query)).records).toContainEqual(
      expect.objectContaining({
        kind: "status",
        name: "runtime.usage",
        text: JSON.stringify({
          input: 1200,
          output: 340,
          cacheRead: 800,
          cacheWrite: 0,
          reasoning: 120,
          costUsd: 0.00031,
        }),
      }),
    );
    const servedRef = await capture("served-model-message", {
      role: "assistant",
      timestamp: 791,
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
      servedModel: "opencode-go/glm-5.3-flash",
      usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0 } },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { payloadRef: servedRef, role: "assistant", phase: "ended" },
    });
    expect((await projection.read(query)).records).toContainEqual(
      expect.objectContaining({
        name: "runtime.usage",
        text: JSON.stringify({
          input: 5,
          output: 6,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          servedModel: "opencode-go/glm-5.3-flash",
          costUsd: 0,
        }),
      }),
    );
    const unresolvedRef = await capture("legacy-unresolved-tool", {
      toolCallId: "legacy-call",
      toolName: "write",
      isError: false,
      result: {
        content: [{ type: "text", text: "Result needs reconciliation" }],
        details: { errorCode: "RUNTIME_TOOL_EXECUTION_UNRESOLVED" },
      },
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.tool_result",
      payload: { capabilityRef: "project.write", payloadRef: unresolvedRef },
    });
    expect((await projection.read(query)).records.at(-1)).toMatchObject({
      kind: "tool",
      phase: "failed",
      output: "Result needs reconciliation",
    });
  });

  it("[ICON-2] puts the model's activity and icon on the tool step and keeps them out of its input", async () => {
    const setup = await executionFixture();
    const artifactPort = setup.repository.runPayloadArtifactPort(ownerId, agentId, {
      product: authority,
      lease,
    });
    const scope = {
      ownerId,
      agentId,
      sessionId: setup.input.runtime.sessionId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: "activity-test",
      actorId: "activity-test",
      dataClassification: "private" as const,
    };
    const capture = async (kind: string, value: unknown) => {
      const ref = `activity:${kind}`;
      await artifactPort.commit({
        runId: setup.runId,
        purpose: "trace",
        operationKey: `runtime:${setup.runId}:${kind}:${ref}`,
        payload: await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification: "private",
          contentType: "application/json",
          plaintext: new TextEncoder().encode(JSON.stringify(value)),
          createdAt: clock.now(),
        }),
      });
      return ref;
    };
    const calls = [
      {
        id: "call-weather",
        arguments: {
          query: "东京 明天 天气",
          activity: "  查东京\n明天的\u202e天气\u0007\u061c  ",
          activityIcon: "cloud",
        },
      },
      {
        id: "call-unknown-icon",
        arguments: {
          query: "rust",
          activity: "查资料",
          activityIcon: "rocket",
        },
      },
      {
        id: "call-plain",
        arguments: { query: "plain", activityIcon: "cloud" },
      },
    ];
    const messageRef = await capture("message", {
      role: "assistant",
      timestamp: 1,
      model: "actual-model",
      stopReason: "toolUse",
      content: calls.map((call) => ({
        type: "toolCall",
        name: "web_search",
        ...call,
      })),
    });
    await setup.trace.record({
      ...scope,
      eventType: "runtime.message",
      payload: { role: "assistant", phase: "ended", payloadRef: messageRef },
    });
    for (const call of calls) {
      const intentRef = await capture(`intent-${call.id}`, {
        toolCallId: call.id,
        toolName: "web_search",
        arguments: call.arguments,
      });
      await setup.trace.record({
        ...scope,
        eventType: "runtime.tool_intent",
        payload: { capabilityRef: "web.search", payloadRef: intentRef },
      });
    }
    const projection = new ThreadExecutionProjection({
      threads: setup.repository.threadRepository(),
      trace: setup.repository.traceStore(),
      payloads: (owner, agent) =>
        setup.repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
      protector: setup.protector,
    });
    const { records } = await projection.read({
      ownerId,
      agentId,
      threadId: setup.admitted.thread.id,
      runId: setup.runId,
      afterSequence: 0,
      limit: 100,
    });
    const tools = records.filter((record) => record.kind === "tool");
    expect(tools).toHaveLength(6);
    expect(tools.map(({ activity, activityIcon }) => [activity, activityIcon])).toEqual([
      ["查东京 明天的 天气", "cloud"],
      ["查资料", "puzzle"],
      ["搜索网页", "cloud"],
      ["查东京 明天的 天气", "cloud"],
      ["查资料", "puzzle"],
      ["搜索网页", "cloud"],
    ]);
    for (const tool of tools) {
      expect(tool.input).not.toContain("activity");
      expect(JSON.parse(tool.input)).toHaveProperty("query");
    }
    for (const record of records)
      expect(() => threadExecutionRecordSchema.parse(record)).not.toThrow();
  });

  it("persists a generated title and publishes its update without changing Run state", async () => {
    const setup = await executionFixture();
    const { ProductionThreadTitles } = await import(
      "../../apps/agent-service/src/production-thread-titles.js"
    );
    const payloads = setup.repository.payloadStore(ownerId, agentId);
    await payloads.put(
      await setup.protector.protect({
        ownerId,
        agentId,
        ref: "title-owner-text",
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode("请展示工具执行记录"),
        createdAt: clock.now(),
      }),
    );
    const created = await setup.commands.create({
      ownerId,
      agentId,
      idempotencyKey: "title-thread",
      resultRef: "title-owner-text",
    });
    const admitted = await setup.commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: created.thread.id,
      expectedThreadRevision: created.thread.revision,
      sessionId: createSessionId("title-session"),
      idempotencyKey: "title-message",
      contentRef: "title-owner-text",
      sourceProofRef: "owner:title-test",
      dataClassification: "private",
      resultRef: "title-owner-text",
    });
    const runId = admitted.message.runId;
    if (!runId) throw new Error("Expected admitted Run");
    const before = await setup.repository.runLifecycle(ownerId, agentId, authority).readRun(runId);
    const failures: unknown[] = [];
    const generate = vi.fn(async () => "执行记录展示");
    const titles = new ProductionThreadTitles({
      threads: setup.repository.threadRepository(),
      payloads,
      protector: setup.protector,
      clock,
      authority: () => authority,
      assertActive: async () => {},
      externalTag: async () => (kind, value) => `${kind}${value.length}`,
      generate,
      onFailure: (error) => {
        failures.push(error);
      },
    });
    titles.start({
      ...setup.input.runtime,
      runId,
      threadId: created.thread.id,
      executionLease: executionLease(runId),
      contextEnvelopeRef: "title-owner-text",
      workerResultRefs: [],
    });
    await titles.stop();
    expect(failures).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
    const saved = await setup.repository
      .threadRepository()
      .read(ownerId, agentId, created.thread.id);
    expect(saved?.titleSource).toBe("automatic");
    const value = await payloads.get(saved?.titleRef as string);
    if (!value) throw new Error("Expected persisted title payload");
    expect(
      new TextDecoder().decode(
        await setup.protector.unprotect({ ownerId, agentId, payload: value }),
      ),
    ).toBe("执行记录展示");
    const events = await setup.repository
      .threadRepository()
      .listGatewayEvents(ownerId, agentId, null, 100);
    expect(events.filter((event) => event.eventType === "thread.rename")).toHaveLength(1);
    expect(await setup.repository.runLifecycle(ownerId, agentId, authority).readRun(runId)).toEqual(
      before,
    );
  });

  async function unknownToolFixture() {
    const previousTime = clock.now();
    clock.set("2026-09-04T00:00:00.000Z");
    const setup = await executionFixture();
    const { createFauxModelFixture } = await import(
      "../../packages/runtime-pi/test/faux-model-fixture.ts"
    );
    const { createProductionRunComposition } = await import(
      "../../apps/agent-service/src/production-run-composition.ts"
    );
    const adapters = createReferenceAdapterSet({ clock });
    const calls = Array.from({ length: 6 }, (_, index) => [
      { name: "uncertain_tool", id: `d3-call-${index}`, arguments: {} },
    ]);
    const model = await createFauxModelFixture("不应发布的回答", calls[0], calls.slice(1));
    const payloads = setup.repository.payloadStore(ownerId, agentId);
    for (const ref of ["d3-prompt", "d3-system"]) {
      await payloads.put(
        await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: Buffer.from("请执行本轮工具。"),
          createdAt: clock.now(),
        }),
      );
    }
    let toolCalls = 0;
    const failure = vi.fn();
    const options: Parameters<typeof createProductionRunComposition>[0] = {
      egress: testModelEgress(),
      configuration: {
        ownerId,
        agentId,
        concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
        deadlines: { runMs: 60_000, workerRequestMs: 10_000, providerRequestMs: 10_000 },
      },
      repository: setup.repository,
      authority: {
        authorityFence: () => authority,
        authorityLease: () => lease,
        assertActive: async () => {
          await setup.repository.deploymentAuthorityPort().assertCurrent(authority);
        },
        isAccepting: () => true,
      },
      models: model.models,
      modelRegistry: [model.descriptor],
      protector: setup.protector,
      memory: adapters.memory,
      tools: {
        listAuthorized: async () => [
          {
            name: "uncertain_tool",
            capabilityRef: "test-tool",
            capabilityHandleRef: "test-handle",
            description: "test",
            parameters: { type: "object", properties: {} },
          },
        ],
        preflight: async () => ({
          allowed: true,
          permissionDecisionRef: "test-policy",
          reasonCode: "test",
        }),
        execute: async () => {
          toolCalls += 1;
          return {
            outcome: "result_unknown",
            resultRef: null,
            errorCode: null,
            externalActionId: "d3-external-action",
            modelContent: "不可交给模型的 UNKNOWN",
          };
        },
      },
      workers: new ScriptedWorkerRunPort(),
      policy: async () => ({
        modelRef: model.descriptor.ref,
        systemInstructionRef: "d3-system",
        policyVersion: "d3-policy",
        policies: [],
        capabilities: [],
        capabilityHandleRefs: ["test-handle"],
        memoryLimit: 5,
        maxSelectedMemories: 0,
      }),
      clock,
      ids: adapters.ids,
      instanceId: "d3-composition",
      cwd: setup.stateRoot,
      agentDir: path.join(setup.stateRoot, "d3-agent"),
      onFailure: failure,
    };
    const compositions: ReturnType<typeof createProductionRunComposition>[] = [];
    const compose = (runMs = 120_000) => {
      const composed = createProductionRunComposition({
        ...options,
        configuration: {
          ...options.configuration,
          deadlines: { ...options.configuration.deadlines, runMs },
        },
        instanceId: `d3-composition-${compositions.length}`,
      });
      compositions.push(composed);
      return composed;
    };
    const artifacts = setup.repository.runPayloadArtifactPort(ownerId, agentId, {
      product: authority,
      lease,
    });
    const projection = new ThreadExecutionProjection({
      threads: setup.repository.threadRepository(),
      checkpoints: setup.checkpoints,
      trace: setup.repository.traceStore(),
      payloads: () => payloads,
      protector: setup.protector,
      resources: {
        readInventory: ({ runId }) =>
          setup.repository
            .sandboxExecutionPreparations(ownerId, agentId)
            .readRunInventory({ runId }),
        now: () => clock.now(),
        digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      },
    });
    const targets: {
      runId: RunId;
      threadId: ThreadId;
      deadlineAt: string;
      inputRef: string;
      inputDigest: string;
    }[] = [];
    const decode = async (ref: string) => {
      const payload = await payloads.get(ref);
      if (!payload) throw new Error("D3_PROTECTED_PAYLOAD_MISSING");
      return JSON.parse(
        Buffer.from(await setup.protector.unprotect({ ownerId, agentId, payload })).toString(),
      );
    };
    const addUnknown = async (runMs = 60_000) => {
      const index = targets.length;
      const created = await setup.commands.create({
        ownerId,
        agentId,
        idempotencyKey: `d3-thread-${index}`,
        resultRef: "d3-prompt",
      });
      const admitted = await setup.commands.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedThreadRevision: created.thread.revision,
        sessionId: createSessionId(`d3-session-${index}`),
        idempotencyKey: `d3-message-${index}`,
        contentRef: "d3-prompt",
        sourceProofRef: "owner:d3",
        dataClassification: "private",
        resultRef: "d3-prompt",
      });
      const runId = admitted.message.runId;
      if (!runId) throw new Error("D3_RUN_MISSING");
      const composed = compose(runMs);
      expect(await composed.dispatcher.pump()).toMatchObject({
        claimed: 1,
        unknown: 1,
        settled: 0,
      });
      await composed.loop.stop(1000);
      expect(await setup.runs.readRun(runId)).toMatchObject({
        run: { status: "reconciling_external_result" },
      });
      expect(await setup.checkpoints.read(runId)).toMatchObject({
        checkpoint: {
          phase: "reconciling_external_result",
          diagnosticCode: "RUNTIME_TOOL_RESULT_UNKNOWN",
          output: null,
          terminalStatus: null,
        },
      });
      const trace = await setup.repository.traceStore().readRun(runId, 0, 1000);
      const intent = trace.find((event) => event.eventType === "runtime.tool_intent");
      const unknown = trace.find((event) => event.eventType === "runtime.result_unknown");
      if (!intent?.payloadRef || !unknown)
        throw new Error("D3_PROTECTED_INTENT_OR_UNKNOWN_MISSING");
      expect(intent.sequence).toBeLessThan(unknown.sequence);
      const envelope = await decode(intent.payloadRef);
      expect(await decode(envelope.payloadRef)).toMatchObject({
        toolCallId: `d3-call-${index}`,
        toolName: "uncertain_tool",
      });
      const artifact = await artifacts.lookup({
        runId,
        purpose: "context",
        operationKey: "run-execution-input:v1",
      });
      if (!artifact) throw new Error("D3_FROZEN_INPUT_MISSING");
      const frozen = await decode(artifact.payloadRef);
      expect(frozen).toMatchObject({
        version: "run-execution-input.v2",
        deadlineAt: new Date(Date.parse(frozen.startedAt) + runMs).toISOString(),
      });
      const target = {
        runId,
        threadId: created.thread.id,
        deadlineAt: frozen.deadlineAt as string,
        inputRef: artifact.payloadRef,
        inputDigest: artifact.contentDigest,
      };
      targets.push(target);
      return target;
    };
    const readState = (target: (typeof targets)[number]) =>
      projection.readState({
        ownerId,
        agentId,
        threadId: target.threadId,
        runId: target.runId,
        canCancelRun: true,
      });
    const readback = (target: (typeof targets)[number]) => {
      const db = openQualifiedDatabase(setup.databasePath);
      try {
        return {
          run: db.prepare("SELECT status,revision FROM runs WHERE id=?").get(target.runId),
          checkpoint: db
            .prepare(
              "SELECT phase,terminal_status,output_kind,diagnostic_code,revision FROM run_coordination_checkpoints WHERE run_id=?",
            )
            .get(target.runId),
          lease: db.prepare("SELECT * FROM run_execution_leases WHERE run_id=?").get(target.runId),
          sandboxRecords: db
            .prepare("SELECT COUNT(*) AS count FROM sandbox_execution_records WHERE run_id=?")
            .get(target.runId),
          failedEvents: db
            .prepare(
              "SELECT * FROM reliable_events WHERE topic='run.failed' AND payload_ref=? ORDER BY id",
            )
            .all(target.inputRef),
          gatewayEvents: db
            .prepare(
              "SELECT * FROM thread_gateway_events WHERE thread_id=? ORDER BY cursor_sequence",
            )
            .all(target.threadId),
          commands: db
            .prepare("SELECT * FROM command_results WHERE state_key=? ORDER BY id")
            .all(target.runId),
        };
      } finally {
        db.close();
      }
    };
    await mkdir(path.join(process.cwd(), ".ci-output/r2-d3"), { recursive: true });
    const evidenceRoot = await mkdtemp(path.join(process.cwd(), `.ci-output/r2-d3/${execution}-`));
    const capture = async (name: string, target: (typeof targets)[number]) => {
      await writeFile(
        path.join(evidenceRoot, `${name}.json`),
        JSON.stringify(
          {
            target,
            at: clock.now(),
            stored: readback(target),
            state: await readState(target),
            toolCalls,
            observedModelRequests: model.observed,
          },
          null,
          2,
        ),
      );
    };
    return {
      ...setup,
      model,
      failure,
      compose,
      addUnknown,
      readState,
      readback,
      capture,
      decode,
      artifacts,
      counts: () => ({ toolCalls, modelCalls: model.observed.length }),
      dispose: async () => {
        try {
          for (const composed of compositions) await composed.loop.stop(1000);
        } finally {
          clock.set(previousTime);
        }
      },
    };
  }

  it("[R2-D3] settles a protected Pi UNKNOWN with nothing to recover before its frozen deadline through public recovery and real projection", async () => {
    const f = await unknownToolFixture();
    try {
      const target = await f.addUnknown();
      expect(f.readback(target).sandboxRecords).toEqual({ count: 0 });
      clock.set(new Date(Date.parse(target.deadlineAt) - 1).toISOString());
      const dispatcher = f.compose().dispatcher;
      const recovery = dispatcher.recover();
      expect(dispatcher.recover()).toBe(recovery);
      await recovery;
      await f.capture("before-deadline", target);
      expect.soft(await f.runs.readRun(target.runId)).toMatchObject({ run: { status: "failed" } });
      expect.soft(await f.checkpoints.read(target.runId)).toMatchObject({
        checkpoint: {
          phase: "failed",
          terminalStatus: "failed",
          output: null,
          diagnosticCode: "RUNTIME_TOOL_RESULT_UNKNOWN",
        },
      });
      expect.soft(await f.readState(target)).toMatchObject({
        displayPhase: "failed",
        reasonCode: "RUNTIME_TOOL_RESULT_UNKNOWN",
        availableActions: [],
        operations: [{ displayPhase: "unresolved", reasonCode: "TOOL_RESULT_UNCONFIRMED" }],
        effectSummary: [{ outcome: "unknown" }],
      });
      const settled = f.readback(target);
      clock.set(target.deadlineAt);
      await f.compose().dispatcher.recover();
      await f.compose().dispatcher.recover();
      await f.capture("at-deadline", target);
      expect.soft(f.readback(target)).toEqual(settled);
      expect.soft(settled.failedEvents).toHaveLength(1);
      expect
        .soft(
          settled.gatewayEvents.filter(
            (event) => (event as { event_type: string }).event_type === "run.failed",
          ),
        )
        .toHaveLength(1);
      expect(f.counts()).toEqual({ toolCalls: 1, modelCalls: 1 });
      expect(JSON.stringify(f.model.observed)).not.toContain("不可交给模型的 UNKNOWN");
      expect(
        await f.artifacts.lookup({
          runId: target.runId,
          purpose: "context",
          operationKey: "run-execution-input:v1",
        }),
      ).toMatchObject({ payloadRef: target.inputRef, contentDigest: target.inputDigest });
      expect(
        (
          await f.repository
            .threadRepository()
            .listMessages(ownerId, agentId, target.threadId, 0, 100)
        ).filter((message) => message.role === "agent"),
      ).toEqual([]);
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });

  it("[R2-D3] settles an expired snapshot whose stored source is unchanged and refuses a changed one", async () => {
    const f = await unknownToolFixture();
    try {
      const { createProductionRunExpiry } = await import(
        "../../apps/agent-service/src/production-run-expiry.ts"
      );
      const target = await f.addUnknown();
      const stored = await f.runs.readRun(target.runId);
      if (!stored) throw new Error("D3_RUN_MISSING");
      const { revision: leaseRevision } = f.readback(target).lease as { revision: number };
      const candidate = {
        ownerId,
        agentId,
        runId: target.runId,
        sessionId: stored.run.sessionId,
        triggerId: stored.run.triggerId,
        threadId: target.threadId,
        runRevision: stored.revision,
        runStatus: stored.run.status,
        checkpointPhase: "reconciling_external_result" as const,
        leaseRevision,
        action: "reconcile" as const,
      };
      const liveSource = (change: (source: RunExecutionSource) => RunExecutionSource) =>
        new Proxy(f.repository, {
          get(repository, key) {
            if (key === "runExecutionSource")
              return (...scope: Parameters<SqliteProductStateRepository["runExecutionSource"]>) => {
                const port = repository.runExecutionSource(...scope);
                return {
                  read: async (runId: RunId) => {
                    const source = await port.read(runId);
                    return source ? change(source) : source;
                  },
                };
              };
            const value = Reflect.get(repository, key);
            return typeof value === "function" ? value.bind(repository) : value;
          },
        });
      const expiry = (repository: SqliteProductStateRepository) =>
        createProductionRunExpiry({
          repository,
          protector: f.protector,
          clock,
          ids: createReferenceAdapterSet({ clock }).ids,
          scope: [ownerId, agentId, authority, lease, "d3-expiry"],
          executionLeaseDurationMs: 30_000,
        });
      clock.set(target.deadlineAt);
      await expect(
        expiry(liveSource((source) => ({ ...source, sourceId: `${source.sourceId}-changed` })))(
          candidate,
        ),
      ).rejects.toThrow("RUN_EXPIRY_INPUT_INVALID");
      await expect(expiry(liveSource((source) => source))(candidate)).resolves.toBe(true);
      expect(await f.runs.readRun(target.runId)).toMatchObject({ run: { status: "failed" } });
    } finally {
      await f.dispose();
    }
  });

  it("[R2-D3] settles every UNKNOWN with nothing to recover across bounded rounds while scanning", async () => {
    const f = await unknownToolFixture();
    try {
      const first = await f.addUnknown();
      clock.advance(1000);
      const second = await f.addUnknown();
      clock.advance(1000);
      const third = await f.addUnknown(20_000);
      clock.advance(28_000);
      const recovery = f.compose().dispatcher;
      await recovery.recover(2);
      expect(await f.runs.readRun(first.runId)).toMatchObject({ run: { status: "failed" } });
      expect(await f.runs.readRun(second.runId)).toMatchObject({ run: { status: "failed" } });
      const added = await f.addUnknown();
      await recovery.recover(2);
      await f.capture("third-settled", third);
      expect.soft(await f.runs.readRun(third.runId)).toMatchObject({ run: { status: "failed" } });
      await recovery.recover(2);
      expect(await f.runs.readRun(added.runId)).toMatchObject({ run: { status: "failed" } });
      expect(f.counts()).toEqual({ toolCalls: 4, modelCalls: 4 });
    } finally {
      await f.dispose();
    }
  });
  it.each([
    "live-lease",
    "revoked-authority",
    "run-revision",
    "checkpoint-revision",
    "lease-revision",
    "input-ref",
    "input-digest",
    "source",
    "not-unknown",
    "output",
    "terminal",
  ] as const)(
    "[R2-D3] rejects unsafe public recovery without replaying the UNKNOWN tool: %s",
    async (scenario) => {
      const f = await unknownToolFixture();
      let restore = () => {};
      try {
        const target = await f.addUnknown();
        clock.set(target.deadlineAt);
        const mutate = (sql: string) => {
          const db = openQualifiedDatabase(f.databasePath);
          try {
            db.prepare(sql).run(target.runId);
          } finally {
            db.close();
          }
        };
        const before = f.readback(target);
        if (scenario === "live-lease")
          mutate(
            "UPDATE run_execution_leases SET released_at=NULL,expires_at='2026-09-04T00:02:00.000Z' WHERE run_id=?",
          );
        if (scenario === "revoked-authority") {
          const db = openQualifiedDatabase(f.databasePath);
          try {
            db.prepare("UPDATE authority_leases SET fencing_token=2").run();
          } finally {
            db.close();
          }
        }
        if (scenario === "not-unknown")
          mutate(
            "UPDATE run_coordination_checkpoints SET diagnostic_code='OTHER_UNKNOWN' WHERE run_id=?",
          );
        if (scenario === "output")
          mutate("UPDATE run_coordination_checkpoints SET output_kind='no-answer' WHERE run_id=?");
        if (scenario === "terminal")
          mutate("UPDATE run_coordination_checkpoints SET terminal_status='failed' WHERE run_id=?");
        if (scenario === "input-ref")
          mutate(
            "UPDATE run_payload_artifacts SET payload_ref='d3-system' WHERE run_id=? AND operation_key='run-execution-input:v1'",
          );
        if (scenario === "input-digest")
          mutate(
            "UPDATE run_payload_artifacts SET content_digest='sha256:changed' WHERE run_id=? AND operation_key='run-execution-input:v1'",
          );
        if (scenario === "source")
          mutate(
            "UPDATE triggers SET payload_ref='d3-system' WHERE id=(SELECT trigger_id FROM runs WHERE id=?)",
          );
        if (["run-revision", "checkpoint-revision", "lease-revision"].includes(scenario)) {
          const unprotect = f.protector.unprotect.bind(f.protector);
          let changed = false;
          const spy = vi.spyOn(f.protector, "unprotect").mockImplementation(async (input) => {
            if (input.payload.ref === target.inputRef && !changed) {
              changed = true;
              const sql =
                scenario === "run-revision"
                  ? "UPDATE runs SET revision=revision+1 WHERE id=?"
                  : scenario === "checkpoint-revision"
                    ? "UPDATE run_coordination_checkpoints SET revision=revision+1 WHERE run_id=?"
                    : "UPDATE run_execution_leases SET revision=revision+1 WHERE run_id=?";
              mutate(sql);
            }
            return unprotect(input);
          });
          restore = () => spy.mockRestore();
        }
        const recovery = f.compose().dispatcher.recover();
        if (
          [
            "revoked-authority",
            "run-revision",
            "checkpoint-revision",
            "lease-revision",
            "input-ref",
            "input-digest",
            "source",
          ].includes(scenario)
        )
          await expect(recovery).rejects.toThrow();
        else await recovery;
        restore();
        expect(await f.runs.readRun(target.runId)).toMatchObject({
          run: { status: "reconciling_external_result" },
        });
        const after = f.readback(target);
        expect(after.failedEvents).toEqual(before.failedEvents);
        expect(after.gatewayEvents).toEqual(before.gatewayEvents);
        expect(after.commands).toEqual(before.commands);
        expect(f.counts()).toEqual({ toolCalls: 1, modelCalls: 1 });
        await f.capture(`guard-${scenario}`, target);
      } finally {
        restore();
        await f.dispose();
      }
    },
  );

  describe("background commands after the answer [BG-1]", () => {
    async function parkedFixture() {
      const setup = await executionFixture({
        executionLeaseExpiresAt: "2026-09-04T00:00:01.000Z",
      });
      await setup.runs.transitionRun(transition(setup.runId, "building_context", 1));
      await setup.runs.transitionRun(transition(setup.runId, "running", 2));
      const holds = [
        {
          taskRef: "background-command:aaaaaaaaaaaaaaaaaaaaaaaa",
          startedAt: clock.now(),
          deadlineAt: "2026-09-04T00:30:00.000Z",
        },
      ];
      await setup.runs.completeRun({ ...completionInput(setup), background: { holds } });
      const noticeContent = "background-notice-payload";
      await setup.repository.payloadStore(ownerId, agentId).put(
        await setup.protector.protect({
          ownerId,
          agentId,
          ref: noticeContent,
          dataClassification: "private",
          contentType: "text/plain",
          createdAt: clock.now(),
          plaintext: new TextEncoder().encode("后台命令 npm test 已结束"),
        }),
      );
      return { ...setup, holds, noticeContent };
    }

    function finishInput(
      setup: Awaited<ReturnType<typeof parkedFixture>>,
      options: { readonly withLease?: boolean } = {},
    ) {
      return {
        ownerId,
        agentId,
        runId: setup.runId,
        idempotencyKey: createIdempotencyKey(`background-finish:${setup.runId}`),
        authority: lease,
        ...(options.withLease === false ? {} : { executionLease: executionLease(setup.runId) }),
        outcomes: [{ taskRef: setup.holds[0]?.taskRef ?? "", outcome: "completed" as const }],
        notice: {
          triggerId: `trigger:background:${setup.runId}`,
          runId: createRunId(`run:background:${setup.runId}`),
          turnId: `turn:background:${setup.runId}`,
          messageId: `message:background:${setup.runId}`,
          contentRef: setup.noticeContent,
          dataClassification: "private" as const,
        },
      };
    }

    it("commits the answer, keeps the Run running and lets the next message start", async () => {
      const setup = await parkedFixture();
      expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("running");
      const database = openQualifiedDatabase(setup.databasePath);
      try {
        expect(
          database
            .prepare("SELECT role FROM thread_messages WHERE run_id = ? ORDER BY sequence")
            .pluck()
            .all(setup.runId),
        ).toEqual(["owner", "agent"]);
        expect(
          database
            .prepare("SELECT committed_at FROM turns WHERE run_id = ?")
            .pluck()
            .get(setup.runId),
        ).toBe(clock.now());
      } finally {
        database.close();
      }
      const thread = await setup.repository
        .threadRepository()
        .read(ownerId, agentId, setup.admitted.thread.id);
      if (!thread) throw new Error("thread missing");
      const next = await setup.commands.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: thread.id,
        expectedThreadRevision: thread.revision,
        sessionId: createSessionId("session-run-lifecycle"),
        idempotencyKey: "thread-submit-second",
        contentRef: "payload-run-lifecycle",
        sourceProofRef: "proof:owner",
        dataClassification: "private",
        resultRef: "payload-run-lifecycle",
      });
      const dispatch = setup.repository.runDispatch(
        ownerId,
        agentId,
        authority,
        lease,
        "thread-run-lifecycle",
      );
      const afterLeaseExpiry = "2026-09-04T00:00:02.000Z";
      const claimable = await dispatch.listClaimable({ now: afterLeaseExpiry, limit: 10 });
      expect(claimable.map((candidate) => candidate.runId)).toEqual([next.message.runId]);
      expect(
        (await dispatch.listReconciliationRequired({ now: afterLeaseExpiry, limit: 10 })).map(
          (candidate) => candidate.runId,
        ),
      ).not.toContain(setup.runId);
      expect(await setup.runs.listBackgroundRuns?.()).toEqual([
        {
          runId: setup.runId,
          threadId: setup.admitted.thread.id,
          holds: setup.holds,
          runStatus: "running",
          leaseLive: true,
          resourcesReleased: true,
        },
      ]);
    });

    it("finishes the Run and starts a system notice Run that can complete", async () => {
      const setup = await parkedFixture();
      const finished = await setup.runs.finishBackgroundRun?.(finishInput(setup));
      expect(finished).toEqual({
        finished: true,
        noticeRunId: `run:background:${setup.runId}`,
      });
      expect(await setup.runs.finishBackgroundRun?.(finishInput(setup))).toEqual({
        finished: false,
        noticeRunId: `run:background:${setup.runId}`,
      });
      expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("completed");
      expect(await setup.runs.listBackgroundRuns?.()).toEqual([]);
      const noticeRunId = createRunId(`run:background:${setup.runId}`);
      const notice = await setup.runs.readRun(noticeRunId);
      expect(notice?.run).toMatchObject({ status: "accepted", threadId: setup.admitted.thread.id });
      const source = await setup.repository.runExecutionSource(ownerId, agentId).read(noticeRunId);
      expect(source).toMatchObject({
        sourceType: "external_event",
        payloadRef: setup.noticeContent,
      });
      const database = openQualifiedDatabase(setup.databasePath);
      try {
        expect(
          database
            .prepare("SELECT role FROM thread_messages WHERE thread_id = ? ORDER BY sequence")
            .pluck()
            .all(setup.admitted.thread.id),
        ).toEqual(["owner", "agent", "system"]);
        expect(
          database
            .prepare("SELECT outcome, notice_run_id FROM run_background_holds WHERE run_id = ?")
            .get(setup.runId),
        ).toEqual({ outcome: "completed", notice_run_id: noticeRunId });
        expect(
          database
            .prepare("SELECT released_at IS NOT NULL FROM run_execution_leases WHERE run_id = ?")
            .pluck()
            .get(setup.runId),
        ).toBe(1);
      } finally {
        database.close();
      }
      const dispatch = setup.repository.runDispatch(
        ownerId,
        agentId,
        authority,
        lease,
        "thread-run-lifecycle",
      );
      expect(
        (await dispatch.listClaimable({ now: clock.now(), limit: 10 })).map(
          (candidate) => candidate.runId,
        ),
      ).toEqual([noticeRunId]);
      await dispatch.claim({
        runId: noticeRunId,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId(`execution-${noticeRunId}`),
        claimedAt: clock.now(),
        expiresAt: "2026-09-05T00:00:00.000Z",
      });
      await setup.runs.transitionRun(
        transition(noticeRunId, "building_context", 1, "notice-build"),
      );
      await setup.runs.transitionRun(transition(noticeRunId, "running", 2, "notice-running"));
      await setup.runs.completeRun({
        ownerId,
        agentId,
        runId: noticeRunId,
        expectedRevision: 3,
        idempotencyKey: createIdempotencyKey("notice-complete"),
        commandFingerprint: "notice-complete",
        authority: lease,
        payloadRef: "payload-run-lifecycle",
        executionLease: executionLease(noticeRunId),
        dataClassification: "private",
        output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      });
      expect((await setup.runs.readRun(noticeRunId))?.run.status).toBe("completed");
    });

    it("refuses to finish while the sandbox resources are still held or the lease is live", async () => {
      const setup = await parkedFixture();
      await expect(
        setup.runs.finishBackgroundRun?.(finishInput(setup, { withLease: false })),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        setup.runs.finishBackgroundRun?.({
          ...finishInput(setup),
          outcomes: [{ taskRef: "background-command:other", outcome: "completed" }],
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("running");
    });

    it("releases the commands without a notice when the owner cancelled the Run", async () => {
      const setup = await parkedFixture();
      const stored = await setup.runs.readRun(setup.runId);
      if (!stored) throw new Error("run missing");
      await setup.runs.cancelRun({
        ownerId,
        agentId,
        runId: setup.runId,
        expectedRevision: stored.revision,
        idempotencyKey: createIdempotencyKey("owner-cancel-background"),
        commandFingerprint: "owner-cancel-background",
        authority: lease,
        payloadRef: "payload-run-lifecycle",
      });
      expect(await setup.runs.finishBackgroundRun?.(finishInput(setup))).toEqual({
        finished: false,
        noticeRunId: null,
      });
      expect(await setup.runs.listBackgroundRuns?.()).toEqual([]);
    });
  });

  describe("coordinator hands background commands over after the answer [BG-2]", () => {
    function coordinatorWith(
      setup: Awaited<ReturnType<typeof executionFixture>>,
      held: readonly { taskRef: string; startedAt: string; deadlineAt: string }[],
    ) {
      const stop = vi.fn(async () => undefined);
      const coordinator = new RunCoordinator({
        clock,
        runs: setup.runs,
        checkpoints: setup.checkpoints,
        context: setup.context,
        runtime: setup.runtime,
        workers: new ScriptedWorkerRunPort(),
        trace: setup.trace,
        background: { held: () => held, stop },
      });
      return { coordinator, stop };
    }

    it("parks a Run whose answer left a command running", async () => {
      const setup = await executionFixture();
      const { coordinator, stop } = coordinatorWith(setup, [
        {
          taskRef: "background-command:bbbbbbbbbbbbbbbbbbbbbbbb",
          startedAt: clock.now(),
          deadlineAt: "2026-09-04T00:30:00.000Z",
        },
      ]);
      const result = await coordinator.execute(setup.input);
      expect(result.parked).toBe(true);
      expect(result.run.run.status).toBe("running");
      expect(stop).not.toHaveBeenCalled();
      expect(await setup.runs.listBackgroundRuns?.()).toEqual([
        expect.objectContaining({ runId: setup.runId, runStatus: "running" }),
      ]);
    });

    it("stops leftover commands and completes normally when nothing is held", async () => {
      const setup = await executionFixture();
      const { coordinator, stop } = coordinatorWith(setup, []);
      const result = await coordinator.execute(setup.input);
      expect(result.parked).toBeUndefined();
      expect(result.run.run.status).toBe("completed");
      expect(stop).toHaveBeenCalledWith(setup.runId);
    });
  });

  it("[ADR-0285] marks the conversation when an outside event starts a run that only answers, so the next run in it reads the mark", async () => {
    const { createFauxModelFixture } = await import(
      "../../packages/runtime-pi/test/faux-model-fixture.js"
    );
    const { createProductionRunComposition } = await import(
      "../../apps/agent-service/src/production-run-composition.js"
    );
    const { ContextExternalContent } = await import(
      "../../apps/agent-service/src/context-external-content.js"
    );
    const setup = await executionFixture();
    const adapters = createReferenceAdapterSet({ clock });
    const model = await createFauxModelFixture(
      "收到邮件了，没有要做的事。",
      undefined,
      [],
      ["好的。"],
    );
    const payloads = setup.repository.payloadStore(ownerId, agentId);
    for (const [ref, text] of [
      ["mark-event", "新邮件：周五的会改到下午三点。"],
      ["mark-owner", "好的"],
      ["mark-system", "你是助手。"],
    ] as const)
      await payloads.put(
        await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
    const thread = await setup.commands.create({
      ownerId,
      agentId,
      idempotencyKey: "mark-thread",
      resultRef: "mark-event",
    });
    const event = await setup.commands.admitOwnerMessage({
      triggerSource: "external_event",
      ownerId,
      agentId,
      threadId: thread.thread.id,
      expectedThreadRevision: thread.thread.revision,
      sessionId: createSessionId("mark-session"),
      idempotencyKey: "mark-message-1",
      contentRef: "mark-event",
      sourceProofRef: "think:mark-test",
      dataClassification: "private",
      resultRef: "mark-event",
    });
    const externalContent = new ContextExternalContent({
      configuration: { ownerId, agentId },
      state: setup.repository,
      source: setup.repository.runExecutionSource(ownerId, agentId),
      authority: () => lease,
      clock,
    });
    const failure = vi.fn();
    const composed = createProductionRunComposition({
      egress: testModelEgress(),
      externalContent,
      configuration: {
        ownerId,
        agentId,
        concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
        deadlines: { runMs: 60_000, workerRequestMs: 10_000, providerRequestMs: 10_000 },
      },
      repository: setup.repository,
      authority: {
        authorityFence: () => authority,
        authorityLease: () => lease,
        assertActive: async () => undefined,
        isAccepting: () => true,
      },
      models: model.models,
      modelRegistry: [model.descriptor],
      protector: setup.protector,
      memory: adapters.memory,
      tools: {
        listAuthorized: async () => [],
        preflight: async () => ({
          allowed: true,
          permissionDecisionRef: "test-policy",
          reasonCode: "test",
        }),
        execute: async () => {
          throw new Error("no tool expected");
        },
      },
      workers: new ScriptedWorkerRunPort(),
      policy: async () => ({
        modelRef: model.descriptor.ref,
        systemInstructionRef: "mark-system",
        policyVersion: "mark-test-policy",
        policies: [],
        capabilities: [],
        capabilityHandleRefs: [],
        memoryLimit: 5,
        maxSelectedMemories: 0,
      }),
      clock,
      ids: adapters.ids,
      instanceId: "mark-composition-test",
      cwd: setup.stateRoot,
      agentDir: path.join(setup.stateRoot, "pi-agent"),
      onFailure: failure,
    });
    const eventRunId = event.message.runId;
    if (!eventRunId) throw new Error("missing event run");
    expect(await externalContent.readThread(thread.thread.id)).toEqual([]);
    await composed.dispatcher.pump();
    expect((await setup.runs.readRun(eventRunId))?.run.status).toBe("completed");
    const eventSource = await setup.repository
      .runExecutionSource(ownerId, agentId)
      .read(eventRunId);
    const origin = `external_event:${eventSource?.sourceId}`;
    expect((await externalContent.readThread(thread.thread.id)).map((s) => s.origin)).toEqual([
      origin,
    ]);

    const current = await setup.repository
      .threadRepository()
      .read(ownerId, agentId, thread.thread.id);
    if (!current) throw new Error("thread missing");
    const owner = await setup.commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: thread.thread.id,
      expectedThreadRevision: current.revision,
      sessionId: createSessionId("mark-session"),
      idempotencyKey: "mark-message-2",
      contentRef: "mark-owner",
      sourceProofRef: "owner:mark-test",
      dataClassification: "private",
      resultRef: "mark-owner",
    });
    const ownerRunId = owner.message.runId;
    if (!ownerRunId) throw new Error("missing owner run");
    await composed.dispatcher.pump();
    expect((await setup.runs.readRun(ownerRunId))?.run.status).toBe("completed");
    expect((await externalContent.read(ownerRunId)).map((s) => s.origin)).toEqual([origin]);
    expect(failure).not.toHaveBeenCalled();
  });

  it("[BG-3] answers, takes the next message while a command runs, then reports it in a new turn", async () => {
    const { createFauxModelFixture } = await import(
      "../../packages/runtime-pi/test/faux-model-fixture.js"
    );
    const { createProductionRunComposition } = await import(
      "../../apps/agent-service/src/production-run-composition.js"
    );
    const { ProductionBackgroundCommands } = await import(
      "../../apps/agent-service/src/production-background-commands.js"
    );
    const setup = await executionFixture();
    const adapters = createReferenceAdapterSet({ clock });
    const model = await createFauxModelFixture(
      "测试已经在后台跑了，跑完我会告诉你。",
      { name: "run_command", id: "long-tests", arguments: { command: "npm test" } },
      [],
      ["明天东京白天多云。", "测试跑完了：42 个全部通过。"],
    );
    const payloads = setup.repository.payloadStore(ownerId, agentId);
    for (const [ref, text] of [
      ["bg-prompt-1", "帮我跑一下全部测试"],
      ["bg-prompt-2", "明天东京下雨吗？"],
      ["bg-system", "你是助手。"],
    ] as const)
      await payloads.put(
        await setup.protector.protect({
          ownerId,
          agentId,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
    const thread = await setup.commands.create({
      ownerId,
      agentId,
      idempotencyKey: "bg-thread",
      resultRef: "bg-prompt-1",
    });
    const first = await setup.commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: thread.thread.id,
      expectedThreadRevision: thread.thread.revision,
      sessionId: createSessionId("bg-session"),
      idempotencyKey: "bg-message-1",
      contentRef: "bg-prompt-1",
      sourceProofRef: "owner:bg-test",
      dataClassification: "private",
      resultRef: "bg-prompt-1",
    });
    const labels: string[] = [];
    const background = new ProductionBackgroundCommands({
      limits: { waitMs: 20, maximumMs: 60_000 },
      now: () => clock.now(),
    });
    let finishCommand: (text: string) => void = () => undefined;
    const command = new Promise<string>((resolve) => {
      finishCommand = resolve;
    });
    const stopRun = vi.fn(async () => ({ released: true }));
    const failure = vi.fn();
    const backgroundFailure = vi.fn();
    const composed = createProductionRunComposition({
      egress: testModelEgress(),
      configuration: {
        ownerId,
        agentId,
        concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
        deadlines: { runMs: 60_000, workerRequestMs: 10_000, providerRequestMs: 10_000 },
      },
      repository: setup.repository,
      authority: {
        authorityFence: () => authority,
        authorityLease: () => lease,
        assertActive: async () => undefined,
        isAccepting: () => true,
      },
      models: model.models,
      modelRegistry: [model.descriptor],
      protector: setup.protector,
      memory: adapters.memory,
      tools: {
        listAuthorized: async () => [
          {
            name: "run_command",
            capabilityRef: "project.coding.bash",
            capabilityHandleRef: "bash-handle",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        preflight: async () => ({
          allowed: true,
          permissionDecisionRef: "test-policy",
          reasonCode: "test",
        }),
        execute: (invocation, options) =>
          background.run(
            invocation,
            options?.signal,
            async () => ({
              outcome: "succeeded" as const,
              resultRef: null,
              errorCode: null,
              externalActionId: null,
              modelContent: await command,
            }),
            async () => ({ ref: "bg-receipt" }),
            async (text) => {
              labels.push(text);
              return { ref: "bg-command-label" };
            },
          ),
        subscribeBackground: (runId, listener) => background.subscribe(runId, listener),
      },
      backgroundCommands: background,
      resources: { stopRun },
      workers: new ScriptedWorkerRunPort(),
      policy: async () => ({
        modelRef: model.descriptor.ref,
        systemInstructionRef: "bg-system",
        policyVersion: "bg-test-policy",
        policies: [],
        capabilities: [],
        capabilityHandleRefs: ["bash-handle"],
        memoryLimit: 5,
        maxSelectedMemories: 0,
      }),
      clock,
      ids: adapters.ids,
      instanceId: "bg-composition-test",
      cwd: setup.stateRoot,
      agentDir: path.join(setup.stateRoot, "pi-agent"),
      onFailure: failure,
      onBackgroundFailure: backgroundFailure,
    });
    const firstRunId = first.message.runId;
    if (!firstRunId) throw new Error("missing first run");
    await composed.dispatcher.pump();
    expect((await setup.runs.readRun(firstRunId))?.run.status).toBe("running");
    expect(composed.background?.holding(firstRunId)).toBe(true);

    const current = await setup.repository
      .threadRepository()
      .read(ownerId, agentId, thread.thread.id);
    if (!current) throw new Error("thread missing");
    const second = await setup.commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: thread.thread.id,
      expectedThreadRevision: current.revision,
      sessionId: createSessionId("bg-session"),
      idempotencyKey: "bg-message-2",
      contentRef: "bg-prompt-2",
      sourceProofRef: "owner:bg-test",
      dataClassification: "private",
      resultRef: "bg-prompt-2",
    });
    const secondRunId = second.message.runId;
    if (!secondRunId) throw new Error("missing second run");
    await composed.dispatcher.pump();
    expect((await setup.runs.readRun(secondRunId))?.run.status).toBe("completed");
    expect((await setup.runs.readRun(firstRunId))?.run.status).toBe("running");
    const parkedSummary = (
      await setup.repository.threadRepository().listRuns(ownerId, agentId, thread.thread.id)
    ).find((run) => run.runId === firstRunId);
    expect(parkedSummary?.background).toMatchObject({ count: 1 });
    expect(parkedSummary?.backgroundCommands).toEqual([
      expect.objectContaining({
        commandRef: "bg-command-label",
        outputRef: null,
        endedAt: null,
        outcome: null,
        noticeRunId: null,
      }),
    ]);
    expect(labels).toHaveLength(1);

    finishCommand("Tests 42 passed");
    await composed.background?.drain();
    expect(backgroundFailure).not.toHaveBeenCalled();
    expect(stopRun).toHaveBeenCalledWith(firstRunId, "run_finished");
    expect((await setup.runs.readRun(firstRunId))?.run.status).toBe("completed");
    await composed.dispatcher.pump();
    expect(failure).not.toHaveBeenCalled();

    const messages = await setup.repository
      .threadRepository()
      .listMessages(ownerId, agentId, thread.thread.id, 0, 20);
    expect(messages.map((message) => message.role)).toEqual([
      "owner",
      "agent",
      "owner",
      "agent",
      "system",
      "agent",
    ]);
    const noticeRunId = messages[4]?.runId;
    if (!noticeRunId) throw new Error("missing notice run");
    expect((await setup.runs.readRun(noticeRunId))?.run.status).toBe("completed");
    const lastContext = JSON.stringify(model.observed.at(-1));
    expect(lastContext).toContain("Tests 42 passed");
    expect(lastContext).toContain("系统通知");
    expect(lastContext).toContain("明天东京下雨吗");
    expect(await setup.runs.listBackgroundRuns?.()).toEqual([]);
    expect(
      (await setup.repository.threadRepository().listRuns(ownerId, agentId, thread.thread.id)).map(
        (run) => run.background,
      ),
    ).toEqual([null, null, null]);
    const finished = (
      await setup.repository.threadRepository().listRuns(ownerId, agentId, thread.thread.id)
    ).find((run) => run.runId === firstRunId)?.backgroundCommands;
    expect(finished).toEqual([
      expect.objectContaining({
        commandRef: "bg-command-label",
        outcome: "completed",
        noticeRunId,
        outputRef: expect.stringMatching(/^background-output:/),
      }),
    ]);
    const outputRef = finished?.[0]?.outputRef;
    if (!outputRef) throw new Error("missing output ref");
    expect(await setup.repository.payloadStore(ownerId, agentId).get(outputRef)).toMatchObject({
      contentType: "text/plain",
    });
  });
  describe("folding owner messages queued behind a Run", () => {
    async function foldFixture() {
      const setup = await fixture();
      const protector = new EnvelopePayloadProtector({
        keys: new InMemoryDevelopmentSecretSource({
          "fold-key@v1": new Uint8Array(32).fill(23),
        }),
        activeKey: { keyRef: "fold-key", kekVersion: "v1", dekVersion: "v1" },
      });
      const payloads = setup.repository.payloadStore(ownerId, agentId);
      const put = async (ref: string, text: string, classification = "private" as const) =>
        payloads.put(
          await protector.protect({
            ownerId,
            agentId,
            ref,
            dataClassification: classification,
            contentType: "text/plain",
            createdAt: clock.now(),
            plaintext: new TextEncoder().encode(text),
          }),
        );
      const created = await setup.commands.create({
        ownerId,
        agentId,
        idempotencyKey: "fold-thread",
        resultRef: "payload-run-lifecycle",
      });
      let revision = created.thread.revision;
      const send = async (
        name: string,
        text: string,
        extra: Partial<Parameters<typeof setup.commands.admitOwnerMessage>[0]> = {},
      ) => {
        await put(`fold-${name}`, text);
        const admitted = await setup.commands.admitOwnerMessage({
          ownerId,
          agentId,
          threadId: created.thread.id,
          expectedThreadRevision: revision,
          sessionId: createSessionId(`session-fold-${name}`),
          idempotencyKey: `fold-${name}`,
          contentRef: `fold-${name}`,
          sourceProofRef: `proof:${name}`,
          dataClassification: "private",
          resultRef: "payload-run-lifecycle",
          ...extra,
        });
        revision = admitted.thread.revision;
        return admitted;
      };
      const inputFor = async (runId: RunId, folds: { foldLimit?: () => Promise<number> } = {}) => {
        const dispatch = setup.repository.runDispatch(
          ownerId,
          agentId,
          authority,
          lease,
          "thread-run-lifecycle",
        );
        const claimed = await dispatch.claim({
          runId,
          expectedRunRevision: 1,
          expectedLeaseRevision: 0,
          executionLeaseId: createRunExecutionLeaseId(`execution-${runId}`),
          claimedAt: clock.now(),
          expiresAt: "2026-09-05T00:00:00.000Z",
        });
        const source = await setup.repository.runExecutionSource(ownerId, agentId).read(runId);
        if (!source) throw new Error("missing source");
        const options = {
          maximumRunDurationMs: 60_000,
          source: setup.repository.runExecutionSource(ownerId, agentId),
          artifacts: setup.repository.runPayloadArtifactPort(ownerId, agentId, {
            product: authority,
            lease,
          }),
          payloads,
          protector,
          clock,
          ids: createReferenceAdapterSet({ clock }).ids,
          dispatch,
          policy: async () => ({
            modelRef: "primary-fold",
            systemInstructionRef: "payload-run-lifecycle",
            policyVersion: "production-policy-v1",
            policies: [],
            capabilities: [],
            capabilityHandleRefs: [],
            memoryLimit: 10,
            maxSelectedMemories: 0,
          }),
          folds: setup.repository.threadRepository(),
          ...folds,
        };
        const candidate = {
          ...source,
          runRevision: 1,
          runStatus: "accepted" as const,
          checkpointPhase: null,
          leaseRevision: 0,
          action: "start" as const,
        };
        const held = await dispatch.assertHeld({
          runId,
          expectedLeaseRevision: claimed.revision,
          executionLeaseId: createRunExecutionLeaseId(`execution-${runId}`),
          at: clock.now(),
        });
        return {
          source,
          create: () => new RunExecutionInputService(options).create({ candidate, lease: held }),
          read: async (ref: string) => {
            const payload = await payloads.get(ref as never);
            if (!payload) return undefined;
            return new TextDecoder().decode(
              await protector.unprotect({ ownerId, agentId, payload }),
            );
          },
        };
      };
      const status = async (runId: RunId | undefined | null) =>
        runId
          ? (await setup.repository.runLifecycle(ownerId, agentId, authority).readRun(runId))?.run
              .status
          : undefined;
      return { setup, send, inputFor, status, threadId: created.thread.id };
    }

    it("answers messages sent while the first was waiting in one Run and completes the others", async () => {
      const { send, inputFor, status, setup } = await foldFixture();
      const first = await send("a", "查东京天气");
      const second = await send("b", "查今天科技新闻");
      const third = await send("c", "查附近评分高的拉面店");
      const firstRun = first.message.runId as RunId;
      const run = await inputFor(firstRun);
      const input = await run.create();
      const ref = input.context.trigger.payloadRef;
      expect(ref).toBe(`fold-prompt:${firstRun}`);
      const text = await run.read(ref);
      expect(text).toContain(`<owner-message id="${first.message.id}">\n查东京天气`);
      expect(text).toContain(`<owner-message id="${second.message.id}">\n查今天科技新闻`);
      expect(text).toContain(`<owner-message id="${third.message.id}">\n查附近评分高的拉面店`);
      expect(text?.indexOf("查东京天气")).toBeLessThan(text?.indexOf("查附近评分高的拉面店") ?? 0);
      expect(input.context.memoryQueryRef).toBe(ref);
      expect(await status(firstRun)).toBe("accepted");
      expect(await status(second.message.runId)).toBe("completed");
      expect(await status(third.message.runId)).toBe("completed");
      const snapshot = await setup.repository.threadRepository().readContextSnapshot?.({
        ownerId,
        agentId,
        threadId: first.thread.id,
        runId: firstRun,
        afterSequence: 0,
        limit: 100,
      });
      expect(snapshot?.messages.map(({ id }) => id) ?? []).toEqual([]);
      const replay = await run.create();
      expect(replay).toEqual(input);
      expect(
        (
          await setup.repository
            .threadRepository()
            .readFoldedOwnerMessages({ ownerId, agentId, runId: firstRun })
        ).map(({ messageId, runId }) => [messageId, runId]),
      ).toEqual([
        [second.message.id, second.message.runId],
        [third.message.id, third.message.runId],
      ]);
    });

    it("does not fold a message when it is the only one waiting", async () => {
      const { send, inputFor } = await foldFixture();
      const only = await send("solo", "你好");
      const run = await inputFor(only.message.runId as RunId);
      const input = await run.create();
      expect(input.context.trigger.payloadRef).toBe(run.source.payloadRef);
    });

    it("stops at the per-run limit and leaves the rest queued for their own Run", async () => {
      const { send, inputFor, status } = await foldFixture();
      const first = await send("a", "一");
      const second = await send("b", "二");
      const third = await send("c", "三");
      const run = await inputFor(first.message.runId as RunId, { foldLimit: async () => 1 });
      const input = await run.create();
      const text = await run.read(input.context.trigger.payloadRef);
      expect(text).toContain("二");
      expect(text).not.toContain("三");
      expect(await status(second.message.runId)).toBe("completed");
      expect(await status(third.message.runId)).toBe("accepted");
    });

    it("never folds a message that chose a different model, or anything behind an event", async () => {
      const { send, inputFor, status } = await foldFixture();
      const first = await send("a", "一");
      const other = await send("b", "二", {
        modelSelection: { modelRef: "other-model", thinkingLevel: "low" },
      });
      const run = await inputFor(first.message.runId as RunId);
      const input = await run.create();
      expect(input.context.trigger.payloadRef).toBe(run.source.payloadRef);
      expect(await status(other.message.runId)).toBe("accepted");
    });

    it("does not fold an owner message into a Run that an outside event started", async () => {
      const { send, inputFor, status } = await foldFixture();
      const event = await send("event", "新邮件", {
        triggerSource: "external_event",
        internal: true,
      });
      const mine = await send("mine", "帮我设个明早 7 点的闹钟");
      const run = await inputFor(event.message.runId as RunId);
      const input = await run.create();
      expect(input.context.trigger.payloadRef).toBe(run.source.payloadRef);
      expect(await status(mine.message.runId)).toBe("accepted");
    });

    it("never folds past an outside event that was queued between two owner messages", async () => {
      const { send, inputFor, status } = await foldFixture();
      const first = await send("a", "一");
      const event = await send("event", "新邮件", {
        triggerSource: "external_event",
        internal: true,
      });
      const later = await send("c", "三");
      const run = await inputFor(first.message.runId as RunId);
      const input = await run.create();
      expect(input.context.trigger.payloadRef).toBe(run.source.payloadRef);
      expect(await status(event.message.runId)).toBe("accepted");
      expect(await status(later.message.runId)).toBe("accepted");
    });
  });
});
