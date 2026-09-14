import type { AgentId, MessageId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

/** Metadata only: canonical text remains in the scoped protected Payload store. */
export type ThreadSearchProjectionSource = {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly payloadRef: PayloadRef;
  readonly dataClassification: DataClassification;
} & (
  | { readonly kind: "title"; readonly titleRevision: number }
  | { readonly kind: "message"; readonly messageId: MessageId; readonly sequence: number }
);

export interface ThreadSearchProjectionSourcePort {
  pending(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly projectionVersion: string;
    readonly limit: number;
  }): Promise<readonly ThreadSearchProjectionSource[]>;
}
