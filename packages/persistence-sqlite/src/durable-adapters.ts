import type {
  AttentionStatePort,
  AuditLedgerPort,
  AuthorityFence,
  AuthorizationStorePort,
  AutomaticReviewStorePort,
  BackgroundWorkStatePort,
  BuiltInIdentityStatePort,
  CapabilityExecutionHandleStorePort,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  CapabilityRegistryStorePort,
  DecisionLedgerPort,
  ExecutionEnvironmentStorePort,
  ExternalMemoryProposalStorePort,
  GapCaseMarkPort,
  GatewayReadModelPort,
  GitHubIntegrationStatePort,
  GovernanceMutationReceiptStorePort,
  HomeUrgencyStorePort,
  LedgerObservationPort,
  MemoryBookStorePort,
  MemoryCaptureBacklogPort,
  MemoryCheckupStorePort,
  MemoryConsolidationStorePort,
  MemoryConversationReviewStorePort,
  MemoryEpisodeStorePort,
  MemoryIndexStorePort,
  MemoryProjectionJobStatePort,
  MemoryReminderStorePort,
  MemoryReviewStorePort,
  ModelBudgetPort,
  ModelInvocationIdentityPort,
  ModelUsageStorePort,
  MuseIntakePort,
  OwnerIdentityStatePort,
  OwnerPreferencesStorePort,
  OwnerProposalStorePort,
  OwnerRuleStorePort,
  PairedDeviceStorePort,
  PayloadStorePort,
  PerceptionStorePort,
  ProactiveStorePort,
  ProductMemoryStatePort,
  RealEvalStorePort,
  ReliableEventPort,
  ReliableEventSinkPort,
  ReviewPrereviewStorePort,
  RuleReviewOwnerStorePort,
  RuleReviewStorePort,
  RunCheckpointStore,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionLeaseReceipt,
  RunLifecyclePort,
  RunPayloadArtifactAuthority,
  RunPayloadArtifactPort,
  RunReconciliationCandidate,
  RunReconciliationPort,
  SandboxExecutionJournalPort,
  SandboxExecutionPreparationPort,
  SandboxJobJournalPort,
  SchedulerPort,
  SensitiveInterceptionStorePort,
  SensitiveMemoryApprovalStatePort,
  SessionDeletionStatePort,
  SessionDeviceStatePort,
  ThreadArtifactStorePort,
  ThreadDistillationStatePort,
  ThreadPromptBundleStorePort,
  ThreadRepositoryPort,
  TraceStorePort,
  WebPushStorePort,
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
      finishBackgroundRun: (input) =>
        this.context.write("runLifecycle.finishBackground", {
          ownerId,
          agentId,
          authority,
          input,
          now: now(),
        }),
      listBackgroundRuns: () =>
        this.context.read("runLifecycle.listBackground", { ownerId, agentId, now: now() }),
      listUnattendedRuns: (input) =>
        this.context.read("runLifecycle.listUnattended", { ownerId, agentId, ...input }),
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

  runReconciliation(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: AuthorityFence,
    consumerId: string,
  ): RunReconciliationPort {
    const scope = { ownerId, agentId, authority, authorityLease, consumerId };
    return Object.freeze<RunReconciliationPort>({
      settleExpired: (input) =>
        this.context.write("runDispatch.settleExpired", { ...scope, input }),
      quarantine: (input) => this.context.write("runDispatch.quarantine", { ...scope, input }),
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
      currentExecutionLease: (input) =>
        this.context.read<RunExecutionLease | undefined>("runDispatch.currentExecutionLease", {
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
      appendNext: (event) => this.context.write("trace.appendNext", { event }),
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

  automaticReviewStore(): AutomaticReviewStorePort {
    return Object.freeze<AutomaticReviewStorePort>({
      readDelegation: (input) => this.context.read("automaticReview.readDelegation", input),
      get: (reviewId) => this.context.read("automaticReview.get", { reviewId }),
      claim: (input) => this.context.write("automaticReview.claim", { input }),
      finish: (input) => this.context.write("automaticReview.finish", { input }),
    });
  }

  authorizationStore(): AuthorizationStorePort {
    return Object.freeze<AuthorizationStorePort>({
      isPolicyAuthorizationCurrent: async ({ ownerId, agentId, key, revision }) => {
        const state = await this.context.read<
          { revision: number; value: { enabled?: boolean } } | undefined
        >("readScopedState", { ownerId, agentId, key });
        return state?.revision === revision && state.value.enabled === true;
      },
      getAuthorizationReservation: (id) =>
        this.context.read("authorization.reservation.get", { id }),
      reserveAuthorization: (input) => this.context.write("authorization.reserve", { input }),
      releaseAuthorization: (input) => this.context.write("authorization.release", { input }),
      createApproval: (request) => this.context.write("authorization.createApproval", { request }),
      findApprovalByIntent: (intentId) =>
        this.context.read("authorization.findApprovalByIntent", { intentId }),
      getApproval: (approvalRequestId) =>
        this.context.read("authorization.getApproval", { approvalRequestId }),
      listApprovals: (ownerId, agentId, filter) =>
        this.context.read("authorization.listApprovals", {
          ownerId,
          agentId,
          status: filter?.status ?? null,
        }),
      approvalChangeMarker: (ownerId, agentId) =>
        this.context.read("authorization.approvalChangeMarker", { ownerId, agentId }),
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
      applyCapabilityUpgrades: (upgrades, upgradedAt, registrations = []) =>
        this.context.write("capability.applyUpgrades", {
          ownerId,
          agentId,
          upgrades,
          upgradedAt,
          registrations,
        }),
      createExecutionHandle: (handle, options) =>
        this.context.write("capability.createHandle", { handle, options }),
      listRunExecutionHandles: (runId, at) =>
        this.context.read("capability.listRunHandles", { ownerId, agentId, runId, at }),
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

  sandboxExecutionPreparations(
    ownerId: OwnerId,
    agentId: AgentId,
  ): SandboxExecutionPreparationPort {
    return Object.freeze<SandboxExecutionPreparationPort>({
      listRecoveryCandidates: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.listRecoveryCandidates", {
          ownerId,
          agentId,
          input,
        }),
      scheduleRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.scheduleRecovery", {
          ownerId,
          agentId,
          input,
        }),
      beginReservationRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.beginReservationRecovery", {
          ownerId,
          agentId,
          input,
        }),
      finishReservationRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.finishReservationRecovery", {
          ownerId,
          agentId,
          input,
        }),
      validatePreparation: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.validatePreparation", {
          ownerId,
          agentId,
          input,
        }),
      releaseReservation: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.releaseReservation", {
          ownerId,
          agentId,
          input,
        }),
      interruptReservation: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.interruptReservation", {
          ownerId,
          agentId,
          input,
        }),
      listRunningPrograms: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.listRunningPrograms", {
          ownerId,
          agentId,
          input,
        }),
      readRunInventory: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readRunInventory", {
          ownerId,
          agentId,
          input,
        }),
      readQueuedByInvocation: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readQueuedByInvocation", {
          ownerId,
          agentId,
          input,
        }),
      enqueue: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.enqueue", { ownerId, agentId, input }),
      rebindQueued: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.rebindQueued", {
          ownerId,
          agentId,
          input,
        }),
      cancelQueued: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.cancelQueued", {
          ownerId,
          agentId,
          input,
        }),
      reserve: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.reserve", { ownerId, agentId, input }),
      bindAndStart: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.bindAndStart", {
          ownerId,
          agentId,
          input,
        }),
      readAdmission: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readAdmission", {
          ownerId,
          agentId,
          input,
        }),
      assertResultAuthority: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.assertResultAuthority", {
          ownerId,
          agentId,
          input,
        }),
      authorizeReservationResult: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.authorizeReservationResult", {
          ownerId,
          agentId,
          input,
        }),
      readAdmissionByInvocation: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readAdmissionByInvocation", {
          ownerId,
          agentId,
          input,
        }),
      readAdmissionByResource: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readAdmissionByResource", {
          ownerId,
          agentId,
          input,
        }),
      listAdmissions: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.listAdmissions", {
          ownerId,
          agentId,
          input,
        }),
    });
  }

  executionEnvironmentStore(ownerId: OwnerId, agentId: AgentId): ExecutionEnvironmentStorePort {
    const operation = (name: keyof ExecutionEnvironmentStorePort) =>
      `capabilityInvocation.executionEnvironment.${name}`;
    return Object.freeze<ExecutionEnvironmentStorePort>({
      reserve: (input) => this.context.write(operation("reserve"), { ownerId, agentId, input }),
      beginCreate: (input) =>
        this.context.write(operation("beginCreate"), { ownerId, agentId, input }),
      recordCreated: (input) =>
        this.context.write(operation("recordCreated"), { ownerId, agentId, input }),
      recordCreateUnknown: (input) =>
        this.context.write(operation("recordCreateUnknown"), { ownerId, agentId, input }),
      linkCall: (input) => this.context.write(operation("linkCall"), { ownerId, agentId, input }),
      completeCall: (input) =>
        this.context.write(operation("completeCall"), { ownerId, agentId, input }),
      requestStop: (input) =>
        this.context.write(operation("requestStop"), { ownerId, agentId, input }),
      acknowledgeStop: (input) =>
        this.context.write(operation("acknowledgeStop"), { ownerId, agentId, input }),
      acceptRelease: (input) =>
        this.context.write(operation("acceptRelease"), { ownerId, agentId, input }),
      read: (environmentId) =>
        this.context.read(operation("read"), { ownerId, agentId, input: { environmentId } }),
      readRun: (runId) =>
        this.context.read(operation("readRun"), { ownerId, agentId, input: { runId } }),
      listLeftovers: (input) =>
        this.context.read(operation("listLeftovers"), { ownerId, agentId, input }),
    });
  }

  sandboxExecutionJournal(ownerId: OwnerId, agentId: AgentId): SandboxExecutionJournalPort {
    return Object.freeze<SandboxExecutionJournalPort>({
      admit: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.admit", { ownerId, agentId, input }),
      read: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.read", { ownerId, agentId, input }),
      listPending: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.listPending", {
          ownerId,
          agentId,
          input,
        }),
      beginRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.beginRecovery", {
          ownerId,
          agentId,
          input,
        }),
      finishRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.finishRecovery", {
          ownerId,
          agentId,
          input,
        }),
      interruptRecovery: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.interruptRecovery", {
          ownerId,
          agentId,
          input,
        }),
      start: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.start", { ownerId, agentId, input }),
      append: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.append", { ownerId, agentId, input }),
      recordOperation: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.recordOperation", {
          ownerId,
          agentId,
          input,
        }),
      readResultRecovery: (input) =>
        this.context.read("capabilityInvocation.sandboxV2.readResultRecovery", {
          ownerId,
          agentId,
          input,
        }),
      importResult: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.importResult", {
          ownerId,
          agentId,
          input,
        }),
      prepareIntent: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.prepareIntent", {
          ownerId,
          agentId,
          input,
        }),
      dispatchIntent: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.dispatchIntent", {
          ownerId,
          agentId,
          input,
        }),
      acknowledgeIntent: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.acknowledgeIntent", {
          ownerId,
          agentId,
          input,
        }),
      observeIntent: (input) =>
        this.context.write("capabilityInvocation.sandboxV2.observeIntent", {
          ownerId,
          agentId,
          input,
        }),
    });
  }

  sandboxJobJournal(ownerId: OwnerId, agentId: AgentId): SandboxJobJournalPort {
    return Object.freeze<SandboxJobJournalPort>({
      readByInvocation: (input) =>
        this.context.read("capabilityInvocation.sandboxByInvocation", { ownerId, agentId, input }),
      listPending: (input) =>
        this.context.read("capabilityInvocation.sandboxListPending", { ownerId, agentId, input }),
      admit: (input) =>
        this.context.write("capabilityInvocation.sandboxAdmit", { ownerId, agentId, input }),
      append: (input) =>
        this.context.write("capabilityInvocation.sandboxAppend", { ownerId, agentId, input }),
      read: (input) =>
        this.context.read("capabilityInvocation.sandboxRead", { ownerId, agentId, input }),
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

  builtInIdentityState(ownerId: OwnerId, agentId: AgentId): BuiltInIdentityStatePort {
    const scope = { ownerId, agentId };
    return Object.freeze<BuiltInIdentityStatePort>({
      recordFailure: (input) =>
        this.context.write("builtInIdentity.recordFailure", { ...scope, input }),
      readAccount: () => this.context.read("builtInIdentity.readAccount", scope),
      provision: (input) => this.context.write("builtInIdentity.provision", { ...scope, input }),
      reserveAttempt: (input) =>
        this.context.write("builtInIdentity.reserveAttempt", { ...scope, input }),
      issueChallenge: (input) =>
        this.context.write("builtInIdentity.issueChallenge", { ...scope, input }),
      readChallenge: (digest) =>
        this.context.read("builtInIdentity.readChallenge", { ...scope, digest }),
      finish: (input) => this.context.write("builtInIdentity.finish", { ...scope, input }),
      authenticate: (input) =>
        this.context.write("builtInIdentity.authenticate", { ...scope, input }),
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
      appendHistory: (input) => this.context.write("memory.appendHistory", input),
      listHistory: (input) => this.context.read("memory.listHistory", input),
      readHistory: (input) => this.context.read("memory.readHistory", input),
    });
  }

  memoryIndex(): MemoryIndexStorePort {
    return Object.freeze<MemoryIndexStorePort>({
      upsert: (document) => this.context.write("memoryIndex.upsert", { document }),
      delete: (memoryId) => this.context.write("memoryIndex.delete", { memoryId }),
      clearScope: (ownerId, agentId) =>
        this.context.write("memoryIndex.clearScope", { ownerId, agentId }),
      search: (input) => this.context.read("memoryIndex.search", input),
      listUnindexed: (input) => this.context.read("memoryIndex.listUnindexed", input),
    });
  }

  memoryConsolidation(): MemoryConsolidationStorePort {
    return Object.freeze<MemoryConsolidationStorePort>({
      begin: (run) => this.context.write("memoryConsolidation.begin", { run }),
      lastCompleted: (ownerId, agentId) =>
        this.context.read("memoryConsolidation.lastCompleted", { ownerId, agentId }),
      finish: (input) => this.context.write("memoryConsolidation.finish", input),
      listChanges: (input) => this.context.read("memoryConsolidation.listChanges", input),
      listHeldPairs: (input) => this.context.read("memoryConsolidation.listHeldPairs", input),
      readChange: (id) => this.context.read("memoryConsolidation.readChange", { id }),
      readBasis: (changeId) => this.context.read("memoryConsolidation.readBasis", { changeId }),
      readBasisChain: (input) => this.context.read("memoryConsolidation.readBasisChain", input),
      readDerived: (input) => this.context.read("memoryConsolidation.readDerived", input),
      markUndone: (input) => this.context.write("memoryConsolidation.markUndone", input),
    });
  }

  memoryBook(): MemoryBookStorePort {
    return Object.freeze<MemoryBookStorePort>({
      readSettings: (scope) => this.context.read("memoryBook.readSettings", scope),
      writeSettings: (input) => this.context.write("memoryBook.writeSettings", input),
      markViewed: (input) => this.context.write("memoryBook.markViewed", input),
      setProfilePin: (input) => this.context.write("memoryBook.setProfilePin", input),
      listProfilePins: (scope) => this.context.read("memoryBook.listProfilePins", scope),
      latestGeneration: (scope) => this.context.read("memoryBook.latestGeneration", scope),
      listInactive: (input) => this.context.read("memory.listInactive", input),
      listExpiredTrash: (input) => this.context.read("memoryBook.listExpiredTrash", input),
      listSubCategories: (scope) => this.context.read("memoryBook.listSubCategories", scope),
      recordPeople: (input) => this.context.write("memoryBook.recordPeople", input),
      listPeople: (scope) => this.context.read("memoryBook.listPeople", scope),
      listPersonSuggestions: (scope) =>
        this.context.read("memoryBook.listPersonSuggestions", scope),
      decidePersonSuggestion: (input) =>
        this.context.write("memoryBook.decidePersonSuggestion", input),
      createImportBatch: (input) => this.context.write("memoryBook.createImportBatch", input),
      listImportBatches: (input) => this.context.read("memoryBook.listImportBatches", input),
      markImportUndone: (input) => this.context.write("memoryBook.markImportUndone", input),
      findOwnerMessages: (input) => this.context.read("memoryBook.findOwnerMessages", input),
    });
  }

  memoryCheckup(): MemoryCheckupStorePort {
    return Object.freeze<MemoryCheckupStorePort>({
      listWeek: (input) => this.context.read("memoryCheckup.listWeek", input),
      createWeek: (input) => this.context.write("memoryCheckup.createWeek", input),
      read: (input) => this.context.read("memoryCheckup.read", input),
      recordAction: (input) => this.context.write("memoryCheckup.recordAction", input),
      recordUndo: (input) => this.context.write("memoryCheckup.recordUndo", input),
      listConfirmedSince: (input) => this.context.read("memoryCheckup.listConfirmedSince", input),
    });
  }

  reviewPrereview(): ReviewPrereviewStorePort {
    return Object.freeze<ReviewPrereviewStorePort>({
      listDone: (input) => this.context.read("reviewPrereview.listDone", input),
      listRecentFailures: (input) => this.context.read("reviewPrereview.listRecentFailures", input),
      countSince: (input) => this.context.read("reviewPrereview.countSince", input),
      ownerHistory: (input) => this.context.read("reviewPrereview.ownerHistory", input),
      listPairs: (input) => this.context.read("reviewPrereview.listPairs", input),
      record: (input) => this.context.write("reviewPrereview.record", input),
      recordFailure: (input) => this.context.write("reviewPrereview.recordFailure", input),
    });
  }

  externalMemoryProposals(): ExternalMemoryProposalStorePort {
    return Object.freeze<ExternalMemoryProposalStorePort>({
      submit: (input) => this.context.write("externalMemoryProposal.submit", input),
      read: (input) => this.context.read("externalMemoryProposal.read", input),
      listPending: (input) => this.context.read("externalMemoryProposal.listPending", input),
      decide: (input) => this.context.write("externalMemoryProposal.decide", input),
      listBatch: (input) => this.context.read("externalMemoryProposal.listBatch", input),
      listBatches: (input) => this.context.read("externalMemoryProposal.listBatches", input),
      reopenBatch: (input) => this.context.write("externalMemoryProposal.reopenBatch", input),
      dropDiscardedText: (input) =>
        this.context.write("externalMemoryProposal.dropDiscardedText", input),
    });
  }

  homeUrgency(): HomeUrgencyStorePort {
    return Object.freeze<HomeUrgencyStorePort>({
      listScores: (input) => this.context.read("homeUrgency.listScores", input),
      listRecentFailures: (input) => this.context.read("homeUrgency.listRecentFailures", input),
      countSince: (input) => this.context.read("homeUrgency.countSince", input),
      recordCall: (input) => this.context.write("homeUrgency.recordCall", input),
    });
  }

  ownerRules(): OwnerRuleStorePort {
    return Object.freeze<OwnerRuleStorePort>({
      list: (input) => this.context.read("ownerRule.list", input),
      read: (input) => this.context.read("ownerRule.read", input),
      create: (input) => this.context.write("ownerRule.create", input),
      setStatus: (input) => this.context.write("ownerRule.setStatus", input),
    });
  }

  ownerProposals(): OwnerProposalStorePort {
    return Object.freeze<OwnerProposalStorePort>({
      propose: (input) => this.context.write("ownerProposal.propose", input),
      read: (input) => this.context.write("ownerProposal.read", input),
      listPending: (input) => this.context.write("ownerProposal.listPending", input),
      decide: (input) => this.context.write("ownerProposal.decide", input),
      settledEvidence: (input) => this.context.write("ownerProposal.settledEvidence", input),
      clearEvidence: (input) => this.context.write("ownerProposal.clearEvidence", input),
    });
  }

  ruleReviews(): RuleReviewStorePort & RuleReviewOwnerStorePort {
    return Object.freeze<RuleReviewStorePort & RuleReviewOwnerStorePort>({
      listDue: (input) => this.context.read("ruleReview.listDue", input),
      resolve: (input) => this.context.write("ruleReview.resolve", input),
      recordFailure: (input) => this.context.write("ruleReview.recordFailure", input),
      listOpen: (input) => this.context.read("ruleReview.listOpen", input),
      act: (input) => this.context.write("ruleReview.act", input),
    });
  }

  memoryReviews(): MemoryReviewStorePort {
    return Object.freeze<MemoryReviewStorePort>({
      expand: (input) => this.context.write("memoryReview.expand", input),
      listOpen: (input) => this.context.read("memoryReview.listOpen", input),
      resolve: (input) => this.context.write("memoryReview.resolve", input),
      reportMissed: (input) => this.context.write("memoryReview.reportMissed", input),
      agreement: (input) => this.context.read("memoryReview.agreement", input),
    });
  }

  memoryCaptureBacklog(): MemoryCaptureBacklogPort {
    return Object.freeze<MemoryCaptureBacklogPort>({
      enqueue: (entry) => this.context.write("memoryCaptureBacklog.enqueue", { entry }),
      oldest: (input) => this.context.read("memoryCaptureBacklog.oldest", input),
      recordAttempt: (input) => this.context.write("memoryCaptureBacklog.recordAttempt", input),
      has: (generationId) => this.context.read("memoryCaptureBacklog.has", { generationId }),
      remove: (generationId) => this.context.write("memoryCaptureBacklog.remove", { generationId }),
    });
  }

  memoryConversationReviews(): MemoryConversationReviewStorePort {
    return Object.freeze<MemoryConversationReviewStorePort>({
      position: (input) => this.context.read("memoryConversationReview.position", input),
      begin: (input) => this.context.write("memoryConversationReview.begin", input),
      attachOutput: (input) => this.context.write("memoryConversationReview.attachOutput", input),
      finish: (input) => this.context.write("memoryConversationReview.finish", input),
      recordChange: (change) =>
        this.context.write("memoryConversationReview.recordChange", { change }),
      discardChange: (input) => this.context.write("memoryConversationReview.discardChange", input),
      markChangeUndone: (input) =>
        this.context.write("memoryConversationReview.markChangeUndone", input),
      read: (id) => this.context.read("memoryConversationReview.read", { id }),
      listWithChanges: (input) =>
        this.context.read("memoryConversationReview.listWithChanges", input),
      listChanges: (reviewId) =>
        this.context.read("memoryConversationReview.listChanges", { reviewId }),
      dayUsage: (input) => this.context.read("memoryConversationReview.dayUsage", input),
      markUndone: (input) => this.context.write("memoryConversationReview.markUndone", input),
    });
  }

  memoryReminders(): MemoryReminderStorePort {
    return Object.freeze<MemoryReminderStorePort>({
      schedule: (reminder) => this.context.write("memoryReminder.schedule", { reminder }),
      listDue: (input) => this.context.read("memoryReminder.listDue", input),
      countDue: (input) => this.context.read("memoryReminder.countDue", input),
      listUpcoming: (input) => this.context.read("memoryReminder.listUpcoming", input),
      read: (id) => this.context.read("memoryReminder.read", { id }),
      update: (input) => this.context.write("memoryReminder.update", input),
    });
  }
  proactive(): ProactiveStorePort {
    return Object.freeze<ProactiveStorePort>({
      readSettings: (input) => this.context.read("proactive.readSettings", input),
      writeSettings: (input) => this.context.write("proactive.writeSettings", input),
      setEnabled: (input) => this.context.write("proactive.setEnabled", input),
      readConnection: (input) => this.context.read("proactive.readConnection", input),
      saveConnection: (input) => this.context.write("proactive.saveConnection", input),
      markConnection: (input) => this.context.write("proactive.markConnection", input),
      removeSource: (input) => this.context.write("proactive.removeSource", input),
      clearRecords: (input) => this.context.write("proactive.clearRecords", input),
      readDecisionPayloads: (input) => this.context.read("proactive.readDecisionPayloads", input),
      unprocessed: (input) => this.context.read("proactive.unprocessed", input),
      readInsight: (input) => this.context.read("proactive.readInsight", input),
      record: (input) => this.context.write("proactive.record", input),
      costSince: (input) => this.context.read("proactive.costSince", input),
      listInsights: (input) => this.context.read("proactive.listInsights", input),
      listDecisions: (input) => this.context.read("proactive.listDecisions", input),
      listProcessed: (input) => this.context.read("proactive.listProcessed", input),
      reviewedCount: (input) => this.context.read("proactive.reviewedCount", input),
      updateInsight: (input) => this.context.write("proactive.updateInsight", input),
      rateDecision: (input) => this.context.write("proactive.rateDecision", input),
      rateProcessed: (input) => this.context.write("proactive.rateProcessed", input),
      markReviewed: (input) => this.context.write("proactive.markReviewed", input),
      pendingPush: (input) => this.context.read("proactive.pendingPush", input),
      listReadyPushes: (input) => this.context.read("proactive.listReadyPushes", input),
      markPushEnqueued: (input) => this.context.write("proactive.markPushEnqueued", input),
      readPush: (input) => this.context.read("proactive.readPush", input),
      readInsights: (input) => this.context.read("proactive.readInsights", input),
      previewBackoff: (input) => this.context.read("proactive.previewBackoff", input),
      listBackoff: (input) => this.context.read("proactive.listBackoff", input),
      restoreBackoff: (input) => this.context.write("proactive.restoreBackoff", input),
    });
  }
  ownerPreferences(): OwnerPreferencesStorePort {
    return Object.freeze<OwnerPreferencesStorePort>({
      read: (input) => this.context.read("ownerPreferences.read", input),
      write: (input) => this.context.write("ownerPreferences.write", input),
    });
  }

  gapCaseMarks(): GapCaseMarkPort {
    return Object.freeze<GapCaseMarkPort>({
      mark: (input) => this.context.write("decisionLedger.gapMark", input),
      unmark: (input) => this.context.write("decisionLedger.gapUnmark", input),
      list: (input) => this.context.read("decisionLedger.gapMarks", input),
    });
  }

  decisionLedger(): DecisionLedgerPort {
    return Object.freeze<DecisionLedgerPort>({
      append: (input) => this.context.write("decisionLedger.append", input),
      appendIfChanged: (input) => this.context.write("decisionLedger.appendIfChanged", input),
      list: (input) => this.context.read("decisionLedger.list", input),
      read: (input) => this.context.read("decisionLedger.read", input),
      rate: (input) => this.context.write("decisionLedger.rate", input),
      listReviewPool: (input) => this.context.read("decisionLedger.listReviewPool", input),
      rateMany: (input) => this.context.write("decisionLedger.rateMany", input),
      recordMuse: (input) => this.context.write("decisionLedger.recordMuse", input),
      listMuse: (input) => this.context.read("decisionLedger.listMuse", input),
      lastRuleUses: (input) => this.context.read("decisionLedger.lastRuleUses", input),
      listSignals: (input) => this.context.read("decisionLedger.listSignals", input),
      readCalibrationRows: (input) =>
        this.context.read("decisionLedger.readCalibrationRows", input),
      readGapCandidates: (input) => this.context.read("decisionLedger.readGapCandidates", input),
      readMailTrace: (input) => this.context.read("decisionLedger.readMailTrace", input),
    });
  }

  ledgerObservation(): LedgerObservationPort {
    return Object.freeze<LedgerObservationPort>({
      readStart: (input) => this.context.read("ledgerObservation.readStart", input),
      setStart: (input) => this.context.write("ledgerObservation.setStart", input),
      beat: (input) => this.context.write("ledgerObservation.beat", input),
      firstHeartbeat: (input) => this.context.read("ledgerObservation.firstHeartbeat", input),
      ensureSnapshot: (input) => this.context.write("ledgerObservation.ensureSnapshot", input),
      readDayFacts: (input) => this.context.read("ledgerObservation.readDayFacts", input),
      countDays: (input) => this.context.read("ledgerObservation.countDays", input),
      appendCheck: (input) => this.context.write("ledgerObservation.appendCheck", input),
      listChecks: (input) => this.context.read("ledgerObservation.listChecks", input),
      listEvents: (input) => this.context.read("ledgerObservation.listEvents", input),
    });
  }

  museIntake(): MuseIntakePort {
    return Object.freeze<MuseIntakePort>({
      ingestBatch: (input) => this.context.write("museIntake.ingestBatch", input),
      listItems: (input) => this.context.read("museIntake.listItems", input),
      channelStatus: (input) => this.context.read("museIntake.channelStatus", input),
      checkChannel: (input) => this.context.write("museIntake.checkChannel", input),
      setPaused: (input) => this.context.write("museIntake.setPaused", input),
      rate: (input) => this.context.write("museIntake.rate", input),
      clearAll: (input) => this.context.write("museIntake.clearAll", input),
    });
  }

  modelUsage(): ModelUsageStorePort {
    return Object.freeze<ModelUsageStorePort>({
      record: (input) => this.context.write("modelUsage.record", input),
      isFollowUpTurn: (input) => this.context.read("modelUsage.isFollowUpTurn", input),
    });
  }

  realEval(): RealEvalStorePort {
    return Object.freeze<RealEvalStorePort>({
      listQuestions: (input) => this.context.read("realEval.listQuestions", input),
      addQuestion: (input) => this.context.write("realEval.addQuestion", input),
      retireQuestion: (input) => this.context.write("realEval.retireQuestion", input),
      recordRun: (input) => this.context.write("realEval.recordRun", input),
      listRuns: (input) => this.context.read("realEval.listRuns", input),
    });
  }

  pairedDevices(): PairedDeviceStorePort {
    return Object.freeze<PairedDeviceStorePort>({
      createPairingCode: (input) => this.context.write("pairedDevices.createPairingCode", input),
      redeemPairingCode: (input) => this.context.write("pairedDevices.redeemPairingCode", input),
      readDevice: (deviceId) => this.context.read("pairedDevices.readDevice", deviceId),
      listDevices: (input) => this.context.read("pairedDevices.listDevices", input),
      readOpenPairingCode: (input) => this.context.read("pairedDevices.readOpenPairingCode", input),
      confirmDevice: (input) => this.context.write("pairedDevices.confirmDevice", input),
      renameDevice: (input) => this.context.write("pairedDevices.renameDevice", input),
      revokeDevice: (input) => this.context.write("pairedDevices.revokeDevice", input),
      recordNonce: (input) => this.context.write("pairedDevices.recordNonce", input),
      touchDevice: (input) => this.context.write("pairedDevices.touchDevice", input),
    });
  }

  perception(): PerceptionStorePort {
    return Object.freeze<PerceptionStorePort>({
      readSettings: (input) => this.context.read("perception.readSettings", input),
      writeSettings: (input) => this.context.write("perception.writeSettings", input),
      knownRecordIds: (input) => this.context.read("perception.knownRecordIds", input),
      releaseContent: (input) => this.context.write("perception.releaseContent", input),
      knownMediaDigests: (input) => this.context.read("perception.knownMediaDigests", input),
      ingestRecords: (input) => this.context.write("perception.ingestRecords", input),
      listDay: (input) => this.context.read("perception.listDay", input),
      searchRecords: (input) => this.context.read("perception.searchRecords", input),
      countDay: (input) => this.context.read("perception.countDay", input),
      readEpisode: (input) => this.context.read("perception.readEpisode", input),
      setRecordStatus: (input) => this.context.write("perception.setRecordStatus", input),
      syncMirror: (input) => this.context.write("perception.syncMirror", input),
      listMirror: (input) => this.context.read("perception.listMirror", input),
      insertTrackPoints: (input) => this.context.write("perception.insertTrackPoints", input),
      countTrackPoints: (input) => this.context.read("perception.countTrackPoints", input),
      createUploadGrant: (input) => this.context.write("perception.createUploadGrant", input),
      readUploadGrant: (input) => this.context.read("perception.readUploadGrant", input),
      completeUploadGrant: (input) => this.context.write("perception.completeUploadGrant", input),
      recordMedia: (input) => this.context.write("perception.recordMedia", input),
      listMedia: (input) => this.context.read("perception.listMedia", input),
      readUsage: (input) => this.context.read("perception.readUsage", input),
      reserveUsage: (input) => this.context.write("perception.reserveUsage", input),
      reportDeviceUsage: (input) => this.context.write("perception.reportDeviceUsage", input),
      markUsageWarned: (input) => this.context.write("perception.markUsageWarned", input),
      prune: (input) => this.context.write("perception.prune", input),
    });
  }

  webPush(): WebPushStorePort {
    return Object.freeze<WebPushStorePort>({
      saveSubscription: (input) => this.context.write("webPush.saveSubscription", input),
      removeSubscription: (input) => this.context.write("webPush.removeSubscription", input),
      listSubscriptions: (input) => this.context.read("webPush.listSubscriptions", input),
      readKinds: (input) => this.context.read("webPush.readKinds", input),
      setKind: (input) => this.context.write("webPush.setKind", input),
      writeKinds: (input) => this.context.write("webPush.writeKinds", input),
      markSubscription: (input) => this.context.write("webPush.markSubscription", input),
      readCursor: (input) => this.context.read("webPush.readCursor", input),
      enqueue: (input) => this.context.write("webPush.enqueue", input),
      listDue: (input) => this.context.read("webPush.listDue", input),
      deferItem: (input) => this.context.write("webPush.deferItem", input),
      recordAttempt: (input) => this.context.write("webPush.recordAttempt", input),
      recordReactions: (input) => this.context.write("webPush.recordReactions", input),
      listFeedback: (input) => this.context.read("webPush.listFeedback", input),
      listFinishedRuns: (input) => this.context.read("webPush.listFinishedRuns", input),
      prune: (input) => this.context.write("webPush.prune", input),
    });
  }

  sensitiveInterceptions(): SensitiveInterceptionStorePort {
    return Object.freeze<SensitiveInterceptionStorePort>({
      record: (input) => this.context.write("sensitiveInterception.record", input),
      list: (input) => this.context.read("sensitiveInterception.list", input),
      summarize: (input) => this.context.read("sensitiveInterception.summarize", input),
      clear: (input) => this.context.write("sensitiveInterception.clear", input),
      threadOfRun: (input) => this.context.read("sensitiveInterception.threadOfRun", input),
    });
  }

  threadPromptBundles(): ThreadPromptBundleStorePort {
    return Object.freeze<ThreadPromptBundleStorePort>({
      latest: (input) => this.context.read("threadPromptBundle.latest", input),
      get: (input) => this.context.read("threadPromptBundle.get", input),
      create: (input) => this.context.write("threadPromptBundle.create", input),
      requestRebuild: (input) => this.context.write("threadPromptBundle.requestRebuild", input),
    });
  }

  threadArtifacts(): ThreadArtifactStorePort {
    return Object.freeze<ThreadArtifactStorePort>({
      register: (input) => this.context.write("threadArtifact.register", input),
      latest: (input) => this.context.read("threadArtifact.latest", input),
      get: (input) => this.context.read("threadArtifact.get", input),
      versions: (input) => this.context.read("threadArtifact.versions", input),
      list: (input) => this.context.read("threadArtifact.list", input),
      markDeleted: (input) => this.context.write("threadArtifact.markDeleted", input),
    });
  }

  memoryEpisodes(): MemoryEpisodeStorePort {
    return Object.freeze<MemoryEpisodeStorePort>({
      upsert: (document) => this.context.write("memoryEpisode.upsert", { document }),
      search: (input) => this.context.read("memoryEpisode.search", input),
      listUnembedded: (input) => this.context.read("memoryEpisode.listUnembedded", input),
      attachEmbedding: (input) => this.context.write("memoryEpisode.attachEmbedding", input),
      listUnsummarized: (input) => this.context.read("memoryEpisode.listUnsummarized", input),
      listDaySummaries: (input) => this.context.read("memoryEpisode.listDaySummaries", input),
      listDaySummariesAfter: (input) =>
        this.context.read("memoryEpisode.listDaySummariesAfter", input),
    });
  }

  memoryProjectionJobs(): MemoryProjectionJobStatePort {
    return Object.freeze<MemoryProjectionJobStatePort>({
      propose: ({ job, requeueCompleted = false }) =>
        this.context.write("memoryJob.propose", { job, requeueCompleted }),
      listPending: (now, limit) => this.context.write("memoryJob.listPending", { now, limit }),
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
      readDetailSnapshot: (query) => this.context.read("thread.readDetailSnapshot", { query }),
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
