import type {
  SandboxExecutionPreparationPort,
  SandboxWorkspaceClaim,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Request = Parameters<SandboxExecutionPreparationPort["reserve"]>[0];
type QueueRow = {
  sequence: number;
  status: "queued" | "admitted" | "cancelled";
  request: string;
  bindingRevision: number;
};
type Position = Awaited<ReturnType<SandboxExecutionPreparationPort["enqueue"]>>;

function snapshot(input: Request, claims: readonly SandboxWorkspaceClaim[]) {
  const { consumedAt: _now, ...invocation } = input.invocation;
  return {
    ...(input.recovery ? { recovery: input.recovery } : {}),
    plan: input.plan,
    reservation: input.reservation,
    invocation,
    claims,
  };
}

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

  private columns(): string {
    const hasBindings = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sandbox_queue_authority_bindings'",
      )
      .get();
    return hasBindings
      ? `sequence, status, COALESCE((SELECT b.request_json FROM sandbox_queue_authority_bindings b WHERE b.job_id=sandbox_admission_queue.job_id ORDER BY b.revision DESC LIMIT 1), request_json) AS request,
         COALESCE((SELECT MAX(b.revision) FROM sandbox_queue_authority_bindings b WHERE b.job_id=sandbox_admission_queue.job_id),0) AS bindingRevision`
      : "sequence, status, request_json AS request, 0 AS bindingRevision";
  }

  rebind(
    input: Request,
    claims: readonly SandboxWorkspaceClaim[],
    expectedRevision: number,
    validate: (previous: ReturnType<typeof snapshot>) => void,
  ) {
    const identity = input.plan.identity;
    const row = this.db
      .prepare(
        `SELECT ${this.columns()} FROM sandbox_admission_queue WHERE job_id=? AND owner_id=? AND agent_id=?`,
      )
      .get(identity.jobId, identity.ownerId, identity.agentId) as QueueRow | undefined;
    if (!row || row.status !== "queued")
      return this.fail("PORT_CONFLICT", "Only an unadmitted queue can change authority binding");
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      row.bindingRevision !== expectedRevision
    )
      return this.fail("PORT_CONFLICT", "Queue authority binding changed");
    const previous = JSON.parse(row.request) as ReturnType<typeof snapshot>;
    const next = snapshot(input, claims);
    const logical = (value: ReturnType<typeof snapshot>) => {
      const { executionLease: _lease, ...plan } = value.plan;
      const { authority: _authority, requestScope, ...invocation } = value.invocation;
      const {
        deploymentId: _deployment,
        authorityEpoch: _epoch,
        fencingToken: _fence,
        ...scope
      } = requestScope;
      return { ...value, plan, invocation: { ...invocation, requestScope: scope } };
    };
    if (
      canonicalAuthorizationSnapshot(logical(previous)) !==
      canonicalAuthorizationSnapshot(logical(next))
    )
      return this.fail(
        "PORT_CONFLICT",
        "Queue logical request cannot change during authority binding",
      );
    validate(previous);
    if (canonicalAuthorizationSnapshot(previous) !== canonicalAuthorizationSnapshot(next))
      this.db
        .prepare(
          "INSERT INTO sandbox_queue_authority_bindings (job_id,revision,request_json,created_at) VALUES(?,?,?,?)",
        )
        .run(
          identity.jobId,
          row.bindingRevision + 1,
          JSON.stringify(next),
          input.invocation.consumedAt,
        );
    const rebound = this.read(
      identity.ownerId,
      identity.agentId,
      identity.runId,
      identity.invocationId,
    );
    if (!rebound) return this.fail("PORT_CONFLICT", "Queue disappeared during authority binding");
    return rebound;
  }

  enqueue(
    input: Request,
    claims: readonly SandboxWorkspaceClaim[],
    validate: () => void,
  ): Position {
    const request = JSON.stringify(snapshot(input, claims));
    const identity = input.plan.identity;
    const sameInvocation = this.read(
      identity.ownerId,
      identity.agentId,
      identity.runId,
      identity.invocationId,
    );
    if (sameInvocation && sameInvocation.plan.identity.jobId !== identity.jobId)
      this.fail("PORT_CONFLICT", "Invocation already has a queue identity");
    const previous = this.db
      .prepare(`SELECT ${this.columns()} FROM sandbox_admission_queue WHERE job_id=?`)
      .get(input.plan.identity.jobId) as (Position & { request: string }) | undefined;
    if (previous) {
      if (
        canonicalAuthorizationSnapshot(JSON.parse(previous.request)) !==
        canonicalAuthorizationSnapshot(JSON.parse(request))
      )
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

  /** This snapshot conveys no execution authority. The current authority and
   * target must still pass admission before any receipt can be committed. */
  read(owner: string, agent: string, runId: string, invocationId: string) {
    const rows = this.db
      .prepare(`SELECT ${this.columns()}
      FROM sandbox_admission_queue WHERE owner_id=? AND agent_id=? AND run_id=?
      AND json_extract(request_json,'$.plan.identity.invocationId')=? LIMIT 2`)
      .all(owner, agent, runId, invocationId) as QueueRow[];
    if (rows.length > 1) this.fail("PORT_CONFLICT", "Invocation has ambiguous queue history");
    const row = rows[0];
    if (!row) return undefined;
    const saved = JSON.parse(row.request) as ReturnType<typeof snapshot>;
    return {
      sequence: row.sequence,
      bindingRevision: row.bindingRevision,
      status: row.status,
      ...(saved.recovery ? { recovery: saved.recovery } : {}),
      plan: saved.plan,
      reservation: saved.reservation,
      invocation: saved.invocation,
      workspaces: saved.claims,
    };
  }

  /** Called inside the journal's read transaction; overflow rejects rather than truncates. */
  readRun(owner: string, agent: string, runId: string, limit: number) {
    const rows = this.db
      .prepare(`SELECT ${this.columns()}
      FROM sandbox_admission_queue WHERE owner_id=? AND agent_id=? AND run_id=?
      ORDER BY sequence LIMIT ?`)
      .all(owner, agent, runId, limit + 1) as QueueRow[];
    if (rows.length > limit) this.fail("PORT_INVALID_OPERATION", "SANDBOX_RUN_INVENTORY_LIMIT");
    const seen = new Set<string>();
    return rows.map((row) => {
      const saved = JSON.parse(row.request) as ReturnType<typeof snapshot>;
      const identity = saved.plan.identity;
      if (
        identity.ownerId !== owner ||
        identity.agentId !== agent ||
        identity.runId !== runId ||
        seen.has(identity.invocationId)
      )
        this.fail("PORT_NOT_AUTHORITATIVE", "SANDBOX_RUN_INVENTORY_SCOPE_MISMATCH");
      seen.add(identity.invocationId);
      return {
        sequence: row.sequence,
        bindingRevision: row.bindingRevision,
        status: row.status,
        ...(saved.recovery ? { recovery: saved.recovery } : {}),
        plan: saved.plan,
        reservation: saved.reservation,
        invocation: saved.invocation,
        workspaces: saved.claims,
      };
    });
  }

  assertUnchanged(input: Request, claims: readonly SandboxWorkspaceClaim[]): void {
    const row = this.db
      .prepare(`SELECT ${this.columns()} FROM sandbox_admission_queue WHERE job_id=?`)
      .get(input.plan.identity.jobId) as { request: string } | undefined;
    const identity = input.plan.identity;
    const saved = this.read(
      identity.ownerId,
      identity.agentId,
      identity.runId,
      identity.invocationId,
    );
    if (saved && saved.plan.identity.jobId !== identity.jobId)
      this.fail("PORT_CONFLICT", "Invocation already has a queue identity");
    if (
      row &&
      canonicalAuthorizationSnapshot(JSON.parse(row.request)) !==
        canonicalAuthorizationSnapshot(snapshot(input, claims))
    )
      this.fail("PORT_CONFLICT", "Queued request changed before admission");
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
