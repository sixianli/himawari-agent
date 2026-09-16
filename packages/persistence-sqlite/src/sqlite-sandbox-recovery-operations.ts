import type {
  SandboxExecutionJournalPort,
  SandboxExecutionRecord,
  SandboxRecoveryState,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Request = Parameters<SandboxExecutionJournalPort["beginRecovery"]>[0] &
  Parameters<SandboxExecutionJournalPort["finishRecovery"]>[0];

/** Invoked inside the existing authority-checked execution journal transaction. */
export class SqliteSandboxRecoveryOperations {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  constructor(db: Database.Database, fail: SqliteApplicationFailure) {
    this.db = db;
    this.fail = fail;
  }
  read(jobId: string): { readonly recovery?: SandboxRecoveryState } {
    const row = this.db
      .prepare("SELECT recovery_json FROM sandbox_execution_records WHERE job_id=?")
      .get(jobId) as { recovery_json: string | null } | undefined;
    return row?.recovery_json
      ? { recovery: JSON.parse(row.recovery_json) as SandboxRecoveryState }
      : {};
  }
  mutate(
    operation: string,
    input: Request,
    record: SandboxExecutionRecord,
  ): SandboxRecoveryState | undefined {
    const current = record.recovery;
    const owner = input.authority.agentServiceBootId;
    if (input.expectedSequence !== record.facts.resource.sequence)
      return this.fail("PORT_CONFLICT", "Recovery resource sequence changed");
    if (operation === "interruptRecovery" && current?.status === "unresolved") return;
    if (operation === "beginRecovery") {
      const duration = Date.parse(input.deadlineAt) - Date.parse(input.now);
      if (
        !["inspect", "stop"].includes(input.action) ||
        !Number.isFinite(duration) ||
        duration < 1 ||
        duration > 30000
      )
        return this.fail("PORT_INVALID_OPERATION", "Invalid bounded recovery request");
      if (current?.status === "running" && current.deadlineAt > input.now)
        return this.fail("PORT_CONFLICT", "Recovery already running");
    } else if (operation === "finishRecovery") {
      if (
        !current ||
        current.status !== "running" ||
        current.owner !== owner ||
        current.revision !== input.expectedRecoveryRevision
      )
        return this.fail("PORT_CONFLICT", "Recovery ownership changed");
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(input.reasonCode))
        return this.fail("PORT_INVALID_OPERATION", "Invalid recovery reason");
    }
    const blocked = this.db
      .prepare(
        "SELECT 1 FROM sandbox_workspace_occupancy WHERE job_id=? AND released_at IS NULL UNION ALL SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=? AND resolved_at IS NULL LIMIT 1",
      )
      .get(record.plan.identity.jobId, record.plan.identity.jobId);
    const state: SandboxRecoveryState =
      operation === "beginRecovery"
        ? {
            revision: (current?.revision ?? 0) + 1,
            owner,
            attempts: (current?.attempts ?? 0) + 1,
            status: "running",
            action: input.action,
            startedAt: input.now,
            deadlineAt: input.deadlineAt,
            finishedAt: null,
            reasonCode: "SANDBOX_RECONCILIATION_REQUESTED",
          }
        : {
            revision: (current?.revision ?? 0) + 1,
            owner,
            attempts: current?.attempts ?? 0,
            status:
              operation === "finishRecovery" && record.releaseReceipt && !blocked
                ? "resolved"
                : "unresolved",
            action: current?.action ?? "inspect",
            startedAt: current?.startedAt ?? input.now,
            deadlineAt: current?.deadlineAt ?? input.now,
            finishedAt: input.now,
            reasonCode:
              operation === "finishRecovery" ? input.reasonCode : "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
          };
    this.db
      .prepare("UPDATE sandbox_execution_records SET recovery_json=? WHERE job_id=?")
      .run(JSON.stringify(state), record.plan.identity.jobId);
    return state;
  }
}
