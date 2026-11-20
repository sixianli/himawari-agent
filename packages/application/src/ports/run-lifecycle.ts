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

export interface RunBackgroundHold {
  readonly taskRef: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly commandRef?: string;
}

export type RunBackgroundOutcome = "completed" | "failed" | "stopped" | "timed_out" | "interrupted";

export interface RunCompletionInput extends RunCommandContext {
  readonly runId: RunId;
  readonly expectedRevision: number;
  readonly output: RuntimeSuccessfulOutput;
  readonly dataClassification: DataClassification;
  readonly background?: { readonly holds: readonly RunBackgroundHold[] };
  readonly recoveryCheckpointRevision?: number;
}

export interface RunTransitionReceipt {
  readonly commandResult: CommandResultRecord;
  readonly replayed: boolean;
}

export interface FinishBackgroundRunInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly idempotencyKey: IdempotencyKey;
  readonly authority: AuthorityFence;
  readonly executionLease?: RunExecutionLeaseClaim;
  readonly outcomes: readonly {
    readonly taskRef: string;
    readonly outcome: RunBackgroundOutcome;
    readonly outputRef?: string;
  }[];
  readonly notice: {
    readonly triggerId: string;
    readonly runId: RunId;
    readonly turnId: string;
    readonly messageId: string;
    readonly contentRef: PayloadRef;
    readonly dataClassification: DataClassification;
  };
}

export interface FinishBackgroundRunResult {
  readonly finished: boolean;
  readonly noticeRunId: RunId | null;
}

export interface BackgroundRunRecord {
  readonly runId: RunId;
  readonly threadId: string;
  readonly holds: readonly RunBackgroundHold[];
  readonly runStatus: RunStatus;
  readonly leaseLive: boolean;
  readonly resourcesReleased: boolean;
}

export interface UnattendedRunRecord {
  readonly runId: RunId;
  readonly threadId: string | null;
  readonly state: "running" | "failed";
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface RunLifecyclePort {
  readRun(runId: RunId): Promise<StoredRun | undefined>;
  transitionRun(input: TransitionRunStateInput): Promise<RunTransitionReceipt>;
  cancelRun(input: RunCancellationInput): Promise<RunTransitionReceipt>;
  completeRun(input: RunCompletionInput): Promise<RunTransitionReceipt>;
  finishBackgroundRun?(input: FinishBackgroundRunInput): Promise<FinishBackgroundRunResult>;
  listBackgroundRuns?(): Promise<readonly BackgroundRunRecord[]>;
  listUnattendedRuns?(input: {
    readonly failedSince: string;
    readonly limit: number;
  }): Promise<readonly UnattendedRunRecord[]>;
}
