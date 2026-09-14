import type { RunId } from "@himawari-agent/domain";
import type { PayloadRef, TraceEventId } from "./common.js";
import type { RuntimeApprovalWait, RuntimeSuccessfulOutput } from "./intelligence.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

export type RunCheckpointPhase =
  | "accepted"
  | "context_formed"
  | "workers_running"
  | "runtime_running"
  | "awaiting_approval"
  | "runtime_settled"
  | "reconciling_external_result"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunCheckpoint {
  readonly suspension?: {
    readonly version: "runtime-suspension.v1";
    readonly continuationRef: PayloadRef;
    readonly approval: RuntimeApprovalWait;
    readonly executionDeadlineAt?: string;
  };
  readonly phase: RunCheckpointPhase;
  readonly contextRef: PayloadRef | null;
  readonly workerResults: Readonly<Record<string, PayloadRef>>;
  readonly runtimeEventCount: number;
  readonly lastTraceEventId: TraceEventId | null;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | null;
  readonly output: RuntimeSuccessfulOutput | null;
  readonly diagnosticCode: string | null;
}

export interface StoredRunCheckpoint {
  readonly runId: RunId;
  readonly revision: number;
  readonly checkpoint: RunCheckpoint;
}

export interface CompareAndSetRunCheckpointInput {
  readonly runId: RunId;
  readonly expectedRevision: number | null;
  readonly checkpoint: RunCheckpoint;
  /** Required for execution-owned checkpoint writes. */
  readonly executionLease?: RunExecutionLeaseClaim;
}

export interface RunCheckpointStore {
  read(runId: RunId): Promise<StoredRunCheckpoint | undefined>;
  compareAndSet(input: CompareAndSetRunCheckpointInput): Promise<StoredRunCheckpoint>;
}
