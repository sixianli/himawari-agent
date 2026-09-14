import type {
  AgentId,
  OwnerId,
  RunId,
  SessionId,
  ThreadId,
  TriggerId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export type RunThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RunModelSelection {
  readonly modelRef: string;
  readonly thinkingLevel: RunThinkingLevel;
}

/** Canonical source of an admitted Run; never inferred from the latest Thread message. */
export interface RunExecutionSource {
  readonly modelSelection?: RunModelSelection;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly triggerId: TriggerId;
  readonly sourceType: "user_message" | "schedule" | "external_event";
  readonly sourceId: string;
  readonly payloadRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly occurredAt: string;
}

export interface RunExecutionSourcePort {
  read(runId: RunId): Promise<RunExecutionSource | undefined>;
}
