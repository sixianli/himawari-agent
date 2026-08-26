import type {
  AgentId,
  CoverageGapId,
  GitHubReceiptId,
  JobId,
  OccurrenceId,
  OwnerId,
} from "@himawari-agent/domain";
import type { PayloadRef } from "./common.js";

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
  readMonitor(monitorId: JobId): Promise<GitHubRepositoryMonitor | undefined>;
  saveMonitor(
    monitor: GitHubRepositoryMonitor,
    expectedRevision: number | null,
  ): Promise<GitHubRepositoryMonitor>;
  recordReceipt(receipt: GitHubWebhookReceiptRecord): Promise<GitHubWebhookReceiptRecord>;
  findReceipt(providerDeliveryId: string): Promise<GitHubWebhookReceiptRecord | undefined>;
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
