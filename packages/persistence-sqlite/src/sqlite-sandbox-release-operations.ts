import type {
  CapabilityInvocationAuthority,
  SandboxExecutionRecord,
  SandboxExecutionVerification,
  SandboxReleaseReceipt,
} from "@himawari-agent/application";
import { sandboxExecutionFactsSchema } from "@himawari-agent/execution-contracts";
import type Database from "better-sqlite3";

/** Used only within the execution journal's immediate transaction. No dispatch authority. */
export class SqliteSandboxReleaseOperations {
  private readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  read(jobId: string): SandboxReleaseReceipt | undefined {
    const row = this.db
      .prepare(
        "SELECT accepted_at AS acceptedAt, verification_json AS verification FROM sandbox_release_receipts WHERE job_id=?",
      )
      .get(jobId) as { acceptedAt: string; verification: string } | undefined;
    if (!row) return undefined;
    const verification = JSON.parse(row.verification) as SandboxExecutionVerification;
    return {
      acceptedAt: row.acceptedAt,
      verification: {
        ...verification,
        facts: sandboxExecutionFactsSchema.parse(verification.facts),
      },
    };
  }

  /** Caller has authenticated the new observation, including its acceptance-time validity. */
  accept(
    record: SandboxExecutionRecord,
    verification: SandboxExecutionVerification,
    authority: CapabilityInvocationAuthority,
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO sandbox_release_receipts(job_id,sequence,accepted_at,verification_json,authority_json) VALUES(?,?,?,?,?)",
      )
      .run(
        record.plan.identity.jobId,
        record.facts.resource.sequence,
        now,
        JSON.stringify(verification),
        JSON.stringify(authority),
      );
    // Migration does not reinterpret historical dispatches. Protect any old
    // outstanding control before releasing its original physical occupancy.
    this.db
      .prepare(
        "INSERT OR IGNORE INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at) SELECT job_id,'intent:' || intent_id,'control_unacknowledged','SANDBOX_CONTROL_ACK_PENDING',dispatched_at FROM sandbox_execution_intents WHERE job_id=? AND kind='continue' AND dispatched_at IS NOT NULL AND acknowledged_at IS NULL",
      )
      .run(record.plan.identity.jobId);
    this.db
      .prepare(
        "UPDATE sandbox_workspace_occupancy SET released_at=(SELECT accepted_at FROM sandbox_release_receipts WHERE job_id=?) WHERE job_id=? AND released_at IS NULL",
      )
      .run(record.plan.identity.jobId, record.plan.identity.jobId);
  }

  protect(
    jobId: string,
    barrierId: string,
    kind: "control_unacknowledged",
    reason: string,
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at) VALUES(?,?,?,?,?)",
      )
      .run(jobId, barrierId, kind, reason, now);
  }

  acknowledge(jobId: string, intentId: string, now: string): void {
    this.db
      .prepare(
        "UPDATE sandbox_workspace_barriers SET resolved_at=? WHERE job_id=? AND barrier_id=? AND kind='control_unacknowledged' AND resolved_at IS NULL",
      )
      .run(now, jobId, `intent:${intentId}`);
  }
}
