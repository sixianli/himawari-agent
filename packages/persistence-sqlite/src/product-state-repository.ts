import path from "node:path";
import type {
  AttentionStatePort,
  AuditLedgerPort,
  BackgroundWorkStatePort,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  ClockPort,
  CommandResultLookup,
  CommandResultRecord,
  CommitStateAndEventsInput,
  CommitStateAndEventsResult,
  DeploymentAuthorityStatePort,
  AuthorizationStorePort,
  CapabilityExecutionHandleStorePort,
  CapabilityRegistryStorePort,
  PayloadStorePort,
  ProductStateRepositoryPort,
  ReliableEventPort,
  ReliableEventRecord,
  SchedulerPort,
  SessionDeviceStatePort,
  SessionDeletionStatePort,
  StateRecord,
  StateStorePort,
  TraceStorePort,
  OwnerIdentityStatePort,
  MemoryProjectionJobStatePort,
  ProductMemoryStatePort,
  SensitiveMemoryApprovalStatePort,
  ThreadDistillationStatePort,
} from "@himawari-agent/application";
import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  DeploymentAuthorityState,
  DeploymentId,
  ProductAuthorityFence,
  OwnerId,
} from "@himawari-agent/domain";
import {
  type SqliteGatewayReadModel,
  type SqliteReliableEventConsumerDeduplicator,
  type SqliteReliableEventOutbox,
  type SqliteStartupRecovery,
  SqliteDurableAdapters,
} from "./durable-adapters.js";
import type { VerifiedMigrationSnapshot } from "./migration-engine.js";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "./migration-engine.js";
import {
  type SqliteWorkerConfiguration,
  SqliteExecutionContext,
} from "./sqlite-execution-context.js";
import { SQLITE_PERSISTENCE_ERROR_CODES, SqlitePersistenceError } from "./state-root-lock.js";
import { acquireStateRootLock, type StateRootLock } from "./state-root-lock.js";

export interface SqliteProductStateRepositoryOptions {
  readonly stateRoot: string;
  readonly databasePath?: string;
  readonly migrationSnapshot?: VerifiedMigrationSnapshot;
  readonly busyTimeoutMs?: number;
  readonly minimumFreeBytes?: number;
  readonly now?: () => string;
  readonly qualification?: SqliteWorkerConfiguration["qualification"];
}

export interface SqliteCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface SqliteOperationalStatus {
  readonly freeBytes: number;
  readonly walBytes: number;
  readonly busyTimeoutMs: number;
  readonly lastTransactionDurationMs: number;
  readonly queuedWriters: number;
  readonly maxObservedQueuedWriters: number;
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

export class SqliteProductStateRepository implements ProductStateRepositoryPort {
  readonly stateRoot: string;
  readonly databasePath: string;
  private readonly context: SqliteExecutionContext;
  private readonly lock: StateRootLock;
  private readonly now: () => string;
  private readonly durable: SqliteDurableAdapters;
  private closed = false;
  private queuedWriters = 0;
  private maxObservedQueuedWriters = 0;

  private constructor(input: {
    stateRoot: string;
    databasePath: string;
    context: SqliteExecutionContext;
    lock: StateRootLock;
    now: () => string;
  }) {
    this.stateRoot = input.stateRoot;
    this.databasePath = input.databasePath;
    this.context = input.context;
    this.lock = input.lock;
    this.now = input.now;
    this.durable = new SqliteDurableAdapters({
      read: (operation, payload) => this.context.request(operation, payload),
      write: (operation, payload) => this.writeRequest(operation, payload),
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
    const minimumFreeBytes = validMinimumFreeBytes(options.minimumFreeBytes ?? 256 * 1024 * 1024);
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
      const context = await SqliteExecutionContext.start({
        databasePath,
        writerSequence: migrations.length,
        busyTimeoutMs,
        minimumFreeBytes,
        startupNow: (options.now ?? (() => new Date().toISOString()))(),
        ...(options.qualification ? { qualification: options.qualification } : {}),
      });
      return new SqliteProductStateRepository({
        stateRoot,
        databasePath,
        context,
        lock,
        now: options.now ?? (() => new Date().toISOString()),
      });
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  read(key: string): Promise<StateRecord | undefined> {
    this.assertOpen();
    return this.context.request("read", { key });
  }

  listPending(limit: number): Promise<readonly ReliableEventRecord[]> {
    this.assertOpen();
    return this.context.request("listPending", { limit });
  }

  markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord> {
    return this.writeRequest("markPublished", { eventId, publishedAt });
  }

  findCommandResult(lookup: CommandResultLookup): Promise<CommandResultRecord | undefined> {
    this.assertOpen();
    return this.context.request("findCommandResult", lookup);
  }

  findCommandCommit(lookup: CommandResultLookup): Promise<CommitStateAndEventsResult | undefined> {
    this.assertOpen();
    return this.context.request("findCommandCommit", lookup);
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
        this.context.request<AuthorityLeaseRecord | undefined>("authority.current", {
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
        this.context.request<DeploymentAuthorityState | undefined>("deployment.read", {
          deploymentId,
        }),
      save: (deployment: DeploymentAuthorityState, expectedRevision: number) =>
        this.writeRequest<DeploymentAuthorityState>("deployment.save", {
          deployment,
          expectedRevision,
        }),
      assertCurrent: (fence: ProductAuthorityFence) =>
        this.context.request<DeploymentAuthorityState>("deployment.assertCurrent", { fence }),
    });
  }

  reliableEventPort(ownerId: OwnerId, agentId: AgentId): ReliableEventPort {
    return this.durable.reliableEventPort(ownerId, agentId);
  }

  authoritativeRunCheckpointStore(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ProductAuthorityFence,
  ): StateStorePort {
    return this.durable.authoritativeRunCheckpointStore(ownerId, agentId, authority, this.now);
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

  auditLedger(): AuditLedgerPort {
    return this.durable.auditLedger();
  }

  authorizationStore(): AuthorizationStorePort {
    return this.durable.authorizationStore();
  }

  capabilityStore(
    ownerId: OwnerId,
    agentId: AgentId,
  ): CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort {
    return this.durable.capabilityStore(ownerId, agentId);
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

  ownerIdentityState(): OwnerIdentityStatePort {
    return this.durable.ownerIdentityState();
  }

  sessionDeviceState(): SessionDeviceStatePort {
    return this.durable.sessionDeviceState();
  }

  productMemoryState(): ProductMemoryStatePort {
    return this.durable.productMemoryState();
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

  gatewayReadModel(): SqliteGatewayReadModel {
    return this.durable.gatewayReadModel();
  }

  startupRecovery(): Promise<SqliteStartupRecovery> {
    this.assertOpen();
    return Promise.resolve(this.context.initialRecovery<SqliteStartupRecovery>());
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
    this.closed = true;
    try {
      await this.context.close();
    } finally {
      await this.lock.release();
    }
  }

  private async writeRequest<TResult>(operation: string, payload: unknown): Promise<TResult> {
    this.assertOpen();
    this.queuedWriters += 1;
    this.maxObservedQueuedWriters = Math.max(this.maxObservedQueuedWriters, this.queuedWriters);
    try {
      return await this.context.request<TResult>(operation, payload);
    } finally {
      this.queuedWriters -= 1;
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
