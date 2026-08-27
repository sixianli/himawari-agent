import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CapabilityExecutionHandleStorePort,
  CapabilityRegistryStorePort,
  ReliableEventRecord,
  ReliableEventSinkPort,
  SessionDeletionRecord,
} from "@himawari-agent/application";
import {
  createAgentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
  createSessionId,
} from "@himawari-agent/domain";
import type { StreamEvent } from "@himawari-agent/gateway-contracts";
import {
  SqliteProductStateRepository,
  SqliteReliableEventPublisher,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  attentionStatePortConformance,
  auditLedgerPortConformance,
  authorizationStorePortConformance,
  capabilityRegistryStorePortConformance,
  payloadStorePortConformance,
  reliableEventPortConformance,
  schedulerPortConformance,
  traceStorePortConformance,
} from "@himawari-agent/testing/conformance";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-conformance");
const AGENT_ID = createAgentId("agent-conformance");
const RUN_ID = createRunId("run-conformance");
const SESSION_ID = createSessionId("session-conformance");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

interface RepositoryResource {
  readonly repository: SqliteProductStateRepository;
  readonly stateRoot: string;
}

const resources = new WeakMap<object, RepositoryResource>();

async function seedRepository(databasePath: string): Promise<void> {
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
      ) VALUES ('deployment-conformance', ?, ?, 0, 'active', 1, 1)`,
    )
    .run(OWNER_ID, AGENT_ID);
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
      'active', ?, 'application/octet-stream')`,
  );
  for (const ref of [
    "payload-event-01",
    "payload-trigger-conformance",
    "payload-schedule-01",
    "payload-schedule-02",
    "payload-attention-state-01",
  ]) {
    insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
  }
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, created_at, updated_at
      ) VALUES ('thread-conformance', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-conformance', ?, ?, 'thread-conformance', 'fixture-trigger',
        'user_message', 'fixture', 'payload-trigger-conformance', 'fixture-proof', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'thread-conformance', ?, 'trigger-conformance', 0,
        'accepted', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, SESSION_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO turns (
        id, owner_id, agent_id, thread_id, session_id, run_id, turn_index
      ) VALUES ('turn-conformance', ?, ?, 'thread-conformance', ?, ?, 0)`,
    )
    .run(OWNER_ID, AGENT_ID, SESSION_ID, RUN_ID);
  database.close();
}

async function openRepository(now = T0): Promise<RepositoryResource> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-sqlite-durable-"));
  await seedRepository(path.join(stateRoot, "product.sqlite"));
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => now,
  });
  return { repository, stateRoot };
}

function tracked<TPort extends object>(resource: RepositoryResource, port: TPort): TPort {
  resources.set(port, resource);
  return port;
}

async function dispose(port: object): Promise<void> {
  const resource = resources.get(port);
  if (!resource) return;
  await resource.repository.close();
  await rm(resource.stateRoot, { recursive: true });
}

reliableEventPortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.reliableEventPort(OWNER_ID, AGENT_ID));
  },
  dispose,
});

traceStorePortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.traceStore());
  },
  dispose,
});

payloadStorePortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.payloadStore(OWNER_ID, AGENT_ID));
  },
  dispose,
});

auditLedgerPortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.auditLedger());
  },
  dispose,
});

authorizationStorePortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.authorizationStore());
  },
  dispose,
});

capabilityRegistryStorePortConformance({
  create: async () => {
    const resource = await openRepository();
    const port: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort =
      resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
    return tracked(resource, port);
  },
  dispose,
});

schedulerPortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.scheduler());
  },
  dispose,
});

attentionStatePortConformance({
  create: async () => {
    const resource = await openRepository();
    return tracked(resource, resource.repository.attentionState());
  },
  dispose,
});

describe("SQLite durable repository adapters", () => {
  it("persists deletion state across a repository restart", async () => {
    const resource = await openRepository();
    const record: SessionDeletionRecord = {
      id: "deletion-session-01",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      status: "pending",
      targets: {
        payload: { status: "pending", attempts: 0, lastErrorCode: null, verifiedAt: null },
        search: { status: "pending", attempts: 0, lastErrorCode: null, verifiedAt: null },
        cache: { status: "pending", attempts: 0, lastErrorCode: null, verifiedAt: null },
        archive: { status: "pending", attempts: 0, lastErrorCode: null, verifiedAt: null },
      },
      requestedAt: T0,
      updatedAt: T0,
    };
    await resource.repository.sessionDeletionState().create(record);
    await resource.repository.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => T1,
    });
    expect(await reopened.sessionDeletionState().get(record.id)).toEqual(record);
    expect((await reopened.startupRecovery()).pendingDeletionIds).toEqual([record.id]);
    await reopened.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("replays a stable outbox identity after sink success without an acknowledgement commit", async () => {
    const resource = await openRepository(T0);
    const eventPort = resource.repository.reliableEventPort(OWNER_ID, AGENT_ID);
    await eventPort.append({
      id: "event-replay-01",
      idempotencyKey: createIdempotencyKey("event-replay-01"),
      topic: "run.changed",
      payloadRef: "payload-event-01",
      occurredAt: T0,
    });
    const firstClaim = await resource.repository.reliableEventOutbox().claim({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      claimId: "claim-before-crash",
      claimedAt: T0,
      expiresAt: T1,
      limit: 10,
    });
    const observed: string[] = [firstClaim[0]?.event.id ?? "missing"];
    await resource.repository.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => T2,
    });
    expect((await reopened.startupRecovery()).recoveredExpiredClaimIds).toEqual([
      "event-replay-01",
    ]);
    const sink: ReliableEventSinkPort = {
      publish: async (event: ReliableEventRecord) => {
        observed.push(event.id);
        return { eventId: event.id, outcome: "duplicate" };
      },
    };
    const publisher = new SqliteReliableEventPublisher({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      outbox: reopened.reliableEventOutbox(),
      sink,
      claimId: () => "claim-after-restart",
      now: () => T2,
    });
    expect((await publisher.publishBatch(10)).map(({ id }) => id)).toEqual(["event-replay-01"]);
    expect(observed).toEqual(["event-replay-01", "event-replay-01"]);
    const deduplicator = reopened.reliableEventConsumerDeduplicator();
    expect(
      await deduplicator.consumeOnce({
        consumerId: "projection-a",
        eventId: "event-replay-01",
        processedAt: T2,
      }),
    ).toBe(true);
    expect(
      await deduplicator.consumeOnce({
        consumerId: "projection-a",
        eventId: "event-replay-01",
        processedAt: T2,
      }),
    ).toBe(false);
    await reopened.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("reopens interrupted delivery work and reports other safe startup work", async () => {
    const resource = await openRepository(T0);
    const attention = resource.repository.attentionState();
    const record = {
      candidateId: "attention-recovery-01",
      candidateFingerprint: "fingerprint-recovery-01",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      duplicateKey: "recovery-01",
      decision: {
        candidateId: "attention-recovery-01",
        level: "NOTIFY" as const,
        reasonCode: "recovery_test",
        interruptAuthorizationRef: null,
      },
      deliveryRequestId: "delivery-recovery-01",
      decidedAt: T0,
    };
    const delivery = {
      id: "delivery-recovery-01",
      candidateId: record.candidateId,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      resultRef: "payload-attention-state-01",
      dataClassification: "private" as const,
      level: "NOTIFY" as const,
      status: "pending" as const,
      assignedClientId: null,
      attempts: 0,
      acknowledgementRef: null,
      lastErrorCode: null,
      createdAt: T0,
      updatedAt: T0,
    };
    await attention.commitDecision({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      expectedRevision: 0,
      record,
      delivery,
    });
    await attention.claimDelivery(delivery.id, "client-before-restart", T1);
    await resource.repository.authorizationStore().createApproval({
      id: "approval-recovery-01",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      intentId: "intent-recovery-01",
      intentSnapshot: {
        id: "intent-recovery-01",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        capabilityRef: "restaurant-search",
        operation: "search",
        resourceRef: "city:tokyo",
        dataClassification: "private",
        sideEffect: "none",
        estimatedCostMicros: 1,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey("intent-recovery-01"),
        reversible: true,
        requestedAt: T0,
      },
      semanticSnapshotHash: "intent-recovery-hash",
      status: "pending",
      deliveryState: "queued_no_ui",
      requestedAt: T0,
      expiresAt: "2999-12-31T23:59:59.999Z",
      decidedAt: null,
      grantId: null,
    });
    await resource.repository.scheduler().upsert(
      {
        id: "job-recovery-01",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: null,
        payloadRef: "payload-schedule-01",
        sourceProofRef: "proof-recovery-01",
        dataClassification: "private",
        authorizationRef: "grant-recovery-01",
        taskScopeRef: "scope-recovery-01",
        capabilityRef: "restaurant-monitor",
        operation: "scan",
        resourceRef: "restaurant:recovery",
        sideEffect: "none",
        estimatedCostMicros: 1,
        intervalMs: 60_000,
        minimumIntervalMs: 60_000,
        expiresAt: "2999-12-31T23:59:59.999Z",
        revokedAt: null,
        nextRunAt: T2,
        occurrence: 0,
        status: "active",
      },
      null,
    );
    await resource.repository.close();

    const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
    database
      .prepare(
        `INSERT INTO job_occurrences (
          id, job_id, owner_id, agent_id, stable_key, status, deployment_id,
          authority_epoch, fencing_token, attempt_count, deadline_at
        ) VALUES ('occurrence-recovery-01', 'job-recovery-01', ?, ?, 'stable-recovery-01',
          'retry_wait', 'deployment-conformance', 1, 1, 1, '2999-12-31T23:59:59.999Z')`,
      )
      .run(OWNER_ID, AGENT_ID);
    database.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => T2,
    });
    const recovery = await reopened.startupRecovery();
    expect(recovery.unfinishedRunKeys).toContain(RUN_ID);
    expect(recovery.pendingApprovalRequestIds).toEqual(["approval-recovery-01"]);
    expect(recovery.recoveredDeliveryRequestIds).toEqual([delivery.id]);
    expect(recovery.pendingDeliveryRequestIds).toEqual([delivery.id]);
    expect(recovery.retryableJobOccurrenceIds).toEqual(["occurrence-recovery-01"]);
    expect(await reopened.attentionState().readDelivery(delivery.id)).toMatchObject({
      status: "pending",
      assignedClientId: null,
      lastErrorCode: "PROCESS_RESTARTED",
    });
    await reopened.close();
    await rm(resource.stateRoot, { recursive: true });
  });

  it("enforces scoped snapshots, persistent cursors and a retention watermark", async () => {
    const resource = await openRepository();
    const readModel = resource.repository.gatewayReadModel();
    const envelope = {
      schemaVersion: "gateway.v1" as const,
      messageId: "message-thread-snapshot",
      correlationId: "correlation-read-model",
      causationId: null,
      dataClassification: "private" as const,
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      actor: { actorType: "system" as const, actorId: "projection" },
    };
    const threadSnapshot = {
      ...envelope,
      kind: "snapshot" as const,
      type: "thread.snapshot" as const,
      payload: {
        threadId: "thread-conformance",
        status: "open" as const,
        revision: 1,
        sessionIds: [SESSION_ID],
        runIds: [RUN_ID],
      },
    };
    await readModel.upsertThreadSnapshot(threadSnapshot);
    expect(
      await readModel.getThreadSnapshot({
        ...envelope,
        kind: "query",
        type: "thread.get_snapshot",
        payload: { threadId: "thread-conformance" },
      }),
    ).toEqual(threadSnapshot);
    await expect(
      readModel.getThreadSnapshot({
        ...envelope,
        scope: { ownerId: "owner-other", agentId: AGENT_ID },
        kind: "query",
        type: "thread.get_snapshot",
        payload: { threadId: "thread-conformance" },
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    await expect(
      readModel.upsertThreadSnapshot({
        ...threadSnapshot,
        payload: { ...threadSnapshot.payload, status: "closed" },
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    const runSnapshot = {
      ...envelope,
      kind: "snapshot" as const,
      type: "run.snapshot" as const,
      messageId: "message-run-snapshot",
      payload: {
        runId: RUN_ID,
        threadId: "thread-conformance",
        sessionId: SESSION_ID,
        triggerId: "trigger-conformance",
        status: "running" as const,
        revision: 1,
        latestSequence: 0,
        activeApprovalRequestId: null,
      },
    };
    await readModel.upsertRunSnapshot(runSnapshot);
    expect(
      await readModel.getRunSnapshot({
        ...envelope,
        kind: "query",
        type: "run.get_snapshot",
        payload: { runId: RUN_ID },
      }),
    ).toEqual(runSnapshot);

    const event = (cursor: string, sequence: number): StreamEvent => ({
      ...envelope,
      kind: "event",
      type: "stream.event",
      messageId: `message-${cursor}`,
      payload: {
        cursor,
        sessionId: SESSION_ID,
        threadId: "thread-conformance",
        runId: RUN_ID,
        turnId: null,
        parentEventId: null,
        sequence,
        occurredAt: T0,
        recordedAt: T0,
        eventType: "run.changed",
        payloadRef: null,
      },
    });
    await readModel.appendEvent(event("cursor-01", 1));
    await readModel.appendEvent(event("cursor-02", 2));
    expect(
      await readModel.queryTrace({
        ...envelope,
        kind: "query",
        type: "trace.query",
        payload: { sessionId: SESSION_ID, runId: RUN_ID, afterSequence: 0, limit: 10 },
      }),
    ).toHaveLength(2);
    await readModel.setRetentionWatermark(2, T1);
    await expect(
      (async () => {
        for await (const _item of readModel.subscribe({
          ...envelope,
          kind: "subscription",
          type: "events.subscribe",
          payload: {
            subscriptionId: "subscription-expired",
            sessionId: null,
            threadId: null,
            runId: null,
            afterCursor: "cursor-01",
          },
        })) {
          // Exhaust the subscription so cursor validation runs.
        }
      })(),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    const subscription = {
      ...envelope,
      kind: "subscription" as const,
      type: "events.subscribe" as const,
      payload: {
        subscriptionId: "subscription-01",
        sessionId: SESSION_ID,
        threadId: null,
        runId: null,
        afterCursor: null,
      },
    };
    const retained = [];
    for await (const item of readModel.subscribe(subscription)) retained.push(item.payload.cursor);
    expect(retained).toEqual(["cursor-02"]);

    const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
    database.prepare("UPDATE threads SET status = 'trashed' WHERE id = 'thread-conformance'").run();
    database.close();
    await expect(
      readModel.getThreadSnapshot({
        ...envelope,
        kind: "query",
        type: "thread.get_snapshot",
        payload: { threadId: "thread-conformance" },
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    await expect(
      readModel.getRunSnapshot({
        ...envelope,
        kind: "query",
        type: "run.get_snapshot",
        payload: { runId: RUN_ID },
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    expect(
      await readModel.queryTrace({
        ...envelope,
        kind: "query",
        type: "trace.query",
        payload: { sessionId: SESSION_ID, runId: RUN_ID, afterSequence: 0, limit: 10 },
      }),
    ).toEqual([]);
    const hidden = [];
    for await (const item of readModel.subscribe(subscription)) hidden.push(item.payload.cursor);
    expect(hidden).toEqual([]);

    await resource.repository.close();
    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => T2,
    });
    expect((await reopened.gatewayReadModel().metadata()).retentionWatermark).toBe(2);
    await reopened.close();
    await rm(resource.stateRoot, { recursive: true });
  });
});
