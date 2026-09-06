import type {
  AttentionStatePort,
  AuditLedgerPort,
  AuthorityFence,
  AuthorizationStorePort,
  BackgroundWorkStatePort,
  CapabilityExecutionHandleStorePort,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  CapabilityRegistryStorePort,
  GatewayReadModelPort,
  GitHubIntegrationStatePort,
  GovernanceMutationReceiptStorePort,
  MemoryProjectionJobStatePort,
  ModelBudgetPort,
  ModelInvocationIdentityPort,
  OwnerIdentityStatePort,
  PayloadStorePort,
  ProductMemoryStatePort,
  ReliableEventPort,
  ReliableEventSinkPort,
  RunCheckpointStore,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionLeaseReceipt,
  RunLifecyclePort,
  RunPayloadArtifactAuthority,
  RunPayloadArtifactPort,
  RunReconciliationCandidate,
  SchedulerPort,
  SensitiveMemoryApprovalStatePort,
  SessionDeletionStatePort,
  SessionDeviceStatePort,
  ThreadDistillationStatePort,
  ThreadRepositoryPort,
  TraceStorePort,
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
  SqliteRecoveryAuthorityScope,
  SqliteStartupRecovery,
} from "./sqlite-durable-operations.js";

export type {
  GatewayProjectionMetadata,
  ReliableEventClaim,
  SqliteRecoveryAuthorityScope,
  SqliteStartupRecovery,
};

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

  runLifecycle(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    now: () => string,
  ): RunLifecyclePort {
    return Object.freeze<RunLifecyclePort>({
      readRun: (runId) => this.context.read("runLifecycle.read", { ownerId, agentId, runId }),
      transitionRun: (input) =>
        this.context.write("runLifecycle.transition", {
          ownerId,
          agentId,
          authority,
          input,
          now: now(),
        }),
      cancelRun: (input) =>
        this.context.write("runLifecycle.cancel", {
          ownerId,
          agentId,
          authority,
          input,
          now: now(),
        }),
      completeRun: (input) =>
        this.context.write("runLifecycle.complete", {
          ownerId,
          agentId,
          authority,
          input,
          now: now(),
        }),
    });
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

  runCheckpointStore(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    now: () => string,
  ): RunCheckpointStore {
    return Object.freeze<RunCheckpointStore>({
      read: (runId) => this.context.read("runCheckpoint.read", { ownerId, agentId, runId }),
      compareAndSet: (input) =>
        this.context.write("runCheckpoint.compareAndSet", {
          ownerId,
          agentId,
          authority,
          ...input,
          updatedAt: now(),
        }),
    });
  }

  runDispatch(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: AuthorityFence,
    consumerId: string,
  ): RunDispatchPort {
    const scope = { ownerId, agentId, authority, authorityLease, consumerId };
    return Object.freeze<RunDispatchPort>({
      listClaimable: (input) =>
        this.context.read<readonly RunDispatchCandidate[]>("runDispatch.listClaimable", {
          ...scope,
          input,
        }),
      listReconciliationRequired: (input) =>
        this.context.read<readonly RunReconciliationCandidate[]>(
          "runDispatch.listReconciliationRequired",
          { ...scope, input },
        ),
      claim: (input) =>
        this.context.write<RunExecutionLeaseReceipt>("runDispatch.claim", {
          ...scope,
          input,
        }),
      renew: (input) =>
        this.context.write<RunExecutionLeaseReceipt>("runDispatch.renew", {
          ...scope,
          input,
        }),
      release: (input) =>
        this.context.write<RunExecutionLeaseReceipt>("runDispatch.release", {
          ...scope,
          input,
        }),
      assertHeld: (input) =>
        this.context.read<RunExecutionLease>("runDispatch.assertHeld", {
          ...scope,
          input,
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

  runPayloadArtifactPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: RunPayloadArtifactAuthority,
    now: () => string,
  ): RunPayloadArtifactPort {
    return Object.freeze<RunPayloadArtifactPort>({
      lookup: (input) =>
        this.context.read("runPayloadArtifact.lookup", {
          ownerId,
          agentId,
          ...input,
          authority: {
            product: authority.product,
            leaseId: authority.lease.leaseId,
            leaseFencingToken: authority.lease.fencingToken,
          },
          now: now(),
        }),
      commit: (input) =>
        this.context.write("runPayloadArtifact.commit", {
          ownerId,
          agentId,
          ...input,
          authority: {
            product: authority.product,
            leaseId: authority.lease.leaseId,
            leaseFencingToken: authority.lease.fencingToken,
          },
          now: now(),
        }),
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
      listApprovals: (ownerId, agentId) =>
        this.context.read("authorization.listApprovals", { ownerId, agentId }),
      resolveApproval: (input) => this.context.write("authorization.resolveApproval", { input }),
      listGrants: (ownerId, agentId) =>
        this.context.read("authorization.listGrants", { ownerId, agentId }),
      consumeGrant: (input) => this.context.write("authorization.consumeGrant", { input }),
      revokeGrant: (grantId, revokedAt, reasonCode, expectedRevision) =>
        this.context.write("authorization.revokeGrant", {
          grantId,
          revokedAt,
          reasonCode,
          expectedRevision,
        }),
    });
  }

  governanceMutationReceiptStore(): GovernanceMutationReceiptStorePort {
    return Object.freeze<GovernanceMutationReceiptStorePort>({
      get: (ownerId, agentId, idempotencyKey) =>
        this.context.read("governance.receipt.get", { ownerId, agentId, idempotencyKey }),
      create: (receipt) => this.context.write("governance.receipt.create", { receipt }),
      complete: (receipt, expectedRevision) =>
        this.context.write("governance.receipt.complete", { receipt, expectedRevision }),
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
      invalidateCapabilityAuthority: (record, expectedRevision, revokedAt) =>
        this.context.write("capability.invalidateAuthority", {
          ownerId,
          agentId,
          record,
          expectedRevision,
          revokedAt,
        }),
      switchCapabilityVersion: (record, expectedRevision, switchedAt) =>
        this.context.write("capability.switchVersion", {
          ownerId,
          agentId,
          record,
          expectedRevision,
          switchedAt,
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
      consumeExecutionHandle: (input) => this.context.write("capability.consumeHandle", { input }),
      revokeCapabilityHandles: (capabilityRef, revokedAt) =>
        this.context.write("capability.revokeHandles", {
          ownerId,
          agentId,
          capabilityRef,
          revokedAt,
        }),
      endRunExecutionHandles: (runId, endedAt) =>
        this.context.write("capability.endRunHandles", {
          ownerId,
          agentId,
          runId,
          endedAt,
        }),
    });
  }

  capabilityInvocationReceiptPort(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityInvocationReceiptPort {
    return Object.freeze<CapabilityInvocationReceiptPort>({
      consume: (input) =>
        this.context.write("capabilityInvocation.consume", { ownerId, agentId, input }),
      read: (input) => this.context.read("capabilityInvocation.read", { ownerId, agentId, input }),
    });
  }

  capabilityInvocationResultPort(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityInvocationResultPort {
    return Object.freeze<CapabilityInvocationResultPort>({
      lookupFrozen: (input) =>
        this.context.read("capabilityInvocationResult.lookupFrozen", {
          ownerId,
          agentId,
          input,
        }),
      observeOutput: (input) =>
        this.context.write("capabilityInvocationResult.observeOutput", {
          ownerId,
          agentId,
          input,
        }),
      lookupOutput: (input) =>
        this.context.read("capabilityInvocationResult.lookupOutput", {
          ownerId,
          agentId,
          input,
        }),
    });
  }

  modelBudgetPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: AuthorityFence,
  ): ModelBudgetPort {
    const scope = { ownerId, agentId, authority, authorityLease };
    return Object.freeze<ModelBudgetPort>({
      read: (input) => this.context.read("modelBudget.read", { scope, input }),
      reserve: (input) => this.context.write("modelBudget.reserve", { scope, input }),
      markStarted: (input) => this.context.write("modelBudget.markStarted", { scope, input }),
      settle: (input) => this.context.write("modelBudget.settle", { scope, input }),
      markUnknown: (input) => this.context.write("modelBudget.markUnknown", { scope, input }),
      releaseReserved: (input) =>
        this.context.write("modelBudget.releaseReserved", { scope, input }),
      finalize: (input) => this.context.write("modelBudget.finalize", { scope, input }),
    });
  }

  modelInvocationIdentityPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: AuthorityFence,
  ): ModelInvocationIdentityPort {
    const scope = { ownerId, agentId, authority, authorityLease };
    return Object.freeze<ModelInvocationIdentityPort>({
      begin: (input) => this.context.write("modelInvocation.begin", { scope, input }),
      markStarted: (input) => this.context.write("modelInvocation.markStarted", { scope, input }),
      releaseReserved: (input) =>
        this.context.write("modelInvocation.releaseReserved", { scope, input }),
      settle: (input) => this.context.write("modelInvocation.settle", { scope, input }),
      markUnknown: (input) => this.context.write("modelInvocation.markUnknown", { scope, input }),
      read: (input) => this.context.read("modelInvocation.read", { scope, input }),
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
      saveWithProjection: (input) => this.context.write("memory.saveWithProjection", input),
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
      latestCheckpoint: (input) => this.context.read("threadDistillation.latestCheckpoint", input),
    });
  }

  threadRepository(): ThreadRepositoryPort {
    return Object.freeze<ThreadRepositoryPort>({
      create: (input) => this.context.write("thread.create", { input }),
      read: (ownerId, agentId, threadId) =>
        this.context.read("thread.read", { ownerId, agentId, threadId }),
      update: (input) => this.context.write("thread.update", { input }),
      findReceipt: (ownerId, agentId, idempotencyKey) =>
        this.context.read("thread.findReceipt", { ownerId, agentId, idempotencyKey }),
      admitOwnerMessage: (input) => this.context.write("thread.admitOwnerMessage", { input }),
      commitAssistantMessage: (input) =>
        this.context.write("thread.commitAssistantMessage", { input }),
      fork: (input) => this.context.write("thread.fork", { input }),
      list: (query) => this.context.read("thread.list", { query }),
      listMessages: (ownerId, agentId, threadId, afterSequence, limit) =>
        this.context.read("thread.listMessages", {
          ownerId,
          agentId,
          threadId,
          afterSequence,
          limit,
        }),
      readContextSnapshot: (query) => this.context.read("thread.readContextSnapshot", { query }),
      readCommittedMessagesByIds: (query) =>
        this.context.read("thread.readCommittedMessagesByIds", { query }),
      listRuns: (ownerId, agentId, threadId) =>
        this.context.read("thread.listRuns", { ownerId, agentId, threadId }),
      listGatewayEvents: (ownerId, agentId, afterCursor, limit) =>
        this.context.read("thread.listGatewayEvents", {
          ownerId,
          agentId,
          afterCursor,
          limit,
        }),
      hasCommittedTurn: (ownerId, agentId, threadId, turnId, atOrBeforeWatermark) =>
        this.context.read("thread.hasCommittedTurn", {
          ownerId,
          agentId,
          threadId,
          turnId,
          atOrBeforeWatermark,
        }),
      projectSearch: (input) => this.context.write("thread.projectSearch", { input }),
      projectTitleSearch: (input) => this.context.write("thread.projectTitleSearch", { input }),
      search: (query) => this.context.read("thread.search", { query }),
      rebuildSearch: (ownerId, agentId, threadId, projectionVersion) =>
        this.context.write("thread.rebuildSearch", {
          ownerId,
          agentId,
          threadId,
          projectionVersion,
        }),
      inspectDeletionImpact: (ownerId, agentId, threadId) =>
        this.context.read("thread.inspectDeletionImpact", { ownerId, agentId, threadId }),
      resolveDeletionTask: (input) => this.context.write("thread.resolveDeletionTask", { input }),
      requestDeletion: (input) => this.context.write("thread.requestDeletion", { input }),
    });
  }

  githubIntegrationState(): GitHubIntegrationStatePort {
    return Object.freeze<GitHubIntegrationStatePort>({
      readInstallation: (installationRef) =>
        this.context.read("github.installation.read", { installationRef }),
      saveInstallation: (record) => this.context.write("github.installation.save", { record }),
      readMonitor: (monitorId) => this.context.read("github.monitor.read", { monitorId }),
      saveMonitor: (monitor, expectedRevision) =>
        this.context.write("github.monitor.save", { monitor, expectedRevision }),
      recordReceipt: (receipt) => this.context.write("github.receipt.record", { receipt }),
      findReceipt: (providerDeliveryId) =>
        this.context.read("github.receipt.find", { providerDeliveryId }),
      readOccurrence: (occurrenceId) =>
        this.context.read("background.readOccurrence", { occurrenceId }),
      admitWebhook: (input) => this.context.write("github.webhook.admit", input),
      saveCoverageGap: (gap) => this.context.write("github.coverage.save", { gap }),
      listCoverageGaps: (monitorId) => this.context.read("github.coverage.list", { monitorId }),
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

  recoverySnapshot(): Promise<SqliteStartupRecovery> {
    return this.context.read("recovery.inspect", {});
  }

  startupRecovery(
    scope: SqliteRecoveryAuthorityScope,
    now: string,
  ): Promise<SqliteStartupRecovery> {
    return this.context.write("recovery.run", { scope, now });
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
