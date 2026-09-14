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
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

export interface RunCommandContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandFingerprint: string;
  readonly authority: AuthorityFence;
  readonly payloadRef: PayloadRef;
  /** Required for execution-owned writes; omitted only for explicit Owner cancellation. */
  readonly executionLease?: RunExecutionLeaseClaim;
}

export interface TransitionRunStateInput extends RunCommandContext {
  readonly runId: RunId;
  readonly expectedRevision: number;
  readonly nextStatus: RunStatus;
}

export interface RunCancellationInput extends Omit<RunCommandContext, "executionLease"> {
  readonly runId: RunId;
  readonly expectedRevision: number;
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
  cancelRun(input: RunCancellationInput): Promise<RunTransitionReceipt>;
  completeRun(input: RunCompletionInput): Promise<RunTransitionReceipt>;
}
