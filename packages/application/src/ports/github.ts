import type {
  AgentId,
  BackgroundOccurrence,
  CoverageGapId,
  GitHubReceiptId,
  JobId,
  OccurrenceId,
  OwnerId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export interface GitHubRepositoryMonitor {
  readonly id: JobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly installationRef: string;
  readonly repositoryRef: string;
  readonly enabledEventRefs: readonly string[];
  readonly authorizationRef: string;
  readonly status: "active" | "paused" | "revoked";
}

export type GitHubMonitorHistoryPolicy = "retain" | "delete";

export interface GitHubMonitorDisclosureConfirmation {
  readonly confirmationRef: string;
  readonly primaryModelRef: string;
  readonly repositoryRef: string;
  readonly disclosedDataClassifications: readonly DataClassification[];
  readonly machineSecretsExcluded: true;
}

/** Applies the Owner's explicit history choice after a monitor is revoked. */
export interface GitHubMonitorHistoryPolicyPort {
  apply(input: {
    readonly monitor: GitHubRepositoryMonitor;
    readonly policy: GitHubMonitorHistoryPolicy;
    readonly requestedBy: string;
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface GitHubMonitorMirrorPort {
  revokeMonitor(monitorId: JobId): Promise<void>;
}

/** GitHub App installation metadata. Secret material is never part of this record. */
export interface GitHubInstallationRecord {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly providerInstallationId: string;
  readonly secretRef: string;
  readonly status: "active" | "revoked";
  readonly createdAt: string;
}

export interface GitHubWebhookReceiptRecord {
  readonly id: GitHubReceiptId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly providerDeliveryId: string;
  readonly installationRef: string;
  readonly repositoryRef: string;
  readonly eventName: string;
  readonly action: string | null;
  readonly payloadRef: PayloadRef;
  readonly status: "received" | "normalized" | "rejected";
  readonly occurrenceId: OccurrenceId | null;
  readonly receivedAt: string;
}

export interface GitHubCoverageGapRecord {
  readonly id: CoverageGapId;
  readonly monitorId: JobId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: "open" | "closed";
  readonly reasonCode: string;
}

export interface GitHubIntegrationStatePort {
  readInstallation(installationRef: string): Promise<GitHubInstallationRecord | undefined>;
  saveInstallation(record: GitHubInstallationRecord): Promise<GitHubInstallationRecord>;
  readMonitor(monitorId: JobId): Promise<GitHubRepositoryMonitor | undefined>;
  saveMonitor(
    monitor: GitHubRepositoryMonitor,
    expectedRevision: number | null,
  ): Promise<GitHubRepositoryMonitor>;
  recordReceipt(receipt: GitHubWebhookReceiptRecord): Promise<GitHubWebhookReceiptRecord>;
  findReceipt(providerDeliveryId: string): Promise<GitHubWebhookReceiptRecord | undefined>;
  readOccurrence(occurrenceId: OccurrenceId): Promise<BackgroundOccurrence | undefined>;
  /** Atomically deduplicates a delivery and creates its one background occurrence. */
  admitWebhook(input: {
    readonly receipt: GitHubWebhookReceiptRecord;
    readonly occurrence: BackgroundOccurrence;
  }): Promise<{
    readonly receipt: GitHubWebhookReceiptRecord;
    readonly occurrence: BackgroundOccurrence;
    readonly replayed: boolean;
  }>;
  saveCoverageGap(gap: GitHubCoverageGapRecord): Promise<GitHubCoverageGapRecord>;
  listCoverageGaps(monitorId: JobId): Promise<readonly GitHubCoverageGapRecord[]>;
}

export interface GitHubReadPort {
  read(input: {
    readonly monitor: GitHubRepositoryMonitor;
    readonly operation: string;
    readonly requestRef: PayloadRef;
    readonly authorizationRef: string;
  }): Promise<{ readonly resultRef: PayloadRef; readonly providerRequestId: string }>;
}
