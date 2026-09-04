import type {
  RunCheckpoint,
  RunCheckpointPhase,
  RunExecutionLeaseClaim,
  RunExecutionLeaseTransactionGuard,
  StoredRunCheckpoint,
} from "@himawari-agent/application";
import {
  createAuthorityLeaseId,
  createDeploymentId,
  createRunExecutionLeaseId,
  createRunId,
} from "@himawari-agent/domain";
import type { ProductAuthorityFence } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid checkpoint object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Invalid checkpoint text");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Invalid checkpoint integer");
  return value;
}
function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}
const phases: readonly RunCheckpointPhase[] = [
  "accepted",
  "context_formed",
  "workers_running",
  "runtime_running",
  "runtime_settled",
  "reconciling_external_result",
  "completed",
  "failed",
  "cancelled",
];

type ExecutionLeaseGuard = Pick<RunExecutionLeaseTransactionGuard, "assertHeldInTransaction">;
type ExecutionLeaseGuardFactory = (input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly authority: ProductAuthorityFence;
  readonly authorityLeaseId: string;
  readonly authorityFencingToken: number;
  readonly consumerId: string;
}) => ExecutionLeaseGuard;

function executionLeaseFromInput(value: unknown): RunExecutionLeaseClaim | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  return {
    executionLeaseId: createRunExecutionLeaseId(text(input["executionLeaseId"])),
    expectedLeaseRevision: integer(input["expectedLeaseRevision"]),
    authorityLeaseId: createAuthorityLeaseId(text(input["authorityLeaseId"])),
    authorityFencingToken: integer(input["authorityFencingToken"]),
    deploymentId: createDeploymentId(text(input["deploymentId"])),
    authorityEpoch: integer(input["authorityEpoch"]),
    fencingToken: integer(input["fencingToken"]),
    consumerId: text(input["consumerId"]),
  };
}

function checkpoint(value: unknown): RunCheckpoint {
  const input = record(value);
  const phase = phases.find((phase) => phase === input["phase"]);
  if (!phase) throw new TypeError("Invalid checkpoint phase");
  const terminalStatus = input["terminalStatus"];
  if (
    terminalStatus !== null &&
    terminalStatus !== "completed" &&
    terminalStatus !== "failed" &&
    terminalStatus !== "cancelled"
  )
    throw new TypeError("Invalid checkpoint terminal status");
  const workerResults = Object.create(null) as Record<string, string>;
  for (const [workerId, ref] of Object.entries(record(input["workerResults"])))
    workerResults[text(workerId)] = text(ref);
  let output: RunCheckpoint["output"] = null;
  if (input["output"] !== null) {
    const raw = record(input["output"]);
    if (raw["kind"] === "assistant-answer")
      output = { kind: "assistant-answer", contentRef: text(raw["contentRef"]) };
    else if (raw["kind"] === "no-answer" && raw["contentRef"] === undefined)
      output = { kind: "no-answer" };
    else throw new TypeError("Invalid checkpoint output");
  }
  return {
    phase,
    terminalStatus,
    output,
    workerResults,
    contextRef: optionalText(input["contextRef"]),
    runtimeEventCount: integer(input["runtimeEventCount"]),
    lastTraceEventId: optionalText(input["lastTraceEventId"]),
    diagnosticCode: optionalText(input["diagnosticCode"]),
  };
}

export class SqliteRunCheckpointOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly assertAuthority: (
    ownerId: string,
    agentId: string,
    fence: ProductAuthorityFence,
  ) => void;
  private readonly executionLease: ExecutionLeaseGuardFactory;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    assertAuthority: (ownerId: string, agentId: string, fence: ProductAuthorityFence) => void,
    executionLease: ExecutionLeaseGuardFactory,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.assertAuthority = assertAuthority;
    this.executionLease = executionLease;
  }

  execute(operation: string, value: unknown): StoredRunCheckpoint | undefined {
    let input: Record<string, unknown>;
    let ownerId: string;
    let agentId: string;
    let runId: ReturnType<typeof createRunId>;
    try {
      input = record(value);
      ownerId = text(input["ownerId"]);
      agentId = text(input["agentId"]);
      runId = createRunId(text(input["runId"]));
    } catch (error) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        error instanceof Error ? error.message : "Invalid checkpoint operation",
      );
    }
    if (operation === "runCheckpoint.read") return this.read(ownerId, agentId, runId);
    if (operation !== "runCheckpoint.compareAndSet")
      return this.fail("PORT_INVALID_OPERATION", "Unknown Run checkpoint operation");
    let expectedRevision: number | null;
    let authority: ProductAuthorityFence;
    let updatedAt: string;
    let executionLease: RunExecutionLeaseClaim | undefined;
    try {
      expectedRevision =
        input["expectedRevision"] === null ? null : integer(input["expectedRevision"]);
      const rawAuthority = record(input["authority"]);
      authority = {
        deploymentId: createDeploymentId(text(rawAuthority["deploymentId"])),
        authorityEpoch: integer(rawAuthority["authorityEpoch"]),
        fencingToken: integer(rawAuthority["fencingToken"]),
      };
      updatedAt = text(input["updatedAt"]);
      if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError("Invalid checkpoint time");
      executionLease = executionLeaseFromInput(input["executionLease"]);
    } catch (error) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        error instanceof Error ? error.message : "Invalid checkpoint operation",
      );
    }
    let next: RunCheckpoint;
    try {
      next = checkpoint(input["checkpoint"]);
    } catch (error) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        error instanceof Error ? error.message : "Invalid checkpoint",
      );
    }
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        this.assertAuthority(ownerId, agentId, {
          deploymentId: text(authority["deploymentId"]) as ProductAuthorityFence["deploymentId"],
          authorityEpoch: integer(authority["authorityEpoch"]),
          fencingToken: integer(authority["fencingToken"]),
        });
        if (
          !this.database
            .prepare("SELECT 1 FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
            .get(runId, ownerId, agentId)
        )
          return this.fail("PORT_NOT_AUTHORITATIVE", "Checkpoint Run is outside the bound scope", {
            runId,
          });
        const current = this.read(ownerId, agentId, runId);
        if ((current?.revision ?? null) !== expectedRevision)
          return this.fail("PORT_CONFLICT", "Run checkpoint revision conflict", { runId });
        if (!executionLease)
          return this.fail(
            "PORT_NOT_AUTHORITATIVE",
            "Execution-owned checkpoint write requires an execution lease",
            { runId },
          );
        if (
          executionLease.deploymentId !== authority.deploymentId ||
          executionLease.authorityEpoch !== authority.authorityEpoch ||
          executionLease.fencingToken !== authority.fencingToken
        )
          return this.fail(
            "PORT_NOT_AUTHORITATIVE",
            "Execution lease claim does not match checkpoint authority",
            { runId },
          );
        this.executionLease({
          ownerId,
          agentId,
          authority,
          authorityLeaseId: executionLease.authorityLeaseId,
          authorityFencingToken: executionLease.authorityFencingToken,
          consumerId: executionLease.consumerId,
        }).assertHeldInTransaction({
          runId,
          expectedLeaseRevision: executionLease.expectedLeaseRevision,
          executionLeaseId: executionLease.executionLeaseId,
          at: updatedAt,
        });
        const refs = [
          next.contextRef,
          ...Object.values(next.workerResults),
          next.output?.kind === "assistant-answer" ? next.output.contentRef : null,
        ];
        for (const ref of refs)
          if (
            ref !== null &&
            !this.database
              .prepare(`SELECT 1 FROM payloads WHERE ref = ?
        AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`)
              .get(ref, ownerId, agentId)
          )
            return this.fail(
              "PORT_INVALID_OPERATION",
              "Checkpoint Payload is outside the active scope",
              { runId, payloadRef: ref },
            );
        if (
          next.lastTraceEventId !== null &&
          !this.database
            .prepare(`SELECT 1 FROM trace_events
        WHERE id = ? AND owner_id = ? AND agent_id = ? AND run_id = ?`)
            .get(next.lastTraceEventId, ownerId, agentId, runId)
        )
          return this.fail(
            "PORT_INVALID_OPERATION",
            "Checkpoint Trace event is outside the Run scope",
            {
              runId,
              traceEventId: next.lastTraceEventId,
            },
          );
        const revision = (current?.revision ?? 0) + 1;
        this.database
          .prepare(`INSERT INTO run_coordination_checkpoints (run_id, owner_id, agent_id, revision,
        phase, context_ref, runtime_event_count, last_trace_event_id, terminal_status, output_kind, final_answer_ref, diagnostic_code, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
        revision = excluded.revision, phase = excluded.phase, context_ref = excluded.context_ref,
        runtime_event_count = excluded.runtime_event_count, last_trace_event_id = excluded.last_trace_event_id,
        terminal_status = excluded.terminal_status, output_kind = excluded.output_kind,
        final_answer_ref = excluded.final_answer_ref, diagnostic_code = excluded.diagnostic_code, updated_at = excluded.updated_at`)
          .run(
            runId,
            ownerId,
            agentId,
            revision,
            next.phase,
            next.contextRef,
            next.runtimeEventCount,
            next.lastTraceEventId,
            next.terminalStatus,
            next.output?.kind ?? null,
            next.output?.kind === "assistant-answer" ? next.output.contentRef : null,
            next.diagnosticCode,
            updatedAt,
          );
        this.database
          .prepare("DELETE FROM run_coordination_worker_results WHERE run_id = ?")
          .run(runId);
        for (const [workerId, ref] of Object.entries(next.workerResults))
          this.database
            .prepare(
              "INSERT INTO run_coordination_worker_results (run_id, owner_id, agent_id, worker_run_id, result_ref) VALUES (?, ?, ?, ?, ?)",
            )
            .run(runId, ownerId, agentId, workerId, ref);
        return { runId, revision, checkpoint: next };
      })
      .immediate();
  }

  private read(
    ownerId: string,
    agentId: string,
    runId: StoredRunCheckpoint["runId"],
  ): StoredRunCheckpoint | undefined {
    const raw = this.database
      .prepare(`SELECT revision, phase, context_ref, runtime_event_count,
      last_trace_event_id, terminal_status, output_kind, final_answer_ref, diagnostic_code
      FROM run_coordination_checkpoints WHERE run_id = ? AND owner_id = ? AND agent_id = ?`)
      .get(runId, ownerId, agentId);
    if (!raw) return undefined;
    const row = record(raw);
    const workerResults = Object.create(null) as Record<string, string>;
    for (const value of this.database
      .prepare(
        "SELECT worker_run_id, result_ref FROM run_coordination_worker_results WHERE run_id = ? ORDER BY worker_run_id",
      )
      .all(runId)) {
      const worker = record(value);
      workerResults[text(worker["worker_run_id"])] = text(worker["result_ref"]);
    }
    return {
      runId,
      revision: integer(row["revision"]),
      checkpoint: checkpoint({
        phase: row["phase"],
        contextRef: row["context_ref"],
        runtimeEventCount: row["runtime_event_count"],
        lastTraceEventId: row["last_trace_event_id"],
        terminalStatus: row["terminal_status"],
        diagnosticCode: row["diagnostic_code"],
        workerResults,
        output:
          row["output_kind"] === null
            ? null
            : row["output_kind"] === "no-answer"
              ? { kind: "no-answer" }
              : { kind: "assistant-answer", contentRef: row["final_answer_ref"] },
      }),
    };
  }
}
