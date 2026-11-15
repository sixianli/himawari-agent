import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ApplePushStorePort,
  AttentionStatePort,
  AuditLedgerPort,
  AuthorityFence,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  AuthorizationStorePort,
  AutomaticReviewStorePort,
  BackgroundWorkStatePort,
  BuiltInIdentityStatePort,
  CapabilityExecutionHandleStorePort,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  CapabilityRegistryStorePort,
  ClockPort,
  CommandResultLookup,
  CommandResultRecord,
  CommitStateAndEventsInput,
  CommitStateAndEventsResult,
  DecisionLedgerPort,
  DeploymentAuthorityStatePort,
  DurableGitHubMonitorHistoryPolicyPort,
  ExecutionEnvironmentStorePort,
  ExternalMemoryProposalStorePort,
  GapCaseMarkPort,
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
  DeviceActionStorePort,
  PerceptionStorePort,
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
  ThinkInboxStorePort,
  OwnerRuleStorePort,
  PairedDeviceStorePort,
  PayloadStorePort,
  ProactiveStorePort,
  ProductMemoryStatePort,
  ProductStateRepositoryPort,
  RealEvalStorePort,
  ReliableEventPort,
  ReliableEventRecord,
  ReviewPrereviewStorePort,
  RuleReviewOwnerStorePort,
  RuleReviewStorePort,
  RunCheckpointStore,
  RunDispatchPort,
  RunExecutionSourcePort,
  RunLifecyclePort,
  RunPayloadArtifactAuthority,
  RunPayloadArtifactPort,
  RunReconciliationPort,
  SandboxExecutionJournalPort,
  SandboxExecutionPreparationPort,
  SandboxJobJournalPort,
  SchedulerPort,
  SensitiveInterceptionStorePort,
  SensitiveMemoryApprovalStatePort,
  SessionDeletionStatePort,
  SessionDeviceStatePort,
  StateRecord,
  ThreadArtifactStorePort,
  ThreadDistillationStatePort,
  ThreadPromptBundleStorePort,
  ThreadRepositoryPort,
  ThreadSearchProjectionSourcePort,
  TraceStorePort,
  WebPushStorePort,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type UnitOfWorkPort,
} from "@himawari-agent/application";
import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  DeploymentAuthorityState,
  DeploymentId,
  OwnerId,
  ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  SqliteDurableAdapters,
  type SqliteGatewayReadModel,
  type SqliteRecoveryAuthorityScope,
  type SqliteReliableEventConsumerDeduplicator,
  type SqliteReliableEventOutbox,
  type SqliteStartupRecovery,
} from "./durable-adapters.js";
import type { VerifiedMigrationSnapshot } from "./migration-engine.js";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "./migration-engine.js";
import {
  SqliteExecutionContext,
  type SqliteSlowOperation,
  type SqliteTimedOperation,
  type SqliteWorkerConfiguration,
} from "./sqlite-execution-context.js";
import { SqliteGitHubMonitorHistoryPolicyAdapter } from "./sqlite-github-history-policy.js";
import {
  acquireStateRootLock,
  SQLITE_PERSISTENCE_ERROR_CODES,
  SqlitePersistenceError,
  type StateRootLock,
} from "./state-root-lock.js";

export interface SqliteExtraReadThreadBudget {
  tryAcquire(): boolean;
  release(): void;
}

export interface SqliteProductStateRepositoryOptions {
  readonly stateRoot: string;
  readonly databasePath?: string;
  readonly migrationSnapshot?: VerifiedMigrationSnapshot;
  readonly busyTimeoutMs?: number;
  readonly minimumFreeBytes?: number;
  readonly warningFreeBytes?: number;
  readonly now?: () => string;
  readonly qualification?: SqliteWorkerConfiguration["qualification"];
  readonly onSlowOperation?: (operation: SqliteSlowOperation) => void;
  readonly onOperation?: (operation: SqliteTimedOperation) => void;
  readonly transactionScopeTimeoutMs?: number;
  readonly extraReadThreadBudget?: SqliteExtraReadThreadBudget;
  readonly proactiveSources?: SqliteWorkerConfiguration["proactiveSources"];
}

export const DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS = 2000;

interface TransactionScope {
  ended: boolean;
}

export interface SqliteCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface SqliteOperationalStatus {
  readonly databaseBytes: number;
  readonly freeBytes: number;
  readonly minimumFreeBytes: number;
  readonly warningFreeBytes: number;
  readonly storageMode: "normal" | "warning" | "write_restricted";
  readonly walBytes: number;
  readonly busyTimeoutMs: number;
  readonly lastTransactionDurationMs: number;
  readonly queuedWriters: number;
  readonly maxObservedQueuedWriters: number;
  readonly outboxPending: number;
  readonly backgroundJobsPending: number;
  readonly memoryProjectionPending: number;
  readonly sseEventRows: number;
  readonly deletionPending: number;
}

function validBusyTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000) {
    throw new RangeError("busyTimeoutMs must be an integer between 1 and 30000");
  }
  return value;
}

function validMinimumFreeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("minimumFreeBytes must be a non-negative safe integer");
  }
  return value;
}

const READ_WORKER_COUNT = 3;
const SLOW_SCOPE_MILLISECONDS = 500;

function validScopeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000)
    throw new RangeError("transactionScopeTimeoutMs must be an integer between 1 and 30000");
  return value;
}

export class SqliteProductStateRepository implements ProductStateRepositoryPort {
  readonly stateRoot: string;
  readonly databasePath: string;
  private readonly context: SqliteExecutionContext;
  private readonly readContexts: SqliteExecutionContext[];
  private readonly startReadContext: () => Promise<SqliteExecutionContext>;
  private readonly readStarts = new Set<Promise<void>>();
  private readonly lock: StateRootLock;
  private readonly now: () => string;
  private readonly extraReadThreadBudget: SqliteExtraReadThreadBudget | undefined;
  private extraReadThreads = 0;
  private readonly durable: SqliteDurableAdapters;
  private readonly githubHistory: DurableGitHubMonitorHistoryPolicyPort;
  private closed = false;
  private readonly scopes = new AsyncLocalStorage<TransactionScope>();
  private scopeGate: Promise<void> | undefined;
  private scopeBroken = false;
  private readonly scopeTimeoutMs: number;
  private readonly onSlowScope: ((operation: SqliteSlowOperation) => void) | undefined;
  private queuedWriters = 0;
  private maxObservedQueuedWriters = 0;

  private constructor(input: {
    stateRoot: string;
    databasePath: string;
    context: SqliteExecutionContext;
    readContext: SqliteExecutionContext;
    startReadContext: () => Promise<SqliteExecutionContext>;
    lock: StateRootLock;
    now: () => string;
    scopeTimeoutMs: number;
    onSlowScope: ((operation: SqliteSlowOperation) => void) | undefined;
    extraReadThreadBudget?: SqliteExtraReadThreadBudget;
  }) {
    this.scopeTimeoutMs = input.scopeTimeoutMs;
    this.onSlowScope = input.onSlowScope;
    this.stateRoot = input.stateRoot;
    this.databasePath = input.databasePath;
    this.context = input.context;
    this.readContexts = [input.readContext];
    this.startReadContext = input.startReadContext;
    this.lock = input.lock;
    this.now = input.now;
    this.extraReadThreadBudget = input.extraReadThreadBudget;
    this.durable = new SqliteDurableAdapters({
      read: (operation, payload) => this.readRequest(operation, payload),
      write: (operation, payload) => this.writeRequest(operation, payload),
    });
    this.githubHistory = new SqliteGitHubMonitorHistoryPolicyAdapter({
      stateRoot: this.stateRoot,
      context: {
        read: (operation, payload) => this.readRequest(operation, payload),
        write: (operation, payload) => this.writeRequest(operation, payload),
      },
    });
  }

  static async open(
    options: SqliteProductStateRepositoryOptions,
  ): Promise<SqliteProductStateRepository> {
    const stateRoot = path.resolve(options.stateRoot);
    const databasePath = path.resolve(
      options.databasePath ?? path.join(stateRoot, "product.sqlite"),
    );
    const busyTimeoutMs = validBusyTimeout(options.busyTimeoutMs ?? 5000);
    const scopeTimeoutMs = validScopeTimeout(
      options.transactionScopeTimeoutMs ?? DEFAULT_TRANSACTION_SCOPE_TIMEOUT_MS,
    );
    const minimumFreeBytes = validMinimumFreeBytes(options.minimumFreeBytes ?? 256 * 1024 * 1024);
    const warningFreeBytes = validMinimumFreeBytes(
      options.warningFreeBytes ?? Math.max(minimumFreeBytes, 1024 * 1024 * 1024),
    );
    if (warningFreeBytes < minimumFreeBytes) {
      throw new RangeError("warningFreeBytes must be greater than or equal to minimumFreeBytes");
    }
    const lock = await acquireStateRootLock(stateRoot);
    try {
      const migrations = await loadBundledMigrations();
      const database = openQualifiedDatabase(databasePath);
      try {
        applyMigrations(database, migrations, {
          ...(options.migrationSnapshot ? { snapshot: options.migrationSnapshot } : {}),
        });
      } finally {
        database.close();
      }
      const context = await SqliteExecutionContext.start(
        {
          databasePath,
          writerSequence: migrations.length,
          busyTimeoutMs,
          minimumFreeBytes,
          warningFreeBytes,
          ...(options.qualification ? { qualification: options.qualification } : {}),
          ...(options.proactiveSources ? { proactiveSources: options.proactiveSources } : {}),
        },
        {
          ...(options.onSlowOperation ? { onSlowOperation: options.onSlowOperation } : {}),
          ...(options.onOperation ? { onOperation: options.onOperation } : {}),
        },
      );
      const startReadContext = () =>
        SqliteExecutionContext.start(
          {
            databasePath,
            writerSequence: migrations.length,
            busyTimeoutMs,
            minimumFreeBytes,
            warningFreeBytes,
            readOnly: true,
            ...(options.proactiveSources ? { proactiveSources: options.proactiveSources } : {}),
          },
          {
            ...(options.onSlowOperation ? { onSlowOperation: options.onSlowOperation } : {}),
            ...(options.onOperation ? { onOperation: options.onOperation } : {}),
          },
        );
      const readContext = await startReadContext().catch(async (error) => {
        await context.close();
        throw error;
      });
      return new SqliteProductStateRepository({
        stateRoot,
        databasePath,
        context,
        readContext,
        startReadContext,
        lock,
        now: options.now ?? (() => new Date().toISOString()),
        scopeTimeoutMs,
        onSlowScope: options.onSlowOperation,
        ...(options.extraReadThreadBudget
          ? { extraReadThreadBudget: options.extraReadThreadBudget }
          : {}),
      });
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  read(key: string): Promise<StateRecord | undefined> {
    this.assertOpen();
    return this.readRequest("read", { key });
  }

  readAuthorityRevision(): Promise<number> {
    this.assertOpen();
    return this.readRequest("readAuthorityRevision", {});
  }

  readScopedState(
    ownerId: OwnerId,
    agentId: AgentId,
    key: string,
  ): Promise<StateRecord | undefined> {
    this.assertOpen();
    return this.readRequest("readScopedState", { ownerId, agentId, key });
  }

  listPending(limit: number): Promise<readonly ReliableEventRecord[]> {
    this.assertOpen();
    return this.readRequest("listPending", { limit });
  }

  markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord> {
    return this.writeRequest("markPublished", { eventId, publishedAt });
  }

  findCommandResult(lookup: CommandResultLookup): Promise<CommandResultRecord | undefined> {
    this.assertOpen();
    return this.readRequest("findCommandResult", lookup);
  }

  findCommandCommit(lookup: CommandResultLookup): Promise<CommitStateAndEventsResult | undefined> {
    this.assertOpen();
    return this.readRequest("findCommandCommit", lookup);
  }

  commitStateAndEvents(input: CommitStateAndEventsInput): Promise<CommitStateAndEventsResult> {
    return this.writeRequest("commit", { input, now: this.now() });
  }

  authorityLeasePort(clock: ClockPort): AuthorityLeasePort {
    return Object.freeze({
      claim: (lease: AgentAuthorityLease, durationMs: number) =>
        this.writeRequest<AuthorityLeaseRecord>("authority.claim", {
          lease,
          durationMs,
          now: clock.now(),
        }),
      current: (agentId: AgentId) =>
        this.readRequest<AuthorityLeaseRecord | undefined>("authority.current", {
          agentId,
          now: clock.now(),
        }),
      renew: (leaseId: AuthorityLeaseId, durationMs: number) =>
        this.writeRequest<AuthorityLeaseRecord>("authority.renew", {
          leaseId,
          durationMs,
          now: clock.now(),
        }),
      release: (leaseId: AuthorityLeaseId) =>
        this.writeRequest<void>("authority.release", { leaseId, now: clock.now() }),
    });
  }

  deploymentAuthorityPort(): DeploymentAuthorityStatePort {
    return Object.freeze({
      read: (deploymentId: DeploymentId) =>
        this.readRequest<DeploymentAuthorityState | undefined>("deployment.read", {
          deploymentId,
        }),
      save: (deployment: DeploymentAuthorityState, expectedRevision: number) =>
        this.writeRequest<DeploymentAuthorityState>("deployment.save", {
          deployment,
          expectedRevision,
        }),
      assertCurrent: (fence: ProductAuthorityFence) =>
        this.readRequest<DeploymentAuthorityState>("deployment.assertCurrent", { fence }),
    });
  }

  reliableEventPort(ownerId: OwnerId, agentId: AgentId): ReliableEventPort {
    return this.durable.reliableEventPort(ownerId, agentId);
  }

  runCheckpointStore(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
  ): RunCheckpointStore {
    return this.durable.runCheckpointStore(ownerId, agentId, authority, this.now);
  }

  runReconciliation(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: AuthorityFence,
    consumerId: string,
  ): RunReconciliationPort {
    return this.durable.runReconciliation(ownerId, agentId, authority, authorityLease, consumerId);
  }

  runDispatch(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: { readonly leaseId: AuthorityLeaseId; readonly fencingToken: number },
    consumerId: string,
  ): RunDispatchPort {
    return this.durable.runDispatch(ownerId, agentId, authority, authorityLease, consumerId);
  }

  modelBudgetPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: { readonly leaseId: AuthorityLeaseId; readonly fencingToken: number },
  ): ModelBudgetPort {
    return this.durable.modelBudgetPort(ownerId, agentId, authority, authorityLease);
  }

  modelInvocationIdentityPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
    authorityLease: { readonly leaseId: AuthorityLeaseId; readonly fencingToken: number },
  ): ModelInvocationIdentityPort {
    return this.durable.modelInvocationIdentityPort(ownerId, agentId, authority, authorityLease);
  }

  reliableEventOutbox(): SqliteReliableEventOutbox {
    return this.durable.reliableEventOutbox();
  }

  reliableEventConsumerDeduplicator(): SqliteReliableEventConsumerDeduplicator {
    return this.durable.reliableEventConsumerDeduplicator();
  }

  traceStore(): TraceStorePort {
    return this.durable.traceStore();
  }

  payloadStore(ownerId: OwnerId, agentId: AgentId): PayloadStorePort {
    return this.durable.payloadStore(ownerId, agentId);
  }

  runPayloadArtifactPort(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: RunPayloadArtifactAuthority,
  ): RunPayloadArtifactPort {
    return this.durable.runPayloadArtifactPort(ownerId, agentId, authority, this.now);
  }

  auditLedger(): AuditLedgerPort {
    return this.durable.auditLedger();
  }

  automaticReviewStore(): AutomaticReviewStorePort {
    return this.durable.automaticReviewStore();
  }

  authorizationStore(): AuthorizationStorePort {
    return this.durable.authorizationStore();
  }

  governanceMutationReceiptStore(): GovernanceMutationReceiptStorePort {
    return this.durable.governanceMutationReceiptStore();
  }

  capabilityStore(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort {
    return this.durable.capabilityStore(ownerId, agentId);
  }

  capabilityInvocationReceiptPort(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityInvocationReceiptPort {
    return this.durable.capabilityInvocationReceiptPort(ownerId, agentId);
  }

  sandboxExecutionPreparations(
    ownerId: OwnerId,
    agentId: AgentId,
  ): SandboxExecutionPreparationPort {
    return this.durable.sandboxExecutionPreparations(ownerId, agentId);
  }

  sandboxExecutionJournal(ownerId: OwnerId, agentId: AgentId): SandboxExecutionJournalPort {
    return this.durable.sandboxExecutionJournal(ownerId, agentId);
  }

  executionEnvironmentStore(ownerId: OwnerId, agentId: AgentId): ExecutionEnvironmentStorePort {
    return this.durable.executionEnvironmentStore(ownerId, agentId);
  }

  sandboxJobJournal(ownerId: OwnerId, agentId: AgentId): SandboxJobJournalPort {
    return this.durable.sandboxJobJournal(ownerId, agentId);
  }

  capabilityInvocationResultPort(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityInvocationResultPort {
    return this.durable.capabilityInvocationResultPort(ownerId, agentId);
  }

  scheduler(): SchedulerPort {
    return this.durable.scheduler();
  }

  backgroundWorkState(): BackgroundWorkStatePort {
    return this.durable.backgroundWorkState();
  }

  attentionState(): AttentionStatePort {
    return this.durable.attentionState();
  }

  sessionDeletionState(): SessionDeletionStatePort {
    return this.durable.sessionDeletionState();
  }

  builtInIdentityState(ownerId: OwnerId, agentId: AgentId): BuiltInIdentityStatePort {
    return this.durable.builtInIdentityState(ownerId, agentId);
  }

  ownerIdentityState(): OwnerIdentityStatePort {
    return this.durable.ownerIdentityState();
  }

  sessionDeviceState(): SessionDeviceStatePort {
    return this.durable.sessionDeviceState();
  }

  productMemoryState(): ProductMemoryStatePort {
    return this.durable.productMemoryState();
  }

  memoryIndex(): MemoryIndexStorePort {
    return this.durable.memoryIndex();
  }

  memoryEpisodes(): MemoryEpisodeStorePort {
    return this.durable.memoryEpisodes();
  }

  memoryConsolidation(): MemoryConsolidationStorePort {
    return this.durable.memoryConsolidation();
  }

  ownerRules(): OwnerRuleStorePort {
    return this.durable.ownerRules();
  }

  ownerProposals(): OwnerProposalStorePort {
    return this.durable.ownerProposals();
  }

  thinkInbox(): ThinkInboxStorePort {
    return this.durable.thinkInbox();
  }

  memoryReminders(): MemoryReminderStorePort {
    return this.durable.memoryReminders();
  }

  memoryCheckup(): MemoryCheckupStorePort {
    return this.durable.memoryCheckup();
  }

  reviewPrereview(): ReviewPrereviewStorePort {
    return this.durable.reviewPrereview();
  }

  homeUrgency(): HomeUrgencyStorePort {
    return this.durable.homeUrgency();
  }

  externalMemoryProposals(): ExternalMemoryProposalStorePort {
    return this.durable.externalMemoryProposals();
  }

  memoryCaptureBacklog(): MemoryCaptureBacklogPort {
    return this.durable.memoryCaptureBacklog();
  }

  ruleReviews(): RuleReviewStorePort & RuleReviewOwnerStorePort {
    return this.durable.ruleReviews();
  }

  memoryReviews(): MemoryReviewStorePort {
    return this.durable.memoryReviews();
  }

  memoryConversationReviews(): MemoryConversationReviewStorePort {
    return this.durable.memoryConversationReviews();
  }

  modelUsage(): ModelUsageStorePort {
    return this.durable.modelUsage();
  }

  realEval(): RealEvalStorePort {
    return this.durable.realEval();
  }

  gapCaseMarks(): GapCaseMarkPort {
    return this.durable.gapCaseMarks();
  }

  decisionLedger(): DecisionLedgerPort {
    return this.durable.decisionLedger();
  }

  museIntake(): MuseIntakePort {
    return this.durable.museIntake();
  }

  ledgerObservation(): LedgerObservationPort {
    return this.durable.ledgerObservation();
  }

  webPush(): WebPushStorePort {
    return this.durable.webPush();
  }

  applePush(): ApplePushStorePort {
    return this.durable.applePush();
  }

  pairedDevices(): PairedDeviceStorePort {
    return this.durable.pairedDevices();
  }

  deviceActions(): DeviceActionStorePort {
    return this.durable.deviceActions();
  }

  perception(): PerceptionStorePort {
    return this.durable.perception();
  }

  proactive(): ProactiveStorePort {
    return this.durable.proactive();
  }

  ownerPreferences(): OwnerPreferencesStorePort {
    return this.durable.ownerPreferences();
  }

  threadArtifacts(): ThreadArtifactStorePort {
    return this.durable.threadArtifacts();
  }

  threadPromptBundles(): ThreadPromptBundleStorePort {
    return this.durable.threadPromptBundles();
  }

  sensitiveInterceptions(): SensitiveInterceptionStorePort {
    return this.durable.sensitiveInterceptions();
  }

  memoryBook(): MemoryBookStorePort {
    return this.durable.memoryBook();
  }

  memoryProjectionJobs(): MemoryProjectionJobStatePort {
    return this.durable.memoryProjectionJobs();
  }

  sensitiveMemoryApprovals(): SensitiveMemoryApprovalStatePort {
    return this.durable.sensitiveMemoryApprovals();
  }

  threadDistillationState(): ThreadDistillationStatePort {
    return this.durable.threadDistillationState();
  }

  threadRepository(): ThreadRepositoryPort {
    return this.durable.threadRepository();
  }

  threadSearchProjectionSource(): ThreadSearchProjectionSourcePort {
    return { pending: (input) => this.readRequest("thread.pendingSearchProjection", input) };
  }

  runExecutionSource(ownerId: OwnerId, agentId: AgentId): RunExecutionSourcePort {
    return Object.freeze<RunExecutionSourcePort>({
      read: (runId) =>
        this.readRequest("thread.readRunExecutionSource", { ownerId, agentId, runId }),
    });
  }

  runLifecycle(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
  ): RunLifecyclePort {
    return this.durable.runLifecycle(ownerId, agentId, authority, this.now);
  }

  githubIntegrationState(): GitHubIntegrationStatePort {
    return this.durable.githubIntegrationState();
  }

  githubMonitorHistoryPolicy(): DurableGitHubMonitorHistoryPolicyPort {
    return this.githubHistory;
  }

  gatewayReadModel(): SqliteGatewayReadModel {
    return this.durable.gatewayReadModel();
  }

  recoverySnapshot(): Promise<SqliteStartupRecovery> {
    this.assertOpen();
    return this.durable.recoverySnapshot();
  }

  startupRecovery(scope: SqliteRecoveryAuthorityScope): Promise<SqliteStartupRecovery> {
    this.assertOpen();
    return this.durable.startupRecovery(scope, this.now());
  }

  checkpoint(mode: "passive" | "truncate" = "passive"): Promise<SqliteCheckpointResult> {
    return this.writeRequest("checkpoint", { mode });
  }

  async operationalStatus(): Promise<SqliteOperationalStatus> {
    this.assertOpen();
    const worker = await this.context.request<
      Omit<SqliteOperationalStatus, "queuedWriters" | "maxObservedQueuedWriters">
    >("status", {});
    return Object.freeze({
      ...worker,
      queuedWriters: this.queuedWriters,
      maxObservedQueuedWriters: this.maxObservedQueuedWriters,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    while (this.scopeGate) await this.scopeGate;
    if (this.closed) return;
    this.closed = true;
    try {
      await Promise.all(this.readStarts);
      await Promise.all(this.readContexts.map((read) => read.close()));
      await this.context.close();
    } finally {
      try {
        while (this.extraReadThreads > 0) {
          this.extraReadThreads -= 1;
          try {
            this.extraReadThreadBudget?.release();
          } catch {}
        }
      } finally {
        await this.lock.release();
      }
    }
  }

  get readWorkerCount(): number {
    return this.readContexts.length;
  }

  private readRequest<TResult>(operation: string, payload: unknown): Promise<TResult> {
    const scope = this.scopes.getStore();
    if (scope) {
      this.assertScopeOpen(scope);
      return this.context.request<TResult>(operation, payload);
    }
    let chosen = this.readContexts[0];
    for (const candidate of this.readContexts)
      if (chosen && candidate.pendingCount < chosen.pendingCount) chosen = candidate;
    if (!chosen) throw new Error("SQLITE_READ_WORKER_MISSING");
    if (
      chosen.pendingCount > 0 &&
      !this.closed &&
      this.readContexts.length + this.readStarts.size < READ_WORKER_COUNT &&
      (this.extraReadThreadBudget?.tryAcquire() ?? true)
    ) {
      const budget = this.extraReadThreadBudget;
      const release = () => {
        if (budget) budget.release();
      };
      const starting: Promise<void> = this.startReadContext()
        .then(
          (started) => {
            if (this.closed) return started.close().finally(release);
            this.readContexts.push(started);
            if (budget) this.extraReadThreads += 1;
          },
          () => release(),
        )
        .catch(() => undefined)
        .finally(() => {
          this.readStarts.delete(starting);
        });
      this.readStarts.add(starting);
    }
    return chosen.request<TResult>(operation, payload);
  }

  private async writeRequest<TResult>(operation: string, payload: unknown): Promise<TResult> {
    this.assertOpen();
    const scope = this.scopes.getStore();
    if (scope) {
      this.assertScopeOpen(scope);
      return this.context.request<TResult>(operation, payload);
    }
    while (this.scopeGate) await this.scopeGate;
    this.assertScopeUsable();
    this.queuedWriters += 1;
    this.maxObservedQueuedWriters = Math.max(this.maxObservedQueuedWriters, this.queuedWriters);
    try {
      return await this.context.request<TResult>(operation, payload);
    } finally {
      this.queuedWriters -= 1;
    }
  }

  private assertScopeUsable(): void {
    if (this.scopeBroken)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "A transaction could not be rolled back; the write lane is closed",
        { reason: "TRANSACTION_ROLLBACK_UNCONFIRMED" },
      );
  }

  private assertScopeOpen(scope: TransactionScope): void {
    if (scope.ended)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "The transaction scope has ended; this call was refused",
        { reason: "TRANSACTION_SCOPE_ENDED" },
      );
  }

  unitOfWork(): UnitOfWorkPort {
    return Object.freeze<UnitOfWorkPort>({ run: (work) => this.runInTransaction(work) });
  }

  async runInTransaction<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    this.assertOpen();
    const joined = this.scopes.getStore();
    if (joined) {
      this.assertScopeOpen(joined);
      return work();
    }
    const requestedAt = performance.now();
    while (this.scopeGate) await this.scopeGate;
    this.assertScopeUsable();
    let release: () => void = () => undefined;
    this.scopeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope: TransactionScope = { ended: false };
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.context.request("transaction.begin", {});
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          scope.ended = true;
          reject(
            new ApplicationPortError(
              PORT_ERROR_CODES.CONFLICT,
              `The transaction scope exceeded ${this.scopeTimeoutMs} ms`,
              { reason: "TRANSACTION_SCOPE_TIMEOUT" },
            ),
          );
        }, this.scopeTimeoutMs);
      });
      deadline.catch(() => undefined);
      const running = this.scopes.run(scope, work);
      running.catch(() => undefined);
      const result = await Promise.race([running, deadline]);
      if (scope.ended)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "The transaction scope ended", {
          reason: "TRANSACTION_SCOPE_ENDED",
        });
      scope.ended = true;
      await this.context.request("transaction.commit", {});
      return result;
    } catch (error) {
      scope.ended = true;
      try {
        await this.context.request("transaction.rollback", {});
      } catch {
        this.scopeBroken = true;
      }
      throw error;
    } finally {
      scope.ended = true;
      if (timer) clearTimeout(timer);
      this.scopeGate = undefined;
      release();
      const totalMs = Math.round(performance.now() - requestedAt);
      if (this.onSlowScope && totalMs >= SLOW_SCOPE_MILLISECONDS) {
        const runMs = Math.round(performance.now() - startedAt);
        try {
          this.onSlowScope({
            lane: "write",
            operation: "transaction.scope",
            totalMs,
            queueWaitMs: totalMs - runMs,
            runMs,
            queuedBehind: 0,
          });
        } catch {}
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SqlitePersistenceError(
        SQLITE_PERSISTENCE_ERROR_CODES.REPOSITORY_CLOSED,
        "The SQLite product-state repository is closed",
      );
    }
  }
}
