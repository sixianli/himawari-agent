import type {
  ApprovalRequest,
  AttentionDecisionCommit,
  AttentionDecisionCommitResult,
  AttentionPolicyState,
  AuditRecord,
  CapabilityExecutionHandle,
  CapabilityRegistryRecord,
  ConsumeGrantInput,
  DeliveryClaim,
  DeliveryRequest,
  DeliverySettlement,
  GrantRecord,
  PayloadRecord,
  ReliableEvent,
  ReliableEventRecord,
  ResolveApprovalInput,
  ScheduledJob,
  ScheduledJobWrite,
  SessionDeletionRecord,
  TraceEvent,
} from "@himawari-agent/application";
import type {
  EventSubscription,
  GetRunSnapshotQuery,
  GetThreadSnapshotQuery,
  RunSnapshot,
  StreamEvent,
  ThreadSnapshot,
  TraceQuery,
} from "@himawari-agent/gateway-contracts";
import type Database from "better-sqlite3";

export type SqliteApplicationFailure = (
  code: string,
  message: string,
  details?: Readonly<Record<string, string>>,
) => never;

export interface ReliableEventClaim {
  readonly claimId: string;
  readonly expiresAt: string;
  readonly event: ReliableEventRecord;
}

export interface SqliteStartupRecovery {
  readonly pendingEventIds: readonly string[];
  readonly recoveredExpiredClaimIds: readonly string[];
  readonly unfinishedRunKeys: readonly string[];
  readonly pendingApprovalRequestIds: readonly string[];
  readonly recoveredDeliveryRequestIds: readonly string[];
  readonly pendingDeliveryRequestIds: readonly string[];
  readonly pendingDeletionIds: readonly string[];
  readonly retryableJobOccurrenceIds: readonly string[];
}

export interface GatewayProjectionMetadata {
  readonly retentionWatermark: number;
  readonly latestCursorSequence: number;
}

interface JsonRow {
  readonly recordJson: string;
}

interface EventRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payloadRef: string;
  readonly occurredAt: string;
  readonly publishedAt: string | null;
}

function parseRecord<TRecord>(row: JsonRow | undefined): TRecord | undefined {
  return row ? (JSON.parse(row.recordJson) as TRecord) : undefined;
}

function parseRecords<TRecord>(rows: readonly JsonRow[]): readonly TRecord[] {
  return rows.map((row) => JSON.parse(row.recordJson) as TRecord);
}

function eventFromRow(row: EventRow): ReliableEventRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey as ReliableEventRecord["idempotencyKey"],
    topic: row.topic,
    payloadRef: row.payloadRef,
    occurredAt: row.occurredAt,
    publishedAt: row.publishedAt,
  };
}

function assertLimit(limit: number, fail: SqliteApplicationFailure): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    fail("PORT_INVALID_OPERATION", "Query limit must be between 0 and 1000", {
      limit: String(limit),
    });
  }
}

function grantStatus(record: GrantRecord): "active" | "revoked" | "expired" | "consumed" {
  if (record.revokedAt !== null) return "revoked";
  if (record.uses >= record.maxUses || record.spentCostMicros >= record.maxTotalCostMicros) {
    return "consumed";
  }
  return "active";
}

function capabilityStatus(
  lifecycle: CapabilityRegistryRecord["lifecycle"],
):
  | "discovered"
  | "installation_proposed"
  | "installation_approved"
  | "active"
  | "disabled"
  | "uninstalled" {
  if (lifecycle === "update_proposed") return "installation_proposed";
  if (lifecycle === "update_approved") return "installation_approved";
  return lifecycle;
}

export class SqliteDurableOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "event.append":
        return this.appendEvent(
          payload as { ownerId: string; agentId: string; event: ReliableEvent },
        );
      case "event.listPending":
        return this.listPendingEvents(
          payload as { ownerId: string; agentId: string; limit: number },
        );
      case "event.markPublished":
        return this.markEventPublished(
          payload as {
            ownerId: string;
            agentId: string;
            eventId: string;
            publishedAt: string;
          },
        );
      case "event.claim":
        return this.claimEvents(
          payload as {
            ownerId: string;
            agentId: string;
            claimId: string;
            claimedAt: string;
            expiresAt: string;
            limit: number;
          },
        );
      case "event.acknowledge":
        return this.acknowledgeEvent(
          payload as {
            eventId: string;
            claimId: string;
            publishedAt: string;
            acknowledgementRef: string;
          },
        );
      case "event.consumeOnce":
        return this.consumeEventOnce(
          payload as { consumerId: string; eventId: string; processedAt: string },
        );
      case "trace.append":
        return this.appendTrace((payload as { event: TraceEvent }).event);
      case "trace.readRun":
        return this.readTraceRun(
          payload as { runId: string; afterSequence: number; limit: number },
        );
      case "trace.readSession":
        return this.readTraceSession(
          payload as { sessionId: string; afterRecordedAt: string | null; limit: number },
        );
      case "payload.put":
        return this.putPayload(
          payload as { ownerId: string; agentId: string; payload: PayloadRecord },
        );
      case "payload.get":
        return this.getPayload(payload as { ownerId: string; agentId: string; ref: string });
      case "payload.delete":
        return this.deletePayload(payload as { ownerId: string; agentId: string; ref: string });
      case "audit.append":
        return this.appendAudit((payload as { record: AuditRecord }).record);
      case "audit.listByAgent":
        return this.listAudit(payload as { agentId: string; afterId: string | null });
      case "authorization.createApproval":
        return this.createApproval((payload as { request: ApprovalRequest }).request);
      case "authorization.findApprovalByIntent":
        return this.findApprovalByIntent((payload as { intentId: string }).intentId);
      case "authorization.getApproval":
        return this.getApproval((payload as { approvalRequestId: string }).approvalRequestId);
      case "authorization.resolveApproval":
        return this.resolveApproval((payload as { input: ResolveApprovalInput }).input);
      case "authorization.listGrants":
        return this.listGrants(payload as { ownerId: string; agentId: string });
      case "authorization.consumeGrant":
        return this.consumeGrant((payload as { input: ConsumeGrantInput }).input);
      case "authorization.revokeGrant":
        return this.revokeGrant(
          payload as { grantId: string; revokedAt: string; reasonCode: string },
        );
      case "capability.create":
        return this.createCapability(
          payload as { ownerId: string; agentId: string; record: CapabilityRegistryRecord },
        );
      case "capability.get":
        return this.getCapability(
          payload as { ownerId: string; agentId: string; capabilityRef: string },
        );
      case "capability.list":
        return this.listCapabilities(payload as { ownerId: string; agentId: string });
      case "capability.save":
        return this.saveCapability(
          payload as {
            ownerId: string;
            agentId: string;
            record: CapabilityRegistryRecord;
            expectedRevision: number;
          },
        );
      case "capability.createHandle":
        return this.createCapabilityHandle(
          (payload as { handle: CapabilityExecutionHandle }).handle,
        );
      case "capability.getHandle":
        return this.getCapabilityHandle(
          payload as { ownerId: string; agentId: string; handleRef: string },
        );
      case "capability.revokeHandle":
        return this.revokeCapabilityHandle(
          payload as { ownerId: string; agentId: string; handleRef: string; revokedAt: string },
        );
      case "scheduler.read":
        return this.readJob((payload as { jobId: string }).jobId);
      case "scheduler.upsert":
        return this.upsertJob(
          payload as { job: ScheduledJobWrite; expectedRevision: number | null },
        );
      case "scheduler.listDue":
        return this.listDue(payload as { at: string; limit: number });
      case "scheduler.cancel":
        return this.cancelJob(payload as { jobId: string; expectedRevision: number });
      case "attention.readPolicy":
        return this.readAttentionPolicy(payload as { ownerId: string; agentId: string });
      case "attention.commitDecision":
        return this.commitAttentionDecision((payload as { input: AttentionDecisionCommit }).input);
      case "attention.readDelivery":
        return this.readDelivery((payload as { requestId: string }).requestId);
      case "attention.claimDelivery":
        return this.claimDelivery(
          payload as { requestId: string; clientId: string; claimedAt: string },
        );
      case "attention.settleDelivery":
        return this.settleDelivery((payload as { input: DeliverySettlement }).input);
      case "deletion.create":
        return this.createDeletion((payload as { record: SessionDeletionRecord }).record);
      case "deletion.get":
        return this.getDeletion((payload as { deletionId: string }).deletionId);
      case "deletion.save":
        return this.saveDeletion(
          payload as { record: SessionDeletionRecord; expectedRevision: number },
        );
      case "gateway.upsertThread":
        return this.upsertThreadSnapshot((payload as { snapshot: ThreadSnapshot }).snapshot);
      case "gateway.upsertRun":
        return this.upsertRunSnapshot((payload as { snapshot: RunSnapshot }).snapshot);
      case "gateway.appendEvent":
        return this.appendGatewayEvent((payload as { event: StreamEvent }).event);
      case "gateway.getThread":
        return this.getThreadSnapshot((payload as { query: GetThreadSnapshotQuery }).query);
      case "gateway.getRun":
        return this.getRunSnapshot((payload as { query: GetRunSnapshotQuery }).query);
      case "gateway.queryTrace":
        return this.queryGatewayTrace((payload as { query: TraceQuery }).query);
      case "gateway.subscribe":
        return this.gatewaySubscription(
          (payload as { subscription: EventSubscription }).subscription,
        );
      case "gateway.setRetentionWatermark":
        return this.setRetentionWatermark(payload as { sequence: number; updatedAt: string });
      case "gateway.metadata":
        return this.gatewayMetadata();
      case "recovery.inspect":
        return this.recoverySnapshot();
      default:
        throw new Error(`Unknown durable SQLite operation ${operation}`);
    }
  }

  recoverStartup(now: string): SqliteStartupRecovery {
    const transaction = this.database.transaction(() => {
      const expiredClaims = this.database
        .prepare(
          `SELECT id FROM reliable_events
          WHERE publication_state = 'claimed' AND claim_expires_at <= ? ORDER BY id`,
        )
        .all(now) as Array<{ readonly id: string }>;
      this.database
        .prepare(
          `UPDATE reliable_events SET publication_state = 'pending', claim_id = NULL,
            claim_expires_at = NULL
          WHERE publication_state = 'claimed' AND claim_expires_at <= ?`,
        )
        .run(now);
      const recoveredDeliveries = this.database
        .prepare("SELECT id FROM inbox_deliveries WHERE status = 'delivering' ORDER BY id")
        .all() as Array<{ readonly id: string }>;
      for (const { id } of recoveredDeliveries) {
        const current = this.readDelivery(id);
        if (!current) continue;
        const recovered: DeliveryRequest = {
          ...current,
          revision: current.revision + 1,
          status: "pending",
          assignedClientId: null,
          lastErrorCode: "PROCESS_RESTARTED",
          updatedAt: now,
        };
        this.database
          .prepare(
            `UPDATE inbox_deliveries SET revision = ?, status = 'pending', updated_at = ?,
              record_json = ? WHERE id = ?`,
          )
          .run(recovered.revision, now, JSON.stringify(recovered), id);
      }
      return {
        pendingEventIds: this.idList(
          "SELECT id FROM reliable_events WHERE published_at IS NULL ORDER BY occurred_at, id",
        ),
        recoveredExpiredClaimIds: expiredClaims.map(({ id }) => id),
        unfinishedRunKeys: this.unfinishedRunKeys(),
        pendingApprovalRequestIds: this.idList(
          "SELECT id FROM approval_requests WHERE status = 'pending' ORDER BY requested_at, id",
        ),
        recoveredDeliveryRequestIds: recoveredDeliveries.map(({ id }) => id),
        pendingDeliveryRequestIds: this.idList(
          "SELECT id FROM inbox_deliveries WHERE status = 'pending' ORDER BY created_at, id",
        ),
        pendingDeletionIds: this.idList(
          "SELECT id FROM deletion_tombstones WHERE status IN ('pending', 'incomplete') ORDER BY requested_at, id",
        ),
        retryableJobOccurrenceIds: this.idList(
          "SELECT id FROM job_occurrences WHERE status IN ('queued', 'retry_wait') ORDER BY id",
        ),
      } satisfies SqliteStartupRecovery;
    });
    return transaction.immediate();
  }

  private idList(sql: string): readonly string[] {
    return (this.database.prepare(sql).all() as Array<{ readonly id: string }>).map(({ id }) => id);
  }

  private assertPayloadScope(ref: string, ownerId: string, agentId: string): void {
    const owned = this.database
      .prepare("SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
      .get(ref, ownerId, agentId);
    if (!owned) {
      this.fail("PORT_INVALID_OPERATION", `Payload ${ref} is outside the requested scope`, {
        payloadRef: ref,
      });
    }
  }

  private assertRunScope(runId: string, ownerId: string, agentId: string): void {
    const owned = this.database
      .prepare("SELECT 1 FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(runId, ownerId, agentId);
    if (!owned) {
      this.fail("PORT_INVALID_OPERATION", `Run ${runId} is outside the requested scope`, {
        runId,
      });
    }
  }

  private unfinishedRunKeys(): readonly string[] {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const stateKeys = (
      this.database
        .prepare("SELECT key, value_json AS valueJson FROM product_state_records ORDER BY key")
        .all() as Array<{ readonly key: string; readonly valueJson: string }>
    )
      .filter(({ valueJson }) => {
        const value = JSON.parse(valueJson) as { readonly status?: unknown };
        return typeof value.status === "string" && !terminal.has(value.status);
      })
      .map(({ key }) => key);
    const runIds = this.idList(
      `SELECT id FROM runs
      WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id`,
    );
    return [...new Set([...stateKeys, ...runIds])].sort();
  }

  private recoverySnapshot(): SqliteStartupRecovery {
    return {
      pendingEventIds: this.idList(
        "SELECT id FROM reliable_events WHERE published_at IS NULL ORDER BY occurred_at, id",
      ),
      recoveredExpiredClaimIds: [],
      unfinishedRunKeys: this.unfinishedRunKeys(),
      pendingApprovalRequestIds: this.idList(
        "SELECT id FROM approval_requests WHERE status = 'pending' ORDER BY requested_at, id",
      ),
      recoveredDeliveryRequestIds: [],
      pendingDeliveryRequestIds: this.idList(
        "SELECT id FROM inbox_deliveries WHERE status = 'pending' ORDER BY created_at, id",
      ),
      pendingDeletionIds: this.idList(
        "SELECT id FROM deletion_tombstones WHERE status IN ('pending', 'incomplete') ORDER BY requested_at, id",
      ),
      retryableJobOccurrenceIds: this.idList(
        "SELECT id FROM job_occurrences WHERE status IN ('queued', 'retry_wait') ORDER BY id",
      ),
    };
  }

  private appendEvent(input: {
    ownerId: string;
    agentId: string;
    event: ReliableEvent;
  }): ReliableEventRecord {
    this.assertDiskHeadroom();
    this.assertPayloadScope(input.event.payloadRef, input.ownerId, input.agentId);
    const existing = this.database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
          occurred_at AS occurredAt, published_at AS publishedAt
        FROM reliable_events WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.event.id, input.ownerId, input.agentId) as EventRow | undefined;
    if (existing) {
      const record = eventFromRow(existing);
      if (
        record.idempotencyKey === input.event.idempotencyKey &&
        record.topic === input.event.topic &&
        record.payloadRef === input.event.payloadRef &&
        record.occurredAt === input.event.occurredAt
      ) {
        return record;
      }
      this.fail("PORT_CONFLICT", `Reliable event ${input.event.id} has different content`, {
        eventId: input.event.id,
      });
    }
    this.database
      .prepare(
        `INSERT INTO reliable_events (
          id, owner_id, agent_id, idempotency_key, topic, payload_ref,
          publication_state, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.event.id,
        input.ownerId,
        input.agentId,
        input.event.idempotencyKey,
        input.event.topic,
        input.event.payloadRef,
        input.event.occurredAt,
      );
    return { ...input.event, publishedAt: null };
  }

  private listPendingEvents(input: {
    ownerId: string;
    agentId: string;
    limit: number;
  }): readonly ReliableEventRecord[] {
    assertLimit(input.limit, this.fail);
    return (
      this.database
        .prepare(
          `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
            occurred_at AS occurredAt, published_at AS publishedAt
          FROM reliable_events
          WHERE owner_id = ? AND agent_id = ? AND published_at IS NULL
          ORDER BY occurred_at, id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, input.limit) as EventRow[]
    ).map(eventFromRow);
  }

  private markEventPublished(input: {
    ownerId: string;
    agentId: string;
    eventId: string;
    publishedAt: string;
  }): ReliableEventRecord {
    this.assertDiskHeadroom();
    const row = this.database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
          occurred_at AS occurredAt, published_at AS publishedAt
        FROM reliable_events WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.eventId, input.ownerId, input.agentId) as EventRow | undefined;
    if (!row) this.fail("PORT_NOT_FOUND", `Reliable event ${input.eventId} not found`);
    if (row.publishedAt !== null) return eventFromRow(row);
    this.database
      .prepare(
        `UPDATE reliable_events SET publication_state = 'published', published_at = ?,
          claim_id = NULL, claim_expires_at = NULL WHERE id = ?`,
      )
      .run(input.publishedAt, input.eventId);
    return eventFromRow({ ...row, publishedAt: input.publishedAt });
  }

  private claimEvents(input: {
    ownerId: string;
    agentId: string;
    claimId: string;
    claimedAt: string;
    expiresAt: string;
    limit: number;
  }): readonly ReliableEventClaim[] {
    assertLimit(input.limit, this.fail);
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE reliable_events SET publication_state = 'pending', claim_id = NULL,
            claim_expires_at = NULL
          WHERE publication_state = 'claimed' AND claim_expires_at <= ?`,
        )
        .run(input.claimedAt);
      const rows = this.database
        .prepare(
          `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
            occurred_at AS occurredAt, published_at AS publishedAt
          FROM reliable_events
          WHERE owner_id = ? AND agent_id = ? AND publication_state = 'pending'
          ORDER BY occurred_at, id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, input.limit) as EventRow[];
      const claim = this.database.prepare(
        `UPDATE reliable_events SET publication_state = 'claimed', claim_id = ?, claim_expires_at = ?
        WHERE id = ? AND publication_state = 'pending'`,
      );
      for (const row of rows) claim.run(input.claimId, input.expiresAt, row.id);
      return rows.map((row) => ({
        claimId: input.claimId,
        expiresAt: input.expiresAt,
        event: eventFromRow(row),
      }));
    });
    return transaction.immediate();
  }

  private acknowledgeEvent(input: {
    eventId: string;
    claimId: string;
    publishedAt: string;
    acknowledgementRef: string;
  }): ReliableEventRecord {
    this.assertDiskHeadroom();
    const row = this.database
      .prepare(
        `SELECT id, idempotency_key AS idempotencyKey, topic, payload_ref AS payloadRef,
          occurred_at AS occurredAt, published_at AS publishedAt
        FROM reliable_events WHERE id = ?`,
      )
      .get(input.eventId) as EventRow | undefined;
    if (!row) this.fail("PORT_NOT_FOUND", `Reliable event ${input.eventId} not found`);
    if (row.publishedAt !== null) return eventFromRow(row);
    const result = this.database
      .prepare(
        `UPDATE reliable_events SET publication_state = 'published', published_at = ?,
          acknowledgement_ref = ?, claim_id = NULL, claim_expires_at = NULL
        WHERE id = ? AND publication_state = 'claimed' AND claim_id = ?
          AND claim_expires_at > ?`,
      )
      .run(
        input.publishedAt,
        input.acknowledgementRef,
        input.eventId,
        input.claimId,
        input.publishedAt,
      );
    if (result.changes !== 1) {
      this.fail("PORT_CONFLICT", `Reliable event ${input.eventId} is not owned by this claim`, {
        eventId: input.eventId,
        claimId: input.claimId,
      });
    }
    return eventFromRow({ ...row, publishedAt: input.publishedAt });
  }

  private consumeEventOnce(input: {
    consumerId: string;
    eventId: string;
    processedAt: string;
  }): boolean {
    this.assertDiskHeadroom();
    const result = this.database
      .prepare(
        `INSERT INTO reliable_event_consumptions (consumer_id, event_id, processed_at)
        VALUES (?, ?, ?) ON CONFLICT(consumer_id, event_id) DO NOTHING`,
      )
      .run(input.consumerId, input.eventId, input.processedAt);
    return result.changes === 1;
  }

  private appendTrace(event: TraceEvent): void {
    this.assertDiskHeadroom();
    this.assertRunScope(event.runId, event.ownerId, event.agentId);
    if (event.payloadRef !== null) {
      this.assertPayloadScope(event.payloadRef, event.ownerId, event.agentId);
    }
    if (
      event.turnId !== null &&
      !this.database
        .prepare("SELECT 1 FROM turns WHERE id = ? AND run_id = ?")
        .get(event.turnId, event.runId)
    ) {
      this.fail("PORT_INVALID_OPERATION", `Turn ${event.turnId} is outside Run ${event.runId}`);
    }
    const transaction = this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM trace_events WHERE id = ?").get(event.id)) {
        this.fail("PORT_DUPLICATE", `Trace event ${event.id} already exists`, {
          eventId: event.id,
        });
      }
      const prior = this.database
        .prepare(
          `SELECT record_json AS recordJson FROM trace_events
          WHERE run_id = ? ORDER BY sequence`,
        )
        .all(event.runId) as JsonRow[];
      const records = parseRecords<TraceEvent>(prior);
      const expectedSequence = records.length + 1;
      if (event.sequence !== expectedSequence) {
        this.fail("PORT_INVALID_OPERATION", `Trace event ${event.id} has an invalid sequence`, {
          expectedSequence: String(expectedSequence),
          sequence: String(event.sequence),
        });
      }
      const first = records[0];
      if (
        first &&
        (first.ownerId !== event.ownerId ||
          first.agentId !== event.agentId ||
          first.sessionId !== event.sessionId ||
          first.threadId !== event.threadId ||
          first.correlationId !== event.correlationId)
      ) {
        this.fail("PORT_INVALID_OPERATION", `Trace event ${event.id} is outside its Run scope`);
      }
      if (event.parentEventId !== null && !records.some(({ id }) => id === event.parentEventId)) {
        this.fail(
          "PORT_INVALID_OPERATION",
          `Trace parent ${event.parentEventId} is outside its Run`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO trace_events (
            id, owner_id, agent_id, session_id, thread_id, run_id, turn_id, sequence,
            event_type, classification, payload_ref, occurred_at, recorded_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.ownerId,
          event.agentId,
          event.sessionId,
          event.threadId,
          event.runId,
          event.turnId,
          event.sequence,
          event.eventType,
          event.dataClassification,
          event.payloadRef,
          event.occurredAt,
          event.recordedAt,
          JSON.stringify(event),
        );
    });
    transaction.immediate();
  }

  private readTraceRun(input: {
    runId: string;
    afterSequence: number;
    limit: number;
  }): readonly TraceEvent[] {
    assertLimit(input.limit, this.fail);
    return parseRecords<TraceEvent>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM trace_events
          WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        )
        .all(input.runId, input.afterSequence, input.limit) as JsonRow[],
    );
  }

  private readTraceSession(input: {
    sessionId: string;
    afterRecordedAt: string | null;
    limit: number;
  }): readonly TraceEvent[] {
    assertLimit(input.limit, this.fail);
    return parseRecords<TraceEvent>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM trace_events
          WHERE session_id = ? AND (? IS NULL OR recorded_at > ?)
          ORDER BY recorded_at, id LIMIT ?`,
        )
        .all(
          input.sessionId,
          input.afterRecordedAt,
          input.afterRecordedAt,
          input.limit,
        ) as JsonRow[],
    );
  }

  private putPayload(input: { ownerId: string; agentId: string; payload: PayloadRecord }): void {
    this.assertDiskHeadroom();
    if (this.database.prepare("SELECT 1 FROM payloads WHERE ref = ?").get(input.payload.ref)) {
      this.fail("PORT_DUPLICATE", `Payload ${input.payload.ref} already exists`, {
        payloadRef: input.payload.ref,
      });
    }
    this.database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
        ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.payload.ref,
        input.ownerId,
        input.agentId,
        input.payload.dataClassification,
        input.payload.ciphertext,
        input.payload.contentDigest,
        input.payload.encryption.algorithm,
        input.payload.encryption.keyRef,
        input.payload.createdAt,
        input.payload.contentType,
      );
  }

  private getPayload(input: {
    ownerId: string;
    agentId: string;
    ref: string;
  }): PayloadRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ref, classification AS dataClassification, content_type AS contentType,
          ciphertext, encryption_algorithm AS encryptionAlgorithm, key_ref AS keyRef,
          content_digest AS contentDigest, created_at AS createdAt
        FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`,
      )
      .get(input.ref, input.ownerId, input.agentId) as
      | {
          readonly ref: string;
          readonly dataClassification: PayloadRecord["dataClassification"];
          readonly contentType: string | null;
          readonly ciphertext: Uint8Array;
          readonly encryptionAlgorithm: string | null;
          readonly keyRef: string | null;
          readonly contentDigest: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      ref: row.ref,
      dataClassification: row.dataClassification,
      contentType: row.contentType ?? "application/octet-stream",
      ciphertext: new Uint8Array(row.ciphertext),
      encryption: {
        algorithm: row.encryptionAlgorithm ?? "unknown",
        keyRef: row.keyRef ?? "unknown",
      },
      contentDigest: row.contentDigest,
      createdAt: row.createdAt,
    };
  }

  private deletePayload(input: { ownerId: string; agentId: string; ref: string }): boolean {
    this.assertDiskHeadroom();
    return (
      this.database
        .prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
        .run(input.ref, input.ownerId, input.agentId).changes === 1
    );
  }

  private appendAudit(record: AuditRecord): void {
    this.assertDiskHeadroom();
    try {
      this.database
        .prepare(
          `INSERT INTO audit_records (
            id, owner_id, agent_id, action, target_ref, outcome, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.ownerId,
          record.agentId,
          record.action,
          record.targetRef,
          record.outcome,
          record.occurredAt,
        );
    } catch (error) {
      if (String((error as { readonly code?: unknown }).code) === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        this.fail("PORT_DUPLICATE", `Audit record ${record.id} already exists`, {
          auditId: record.id,
        });
      }
      throw error;
    }
  }

  private listAudit(input: { agentId: string; afterId: string | null }): readonly AuditRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, agent_id AS agentId, action,
          target_ref AS targetRef, outcome, occurred_at AS occurredAt
        FROM audit_records WHERE agent_id = ? ORDER BY occurred_at, id`,
      )
      .all(input.agentId) as AuditRecord[];
    if (input.afterId === null) return rows;
    const index = rows.findIndex(({ id }) => id === input.afterId);
    return rows.slice(index + 1);
  }

  private ensureMetadataPayload(
    ownerId: string,
    agentId: string,
    ref: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, lifecycle_state, created_at, content_type
        ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'', ?, 'active', ?, 'application/x-himawari-metadata')
        ON CONFLICT(ref) DO NOTHING`,
      )
      .run(ref, ownerId, agentId, `metadata:${ref}`, createdAt);
  }

  private approvalRow(id: string): ApprovalRequest | undefined {
    return parseRecord<ApprovalRequest>(
      this.database
        .prepare("SELECT record_json AS recordJson FROM approval_requests WHERE id = ?")
        .get(id) as JsonRow | undefined,
    );
  }

  private createApproval(request: ApprovalRequest): ApprovalRequest {
    this.assertDiskHeadroom();
    this.assertRunScope(request.runId, request.ownerId, request.agentId);
    if (this.approvalRow(request.id)) {
      this.fail("PORT_DUPLICATE", `Approval ${request.id} already exists`, {
        approvalRequestId: request.id,
      });
    }
    const intentRef = `metadata:approval-intent:${request.id}`;
    this.ensureMetadataPayload(request.ownerId, request.agentId, intentRef, request.requestedAt);
    this.database
      .prepare(
        `INSERT INTO approval_requests (
          id, owner_id, agent_id, run_id, revision, status, risk, intent_ref,
          semantic_snapshot_hash, requested_at, decided_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'low', ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.ownerId,
        request.agentId,
        request.runId,
        request.revision,
        request.status,
        intentRef,
        request.semanticSnapshotHash,
        request.requestedAt,
        request.decidedAt,
        JSON.stringify(request),
      );
    return request;
  }

  private findApprovalByIntent(intentId: string): ApprovalRequest | undefined {
    const rows = this.database
      .prepare("SELECT record_json AS recordJson FROM approval_requests ORDER BY requested_at, id")
      .all() as JsonRow[];
    return parseRecords<ApprovalRequest>(rows)
      .filter((record) => record.intentId === intentId)
      .at(-1);
  }

  private getApproval(approvalRequestId: string): ApprovalRequest | undefined {
    return this.approvalRow(approvalRequestId);
  }

  private insertGrant(grant: GrantRecord): void {
    this.database
      .prepare(
        `INSERT INTO grants (
          id, owner_id, agent_id, revision, status, scope_ref, authorization_ref,
          expires_at, revoked_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.ownerId,
        grant.agentId,
        grant.revision,
        grantStatus(grant),
        `grant-scope:${grant.id}`,
        grant.sourceApprovalRequestId,
        grant.expiresAt,
        grant.revokedAt,
        JSON.stringify(grant),
      );
  }

  private resolveApproval(input: ResolveApprovalInput): ApprovalRequest {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.approvalRow(input.approvalRequestId);
      if (!current) this.fail("PORT_NOT_FOUND", `Approval ${input.approvalRequestId} not found`);
      if (current.revision !== input.expectedRevision || current.status !== "pending") {
        this.fail("PORT_CONFLICT", `Approval ${current.id} cannot be resolved`);
      }
      if (current.semanticSnapshotHash !== input.semanticSnapshotHash) {
        this.fail("PORT_CONFLICT", `Approval ${current.id} semantic snapshot changed`);
      }
      if ((input.resolution === "approved") !== (input.grant !== null)) {
        this.fail("PORT_INVALID_OPERATION", "Approved resolutions require exactly one Grant");
      }
      if (
        input.grant &&
        this.database.prepare("SELECT 1 FROM grants WHERE id = ?").get(input.grant.id)
      ) {
        this.fail("PORT_DUPLICATE", `Grant ${input.grant.id} already exists`);
      }
      const resolved: ApprovalRequest = {
        ...current,
        revision: current.revision + 1,
        status: input.resolution,
        decidedAt: input.decidedAt,
        grantId: input.grant?.id ?? null,
      };
      if (input.grant) this.insertGrant(input.grant);
      this.database
        .prepare(
          "UPDATE approval_requests SET revision = ?, status = ?, decided_at = ?, record_json = ? WHERE id = ?",
        )
        .run(
          resolved.revision,
          resolved.status,
          resolved.decidedAt,
          JSON.stringify(resolved),
          resolved.id,
        );
      return resolved;
    });
    return transaction.immediate();
  }

  private listGrants(input: { ownerId: string; agentId: string }): readonly GrantRecord[] {
    return parseRecords<GrantRecord>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM grants
          WHERE owner_id = ? AND agent_id = ? ORDER BY id`,
        )
        .all(input.ownerId, input.agentId) as JsonRow[],
    );
  }

  private grantRow(grantId: string): GrantRecord | undefined {
    return parseRecord<GrantRecord>(
      this.database
        .prepare("SELECT record_json AS recordJson FROM grants WHERE id = ?")
        .get(grantId) as JsonRow | undefined,
    );
  }

  private consumeGrant(input: ConsumeGrantInput): GrantRecord {
    this.assertDiskHeadroom();
    const current = this.grantRow(input.grantId);
    if (!current) this.fail("PORT_NOT_FOUND", `Grant ${input.grantId} not found`);
    if (current.revision !== input.expectedRevision) {
      this.fail("PORT_CONFLICT", `Grant ${current.id} has a stale revision`);
    }
    if (
      current.revokedAt !== null ||
      input.consumedAt < current.validFrom ||
      input.consumedAt >= current.expiresAt ||
      current.uses >= current.maxUses ||
      current.spentCostMicros + input.costMicros > current.maxTotalCostMicros
    ) {
      this.fail("PORT_INVALID_OPERATION", `Grant ${current.id} is not consumable`);
    }
    const consumed: GrantRecord = {
      ...current,
      revision: current.revision + 1,
      uses: current.uses + 1,
      spentCostMicros: current.spentCostMicros + input.costMicros,
    };
    this.updateGrant(consumed);
    return consumed;
  }

  private revokeGrant(input: {
    grantId: string;
    revokedAt: string;
    reasonCode: string;
  }): GrantRecord {
    this.assertDiskHeadroom();
    const current = this.grantRow(input.grantId);
    if (!current) this.fail("PORT_NOT_FOUND", `Grant ${input.grantId} not found`);
    if (current.revokedAt !== null) return current;
    const revoked: GrantRecord = {
      ...current,
      revision: current.revision + 1,
      revokedAt: input.revokedAt,
      revocationReasonCode: input.reasonCode,
    };
    this.updateGrant(revoked);
    return revoked;
  }

  private updateGrant(record: GrantRecord): void {
    this.database
      .prepare(
        "UPDATE grants SET revision = ?, status = ?, revoked_at = ?, record_json = ? WHERE id = ?",
      )
      .run(
        record.revision,
        grantStatus(record),
        record.revokedAt,
        JSON.stringify(record),
        record.id,
      );
  }

  private createCapability(input: {
    ownerId: string;
    agentId: string;
    record: CapabilityRegistryRecord;
  }): CapabilityRegistryRecord {
    this.assertDiskHeadroom();
    if (this.getCapability({ ...input, capabilityRef: input.record.ref })) {
      this.fail("PORT_DUPLICATE", `Capability ${input.record.ref} already exists`);
    }
    const declarationRef = `metadata:capability-declaration:${input.record.ref}`;
    this.ensureMetadataPayload(
      input.ownerId,
      input.agentId,
      declarationRef,
      input.record.discoveredAt,
    );
    this.database
      .prepare(
        `INSERT INTO capability_declarations (
          id, owner_id, agent_id, revision, version, integrity, status,
          declaration_ref, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.record.ref,
        input.ownerId,
        input.agentId,
        input.record.revision,
        input.record.declaration.version,
        input.record.declaration.integrity,
        capabilityStatus(input.record.lifecycle),
        declarationRef,
        JSON.stringify(input.record),
      );
    return input.record;
  }

  private getCapability(input: {
    ownerId: string;
    agentId: string;
    capabilityRef: string;
  }): CapabilityRegistryRecord | undefined {
    return parseRecord<CapabilityRegistryRecord>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM capability_declarations
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(input.capabilityRef, input.ownerId, input.agentId) as JsonRow | undefined,
    );
  }

  private listCapabilities(input: {
    ownerId: string;
    agentId: string;
  }): readonly CapabilityRegistryRecord[] {
    return parseRecords<CapabilityRegistryRecord>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM capability_declarations
          WHERE owner_id = ? AND agent_id = ? ORDER BY id`,
        )
        .all(input.ownerId, input.agentId) as JsonRow[],
    );
  }

  private saveCapability(input: {
    ownerId: string;
    agentId: string;
    record: CapabilityRegistryRecord;
    expectedRevision: number;
  }): CapabilityRegistryRecord {
    this.assertDiskHeadroom();
    const current = this.getCapability({ ...input, capabilityRef: input.record.ref });
    if (!current) this.fail("PORT_NOT_FOUND", `Capability ${input.record.ref} not found`);
    if (
      current.revision !== input.expectedRevision ||
      input.record.revision !== input.expectedRevision + 1
    ) {
      this.fail("PORT_CONFLICT", `Capability ${input.record.ref} has a stale revision`);
    }
    this.database
      .prepare(
        `UPDATE capability_declarations SET revision = ?, version = ?, integrity = ?,
          status = ?, record_json = ? WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .run(
        input.record.revision,
        input.record.declaration.version,
        input.record.declaration.integrity,
        capabilityStatus(input.record.lifecycle),
        JSON.stringify(input.record),
        input.record.ref,
        input.ownerId,
        input.agentId,
      );
    return input.record;
  }

  private createCapabilityHandle(handle: CapabilityExecutionHandle): CapabilityExecutionHandle {
    this.assertDiskHeadroom();
    this.assertRunScope(handle.runId, handle.ownerId, handle.agentId);
    if (
      !this.database
        .prepare(
          `SELECT 1 FROM capability_declarations
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(handle.capabilityRef, handle.ownerId, handle.agentId)
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        `Capability ${handle.capabilityRef} is outside the Handle scope`,
      );
    }
    if (this.database.prepare("SELECT 1 FROM capability_handles WHERE id = ?").get(handle.ref)) {
      this.fail("PORT_DUPLICATE", `Capability handle ${handle.ref} already exists`);
    }
    this.database
      .prepare(
        `INSERT INTO capability_handles (
          id, capability_id, run_id, authorization_ref, status, expires_at, revoked_at, record_json
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        handle.ref,
        handle.capabilityRef,
        handle.runId,
        handle.authorization.ref,
        handle.expiresAt,
        handle.revokedAt,
        JSON.stringify(handle),
      );
    return handle;
  }

  private getCapabilityHandle(input: {
    ownerId: string;
    agentId: string;
    handleRef: string;
  }): CapabilityExecutionHandle | undefined {
    return parseRecord<CapabilityExecutionHandle>(
      this.database
        .prepare(
          `SELECT capability_handles.record_json AS recordJson
          FROM capability_handles
          JOIN capability_declarations ON capability_declarations.id = capability_handles.capability_id
          WHERE capability_handles.id = ? AND capability_declarations.owner_id = ?
            AND capability_declarations.agent_id = ?`,
        )
        .get(input.handleRef, input.ownerId, input.agentId) as JsonRow | undefined,
    );
  }

  private revokeCapabilityHandle(input: {
    ownerId: string;
    agentId: string;
    handleRef: string;
    revokedAt: string;
  }): CapabilityExecutionHandle {
    this.assertDiskHeadroom();
    const current = this.getCapabilityHandle(input);
    if (!current) this.fail("PORT_NOT_FOUND", `Capability handle ${input.handleRef} not found`);
    if (current.revokedAt !== null) return current;
    const revoked = { ...current, revokedAt: input.revokedAt };
    this.database
      .prepare(
        "UPDATE capability_handles SET status = 'revoked', revoked_at = ?, record_json = ? WHERE id = ?",
      )
      .run(input.revokedAt, JSON.stringify(revoked), input.handleRef);
    return revoked;
  }

  private readJob(jobId: string): ScheduledJob | undefined {
    return parseRecord<ScheduledJob>(
      this.database
        .prepare("SELECT record_json AS recordJson FROM scheduled_jobs WHERE id = ?")
        .get(jobId) as JsonRow | undefined,
    );
  }

  private upsertJob(input: {
    job: ScheduledJobWrite;
    expectedRevision: number | null;
  }): ScheduledJob {
    this.assertDiskHeadroom();
    const current = this.readJob(input.job.id);
    if ((current?.revision ?? null) !== input.expectedRevision) {
      this.fail("PORT_CONFLICT", `Scheduled job ${input.job.id} revision conflict`);
    }
    if (
      current &&
      (current.ownerId !== input.job.ownerId || current.agentId !== input.job.agentId)
    ) {
      this.fail("PORT_CONFLICT", `Scheduled job ${input.job.id} cannot change scope`);
    }
    this.assertPayloadScope(input.job.payloadRef, input.job.ownerId, input.job.agentId);
    if (
      input.job.threadId !== null &&
      !this.database
        .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(input.job.threadId, input.job.ownerId, input.job.agentId)
    ) {
      this.fail("PORT_INVALID_OPERATION", `Thread ${input.job.threadId} is outside the Job scope`);
    }
    const stored: ScheduledJob = { ...input.job, revision: (current?.revision ?? 0) + 1 };
    this.database
      .prepare(
        `INSERT INTO scheduled_jobs (
          id, owner_id, agent_id, thread_id, revision, status, authorization_ref,
          definition_ref, next_occurrence_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id,
          revision = excluded.revision, status = excluded.status,
          authorization_ref = excluded.authorization_ref,
          definition_ref = excluded.definition_ref,
          next_occurrence_at = excluded.next_occurrence_at,
          record_json = excluded.record_json`,
      )
      .run(
        stored.id,
        stored.ownerId,
        stored.agentId,
        stored.threadId,
        stored.revision,
        stored.status === "cancelled" ? "revoked" : "active",
        stored.authorizationRef,
        stored.payloadRef,
        stored.nextRunAt,
        JSON.stringify(stored),
      );
    return stored;
  }

  private listDue(input: { at: string; limit: number }): readonly ScheduledJob[] {
    assertLimit(input.limit, this.fail);
    return parseRecords<ScheduledJob>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM scheduled_jobs
          WHERE status = 'active' AND next_occurrence_at <= ?
          ORDER BY next_occurrence_at, id LIMIT ?`,
        )
        .all(input.at, input.limit) as JsonRow[],
    );
  }

  private cancelJob(input: { jobId: string; expectedRevision: number }): ScheduledJob {
    this.assertDiskHeadroom();
    const current = this.readJob(input.jobId);
    if (!current) this.fail("PORT_NOT_FOUND", `Job ${input.jobId} not found`);
    if (current.revision !== input.expectedRevision) {
      this.fail("PORT_CONFLICT", `Scheduled job ${input.jobId} revision conflict`);
    }
    if (current.status === "cancelled") return current;
    const cancelled: ScheduledJob = {
      ...current,
      revision: current.revision + 1,
      status: "cancelled",
    };
    this.database
      .prepare(
        "UPDATE scheduled_jobs SET revision = ?, status = 'revoked', record_json = ? WHERE id = ?",
      )
      .run(cancelled.revision, JSON.stringify(cancelled), cancelled.id);
    return cancelled;
  }

  private readAttentionPolicy(input: { ownerId: string; agentId: string }): AttentionPolicyState {
    const revision = this.database
      .prepare("SELECT revision FROM attention_policy_states WHERE owner_id = ? AND agent_id = ?")
      .pluck()
      .get(input.ownerId, input.agentId) as number | undefined;
    const decisions = parseRecords<AttentionPolicyState["decisions"][number]>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM attention_decisions
          WHERE owner_id = ? AND agent_id = ? ORDER BY decided_at, id`,
        )
        .all(input.ownerId, input.agentId) as JsonRow[],
    );
    return { revision: revision ?? 0, decisions };
  }

  private commitAttentionDecision(input: AttentionDecisionCommit): AttentionDecisionCommitResult {
    this.assertDiskHeadroom();
    this.assertRunScope(input.record.runId, input.ownerId, input.agentId);
    if (input.delivery) {
      this.assertPayloadScope(input.delivery.resultRef, input.ownerId, input.agentId);
    }
    const transaction = this.database.transaction(() => {
      const current = this.readAttentionPolicy(input);
      if (current.revision !== input.expectedRevision) {
        this.fail("PORT_CONFLICT", "Attention policy state revision conflict");
      }
      if (
        input.record.ownerId !== input.ownerId ||
        input.record.agentId !== input.agentId ||
        current.decisions.some(({ candidateId }) => candidateId === input.record.candidateId)
      ) {
        this.fail("PORT_CONFLICT", `Attention decision ${input.record.candidateId} conflicts`);
      }
      const deliveryMatches =
        input.record.decision.level === "SILENT"
          ? input.record.deliveryRequestId === null && input.delivery === null
          : input.delivery !== null &&
            input.record.deliveryRequestId === input.delivery.id &&
            input.record.candidateId === input.delivery.candidateId &&
            input.record.ownerId === input.delivery.ownerId &&
            input.record.agentId === input.delivery.agentId &&
            input.record.runId === input.delivery.runId &&
            input.record.decision.level === input.delivery.level &&
            input.delivery.status === "pending" &&
            input.delivery.assignedClientId === null &&
            input.delivery.attempts === 0;
      if (!deliveryMatches) {
        this.fail("PORT_INVALID_OPERATION", "Attention decision does not match its delivery");
      }
      const nextRevision = current.revision + 1;
      this.database
        .prepare(
          `INSERT INTO attention_policy_states (owner_id, agent_id, revision, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, agent_id) DO UPDATE SET
            revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, nextRevision, input.record.decidedAt);
      this.database
        .prepare(
          `INSERT INTO attention_decisions (
            id, owner_id, agent_id, run_id, level, reason_code, decided_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.record.candidateId,
          input.record.ownerId,
          input.record.agentId,
          input.record.runId,
          input.record.decision.level,
          input.record.decision.reasonCode,
          input.record.decidedAt,
          JSON.stringify(input.record),
        );
      const delivery: DeliveryRequest | null = input.delivery
        ? { ...input.delivery, revision: 1 }
        : null;
      if (delivery) {
        this.database
          .prepare(
            `INSERT INTO inbox_deliveries (
              id, owner_id, agent_id, run_id, revision, result_ref, status,
              created_at, updated_at, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            delivery.id,
            delivery.ownerId,
            delivery.agentId,
            delivery.runId,
            delivery.revision,
            delivery.resultRef,
            delivery.status,
            delivery.createdAt,
            delivery.updatedAt,
            JSON.stringify(delivery),
          );
      }
      return {
        state: {
          revision: nextRevision,
          decisions: [...current.decisions, input.record],
        },
        record: input.record,
        delivery,
      };
    });
    return transaction.immediate();
  }

  private readDelivery(requestId: string): DeliveryRequest | undefined {
    return parseRecord<DeliveryRequest>(
      this.database
        .prepare("SELECT record_json AS recordJson FROM inbox_deliveries WHERE id = ?")
        .get(requestId) as JsonRow | undefined,
    );
  }

  private claimDelivery(input: {
    requestId: string;
    clientId: string;
    claimedAt: string;
  }): DeliveryClaim {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.readDelivery(input.requestId);
      if (!current) this.fail("PORT_NOT_FOUND", `Delivery request ${input.requestId} not found`);
      if (current.status === "delivered") {
        return {
          claimed: false,
          request: current,
          reasonCode: "ALREADY_DELIVERED" as const,
        };
      }
      if (current.status === "delivering") {
        return { claimed: false, request: current, reasonCode: "ALREADY_CLAIMED" as const };
      }
      const claimed: DeliveryRequest = {
        ...current,
        revision: current.revision + 1,
        status: "delivering",
        assignedClientId: input.clientId,
        attempts: current.attempts + 1,
        updatedAt: input.claimedAt,
      };
      this.updateDelivery(claimed);
      return { claimed: true, request: claimed, reasonCode: "CLAIMED" as const };
    });
    return transaction.immediate();
  }

  private settleDelivery(input: DeliverySettlement): DeliveryRequest {
    this.assertDiskHeadroom();
    const current = this.readDelivery(input.requestId);
    if (!current) this.fail("PORT_NOT_FOUND", `Delivery request ${input.requestId} not found`);
    const validAcknowledgement =
      input.outcome === "delivered"
        ? input.acknowledgementRef !== null && input.errorCode === null
        : input.acknowledgementRef === null;
    if (
      current.status !== "delivering" ||
      current.revision !== input.expectedRevision ||
      current.assignedClientId !== input.clientId ||
      !validAcknowledgement
    ) {
      this.fail("PORT_CONFLICT", `Delivery request ${input.requestId} cannot settle`);
    }
    const delivered = input.outcome === "delivered";
    const settled: DeliveryRequest = {
      ...current,
      revision: current.revision + 1,
      status: delivered ? "delivered" : "pending",
      assignedClientId: delivered ? current.assignedClientId : null,
      acknowledgementRef: delivered ? input.acknowledgementRef : null,
      lastErrorCode: delivered ? null : (input.errorCode ?? "DELIVERY_UNAVAILABLE"),
      updatedAt: input.settledAt,
    };
    this.updateDelivery(settled);
    return settled;
  }

  private updateDelivery(record: DeliveryRequest): void {
    this.database
      .prepare(
        "UPDATE inbox_deliveries SET revision = ?, status = ?, updated_at = ?, record_json = ? WHERE id = ?",
      )
      .run(record.revision, record.status, record.updatedAt, JSON.stringify(record), record.id);
  }

  private deletionRow(deletionId: string): SessionDeletionRecord | undefined {
    return parseRecord<SessionDeletionRecord>(
      this.database
        .prepare("SELECT record_json AS recordJson FROM deletion_tombstones WHERE id = ?")
        .get(deletionId) as JsonRow | undefined,
    );
  }

  private createDeletion(record: SessionDeletionRecord): SessionDeletionRecord {
    this.assertDiskHeadroom();
    if (this.deletionRow(record.id)) {
      this.fail("PORT_DUPLICATE", `Session deletion ${record.id} already exists`);
    }
    this.database
      .prepare(
        `INSERT INTO deletion_tombstones (
          id, owner_id, agent_id, object_type, object_id, status, requested_at,
          purge_deadline_at, verified_at, record_json
        ) VALUES (?, ?, ?, 'session', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.agentId,
        record.sessionId,
        record.status,
        record.requestedAt,
        record.updatedAt,
        record.status === "verified" ? record.updatedAt : null,
        JSON.stringify(record),
      );
    return record;
  }

  private getDeletion(deletionId: string): SessionDeletionRecord | undefined {
    return this.deletionRow(deletionId);
  }

  private saveDeletion(input: {
    record: SessionDeletionRecord;
    expectedRevision: number;
  }): SessionDeletionRecord {
    this.assertDiskHeadroom();
    const current = this.deletionRow(input.record.id);
    if (!current) this.fail("PORT_NOT_FOUND", `Session deletion ${input.record.id} not found`);
    if (
      current.revision !== input.expectedRevision ||
      input.record.revision !== input.expectedRevision + 1
    ) {
      this.fail("PORT_CONFLICT", `Session deletion ${input.record.id} has a stale revision`);
    }
    this.database
      .prepare(
        `UPDATE deletion_tombstones SET status = ?, purge_deadline_at = ?, verified_at = ?,
          record_json = ? WHERE id = ?`,
      )
      .run(
        input.record.status,
        input.record.updatedAt,
        input.record.status === "verified" ? input.record.updatedAt : null,
        JSON.stringify(input.record),
        input.record.id,
      );
    return input.record;
  }

  private upsertThreadSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
    this.assertDiskHeadroom();
    if (snapshot.payload.sessionIds.length > 1000 || snapshot.payload.runIds.length > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Thread snapshot exceeds the bounded reference window", {
        threadId: snapshot.payload.threadId,
      });
    }
    const currentRow = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, revision,
          snapshot_json AS recordJson FROM gateway_thread_snapshots WHERE thread_id = ?`,
      )
      .get(snapshot.payload.threadId) as
      | {
          readonly ownerId: string;
          readonly agentId: string;
          readonly revision: number;
          readonly recordJson: string;
        }
      | undefined;
    if (currentRow) {
      if (
        currentRow.ownerId !== snapshot.scope.ownerId ||
        currentRow.agentId !== snapshot.scope.agentId ||
        snapshot.payload.revision < currentRow.revision
      ) {
        this.fail(
          "PORT_CONFLICT",
          `Thread snapshot ${snapshot.payload.threadId} is stale or re-scoped`,
        );
      }
      if (snapshot.payload.revision === currentRow.revision) {
        const current = JSON.parse(currentRow.recordJson) as ThreadSnapshot;
        if (currentRow.recordJson !== JSON.stringify(snapshot)) {
          this.fail(
            "PORT_CONFLICT",
            `Thread snapshot ${snapshot.payload.threadId} revision was reused`,
          );
        }
        return current;
      }
    }
    this.database
      .prepare(
        `INSERT INTO gateway_thread_snapshots (
          thread_id, owner_id, agent_id, revision, snapshot_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision,
          snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
        WHERE excluded.owner_id = gateway_thread_snapshots.owner_id
          AND excluded.agent_id = gateway_thread_snapshots.agent_id
          AND excluded.revision >= gateway_thread_snapshots.revision`,
      )
      .run(
        snapshot.payload.threadId,
        snapshot.scope.ownerId,
        snapshot.scope.agentId,
        snapshot.payload.revision,
        JSON.stringify(snapshot),
        new Date().toISOString(),
      );
    return snapshot;
  }

  private upsertRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
    this.assertDiskHeadroom();
    const currentRow = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, revision,
          snapshot_json AS recordJson FROM gateway_run_snapshots WHERE run_id = ?`,
      )
      .get(snapshot.payload.runId) as
      | {
          readonly ownerId: string;
          readonly agentId: string;
          readonly revision: number;
          readonly recordJson: string;
        }
      | undefined;
    if (currentRow) {
      if (
        currentRow.ownerId !== snapshot.scope.ownerId ||
        currentRow.agentId !== snapshot.scope.agentId ||
        snapshot.payload.revision < currentRow.revision
      ) {
        this.fail("PORT_CONFLICT", `Run snapshot ${snapshot.payload.runId} is stale or re-scoped`);
      }
      if (snapshot.payload.revision === currentRow.revision) {
        const current = JSON.parse(currentRow.recordJson) as RunSnapshot;
        if (currentRow.recordJson !== JSON.stringify(snapshot)) {
          this.fail("PORT_CONFLICT", `Run snapshot ${snapshot.payload.runId} revision was reused`);
        }
        return current;
      }
    }
    this.database
      .prepare(
        `INSERT INTO gateway_run_snapshots (
          run_id, owner_id, agent_id, revision, snapshot_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision,
          snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
        WHERE excluded.owner_id = gateway_run_snapshots.owner_id
          AND excluded.agent_id = gateway_run_snapshots.agent_id
          AND excluded.revision >= gateway_run_snapshots.revision`,
      )
      .run(
        snapshot.payload.runId,
        snapshot.scope.ownerId,
        snapshot.scope.agentId,
        snapshot.payload.revision,
        JSON.stringify(snapshot),
        new Date().toISOString(),
      );
    return snapshot;
  }

  private appendGatewayEvent(event: StreamEvent): StreamEvent {
    this.assertDiskHeadroom();
    const runScope = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, session_id AS sessionId,
          thread_id AS threadId FROM runs WHERE id = ?`,
      )
      .get(event.payload.runId) as
      | {
          readonly ownerId: string;
          readonly agentId: string;
          readonly sessionId: string;
          readonly threadId: string | null;
        }
      | undefined;
    if (
      !runScope ||
      runScope.ownerId !== event.scope.ownerId ||
      runScope.agentId !== event.scope.agentId ||
      runScope.sessionId !== event.payload.sessionId ||
      runScope.threadId !== event.payload.threadId
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        `Gateway event ${event.payload.cursor} is outside its Run scope`,
      );
    }
    const nextSequence =
      Number(
        this.database
          .prepare("SELECT COALESCE(MAX(cursor_sequence), 0) FROM gateway_stream_events")
          .pluck()
          .get(),
      ) + 1;
    try {
      this.database
        .prepare(
          `INSERT INTO gateway_stream_events (
            cursor_sequence, cursor, owner_id, agent_id, session_id, thread_id, run_id,
            run_sequence, recorded_at, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextSequence,
          event.payload.cursor,
          event.scope.ownerId,
          event.scope.agentId,
          event.payload.sessionId,
          event.payload.threadId,
          event.payload.runId,
          event.payload.sequence,
          event.payload.recordedAt,
          JSON.stringify(event),
        );
    } catch (error) {
      if (String((error as { readonly code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
        this.fail("PORT_DUPLICATE", `Gateway cursor ${event.payload.cursor} already exists`);
      }
      throw error;
    }
    return event;
  }

  private getThreadSnapshot(query: GetThreadSnapshotQuery): ThreadSnapshot {
    const row = this.database
      .prepare(
        `SELECT snapshot_json AS recordJson FROM gateway_thread_snapshots
        WHERE thread_id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(query.payload.threadId, query.scope.ownerId, query.scope.agentId) as JsonRow | undefined;
    const snapshot = parseRecord<ThreadSnapshot>(row);
    if (!snapshot) this.fail("PORT_NOT_FOUND", `Thread ${query.payload.threadId} not found`);
    return snapshot;
  }

  private getRunSnapshot(query: GetRunSnapshotQuery): RunSnapshot {
    const row = this.database
      .prepare(
        `SELECT snapshot_json AS recordJson FROM gateway_run_snapshots
        WHERE run_id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(query.payload.runId, query.scope.ownerId, query.scope.agentId) as JsonRow | undefined;
    const snapshot = parseRecord<RunSnapshot>(row);
    if (!snapshot) this.fail("PORT_NOT_FOUND", `Run ${query.payload.runId} not found`);
    return snapshot;
  }

  private queryGatewayTrace(query: TraceQuery): readonly StreamEvent[] {
    assertLimit(query.payload.limit, this.fail);
    return parseRecords<StreamEvent>(
      this.database
        .prepare(
          `SELECT event_json AS recordJson FROM gateway_stream_events
          WHERE owner_id = ? AND agent_id = ? AND session_id = ?
            AND (? IS NULL OR run_id = ?) AND run_sequence > ?
          ORDER BY cursor_sequence LIMIT ?`,
        )
        .all(
          query.scope.ownerId,
          query.scope.agentId,
          query.payload.sessionId,
          query.payload.runId,
          query.payload.runId,
          query.payload.afterSequence,
          query.payload.limit,
        ) as JsonRow[],
    );
  }

  private gatewaySubscription(subscription: EventSubscription): readonly StreamEvent[] {
    const afterSequence = this.resolveCursor(
      subscription.payload.afterCursor,
      subscription.scope.ownerId,
      subscription.scope.agentId,
    );
    return parseRecords<StreamEvent>(
      this.database
        .prepare(
          `SELECT event_json AS recordJson FROM gateway_stream_events
          WHERE cursor_sequence > ? AND owner_id = ? AND agent_id = ?
            AND (? IS NULL OR session_id = ?)
            AND (? IS NULL OR thread_id = ?)
            AND (? IS NULL OR run_id = ?)
          ORDER BY cursor_sequence LIMIT 1000`,
        )
        .all(
          afterSequence,
          subscription.scope.ownerId,
          subscription.scope.agentId,
          subscription.payload.sessionId,
          subscription.payload.sessionId,
          subscription.payload.threadId,
          subscription.payload.threadId,
          subscription.payload.runId,
          subscription.payload.runId,
        ) as JsonRow[],
    );
  }

  private resolveCursor(cursor: string | null, ownerId: string, agentId: string): number {
    if (cursor === null) return Math.max(0, this.gatewayMetadata().retentionWatermark - 1);
    const sequence = this.database
      .prepare(
        `SELECT cursor_sequence FROM gateway_stream_events
        WHERE cursor = ? AND owner_id = ? AND agent_id = ?`,
      )
      .pluck()
      .get(cursor, ownerId, agentId) as number | undefined;
    if (sequence === undefined || sequence < this.gatewayMetadata().retentionWatermark) {
      this.fail("PORT_NOT_FOUND", `Gateway cursor ${cursor} is outside the retention window`, {
        cursor,
      });
    }
    return sequence;
  }

  private setRetentionWatermark(input: {
    sequence: number;
    updatedAt: string;
  }): GatewayProjectionMetadata {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      this.fail("PORT_INVALID_OPERATION", "Retention watermark must be a non-negative integer");
    }
    this.assertDiskHeadroom();
    const current = this.gatewayMetadata();
    if (
      input.sequence < current.retentionWatermark ||
      input.sequence > current.latestCursorSequence
    ) {
      this.fail(
        "PORT_CONFLICT",
        "Retention watermark cannot move backwards or beyond the latest cursor",
      );
    }
    const transaction = this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM gateway_stream_events WHERE cursor_sequence < ?")
        .run(input.sequence);
      this.database
        .prepare(
          `INSERT INTO gateway_read_model_metadata (key, value, updated_at)
          VALUES ('retention_watermark', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(input.sequence), input.updatedAt);
      return this.gatewayMetadata();
    });
    return transaction.immediate();
  }

  private gatewayMetadata(): GatewayProjectionMetadata {
    const watermark = Number(
      this.database
        .prepare("SELECT value FROM gateway_read_model_metadata WHERE key = 'retention_watermark'")
        .pluck()
        .get() ?? 0,
    );
    const latest = Number(
      this.database
        .prepare("SELECT COALESCE(MAX(cursor_sequence), 0) FROM gateway_stream_events")
        .pluck()
        .get(),
    );
    return { retentionWatermark: watermark, latestCursorSequence: latest };
  }
}
