import type {
  AgentId,
  IdempotencyKey,
  OwnerId,
  Run,
  RunId,
  RunStatus,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { RuntimeSuccessfulOutput } from "./intelligence.js";
import type { AuthorityFence, CommandResultRecord } from "./persistence.js";

export interface RunCommandContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandFingerprint: string;
  readonly authority: AuthorityFence;
  readonly payloadRef: PayloadRef;
}

export interface TransitionRunStateInput extends RunCommandContext {
  readonly runId: RunId;
  readonly expectedRevision: number;
  readonly nextStatus: RunStatus;
}

export interface StoredRun {
  readonly run: Run;
  readonly revision: number;
}

export interface RunCompletionInput extends RunCommandContext {
  readonly runId: RunId;
  readonly expectedRevision: number;
  readonly output: RuntimeSuccessfulOutput;
  readonly dataClassification: DataClassification;
}

export interface RunTransitionReceipt {
  readonly commandResult: CommandResultRecord;
  readonly replayed: boolean;
}

export interface RunLifecyclePort {
  readRun(runId: RunId): Promise<StoredRun | undefined>;
  transitionRun(input: TransitionRunStateInput): Promise<RunTransitionReceipt>;
  completeRun(input: RunCompletionInput): Promise<RunTransitionReceipt>;
}
