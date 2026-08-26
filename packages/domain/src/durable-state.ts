import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";
import type {
  AgentId,
  BackupId,
  CheckpointJobId,
  CoverageGapId,
  DeploymentId,
  DeviceId,
  GitHubReceiptId,
  HealthSnapshotId,
  JobId,
  MemoryGenerationId,
  MemoryId,
  MessageId,
  OccurrenceId,
  OwnerId,
  RunId,
  SessionId,
  ThreadId,
  TransferId,
} from "./identifiers.js";

export type ProductDataClassification = "public" | "private" | "sensitive" | "restricted";

export interface ProductAuthorityFence {
  readonly deploymentId: DeploymentId;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export type DeploymentStatus = "inactive_ready" | "active" | "retired_pending_transfer" | "retired";

export interface DeploymentAuthorityState {
  readonly id: DeploymentId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly status: DeploymentStatus;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly transferId: TransferId | null;
}

function invalidTransition(kind: string, current: string, next: string): never {
  throw new DomainError(
    DOMAIN_ERROR_CODES.INVALID_STATE_TRANSITION,
    `${kind} cannot transition from ${current} to ${next}`,
    { kind, current, next },
  );
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      `${field} must be a positive safe integer`,
      { field, value: String(value) },
    );
  }
}

export function activateDeployment(
  deployment: DeploymentAuthorityState,
  next: { readonly authorityEpoch: number; readonly fencingToken: number },
): DeploymentAuthorityState {
  if (deployment.status !== "inactive_ready") {
    return invalidTransition("deployment", deployment.status, "active");
  }
  assertPositiveInteger(next.authorityEpoch, "authorityEpoch");
  assertPositiveInteger(next.fencingToken, "fencingToken");
  if (next.authorityEpoch <= deployment.authorityEpoch) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.STALE_AUTHORITY_FENCE,
      "A deployment must activate with a monotonically higher authority epoch",
      {
        currentEpoch: String(deployment.authorityEpoch),
        requestedEpoch: String(next.authorityEpoch),
      },
    );
  }
  return Object.freeze({
    ...deployment,
    revision: deployment.revision + 1,
    status: "active" as const,
    authorityEpoch: next.authorityEpoch,
    fencingToken: next.fencingToken,
  });
}

export function retireDeployment(
  deployment: DeploymentAuthorityState,
  next: "retired_pending_transfer" | "retired",
): DeploymentAuthorityState {
  const allowed =
    (deployment.status === "active" && next === "retired_pending_transfer") ||
    (deployment.status === "retired_pending_transfer" && next === "retired");
  if (!allowed) return invalidTransition("deployment", deployment.status, next);
  return Object.freeze({ ...deployment, revision: deployment.revision + 1, status: next });
}

export function assertAuthorityFence(
  deployment: DeploymentAuthorityState,
  fence: ProductAuthorityFence,
): void {
  if (
    deployment.status !== "active" ||
    deployment.id !== fence.deploymentId ||
    deployment.authorityEpoch !== fence.authorityEpoch ||
    deployment.fencingToken !== fence.fencingToken
  ) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.STALE_AUTHORITY_FENCE,
      "The operation does not carry the active deployment authority fence",
      {
        deploymentId: deployment.id,
        status: deployment.status,
        authorityEpoch: String(deployment.authorityEpoch),
        fencingToken: String(deployment.fencingToken),
      },
    );
  }
}

export interface ProductThreadMessage {
  readonly id: MessageId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly role: "owner" | "agent" | "system";
  readonly contentRef: string;
  readonly dataClassification: ProductDataClassification;
  readonly committedAt: string;
}

export function createProductThreadMessage(input: ProductThreadMessage): ProductThreadMessage {
  assertPositiveInteger(input.sequence, "message.sequence");
  if (input.contentRef.length === 0) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      "A committed message requires a Payload reference",
      { field: "contentRef", value: "" },
    );
  }
  return Object.freeze({ ...input });
}

export type ThreadCheckpointStatus =
  | "pending"
  | "running"
  | "completed"
  | "retry_wait"
  | "failed_terminal";

export interface ThreadCheckpointJob {
  readonly id: CheckpointJobId;
  readonly generationId: MemoryGenerationId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly status: ThreadCheckpointStatus;
  readonly attemptCount: number;
  readonly requestedAt: string;
}

export function createThreadCheckpointJob(
  input: Omit<ThreadCheckpointJob, "status" | "attemptCount">,
): ThreadCheckpointJob {
  assertPositiveInteger(input.sourceWatermark, "sourceWatermark");
  return Object.freeze({ ...input, status: "pending" as const, attemptCount: 0 });
}

const CHECKPOINT_TRANSITIONS: Readonly<
  Record<ThreadCheckpointStatus, ReadonlySet<ThreadCheckpointStatus>>
> = {
  pending: new Set(["running"]),
  running: new Set(["completed", "retry_wait", "failed_terminal"]),
  retry_wait: new Set(["running", "failed_terminal"]),
  completed: new Set(),
  failed_terminal: new Set(),
};

export function transitionCheckpointJob(
  job: ThreadCheckpointJob,
  next: ThreadCheckpointStatus,
): ThreadCheckpointJob {
  if (!CHECKPOINT_TRANSITIONS[job.status].has(next)) {
    return invalidTransition("thread_checkpoint", job.status, next);
  }
  return Object.freeze({
    ...job,
    status: next,
    attemptCount: next === "running" ? job.attemptCount + 1 : job.attemptCount,
  });
}

export type MemoryGenerationStatus = "pending" | "running" | "completed" | "failed_terminal";

export interface MemoryGenerationState {
  readonly id: MemoryGenerationId;
  readonly checkpointJobId: CheckpointJobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly status: MemoryGenerationStatus;
  readonly modelDescriptorRef: string;
  readonly policyVersion: string;
  readonly outputRef: string | null;
}

const GENERATION_TRANSITIONS: Readonly<
  Record<MemoryGenerationStatus, ReadonlySet<MemoryGenerationStatus>>
> = {
  pending: new Set(["running", "failed_terminal"]),
  running: new Set(["completed", "failed_terminal"]),
  completed: new Set(),
  failed_terminal: new Set(),
};

export function transitionMemoryGeneration(
  generation: MemoryGenerationState,
  next: MemoryGenerationStatus,
  outputRef: string | null = null,
): MemoryGenerationState {
  if (!GENERATION_TRANSITIONS[generation.status].has(next)) {
    return invalidTransition("memory_generation", generation.status, next);
  }
  if ((next === "completed") !== (outputRef !== null)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      "Only a completed Memory generation may carry an output reference",
      { next, outputRef: outputRef ?? "" },
    );
  }
  return Object.freeze({ ...generation, status: next, outputRef });
}

export interface BrowserSessionState {
  readonly id: SessionId;
  readonly ownerId: OwnerId;
  readonly deviceId: DeviceId;
  readonly status: "active" | "revoked";
  readonly authenticationRef: string;
  readonly firstAuthenticatedAt: string;
  readonly lastActiveAt: string;
  readonly recentAuthenticatedAt: string;
  readonly revokedAt: string | null;
}

export interface DeviceState {
  readonly id: DeviceId;
  readonly ownerId: OwnerId;
  readonly label: string;
  readonly status: "active" | "revoked";
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export function revokeBrowserSession(
  session: BrowserSessionState,
  revokedAt: string,
): BrowserSessionState {
  if (session.status !== "active") {
    return invalidTransition("browser_session", session.status, "revoked");
  }
  return Object.freeze({ ...session, status: "revoked" as const, revokedAt });
}

export type BackgroundJobStatus = "active" | "paused" | "revoked";

export interface BackgroundJobState {
  readonly id: JobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly revision: number;
  readonly status: BackgroundJobStatus;
  readonly authorizationRef: string;
  readonly nextOccurrenceAt: string | null;
}

const BACKGROUND_JOB_TRANSITIONS: Readonly<
  Record<BackgroundJobStatus, ReadonlySet<BackgroundJobStatus>>
> = {
  active: new Set(["paused", "revoked"]),
  paused: new Set(["active", "revoked"]),
  revoked: new Set(),
};

export function transitionBackgroundJob(
  job: BackgroundJobState,
  next: BackgroundJobStatus,
): BackgroundJobState {
  if (!BACKGROUND_JOB_TRANSITIONS[job.status].has(next)) {
    return invalidTransition("background_job", job.status, next);
  }
  return Object.freeze({ ...job, revision: job.revision + 1, status: next });
}

export type BackgroundOccurrenceStatus =
  | "queued"
  | "admitted"
  | "running"
  | "retry_wait"
  | "blocked_credentials"
  | "blocked_approval"
  | "budget_blocked"
  | "capacity_blocked"
  | "completed"
  | "failed_terminal"
  | "missed";

export interface BackgroundOccurrence {
  readonly id: OccurrenceId;
  readonly jobId: JobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly stableKey: string;
  readonly status: BackgroundOccurrenceStatus;
  readonly authority: ProductAuthorityFence;
  readonly category: string;
  readonly dataClassification: ProductDataClassification;
  readonly foreground: boolean;
  readonly parallelSafe: boolean;
  readonly estimatedCostMicros: number;
  readonly reservedCostMicros: number;
  readonly spentCostMicros: number;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly deadlineAt: string;
  readonly runId: RunId | null;
  readonly workLease: {
    readonly id: string;
    readonly holderId: string;
    readonly acquiredAt: string;
    readonly expiresAt: string;
  } | null;
  readonly lastErrorCode: string | null;
}

const OCCURRENCE_TRANSITIONS: Readonly<
  Record<BackgroundOccurrenceStatus, ReadonlySet<BackgroundOccurrenceStatus>>
> = {
  queued: new Set([
    "admitted",
    "retry_wait",
    "blocked_credentials",
    "blocked_approval",
    "budget_blocked",
    "capacity_blocked",
    "failed_terminal",
    "missed",
  ]),
  admitted: new Set(["running", "failed_terminal"]),
  running: new Set(["completed", "retry_wait", "failed_terminal"]),
  retry_wait: new Set(["queued", "failed_terminal"]),
  blocked_credentials: new Set(["queued", "failed_terminal"]),
  blocked_approval: new Set(["queued", "failed_terminal"]),
  budget_blocked: new Set(["queued", "failed_terminal"]),
  capacity_blocked: new Set(["queued", "failed_terminal"]),
  completed: new Set(),
  failed_terminal: new Set(),
  missed: new Set(),
};

export function transitionOccurrence(
  occurrence: BackgroundOccurrence,
  next: BackgroundOccurrenceStatus,
): BackgroundOccurrence {
  if (!OCCURRENCE_TRANSITIONS[occurrence.status].has(next)) {
    return invalidTransition("occurrence", occurrence.status, next);
  }
  return Object.freeze({
    ...occurrence,
    revision: occurrence.revision + 1,
    status: next,
    attemptCount: next === "running" ? occurrence.attemptCount + 1 : occurrence.attemptCount,
  });
}

export type MemoryLifecycleStatus =
  | "active"
  | "archived"
  | "trashed"
  | "deletion_pending"
  | "deleted_verified";

export interface ProductMemoryLifecycle {
  readonly id: MemoryId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly status: MemoryLifecycleStatus;
  readonly providerRecordId: string | null;
}

const MEMORY_TRANSITIONS: Readonly<
  Record<MemoryLifecycleStatus, ReadonlySet<MemoryLifecycleStatus>>
> = {
  active: new Set(["archived", "trashed", "deletion_pending"]),
  archived: new Set(["active", "trashed", "deletion_pending"]),
  trashed: new Set(["active", "deletion_pending"]),
  deletion_pending: new Set(["deleted_verified"]),
  deleted_verified: new Set(),
};

export function transitionMemoryLifecycle(
  memory: ProductMemoryLifecycle,
  next: MemoryLifecycleStatus,
): ProductMemoryLifecycle {
  if (!MEMORY_TRANSITIONS[memory.status].has(next)) {
    return invalidTransition("memory", memory.status, next);
  }
  return Object.freeze({ ...memory, revision: memory.revision + 1, status: next });
}

export interface GitHubWebhookReceipt {
  readonly id: GitHubReceiptId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly providerDeliveryId: string;
  readonly installationRef: string;
  readonly repositoryRef: string;
  readonly payloadRef: string;
  readonly status: "received" | "normalized" | "rejected";
  readonly occurrenceId: OccurrenceId | null;
}

export interface GitHubCoverageGap {
  readonly id: CoverageGapId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly monitorId: JobId;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: "open" | "closed";
}

export function transitionGitHubReceipt(
  receipt: GitHubWebhookReceipt,
  next: "normalized" | "rejected",
  occurrenceId: OccurrenceId | null,
): GitHubWebhookReceipt {
  if (receipt.status !== "received") {
    return invalidTransition("github_receipt", receipt.status, next);
  }
  if ((next === "normalized") !== (occurrenceId !== null)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      "Only a normalized GitHub receipt may carry an occurrence ID",
      { next, occurrenceId: occurrenceId ?? "" },
    );
  }
  return Object.freeze({ ...receipt, status: next, occurrenceId });
}

export function closeCoverageGap(gap: GitHubCoverageGap, endedAt: string): GitHubCoverageGap {
  if (gap.status !== "open") return invalidTransition("github_coverage_gap", gap.status, "closed");
  return Object.freeze({ ...gap, status: "closed" as const, endedAt });
}

export interface RecoveryPointState {
  readonly id: BackupId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly status: "creating" | "verified" | "failed";
  readonly manifestRef: string | null;
}

export function transitionRecoveryPoint(
  recoveryPoint: RecoveryPointState,
  next: "verified" | "failed",
  manifestRef: string | null,
): RecoveryPointState {
  if (recoveryPoint.status !== "creating") {
    return invalidTransition("recovery_point", recoveryPoint.status, next);
  }
  if ((next === "verified") !== (manifestRef !== null)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      "Only a verified recovery point may carry a manifest reference",
      { next, manifestRef: manifestRef ?? "" },
    );
  }
  return Object.freeze({ ...recoveryPoint, status: next, manifestRef });
}

export type TransferStatus =
  | "proposed"
  | "exporting"
  | "exported_verified"
  | "importing"
  | "inactive_ready"
  | "activated"
  | "abandoned";

export interface TransferState {
  readonly id: TransferId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sourceDeploymentId: DeploymentId;
  readonly targetDeploymentId: DeploymentId;
  readonly status: TransferStatus;
  readonly authorityEpoch: number;
  readonly packageRef: string | null;
}

const TRANSFER_TRANSITIONS: Readonly<Record<TransferStatus, ReadonlySet<TransferStatus>>> = {
  proposed: new Set(["exporting", "abandoned"]),
  exporting: new Set(["exported_verified", "abandoned"]),
  exported_verified: new Set(["importing", "abandoned"]),
  importing: new Set(["inactive_ready", "abandoned"]),
  inactive_ready: new Set(["activated", "abandoned"]),
  activated: new Set(),
  abandoned: new Set(),
};

export function transitionTransfer(transfer: TransferState, next: TransferStatus): TransferState {
  if (!TRANSFER_TRANSITIONS[transfer.status].has(next)) {
    return invalidTransition("transfer", transfer.status, next);
  }
  return Object.freeze({ ...transfer, status: next });
}

export type DependencyHealthStatus = "healthy" | "degraded" | "unavailable";

export interface DependencyHealth {
  readonly name: string;
  readonly required: boolean;
  readonly status: DependencyHealthStatus;
  readonly reasonCode: string | null;
}

export interface DeploymentHealthSnapshot {
  readonly id: HealthSnapshotId;
  readonly live: boolean;
  readonly ready: boolean;
  readonly status: "healthy" | "degraded" | "not_ready" | "not_live";
  readonly dependencies: readonly DependencyHealth[];
}

export function evaluateDeploymentHealth(input: {
  readonly live: boolean;
  readonly authorityActive: boolean;
  readonly snapshotId: HealthSnapshotId;
  readonly dependencies: readonly DependencyHealth[];
}): DeploymentHealthSnapshot {
  const requiredUnavailable = input.dependencies.some(
    (dependency) => dependency.required && dependency.status !== "healthy",
  );
  const ready = input.live && input.authorityActive && !requiredUnavailable;
  const degraded = input.dependencies.some((dependency) => dependency.status !== "healthy");
  return Object.freeze({
    id: input.snapshotId,
    live: input.live,
    ready,
    status: !input.live ? "not_live" : !ready ? "not_ready" : degraded ? "degraded" : "healthy",
    dependencies: Object.freeze([...input.dependencies]),
  });
}
