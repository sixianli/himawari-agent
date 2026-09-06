import type {
  AgentId,
  OwnerId,
  RunId,
  SessionId,
  ThreadId,
  TriggerId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

/** Canonical source of an admitted Run; never inferred from the latest Thread message. */
export interface RunExecutionSource {
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
