import type { RunId } from "@himawari-agent/domain";
import type { PayloadRef, TraceEventId } from "./common.js";
import type { RuntimeSuccessfulOutput } from "./intelligence.js";

export type RunCheckpointPhase =
  | "accepted"
  | "context_formed"
  | "workers_running"
  | "runtime_running"
  | "runtime_settled"
  | "reconciling_external_result"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunCheckpoint {
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
}

export interface RunCheckpointStore {
  read(runId: RunId): Promise<StoredRunCheckpoint | undefined>;
  compareAndSet(input: CompareAndSetRunCheckpointInput): Promise<StoredRunCheckpoint>;
}
