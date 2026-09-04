import type {
  AgentId,
  MessageId,
  OwnerId,
  RunId,
  SessionId,
  ThreadId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export type ProductContextTriggerSource = "user_message" | "schedule" | "external_event";

export type ProductContextMessageRole = "owner" | "agent" | "system";

export interface ProductContextHistoryItem {
  readonly messageId: MessageId;
  readonly role: ProductContextMessageRole;
  readonly contentRef: PayloadRef;
  readonly occurredAt: string;
  readonly dataClassification: DataClassification;
}

export interface ProductContextPrompt {
  readonly id: string;
  readonly sourceType: ProductContextTriggerSource;
  readonly payloadRef: PayloadRef;
  readonly occurredAt: string;
}

export interface ProductContextSystemPolicyRef {
  readonly ref: string;
  readonly payloadRef: PayloadRef;
  readonly kind: "policy" | "answer-locale";
}

export type ProductContextBlockKind = "thread-summary" | "memory" | "capability-summary";

export interface ProductContextBlock {
  readonly kind: ProductContextBlockKind;
  readonly ref: string;
  readonly payloadRef: PayloadRef;
  readonly sourceRef?: string;
  readonly dataClassification: DataClassification;
}

export interface ProductContextEnvelopeV1 {
  readonly schemaVersion: "context.v1";
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly formedAt: string;
  readonly sourceWatermark: number | null;
  readonly policyVersion: string;
  readonly history: readonly ProductContextHistoryItem[];
  readonly prompt: ProductContextPrompt;
  readonly systemPolicyRefs: readonly ProductContextSystemPolicyRef[];
  readonly contextBlocks: readonly ProductContextBlock[];
}

export function contextArtifactOperationKey(runId: RunId): string {
  return `context:${runId}`;
}
