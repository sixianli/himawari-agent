import type {
  AgentId,
  MessageId,
  OwnerId,
  RunId,
  RunStatus,
  SessionId,
  ThreadId,
} from "@himawari-agent/domain";
import { RUN_STATUSES } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { RuntimeHistoryReference } from "./runtime-history.js";

export type ProductContextTriggerSource = "user_message" | "schedule" | "external_event";

export type ProductContextMessageRole = "owner" | "agent" | "system";

/** Canonical Run state at context formation time, not at replay time. */
export interface ProductContextRunState {
  readonly runId: RunId;
  readonly status: RunStatus;
}

export function isProductContextRunState(value: unknown): value is ProductContextRunState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["runId"] === "string" &&
    record["runId"].trim().length > 0 &&
    typeof record["status"] === "string" &&
    (RUN_STATUSES as readonly string[]).includes(record["status"])
  );
}

export interface ProductContextHistoryItem {
  readonly messageId: MessageId;
  readonly role: ProductContextMessageRole;
  readonly contentRef: PayloadRef;
  readonly occurredAt: string;
  readonly dataClassification: DataClassification;
  /** Absent in older persisted envelopes or messages with no associated Run. */
  readonly runState?: ProductContextRunState;
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
  readonly runtimeHistory?: {
    readonly reference: RuntimeHistoryReference;
    readonly runState: ProductContextRunState;
  };
  readonly prompt: ProductContextPrompt;
  readonly systemPolicyRefs: readonly ProductContextSystemPolicyRef[];
  readonly contextBlocks: readonly ProductContextBlock[];
}

export function contextArtifactOperationKey(runId: RunId): string {
  return `context:${runId}`;
}
