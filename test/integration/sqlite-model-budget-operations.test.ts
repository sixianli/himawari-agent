import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BackgroundAdmissionLimits,
  BackgroundOccurrenceSettlement,
  ModelInvocationIdentityBeginInput,
  ScheduledJobWrite,
} from "@himawari-agent/application";
import {
  claimFromRunExecutionLease,
  type ModelInvocationAdmissionDescriptor,
  ModelInvocationAdmissionService,
} from "@himawari-agent/application";
import {
  type BackgroundOccurrence,
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createJobId,
  createOccurrenceId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
  type SqliteRecoveryAuthorityScope,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-model-budget");
const AGENT_ID = createAgentId("agent-model-budget");
const DEPLOYMENT_ID = createDeploymentId("deployment-model-budget");
const JOB_ID = createJobId("job-model-budget");
const OCCURRENCE_ID = createOccurrenceId("occurrence-model-budget");
const RUN_ID = createRunId("run-model-budget");
const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T00:00:01.000Z";
const EXPIRED_LEASE_AT = "2026-09-05T00:00:00.500Z";
const FAR_FUTURE = "2999-12-31T23:59:59.999Z";
const AUTHORITY_LEASE_ID = createAuthorityLeaseId("lease-model-budget");
const EXECUTION_LEASE_ID = createRunExecutionLeaseId("execution-model-budget");
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const RECOVERY_SCOPE: SqliteRecoveryAuthorityScope = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  authority: AUTHORITY,
  authorityLease: {
    leaseId: AUTHORITY_LEASE_ID,
    fencingToken: AUTHORITY.fencingToken,
  },
};
const LIMITS: BackgroundAdmissionLimits = {
  globalCostMicros: 10_000,
  perRunCostMicros: 1_000,
  perClassificationCostMicros: {
    public: 10_000,
    private: 10_000,
    sensitive: 10_000,
    restricted: 10_000,
  },
  totalRuns: 4,
  foregroundReserved: 0,
  perCategory: { monitor: 4 },
};
const MODEL_LIMITS = {
  accountCostMicros: 1_000,
  globalCostMicros: 10_000,
  perClassificationCostMicros: {
    public: 10_000,
    private: 10_000,
    sensitive: 10_000,
    restricted: 10_000,
  },
} as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function job(): ScheduledJobWrite {
  return {
    id: JOB_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: null,
    payloadRef: "payload-model-budget",
    sourceProofRef: "proof-model-budget",
    dataClassification: "private",
    authorizationRef: "authorization-model-budget",
    taskScopeRef: "scope-model-budget",
    capabilityRef: "capability-model-budget",
    operation: "run",
    resourceRef: "resource-model-budget",
    sideEffect: "none",
    estimatedCostMicros: 100,
    intervalMs: 60_000,
    minimumIntervalMs: 60_000,
    expiresAt: FAR_FUTURE,
    revokedAt: null,
    nextRunAt: NOW,
    occurrence: 0,
    status: "active",
  };
}

function occurrence(): BackgroundOccurrence {
  return {
    id: OCCURRENCE_ID,
    jobId: JOB_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    stableKey: "model-budget-occurrence",
    status: "queued",
    authority: AUTHORITY,
    category: "monitor",
    dataClassification: "private",
    foreground: false,
    parallelSafe: false,
    estimatedCostMicros: 100,
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

function unknownSettlement(current: BackgroundOccurrence): BackgroundOccurrenceSettlement {
  if (!current.workLease) throw new Error("Expected a claimed occurrence");
  return {
    occurrenceId: current.id,
    expectedRevision: current.revision,
    authority: AUTHORITY,
    leaseId: current.workLease.id,
    settledAt: LATER,
    outcome: "external_result_unknown",
    spentCostMicros: 0,
    errorCode: "UNRELATED_ERROR_CODE",
    failureClass: null,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitterSeed: 0,
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-model-budget-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "product.sqlite");
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
      `INSERT INTO authority_leases (
        id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
        fencing_token, acquired_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, 'holder-model-budget', 1, 1, ?, ?, NULL)`,
    )
    .run(AUTHORITY_LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW, FAR_FUTURE);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type
      ) VALUES ('payload-model-budget', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:model-budget', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-model-budget', ?, ?, NULL, 'trigger-model-budget',
        'schedule', 'model-budget', 'payload-model-budget', 'proof-model-budget', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'session-model-budget', 'trigger-model-budget',
        1, 'accepted', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, NOW, NOW);
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot: directory,
    databasePath,
    minimumFreeBytes: 0,
    now: () => NOW,
  });
  await repository.scheduler().upsert(job(), null);
  return { databasePath, repository };
}

describe("SQLite model budget migration red tests", () => {
  it("does not expose a generic occurrence writer for budget facts", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      expect("saveOccurrence" in state).toBe(false);
    } finally {
      await resource.repository.close();
    }
  });

  it("keeps an unknown external result reservation for reconciliation", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      const admitted = await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: NOW,
      });
      const claimed = await state.claimOccurrence({
        occurrenceId: admitted.occurrence.id,
        expectedRevision: admitted.occurrence.revision,
        authority: AUTHORITY,
        leaseId: "work-lease-model-budget",
        holderId: "worker-model-budget",
        claimedAt: NOW,
        expiresAt: LATER,
      });
      const unknown = await state.settleOccurrence(unknownSettlement(claimed));
      expect(unknown.reservedCostMicros).toBe(created.estimatedCostMicros);
      expect(unknown.spentCostMicros).toBe(0);
      const admissionRetry = await state.reserveAdmission({
        occurrenceId: unknown.id,
        expectedRevision: unknown.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: LATER,
      });
      expect(admissionRetry.outcome).toBe("reconcile_required");
      expect(admissionRetry.reasonCode).toBe("EXTERNAL_RESULT_RECONCILIATION_REQUIRED");
      await resource.repository.close();
      const restarted = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      const recovery = await restarted.startupRecovery(RECOVERY_SCOPE);
      expect(recovery.unknownExternalResultOccurrenceIds).toContain(created.id);
      expect(recovery.retryableJobOccurrenceIds).not.toContain(created.id);
      await restarted.close();
    } finally {
      await resource.repository.close();
    }
  });

  it("routes an unknown child on an expired occurrence lease only to reconciliation", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      const admitted = await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: NOW,
      });
      const claimed = await state.claimOccurrence({
        occurrenceId: admitted.occurrence.id,
        expectedRevision: admitted.occurrence.revision,
        authority: AUTHORITY,
        leaseId: "work-lease-unknown-recovery",
        holderId: "worker-unknown-recovery",
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      if (!claimed.workLease) throw new Error("Expected a claimed occurrence");
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      const activeParent = {
        kind: "occurrence" as const,
        occurrenceId: claimed.id,
        expectedRevision: claimed.revision,
        workLeaseId: claimed.workLease.id,
        workLeaseHolderId: claimed.workLease.holderId,
      };
      const allocation = await budget.reserve({
        parent: activeParent,
        operationKey: "unknown-recovery-child",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 25,
        limits: MODEL_LIMITS,
        reservedAt: NOW,
      });
      await budget.markStarted({
        parent: activeParent,
        operationKey: allocation.allocation.operationKey,
        startedAt: NOW,
      });
      await budget.markUnknown({
        parent: { kind: "occurrence", occurrenceId: claimed.id },
        operationKey: allocation.allocation.operationKey,
        observedAt: LATER,
        reasonCode: "provider_unresolved",
      });

      await resource.repository.close();
      const database = openQualifiedDatabase(resource.databasePath);
      try {
        const row = database
          .prepare("SELECT record_json AS recordJson FROM job_occurrences WHERE id = ?")
          .get(claimed.id) as { readonly recordJson: string };
        const record = JSON.parse(row.recordJson) as BackgroundOccurrence;
        if (!record.workLease) throw new Error("Expected persisted work lease");
        const expiredAt = "2026-09-05T00:00:00.500Z";
        const expiredRecord = {
          ...record,
          workLease: { ...record.workLease, expiresAt: expiredAt },
        };
        database
          .prepare(
            "UPDATE job_occurrences SET work_lease_expires_at = ?, record_json = ? WHERE id = ?",
          )
          .run(expiredAt, JSON.stringify(expiredRecord), claimed.id);
      } finally {
        database.close();
      }

      const restarted = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => LATER,
      });
      try {
        const recovery = await restarted.startupRecovery(RECOVERY_SCOPE);
        expect(recovery.unknownExternalResultOccurrenceIds).toContain(claimed.id);
        const recoverable = await restarted
          .backgroundWorkState()
          .listRecoverable(OWNER_ID, AGENT_ID, LATER, 10);
        expect(recoverable.map(({ id }) => id)).not.toContain(claimed.id);
        expect(recovery.retryableJobOccurrenceIds).not.toContain(claimed.id);
        expect(recovery.expiredWorkLeaseOccurrenceIds).not.toContain(claimed.id);
        await expect(
          restarted.backgroundWorkState().claimOccurrence({
            occurrenceId: claimed.id,
            expectedRevision: claimed.revision,
            authority: AUTHORITY,
            leaseId: "work-lease-unknown-recovery-retry",
            holderId: "worker-unknown-recovery-retry",
            claimedAt: LATER,
            expiresAt: FAR_FUTURE,
          }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await expect(
          restarted.backgroundWorkState().reserveAdmission({
            occurrenceId: claimed.id,
            expectedRevision: claimed.revision,
            runId: RUN_ID,
            authority: AUTHORITY,
            limits: LIMITS,
            admittedAt: LATER,
          }),
        ).resolves.toMatchObject({
          outcome: "reconcile_required",
          reasonCode: "EXTERNAL_RESULT_RECONCILIATION_REQUIRED",
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await resource.repository.close();
    }
  });

  it("keeps legacy unknown occurrences out of retryable and recoverable lists", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: NOW,
      });

      await resource.repository.close();
      const database = openQualifiedDatabase(resource.databasePath);
      try {
        const row = database
          .prepare("SELECT record_json AS recordJson FROM job_occurrences WHERE id = ?")
          .get(created.id) as { readonly recordJson: string };
        const record = JSON.parse(row.recordJson) as BackgroundOccurrence;
        const legacyRetryWait: BackgroundOccurrence = {
          ...record,
          status: "retry_wait",
          nextRetryAt: NOW,
          workLease: null,
          lastErrorCode: "EXTERNAL_RESULT_UNKNOWN",
        };
        database
          .prepare(
            `UPDATE job_occurrences
             SET status = 'retry_wait', next_retry_at = ?,
                 work_lease_id = NULL, work_lease_holder_id = NULL,
                 work_lease_acquired_at = NULL, work_lease_expires_at = NULL,
                 last_error_code = ?, record_json = ?
             WHERE id = ?`,
          )
          .run(NOW, "EXTERNAL_RESULT_UNKNOWN", JSON.stringify(legacyRetryWait), created.id);
      } finally {
        database.close();
      }

      const retryRepository = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => LATER,
      });
      try {
        const recovery = await retryRepository.startupRecovery(RECOVERY_SCOPE);
        expect(recovery.retryableJobOccurrenceIds).not.toContain(created.id);
        expect(recovery.unknownExternalResultOccurrenceIds).toContain(created.id);
        const recoverable = await retryRepository
          .backgroundWorkState()
          .listRecoverable(OWNER_ID, AGENT_ID, LATER, 10);
        expect(recoverable.map(({ id }) => id)).not.toContain(created.id);
      } finally {
        await retryRepository.close();
      }

      const runningDatabase = openQualifiedDatabase(resource.databasePath);
      try {
        const row = runningDatabase
          .prepare("SELECT record_json AS recordJson FROM job_occurrences WHERE id = ?")
          .get(created.id) as { readonly recordJson: string };
        const record = JSON.parse(row.recordJson) as BackgroundOccurrence;
        const expiredAt = "2026-09-05T00:00:00.500Z";
        const legacyRunningWorkLease = {
          id: "legacy-unknown-work-lease",
          holderId: "legacy-unknown-worker",
          acquiredAt: NOW,
          expiresAt: expiredAt,
        } as const;
        const legacyRunning: BackgroundOccurrence = {
          ...record,
          status: "running",
          nextRetryAt: null,
          workLease: legacyRunningWorkLease,
          lastErrorCode: "EXTERNAL_RESULT_UNKNOWN",
        };
        runningDatabase
          .prepare(
            `UPDATE job_occurrences
             SET status = 'running', next_retry_at = NULL,
                 work_lease_id = ?, work_lease_holder_id = ?,
                 work_lease_acquired_at = ?, work_lease_expires_at = ?,
                 last_error_code = ?, record_json = ?
             WHERE id = ?`,
          )
          .run(
            legacyRunningWorkLease.id,
            legacyRunningWorkLease.holderId,
            legacyRunningWorkLease.acquiredAt,
            legacyRunningWorkLease.expiresAt,
            legacyRunning.lastErrorCode,
            JSON.stringify(legacyRunning),
            created.id,
          );
      } finally {
        runningDatabase.close();
      }

      const expiredRepository = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => LATER,
      });
      try {
        const recovery = await expiredRepository.startupRecovery(RECOVERY_SCOPE);
        expect(recovery.expiredWorkLeaseOccurrenceIds).not.toContain(created.id);
        const recoverable = await expiredRepository
          .backgroundWorkState()
          .listRecoverable(OWNER_ID, AGENT_ID, LATER, 10);
        expect(recoverable.map(({ id }) => id)).not.toContain(created.id);
      } finally {
        await expiredRepository.close();
      }
    } finally {
      await resource.repository.close();
    }
  });

  it("draws child allocations from an admitted occurrence without double counting", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      const admitted = await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: NOW,
      });
      const claimed = await state.claimOccurrence({
        occurrenceId: admitted.occurrence.id,
        expectedRevision: admitted.occurrence.revision,
        authority: AUTHORITY,
        leaseId: "work-lease-child-budget",
        holderId: "worker-child-budget",
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      if (!claimed.workLease) throw new Error("Expected a claimed occurrence");
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      const activeParent = {
        kind: "occurrence" as const,
        occurrenceId: claimed.id,
        expectedRevision: claimed.revision,
        workLeaseId: claimed.workLease.id,
        workLeaseHolderId: claimed.workLease.holderId,
      };
      const limits = {
        accountCostMicros: 1_000,
        globalCostMicros: 10_000,
        perClassificationCostMicros: {
          public: 10_000,
          private: 10_000,
          sensitive: 10_000,
          restricted: 10_000,
        },
      } as const;
      const first = await budget.reserve({
        parent: activeParent,
        operationKey: "child-budget-1",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 40,
        limits,
        reservedAt: NOW,
      });
      const second = await budget.reserve({
        parent: activeParent,
        operationKey: "child-budget-2",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 60,
        limits,
        reservedAt: NOW,
      });
      expect(first.account.reservedCostMicros).toBe(created.estimatedCostMicros);
      expect(second.account.reservedCostMicros).toBe(created.estimatedCostMicros);
      await expect(
        budget.reserve({
          parent: activeParent,
          operationKey: "child-budget-over-cap",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits,
          reservedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });

      await budget.markStarted({
        parent: activeParent,
        operationKey: first.allocation.operationKey,
        startedAt: NOW,
      });
      const firstSettled = await budget.settle({
        parent: { kind: "occurrence", occurrenceId: claimed.id },
        operationKey: first.allocation.operationKey,
        actualCostMicros: 30,
        settledAt: LATER,
      });
      expect(firstSettled.account.reservedCostMicros).toBe(60);
      expect(firstSettled.account.spentCostMicros).toBe(30);
      await budget.markStarted({
        parent: activeParent,
        operationKey: second.allocation.operationKey,
        startedAt: NOW,
      });
      const unknown = await budget.markUnknown({
        parent: { kind: "occurrence", occurrenceId: claimed.id },
        operationKey: second.allocation.operationKey,
        observedAt: LATER,
        reasonCode: "provider_unresolved",
      });
      expect(unknown.account.reservedCostMicros).toBe(60);
      expect(unknown.account.status).toBe("reconcile_required");
      const reconciled = await budget.settle({
        parent: { kind: "occurrence", occurrenceId: claimed.id },
        operationKey: second.allocation.operationKey,
        actualCostMicros: 70,
        settledAt: LATER,
      });
      expect(reconciled.account.reservedCostMicros).toBe(0);
      expect(reconciled.account.spentCostMicros).toBe(100);
      expect(reconciled.account.status).toBe("over_budget");

      const closed = await state.settleOccurrence({
        occurrenceId: claimed.id,
        expectedRevision: claimed.revision,
        authority: AUTHORITY,
        leaseId: claimed.workLease.id,
        settledAt: LATER,
        outcome: "completed",
        spentCostMicros: 0,
        errorCode: null,
        failureClass: null,
        retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000, jitterSeed: 0 },
      });
      expect(closed.reservedCostMicros).toBe(0);
      expect(closed.spentCostMicros).toBe(100);
      const finalized = await budget.read({
        parent: { kind: "occurrence", occurrenceId: claimed.id },
        limit: 10,
      });
      expect(finalized?.account.status).toBe("over_budget");
    } finally {
      await resource.repository.close();
    }
  });

  it("applies one global and classification budget across background and foreground parents", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: {
          ...LIMITS,
          globalCostMicros: 100,
          perRunCostMicros: 100,
          perClassificationCostMicros: {
            ...LIMITS.perClassificationCostMicros,
            private: 100,
          },
        },
        admittedAt: NOW,
      });
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-global-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-global"),
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await expect(
        budget.reserve({
          parent: {
            kind: "run",
            runId: RUN_ID,
            executionLease: claimFromRunExecutionLease(claimed),
          },
          operationKey: "foreground-over-background-budget",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits: {
            accountCostMicros: 100,
            globalCostMicros: 100,
            perClassificationCostMicros: {
              public: 10_000,
              private: 100,
              sensitive: 10_000,
              restricted: 10_000,
            },
          },
          reservedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      await resource.repository.close();
    }
  });

  it("rejects a Run budget parent when the Run is already owned by an occurrence", async () => {
    const resource = await fixture();
    try {
      const state = resource.repository.backgroundWorkState();
      const created = await state.createOccurrence(occurrence());
      const admitted = await state.reserveAdmission({
        occurrenceId: created.id,
        expectedRevision: created.revision,
        runId: RUN_ID,
        authority: AUTHORITY,
        limits: LIMITS,
        admittedAt: NOW,
      });
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-ownership-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-ownership"),
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await expect(
        budget.reserve({
          parent: {
            kind: "run",
            runId: RUN_ID,
            executionLease: claimFromRunExecutionLease(claimed),
          },
          operationKey: "run-parent-after-occurrence",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits: MODEL_LIMITS,
          reservedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      expect(admitted.occurrence.runId).toBe(RUN_ID);
      expect(
        await budget.read({
          parent: { kind: "run", runId: RUN_ID },
          limit: 10,
        }),
      ).toBeUndefined();
      const runs = resource.repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY);
      const executionLease = claimFromRunExecutionLease(claimed);
      await runs.transitionRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        expectedRevision: 1,
        nextStatus: "building_context",
        idempotencyKey: createIdempotencyKey("budget-ownership-finalize-building"),
        commandFingerprint: "budget-ownership-finalize-building",
        payloadRef: "payload-model-budget",
        authority: { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        executionLease,
      });
      await runs.transitionRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        expectedRevision: 2,
        nextStatus: "failed",
        idempotencyKey: createIdempotencyKey("budget-ownership-finalize-failed"),
        commandFingerprint: "budget-ownership-finalize-failed",
        payloadRef: "payload-model-budget",
        authority: { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        executionLease,
      });
      await expect(
        budget.finalize({
          parent: { kind: "run", runId: RUN_ID },
          finalizedAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      expect(
        await budget.read({
          parent: { kind: "run", runId: RUN_ID },
          limit: 10,
        }),
      ).toBeUndefined();
    } finally {
      await resource.repository.close();
    }

    const reverse = await fixture();
    try {
      const dispatch = reverse.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-ownership-reverse",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-ownership-reverse"),
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const budget = reverse.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await budget.reserve({
        parent: {
          kind: "run",
          runId: RUN_ID,
          executionLease: claimFromRunExecutionLease(claimed),
        },
        operationKey: "run-parent-before-occurrence",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 1,
        limits: MODEL_LIMITS,
        reservedAt: NOW,
      });
      const created = await reverse.repository.backgroundWorkState().createOccurrence(occurrence());
      await expect(
        reverse.repository.backgroundWorkState().reserveAdmission({
          occurrenceId: created.id,
          expectedRevision: created.revision,
          runId: RUN_ID,
          authority: AUTHORITY,
          limits: LIMITS,
          admittedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      await reverse.repository.close();
    }
  });

  it("keeps an over-budget account sticky after later allocations settle", async () => {
    const resource = await fixture();
    try {
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-overrun-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-overrun"),
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const executionLease = claimFromRunExecutionLease(claimed);
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      const parent = { kind: "run" as const, runId: RUN_ID, executionLease };
      const limits = {
        accountCostMicros: 1_000,
        globalCostMicros: 10_000,
        perClassificationCostMicros: {
          public: 10_000,
          private: 10_000,
          sensitive: 10_000,
          restricted: 10_000,
        },
      } as const;
      const first = await budget.reserve({
        parent,
        operationKey: "overrun-first",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 10,
        limits,
        reservedAt: NOW,
      });
      const second = await budget.reserve({
        parent,
        operationKey: "overrun-second",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 10,
        limits,
        reservedAt: NOW,
      });
      await budget.markStarted({
        parent,
        operationKey: first.allocation.operationKey,
        startedAt: NOW,
      });
      await budget.markStarted({
        parent,
        operationKey: second.allocation.operationKey,
        startedAt: NOW,
      });

      const overrun = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: first.allocation.operationKey,
        actualCostMicros: 20,
        settledAt: LATER,
      });
      expect(overrun.account.status).toBe("over_budget");
      const later = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: second.allocation.operationKey,
        actualCostMicros: 5,
        settledAt: LATER,
      });
      expect(later.account.status).toBe("over_budget");
      expect(later.account.reservedCostMicros).toBe(0);
      expect(later.account.spentCostMicros).toBe(25);
      await expect(
        budget.reserve({
          parent,
          operationKey: "overrun-after-settlement",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits,
          reservedAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      await resource.repository.close();
    }
  });

  it("rejects a stale deployment fence before creating a foreground allocation", async () => {
    const resource = await fixture();
    await resource.repository.close();
    const database = openQualifiedDatabase(resource.databasePath);
    database.prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?").run(DEPLOYMENT_ID);
    database.close();
    const restarted = await SqliteProductStateRepository.open({
      stateRoot: path.dirname(resource.databasePath),
      databasePath: resource.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    try {
      const budget = restarted.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await expect(
        budget.reserve({
          parent: {
            kind: "run",
            runId: RUN_ID,
            executionLease: {
              executionLeaseId: EXECUTION_LEASE_ID,
              expectedLeaseRevision: 0,
              authorityLeaseId: AUTHORITY_LEASE_ID,
              authorityFencingToken: 1,
              deploymentId: DEPLOYMENT_ID,
              authorityEpoch: 1,
              fencingToken: 1,
              consumerId: "stale-authority-consumer",
            },
          },
          operationKey: "stale-authority-call",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits: {
            accountCostMicros: 1_000,
            globalCostMicros: 10_000,
            perClassificationCostMicros: {
              public: 10_000,
              private: 10_000,
              sensitive: 10_000,
              restricted: 10_000,
            },
          },
          reservedAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    } finally {
      await restarted.close();
    }
  });

  it("rejects a foreground allocation after its execution lease expires", async () => {
    const resource = await fixture();
    try {
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-expiry-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-expiry"),
        claimedAt: NOW,
        expiresAt: LATER,
      });
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await expect(
        budget.reserve({
          parent: {
            kind: "run",
            runId: RUN_ID,
            executionLease: claimFromRunExecutionLease(claimed),
          },
          operationKey: "expired-execution-call",
          modelRef: "approved-model-v1",
          dataClassification: "private",
          estimatedCostMicros: 1,
          limits: {
            accountCostMicros: 1_000,
            globalCostMicros: 10_000,
            perClassificationCostMicros: {
              public: 10_000,
              private: 10_000,
              sensitive: 10_000,
              restricted: 10_000,
            },
          },
          reservedAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      await resource.repository.close();
    }
  });

  it("finalizes only unallocated Run budget after the canonical Run becomes terminal", async () => {
    const resource = await fixture();
    try {
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-finalize-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: createRunExecutionLeaseId("execution-model-budget-finalize"),
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const executionLease = claimFromRunExecutionLease(claimed);
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      await budget.reserve({
        parent: { kind: "run", runId: RUN_ID, executionLease },
        operationKey: "finalize-open-call",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 50,
        limits: {
          accountCostMicros: 1_000,
          globalCostMicros: 10_000,
          perClassificationCostMicros: {
            public: 10_000,
            private: 10_000,
            sensitive: 10_000,
            restricted: 10_000,
          },
        },
        reservedAt: NOW,
      });
      const startedAllocation = await budget.reserve({
        parent: { kind: "run", runId: RUN_ID, executionLease },
        operationKey: "finalize-started-call",
        modelRef: "approved-model-v1",
        dataClassification: "private",
        estimatedCostMicros: 30,
        limits: {
          accountCostMicros: 1_000,
          globalCostMicros: 10_000,
          perClassificationCostMicros: {
            public: 10_000,
            private: 10_000,
            sensitive: 10_000,
            restricted: 10_000,
          },
        },
        reservedAt: NOW,
      });
      await budget.markStarted({
        parent: { kind: "run", runId: RUN_ID, executionLease },
        operationKey: startedAllocation.allocation.operationKey,
        startedAt: NOW,
      });
      const runs = resource.repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY);
      await runs.transitionRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        expectedRevision: 1,
        nextStatus: "building_context",
        idempotencyKey: createIdempotencyKey("budget-finalize-building"),
        commandFingerprint: "budget-finalize-building",
        payloadRef: "payload-model-budget",
        authority: { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        executionLease,
      });
      await runs.transitionRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        expectedRevision: 2,
        nextStatus: "failed",
        idempotencyKey: createIdempotencyKey("budget-finalize-failed"),
        commandFingerprint: "budget-finalize-failed",
        payloadRef: "payload-model-budget",
        authority: { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        executionLease,
      });
      const openFinalized = await budget.finalize({
        parent: { kind: "run", runId: RUN_ID },
        finalizedAt: LATER,
      });
      expect(openFinalized.reservedCostMicros).toBe(30);
      expect(openFinalized.status).toBe("reconcile_required");
      const finalizedSnapshot = await budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(
        finalizedSnapshot?.allocations.map(({ operationKey, status }) => ({
          operationKey,
          status,
        })),
      ).toEqual([
        { operationKey: "finalize-open-call", status: "released" },
        { operationKey: "finalize-started-call", status: "started" },
      ]);
      const settled = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: startedAllocation.allocation.operationKey,
        actualCostMicros: 20,
        settledAt: LATER,
      });
      expect(settled.account.reservedCostMicros).toBe(0);
      expect(settled.account.spentCostMicros).toBe(20);
      const finalized = await budget.finalize({
        parent: { kind: "run", runId: RUN_ID },
        finalizedAt: LATER,
      });
      expect(finalized.reservedCostMicros).toBe(0);
      expect(finalized.spentCostMicros).toBe(20);
      expect(finalized.status).toBe("active");
    } finally {
      await resource.repository.close();
    }
  });

  it("accounts a foreground Run through its real execution claim", async () => {
    const resource = await fixture();
    try {
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-budget-consumer",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: EXECUTION_LEASE_ID,
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      const activeParent = {
        kind: "run" as const,
        runId: RUN_ID,
        executionLease: claimFromRunExecutionLease(claimed),
      };
      const reserveInput = {
        parent: activeParent,
        operationKey: "model-call-1",
        modelRef: "approved-model-v1",
        dataClassification: "private" as const,
        estimatedCostMicros: 100,
        limits: {
          accountCostMicros: 1_000,
          globalCostMicros: 10_000,
          perClassificationCostMicros: {
            public: 10_000,
            private: 10_000,
            sensitive: 10_000,
            restricted: 10_000,
          },
        },
        reservedAt: NOW,
      };
      const reserved = await budget.reserve(reserveInput);
      const replayed = await budget.reserve(reserveInput);
      expect(replayed.replayed).toBe(true);
      expect(replayed.allocation.operationKey).toBe(reserved.allocation.operationKey);
      await expect(
        budget.reserve({ ...reserveInput, estimatedCostMicros: 101 }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        budget.reserve({
          ...reserveInput,
          operationKey: "model-call-lower-classification",
          dataClassification: "public",
          estimatedCostMicros: 1,
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      await expect(
        budget.reserve({
          ...reserveInput,
          operationKey: "model-call-higher-classification",
          dataClassification: "sensitive",
          estimatedCostMicros: 1,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        budget.settle({
          parent: { kind: "run", runId: RUN_ID },
          operationKey: reserveInput.operationKey,
          actualCostMicros: 80,
          settledAt: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        budget.markUnknown({
          parent: { kind: "run", runId: RUN_ID },
          operationKey: reserveInput.operationKey,
          observedAt: LATER,
          reasonCode: "provider_unresolved",
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await budget.markStarted({
        parent: activeParent,
        operationKey: reserveInput.operationKey,
        startedAt: NOW,
      });
      const settled = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: reserveInput.operationKey,
        actualCostMicros: 80,
        settledAt: LATER,
      });
      expect(settled.account.reservedCostMicros).toBe(0);
      expect(settled.account.spentCostMicros).toBe(80);
      const settledReplay = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: reserveInput.operationKey,
        actualCostMicros: 80,
        settledAt: LATER,
      });
      expect(settledReplay.replayed).toBe(true);

      const lateReserve = await budget.reserve({
        ...reserveInput,
        operationKey: "model-call-after-settle",
        estimatedCostMicros: 40,
      });
      await budget.markStarted({
        parent: activeParent,
        operationKey: lateReserve.allocation.operationKey,
        startedAt: NOW,
      });
      await dispatch.release({
        runId: RUN_ID,
        expectedLeaseRevision: claimed.revision,
        executionLeaseId: EXECUTION_LEASE_ID,
        releasedAt: LATER,
      });
      const lateSettled = await budget.settle({
        parent: { kind: "run", runId: RUN_ID },
        operationKey: lateReserve.allocation.operationKey,
        actualCostMicros: 20,
        settledAt: LATER,
      });
      expect(lateSettled.account.spentCostMicros).toBe(100);
      const firstPage = await budget.read({ parent: { kind: "run", runId: RUN_ID }, limit: 1 });
      expect(firstPage?.allocations.map(({ operationKey }) => operationKey)).toEqual([
        "model-call-1",
      ]);
      expect(firstPage?.nextOperationKey).toBe("model-call-1");
      expect(firstPage?.account.spentCostMicros).toBe(100);
      const secondPage = await budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 1,
        afterOperationKey: firstPage?.nextOperationKey ?? null,
      });
      expect(secondPage?.allocations.map(({ operationKey }) => operationKey)).toEqual([
        "model-call-after-settle",
      ]);
      expect(secondPage?.nextOperationKey).toBeNull();
      await resource.repository.close();
      const restarted = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(resource.databasePath),
        databasePath: resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      try {
        const restartedBudget = restarted.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
          leaseId: AUTHORITY_LEASE_ID,
          fencingToken: 1,
        });
        const restored = await restartedBudget.read({
          parent: { kind: "run", runId: RUN_ID },
          limit: 10,
        });
        expect(restored?.account.spentCostMicros).toBe(100);
        expect(restored?.allocations.map(({ operationKey }) => operationKey)).toEqual([
          "model-call-1",
          "model-call-after-settle",
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await resource.repository.close();
    }
  });

  it("composes model admission with the real authority, execution lease, and budget writer", async () => {
    const resource = await fixture();
    try {
      const dispatch = resource.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
        "model-admission-integration",
      );
      const claimed = await dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 0,
        executionLeaseId: EXECUTION_LEASE_ID,
        claimedAt: NOW,
        expiresAt: FAR_FUTURE,
      });
      const budget = resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      });
      const invocations = resource.repository.modelInvocationIdentityPort(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: 1 },
      );
      const descriptor: ModelInvocationAdmissionDescriptor = {
        ref: "approved-model-v1",
        provider: "fixture-provider",
        model: "fixture-model",
        version: "2026-09-05",
        routingClass: "primary",
        priority: 1,
        disclosure: "trusted_remote",
        capabilities: ["chat"],
        allowedDataClassifications: ["private"],
        secretRequirement: null,
        pricing: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
        estimatedCostMicros: 100,
      };
      const admission = new ModelInvocationAdmissionService({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        executionLease: claimFromRunExecutionLease(claimed),
        dispatch,
        invocations,
        clock: { now: () => NOW },
        limits: MODEL_LIMITS,
        registry: [descriptor],
      });

      const admitted = await admission.begin({
        modelRef: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        modelVersion: descriptor.version,
        dataClassification: "private",
        logicalSlot: "model-admission-integration-call",
        source: "model-port",
        ordinal: 1,
        estimatedCostMicros: descriptor.estimatedCostMicros,
        pricing: descriptor.pricing,
      });
      expect(admitted.disposition).toBe("fresh");
      if (admitted.disposition !== "fresh") throw new Error("Expected fresh model admission");
      const permit = admitted.permit;
      await permit.markStarted();
      await permit.settle({
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      });

      const snapshot = await budget.read({ parent: { kind: "run", runId: RUN_ID }, limit: 10 });
      expect(snapshot?.account).toMatchObject({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        parent: { kind: "run", runId: RUN_ID },
        spentCostMicros: 17,
      });
      expect(snapshot?.allocations).toEqual([
        expect.objectContaining({
          operationKey: admitted.identity.budgetOperationKey,
          modelRef: descriptor.ref,
          status: "settled",
          actualCostMicros: 17,
        }),
      ]);
    } finally {
      await resource.repository.close();
    }
  });
});

const INVOCATION_PRICING = Object.freeze({
  input: 1,
  output: 2,
  cacheRead: 0.5,
  cacheWrite: 0.25,
});

function identityInput(
  executionLease: ReturnType<typeof claimFromRunExecutionLease>,
  overrides: Partial<ModelInvocationIdentityBeginInput> = {},
): ModelInvocationIdentityBeginInput {
  return {
    runId: RUN_ID,
    modelRef: "identity-model-v1",
    provider: "fixture-provider",
    model: "fixture-model",
    modelVersion: "v1",
    dataClassification: "private",
    logicalSlot: "identity-slot-1",
    source: "agent-stream",
    ordinal: 1,
    estimatedCostMicros: 100,
    pricing: INVOCATION_PRICING,
    executionLease,
    authority: AUTHORITY,
    authorityLease: { leaseId: AUTHORITY_LEASE_ID, fencingToken: AUTHORITY.fencingToken },
    limits: MODEL_LIMITS,
    reservedAt: NOW,
    ...overrides,
  };
}

async function identityFixture() {
  const resource = await fixture();
  const dispatch = resource.repository.runDispatch(
    OWNER_ID,
    AGENT_ID,
    AUTHORITY,
    { leaseId: AUTHORITY_LEASE_ID, fencingToken: AUTHORITY.fencingToken },
    "model-identity-consumer",
  );
  const claimed = await dispatch.claim({
    runId: RUN_ID,
    expectedRunRevision: 1,
    expectedLeaseRevision: 0,
    executionLeaseId: EXECUTION_LEASE_ID,
    claimedAt: NOW,
    expiresAt: FAR_FUTURE,
  });
  return {
    resource,
    dispatch,
    claim: claimFromRunExecutionLease(claimed),
    identity: resource.repository.modelInvocationIdentityPort(OWNER_ID, AGENT_ID, AUTHORITY, {
      leaseId: AUTHORITY_LEASE_ID,
      fencingToken: AUTHORITY.fencingToken,
    }),
    budget: resource.repository.modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY, {
      leaseId: AUTHORITY_LEASE_ID,
      fencingToken: AUTHORITY.fencingToken,
    }),
  };
}

describe("SQLite durable model invocation identities", () => {
  it("revalidates current authority before replaying an identity", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");

      await fixtureState.resource.repository.close();
      const database = openQualifiedDatabase(fixtureState.resource.databasePath);
      database.prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?").run(DEPLOYMENT_ID);
      database.close();

      const restarted = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(fixtureState.resource.databasePath),
        databasePath: fixtureState.resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      try {
        const staleIdentity = restarted.modelInvocationIdentityPort(OWNER_ID, AGENT_ID, AUTHORITY, {
          leaseId: AUTHORITY_LEASE_ID,
          fencingToken: AUTHORITY.fencingToken,
        });
        await expect(staleIdentity.begin(identityInput(fixtureState.claim))).rejects.toMatchObject({
          code: "PORT_NOT_AUTHORITATIVE",
        });
        await expect(
          staleIdentity.releaseReserved({
            runId: RUN_ID,
            invocationId: first.identity.invocationId,
            budgetOperationKey: first.identity.budgetOperationKey,
            executionLease: fixtureState.claim,
            at: NOW,
          }),
        ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      } finally {
        await restarted.close();
      }
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("requires a held execution lease before begin replay or idempotent start", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");
      await fixtureState.identity.markStarted({
        runId: RUN_ID,
        invocationId: first.identity.invocationId,
        budgetOperationKey: first.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: NOW,
      });

      await fixtureState.resource.repository.close();
      const database = openQualifiedDatabase(fixtureState.resource.databasePath);
      database
        .prepare("UPDATE run_execution_leases SET expires_at = ? WHERE run_id = ?")
        .run(EXPIRED_LEASE_AT, RUN_ID);
      database.close();

      const restarted = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(fixtureState.resource.databasePath),
        databasePath: fixtureState.resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      try {
        const expiredIdentity = restarted.modelInvocationIdentityPort(
          OWNER_ID,
          AGENT_ID,
          AUTHORITY,
          { leaseId: AUTHORITY_LEASE_ID, fencingToken: AUTHORITY.fencingToken },
        );
        await expect(
          expiredIdentity.begin(identityInput(fixtureState.claim, { reservedAt: LATER })),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await expect(
          expiredIdentity.markStarted({
            runId: RUN_ID,
            invocationId: first.identity.invocationId,
            budgetOperationKey: first.identity.budgetOperationKey,
            executionLease: fixtureState.claim,
            at: LATER,
          }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await expect(
          expiredIdentity.settle({
            runId: RUN_ID,
            invocationId: first.identity.invocationId,
            budgetOperationKey: first.identity.budgetOperationKey,
            executionLease: fixtureState.claim,
            actualCostMicros: 100,
            at: LATER,
          }),
        ).resolves.toMatchObject({ status: "settled", actualCostMicros: 100 });
      } finally {
        await restarted.close();
      }
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("does not turn a replayed orphan budget allocation into a fresh identity", async () => {
    const fixtureState = await identityFixture();
    try {
      const input = identityInput(fixtureState.claim);
      const slotDigest = createHash("sha256").update(input.logicalSlot, "utf8").digest("hex");
      const orphanInvocationId = `model-invocation:${RUN_ID}:${slotDigest.slice(0, 32)}:1`;
      const orphanOperationKey = `model-invocation:${orphanInvocationId}`;
      await fixtureState.budget.reserve({
        parent: { kind: "run", runId: RUN_ID, executionLease: fixtureState.claim },
        operationKey: orphanOperationKey,
        modelRef: input.modelRef,
        dataClassification: input.dataClassification,
        estimatedCostMicros: input.estimatedCostMicros,
        limits: input.limits,
        reservedAt: input.reservedAt,
      });

      await expect(fixtureState.identity.begin(input)).resolves.toMatchObject({
        disposition: "blocked",
        reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
      });
      expect(
        await fixtureState.identity.read({ runId: RUN_ID, invocationId: orphanInvocationId }),
      ).toBeUndefined();
      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(snapshot?.allocations).toHaveLength(1);
      expect(snapshot?.allocations[0]).toMatchObject({
        operationKey: orphanOperationKey,
        status: "reserved",
      });
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("allocates one physical identity per logical slot and replays it after reopen", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      expect(first.disposition).toBe("fresh");
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");

      const replay = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      expect(replay).toMatchObject({
        disposition: "replay",
        identity: {
          invocationId: first.identity.invocationId,
          sequence: 1,
          status: "reserved",
        },
        reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
      });
      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(snapshot?.allocations).toHaveLength(1);

      await fixtureState.resource.repository.close();
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: path.dirname(fixtureState.resource.databasePath),
        databasePath: fixtureState.resource.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW,
      });
      try {
        const reopenedIdentity = reopened.modelInvocationIdentityPort(
          OWNER_ID,
          AGENT_ID,
          AUTHORITY,
          { leaseId: AUTHORITY_LEASE_ID, fencingToken: AUTHORITY.fencingToken },
        );
        await expect(
          reopenedIdentity.begin(identityInput(fixtureState.claim)),
        ).resolves.toMatchObject({
          disposition: "replay",
          identity: { invocationId: first.identity.invocationId, sequence: 1 },
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("creates a new sequence only after a reserved identity is durably released", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");
      const released = await fixtureState.identity.releaseReserved({
        runId: RUN_ID,
        invocationId: first.identity.invocationId,
        budgetOperationKey: first.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: NOW,
      });
      expect(released).toMatchObject({ status: "released", sequence: 1 });

      const second = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      expect(second.disposition).toBe("fresh");
      if (second.disposition !== "fresh") throw new Error("Expected a fresh second identity");
      expect(second.identity.sequence).toBe(2);
      expect(second.identity.invocationId).not.toBe(first.identity.invocationId);
      expect(second.identity.budgetOperationKey).not.toBe(first.identity.budgetOperationKey);

      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(
        snapshot?.allocations.map(({ operationKey, status }) => ({ operationKey, status })),
      ).toEqual([
        { operationKey: first.identity.budgetOperationKey, status: "released" },
        { operationKey: second.identity.budgetOperationKey, status: "reserved" },
      ]);
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("keeps a started identity in reconciliation across lease reclaim", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");
      await fixtureState.identity.markStarted({
        runId: RUN_ID,
        invocationId: first.identity.invocationId,
        budgetOperationKey: first.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: NOW,
      });
      await fixtureState.dispatch.release({
        runId: RUN_ID,
        expectedLeaseRevision: fixtureState.claim.expectedLeaseRevision,
        executionLeaseId: fixtureState.claim.executionLeaseId,
        releasedAt: LATER,
      });
      const reclaimedLease = await fixtureState.dispatch.claim({
        runId: RUN_ID,
        expectedRunRevision: 1,
        expectedLeaseRevision: 2,
        executionLeaseId: createRunExecutionLeaseId("execution-model-identity-reclaimed"),
        claimedAt: LATER,
        expiresAt: FAR_FUTURE,
      });
      const reclaimedIdentity = fixtureState.resource.repository.modelInvocationIdentityPort(
        OWNER_ID,
        AGENT_ID,
        AUTHORITY,
        { leaseId: AUTHORITY_LEASE_ID, fencingToken: AUTHORITY.fencingToken },
      );
      const replay = await reclaimedIdentity.begin(
        identityInput(claimFromRunExecutionLease(reclaimedLease)),
      );
      expect(replay).toMatchObject({
        disposition: "replay",
        identity: { invocationId: first.identity.invocationId, status: "started" },
        reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
      });
      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(snapshot?.allocations).toHaveLength(1);
      expect(snapshot?.allocations[0]?.status).toBe("started");
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("rejects semantic conflicts and preserves settled identity facts", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");
      await fixtureState.identity.markStarted({
        runId: RUN_ID,
        invocationId: first.identity.invocationId,
        budgetOperationKey: first.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: NOW,
      });
      const settled = await fixtureState.identity.settle({
        runId: RUN_ID,
        invocationId: first.identity.invocationId,
        budgetOperationKey: first.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        actualCostMicros: 17,
        at: LATER,
      });
      expect(settled).toMatchObject({ status: "settled", actualCostMicros: 17 });

      const replay = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      expect(replay).toMatchObject({ disposition: "replay", identity: { status: "settled" } });
      const conflict = await fixtureState.identity.begin(
        identityInput(fixtureState.claim, { model: "different-model" }),
      );
      expect(conflict).toMatchObject({
        disposition: "blocked",
        reasonCode: "MODEL_INVOCATION_IDENTITY_CONFLICT",
      });
      const unknownFirst = await fixtureState.identity.begin(
        identityInput(fixtureState.claim, { logicalSlot: "identity-slot-unknown" }),
      );
      if (unknownFirst.disposition !== "fresh") throw new Error("Expected an unknown identity");
      await fixtureState.identity.markStarted({
        runId: RUN_ID,
        invocationId: unknownFirst.identity.invocationId,
        budgetOperationKey: unknownFirst.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: NOW,
      });
      await fixtureState.identity.markUnknown({
        runId: RUN_ID,
        invocationId: unknownFirst.identity.invocationId,
        budgetOperationKey: unknownFirst.identity.budgetOperationKey,
        executionLease: fixtureState.claim,
        at: LATER,
        reasonCode: "transport_unresolved",
      });
      await expect(
        fixtureState.identity.begin(
          identityInput(fixtureState.claim, { logicalSlot: "identity-slot-unknown" }),
        ),
      ).resolves.toMatchObject({
        disposition: "replay",
        identity: { status: "unknown", invocationId: unknownFirst.identity.invocationId },
      });
      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(snapshot?.allocations).toHaveLength(2);
      expect(snapshot?.allocations[0]?.status).toBe("settled");
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("supports independent physical streams while preserving per-slot replay", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      const second = await fixtureState.identity.begin(
        identityInput(fixtureState.claim, { logicalSlot: "identity-slot-2", ordinal: 2 }),
      );
      expect(first.disposition).toBe("fresh");
      expect(second.disposition).toBe("fresh");
      if (first.disposition !== "fresh" || second.disposition !== "fresh") {
        throw new Error("Expected independent fresh identities");
      }
      expect(first.identity.sequence).toBe(1);
      expect(second.identity.sequence).toBe(1);
      expect(first.identity.invocationId).not.toBe(second.identity.invocationId);
      const replay = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      expect(replay).toMatchObject({
        disposition: "replay",
        identity: { invocationId: first.identity.invocationId },
      });
      const snapshot = await fixtureState.budget.read({
        parent: { kind: "run", runId: RUN_ID },
        limit: 10,
      });
      expect(snapshot?.allocations).toHaveLength(2);
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("rolls back the budget reservation when identity insertion fails", async () => {
    const fixtureState = await identityFixture();
    try {
      const database = openQualifiedDatabase(fixtureState.resource.databasePath);
      database.exec(
        `CREATE TRIGGER reject_model_identity_insert
         BEFORE INSERT ON model_invocation_identities
         WHEN NEW.logical_slot = 'identity-slot-rollback'
         BEGIN
           SELECT RAISE(ABORT, 'identity insert rejected by test');
         END`,
      );
      database.close();

      await expect(
        fixtureState.identity.begin(
          identityInput(fixtureState.claim, { logicalSlot: "identity-slot-rollback" }),
        ),
      ).rejects.toThrow("identity insert rejected by test");
      expect(
        await fixtureState.budget.read({ parent: { kind: "run", runId: RUN_ID }, limit: 10 }),
      ).toBeUndefined();

      const check = openQualifiedDatabase(fixtureState.resource.databasePath);
      try {
        expect(
          check
            .prepare(
              "SELECT COUNT(*) AS count FROM model_invocation_identities WHERE logical_slot = ?",
            )
            .get("identity-slot-rollback"),
        ).toEqual({ count: 0 });
        expect(
          check
            .prepare(
              "SELECT COUNT(*) AS count FROM model_budget_allocations WHERE operation_key LIKE 'model-invocation:%'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        check.close();
      }
    } finally {
      await fixtureState.resource.repository.close();
    }
  });

  it("enforces the identity authority and lifecycle SQL checks", async () => {
    const fixtureState = await identityFixture();
    try {
      const first = await fixtureState.identity.begin(identityInput(fixtureState.claim));
      if (first.disposition !== "fresh") throw new Error("Expected a fresh identity");
      await fixtureState.resource.repository.close();
      const database = openQualifiedDatabase(fixtureState.resource.databasePath);
      try {
        database
          .prepare(
            `INSERT INTO authority_leases (
              id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
              fencing_token, acquired_at, expires_at, released_at
            ) VALUES (?, ?, ?, ?, 'second-holder', 1, 2, ?, ?, NULL)`,
          )
          .run("lease-model-identity-other", OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW, FAR_FUTURE);
        expect(() =>
          database
            .prepare(
              "UPDATE model_invocation_identities SET authority_lease_id = ? WHERE invocation_id = ?",
            )
            .run("lease-model-identity-other", first.identity.invocationId),
        ).toThrow();
        expect(() =>
          database
            .prepare(
              `UPDATE model_invocation_identities
               SET status = 'unknown', reason_code = 'provider_unresolved',
                   observed_at = ?, started_at = NULL
               WHERE invocation_id = ?`,
            )
            .run(LATER, first.identity.invocationId),
        ).toThrow();
      } finally {
        database.close();
      }
    } finally {
      await fixtureState.resource.repository.close();
    }
  });
});

it("preserves populated model identities and allocations when rebuilding budget parents", async () => {
  const current = await identityFixture();
  const admitted = await current.identity.begin(identityInput(current.claim));
  if (admitted.disposition !== "fresh") throw new Error("IDENTITY_NOT_FRESH");
  await current.resource.repository.close();
  const database = openQualifiedDatabase(current.resource.databasePath);
  try {
    const tables = [
      "model_budget_accounts",
      "model_budget_allocations",
      "model_invocation_identities",
    ];
    const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
    const migration = (await loadBundledMigrations()).find(({ sequence }) => sequence === 25);
    if (!migration) throw new Error("MIGRATION_MISSING");
    database.transaction(() => database.exec(migration.sql))();
    expect(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }
});
