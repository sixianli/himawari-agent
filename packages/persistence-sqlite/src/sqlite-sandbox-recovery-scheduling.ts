import type {
  SandboxExecutionAdmissionRecord,
  SandboxExecutionPreparationPort,
  SandboxRecoveryState,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { SANDBOX_AUTHORITY_WITHDRAWN_SQL } from "./sqlite-sandbox-authority-withdrawal.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input = Parameters<SandboxExecutionPreparationPort["scheduleRecovery"]>[0];
const initialReasons = new Set([
  "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
  "SANDBOX_RELEASE_CONTRADICTED",
  "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
]);

/** Runs inside the existing authority-checked journal transaction. It grants
 * only a queued inspect/stop and fences unbound starts before scheduling stop. */
export class SqliteSandboxRecoveryScheduling {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  constructor(db: Database.Database, fail: SqliteApplicationFailure) {
    this.db = db;
    this.fail = fail;
  }

  schedule(
    input: Input,
    admission: SandboxExecutionAdmissionRecord,
  ): SandboxRecoveryState | undefined {
    const record = admission.phase === "bound" ? admission.record : admission;
    const sequence = admission.phase === "bound" ? admission.record.facts.resource.sequence : null;
    const current = record.recovery;
    if (
      input.expectedSequence !== sequence ||
      input.expectedRecoveryRevision !== (current?.revision ?? 0)
    )
      return this.fail("PORT_CONFLICT", "Recovery discovery changed");
    if (record.releaseReceipt && record.workspaceBlocked === false) {
      if (current?.status === "scheduled" || current?.status === "running")
        return this.save(record.plan.identity.jobId, {
          ...current,
          revision: current.revision + 1,
          status: "resolved",
          owner: input.authority.agentServiceBootId,
          finishedAt: input.now,
          nextAttemptAt: null,
          reasonCode: "SANDBOX_RECONCILIATION_CONFIRMED",
        });
      return;
    }
    if (current?.status === "running") {
      if (current.deadlineAt > input.now) return;
      return this.save(record.plan.identity.jobId, {
        ...current,
        revision: current.revision + 1,
        status: "unresolved",
        owner: input.authority.agentServiceBootId,
        finishedAt: input.now,
        reasonCode: "SANDBOX_RECONCILIATION_TIMED_OUT",
        nextAttemptAt: null,
      });
    }
    const run = this.db
      .prepare("SELECT status FROM runs WHERE id=? AND owner_id=? AND agent_id=?")
      .get(
        record.plan.identity.runId,
        record.plan.identity.ownerId,
        record.plan.identity.agentId,
      ) as { status: string } | undefined;
    if (!run) return this.fail("PORT_NOT_FOUND", "Recovery Run missing");
    const withdrawn =
      this.db
        .prepare(`SELECT 1 FROM sandbox_execution_records r
      WHERE r.job_id=@jobId AND r.owner_id=@ownerId AND r.agent_id=@agentId
      AND ${SANDBOX_AUTHORITY_WITHDRAWN_SQL}`)
        .get({
          jobId: record.plan.identity.jobId,
          ownerId: record.plan.identity.ownerId,
          agentId: record.plan.identity.agentId,
          recoveryNow: input.now,
        }) !== undefined;
    const stop =
      withdrawn ||
      ["completed", "failed", "cancelled", "reconciling_external_result"].includes(run.status) ||
      record.plan.effectiveDeadlineAt <= input.now ||
      (admission.phase === "reserved" && admission.stopRequestedAt !== undefined);
    const action = stop ? "stop" : "inspect";
    if (
      !stop &&
      (admission.phase === "reserved" ||
        !["lost", "reconciling", "released"].includes(admission.record.facts.resource.supervision))
    )
      return;
    // A completed failed attempt is paused. A later stop obligation is a distinct
    // action, not a retry of inspection; fresh incidents explicitly reset the reason.
    if (
      current?.status === "unresolved" &&
      !initialReasons.has(current.reasonCode) &&
      !(stop && current.action !== "stop")
    )
      return;
    if (
      current?.status === "scheduled" &&
      current.action === action &&
      current.owner === input.authority.agentServiceBootId
    )
      return current;
    const state: SandboxRecoveryState = {
      revision: (current?.revision ?? 0) + 1,
      owner: input.authority.agentServiceBootId,
      attempts: current?.attempts ?? 0,
      status: "scheduled",
      action,
      scheduledAt: input.now,
      nextAttemptAt: input.now,
      startedAt: null,
      deadlineAt: null,
      finishedAt: null,
      reasonCode: stop ? "SANDBOX_RESOURCE_STOP_REQUIRED" : "SANDBOX_RESOURCE_INSPECTION_REQUIRED",
    };
    if (admission.phase === "reserved")
      this.db
        .prepare(
          "UPDATE sandbox_execution_records SET reservation_stopped_at=COALESCE(reservation_stopped_at,?) WHERE job_id=?",
        )
        .run(input.now, record.plan.identity.jobId);
    return this.save(record.plan.identity.jobId, state);
  }

  private save(jobId: string, state: SandboxRecoveryState): SandboxRecoveryState {
    this.db
      .prepare("UPDATE sandbox_execution_records SET recovery_json=? WHERE job_id=?")
      .run(JSON.stringify(state), jobId);
    return state;
  }
}
