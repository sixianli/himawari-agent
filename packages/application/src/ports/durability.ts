import type {
  AgentId,
  BackgroundJobState,
  BackgroundOccurrence,
  DeploymentAuthorityState,
  DeploymentId,
  JobId,
  OccurrenceId,
  OwnerId,
  ProductAuthorityFence,
  ProductDataClassification,
  RunId,
} from "@himawari-agent/domain";

export interface PersistenceOpenRequest {
  readonly stateRoot: string;
  readonly expectedSchemaVersion: string;
  readonly busyTimeoutMs: number;
}

export interface PersistenceRuntimeStatus {
  readonly adapterId: string;
  readonly schemaVersion: string;
  readonly sqliteVersion: string;
  readonly journalMode: "wal";
  readonly synchronous: "full";
  readonly quickCheck: "ok" | "failed";
  readonly openedAt: string;
}

export interface PersistenceLifecyclePort {
  open(request: PersistenceOpenRequest): Promise<PersistenceRuntimeStatus>;
  status(): Promise<PersistenceRuntimeStatus>;
  integrityCheck(): Promise<{ readonly ok: boolean; readonly resultRef: string }>;
  close(): Promise<void>;
}

export interface DeploymentAuthorityStatePort {
  read(deploymentId: DeploymentId): Promise<DeploymentAuthorityState | undefined>;
  save(
    deployment: DeploymentAuthorityState,
    expectedRevision: number,
  ): Promise<DeploymentAuthorityState>;
  assertCurrent(fence: ProductAuthorityFence): Promise<DeploymentAuthorityState>;
}

export interface BackgroundWorkStatePort {
  readJob(jobId: JobId): Promise<BackgroundJobState | undefined>;
  saveJob(job: BackgroundJobState, expectedRevision: number): Promise<BackgroundJobState>;
  readOccurrence(occurrenceId: OccurrenceId): Promise<BackgroundOccurrence | undefined>;
  createOccurrence(occurrence: BackgroundOccurrence): Promise<BackgroundOccurrence>;
  saveOccurrence(
    occurrence: BackgroundOccurrence,
    expectedRevision: number,
  ): Promise<BackgroundOccurrence>;
  reserveAdmission(input: BackgroundAdmissionReservation): Promise<BackgroundAdmissionResult>;
  claimOccurrence(input: BackgroundOccurrenceClaim): Promise<BackgroundOccurrence>;
  settleOccurrence(input: BackgroundOccurrenceSettlement): Promise<BackgroundOccurrence>;
  listByJob(jobId: JobId, limit: number): Promise<readonly BackgroundOccurrence[]>;
  listRecoverable(
    ownerId: OwnerId,
    agentId: AgentId,
    now: string,
    limit: number,
  ): Promise<readonly BackgroundOccurrence[]>;
}

export interface BackgroundAdmissionLimits {
  readonly globalCostMicros: number;
  readonly perRunCostMicros: number;
  readonly perClassificationCostMicros: Readonly<Record<ProductDataClassification, number>>;
  readonly totalRuns: number;
  readonly foregroundReserved: number;
  readonly perCategory: Readonly<Record<string, number>>;
}

export interface BackgroundAdmissionReservation {
  readonly occurrenceId: OccurrenceId;
  readonly expectedRevision: number;
  readonly runId: RunId;
  readonly authority: ProductAuthorityFence;
  readonly limits: BackgroundAdmissionLimits;
  readonly admittedAt: string;
}

export interface BackgroundAdmissionResult {
  readonly occurrence: BackgroundOccurrence;
  readonly outcome:
    | "admitted"
    | "budget_blocked"
    | "capacity_blocked"
    | "deadline_exceeded"
    | "blocked"
    | "reconcile_required"
    | "duplicate";
  readonly reasonCode:
    | "ADMITTED"
    | "ALREADY_ADMITTED"
    | "JOB_ALREADY_ACTIVE"
    | "GLOBAL_BUDGET_EXHAUSTED"
    | "CLASSIFICATION_BUDGET_EXHAUSTED"
    | "RUN_BUDGET_EXCEEDED"
    | "TOTAL_CAPACITY_EXHAUSTED"
    | "FOREGROUND_CAPACITY_RESERVED"
    | "CATEGORY_CAPACITY_EXHAUSTED"
    | "DEADLINE_EXCEEDED"
    | "CREDENTIALS_BLOCKED"
    | "AUTHORIZATION_BLOCKED"
    | "MODEL_BLOCKED"
    | "RETRY_NOT_DUE"
    | "EXTERNAL_RESULT_RECONCILIATION_REQUIRED";
}

export interface BackgroundOccurrenceClaim {
  readonly occurrenceId: OccurrenceId;
  readonly expectedRevision: number;
  readonly authority: ProductAuthorityFence;
  readonly leaseId: string;
  readonly holderId: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export type BackgroundFailureClass =
  | "transport"
  | "provider"
  | "credential"
  | "authorization"
  | "policy"
  | "invalid_input";

export interface BackgroundOccurrenceSettlement {
  readonly occurrenceId: OccurrenceId;
  readonly expectedRevision: number;
  readonly authority: ProductAuthorityFence;
  readonly leaseId: string;
  readonly settledAt: string;
  readonly outcome: "completed" | "failed" | "model_blocked" | "external_result_unknown";
  readonly spentCostMicros: number;
  readonly errorCode: string | null;
  readonly failureClass: BackgroundFailureClass | null;
  readonly retry: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterSeed: number;
  };
}
