import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableBackgroundWorkService,
  UnifiedTriggerIngestionService,
  type BackgroundAdmissionLimits,
  type BackgroundOccurrenceSettlement,
  type TriggerAdmissionPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createIdempotencyKey,
  createJobId,
  createOccurrenceId,
  createOwnerId,
  createRunId,
  createSessionId,
  type BackgroundOccurrence,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-background");
const AGENT_ID = createAgentId("agent-background");
const DEPLOYMENT_ID = createDeploymentId("deployment-background");
const RUN_ID = createRunId("run-background");
const SESSION_ID = createSessionId("session-background");
const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:00:01.000Z";
const T2 = "2026-08-27T00:00:02.000Z";
const T3 = "2026-08-27T00:00:03.000Z";
const FAR_FUTURE = "2999-12-31T23:59:59.999Z";
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};

const LIMITS: BackgroundAdmissionLimits = {
  globalCostMicros: 10_000,
  perRunCostMicros: 1_000,
  perClassificationCostMicros: {
    public: 10_000,
    private: 10_000,
    sensitive: 5_000,
    restricted: 1_000,
  },
  totalRuns: 4,
  foregroundReserved: 1,
  perCategory: { monitor: 3, foreground: 2 },
};

async function seed(databasePath: string): Promise<void> {
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at,
        content_type
      ) VALUES ('payload-background', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:background', 'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, created_at, updated_at
      ) VALUES ('thread-background', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-background', ?, ?, 'thread-background', 'seed-trigger',
        'user_message', 'seed', 'payload-background', 'seed-proof', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'thread-background', ?, 'trigger-background', 1,
        'awaiting_approval', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, SESSION_ID, T0, T0);
  database.close();
}

async function setup(now = T0) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-background-"));
  const databasePath = path.join(stateRoot, "product.sqlite");
  await seed(databasePath);
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => now,
  });
  return { stateRoot, databasePath, repository };
}

async function addJob(repository: SqliteProductStateRepository, id: string, category = "monitor") {
  await repository.scheduler().upsert(
    {
      id,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: null,
      payloadRef: "payload-background",
      sourceProofRef: `proof:${id}`,
      dataClassification: "private",
      authorizationRef: `authorization:${id}`,
      taskScopeRef: `scope:${id}`,
      capabilityRef: `capability:${category}`,
      operation: "run",
      resourceRef: `resource:${id}`,
      sideEffect: "none",
      estimatedCostMicros: 100,
      intervalMs: 60_000,
      minimumIntervalMs: 60_000,
      expiresAt: FAR_FUTURE,
      revokedAt: null,
      nextRunAt: T1,
      occurrence: 0,
      status: "active",
    },
    null,
  );
}

function occurrence(input: {
  id: string;
  jobId: string;
  stableKey?: string;
  foreground?: boolean;
  parallelSafe?: boolean;
  estimatedCostMicros?: number;
  category?: string;
}): BackgroundOccurrence {
  return {
    id: createOccurrenceId(input.id),
    jobId: createJobId(input.jobId),
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    stableKey: input.stableKey ?? `${input.jobId}:${input.id}`,
    status: "queued",
    authority: AUTHORITY,
    category: input.category ?? "monitor",
    dataClassification: "private",
    foreground: input.foreground ?? false,
    parallelSafe: input.parallelSafe ?? false,
    estimatedCostMicros: input.estimatedCostMicros ?? 100,
    reservedCostMicros: 0,
    spentCostMicros: 0,
    attemptCount: 0,
    nextRetryAt: null,
    deadlineAt: FAR_FUTURE,
    runId: null,
    workLease: null,
    lastErrorCode: null,
  };
}

function dispatchInput(value: BackgroundOccurrence, limits = LIMITS) {
  return {
    occurrence: value,
    runId: RUN_ID,
    limits,
    trigger: {
      messageId: `message:${value.stableKey}`,
      correlationId: `correlation:${value.stableKey}`,
      causationId: `job:${value.jobId}`,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      actorType: "scheduler" as const,
      actorId: `scheduler:${value.jobId}`,
      dataClassification: "private" as const,
      triggerId: `trigger:${value.stableKey}`,
      sourceType: "schedule" as const,
      sourceId: value.jobId,
      occurredAt: T0,
      threadId: null,
      payloadRef: "payload-background",
      sourceProofRef: `proof:${value.stableKey}`,
    },
  };
}

function triggerService(observed: string[]) {
  const results = new Map<string, string>();
  const admission: TriggerAdmissionPort = {
    admit: async (command) => {
      const existing = results.get(command.idempotencyKey);
      if (existing) return { resultRef: existing, replayed: true };
      const resultRef = `run:${command.payload.triggerId}`;
      results.set(command.idempotencyKey, resultRef);
      observed.push(command.idempotencyKey);
      return { resultRef, replayed: false };
    },
  };
  return new UnifiedTriggerIngestionService(admission);
}

function settlement(
  current: BackgroundOccurrence,
  input: Partial<BackgroundOccurrenceSettlement>,
): BackgroundOccurrenceSettlement {
  if (!current.workLease) throw new Error("Occurrence must be claimed before settlement");
  return {
    occurrenceId: current.id,
    expectedRevision: current.revision,
    authority: AUTHORITY,
    leaseId: current.workLease.id,
    settledAt: T1,
    outcome: "completed",
    spentCostMicros: 50,
    errorCode: null,
    failureClass: null,
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000, jitterSeed: 0 },
    ...input,
  };
}

describe("Task 12 durable background recovery", () => {
  it("merges stable occurrences, reuses unified Trigger admission, and defaults to one active Run", async () => {
    const resource = await setup();
    await addJob(resource.repository, "job-single");
    const observed: string[] = [];
    const service = new DurableBackgroundWorkService({
      state: resource.repository.backgroundWorkState(),
      triggers: triggerService(observed),
    });
    const first = await service.dispatch(
      dispatchInput(
        occurrence({
          id: "occurrence-first",
          jobId: "job-single",
          stableKey: "same",
          parallelSafe: true,
        }),
      ),
    );
    const duplicate = await service.dispatch(
      dispatchInput(
        occurrence({
          id: "occurrence-duplicate",
          jobId: "job-single",
          stableKey: "same",
          parallelSafe: true,
        }),
      ),
    );
    const blocked = await service.dispatch(
      dispatchInput(occurrence({ id: "occurrence-blocked", jobId: "job-single" })),
    );
    const parallel = await service.dispatch(
      dispatchInput(
        occurrence({ id: "occurrence-parallel", jobId: "job-single", parallelSafe: true }),
      ),
    );

    expect(first.outcome).toBe("admitted");
    expect(duplicate).toMatchObject({ outcome: "duplicate", replayed: true });
    expect(duplicate.occurrence.id).toBe(first.occurrence.id);
    expect(blocked).toMatchObject({
      outcome: "capacity_blocked",
      reasonCode: "JOB_ALREADY_ACTIVE",
    });
    expect(parallel.outcome).toBe("admitted");
    expect(observed).toEqual([
      "background:same",
      "background:job-single:occurrence-blocked",
      "background:job-single:occurrence-parallel",
    ]);

    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("enforces persistent hard budgets, category capacity, and foreground reservation", async () => {
    const resource = await setup();
    const state = resource.repository.backgroundWorkState();
    const service = new DurableBackgroundWorkService({ state, triggers: triggerService([]) });
    for (const id of ["job-budget", "job-background-a", "job-background-b", "job-foreground"]) {
      await addJob(resource.repository, id, id === "job-foreground" ? "foreground" : "monitor");
    }
    const budget = await service.dispatch(
      dispatchInput(
        occurrence({ id: "occurrence-budget", jobId: "job-budget", estimatedCostMicros: 101 }),
        {
          ...LIMITS,
          globalCostMicros: 100,
          perRunCostMicros: 100,
          perClassificationCostMicros: {
            ...LIMITS.perClassificationCostMicros,
            private: 100,
          },
        },
      ),
    );
    const capacityLimits = {
      ...LIMITS,
      totalRuns: 2,
      foregroundReserved: 1,
      perCategory: { monitor: 10, foreground: 1 },
    };
    const backgroundA = await service.dispatch(
      dispatchInput(occurrence({ id: "occurrence-a", jobId: "job-background-a" }), capacityLimits),
    );
    const backgroundB = await service.dispatch(
      dispatchInput(occurrence({ id: "occurrence-b", jobId: "job-background-b" }), capacityLimits),
    );
    const foreground = await service.dispatch(
      dispatchInput(
        occurrence({
          id: "occurrence-foreground",
          jobId: "job-foreground",
          category: "foreground",
          foreground: true,
        }),
        capacityLimits,
      ),
    );

    expect(budget).toMatchObject({
      outcome: "budget_blocked",
      reasonCode: "RUN_BUDGET_EXCEEDED",
    });
    expect(backgroundA.outcome).toBe("admitted");
    expect(backgroundB).toMatchObject({
      outcome: "capacity_blocked",
      reasonCode: "FOREGROUND_CAPACITY_RESERVED",
    });
    expect(foreground.outcome).toBe("admitted");
    expect((await state.readOccurrence(budget.occurrence.id))?.status).toBe("budget_blocked");

    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("uses bounded retry and never automatically retries credential, authorization, or policy failures", async () => {
    const resource = await setup();
    const state = resource.repository.backgroundWorkState();
    const service = new DurableBackgroundWorkService({ state, triggers: triggerService([]) });
    const cases = [
      ["transport", "retry_wait"],
      ["credential", "blocked_credentials"],
      ["authorization", "blocked_approval"],
      ["policy", "failed_terminal"],
    ] as const;
    for (const [failureClass, expectedStatus] of cases) {
      const jobId = `job-${failureClass}`;
      await addJob(resource.repository, jobId);
      const admitted = await service.dispatch(
        dispatchInput(occurrence({ id: `occurrence-${failureClass}`, jobId })),
      );
      const claimed = await service.claim({
        occurrenceId: admitted.occurrence.id,
        expectedRevision: admitted.occurrence.revision,
        authority: AUTHORITY,
        leaseId: `lease-${failureClass}`,
        holderId: "worker-a",
        claimedAt: T0,
        expiresAt: T2,
      });
      const settled = await service.settle(
        settlement(claimed, {
          outcome: "failed",
          spentCostMicros: 10,
          errorCode: `ERROR_${failureClass.toUpperCase()}`,
          failureClass,
        }),
      );
      expect(settled.status).toBe(expectedStatus);
      expect(settled.nextRetryAt).toBe(failureClass === "transport" ? T2 : null);
    }

    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("restores checkpoints, blockers, unknown results, expired work, approval, and Delivery without browser state", async () => {
    const resource = await setup();
    const state = resource.repository.backgroundWorkState();
    const service = new DurableBackgroundWorkService({ state, triggers: triggerService([]) });
    await resource.repository
      .authoritativeRunCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY)
      .compareAndSet({
        key: `run-checkpoint:${RUN_ID}`,
        expectedRevision: null,
        value: {
          phase: "runtime",
          contextRef: "payload-background",
          workerResults: {},
          runtimeEventCount: 1,
          lastTraceEventId: null,
          terminalStatus: null,
        },
      });
    const states = ["running", "retry", "model", "unknown"] as const;
    for (const stateName of states) await addJob(resource.repository, `job-${stateName}`);

    const admittedRunning = await service.dispatch(
      dispatchInput(occurrence({ id: "occurrence-running", jobId: "job-running" })),
    );
    await service.claim({
      occurrenceId: admittedRunning.occurrence.id,
      expectedRevision: admittedRunning.occurrence.revision,
      authority: AUTHORITY,
      leaseId: "lease-expiring",
      holderId: "worker-before-restart",
      claimedAt: T0,
      expiresAt: T2,
    });

    const createSettled = async (
      name: "retry" | "model" | "unknown",
      values: Partial<BackgroundOccurrenceSettlement>,
    ) => {
      const admitted = await service.dispatch(
        dispatchInput(occurrence({ id: `occurrence-${name}`, jobId: `job-${name}` })),
      );
      const claimed = await service.claim({
        occurrenceId: admitted.occurrence.id,
        expectedRevision: admitted.occurrence.revision,
        authority: AUTHORITY,
        leaseId: `lease-${name}`,
        holderId: "worker-before-restart",
        claimedAt: T0,
        expiresAt: T2,
      });
      return service.settle(settlement(claimed, values));
    };
    await createSettled("retry", {
      outcome: "failed",
      failureClass: "transport",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await createSettled("model", { outcome: "model_blocked", errorCode: "MODEL_BLOCKED" });
    await createSettled("unknown", {
      outcome: "external_result_unknown",
      errorCode: "EXTERNAL_RESULT_UNKNOWN",
    });
    expect(
      await service.dispatch(
        dispatchInput(occurrence({ id: "occurrence-retry", jobId: "job-retry" })),
      ),
    ).toMatchObject({ outcome: "blocked", reasonCode: "RETRY_NOT_DUE" });
    expect(
      await service.dispatch(
        dispatchInput(occurrence({ id: "occurrence-model", jobId: "job-model" })),
      ),
    ).toMatchObject({ outcome: "blocked", reasonCode: "MODEL_BLOCKED" });
    expect(
      await service.dispatch(
        dispatchInput(occurrence({ id: "occurrence-unknown", jobId: "job-unknown" })),
      ),
    ).toMatchObject({
      outcome: "reconcile_required",
      reasonCode: "EXTERNAL_RESULT_RECONCILIATION_REQUIRED",
    });

    await resource.repository.authorizationStore().createApproval({
      id: "approval-background",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      intentId: "intent-background",
      intentSnapshot: {
        id: "intent-background",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        capabilityRef: "capability-background",
        operation: "run",
        resourceRef: "resource-background",
        dataClassification: "private",
        sideEffect: "none",
        estimatedCostMicros: 1,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey("intent-background"),
        reversible: true,
        requestedAt: T0,
      },
      semanticSnapshotHash: "snapshot-background",
      status: "pending",
      deliveryState: "queued_no_ui",
      requestedAt: T0,
      expiresAt: FAR_FUTURE,
      decidedAt: null,
      grantId: null,
    });
    const attention = resource.repository.attentionState();
    await attention.commitDecision({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      expectedRevision: 0,
      record: {
        candidateId: "candidate-background",
        candidateFingerprint: "fingerprint-background",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        duplicateKey: "duplicate-background",
        decision: {
          candidateId: "candidate-background",
          level: "INBOX",
          reasonCode: "background_complete",
          interruptAuthorizationRef: null,
        },
        deliveryRequestId: "delivery-background",
        decidedAt: T0,
      },
      delivery: {
        id: "delivery-background",
        candidateId: "candidate-background",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        resultRef: "payload-background",
        dataClassification: "private",
        level: "INBOX",
        status: "pending",
        assignedClientId: null,
        attempts: 0,
        acknowledgementRef: null,
        lastErrorCode: null,
        createdAt: T0,
        updatedAt: T0,
      },
    });
    await attention.claimDelivery("delivery-background", "browser-before-close", T1);
    await resource.repository.close();

    const authorityDatabase = openQualifiedDatabase(resource.databasePath);
    authorityDatabase
      .prepare("UPDATE deployments SET revision = 1, fencing_token = 2 WHERE id = ?")
      .run(DEPLOYMENT_ID);
    authorityDatabase.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      databasePath: resource.databasePath,
      minimumFreeBytes: 0,
      now: () => T2,
    });
    const recovery = await reopened.startupRecovery();
    expect(recovery.unfinishedRunKeys).toEqual(
      expect.arrayContaining([RUN_ID, `run-checkpoint:${RUN_ID}`]),
    );
    expect(recovery.pendingApprovalRequestIds).toEqual(["approval-background"]);
    expect(recovery.expiredWorkLeaseOccurrenceIds).toEqual(["occurrence-running"]);
    expect(recovery.retryableJobOccurrenceIds).toEqual(
      expect.arrayContaining(["occurrence-running", "occurrence-retry", "occurrence-unknown"]),
    );
    expect(recovery.modelBlockedOccurrenceIds).toEqual(["occurrence-model"]);
    expect(recovery.unknownExternalResultOccurrenceIds).toEqual(["occurrence-unknown"]);
    expect(recovery.recoveredDeliveryRequestIds).toEqual(["delivery-background"]);
    expect(await reopened.attentionState().readDelivery("delivery-background")).toMatchObject({
      status: "pending",
      assignedClientId: null,
      lastErrorCode: "PROCESS_RESTARTED",
    });
    expect(
      await reopened
        .authoritativeRunCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY)
        .read(`run-checkpoint:${RUN_ID}`),
    ).toMatchObject({ revision: 1, value: { phase: "runtime" } });
    await expect(
      reopened.authoritativeRunCheckpointStore(OWNER_ID, AGENT_ID, AUTHORITY).compareAndSet({
        key: `run-checkpoint:${RUN_ID}`,
        expectedRevision: 1,
        value: {
          phase: "runtime",
          contextRef: "payload-background",
          workerResults: {},
          runtimeEventCount: 2,
          lastTraceEventId: null,
          terminalStatus: null,
        },
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    await expect(
      reopened.backgroundWorkState().claimOccurrence({
        occurrenceId: createOccurrenceId("occurrence-running"),
        expectedRevision: 3,
        authority: AUTHORITY,
        leaseId: "stale-authority-lease",
        holderId: "worker-after-restart",
        claimedAt: T2,
        expiresAt: T3,
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });

    await reopened.close();
    await rm(resource.stateRoot, { recursive: true });
  });
});
