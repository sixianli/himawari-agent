import type { MemoryPersonLinkMention, MemoryPersonMention } from "./memory-book.js";
import type { MemoryReminderSchedule } from "./memory-reminders.js";
import type {
  AgentId,
  MemoryGenerationId,
  MemoryId,
  OwnerId,
  RunId,
  ThreadId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { DecisionLedgerWrite } from "./decision-ledger.js";
import type {
  ProductMemoryAttributes,
  ProductMemoryProposal,
  ProductMemoryRecord,
} from "./memory-projection.js";

export type ExtractedMemoryKind =
  | "durable_fact"
  | "decision"
  | "commitment"
  | "experience"
  | "transient";

export interface ExtractedMemoryCandidate {
  readonly kind: ExtractedMemoryKind;
  readonly decision: "create" | "update" | "merge" | "unchanged";
  readonly existingMemoryId: MemoryId | null;
  readonly text: string;
  readonly dataClassification: DataClassification;
  readonly confidencePermille: number;
  readonly inference: boolean;
  readonly sourceRefs: readonly string[];
  readonly sensitiveTopic?: SensitiveMemoryTopic;
  readonly attributes?: ProductMemoryAttributes;
  readonly supersedes?: MemoryId | null;
  readonly reminder?: MemoryReminderSchedule;
  readonly people?: readonly MemoryPersonMention[];
  readonly personLinks?: readonly MemoryPersonLinkMention[];
  readonly quote?: string;
}

export interface IncrementalMemoryExtractionPort {
  extract(input: {
    readonly sourceText: string;
    readonly sourceRef: string;
    readonly sourceClassification: DataClassification;
    readonly policyVersion: string;
    readonly modelDescriptorRef: string;
  }): Promise<readonly ExtractedMemoryCandidate[]>;
}

export interface ApprovedMemoryContentPort {
  store(input: {
    readonly contentKey: string;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly sourceRef: string;
    readonly createdAt: string;
  }): Promise<PayloadRef>;
}

export interface IncrementalMemoryProductPort {
  applyProposal(
    proposal: ProductMemoryProposal,
    generationId: MemoryGenerationId,
    ledger?: DecisionLedgerWrite,
  ): Promise<ProductMemoryRecord>;
}

export interface SensitiveMemoryApprovalRequest {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly generationId: MemoryGenerationId;
  readonly sourceRef: string;
  readonly sourceClassification: DataClassification;
  readonly candidateOrdinal: number;
  readonly productMemoryId: MemoryId;
  readonly decision: ExtractedMemoryCandidate["decision"];
  readonly existingMemoryId: MemoryId | null;
  readonly dataClassification: "sensitive" | "restricted";
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly status: "pending" | "approved" | "edited" | "rejected" | "expired" | "committed";
  readonly deliveryState: "deliverable" | "queued_no_ui";
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly committedAt: string | null;
}

export interface SensitiveMemoryApprovalStatePort {
  create(request: SensitiveMemoryApprovalRequest): Promise<SensitiveMemoryApprovalRequest>;
  read(requestId: string): Promise<SensitiveMemoryApprovalRequest | undefined>;
  resolve(input: {
    readonly requestId: string;
    readonly resolution: "approved" | "edited" | "rejected" | "expired";
    readonly decidedAt: string;
  }): Promise<SensitiveMemoryApprovalRequest>;
  markCommitted(input: {
    readonly requestId: string;
    readonly committedAt: string;
  }): Promise<SensitiveMemoryApprovalRequest>;
  listPending(
    ownerId: OwnerId,
    threadId: ThreadId | null,
  ): Promise<readonly SensitiveMemoryApprovalRequest[]>;
}

export const SENSITIVE_MEMORY_TOPICS = [
  "health",
  "finance",
  "beliefs",
  "intimacy",
  "third_party",
  "location",
  "legal",
  "other",
] as const;

export type SensitiveMemoryTopic = (typeof SENSITIVE_MEMORY_TOPICS)[number];

export interface SensitiveMemoryCandidatePort {
  store(input: {
    readonly request: SensitiveMemoryApprovalRequest;
    readonly candidate: ExtractedMemoryCandidate;
  }): Promise<void>;
  read(request: SensitiveMemoryApprovalRequest): Promise<ExtractedMemoryCandidate | undefined>;
}

export interface MemoryExtractionAuditRecord {
  readonly sourceRef: string;
  readonly generationId: MemoryGenerationId;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly candidateOrdinal: number | null;
  readonly classification: DataClassification;
  readonly outcome:
    | "source_secret_excluded"
    | "candidate_secret_excluded"
    | "restricted_excluded"
    | "extraction_failed"
    | "evidence_unverified"
    | "candidate_invalid"
    | "nothing_to_remember"
    | "transient_ignored"
    | "confidence_below_threshold"
    | "approval_requested"
    | "background_reference_queued"
    | "explicitly_approved"
    | "auto_committed"
    | "approval_rejected"
    | "approval_expired"
    | "approval_committed";
  readonly secretFindings: readonly { readonly ruleId: string; readonly count: number }[];
  readonly occurredAt: string;
}

export interface MemoryExtractionAuditPort {
  record(record: MemoryExtractionAuditRecord): Promise<void>;
}
