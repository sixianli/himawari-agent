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
  saveOccurrence(occurrence: BackgroundOccurrence): Promise<BackgroundOccurrence>;
  listRecoverable(
    ownerId: OwnerId,
    agentId: AgentId,
    limit: number,
  ): Promise<readonly BackgroundOccurrence[]>;
}
