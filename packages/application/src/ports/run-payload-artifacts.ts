import type { AgentId, OwnerId, ProductAuthorityFence, RunId } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { PayloadRecord } from "./observability.js";
import type { AuthorityFence } from "./persistence.js";

export const RUN_PAYLOAD_ARTIFACT_PURPOSES = [
  "trace",
  "context",
  "final_answer",
  "worker_result",
] as const;

export type RunPayloadArtifactPurpose = (typeof RUN_PAYLOAD_ARTIFACT_PURPOSES)[number];

export interface RunPayloadArtifactAuthority {
  readonly product: ProductAuthorityFence;
  readonly lease: AuthorityFence;
}

export interface RunPayloadArtifactLookupInput {
  readonly runId: RunId;
  readonly purpose: RunPayloadArtifactPurpose;
  readonly operationKey: string;
}

export interface RunPayloadArtifact extends RunPayloadArtifactLookupInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly payloadRef: PayloadRef;
  readonly contentDigest: string;
  readonly contentType: string;
  readonly dataClassification: DataClassification;
  readonly createdAt: string;
}

export interface RunPayloadArtifactCommitInput extends RunPayloadArtifactLookupInput {
  readonly payload: PayloadRecord;
}

export interface RunPayloadArtifactCommitResult {
  readonly ref: PayloadRef;
  readonly replayed: boolean;
  readonly artifact: RunPayloadArtifact;
}

export interface RunPayloadArtifactPort {
  lookup(input: RunPayloadArtifactLookupInput): Promise<RunPayloadArtifact | undefined>;
  commit(input: RunPayloadArtifactCommitInput): Promise<RunPayloadArtifactCommitResult>;
}
