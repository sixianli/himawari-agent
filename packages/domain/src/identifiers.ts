import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";

declare const identifierBrand: unique symbol;

type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

export type OwnerId = Identifier<"OwnerId">;
export type AgentId = Identifier<"AgentId">;
export type ThreadId = Identifier<"ThreadId">;
export type SessionId = Identifier<"SessionId">;
export type RunId = Identifier<"RunId">;
export type TurnId = Identifier<"TurnId">;
export type TriggerId = Identifier<"TriggerId">;
export type IdempotencyKey = Identifier<"IdempotencyKey">;
export type AuthorityLeaseId = Identifier<"AuthorityLeaseId">;
export type AuthorityHolderId = Identifier<"AuthorityHolderId">;
export type DeploymentId = Identifier<"DeploymentId">;
export type MessageId = Identifier<"MessageId">;
export type CheckpointJobId = Identifier<"CheckpointJobId">;
export type MemoryGenerationId = Identifier<"MemoryGenerationId">;
export type MemoryId = Identifier<"MemoryId">;
export type DeviceId = Identifier<"DeviceId">;
export type JobId = Identifier<"JobId">;
export type OccurrenceId = Identifier<"OccurrenceId">;
export type GitHubReceiptId = Identifier<"GitHubReceiptId">;
export type CoverageGapId = Identifier<"CoverageGapId">;
export type BackupId = Identifier<"BackupId">;
export type TransferId = Identifier<"TransferId">;
export type HealthSnapshotId = Identifier<"HealthSnapshotId">;
export type SuggestionId = Identifier<"SuggestionId">;
export type ReflectionId = Identifier<"ReflectionId">;
export type DelegationId = Identifier<"DelegationId">;
export type WorkerRunId = Identifier<"WorkerRunId">;
export type ImprovementId = Identifier<"ImprovementId">;

const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function createIdentifier<Kind extends string>(value: string, kind: Kind): Identifier<Kind> {
  if (!MACHINE_IDENTIFIER_PATTERN.test(value)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_IDENTIFIER,
      `${kind} must be a 1-128 character machine identifier`,
      { kind, value },
    );
  }

  return value as Identifier<Kind>;
}

export function createOwnerId(value: string): OwnerId {
  return createIdentifier(value, "OwnerId");
}

export function createAgentId(value: string): AgentId {
  return createIdentifier(value, "AgentId");
}

export function createThreadId(value: string): ThreadId {
  return createIdentifier(value, "ThreadId");
}

export function createSessionId(value: string): SessionId {
  return createIdentifier(value, "SessionId");
}

export function createRunId(value: string): RunId {
  return createIdentifier(value, "RunId");
}

export function createTurnId(value: string): TurnId {
  return createIdentifier(value, "TurnId");
}

export function createTriggerId(value: string): TriggerId {
  return createIdentifier(value, "TriggerId");
}

export function createIdempotencyKey(value: string): IdempotencyKey {
  return createIdentifier(value, "IdempotencyKey");
}

export function createAuthorityLeaseId(value: string): AuthorityLeaseId {
  return createIdentifier(value, "AuthorityLeaseId");
}

export function createAuthorityHolderId(value: string): AuthorityHolderId {
  return createIdentifier(value, "AuthorityHolderId");
}

export function createDeploymentId(value: string): DeploymentId {
  return createIdentifier(value, "DeploymentId");
}

export function createMessageId(value: string): MessageId {
  return createIdentifier(value, "MessageId");
}

export function createCheckpointJobId(value: string): CheckpointJobId {
  return createIdentifier(value, "CheckpointJobId");
}

export function createMemoryGenerationId(value: string): MemoryGenerationId {
  return createIdentifier(value, "MemoryGenerationId");
}

export function createMemoryId(value: string): MemoryId {
  return createIdentifier(value, "MemoryId");
}

export function createDeviceId(value: string): DeviceId {
  return createIdentifier(value, "DeviceId");
}

export function createJobId(value: string): JobId {
  return createIdentifier(value, "JobId");
}

export function createOccurrenceId(value: string): OccurrenceId {
  return createIdentifier(value, "OccurrenceId");
}

export function createGitHubReceiptId(value: string): GitHubReceiptId {
  return createIdentifier(value, "GitHubReceiptId");
}

export function createCoverageGapId(value: string): CoverageGapId {
  return createIdentifier(value, "CoverageGapId");
}

export function createBackupId(value: string): BackupId {
  return createIdentifier(value, "BackupId");
}

export function createTransferId(value: string): TransferId {
  return createIdentifier(value, "TransferId");
}

export function createHealthSnapshotId(value: string): HealthSnapshotId {
  return createIdentifier(value, "HealthSnapshotId");
}

export function createSuggestionId(value: string): SuggestionId {
  return createIdentifier(value, "SuggestionId");
}

export function createReflectionId(value: string): ReflectionId {
  return createIdentifier(value, "ReflectionId");
}

export function createDelegationId(value: string): DelegationId {
  return createIdentifier(value, "DelegationId");
}

export function createWorkerRunId(value: string): WorkerRunId {
  return createIdentifier(value, "WorkerRunId");
}

export function createImprovementId(value: string): ImprovementId {
  return createIdentifier(value, "ImprovementId");
}
