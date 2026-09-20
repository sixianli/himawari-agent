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
    // A fresh stop observation may resolve a later incident. The original
    // receipt remains immutable; older release evidence cannot clear new risk.
    const resource = verification.facts.resource;
    if (resource.supervision !== "released") return;
    const incidents = this.db
      .prepare(
        "SELECT barrier_id,created_at,verification_json FROM sandbox_workspace_barriers WHERE job_id=? AND kind='resource_contradiction' AND resolved_at IS NULL",
      )
      .all(record.plan.identity.jobId) as {
      barrier_id: string;
      created_at: string;
      verification_json: string;
    }[];
    for (const incident of incidents) {
      const prior = JSON.parse(incident.verification_json) as SandboxExecutionVerification;
      const old = prior.facts.resource;
      if (
        old.supervision !== "controlled" ||
        resource.occurredAt <= old.occurredAt ||
        verification.checkedAt < incident.created_at ||
        JSON.stringify(resource.evidence.subject) !== JSON.stringify(old.evidence.subject)
      )
        continue;
      this.db
        .prepare(
          "UPDATE sandbox_workspace_barriers SET resolved_at=?,resolution_json=? WHERE job_id=? AND barrier_id=? AND resolved_at IS NULL",
        )
        .run(
          now,
          JSON.stringify({ verification, authority }),
          record.plan.identity.jobId,
          incident.barrier_id,
        );
    }
  }

  contradiction(
    record: SandboxExecutionRecord,
    verification: SandboxExecutionVerification,
    authority: CapabilityInvocationAuthority,
    now: string,
  ): boolean {
    const resource = verification.facts.resource;
    if (resource.supervision !== "controlled")
      throw new Error("Contradiction must identify a controlled resource");
    const barrierId = `resource:${resource.sequence}:${resource.evidence.digest}`;
    const old = this.db
      .prepare(
        "SELECT verification_json FROM sandbox_workspace_barriers WHERE job_id=? AND barrier_id=?",
      )
      .get(record.plan.identity.jobId, barrierId) as { verification_json: string } | undefined;
    if (old) {
      const previous = JSON.parse(old.verification_json) as SandboxExecutionVerification;
      if (JSON.stringify(previous.facts) !== JSON.stringify(verification.facts))
        throw new Error("Resource incident replay changed");
      return false;
    }
    this.db
      .prepare(
        "INSERT INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at,verification_json,authority_json) VALUES(?,?,'resource_contradiction','SANDBOX_RELEASE_CONTRADICTED',?,?,?)",
      )
      .run(
        record.plan.identity.jobId,
        barrierId,
        now,
        JSON.stringify(verification),
        JSON.stringify(authority),
      );
    return true;
  }

  hasContradiction(jobId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=? AND kind='resource_contradiction' AND resolved_at IS NULL LIMIT 1",
        )
        .get(jobId),
    );
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
