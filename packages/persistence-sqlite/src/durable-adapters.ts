import type {
  AttentionStatePort,
  AuditLedgerPort,
  AuthorizationStorePort,
  CapabilityExecutionHandleStorePort,
  CapabilityRegistryStorePort,
  GatewayReadModelPort,
  PayloadStorePort,
  ReliableEventPort,
  ReliableEventSinkPort,
  SchedulerPort,
  SessionDeviceStatePort,
  SessionDeletionStatePort,
  TraceStorePort,
  BackgroundWorkStatePort,
  StateStorePort,
  OwnerIdentityStatePort,
  MemoryProjectionJobStatePort,
  ProductMemoryStatePort,
  SensitiveMemoryApprovalStatePort,
  ThreadDistillationStatePort,
} from "@himawari-agent/application";
import type { AgentId, OwnerId, ProductAuthorityFence } from "@himawari-agent/domain";
import type {
  EventSubscription,
  RunSnapshot,
  StreamEvent,
  ThreadSnapshot,
} from "@himawari-agent/gateway-contracts";
import type {
  GatewayProjectionMetadata,
  ReliableEventClaim,
  SqliteStartupRecovery,
} from "./sqlite-durable-operations.js";

export type { GatewayProjectionMetadata, ReliableEventClaim, SqliteStartupRecovery };

export interface SqliteDurableAdapterContext {
  read<TResult>(operation: string, payload: unknown): Promise<TResult>;
  write<TResult>(operation: string, payload: unknown): Promise<TResult>;
}

export interface SqliteReliableEventOutbox {
  claim(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly claimId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
    readonly limit: number;
  }): Promise<readonly ReliableEventClaim[]>;
  acknowledge(input: {
    readonly eventId: string;
    readonly claimId: string;
    readonly publishedAt: string;
    readonly acknowledgementRef: string;
  }): Promise<ReliableEventClaim["event"]>;
}

export interface SqliteReliableEventConsumerDeduplicator {
  consumeOnce(input: {
    readonly consumerId: string;
    readonly eventId: string;
    readonly processedAt: string;
  }): Promise<boolean>;
}

export interface SqliteGatewayReadModel extends GatewayReadModelPort {
  upsertThreadSnapshot(snapshot: ThreadSnapshot): Promise<ThreadSnapshot>;
  upsertRunSnapshot(snapshot: RunSnapshot): Promise<RunSnapshot>;
  appendEvent(event: StreamEvent): Promise<StreamEvent>;
  setRetentionWatermark(sequence: number, updatedAt: string): Promise<GatewayProjectionMetadata>;
  metadata(): Promise<GatewayProjectionMetadata>;
}

export class SqliteDurableAdapters {
  private readonly context: SqliteDurableAdapterContext;

  constructor(context: SqliteDurableAdapterContext) {
    this.context = context;
  }

  reliableEventPort(ownerId: OwnerId, agentId: AgentId): ReliableEventPort {
    return Object.freeze<ReliableEventPort>({
      append: (event) =>
        this.context.write("event.append", {
          ownerId,
          agentId,
          event,
        }),
      listPending: (limit) => this.context.read("event.listPending", { ownerId, agentId, limit }),
      markPublished: (eventId, publishedAt) =>
        this.context.write("event.markPublished", {
          ownerId,
          agentId,
          eventId,
          publishedAt,
        }),
    });
  }

  authoritativeRunCheckpointStore(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    now: () => string,
  ): StateStorePort {
    return Object.freeze<StateStorePort>({
      read: (key) => this.context.read("state.read", { ownerId, agentId, key }),
      compareAndSet: (input) =>
        this.context.write("state.compareAndSet", {
          ownerId,
          agentId,
          authority,
          ...input,
          updatedAt: now(),
        }),
    });
  }

  reliableEventOutbox(): SqliteReliableEventOutbox {
    return Object.freeze<SqliteReliableEventOutbox>({
      claim: (input) => this.context.write("event.claim", input),
      acknowledge: (input) => this.context.write("event.acknowledge", input),
    });
  }

  reliableEventConsumerDeduplicator(): SqliteReliableEventConsumerDeduplicator {
    return Object.freeze<SqliteReliableEventConsumerDeduplicator>({
      consumeOnce: (input) => this.context.write("event.consumeOnce", input),
    });
  }

  traceStore(): TraceStorePort {
    return Object.freeze<TraceStorePort>({
      append: (event) => this.context.write("trace.append", { event }),
      readRun: (runId, afterSequence, limit) =>
        this.context.read("trace.readRun", { runId, afterSequence, limit }),
      readSession: (sessionId, afterRecordedAt, limit) =>
        this.context.read("trace.readSession", { sessionId, afterRecordedAt, limit }),
    });
  }

  payloadStore(ownerId: OwnerId, agentId: AgentId): PayloadStorePort {
    return Object.freeze<PayloadStorePort>({
      put: (payload) => this.context.write("payload.put", { ownerId, agentId, payload }),
      get: (ref) => this.context.read("payload.get", { ownerId, agentId, ref }),
      delete: (ref) => this.context.write("payload.delete", { ownerId, agentId, ref }),
    });
  }

  auditLedger(): AuditLedgerPort {
    return Object.freeze<AuditLedgerPort>({
      append: (record) => this.context.write("audit.append", { record }),
      listByAgent: (agentId, afterId) =>
        this.context.read("audit.listByAgent", { agentId, afterId }),
    });
  }

  authorizationStore(): AuthorizationStorePort {
    return Object.freeze<AuthorizationStorePort>({
      createApproval: (request) => this.context.write("authorization.createApproval", { request }),
      findApprovalByIntent: (intentId) =>
        this.context.read("authorization.findApprovalByIntent", { intentId }),
      getApproval: (approvalRequestId) =>
        this.context.read("authorization.getApproval", { approvalRequestId }),
      resolveApproval: (input) => this.context.write("authorization.resolveApproval", { input }),
      listGrants: (ownerId, agentId) =>
        this.context.read("authorization.listGrants", { ownerId, agentId }),
      consumeGrant: (input) => this.context.write("authorization.consumeGrant", { input }),
      revokeGrant: (grantId, revokedAt, reasonCode) =>
        this.context.write("authorization.revokeGrant", { grantId, revokedAt, reasonCode }),
    });
  }

  capabilityStore(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort {
    return Object.freeze<CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort>({
      create: (record) => this.context.write("capability.create", { ownerId, agentId, record }),
      get: (capabilityRef) =>
        this.context.read("capability.get", { ownerId, agentId, capabilityRef }),
      list: () => this.context.read("capability.list", { ownerId, agentId }),
      save: (record, expectedRevision) =>
        this.context.write("capability.save", {
          ownerId,
          agentId,
          record,
          expectedRevision,
        }),
      createExecutionHandle: (handle) => this.context.write("capability.createHandle", { handle }),
      getExecutionHandle: (handleRef) =>
        this.context.read("capability.getHandle", { ownerId, agentId, handleRef }),
      revokeExecutionHandle: (handleRef, revokedAt) =>
        this.context.write("capability.revokeHandle", {
          ownerId,
          agentId,
          handleRef,
          revokedAt,
        }),
    });
  }

  scheduler(): SchedulerPort {
    return Object.freeze<SchedulerPort>({
      read: (jobId) => this.context.read("scheduler.read", { jobId }),
      upsert: (job, expectedRevision) =>
        this.context.write("scheduler.upsert", { job, expectedRevision }),
      listDue: (at, limit) => this.context.read("scheduler.listDue", { at, limit }),
      cancel: (jobId, expectedRevision) =>
        this.context.write("scheduler.cancel", { jobId, expectedRevision }),
    });
  }

  backgroundWorkState(): BackgroundWorkStatePort {
    return Object.freeze<BackgroundWorkStatePort>({
      readJob: (jobId) => this.context.read("background.readJob", { jobId }),
      saveJob: (job, expectedRevision) =>
        this.context.write("background.saveJob", { job, expectedRevision }),
      readOccurrence: (occurrenceId) =>
        this.context.read("background.readOccurrence", { occurrenceId }),
      createOccurrence: (occurrence) =>
        this.context.write("background.createOccurrence", { occurrence }),
      saveOccurrence: (occurrence, expectedRevision) =>
        this.context.write("background.saveOccurrence", { occurrence, expectedRevision }),
      reserveAdmission: (input) => this.context.write("background.reserveAdmission", { input }),
      claimOccurrence: (input) => this.context.write("background.claimOccurrence", { input }),
      settleOccurrence: (input) => this.context.write("background.settleOccurrence", { input }),
      listByJob: (jobId, limit) => this.context.read("background.listByJob", { jobId, limit }),
      listRecoverable: (ownerId, agentId, now, limit) =>
        this.context.read("background.listRecoverable", { ownerId, agentId, now, limit }),
    });
  }

  attentionState(): AttentionStatePort {
    return Object.freeze<AttentionStatePort>({
      readPolicyState: (ownerId, agentId) =>
        this.context.read("attention.readPolicy", { ownerId, agentId }),
      commitDecision: (input) => this.context.write("attention.commitDecision", { input }),
      readDelivery: (requestId) => this.context.read("attention.readDelivery", { requestId }),
      claimDelivery: (requestId, clientId, claimedAt) =>
        this.context.write("attention.claimDelivery", { requestId, clientId, claimedAt }),
      settleDelivery: (input) => this.context.write("attention.settleDelivery", { input }),
    });
  }

  sessionDeletionState(): SessionDeletionStatePort {
    return Object.freeze<SessionDeletionStatePort>({
      create: (record) => this.context.write("deletion.create", { record }),
      get: (deletionId) => this.context.read("deletion.get", { deletionId }),
      save: (record, expectedRevision) =>
        this.context.write("deletion.save", { record, expectedRevision }),
    });
  }

  ownerIdentityState(): OwnerIdentityStatePort {
    return Object.freeze<OwnerIdentityStatePort>({
      bindFirstOwner: (input) => this.context.write("identity.bindFirstOwner", input),
      readBySubject: (externalSubjectRef) =>
        this.context.read("identity.readBySubject", { externalSubjectRef }),
      readByOwner: (ownerId) => this.context.read("identity.readByOwner", { ownerId }),
      repairBinding: (input) => this.context.write("identity.repairBinding", input),
    });
  }

  sessionDeviceState(): SessionDeviceStatePort {
    return Object.freeze<SessionDeviceStatePort>({
      readSession: (sessionId) => this.context.read("identity.readSession", { sessionId }),
      findSessionByAuthenticationRef: (authenticationRef) =>
        this.context.read("identity.findSessionByAuthenticationRef", { authenticationRef }),
      listSessions: (ownerId, includeRevoked) =>
        this.context.read("identity.listSessions", { ownerId, includeRevoked }),
      listDevices: (ownerId, includeRevoked) =>
        this.context.read("identity.listDevices", { ownerId, includeRevoked }),
      saveDevice: (device, expectedRevision) =>
        this.context.write("identity.saveDevice", { device, expectedRevision }),
      revokeDevice: (deviceId, expectedRevision, revokedAt) =>
        this.context.write("identity.revokeDevice", { deviceId, expectedRevision, revokedAt }),
      saveSession: (session, expectedRevision) =>
        this.context.write("identity.saveSession", { session, expectedRevision }),
      revokeSession: (sessionId, expectedRevision, revokedAt) =>
        this.context.write("identity.revokeSession", { sessionId, expectedRevision, revokedAt }),
    });
  }

  productMemoryState(): ProductMemoryStatePort {
    return Object.freeze<ProductMemoryStatePort>({
      read: (memoryId) => this.context.read("memory.read", { memoryId }),
      readMany: (input) => this.context.read("memory.readMany", input),
      searchActive: (input) => this.context.read("memory.searchActive", input),
      save: (memory, expectedRevision) =>
        this.context.write("memory.save", { memory, expectedRevision }),
      listActive: (ownerId, agentId) =>
        this.context.read("memory.listActive", { ownerId, agentId }),
      markUsed: (memoryIds, usedAt) => this.context.write("memory.markUsed", { memoryIds, usedAt }),
    });
  }

  memoryProjectionJobs(): MemoryProjectionJobStatePort {
    return Object.freeze<MemoryProjectionJobStatePort>({
      propose: ({ job, requeueCompleted = false }) =>
        this.context.write("memoryJob.propose", { job, requeueCompleted }),
      listPending: (now, limit) => this.context.read("memoryJob.listPending", { now, limit }),
      claim: (input) => this.context.write("memoryJob.claim", input),
      complete: (input) => this.context.write("memoryJob.complete", input),
      retry: (input) => this.context.write("memoryJob.retry", input),
      listByMemory: (memoryId) => this.context.read("memoryJob.listByMemory", { memoryId }),
    });
  }

  sensitiveMemoryApprovals(): SensitiveMemoryApprovalStatePort {
    return Object.freeze<SensitiveMemoryApprovalStatePort>({
      create: (request) => this.context.write("memoryApproval.create", { request }),
      read: (requestId) => this.context.read("memoryApproval.read", { requestId }),
      resolve: (input) => this.context.write("memoryApproval.resolve", input),
      markCommitted: (input) => this.context.write("memoryApproval.markCommitted", input),
      listPending: (ownerId, threadId) =>
        this.context.read("memoryApproval.listPending", { ownerId, threadId }),
    });
  }

  threadDistillationState(): ThreadDistillationStatePort {
    return Object.freeze<ThreadDistillationStatePort>({
      request: (work) => this.context.write("threadDistillation.request", { work }),
      read: (jobId) => this.context.read("threadDistillation.read", { jobId }),
      findByIdentity: (input) => this.context.read("threadDistillation.findByIdentity", input),
      listReady: (now, limit) => this.context.write("threadDistillation.listReady", { now, limit }),
      claim: (input) => this.context.write("threadDistillation.claim", input),
      commit: (input) => this.context.write("threadDistillation.commit", input),
      retry: (input) => this.context.write("threadDistillation.retry", input),
      readOutput: (generationId) =>
        this.context.read("threadDistillation.readOutput", { generationId }),
      latestSummary: (threadId) =>
        this.context.read("threadDistillation.latestSummary", { threadId }),
    });
  }

  gatewayReadModel(): SqliteGatewayReadModel {
    const context = this.context;
    return Object.freeze<SqliteGatewayReadModel>({
      upsertThreadSnapshot: (snapshot) => context.write("gateway.upsertThread", { snapshot }),
      upsertRunSnapshot: (snapshot) => context.write("gateway.upsertRun", { snapshot }),
      appendEvent: (event) => context.write("gateway.appendEvent", { event }),
      getThreadSnapshot: (query) => context.read("gateway.getThread", { query }),
      getRunSnapshot: (query) => context.read("gateway.getRun", { query }),
      queryTrace: (query) => context.read("gateway.queryTrace", { query }),
      async *subscribe(subscription: EventSubscription): AsyncIterable<StreamEvent> {
        const events = await context.read<readonly StreamEvent[]>("gateway.subscribe", {
          subscription,
        });
        for (const event of events) yield event;
      },
      setRetentionWatermark: (sequence, updatedAt) =>
        context.write("gateway.setRetentionWatermark", { sequence, updatedAt }),
      metadata: () => context.read("gateway.metadata", {}),
    });
  }

  startupRecovery(): Promise<SqliteStartupRecovery> {
    return this.context.read("recovery.inspect", {});
  }
}

export interface SqliteReliableEventPublisherOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly outbox: SqliteReliableEventOutbox;
  readonly sink: ReliableEventSinkPort;
  readonly claimId: () => string;
  readonly now: () => string;
  readonly claimDurationMs?: number;
}

export class SqliteReliableEventPublisher {
  private readonly options: SqliteReliableEventPublisherOptions;

  constructor(options: SqliteReliableEventPublisherOptions) {
    this.options = options;
  }

  async publishBatch(limit: number): Promise<readonly ReliableEventClaim["event"][]> {
    const claimedAt = this.options.now();
    const expiresAt = new Date(
      new Date(claimedAt).valueOf() + (this.options.claimDurationMs ?? 30_000),
    ).toISOString();
    const claimId = this.options.claimId();
    const claims = await this.options.outbox.claim({
      ownerId: this.options.ownerId,
      agentId: this.options.agentId,
      claimId,
      claimedAt,
      expiresAt,
      limit,
    });
    const published = [];
    for (const claim of claims) {
      const delivery = await this.options.sink.publish(claim.event);
      published.push(
        await this.options.outbox.acknowledge({
          eventId: claim.event.id,
          claimId,
          publishedAt: this.options.now(),
          acknowledgementRef: `${delivery.outcome}:${delivery.eventId}`,
        }),
      );
    }
    return published;
  }
}
