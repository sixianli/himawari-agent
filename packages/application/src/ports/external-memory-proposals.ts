import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type { MemoryCategory } from "./memory-projection.js";

export const EXTERNAL_MEMORY_PROPOSAL_STATUSES = [
  "pending",
  "committed",
  "rejected",
  "superseded",
] as const;

export type ExternalMemoryProposalStatus = (typeof EXTERNAL_MEMORY_PROPOSAL_STATUSES)[number];

export interface ExternalMemoryProposalScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface ExternalMemoryProposalRecord extends ExternalMemoryProposalScope {
  readonly id: string;
  readonly subjectRef: string;
  readonly client: string;
  readonly sourceKey: string | null;
  readonly textSha256: string;
  readonly normalization: string;
  readonly contentRef: string | null;
  readonly category: Exclude<MemoryCategory, "rule">;
  readonly dataClassification: "private" | "sensitive";
  readonly status: ExternalMemoryProposalStatus;
  readonly receivedAt: string;
  readonly decidedAt: string | null;
  readonly batchId: string | null;
  readonly memoryId: MemoryId | null;
  readonly supersededBy: string | null;
}

export type ExternalMemoryProposalSubmission = Pick<
  ExternalMemoryProposalRecord,
  | "ownerId"
  | "agentId"
  | "id"
  | "subjectRef"
  | "client"
  | "sourceKey"
  | "textSha256"
  | "normalization"
  | "contentRef"
  | "category"
  | "dataClassification"
  | "receivedAt"
>;

export interface ExternalMemoryProposalSubmitResult {
  readonly proposal: ExternalMemoryProposalRecord;
  readonly created: boolean;
  readonly superseded: readonly string[];
}

export interface ExternalMemoryProposalBatch {
  readonly batchId: string;
  readonly decidedAt: string;
  readonly committed: number;
  readonly rejected: number;
}

export interface ExternalMemoryProposalStorePort {
  submit(input: ExternalMemoryProposalSubmission): Promise<ExternalMemoryProposalSubmitResult>;
  read(
    input: ExternalMemoryProposalScope & { readonly id: string },
  ): Promise<ExternalMemoryProposalRecord | undefined>;
  listPending(
    input: ExternalMemoryProposalScope & { readonly limit: number },
  ): Promise<{ readonly items: readonly ExternalMemoryProposalRecord[]; readonly total: number }>;
  decide(
    input: ExternalMemoryProposalScope & {
      readonly id: string;
      readonly status: "committed" | "rejected";
      readonly decidedAt: string;
      readonly batchId: string | null;
      readonly memoryId: MemoryId | null;
    },
  ): Promise<boolean>;
  listBatch(
    input: ExternalMemoryProposalScope & { readonly batchId: string },
  ): Promise<readonly ExternalMemoryProposalRecord[]>;
  listBatches(
    input: ExternalMemoryProposalScope & { readonly limit: number },
  ): Promise<readonly ExternalMemoryProposalBatch[]>;
  reopenBatch(
    input: ExternalMemoryProposalScope & {
      readonly batchId: string;
      readonly reopen: readonly string[];
      readonly trashed: readonly string[];
      readonly complete: boolean;
    },
  ): Promise<readonly string[]>;
  dropDiscardedText(
    input: ExternalMemoryProposalScope & { readonly decidedBefore: string },
  ): Promise<number>;
}
