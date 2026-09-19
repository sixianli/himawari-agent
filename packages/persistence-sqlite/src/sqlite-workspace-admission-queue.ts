import type Database from "better-sqlite3";
import type {
  SandboxExecutionPreparationPort,
  SandboxWorkspaceClaim,
} from "@himawari-agent/application";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Request = Parameters<SandboxExecutionPreparationPort["reserve"]>[0];
type Position = Awaited<ReturnType<SandboxExecutionPreparationPort["enqueue"]>>;

/** Called only inside the journal's immediate transaction. Priority holds no resource. */
export class SqliteWorkspaceAdmissionQueue {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly conflicts: (
    left: SandboxWorkspaceClaim,
    right: SandboxWorkspaceClaim,
  ) => boolean;
  constructor(
    db: Database.Database,
    fail: SqliteApplicationFailure,
    conflicts: (left: SandboxWorkspaceClaim, right: SandboxWorkspaceClaim) => boolean,
  ) {
    this.db = db;
    this.fail = fail;
    this.conflicts = conflicts;
  }

  enqueue(
    input: Request,
    claims: readonly SandboxWorkspaceClaim[],
    validate: () => void,
  ): Position {
    const { consumedAt: _now, ...invocation } = input.invocation;
    const request = JSON.stringify({
      plan: input.plan,
      reservation: input.reservation,
      invocation,
      claims,
    });
    const previous = this.db
      .prepare(
        "SELECT sequence, status, request_json AS request FROM sandbox_admission_queue WHERE job_id=?",
      )
      .get(input.plan.identity.jobId) as (Position & { request: string }) | undefined;
    if (previous) {
      if (previous.request !== request)
        this.fail("PORT_CONFLICT", "Queued request identity changed");
      if (previous.status === "queued") validate();
      return { sequence: previous.sequence, status: previous.status };
    }
    validate();
    const inserted = this.db
      .prepare(`INSERT INTO sandbox_admission_queue
      (job_id,owner_id,agent_id,run_id,host_id,handle_ref,deadline_at,status,request_json,claims_json)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`)
      .run(
        input.plan.identity.jobId,
        input.plan.identity.ownerId,
        input.plan.identity.agentId,
        input.plan.identity.runId,
        input.plan.identity.hostId,
        input.plan.handleRef,
        input.plan.effectiveDeadlineAt,
        request,
        JSON.stringify(claims),
      );
    return { sequence: Number(inserted.lastInsertRowid), status: "queued" };
  }

  cancel(jobId: string, owner: string, agent: string): void {
    this.db
      .prepare(
        "UPDATE sandbox_admission_queue SET status='cancelled' WHERE job_id=? AND owner_id=? AND agent_id=? AND status='queued'",
      )
      .run(jobId, owner, agent);
  }

  assertFair(claims: readonly SandboxWorkspaceClaim[], jobId: string, now: string): void {
    this.db
      .prepare(`UPDATE sandbox_admission_queue SET status='cancelled' WHERE status='queued' AND
      (deadline_at<=? OR EXISTS (SELECT 1 FROM runs r WHERE r.id=run_id AND r.status IN ('completed','failed','cancelled')) OR
       EXISTS (SELECT 1 FROM capability_handles h WHERE h.id=handle_ref AND (h.revoked_at IS NOT NULL OR h.expires_at<=?)))`)
      .run(now, now);
    const own = this.db
      .prepare("SELECT sequence, status FROM sandbox_admission_queue WHERE job_id=?")
      .get(jobId) as Position | undefined;
    if (own?.status === "cancelled")
      this.fail("PORT_NOT_AUTHORITATIVE", "Queued request was cancelled or expired");
    for (const claim of claims) {
      const older = this.db
        .prepare(
          "SELECT claims_json AS claims FROM sandbox_admission_queue WHERE host_id=? AND status='queued' AND sequence<? AND job_id!=? ORDER BY sequence",
        )
        .all(claim.hostId, own?.sequence ?? Number.MAX_SAFE_INTEGER, jobId) as { claims: string }[];
      for (const row of older) {
        const candidates = JSON.parse(row.claims) as SandboxWorkspaceClaim[];
        if (candidates.some((other) => this.conflicts(claim, other)))
          this.fail("PORT_CONFLICT", "Workspace has an earlier conflicting request", {
            reasonCode: "WORKSPACE_QUEUED",
          });
      }
    }
  }

  admitted(jobId: string): void {
    this.db
      .prepare(
        "UPDATE sandbox_admission_queue SET status='admitted' WHERE job_id=? AND status='queued'",
      )
      .run(jobId);
  }
}
