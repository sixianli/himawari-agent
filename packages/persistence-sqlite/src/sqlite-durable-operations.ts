import type {
  ApprovalRequest,
  AttentionDecisionCommit,
  AttentionDecisionCommitResult,
  AttentionPolicyState,
  AuditRecord,
  BackgroundAdmissionReservation,
  BackgroundAdmissionResult,
  BackgroundOccurrenceClaim,
  BackgroundOccurrenceSettlement,
  CapabilityExecutionHandle,
  ConsumeCapabilityExecutionHandleInput,
  GovernedCapabilityExecutionHandle,
  CapabilityRegistryRecord,
  ConsumeGrantInput,
  DeliveryClaim,
  DeliveryRequest,
  DeliverySettlement,
  GitHubCoverageGapRecord,
  GitHubMonitorHistoryPolicyOperation,
  GitHubInstallationRecord,
  GitHubRepositoryMonitor,
  GitHubWebhookReceiptRecord,
  GovernanceMutationReceipt,
  GrantRecord,
  PayloadRecord,
  ProductDeviceRecord,
  ProductSessionRecord,
  OwnerIdentityBindingRecord,
  ReliableEvent,
  ReliableEventRecord,
  ResolveApprovalInput,
  ScheduledJob,
  ScheduledJobWrite,
  SessionDeletionRecord,
  StateRecord,
  JsonObject,
  TraceEvent,
} from "@himawari-agent/application";
import type {
  BackgroundJobState,
  BackgroundOccurrence,
  DeviceId,
  JobId,
  OccurrenceId,
  OwnerId,
  ProductAuthorityFence,
  SessionId,
} from "@himawari-agent/domain";
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
import { SqliteCheckpointOperations } from "./sqlite-checkpoint-operations.ts";
import { SqliteMemoryOperations } from "./sqlite-memory-operations.ts";
import { SqliteThreadOperations } from "./sqlite-thread-operations.ts";

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
  readonly expiredWorkLeaseOccurrenceIds: readonly string[];
  readonly blockedOccurrenceIds: readonly string[];
  readonly modelBlockedOccurrenceIds: readonly string[];
  readonly unknownExternalResultOccurrenceIds: readonly string[];
}

export interface GatewayProjectionMetadata {
  readonly retentionWatermark: number;
  readonly latestCursorSequence: number;
}

export interface SqliteGitHubHistoryApplyResult {
  readonly operation: GitHubMonitorHistoryPolicyOperation;
  readonly pendingPayloadFiles: readonly string[];
}

interface GitHubHistoryRow {
  readonly monitorId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly monitorRevision: number;
  readonly policy: "retain" | "delete";
  readonly status: "running" | "retry_wait" | "completed";
  readonly attemptCount: number;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly pendingPayloadFilesJson: string;
  readonly monitorJson: string;
}

interface JsonRow {
  readonly recordJson: string;
}

interface GovernanceMutationReceiptRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly commandType: string;
  readonly semanticFingerprint: string;
  readonly phase: GovernanceMutationReceipt["phase"];
  readonly resultRef: string | null;
  readonly startedAt: string;
  readonly committedAt: string | null;
}

interface EventRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payloadRef: string;
  readonly occurredAt: string;
  readonly publishedAt: string | null;
}

interface BackgroundOccurrenceRow {
  readonly id: string;
  readonly jobId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly stableKey: string;
  readonly status: BackgroundOccurrence["status"];
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly category: string;
  readonly dataClassification: BackgroundOccurrence["dataClassification"];
  readonly foreground: number;
  readonly parallelSafe: number;
  readonly estimatedCostMicros: number;
  readonly reservedCostMicros: number;
  readonly spentCostMicros: number;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly deadlineAt: string;
  readonly runId: string | null;
  readonly workLeaseId: string | null;
  readonly workLeaseHolderId: string | null;
  readonly workLeaseAcquiredAt: string | null;
  readonly workLeaseExpiresAt: string | null;
  readonly lastErrorCode: string | null;
  readonly recordJson: string | null;
}

interface IdentityBindingRow {
  readonly ownerId: string;
  readonly externalSubjectRef: string;
  readonly boundAt: string;
  readonly status: OwnerIdentityBindingRecord["status"];
}

interface ProductDeviceRow {
  readonly id: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly label: string;
  readonly status: ProductDeviceRecord["status"];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface ProductSessionRow {
  readonly id: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly revision: number;
  readonly authenticationRef: string;
  readonly status: ProductSessionRecord["status"];
  readonly firstAuthenticatedAt: string;
  readonly lastActiveAt: string;
  readonly recentAuthenticatedAt: string;
  readonly revokedAt: string | null;
}

function parseRecord<TRecord>(row: JsonRow | undefined): TRecord | undefined {
  return row ? (JSON.parse(row.recordJson) as TRecord) : undefined;
}

function parseRecords<TRecord>(rows: readonly JsonRow[]): readonly TRecord[] {
  return rows.map((row) => JSON.parse(row.recordJson) as TRecord);
}

function governanceReceiptFromRow(row: GovernanceMutationReceiptRow): GovernanceMutationReceipt {
  return row as GovernanceMutationReceipt;
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

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) throw new RangeError("SQL placeholder list cannot be empty");
  return values.map(() => "?").join(", ");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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
  if (lifecycle === "review_required") return "discovered";
  if (lifecycle === "revoked") return "disabled";
  return lifecycle;
}

export class SqliteDurableOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly checkpoint: SqliteCheckpointOperations;
  private readonly memory: SqliteMemoryOperations;
  private readonly thread: SqliteThreadOperations;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.checkpoint = new SqliteCheckpointOperations(database, fail, assertDiskHeadroom);
    this.memory = new SqliteMemoryOperations(database, fail, assertDiskHeadroom);
    this.thread = new SqliteThreadOperations(database, fail, assertDiskHeadroom);
  }

  execute(operation: string, payload: unknown): unknown {
    if (operation.startsWith("thread.")) {
      return this.thread.execute(operation, payload);
    }
    if (operation.startsWith("threadDistillation.")) {
      return this.checkpoint.execute(operation, payload);
    }
    if (
      operation.startsWith("memory.") ||
      operation.startsWith("memoryJob.") ||
      operation.startsWith("memoryApproval.")
    ) {
      return this.memory.execute(operation, payload);
    }
    switch (operation) {
      case "event.append":
        return this.appendEvent(
          payload as { ownerId: string; agentId: string; event: ReliableEvent },
        );
      case "state.read":
        return this.readScopedState(payload as { ownerId: string; agentId: string; key: string });
      case "state.compareAndSet":
        return this.compareAndSetState(
          payload as {
            ownerId: string;
            agentId: string;
            authority: ProductAuthorityFence;
            key: string;
            expectedRevision: number | null;
            value: JsonObject;
            updatedAt: string;
          },
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
      case "authorization.listApprovals":
        return this.listApprovals(payload as { ownerId: string; agentId: string });
      case "authorization.resolveApproval":
        return this.resolveApproval((payload as { input: ResolveApprovalInput }).input);
      case "authorization.listGrants":
        return this.listGrants(payload as { ownerId: string; agentId: string });
      case "authorization.consumeGrant":
        return this.consumeGrant((payload as { input: ConsumeGrantInput }).input);
      case "authorization.revokeGrant":
        return this.revokeGrant(
          payload as {
            grantId: string;
            revokedAt: string;
            reasonCode: string;
            expectedRevision?: number;
          },
        );
      case "governance.receipt.get":
        return this.getGovernanceMutationReceipt(
          payload as { ownerId: string; agentId: string; idempotencyKey: string },
        );
      case "governance.receipt.create":
        return this.createGovernanceMutationReceipt(
          (payload as { receipt: GovernanceMutationReceipt }).receipt,
        );
      case "governance.receipt.complete":
        return this.completeGovernanceMutationReceipt(
          payload as { receipt: GovernanceMutationReceipt; expectedRevision: number },
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
      case "capability.invalidateAuthority":
        return this.invalidateCapabilityAuthority(
          payload as {
            ownerId: string;
            agentId: string;
            record: CapabilityRegistryRecord;
            expectedRevision: number;
            revokedAt: string;
          },
        );
      case "capability.switchVersion":
        return this.switchCapabilityVersion(
          payload as {
            ownerId: string;
            agentId: string;
            record: CapabilityRegistryRecord;
            expectedRevision: number;
            switchedAt: string;
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
      case "capability.consumeHandle":
        return this.consumeCapabilityHandle(
          (payload as { input: ConsumeCapabilityExecutionHandleInput }).input,
        );
      case "capability.revokeHandles":
        return this.revokeCapabilityHandles(
          payload as { ownerId: string; agentId: string; capabilityRef: string; revokedAt: string },
        );
      case "capability.endRunHandles":
        return this.endRunCapabilityHandles(
          payload as { ownerId: string; agentId: string; runId: string; endedAt: string },
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
      case "background.readJob":
        return this.readBackgroundJob((payload as { jobId: JobId }).jobId);
      case "background.saveJob":
        return this.saveBackgroundJob(
          payload as { job: BackgroundJobState; expectedRevision: number },
        );
      case "background.readOccurrence":
        return this.readOccurrence((payload as { occurrenceId: OccurrenceId }).occurrenceId);
      case "background.createOccurrence":
        return this.createOccurrence((payload as { occurrence: BackgroundOccurrence }).occurrence);
      case "background.saveOccurrence":
        return this.saveOccurrence(
          payload as { occurrence: BackgroundOccurrence; expectedRevision: number },
        );
      case "background.reserveAdmission":
        return this.reserveBackgroundAdmission(
          (payload as { input: BackgroundAdmissionReservation }).input,
        );
      case "background.claimOccurrence":
        return this.claimOccurrence((payload as { input: BackgroundOccurrenceClaim }).input);
      case "background.settleOccurrence":
        return this.settleOccurrence((payload as { input: BackgroundOccurrenceSettlement }).input);
      case "background.listByJob":
        return this.listOccurrencesByJob(payload as { jobId: JobId; limit: number });
      case "background.listRecoverable":
        return this.listRecoverableOccurrences(
          payload as { ownerId: string; agentId: string; now: string; limit: number },
        );
      case "github.installation.read":
        return this.readGitHubInstallation(
          (payload as { installationRef: string }).installationRef,
        );
      case "github.installation.save":
        return this.saveGitHubInstallation(
          (payload as { record: GitHubInstallationRecord }).record,
        );
      case "github.monitor.read":
        return this.readGitHubMonitor((payload as { monitorId: JobId }).monitorId);
      case "github.monitor.save":
        return this.saveGitHubMonitor(
          payload as { monitor: GitHubRepositoryMonitor; expectedRevision: number | null },
        );
      case "github.receipt.record":
        return this.recordGitHubReceipt(
          (payload as { receipt: GitHubWebhookReceiptRecord }).receipt,
        );
      case "github.receipt.find":
        return this.readGitHubReceipt(
          (payload as { providerDeliveryId: string }).providerDeliveryId,
        );
      case "github.webhook.admit":
        return this.admitGitHubWebhook(
          payload as {
            receipt: GitHubWebhookReceiptRecord;
            occurrence: BackgroundOccurrence;
          },
        );
      case "github.coverage.save":
        return this.saveGitHubCoverageGap((payload as { gap: GitHubCoverageGapRecord }).gap);
      case "github.coverage.list":
        return this.listGitHubCoverageGaps((payload as { monitorId: JobId }).monitorId);
      case "github.history.apply":
        return this.applyGitHubHistoryPolicy(
          payload as {
            monitor: GitHubRepositoryMonitor;
            policy: "retain" | "delete";
            requestedBy: string;
            occurredAt: string;
          },
        );
      case "github.history.inspect":
        return this.readGitHubHistoryOperation((payload as { monitorId: JobId }).monitorId);
      case "github.history.listRetryable":
        return this.listRetryableGitHubHistoryOperations((payload as { limit: number }).limit);
      case "github.history.retry":
        return this.retryGitHubHistoryPolicy(payload as { monitorId: JobId; occurredAt: string });
      case "github.history.finalize":
        return this.finalizeGitHubHistoryPolicy(
          payload as { monitorId: JobId; occurredAt: string },
        );
      case "github.history.fail":
        return this.failGitHubHistoryPolicy(
          payload as { monitorId: JobId; occurredAt: string; errorCode: string },
        );
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
      case "identity.bindFirstOwner":
        return this.bindFirstOwner(
          payload as { ownerId: string; externalSubjectRef: string; boundAt: string },
        );
      case "identity.readBySubject":
        return this.readIdentityBySubject(
          (payload as { externalSubjectRef: string }).externalSubjectRef,
        );
      case "identity.readByOwner":
        return this.readIdentityByOwner((payload as { ownerId: string }).ownerId);
      case "identity.repairBinding":
        return this.repairIdentityBinding(
          payload as { ownerId: string; externalSubjectRef: string; repairedAt: string },
        );
      case "identity.readSession":
        return this.readProductSession((payload as { sessionId: string }).sessionId);
      case "identity.findSessionByAuthenticationRef":
        return this.findProductSessionByAuthenticationRef(
          (payload as { authenticationRef: string }).authenticationRef,
        );
      case "identity.listSessions":
        return this.listProductSessions(payload as { ownerId: string; includeRevoked: boolean });
      case "identity.listDevices":
        return this.listProductDevices(payload as { ownerId: string; includeRevoked: boolean });
      case "identity.saveDevice":
        return this.saveProductDevice(
          payload as {
            device: Omit<ProductDeviceRecord, "revision">;
            expectedRevision: number | null;
          },
        );
      case "identity.revokeDevice":
        return this.revokeProductDevice(
          payload as { deviceId: string; expectedRevision: number; revokedAt: string },
        );
      case "identity.saveSession":
        return this.saveProductSession(
          payload as {
            session: Omit<ProductSessionRecord, "revision">;
            expectedRevision: number | null;
          },
        );
      case "identity.revokeSession":
        return this.revokeProductSession(
          payload as { sessionId: string; expectedRevision: number; revokedAt: string },
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
      this.database
        .prepare(
          `UPDATE github_history_policy_operations
          SET status = 'retry_wait', last_error_code = 'history_process_interrupted', updated_at = ?
          WHERE status = 'running'`,
        )
        .run(now);
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
        retryableJobOccurrenceIds: this.idListWith(
          `SELECT id FROM job_occurrences WHERE status IN ('queued', 'admitted')
            OR (status = 'retry_wait' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            OR (status = 'running' AND work_lease_expires_at <= ?) ORDER BY id`,
          now,
          now,
        ),
        expiredWorkLeaseOccurrenceIds: this.idListWith(
          `SELECT id FROM job_occurrences WHERE status = 'running'
            AND work_lease_expires_at <= ? ORDER BY id`,
          now,
        ),
        blockedOccurrenceIds: this.idList(
          `SELECT id FROM job_occurrences WHERE status IN (
            'blocked_credentials', 'blocked_approval', 'budget_blocked', 'capacity_blocked'
          ) ORDER BY id`,
        ),
        modelBlockedOccurrenceIds: this.idList(
          `SELECT id FROM job_occurrences WHERE status = 'blocked_approval'
            AND last_error_code = 'MODEL_BLOCKED' ORDER BY id`,
        ),
        unknownExternalResultOccurrenceIds: this.idList(
          `SELECT id FROM job_occurrences WHERE status = 'retry_wait'
            AND last_error_code = 'EXTERNAL_RESULT_UNKNOWN' ORDER BY id`,
        ),
      } satisfies SqliteStartupRecovery;
    });
    return transaction.immediate();
  }

  private idList(sql: string): readonly string[] {
    return (this.database.prepare(sql).all() as Array<{ readonly id: string }>).map(({ id }) => id);
  }

  private readScopedState(input: {
    ownerId: string;
    agentId: string;
    key: string;
  }): StateRecord | undefined {
    if (!input.key.startsWith("run-checkpoint:")) {
      this.fail("PORT_INVALID_OPERATION", "The durable checkpoint store only accepts Run keys");
    }
    const row = this.database
      .prepare(
        `SELECT key, revision, value_json AS valueJson FROM product_state_records
        WHERE key = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.key, input.ownerId, input.agentId) as
      | { readonly key: string; readonly revision: number; readonly valueJson: string }
      | undefined;
    return row
      ? { key: row.key, revision: row.revision, value: JSON.parse(row.valueJson) as JsonObject }
      : undefined;
  }

  private compareAndSetState(input: {
    ownerId: string;
    agentId: string;
    authority: ProductAuthorityFence;
    key: string;
    expectedRevision: number | null;
    value: JsonObject;
    updatedAt: string;
  }): StateRecord {
    this.assertDiskHeadroom();
    if (!input.key.startsWith("run-checkpoint:")) {
      this.fail("PORT_INVALID_OPERATION", "The durable checkpoint store only accepts Run keys");
    }
    this.assertBackgroundFence(input.ownerId, input.agentId, input.authority);
    const transaction = this.database.transaction(() => {
      const current = this.readScopedState(input);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        this.fail("PORT_CONFLICT", `State ${input.key} revision conflict`, { key: input.key });
      }
      const revision = (current?.revision ?? 0) + 1;
      this.database
        .prepare(
          `INSERT INTO product_state_records (
            key, owner_id, agent_id, revision, value_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
            revision = excluded.revision, value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.key,
          input.ownerId,
          input.agentId,
          revision,
          JSON.stringify(input.value),
          input.updatedAt,
        );
      return { key: input.key, revision, value: input.value };
    });
    return transaction.immediate();
  }

  private idListWith(sql: string, ...parameters: readonly unknown[]): readonly string[] {
    return (this.database.prepare(sql).all(...parameters) as Array<{ readonly id: string }>).map(
      ({ id }) => id,
    );
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
      .filter(({ key, valueJson }) => {
        const value = JSON.parse(valueJson) as {
          readonly status?: unknown;
          readonly terminalStatus?: unknown;
        };
        if (key.startsWith("run-checkpoint:")) return value.terminalStatus === null;
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
      expiredWorkLeaseOccurrenceIds: [],
      blockedOccurrenceIds: this.idList(
        `SELECT id FROM job_occurrences WHERE status IN (
          'blocked_credentials', 'blocked_approval', 'budget_blocked', 'capacity_blocked'
        ) ORDER BY id`,
      ),
      modelBlockedOccurrenceIds: this.idList(
        `SELECT id FROM job_occurrences WHERE status = 'blocked_approval'
          AND last_error_code = 'MODEL_BLOCKED' ORDER BY id`,
      ),
      unknownExternalResultOccurrenceIds: this.idList(
        `SELECT id FROM job_occurrences WHERE status = 'retry_wait'
          AND last_error_code = 'EXTERNAL_RESULT_UNKNOWN' ORDER BY id`,
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
    const storage = input.payload.storage ?? { kind: "inline" as const };
    this.database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          ciphertext_path, content_digest, encryption_algorithm, key_ref,
          lifecycle_state, created_at, content_type, encryption_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        input.payload.ref,
        input.ownerId,
        input.agentId,
        input.payload.dataClassification,
        storage.kind === "inline" ? "sqlite_blob" : "ciphertext_file",
        storage.kind === "inline" ? input.payload.ciphertext : null,
        storage.kind === "ciphertext_file" ? storage.relativePath : null,
        input.payload.contentDigest,
        input.payload.encryption.algorithm,
        input.payload.encryption.keyRef,
        input.payload.createdAt,
        input.payload.contentType,
        JSON.stringify(input.payload.encryption),
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
          storage_kind AS storageKind, ciphertext, ciphertext_path AS ciphertextPath,
          encryption_algorithm AS encryptionAlgorithm, key_ref AS keyRef,
          encryption_metadata_json AS encryptionMetadataJson,
          content_digest AS contentDigest, created_at AS createdAt
        FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`,
      )
      .get(input.ref, input.ownerId, input.agentId) as
      | {
          readonly ref: string;
          readonly dataClassification: PayloadRecord["dataClassification"];
          readonly contentType: string | null;
          readonly storageKind: "sqlite_blob" | "ciphertext_file";
          readonly ciphertext: Uint8Array | null;
          readonly ciphertextPath: string | null;
          readonly encryptionAlgorithm: string | null;
          readonly keyRef: string | null;
          readonly encryptionMetadataJson: string | null;
          readonly contentDigest: string;
          readonly createdAt: string;
        }
      | undefined;
    if (!row) return undefined;
    const encryption = row.encryptionMetadataJson
      ? (JSON.parse(row.encryptionMetadataJson) as PayloadRecord["encryption"])
      : {
          algorithm: row.encryptionAlgorithm ?? "unknown",
          keyRef: row.keyRef ?? "unknown",
        };
    return {
      ref: row.ref,
      dataClassification: row.dataClassification,
      contentType: row.contentType ?? "application/octet-stream",
      ciphertext: row.ciphertext ? new Uint8Array(row.ciphertext) : new Uint8Array(),
      encryption,
      storage:
        row.storageKind === "ciphertext_file" && row.ciphertextPath
          ? {
              kind: "ciphertext_file",
              relativePath: row.ciphertextPath,
              ciphertextDigest: encryption.ciphertextDigest ?? "unknown",
            }
          : { kind: "inline" },
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.ownerId,
        request.agentId,
        request.runId,
        request.revision,
        request.status,
        "finalRisk" in request && typeof request.finalRisk === "string"
          ? request.finalRisk.toLowerCase()
          : "low",
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

  private listApprovals(input: { ownerId: string; agentId: string }): readonly ApprovalRequest[] {
    return parseRecords<ApprovalRequest>(
      this.database
        .prepare(
          `SELECT record_json AS recordJson FROM approval_requests
          WHERE owner_id = ? AND agent_id = ? ORDER BY requested_at, id`,
        )
        .all(input.ownerId, input.agentId) as JsonRow[],
    );
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
        ...(input.recentAuthenticationRef !== undefined
          ? { recentAuthenticationRef: input.recentAuthenticationRef }
          : {}),
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
    const transaction = this.database.transaction(() => {
      if (input.usageId) {
        const replay = this.database
          .prepare("SELECT 1 FROM authorization_usage WHERE id = ? AND grant_id = ?")
          .get(input.usageId, input.grantId);
        if (replay) {
          const record = this.grantRow(input.grantId);
          if (!record) this.fail("PORT_NOT_FOUND", `Grant ${input.grantId} not found`);
          return record;
        }
      }
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
      )
        this.fail("PORT_INVALID_OPERATION", `Grant ${current.id} is not consumable`);
      const consumed: GrantRecord = {
        ...current,
        revision: current.revision + 1,
        uses: current.uses + 1,
        spentCostMicros: current.spentCostMicros + input.costMicros,
      };
      this.updateGrant(consumed);
      if (input.usageId && input.operation) {
        this.database
          .prepare(
            `INSERT INTO authorization_usage (id, grant_id, run_id, operation, cost_micros, used_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.usageId,
            input.grantId,
            input.runId ?? null,
            input.operation,
            input.costMicros,
            input.consumedAt,
          );
        const usagePayloadRef = `metadata:${input.usageId}`;
        this.ensureMetadataPayload(
          current.ownerId,
          current.agentId,
          usagePayloadRef,
          input.consumedAt,
        );
        this.database
          .prepare(
            `INSERT INTO reliable_events (
              id, owner_id, agent_id, idempotency_key, topic, payload_ref,
              publication_state, occurred_at
            ) VALUES (?, ?, ?, ?, 'authorization.grant_consumed', ?, 'pending', ?)`,
          )
          .run(
            `event:${input.usageId}`,
            current.ownerId,
            current.agentId,
            input.usageId,
            usagePayloadRef,
            input.consumedAt,
          );
        this.database
          .prepare(
            `INSERT INTO audit_records (
              id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at
            ) VALUES (?, ?, ?, 'authorization.grant_consumed', ?, 'completed', NULL, ?)`,
          )
          .run(
            `audit:${input.usageId}`,
            current.ownerId,
            current.agentId,
            current.id,
            input.consumedAt,
          );
        if (input.runId) {
          const run = this.database
            .prepare(
              `SELECT session_id AS sessionId, thread_id AS threadId
              FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?`,
            )
            .get(input.runId, current.ownerId, current.agentId) as
            | { sessionId: string; threadId: string | null }
            | undefined;
          if (!run)
            this.fail("PORT_INVALID_OPERATION", `Run ${input.runId} is outside Grant scope`);
          const sequence = Number(
            this.database
              .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 FROM trace_events WHERE run_id = ?")
              .pluck()
              .get(input.runId),
          );
          this.database
            .prepare(
              `INSERT INTO trace_events (
                id, owner_id, agent_id, session_id, thread_id, run_id, turn_id,
                sequence, event_type, classification, payload_ref, occurred_at, recorded_at
              ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'authorization.grant_consumed',
                'private', ?, ?, ?)`,
            )
            .run(
              `trace:${input.usageId}`,
              current.ownerId,
              current.agentId,
              run.sessionId,
              run.threadId,
              input.runId,
              sequence,
              usagePayloadRef,
              input.consumedAt,
              input.consumedAt,
            );
        }
      }
      return consumed;
    });
    return transaction.immediate();
  }

  private revokeGrant(input: {
    grantId: string;
    revokedAt: string;
    reasonCode: string;
    expectedRevision?: number;
  }): GrantRecord {
    this.assertDiskHeadroom();
    const current = this.grantRow(input.grantId);
    if (!current) this.fail("PORT_NOT_FOUND", `Grant ${input.grantId} not found`);
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
      this.fail("PORT_CONFLICT", `Grant ${current.id} has a stale revision`);
    }
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

  private getGovernanceMutationReceipt(input: {
    ownerId: string;
    agentId: string;
    idempotencyKey: string;
  }): GovernanceMutationReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, idempotency_key AS idempotencyKey,
          revision, command_type AS commandType, semantic_fingerprint AS semanticFingerprint,
          phase, result_ref AS resultRef, started_at AS startedAt, committed_at AS committedAt
        FROM governance_mutation_receipts
        WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(input.ownerId, input.agentId, input.idempotencyKey) as
      | GovernanceMutationReceiptRow
      | undefined;
    return row ? governanceReceiptFromRow(row) : undefined;
  }

  private createGovernanceMutationReceipt(
    receipt: GovernanceMutationReceipt,
  ): GovernanceMutationReceipt {
    this.assertDiskHeadroom();
    if (
      receipt.revision !== 1 ||
      receipt.phase !== "executing" ||
      receipt.resultRef !== null ||
      receipt.committedAt !== null ||
      !receipt.commandType ||
      !receipt.semanticFingerprint
    ) {
      this.fail("PORT_INVALID_OPERATION", "Governance receipt must begin in executing phase");
    }
    try {
      this.database
        .prepare(
          `INSERT INTO governance_mutation_receipts (
            owner_id, agent_id, idempotency_key, revision, command_type,
            semantic_fingerprint, phase, result_ref, started_at, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.ownerId,
          receipt.agentId,
          receipt.idempotencyKey,
          receipt.revision,
          receipt.commandType,
          receipt.semanticFingerprint,
          receipt.phase,
          receipt.resultRef,
          receipt.startedAt,
          receipt.committedAt,
        );
    } catch (error) {
      if (String((error as { readonly code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
        this.fail("PORT_DUPLICATE", `Governance receipt ${receipt.idempotencyKey} exists`, {
          idempotencyKey: receipt.idempotencyKey,
        });
      }
      throw error;
    }
    return receipt;
  }

  private completeGovernanceMutationReceipt(input: {
    receipt: GovernanceMutationReceipt;
    expectedRevision: number;
  }): GovernanceMutationReceipt {
    this.assertDiskHeadroom();
    const current = this.getGovernanceMutationReceipt(input.receipt);
    if (!current) this.fail("PORT_NOT_FOUND", "Governance receipt not found");
    if (current.phase === "completed") {
      if (
        current.commandType === input.receipt.commandType &&
        current.semanticFingerprint === input.receipt.semanticFingerprint &&
        current.resultRef === input.receipt.resultRef
      ) {
        return current;
      }
      this.fail("PORT_CONFLICT", "Governance receipt was completed with a different result");
    }
    if (
      current.revision !== input.expectedRevision ||
      input.receipt.revision !== current.revision + 1 ||
      input.receipt.phase !== "completed" ||
      input.receipt.resultRef === null ||
      input.receipt.committedAt === null ||
      current.commandType !== input.receipt.commandType ||
      current.semanticFingerprint !== input.receipt.semanticFingerprint ||
      current.startedAt !== input.receipt.startedAt
    ) {
      this.fail("PORT_CONFLICT", "Governance receipt completion is stale or changed", {
        idempotencyKey: input.receipt.idempotencyKey,
      });
    }
    const result = this.database
      .prepare(
        `UPDATE governance_mutation_receipts
        SET revision = ?, phase = 'completed', result_ref = ?, committed_at = ?
        WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?
          AND revision = ? AND phase = 'executing'`,
      )
      .run(
        input.receipt.revision,
        input.receipt.resultRef,
        input.receipt.committedAt,
        input.receipt.ownerId,
        input.receipt.agentId,
        input.receipt.idempotencyKey,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      this.fail("PORT_CONFLICT", "Governance receipt completion lost its revision race", {
        idempotencyKey: input.receipt.idempotencyKey,
      });
    }
    return input.receipt;
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

  private invalidateCapabilityAuthority(input: {
    ownerId: string;
    agentId: string;
    record: CapabilityRegistryRecord;
    expectedRevision: number;
    revokedAt: string;
  }): CapabilityRegistryRecord {
    const transaction = this.database.transaction(() => {
      const saved = this.saveCapability(input);
      this.revokeCapabilityHandlesCore({
        ownerId: input.ownerId,
        agentId: input.agentId,
        capabilityRef: input.record.ref,
        revokedAt: input.revokedAt,
      });
      const jobs = this.database
        .prepare(
          `SELECT id, revision, record_json AS recordJson FROM scheduled_jobs
          WHERE owner_id = ? AND agent_id = ? AND status != 'revoked'
            AND json_extract(record_json, '$.capabilityRef') = ?`,
        )
        .all(input.ownerId, input.agentId, input.record.ref) as Array<{
        id: string;
        revision: number;
        recordJson: string;
      }>;
      for (const job of jobs) {
        const record = JSON.parse(job.recordJson) as Record<string, unknown>;
        this.database
          .prepare(
            `UPDATE scheduled_jobs SET status = 'revoked', revision = revision + 1,
              next_occurrence_at = NULL, record_json = ? WHERE id = ? AND revision = ?`,
          )
          .run(
            JSON.stringify({
              ...record,
              revision: job.revision + 1,
              status: "cancelled",
              revokedAt: input.revokedAt,
              nextRunAt: null,
            }),
            job.id,
            job.revision,
          );
      }
      return saved;
    });
    return transaction.immediate();
  }

  private switchCapabilityVersion(input: {
    ownerId: string;
    agentId: string;
    record: CapabilityRegistryRecord;
    expectedRevision: number;
    switchedAt: string;
  }): CapabilityRegistryRecord {
    const transaction = this.database.transaction(() => {
      const saved = this.saveCapability(input);
      this.revokeCapabilityHandlesCore({
        ownerId: input.ownerId,
        agentId: input.agentId,
        capabilityRef: input.record.ref,
        revokedAt: input.switchedAt,
      });
      return saved;
    });
    return transaction.immediate();
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

  private consumeCapabilityHandle(
    input: ConsumeCapabilityExecutionHandleInput,
  ): GovernedCapabilityExecutionHandle {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT record_json AS recordJson FROM capability_handles WHERE id = ?")
        .get(input.handleRef) as JsonRow | undefined;
      const current = parseRecord<GovernedCapabilityExecutionHandle>(row);
      if (!current || current.handleVersion !== "capability-handle.v2") {
        this.fail("PORT_NOT_FOUND", `Capability handle ${input.handleRef} not found`);
      }
      if (current.idempotencyKeys.includes(input.idempotencyKey)) return current;
      if (
        current.revision !== input.expectedRevision ||
        current.revokedAt !== null ||
        current.workerEndedAt !== null ||
        input.consumedAt >= current.expiresAt ||
        current.authorityFence !== input.authorityFence ||
        current.uses >= current.maxUses ||
        current.spentCostMicros + input.costMicros > current.maxTotalCostMicros
      )
        this.fail("PORT_CONFLICT", `Capability handle ${input.handleRef} is not consumable`);
      const consumed: GovernedCapabilityExecutionHandle = {
        ...current,
        revision: current.revision + 1,
        uses: current.uses + 1,
        spentCostMicros: current.spentCostMicros + input.costMicros,
        idempotencyKeys: [...current.idempotencyKeys, input.idempotencyKey],
      };
      this.database
        .prepare("UPDATE capability_handles SET status = ?, record_json = ? WHERE id = ?")
        .run(
          consumed.uses >= consumed.maxUses ? "consumed" : "active",
          JSON.stringify(consumed),
          consumed.ref,
        );
      return consumed;
    });
    return transaction.immediate();
  }

  private revokeCapabilityHandles(input: {
    ownerId: string;
    agentId: string;
    capabilityRef: string;
    revokedAt: string;
  }): number {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => this.revokeCapabilityHandlesCore(input));
    return transaction.immediate();
  }

  private endRunCapabilityHandles(input: {
    ownerId: string;
    agentId: string;
    runId: string;
    endedAt: string;
  }): number {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT capability_handles.record_json AS recordJson
          FROM capability_handles JOIN capability_declarations
            ON capability_declarations.id = capability_handles.capability_id
          WHERE capability_handles.run_id = ? AND capability_declarations.owner_id = ?
            AND capability_declarations.agent_id = ? AND capability_handles.status = 'active'`,
        )
        .all(input.runId, input.ownerId, input.agentId) as JsonRow[];
      for (const row of rows) {
        const current = parseRecord<GovernedCapabilityExecutionHandle>(row);
        if (!current || current.workerEndedAt !== null) continue;
        const ended: GovernedCapabilityExecutionHandle = {
          ...current,
          revision: current.revision + 1,
          workerEndedAt: input.endedAt,
        };
        this.database
          .prepare("UPDATE capability_handles SET status = 'revoked', record_json = ? WHERE id = ?")
          .run(JSON.stringify(ended), current.ref);
      }
      return rows.length;
    });
    return transaction.immediate();
  }

  private revokeCapabilityHandlesCore(input: {
    ownerId: string;
    agentId: string;
    capabilityRef: string;
    revokedAt: string;
  }): number {
    const rows = this.database
      .prepare(
        `SELECT capability_handles.record_json AS recordJson
       FROM capability_handles JOIN capability_declarations
       ON capability_declarations.id = capability_handles.capability_id
       WHERE capability_handles.capability_id = ? AND capability_declarations.owner_id = ?
       AND capability_declarations.agent_id = ? AND capability_handles.status = 'active'`,
      )
      .all(input.capabilityRef, input.ownerId, input.agentId) as JsonRow[];
    for (const row of rows) {
      const current = parseRecord<CapabilityExecutionHandle>(row);
      if (!current || current.revokedAt !== null) continue;
      const revoked = { ...current, revokedAt: input.revokedAt };
      this.database
        .prepare(
          "UPDATE capability_handles SET status = 'revoked', revoked_at = ?, record_json = ? WHERE id = ?",
        )
        .run(input.revokedAt, JSON.stringify(revoked), current.ref);
    }
    return rows.length;
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
        stored.status === "cancelled" ? "revoked" : stored.status,
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

  private readBackgroundJob(jobId: JobId): BackgroundJobState | undefined {
    const job = this.readJob(jobId);
    if (!job) return undefined;
    return {
      id: job.id as JobId,
      ownerId: job.ownerId,
      agentId: job.agentId,
      threadId: job.threadId,
      revision: job.revision,
      status: job.status === "cancelled" ? "revoked" : job.status,
      authorizationRef: job.authorizationRef,
      nextOccurrenceAt: job.status === "cancelled" ? null : job.nextRunAt,
    };
  }

  private saveBackgroundJob(input: {
    job: BackgroundJobState;
    expectedRevision: number;
  }): BackgroundJobState {
    this.assertDiskHeadroom();
    const current = this.readJob(input.job.id);
    if (!current) this.fail("PORT_NOT_FOUND", `Background job ${input.job.id} not found`);
    if (
      current.revision !== input.expectedRevision ||
      input.job.revision !== input.expectedRevision + 1 ||
      current.ownerId !== input.job.ownerId ||
      current.agentId !== input.job.agentId ||
      current.authorizationRef !== input.job.authorizationRef
    ) {
      this.fail("PORT_CONFLICT", `Background job ${input.job.id} has a stale revision or scope`);
    }
    const status: ScheduledJob["status"] =
      input.job.status === "revoked" ? "cancelled" : input.job.status;
    const stored: ScheduledJob = {
      ...current,
      revision: input.job.revision,
      status,
      nextRunAt: input.job.nextOccurrenceAt ?? current.nextRunAt,
    };
    this.database
      .prepare(
        `UPDATE scheduled_jobs SET revision = ?, status = ?, next_occurrence_at = ?,
          record_json = ? WHERE id = ?`,
      )
      .run(
        stored.revision,
        input.job.status,
        input.job.nextOccurrenceAt,
        JSON.stringify(stored),
        input.job.id,
      );
    return input.job;
  }

  private githubInstallationRow(installationRef: string): GitHubInstallationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, agent_id AS agentId,
          provider_installation_id AS providerInstallationId, secret_ref AS secretRef,
          status, created_at AS createdAt
        FROM github_installations WHERE id = ?`,
      )
      .get(installationRef) as GitHubInstallationRecord | undefined;
    return row
      ? {
          ...row,
          ownerId: row.ownerId as GitHubInstallationRecord["ownerId"],
          agentId: row.agentId as GitHubInstallationRecord["agentId"],
        }
      : undefined;
  }

  private readGitHubInstallation(installationRef: string): GitHubInstallationRecord | undefined {
    return this.githubInstallationRow(installationRef);
  }

  private saveGitHubInstallation(record: GitHubInstallationRecord): GitHubInstallationRecord {
    this.assertDiskHeadroom();
    if (
      record.id.length === 0 ||
      record.providerInstallationId.length === 0 ||
      record.secretRef.length === 0
    ) {
      this.fail("PORT_INVALID_OPERATION", "GitHub installation metadata is incomplete");
    }
    const current = this.githubInstallationRow(record.id);
    if (current && (current.ownerId !== record.ownerId || current.agentId !== record.agentId)) {
      this.fail("PORT_CONFLICT", `GitHub installation ${record.id} cannot change scope`);
    }
    const providerOwner = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, agent_id AS agentId
        FROM github_installations WHERE provider_installation_id = ?`,
      )
      .get(record.providerInstallationId) as
      | { readonly id: string; readonly ownerId: string; readonly agentId: string }
      | undefined;
    if (
      providerOwner &&
      (providerOwner.id !== record.id ||
        providerOwner.ownerId !== record.ownerId ||
        providerOwner.agentId !== record.agentId)
    ) {
      this.fail("PORT_CONFLICT", "GitHub provider installation is already bound elsewhere");
    }
    this.database
      .prepare(
        `INSERT INTO github_installations (
          id, owner_id, agent_id, provider_installation_id, secret_ref, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_installation_id = excluded.provider_installation_id,
          secret_ref = excluded.secret_ref, status = excluded.status`,
      )
      .run(
        record.id,
        record.ownerId,
        record.agentId,
        record.providerInstallationId,
        record.secretRef,
        record.status,
        record.createdAt,
      );
    return record;
  }

  private githubMonitorRow(monitorId: JobId): GitHubRepositoryMonitor | undefined {
    const row = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, agent_id AS agentId,
          installation_id AS installationRef, provider_repository_id AS repositoryRef,
          revision, status, authorization_ref AS authorizationRef,
          enabled_events_ref AS enabledEventsRef
        FROM github_repository_monitors WHERE id = ?`,
      )
      .get(monitorId) as
      | {
          readonly id: string;
          readonly ownerId: string;
          readonly agentId: string;
          readonly installationRef: string;
          readonly repositoryRef: string;
          readonly revision: number;
          readonly status: GitHubRepositoryMonitor["status"];
          readonly authorizationRef: string;
          readonly enabledEventsRef: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as JobId,
      ownerId: row.ownerId as GitHubRepositoryMonitor["ownerId"],
      agentId: row.agentId as GitHubRepositoryMonitor["agentId"],
      revision: row.revision,
      installationRef: row.installationRef,
      repositoryRef: row.repositoryRef,
      // The protected payload is intentionally opaque to SQLite. Callers use this
      // reference as the durable event-configuration binding.
      enabledEventRefs: [row.enabledEventsRef],
      authorizationRef: row.authorizationRef,
      status: row.status,
    };
  }

  private readGitHubMonitor(monitorId: JobId): GitHubRepositoryMonitor | undefined {
    return this.githubMonitorRow(monitorId);
  }

  private saveGitHubMonitor(input: {
    monitor: GitHubRepositoryMonitor;
    expectedRevision: number | null;
  }): GitHubRepositoryMonitor {
    this.assertDiskHeadroom();
    const monitor = input.monitor;
    if (monitor.revision < 0 || monitor.enabledEventRefs.length === 0) {
      this.fail("PORT_INVALID_OPERATION", `GitHub monitor ${monitor.id} is incomplete`);
    }
    const current = this.githubMonitorRow(monitor.id);
    if ((current?.revision ?? null) !== input.expectedRevision) {
      this.fail("PORT_CONFLICT", `GitHub monitor ${monitor.id} revision conflict`);
    }
    if (
      current &&
      (current.ownerId !== monitor.ownerId ||
        current.agentId !== monitor.agentId ||
        current.installationRef !== monitor.installationRef ||
        current.repositoryRef !== monitor.repositoryRef)
    ) {
      this.fail("PORT_CONFLICT", `GitHub monitor ${monitor.id} cannot change scope`);
    }
    const installation = this.githubInstallationRow(monitor.installationRef);
    if (
      !installation ||
      installation.ownerId !== monitor.ownerId ||
      installation.agentId !== monitor.agentId ||
      (installation.status !== "active" && monitor.status === "active")
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        `GitHub installation ${monitor.installationRef} is not active`,
      );
    }
    this.assertPayloadScope(monitor.enabledEventRefs[0] ?? "", monitor.ownerId, monitor.agentId);
    this.database
      .prepare(
        `INSERT INTO github_repository_monitors (
          id, owner_id, agent_id, installation_id, provider_repository_id, revision,
          status, authorization_ref, enabled_events_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
          status = excluded.status, authorization_ref = excluded.authorization_ref,
          enabled_events_ref = excluded.enabled_events_ref`,
      )
      .run(
        monitor.id,
        monitor.ownerId,
        monitor.agentId,
        monitor.installationRef,
        monitor.repositoryRef,
        monitor.revision,
        monitor.status,
        monitor.authorizationRef,
        monitor.enabledEventRefs[0],
      );
    return monitor;
  }

  private githubReceiptRow(
    providerDeliveryId: string,
    installationRef?: string,
  ): GitHubWebhookReceiptRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT r.id AS id, r.owner_id AS ownerId, r.agent_id AS agentId,
          r.provider_delivery_id AS providerDeliveryId, r.installation_id AS installationRef,
          m.provider_repository_id AS repositoryRef, r.event_name AS eventName, r.action,
          r.payload_ref AS payloadRef, r.status, r.occurrence_id AS occurrenceId,
          r.received_at AS receivedAt
        FROM github_webhook_receipts AS r
        JOIN github_repository_monitors AS m ON m.id = r.repository_monitor_id
        WHERE r.provider_delivery_id = ?
          AND (? IS NULL OR r.installation_id = ?)
        ORDER BY r.received_at, r.id LIMIT 1`,
      )
      .get(providerDeliveryId, installationRef ?? null, installationRef ?? null) as
      | GitHubWebhookReceiptRecord
      | undefined;
    if (!row) return undefined;
    return {
      ...row,
      id: row.id as GitHubWebhookReceiptRecord["id"],
      ownerId: row.ownerId as GitHubWebhookReceiptRecord["ownerId"],
      agentId: row.agentId as GitHubWebhookReceiptRecord["agentId"],
      occurrenceId: row.occurrenceId as GitHubWebhookReceiptRecord["occurrenceId"],
    };
  }

  private assertGitHubReceiptScope(receipt: GitHubWebhookReceiptRecord): void {
    const installation = this.githubInstallationRow(receipt.installationRef);
    const monitorRow = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, installation_id AS installationRef,
          provider_repository_id AS repositoryRef
        FROM github_repository_monitors WHERE provider_repository_id = ?
          AND installation_id = ? LIMIT 1`,
      )
      .get(receipt.repositoryRef, receipt.installationRef) as
      | {
          readonly ownerId: string;
          readonly agentId: string;
          readonly installationRef: string;
          readonly repositoryRef: string;
        }
      | undefined;
    if (
      !installation ||
      installation.ownerId !== receipt.ownerId ||
      installation.agentId !== receipt.agentId ||
      !monitorRow ||
      monitorRow.ownerId !== receipt.ownerId ||
      monitorRow.agentId !== receipt.agentId ||
      monitorRow.installationRef !== receipt.installationRef ||
      monitorRow.repositoryRef !== receipt.repositoryRef
    ) {
      this.fail("PORT_INVALID_OPERATION", "GitHub webhook receipt is outside installation scope");
    }
    this.assertPayloadScope(receipt.payloadRef, receipt.ownerId, receipt.agentId);
  }

  private readGitHubReceipt(
    providerDeliveryId: string,
    installationRef?: string,
  ): GitHubWebhookReceiptRecord | undefined {
    return this.githubReceiptRow(providerDeliveryId, installationRef);
  }

  private recordGitHubReceipt(receipt: GitHubWebhookReceiptRecord): GitHubWebhookReceiptRecord {
    this.assertDiskHeadroom();
    this.assertGitHubReceiptScope(receipt);
    const existing = this.githubReceiptRow(receipt.providerDeliveryId, receipt.installationRef);
    if (existing) {
      if (
        existing.ownerId !== receipt.ownerId ||
        existing.agentId !== receipt.agentId ||
        existing.installationRef !== receipt.installationRef ||
        existing.repositoryRef !== receipt.repositoryRef ||
        existing.payloadRef !== receipt.payloadRef
      ) {
        this.fail("PORT_CONFLICT", "GitHub delivery ID was reused outside its original scope");
      }
      return existing;
    }
    const monitor = this.database
      .prepare(
        `SELECT id FROM github_repository_monitors
        WHERE installation_id = ? AND provider_repository_id = ?
          AND owner_id = ? AND agent_id = ? LIMIT 1`,
      )
      .get(receipt.installationRef, receipt.repositoryRef, receipt.ownerId, receipt.agentId) as
      | { readonly id: string }
      | undefined;
    if (!monitor) this.fail("PORT_INVALID_OPERATION", "GitHub monitor scope is not registered");
    this.database
      .prepare(
        `INSERT INTO github_webhook_receipts (
          id, owner_id, agent_id, installation_id, repository_monitor_id,
          provider_delivery_id, event_name, action, payload_ref, status,
          occurrence_id, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.ownerId,
        receipt.agentId,
        receipt.installationRef,
        monitor.id,
        receipt.providerDeliveryId,
        receipt.eventName,
        receipt.action,
        receipt.payloadRef,
        receipt.status,
        receipt.occurrenceId,
        receipt.receivedAt,
      );
    return receipt;
  }

  private admitGitHubWebhook(input: {
    receipt: GitHubWebhookReceiptRecord;
    occurrence: BackgroundOccurrence;
  }): {
    receipt: GitHubWebhookReceiptRecord;
    occurrence: BackgroundOccurrence;
    replayed: boolean;
  } {
    this.assertDiskHeadroom();
    this.assertGitHubReceiptScope(input.receipt);
    if (input.receipt.status !== "received" || input.receipt.occurrenceId !== null) {
      this.fail("PORT_INVALID_OPERATION", "A new GitHub webhook admission must be received");
    }
    if (input.occurrence.stableKey.length === 0) {
      this.fail("PORT_INVALID_OPERATION", "GitHub webhook occurrence requires a stable key");
    }
    const transaction = this.database.transaction(() => {
      const existing = this.githubReceiptRow(
        input.receipt.providerDeliveryId,
        input.receipt.installationRef,
      );
      if (
        existing &&
        (existing.ownerId !== input.receipt.ownerId ||
          existing.agentId !== input.receipt.agentId ||
          existing.repositoryRef !== input.receipt.repositoryRef ||
          existing.eventName !== input.receipt.eventName)
      ) {
        this.fail("PORT_CONFLICT", "GitHub delivery ID was reused outside its original scope");
      }
      if (existing?.occurrenceId) {
        const occurrence = this.readOccurrence(existing.occurrenceId);
        if (!occurrence)
          this.fail("PORT_INVALID_OPERATION", "GitHub receipt points to missing occurrence");
        return { receipt: existing, occurrence, replayed: true };
      }
      const receipt = existing ?? this.recordGitHubReceipt(input.receipt);
      const occurrence = this.createOccurrence(input.occurrence);
      const normalized: GitHubWebhookReceiptRecord = {
        ...receipt,
        status: "normalized",
        occurrenceId: occurrence.id,
      };
      this.database
        .prepare(
          `UPDATE github_webhook_receipts SET status = 'normalized', occurrence_id = ?
          WHERE id = ?`,
        )
        .run(occurrence.id, receipt.id);
      return { receipt: normalized, occurrence, replayed: existing !== undefined };
    });
    return transaction.immediate();
  }

  private saveGitHubCoverageGap(gap: GitHubCoverageGapRecord): GitHubCoverageGapRecord {
    this.assertDiskHeadroom();
    const monitor = this.githubMonitorRow(gap.monitorId);
    if (!monitor || monitor.ownerId !== gap.ownerId || monitor.agentId !== gap.agentId) {
      this.fail("PORT_INVALID_OPERATION", `GitHub monitor ${gap.monitorId} is outside scope`);
    }
    if ((gap.status === "open") !== (gap.endedAt === null)) {
      this.fail("PORT_INVALID_OPERATION", "Open GitHub coverage gaps cannot have an end time");
    }
    const existing = this.database
      .prepare("SELECT id FROM github_coverage_gaps WHERE id = ?")
      .get(gap.id) as { readonly id: string } | undefined;
    if (existing) {
      this.database
        .prepare(
          `UPDATE github_coverage_gaps SET status = ?, reason_code = ?,
            started_at = ?, ended_at = ? WHERE id = ?`,
        )
        .run(gap.status, gap.reasonCode, gap.startedAt, gap.endedAt, gap.id);
    } else {
      this.database
        .prepare(
          `INSERT INTO github_coverage_gaps (
            id, monitor_id, owner_id, agent_id, status, reason_code,
            started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          gap.id,
          gap.monitorId,
          gap.ownerId,
          gap.agentId,
          gap.status,
          gap.reasonCode,
          gap.startedAt,
          gap.endedAt,
        );
    }
    return gap;
  }

  private listGitHubCoverageGaps(monitorId: JobId): readonly GitHubCoverageGapRecord[] {
    return this.database
      .prepare(
        `SELECT id, monitor_id AS monitorId, owner_id AS ownerId, agent_id AS agentId,
          status, reason_code AS reasonCode, started_at AS startedAt, ended_at AS endedAt
        FROM github_coverage_gaps WHERE monitor_id = ? ORDER BY started_at, id`,
      )
      .all(monitorId) as GitHubCoverageGapRecord[];
  }

  private githubHistoryRow(monitorId: JobId): GitHubHistoryRow | undefined {
    return this.database
      .prepare(
        `SELECT monitor_id AS monitorId, owner_id AS ownerId, agent_id AS agentId,
          monitor_revision AS monitorRevision, policy, status, attempt_count AS attemptCount,
          requested_by AS requestedBy, requested_at AS requestedAt, updated_at AS updatedAt,
          completed_at AS completedAt, last_error_code AS lastErrorCode,
          pending_payload_files_json AS pendingPayloadFilesJson, monitor_json AS monitorJson
        FROM github_history_policy_operations WHERE monitor_id = ?`,
      )
      .get(monitorId) as GitHubHistoryRow | undefined;
  }

  private publicGitHubHistoryOperation(row: GitHubHistoryRow): GitHubMonitorHistoryPolicyOperation {
    return Object.freeze({
      monitorId: row.monitorId as JobId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as import("@himawari-agent/domain").AgentId,
      monitorRevision: row.monitorRevision,
      policy: row.policy,
      status: row.status,
      attemptCount: row.attemptCount,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      lastErrorCode: row.lastErrorCode,
    });
  }

  private readGitHubHistoryOperation(
    monitorId: JobId,
  ): GitHubMonitorHistoryPolicyOperation | undefined {
    const row = this.githubHistoryRow(monitorId);
    return row ? this.publicGitHubHistoryOperation(row) : undefined;
  }

  private listRetryableGitHubHistoryOperations(
    limit: number,
  ): readonly GitHubMonitorHistoryPolicyOperation[] {
    assertLimit(limit, this.fail);
    return (
      this.database
        .prepare(
          `SELECT monitor_id AS monitorId, owner_id AS ownerId, agent_id AS agentId,
            monitor_revision AS monitorRevision, policy, status, attempt_count AS attemptCount,
            requested_by AS requestedBy, requested_at AS requestedAt, updated_at AS updatedAt,
            completed_at AS completedAt, last_error_code AS lastErrorCode,
            pending_payload_files_json AS pendingPayloadFilesJson, monitor_json AS monitorJson
          FROM github_history_policy_operations WHERE status = 'retry_wait'
          ORDER BY updated_at, monitor_id LIMIT ?`,
        )
        .all(limit) as GitHubHistoryRow[]
    ).map((row) => this.publicGitHubHistoryOperation(row));
  }

  private applyGitHubHistoryPolicy(input: {
    monitor: GitHubRepositoryMonitor;
    policy: "retain" | "delete";
    requestedBy: string;
    occurredAt: string;
  }): SqliteGitHubHistoryApplyResult {
    this.assertDiskHeadroom();
    if (input.monitor.status !== "revoked" || input.requestedBy.length === 0) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "GitHub history policy requires a revoked monitor and Owner identity",
      );
    }
    const durableMonitor = this.githubMonitorRow(input.monitor.id);
    if (
      !durableMonitor ||
      durableMonitor.ownerId !== input.monitor.ownerId ||
      durableMonitor.agentId !== input.monitor.agentId ||
      durableMonitor.status !== "revoked" ||
      durableMonitor.revision !== input.monitor.revision
    ) {
      this.fail("PORT_CONFLICT", `GitHub monitor ${input.monitor.id} durable revision changed`);
    }
    const existing = this.githubHistoryRow(input.monitor.id);
    if (
      existing &&
      (existing.policy !== input.policy || existing.monitorRevision !== input.monitor.revision)
    ) {
      this.fail("PORT_CONFLICT", `GitHub monitor ${input.monitor.id} history policy is immutable`);
    }
    if (existing?.status === "completed") {
      return Object.freeze({
        operation: this.publicGitHubHistoryOperation(existing),
        pendingPayloadFiles: Object.freeze([]),
      });
    }

    const attempt = (existing?.attemptCount ?? 0) + 1;
    this.database
      .prepare(
        `INSERT INTO github_history_policy_operations (
          monitor_id, owner_id, agent_id, monitor_revision, policy, status, attempt_count,
          requested_by, requested_at, updated_at, completed_at, last_error_code,
          pending_payload_files_json, monitor_json
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, '[]', ?)
        ON CONFLICT(monitor_id) DO UPDATE SET status = 'running',
          attempt_count = excluded.attempt_count, updated_at = excluded.updated_at,
          last_error_code = NULL`,
      )
      .run(
        input.monitor.id,
        input.monitor.ownerId,
        input.monitor.agentId,
        input.monitor.revision,
        input.policy,
        attempt,
        input.requestedBy,
        existing?.requestedAt ?? input.occurredAt,
        input.occurredAt,
        JSON.stringify(input.monitor),
      );

    const oldPending = existing ? (JSON.parse(existing.pendingPayloadFilesJson) as string[]) : [];
    if (oldPending.length > 0) {
      this.database
        .prepare(
          `UPDATE github_history_policy_operations SET status = 'retry_wait',
            last_error_code = 'payload_files_pending', pending_payload_files_json = ?, updated_at = ?
          WHERE monitor_id = ?`,
        )
        .run(JSON.stringify(oldPending), input.occurredAt, input.monitor.id);
      return Object.freeze({
        operation: this.readGitHubHistoryOperation(
          input.monitor.id,
        ) as GitHubMonitorHistoryPolicyOperation,
        pendingPayloadFiles: Object.freeze(oldPending),
      });
    }

    try {
      const transaction = this.database.transaction(() =>
        input.policy === "delete" ? this.deleteGitHubMonitorHistory(input.monitor) : [],
      );
      const pendingPayloadFiles = transaction.immediate();
      const status = pendingPayloadFiles.length > 0 ? "retry_wait" : "completed";
      this.database
        .prepare(
          `UPDATE github_history_policy_operations SET status = ?, updated_at = ?, completed_at = ?,
            last_error_code = ?, pending_payload_files_json = ? WHERE monitor_id = ?`,
        )
        .run(
          status,
          input.occurredAt,
          status === "completed" ? input.occurredAt : null,
          status === "completed" ? null : "payload_files_pending",
          JSON.stringify(pendingPayloadFiles),
          input.monitor.id,
        );
      return Object.freeze({
        operation: this.readGitHubHistoryOperation(
          input.monitor.id,
        ) as GitHubMonitorHistoryPolicyOperation,
        pendingPayloadFiles: Object.freeze([...pendingPayloadFiles]),
      });
    } catch (error) {
      this.database
        .prepare(
          `UPDATE github_history_policy_operations SET status = 'retry_wait', updated_at = ?,
            last_error_code = 'history_apply_failed' WHERE monitor_id = ?`,
        )
        .run(input.occurredAt, input.monitor.id);
      throw error;
    }
  }

  private finalizeGitHubHistoryPolicy(input: {
    monitorId: JobId;
    occurredAt: string;
  }): GitHubMonitorHistoryPolicyOperation {
    if (!this.githubHistoryRow(input.monitorId)) {
      this.fail("PORT_NOT_FOUND", `GitHub history operation ${input.monitorId} not found`);
    }
    this.database
      .prepare(
        `UPDATE github_history_policy_operations SET status = 'completed', updated_at = ?,
          completed_at = ?, last_error_code = NULL, pending_payload_files_json = '[]'
        WHERE monitor_id = ?`,
      )
      .run(input.occurredAt, input.occurredAt, input.monitorId);
    return this.readGitHubHistoryOperation(input.monitorId) as GitHubMonitorHistoryPolicyOperation;
  }

  private retryGitHubHistoryPolicy(input: {
    monitorId: JobId;
    occurredAt: string;
  }): SqliteGitHubHistoryApplyResult {
    const row = this.githubHistoryRow(input.monitorId);
    if (!row) this.fail("PORT_NOT_FOUND", `GitHub history operation ${input.monitorId} not found`);
    if (row.status === "completed") {
      return Object.freeze({
        operation: this.publicGitHubHistoryOperation(row),
        pendingPayloadFiles: Object.freeze([]),
      });
    }
    return this.applyGitHubHistoryPolicy({
      monitor: JSON.parse(row.monitorJson) as GitHubRepositoryMonitor,
      policy: row.policy,
      requestedBy: row.requestedBy,
      occurredAt: input.occurredAt,
    });
  }

  private failGitHubHistoryPolicy(input: {
    monitorId: JobId;
    occurredAt: string;
    errorCode: string;
  }): GitHubMonitorHistoryPolicyOperation {
    if (!this.githubHistoryRow(input.monitorId)) {
      this.fail("PORT_NOT_FOUND", `GitHub history operation ${input.monitorId} not found`);
    }
    this.database
      .prepare(
        `UPDATE github_history_policy_operations SET status = 'retry_wait', updated_at = ?,
          completed_at = NULL, last_error_code = ? WHERE monitor_id = ?`,
      )
      .run(input.occurredAt, input.errorCode, input.monitorId);
    return this.readGitHubHistoryOperation(input.monitorId) as GitHubMonitorHistoryPolicyOperation;
  }

  private deleteGitHubMonitorHistory(monitor: GitHubRepositoryMonitor): readonly string[] {
    const job = this.database
      .prepare("SELECT definition_ref AS definitionRef FROM scheduled_jobs WHERE id = ?")
      .get(monitor.id) as { definitionRef: string } | undefined;
    const runIds = this.sqlValues(
      "SELECT run_id AS value FROM job_occurrences WHERE job_id = ? AND run_id IS NOT NULL",
      [monitor.id],
    );
    const triggerIds =
      runIds.length === 0
        ? []
        : this.sqlValues(
            `SELECT trigger_id AS value FROM runs WHERE id IN (${placeholders(runIds)})`,
            runIds,
          );
    const payloadRefs: string[] = job ? [job.definitionRef] : [];
    payloadRefs.push(
      ...this.sqlValues(
        "SELECT payload_ref AS value FROM github_webhook_receipts WHERE repository_monitor_id = ?",
        [monitor.id],
      ),
    );
    if (triggerIds.length > 0) {
      payloadRefs.push(
        ...this.sqlValues(
          `SELECT payload_ref AS value FROM triggers WHERE id IN (${placeholders(triggerIds)})`,
          triggerIds,
        ),
      );
    }
    if (runIds.length > 0) {
      for (const [table, column] of [
        ["run_checkpoints", "checkpoint_ref"],
        ["approval_requests", "intent_ref"],
        ["trace_events", "payload_ref"],
        ["attention_decisions", "decision_ref"],
        ["inbox_deliveries", "result_ref"],
      ] as const) {
        payloadRefs.push(
          ...this.sqlValues(
            `SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}
            WHERE run_id IN (${placeholders(runIds)})
              AND ${quoteIdentifier(column)} IS NOT NULL`,
            runIds,
          ),
        );
      }
      const checkpointIds = this.sqlValues(
        `SELECT DISTINCT checkpoint_job_id AS value FROM thread_checkpoint_sources
        WHERE source_ref IN (${placeholders(runIds)})`,
        runIds,
      );
      if (checkpointIds.length > 0) {
        payloadRefs.push(
          ...this.sqlValues(
            `SELECT summary_ref AS value FROM thread_checkpoint_jobs
            WHERE id IN (${placeholders(checkpointIds)}) AND summary_ref IS NOT NULL`,
            checkpointIds,
          ),
          ...this.sqlValues(
            `SELECT content_ref AS value FROM thread_summaries WHERE generation_id IN
            (SELECT id FROM memory_generations WHERE checkpoint_job_id IN (${placeholders(checkpointIds)}))`,
            checkpointIds,
          ),
          ...this.sqlValues(
            `SELECT content_ref AS value FROM thread_derivative_candidates WHERE generation_id IN
            (SELECT id FROM memory_generations WHERE checkpoint_job_id IN (${placeholders(checkpointIds)}))
            AND content_ref IS NOT NULL`,
            checkpointIds,
          ),
        );
        this.database
          .prepare(
            `DELETE FROM thread_checkpoint_jobs WHERE id IN (${placeholders(checkpointIds)})`,
          )
          .run(...checkpointIds);
      }
      this.database
        .prepare(
          `UPDATE memory_provenance SET source_deleted = 1
          WHERE source_id IN (${placeholders(runIds)})`,
        )
        .run(...runIds);
    }

    this.database
      .prepare("DELETE FROM github_webhook_receipts WHERE repository_monitor_id = ?")
      .run(monitor.id);
    this.database.prepare("DELETE FROM github_coverage_gaps WHERE monitor_id = ?").run(monitor.id);
    this.database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(monitor.id);
    if (runIds.length > 0) {
      this.database
        .prepare(`DELETE FROM runs WHERE id IN (${placeholders(runIds)})`)
        .run(...runIds);
    }
    if (triggerIds.length > 0) {
      this.database
        .prepare(`DELETE FROM triggers WHERE id IN (${placeholders(triggerIds)})`)
        .run(...triggerIds);
    }
    for (const ref of [monitor.id, ...runIds]) {
      const escaped = ref.replaceAll("%", "\\%").replaceAll("_", "\\_");
      this.database
        .prepare("DELETE FROM product_state_records WHERE key = ? OR key LIKE ? ESCAPE '\\'")
        .run(ref, `${escaped}:%`);
      this.database
        .prepare("DELETE FROM command_results WHERE state_key = ? OR state_key LIKE ? ESCAPE '\\'")
        .run(ref, `${escaped}:%`);
    }
    const uniqueRefs = [...new Set(payloadRefs)];
    if (uniqueRefs.length > 0) {
      this.database
        .prepare(`DELETE FROM reliable_events WHERE payload_ref IN (${placeholders(uniqueRefs)})`)
        .run(...uniqueRefs);
    }
    const files: string[] = [];
    for (const ref of uniqueRefs) {
      if (this.isPayloadReferenced(ref)) continue;
      const payload = this.database
        .prepare(
          `SELECT storage_kind AS storageKind, ciphertext_path AS ciphertextPath
          FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(ref, monitor.ownerId, monitor.agentId) as
        | { storageKind: string; ciphertextPath: string | null }
        | undefined;
      if (!payload) continue;
      this.database.prepare("DELETE FROM payloads WHERE ref = ?").run(ref);
      if (payload.storageKind === "ciphertext_file" && payload.ciphertextPath) {
        files.push(payload.ciphertextPath);
      }
    }
    return Object.freeze([...new Set(files)]);
  }

  private sqlValues(sql: string, parameters: readonly unknown[]): string[] {
    return (this.database.prepare(sql).all(...parameters) as Array<{ value: string }>).map(
      ({ value }) => value,
    );
  }

  private isPayloadReferenced(ref: string): boolean {
    const tables = this.database
      .prepare(
        "SELECT name FROM pragma_table_list WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const foreignKeys = this.database
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
        .all() as Array<{ table: string; from: string }>;
      for (const foreignKey of foreignKeys) {
        if (foreignKey.table !== "payloads") continue;
        const count = Number(
          this.database
            .prepare(
              `SELECT COUNT(*) FROM ${quoteIdentifier(name)}
              WHERE ${quoteIdentifier(foreignKey.from)} = ?`,
            )
            .pluck()
            .get(ref),
        );
        if (count > 0) return true;
      }
    }
    return false;
  }

  private occurrenceSelect(): string {
    return `SELECT id, job_id AS jobId, owner_id AS ownerId, agent_id AS agentId,
      revision, stable_key AS stableKey, status, deployment_id AS deploymentId,
      authority_epoch AS authorityEpoch, fencing_token AS fencingToken, category,
      data_classification AS dataClassification, foreground, parallel_safe AS parallelSafe,
      estimated_cost_micros AS estimatedCostMicros,
      reserved_cost_micros AS reservedCostMicros, spent_cost_micros AS spentCostMicros,
      attempt_count AS attemptCount, next_retry_at AS nextRetryAt, deadline_at AS deadlineAt,
      run_id AS runId, work_lease_id AS workLeaseId,
      work_lease_holder_id AS workLeaseHolderId,
      work_lease_acquired_at AS workLeaseAcquiredAt,
      work_lease_expires_at AS workLeaseExpiresAt, last_error_code AS lastErrorCode,
      record_json AS recordJson FROM job_occurrences`;
  }

  private occurrenceFromRow(row: BackgroundOccurrenceRow): BackgroundOccurrence {
    if (row.recordJson) return JSON.parse(row.recordJson) as BackgroundOccurrence;
    const hasLease =
      row.workLeaseId !== null &&
      row.workLeaseHolderId !== null &&
      row.workLeaseAcquiredAt !== null &&
      row.workLeaseExpiresAt !== null;
    return {
      id: row.id as OccurrenceId,
      jobId: row.jobId as JobId,
      ownerId: row.ownerId as BackgroundOccurrence["ownerId"],
      agentId: row.agentId as BackgroundOccurrence["agentId"],
      revision: row.revision,
      stableKey: row.stableKey,
      status: row.status,
      authority: {
        deploymentId: row.deploymentId as ProductAuthorityFence["deploymentId"],
        authorityEpoch: row.authorityEpoch,
        fencingToken: row.fencingToken,
      },
      category: row.category,
      dataClassification: row.dataClassification,
      foreground: row.foreground === 1,
      parallelSafe: row.parallelSafe === 1,
      estimatedCostMicros: row.estimatedCostMicros,
      reservedCostMicros: row.reservedCostMicros,
      spentCostMicros: row.spentCostMicros,
      attemptCount: row.attemptCount,
      nextRetryAt: row.nextRetryAt,
      deadlineAt: row.deadlineAt,
      runId: row.runId as BackgroundOccurrence["runId"],
      workLease: hasLease
        ? {
            id: row.workLeaseId as string,
            holderId: row.workLeaseHolderId as string,
            acquiredAt: row.workLeaseAcquiredAt as string,
            expiresAt: row.workLeaseExpiresAt as string,
          }
        : null,
      lastErrorCode: row.lastErrorCode,
    };
  }

  private readOccurrence(occurrenceId: OccurrenceId): BackgroundOccurrence | undefined {
    const row = this.database
      .prepare(`${this.occurrenceSelect()} WHERE id = ?`)
      .get(occurrenceId) as BackgroundOccurrenceRow | undefined;
    return row ? this.occurrenceFromRow(row) : undefined;
  }

  private readOccurrenceByStableKey(
    jobId: JobId,
    stableKey: string,
  ): BackgroundOccurrence | undefined {
    const row = this.database
      .prepare(`${this.occurrenceSelect()} WHERE job_id = ? AND stable_key = ?`)
      .get(jobId, stableKey) as BackgroundOccurrenceRow | undefined;
    return row ? this.occurrenceFromRow(row) : undefined;
  }

  private assertBackgroundFence(
    ownerId: string,
    agentId: string,
    fence: ProductAuthorityFence,
  ): void {
    const current = this.database
      .prepare(
        `SELECT status, authority_epoch AS authorityEpoch, fencing_token AS fencingToken
        FROM deployments WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(fence.deploymentId, ownerId, agentId) as
      | { readonly status: string; readonly authorityEpoch: number; readonly fencingToken: number }
      | undefined;
    if (
      !current ||
      current.status !== "active" ||
      current.authorityEpoch !== fence.authorityEpoch ||
      current.fencingToken !== fence.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Background work carries a stale authority fence", {
        deploymentId: fence.deploymentId,
      });
    }
  }

  private assertOccurrenceShape(occurrence: BackgroundOccurrence): void {
    const nonNegative = [
      occurrence.revision,
      occurrence.estimatedCostMicros,
      occurrence.reservedCostMicros,
      occurrence.spentCostMicros,
      occurrence.attemptCount,
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
    const deadline = new Date(occurrence.deadlineAt);
    if (
      !nonNegative ||
      occurrence.revision < 1 ||
      occurrence.stableKey.length === 0 ||
      occurrence.stableKey.length > 512 ||
      occurrence.category.length === 0 ||
      occurrence.category.length > 64 ||
      Number.isNaN(deadline.valueOf()) ||
      deadline.toISOString() !== occurrence.deadlineAt
    ) {
      this.fail("PORT_INVALID_OPERATION", `Background occurrence ${occurrence.id} is invalid`);
    }
  }

  private createOccurrence(occurrence: BackgroundOccurrence): BackgroundOccurrence {
    this.assertDiskHeadroom();
    this.assertOccurrenceShape(occurrence);
    this.assertBackgroundFence(occurrence.ownerId, occurrence.agentId, occurrence.authority);
    const duplicate = this.readOccurrenceByStableKey(occurrence.jobId, occurrence.stableKey);
    if (duplicate) return duplicate;
    if (this.readOccurrence(occurrence.id)) {
      this.fail("PORT_CONFLICT", `Background occurrence ${occurrence.id} already exists`);
    }
    const job = this.readJob(occurrence.jobId);
    if (!job || job.ownerId !== occurrence.ownerId || job.agentId !== occurrence.agentId) {
      this.fail("PORT_INVALID_OPERATION", `Background job ${occurrence.jobId} is outside scope`);
    }
    if (
      occurrence.status !== "queued" ||
      occurrence.runId !== null ||
      occurrence.workLease !== null ||
      occurrence.reservedCostMicros !== 0 ||
      occurrence.spentCostMicros !== 0 ||
      occurrence.attemptCount !== 0
    ) {
      this.fail("PORT_INVALID_OPERATION", "A new background occurrence must start queued");
    }
    this.database
      .prepare(
        `INSERT INTO job_occurrences (
          id, job_id, owner_id, agent_id, revision, stable_key, status, deployment_id,
          authority_epoch, fencing_token, category, data_classification, foreground,
          parallel_safe, estimated_cost_micros, reserved_cost_micros, spent_cost_micros,
          attempt_count, next_retry_at, deadline_at, run_id, work_lease_id,
          work_lease_holder_id, work_lease_acquired_at, work_lease_expires_at,
          last_error_code, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurrence.id,
        occurrence.jobId,
        occurrence.ownerId,
        occurrence.agentId,
        occurrence.revision,
        occurrence.stableKey,
        occurrence.status,
        occurrence.authority.deploymentId,
        occurrence.authority.authorityEpoch,
        occurrence.authority.fencingToken,
        occurrence.category,
        occurrence.dataClassification,
        occurrence.foreground ? 1 : 0,
        occurrence.parallelSafe ? 1 : 0,
        occurrence.estimatedCostMicros,
        occurrence.reservedCostMicros,
        occurrence.spentCostMicros,
        occurrence.attemptCount,
        occurrence.nextRetryAt,
        occurrence.deadlineAt,
        occurrence.runId,
        null,
        null,
        null,
        null,
        occurrence.lastErrorCode,
        JSON.stringify(occurrence),
      );
    return occurrence;
  }

  private writeOccurrence(occurrence: BackgroundOccurrence): void {
    this.database
      .prepare(
        `UPDATE job_occurrences SET revision = ?, status = ?, deployment_id = ?,
          authority_epoch = ?, fencing_token = ?, category = ?, data_classification = ?,
          foreground = ?, parallel_safe = ?, estimated_cost_micros = ?,
          reserved_cost_micros = ?, spent_cost_micros = ?, attempt_count = ?,
          next_retry_at = ?, deadline_at = ?, run_id = ?, work_lease_id = ?,
          work_lease_holder_id = ?, work_lease_acquired_at = ?, work_lease_expires_at = ?,
          last_error_code = ?, record_json = ? WHERE id = ?`,
      )
      .run(
        occurrence.revision,
        occurrence.status,
        occurrence.authority.deploymentId,
        occurrence.authority.authorityEpoch,
        occurrence.authority.fencingToken,
        occurrence.category,
        occurrence.dataClassification,
        occurrence.foreground ? 1 : 0,
        occurrence.parallelSafe ? 1 : 0,
        occurrence.estimatedCostMicros,
        occurrence.reservedCostMicros,
        occurrence.spentCostMicros,
        occurrence.attemptCount,
        occurrence.nextRetryAt,
        occurrence.deadlineAt,
        occurrence.runId,
        occurrence.workLease?.id ?? null,
        occurrence.workLease?.holderId ?? null,
        occurrence.workLease?.acquiredAt ?? null,
        occurrence.workLease?.expiresAt ?? null,
        occurrence.lastErrorCode,
        JSON.stringify(occurrence),
        occurrence.id,
      );
  }

  private saveOccurrence(input: {
    occurrence: BackgroundOccurrence;
    expectedRevision: number;
  }): BackgroundOccurrence {
    this.assertDiskHeadroom();
    this.assertOccurrenceShape(input.occurrence);
    const current = this.readOccurrence(input.occurrence.id);
    if (!current) this.fail("PORT_NOT_FOUND", `Occurrence ${input.occurrence.id} not found`);
    if (
      current.revision !== input.expectedRevision ||
      input.occurrence.revision !== input.expectedRevision + 1 ||
      current.jobId !== input.occurrence.jobId ||
      current.ownerId !== input.occurrence.ownerId ||
      current.agentId !== input.occurrence.agentId ||
      current.stableKey !== input.occurrence.stableKey
    ) {
      this.fail("PORT_CONFLICT", `Occurrence ${input.occurrence.id} has a stale revision or scope`);
    }
    this.assertBackgroundFence(
      input.occurrence.ownerId,
      input.occurrence.agentId,
      input.occurrence.authority,
    );
    this.writeOccurrence(input.occurrence);
    return input.occurrence;
  }

  private reserveBackgroundAdmission(
    input: BackgroundAdmissionReservation,
  ): BackgroundAdmissionResult {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.readOccurrence(input.occurrenceId);
      if (!current) this.fail("PORT_NOT_FOUND", `Occurrence ${input.occurrenceId} not found`);
      this.assertBackgroundFence(current.ownerId, current.agentId, input.authority);
      if (
        current.status === "completed" ||
        current.status === "failed_terminal" ||
        current.status === "missed" ||
        ((current.status === "admitted" || current.status === "running") &&
          current.runId === input.runId)
      ) {
        return {
          occurrence: current,
          outcome: "duplicate" as const,
          reasonCode: "ALREADY_ADMITTED" as const,
        };
      }
      if (current.revision !== input.expectedRevision) {
        this.fail("PORT_CONFLICT", `Occurrence ${input.occurrenceId} revision conflict`);
      }
      if (current.status === "retry_wait" && current.lastErrorCode === "EXTERNAL_RESULT_UNKNOWN") {
        return {
          occurrence: current,
          outcome: "reconcile_required" as const,
          reasonCode: "EXTERNAL_RESULT_RECONCILIATION_REQUIRED" as const,
        };
      }
      if (current.status === "blocked_credentials") {
        return {
          occurrence: current,
          outcome: "blocked" as const,
          reasonCode: "CREDENTIALS_BLOCKED" as const,
        };
      }
      if (current.status === "blocked_approval") {
        return {
          occurrence: current,
          outcome: "blocked" as const,
          reasonCode:
            current.lastErrorCode === "MODEL_BLOCKED"
              ? ("MODEL_BLOCKED" as const)
              : ("AUTHORIZATION_BLOCKED" as const),
        };
      }
      if (
        current.status === "retry_wait" &&
        current.nextRetryAt !== null &&
        current.nextRetryAt > input.admittedAt
      ) {
        return {
          occurrence: current,
          outcome: "blocked" as const,
          reasonCode: "RETRY_NOT_DUE" as const,
        };
      }
      if (
        !["queued", "retry_wait", "budget_blocked", "capacity_blocked"].includes(current.status)
      ) {
        this.fail("PORT_INVALID_OPERATION", `Occurrence ${input.occurrenceId} cannot be admitted`);
      }
      const admittedAt = new Date(input.admittedAt);
      if (Number.isNaN(admittedAt.valueOf()) || admittedAt.toISOString() !== input.admittedAt) {
        this.fail("PORT_INVALID_OPERATION", "Background admission time is invalid");
      }
      if (input.admittedAt >= current.deadlineAt) {
        const expired: BackgroundOccurrence = {
          ...current,
          revision: current.revision + 1,
          status: "failed_terminal",
          authority: input.authority,
          runId: input.runId,
          reservedCostMicros: 0,
          nextRetryAt: null,
          lastErrorCode: "DEADLINE_EXCEEDED",
        };
        this.writeOccurrence(expired);
        return {
          occurrence: expired,
          outcome: "deadline_exceeded" as const,
          reasonCode: "DEADLINE_EXCEEDED" as const,
        };
      }
      const limits = input.limits;
      const positiveCapacity =
        Number.isSafeInteger(limits.totalRuns) &&
        limits.totalRuns > 0 &&
        Number.isSafeInteger(limits.foregroundReserved) &&
        limits.foregroundReserved >= 0 &&
        limits.foregroundReserved <= limits.totalRuns;
      const budgets = [
        limits.globalCostMicros,
        limits.perRunCostMicros,
        limits.perClassificationCostMicros.public,
        limits.perClassificationCostMicros.private,
        limits.perClassificationCostMicros.sensitive,
        limits.perClassificationCostMicros.restricted,
      ];
      if (
        !positiveCapacity ||
        !budgets.every((value) => Number.isSafeInteger(value) && value >= 0)
      ) {
        this.fail("PORT_INVALID_OPERATION", "Background admission limits are invalid");
      }
      let reasonCode: BackgroundAdmissionResult["reasonCode"] | null = null;
      const activeForJob = this.database
        .prepare(
          `SELECT COUNT(*) FROM job_occurrences WHERE job_id = ? AND id <> ?
            AND run_id IS NOT NULL AND status IN (
              'admitted', 'running', 'retry_wait', 'blocked_credentials', 'blocked_approval'
            )`,
        )
        .pluck()
        .get(current.jobId, current.id) as number;
      const unsafeActiveForJob = this.database
        .prepare(
          `SELECT COUNT(*) FROM job_occurrences WHERE job_id = ? AND id <> ?
            AND run_id IS NOT NULL AND parallel_safe = 0 AND status IN (
              'admitted', 'running', 'retry_wait', 'blocked_credentials', 'blocked_approval'
            )`,
        )
        .pluck()
        .get(current.jobId, current.id) as number;
      if ((!current.parallelSafe || unsafeActiveForJob > 0) && activeForJob > 0) {
        reasonCode = "JOB_ALREADY_ACTIVE";
      }

      const capacity = this.database
        .prepare(
          `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN foreground = 0 THEN 1 ELSE 0 END), 0) AS background
          FROM job_occurrences WHERE owner_id = ? AND agent_id = ?
            AND status IN ('admitted', 'running')`,
        )
        .get(current.ownerId, current.agentId) as {
        readonly total: number;
        readonly background: number;
      };
      if (!reasonCode && capacity.total >= limits.totalRuns) {
        reasonCode = "TOTAL_CAPACITY_EXHAUSTED";
      }
      if (
        !reasonCode &&
        !current.foreground &&
        capacity.background >= limits.totalRuns - limits.foregroundReserved
      ) {
        reasonCode = "FOREGROUND_CAPACITY_RESERVED";
      }
      const categoryLimit = limits.perCategory[current.category];
      if (categoryLimit !== undefined) {
        if (!Number.isSafeInteger(categoryLimit) || categoryLimit < 0) {
          this.fail("PORT_INVALID_OPERATION", `Category ${current.category} limit is invalid`);
        }
        const categoryActive = this.database
          .prepare(
            `SELECT COUNT(*) FROM job_occurrences WHERE owner_id = ? AND agent_id = ?
              AND category = ? AND status IN ('admitted', 'running')`,
          )
          .pluck()
          .get(current.ownerId, current.agentId, current.category) as number;
        if (!reasonCode && categoryActive >= categoryLimit) {
          reasonCode = "CATEGORY_CAPACITY_EXHAUSTED";
        }
      }

      const usage = this.database
        .prepare(
          `SELECT COALESCE(SUM(reserved_cost_micros + spent_cost_micros), 0) AS globalUsed,
            COALESCE(SUM(CASE WHEN data_classification = ?
              THEN reserved_cost_micros + spent_cost_micros ELSE 0 END), 0) AS classificationUsed
          FROM job_occurrences WHERE owner_id = ? AND agent_id = ? AND id <> ?`,
        )
        .get(current.dataClassification, current.ownerId, current.agentId, current.id) as {
        readonly globalUsed: number;
        readonly classificationUsed: number;
      };
      if (
        !reasonCode &&
        current.spentCostMicros + current.estimatedCostMicros > limits.perRunCostMicros
      ) {
        reasonCode = "RUN_BUDGET_EXCEEDED";
      }
      if (
        !reasonCode &&
        usage.globalUsed + current.spentCostMicros + current.estimatedCostMicros >
          limits.globalCostMicros
      ) {
        reasonCode = "GLOBAL_BUDGET_EXHAUSTED";
      }
      if (
        !reasonCode &&
        usage.classificationUsed + current.spentCostMicros + current.estimatedCostMicros >
          limits.perClassificationCostMicros[current.dataClassification]
      ) {
        reasonCode = "CLASSIFICATION_BUDGET_EXHAUSTED";
      }

      const blockedByBudget =
        reasonCode === "RUN_BUDGET_EXCEEDED" ||
        reasonCode === "GLOBAL_BUDGET_EXHAUSTED" ||
        reasonCode === "CLASSIFICATION_BUDGET_EXHAUSTED";
      const stored: BackgroundOccurrence = {
        ...current,
        revision: current.revision + 1,
        status: reasonCode ? (blockedByBudget ? "budget_blocked" : "capacity_blocked") : "admitted",
        authority: input.authority,
        runId: input.runId,
        reservedCostMicros: reasonCode ? 0 : current.estimatedCostMicros,
        nextRetryAt: null,
        lastErrorCode: reasonCode,
      };
      this.writeOccurrence(stored);
      const result: BackgroundAdmissionResult = {
        occurrence: stored,
        outcome: reasonCode
          ? blockedByBudget
            ? ("budget_blocked" as const)
            : ("capacity_blocked" as const)
          : ("admitted" as const),
        reasonCode: reasonCode ?? "ADMITTED",
      };
      return result;
    });
    return transaction.immediate();
  }

  private claimOccurrence(input: BackgroundOccurrenceClaim): BackgroundOccurrence {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.readOccurrence(input.occurrenceId);
      if (!current) this.fail("PORT_NOT_FOUND", `Occurrence ${input.occurrenceId} not found`);
      this.assertBackgroundFence(current.ownerId, current.agentId, input.authority);
      if (current.revision !== input.expectedRevision) {
        this.fail("PORT_CONFLICT", `Occurrence ${input.occurrenceId} revision conflict`);
      }
      const claimedAt = new Date(input.claimedAt);
      const expiresAt = new Date(input.expiresAt);
      if (
        Number.isNaN(claimedAt.valueOf()) ||
        claimedAt.toISOString() !== input.claimedAt ||
        Number.isNaN(expiresAt.valueOf()) ||
        expiresAt.toISOString() !== input.expiresAt ||
        expiresAt <= claimedAt ||
        input.expiresAt > current.deadlineAt
      ) {
        this.fail("PORT_INVALID_OPERATION", "Background work lease is invalid");
      }
      const reclaiming =
        current.status === "running" &&
        current.workLease !== null &&
        current.workLease.expiresAt <= input.claimedAt;
      if (current.status !== "admitted" && !reclaiming) {
        this.fail("PORT_CONFLICT", `Occurrence ${input.occurrenceId} is not claimable`);
      }
      const claimed: BackgroundOccurrence = {
        ...current,
        revision: current.revision + 1,
        status: "running",
        authority: input.authority,
        attemptCount: current.attemptCount + 1,
        workLease: {
          id: input.leaseId,
          holderId: input.holderId,
          acquiredAt: input.claimedAt,
          expiresAt: input.expiresAt,
        },
        lastErrorCode: reclaiming ? "WORK_LEASE_EXPIRED" : null,
      };
      this.writeOccurrence(claimed);
      return claimed;
    });
    return transaction.immediate();
  }

  private settleOccurrence(input: BackgroundOccurrenceSettlement): BackgroundOccurrence {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.readOccurrence(input.occurrenceId);
      if (!current) this.fail("PORT_NOT_FOUND", `Occurrence ${input.occurrenceId} not found`);
      this.assertBackgroundFence(current.ownerId, current.agentId, input.authority);
      if (
        current.revision !== input.expectedRevision ||
        current.status !== "running" ||
        current.workLease?.id !== input.leaseId
      ) {
        this.fail("PORT_CONFLICT", `Occurrence ${input.occurrenceId} cannot settle`);
      }
      if (!Number.isSafeInteger(input.spentCostMicros) || input.spentCostMicros < 0) {
        this.fail("PORT_INVALID_OPERATION", "Background settlement cost is invalid");
      }
      const settledAt = new Date(input.settledAt);
      if (Number.isNaN(settledAt.valueOf()) || settledAt.toISOString() !== input.settledAt) {
        this.fail("PORT_INVALID_OPERATION", "Background settlement time is invalid");
      }
      let status: BackgroundOccurrence["status"];
      let nextRetryAt: string | null = null;
      let errorCode = input.errorCode;
      if (input.outcome === "completed" && input.spentCostMicros <= current.reservedCostMicros) {
        status = "completed";
        errorCode = null;
      } else if (input.outcome === "model_blocked") {
        status = "blocked_approval";
        errorCode = input.errorCode ?? "MODEL_BLOCKED";
      } else if (input.outcome === "external_result_unknown") {
        status = "retry_wait";
        errorCode = input.errorCode ?? "EXTERNAL_RESULT_UNKNOWN";
      } else if (input.spentCostMicros > current.reservedCostMicros) {
        status = "failed_terminal";
        errorCode = "RUN_BUDGET_EXCEEDED";
      } else if (input.failureClass === "credential") {
        status = "blocked_credentials";
      } else if (input.failureClass === "authorization") {
        status = "blocked_approval";
      } else if (input.failureClass === "policy" || input.failureClass === "invalid_input") {
        status = "failed_terminal";
      } else if (input.failureClass === "transport" || input.failureClass === "provider") {
        const retry = input.retry;
        const retryValid =
          Number.isSafeInteger(retry.maxAttempts) &&
          retry.maxAttempts >= 1 &&
          Number.isSafeInteger(retry.baseDelayMs) &&
          retry.baseDelayMs >= 1 &&
          Number.isSafeInteger(retry.maxDelayMs) &&
          retry.maxDelayMs >= retry.baseDelayMs &&
          Number.isSafeInteger(retry.jitterSeed) &&
          retry.jitterSeed >= 0;
        if (!retryValid) this.fail("PORT_INVALID_OPERATION", "Retry policy is invalid");
        const exponential = Math.min(
          retry.maxDelayMs,
          retry.baseDelayMs * 2 ** Math.max(0, current.attemptCount - 1),
        );
        const jitter = Math.floor((exponential * (retry.jitterSeed % 201)) / 1000);
        const retryAt = new Date(settledAt.valueOf() + exponential + jitter);
        if (
          current.attemptCount < retry.maxAttempts &&
          retryAt.toISOString() < current.deadlineAt
        ) {
          status = "retry_wait";
          nextRetryAt = retryAt.toISOString();
        } else {
          status = "failed_terminal";
        }
      } else {
        status = "failed_terminal";
      }
      const settled: BackgroundOccurrence = {
        ...current,
        revision: current.revision + 1,
        status,
        authority: input.authority,
        reservedCostMicros: 0,
        spentCostMicros: current.spentCostMicros + input.spentCostMicros,
        nextRetryAt,
        workLease: null,
        lastErrorCode: errorCode,
      };
      this.writeOccurrence(settled);
      return settled;
    });
    return transaction.immediate();
  }

  private listOccurrencesByJob(input: {
    jobId: JobId;
    limit: number;
  }): readonly BackgroundOccurrence[] {
    assertLimit(input.limit, this.fail);
    return (
      this.database
        .prepare(`${this.occurrenceSelect()} WHERE job_id = ? ORDER BY id LIMIT ?`)
        .all(input.jobId, input.limit) as BackgroundOccurrenceRow[]
    ).map((row) => this.occurrenceFromRow(row));
  }

  private listRecoverableOccurrences(input: {
    ownerId: string;
    agentId: string;
    now: string;
    limit: number;
  }): readonly BackgroundOccurrence[] {
    assertLimit(input.limit, this.fail);
    return (
      this.database
        .prepare(
          `${this.occurrenceSelect()} WHERE owner_id = ? AND agent_id = ? AND (
            status IN ('queued', 'admitted', 'blocked_credentials', 'blocked_approval',
              'budget_blocked', 'capacity_blocked')
            OR (status = 'retry_wait' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            OR (status = 'running' AND work_lease_expires_at <= ?)
          ) ORDER BY deadline_at, id LIMIT ?`,
        )
        .all(
          input.ownerId,
          input.agentId,
          input.now,
          input.now,
          input.limit,
        ) as BackgroundOccurrenceRow[]
    ).map((row) => this.occurrenceFromRow(row));
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

  private identityBindingFromRow(
    row: IdentityBindingRow | undefined,
  ): OwnerIdentityBindingRecord | undefined {
    return row
      ? {
          ownerId: row.ownerId as OwnerId,
          externalSubjectRef: row.externalSubjectRef,
          boundAt: row.boundAt,
          status: row.status,
        }
      : undefined;
  }

  private bindFirstOwner(input: {
    ownerId: string;
    externalSubjectRef: string;
    boundAt: string;
  }): OwnerIdentityBindingRecord {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const bindingCount = (
        this.database.prepare("SELECT COUNT(*) AS count FROM owner_identity_bindings").get() as {
          readonly count: number;
        }
      ).count;
      if (bindingCount !== 0) {
        this.fail("PORT_CONFLICT", "Owner bootstrap has already been consumed");
      }
      const owners = this.database.prepare("SELECT id FROM owners ORDER BY id LIMIT 2").all() as {
        readonly id: string;
      }[];
      if (owners.length > 1 || (owners.length === 1 && owners[0]?.id !== input.ownerId)) {
        this.fail("PORT_CONFLICT", "Owner bootstrap requires one stable product Owner");
      }
      if (owners.length === 0) {
        this.database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(input.ownerId);
      }
      this.database
        .prepare(
          `INSERT INTO owner_identity_bindings (
            owner_id, external_subject_ref, bound_at, status
          ) VALUES (?, ?, ?, 'active')`,
        )
        .run(input.ownerId, input.externalSubjectRef, input.boundAt);
      return this.readIdentityByOwner(input.ownerId);
    });
    const result = transaction.immediate();
    if (!result) this.fail("PORT_INVALID_OPERATION", "Owner bootstrap did not persist a binding");
    return result;
  }

  private readIdentityBySubject(
    externalSubjectRef: string,
  ): OwnerIdentityBindingRecord | undefined {
    return this.identityBindingFromRow(
      this.database
        .prepare(
          `SELECT owner_id AS ownerId, external_subject_ref AS externalSubjectRef,
            bound_at AS boundAt, status
          FROM owner_identity_bindings WHERE external_subject_ref = ?`,
        )
        .get(externalSubjectRef) as IdentityBindingRow | undefined,
    );
  }

  private readIdentityByOwner(ownerId: string): OwnerIdentityBindingRecord | undefined {
    return this.identityBindingFromRow(
      this.database
        .prepare(
          `SELECT owner_id AS ownerId, external_subject_ref AS externalSubjectRef,
            bound_at AS boundAt, status
          FROM owner_identity_bindings WHERE owner_id = ?`,
        )
        .get(ownerId) as IdentityBindingRow | undefined,
    );
  }

  private repairIdentityBinding(input: {
    ownerId: string;
    externalSubjectRef: string;
    repairedAt: string;
  }): OwnerIdentityBindingRecord {
    this.assertDiskHeadroom();
    const result = this.database
      .prepare(
        `UPDATE owner_identity_bindings
        SET external_subject_ref = ?, bound_at = ?, status = 'active'
        WHERE owner_id = ?`,
      )
      .run(input.externalSubjectRef, input.repairedAt, input.ownerId);
    if (result.changes !== 1) {
      this.fail("PORT_NOT_FOUND", `Owner identity binding ${input.ownerId} not found`);
    }
    const binding = this.readIdentityByOwner(input.ownerId);
    if (!binding) this.fail("PORT_INVALID_OPERATION", "Repaired identity binding disappeared");
    return binding;
  }

  private productDeviceFromRow(row: ProductDeviceRow | undefined): ProductDeviceRecord | undefined {
    return row
      ? {
          ...row,
          id: row.id as DeviceId,
          ownerId: row.ownerId as OwnerId,
        }
      : undefined;
  }

  private productSessionFromRow(
    row: ProductSessionRow | undefined,
  ): ProductSessionRecord | undefined {
    return row
      ? {
          ...row,
          id: row.id as SessionId,
          ownerId: row.ownerId as OwnerId,
          deviceId: row.deviceId as DeviceId,
        }
      : undefined;
  }

  private readProductSession(sessionId: string): ProductSessionRecord | undefined {
    return this.productSessionFromRow(
      this.database
        .prepare(
          `SELECT id, owner_id AS ownerId, device_id AS deviceId, revision,
            authentication_ref AS authenticationRef, status,
            first_authenticated_at AS firstAuthenticatedAt, last_active_at AS lastActiveAt,
            recent_authenticated_at AS recentAuthenticatedAt, revoked_at AS revokedAt
          FROM product_sessions WHERE id = ?`,
        )
        .get(sessionId) as ProductSessionRow | undefined,
    );
  }

  private findProductSessionByAuthenticationRef(
    authenticationRef: string,
  ): ProductSessionRecord | undefined {
    return this.productSessionFromRow(
      this.database
        .prepare(
          `SELECT id, owner_id AS ownerId, device_id AS deviceId, revision,
            authentication_ref AS authenticationRef, status,
            first_authenticated_at AS firstAuthenticatedAt, last_active_at AS lastActiveAt,
            recent_authenticated_at AS recentAuthenticatedAt, revoked_at AS revokedAt
          FROM product_sessions WHERE authentication_ref = ?`,
        )
        .get(authenticationRef) as ProductSessionRow | undefined,
    );
  }

  private listProductSessions(input: {
    ownerId: string;
    includeRevoked: boolean;
  }): readonly ProductSessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, device_id AS deviceId, revision,
          authentication_ref AS authenticationRef, status,
          first_authenticated_at AS firstAuthenticatedAt, last_active_at AS lastActiveAt,
          recent_authenticated_at AS recentAuthenticatedAt, revoked_at AS revokedAt
        FROM product_sessions
        WHERE owner_id = ? AND (? = 1 OR status = 'active')
        ORDER BY last_active_at DESC, id`,
      )
      .all(input.ownerId, input.includeRevoked ? 1 : 0) as ProductSessionRow[];
    return rows.map((row) => this.productSessionFromRow(row) as ProductSessionRecord);
  }

  private listProductDevices(input: {
    ownerId: string;
    includeRevoked: boolean;
  }): readonly ProductDeviceRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, owner_id AS ownerId, revision, label, status,
          first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
        FROM devices WHERE owner_id = ? AND (? = 1 OR status = 'active')
        ORDER BY last_seen_at DESC, id`,
      )
      .all(input.ownerId, input.includeRevoked ? 1 : 0) as ProductDeviceRow[];
    return rows.map((row) => this.productDeviceFromRow(row) as ProductDeviceRecord);
  }

  private readProductDevice(deviceId: string): ProductDeviceRecord | undefined {
    return this.productDeviceFromRow(
      this.database
        .prepare(
          `SELECT id, owner_id AS ownerId, revision, label, status,
            first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
          FROM devices WHERE id = ?`,
        )
        .get(deviceId) as ProductDeviceRow | undefined,
    );
  }

  private saveProductDevice(input: {
    device: Omit<ProductDeviceRecord, "revision">;
    expectedRevision: number | null;
  }): ProductDeviceRecord {
    this.assertDiskHeadroom();
    const current = this.readProductDevice(input.device.id);
    if (input.expectedRevision === null) {
      if (current) this.fail("PORT_DUPLICATE", `Device ${input.device.id} already exists`);
      this.database
        .prepare(
          `INSERT INTO devices (
            id, owner_id, revision, label, status, first_seen_at, last_seen_at
          ) VALUES (?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          input.device.id,
          input.device.ownerId,
          input.device.label,
          input.device.status,
          input.device.firstSeenAt,
          input.device.lastSeenAt,
        );
    } else {
      if (!current) this.fail("PORT_NOT_FOUND", `Device ${input.device.id} not found`);
      if (current.revision !== input.expectedRevision || current.ownerId !== input.device.ownerId) {
        this.fail("PORT_CONFLICT", `Device ${input.device.id} has a stale revision or scope`);
      }
      this.database
        .prepare(
          `UPDATE devices SET revision = revision + 1, label = ?, status = ?,
            first_seen_at = ?, last_seen_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(
          input.device.label,
          input.device.status,
          input.device.firstSeenAt,
          input.device.lastSeenAt,
          input.device.id,
          input.expectedRevision,
        );
    }
    const saved = this.readProductDevice(input.device.id);
    if (!saved) this.fail("PORT_INVALID_OPERATION", `Device ${input.device.id} was not persisted`);
    return saved;
  }

  private revokeProductDevice(input: {
    deviceId: string;
    expectedRevision: number;
    revokedAt: string;
  }): ProductDeviceRecord {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const current = this.readProductDevice(input.deviceId);
      if (!current) this.fail("PORT_NOT_FOUND", `Device ${input.deviceId} not found`);
      if (current.revision !== input.expectedRevision || current.status !== "active") {
        this.fail("PORT_CONFLICT", `Device ${input.deviceId} cannot be revoked`);
      }
      this.database
        .prepare(
          `UPDATE devices SET revision = revision + 1, status = 'revoked', last_seen_at = ?
          WHERE id = ? AND revision = ?`,
        )
        .run(input.revokedAt, input.deviceId, input.expectedRevision);
      this.database
        .prepare(
          `UPDATE product_sessions SET revision = revision + 1, status = 'revoked', revoked_at = ?
          WHERE device_id = ? AND status = 'active'`,
        )
        .run(input.revokedAt, input.deviceId);
      return this.readProductDevice(input.deviceId);
    });
    const revoked = transaction.immediate();
    if (!revoked) this.fail("PORT_INVALID_OPERATION", `Device ${input.deviceId} disappeared`);
    return revoked;
  }

  private saveProductSession(input: {
    session: Omit<ProductSessionRecord, "revision">;
    expectedRevision: number | null;
  }): ProductSessionRecord {
    this.assertDiskHeadroom();
    const current = this.readProductSession(input.session.id);
    const device = this.readProductDevice(input.session.deviceId);
    if (!device || device.ownerId !== input.session.ownerId || device.status !== "active") {
      this.fail("PORT_NOT_AUTHORITATIVE", "Product session requires an active Owner device");
    }
    if (input.expectedRevision === null) {
      if (current) this.fail("PORT_DUPLICATE", `Product session ${input.session.id} exists`);
      this.database
        .prepare(
          `INSERT INTO product_sessions (
            id, owner_id, device_id, revision, authentication_ref, status,
            first_authenticated_at, last_active_at, recent_authenticated_at, revoked_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session.id,
          input.session.ownerId,
          input.session.deviceId,
          input.session.authenticationRef,
          input.session.status,
          input.session.firstAuthenticatedAt,
          input.session.lastActiveAt,
          input.session.recentAuthenticatedAt,
          input.session.revokedAt,
        );
    } else {
      if (!current) this.fail("PORT_NOT_FOUND", `Product session ${input.session.id} not found`);
      if (
        current.revision !== input.expectedRevision ||
        current.ownerId !== input.session.ownerId ||
        current.deviceId !== input.session.deviceId
      ) {
        this.fail("PORT_CONFLICT", `Product session ${input.session.id} is stale or re-scoped`);
      }
      this.database
        .prepare(
          `UPDATE product_sessions SET revision = revision + 1, authentication_ref = ?,
            status = ?, first_authenticated_at = ?, last_active_at = ?,
            recent_authenticated_at = ?, revoked_at = ?
          WHERE id = ? AND revision = ?`,
        )
        .run(
          input.session.authenticationRef,
          input.session.status,
          input.session.firstAuthenticatedAt,
          input.session.lastActiveAt,
          input.session.recentAuthenticatedAt,
          input.session.revokedAt,
          input.session.id,
          input.expectedRevision,
        );
    }
    const saved = this.readProductSession(input.session.id);
    if (!saved) {
      this.fail("PORT_INVALID_OPERATION", `Product session ${input.session.id} was not persisted`);
    }
    return saved;
  }

  private revokeProductSession(input: {
    sessionId: string;
    expectedRevision: number;
    revokedAt: string;
  }): ProductSessionRecord {
    this.assertDiskHeadroom();
    const current = this.readProductSession(input.sessionId);
    if (!current || current.revision !== input.expectedRevision || current.status !== "active") {
      this.fail("PORT_CONFLICT", `Product session ${input.sessionId} cannot be revoked`);
    }
    this.database
      .prepare(
        `UPDATE product_sessions SET revision = revision + 1, status = 'revoked', revoked_at = ?
        WHERE id = ? AND revision = ?`,
      )
      .run(input.revokedAt, input.sessionId, input.expectedRevision);
    const revoked = this.readProductSession(input.sessionId);
    if (!revoked) this.fail("PORT_INVALID_OPERATION", `Product session ${input.sessionId} lost`);
    return revoked;
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
        `SELECT gateway_thread_snapshots.snapshot_json AS recordJson
        FROM gateway_thread_snapshots
        JOIN threads ON threads.id = gateway_thread_snapshots.thread_id
        WHERE gateway_thread_snapshots.thread_id = ?
          AND gateway_thread_snapshots.owner_id = ?
          AND gateway_thread_snapshots.agent_id = ?
          AND threads.status = 'open'`,
      )
      .get(query.payload.threadId, query.scope.ownerId, query.scope.agentId) as JsonRow | undefined;
    const snapshot = parseRecord<ThreadSnapshot>(row);
    if (!snapshot) this.fail("PORT_NOT_FOUND", `Thread ${query.payload.threadId} not found`);
    return snapshot;
  }

  private getRunSnapshot(query: GetRunSnapshotQuery): RunSnapshot {
    const row = this.database
      .prepare(
        `SELECT gateway_run_snapshots.snapshot_json AS recordJson
        FROM gateway_run_snapshots
        JOIN runs ON runs.id = gateway_run_snapshots.run_id
        LEFT JOIN threads ON threads.id = runs.thread_id
        WHERE gateway_run_snapshots.run_id = ?
          AND gateway_run_snapshots.owner_id = ?
          AND gateway_run_snapshots.agent_id = ?
          AND (runs.thread_id IS NULL OR threads.status = 'open')`,
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
            AND (thread_id IS NULL OR EXISTS (
              SELECT 1 FROM threads WHERE threads.id = gateway_stream_events.thread_id
                AND threads.status = 'open'
            ))
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
            AND (thread_id IS NULL OR EXISTS (
              SELECT 1 FROM threads WHERE threads.id = gateway_stream_events.thread_id
                AND threads.status = 'open'
            ))
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
