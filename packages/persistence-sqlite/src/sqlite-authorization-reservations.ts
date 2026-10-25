import type Database from "better-sqlite3";
import type {
  ApprovalRequest,
  AuthorizationReservation,
  CapabilityExecutionHandle,
  ConsumeGrantInput,
  GovernedCapabilityExecutionHandle,
  GovernedGrantRecord,
  ReserveAuthorizationInput,
} from "@himawari-agent/application";
import {
  actionIntentFingerprint,
  approvalMatchesIntent,
  canonicalAuthorizationSnapshot,
  governedGrantAuthorityCovers,
} from "@himawari-agent/application/action-intent-snapshot";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

export class SqliteAuthorizationReservations {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly grant: (id: string) => GovernedGrantRecord | undefined;
  private readonly approval: (id: string) => ApprovalRequest | undefined;
  private readonly policy: (approval: ApprovalRequest) => void;
  private readonly consume: (input: ConsumeGrantInput, reservationId: string) => void;
  constructor(
    db: Database.Database,
    fail: SqliteApplicationFailure,
    grant: (id: string) => GovernedGrantRecord | undefined,
    approval: (id: string) => ApprovalRequest | undefined,
    policy: (approval: ApprovalRequest) => void,
    consume: (input: ConsumeGrantInput, reservationId: string) => void,
  ) {
    this.db = db;
    this.fail = fail;
    this.grant = grant;
    this.approval = approval;
    this.policy = policy;
    this.consume = consume;
  }

  get(id: string): AuthorizationReservation | undefined {
    const row = this.db
      .prepare("SELECT record_json AS json FROM authorization_reservations WHERE id = ?")
      .get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  capacity(grantId: string, excluding = ""): { uses: number; cost: number } {
    return this.db
      .prepare(`SELECT COUNT(*) AS uses, COALESCE(SUM(cost_micros), 0) AS cost
      FROM authorization_reservations WHERE grant_id = ? AND status = 'reserved' AND id != ?`)
      .get(grantId, excluding) as { uses: number; cost: number };
  }

  private save(record: AuthorizationReservation): AuthorizationReservation {
    this.db
      .prepare(`INSERT INTO authorization_reservations (id, grant_id, status, cost_micros, expires_at, handle_ref, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      handle_ref=excluded.handle_ref, record_json=excluded.record_json`)
      .run(
        record.id,
        record.grantId,
        record.status,
        record.intent.estimatedCostMicros,
        record.expiresAt,
        record.handleRef,
        JSON.stringify(record),
      );
    return record;
  }

  private live(record: AuthorizationReservation, now: string): GovernedGrantRecord {
    const grant = this.grant(record.grantId);
    if (
      !grant ||
      !governedGrantAuthorityCovers(grant, record.intent, now) ||
      now >= record.expiresAt
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Reserved authorization expired or was revoked");
    const approval = this.approval(grant.sourceApprovalRequestId);
    if (
      !approval ||
      approval.status !== "approved" ||
      approval.grantId !== grant.id ||
      (grant.kind === "one_time" && !approvalMatchesIntent(approval, record.intent))
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Reservation has no matching approved authority");
    this.policy(approval);
    const run = this.db
      .prepare(
        "SELECT status, thread_id AS threadId FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?",
      )
      .get(record.intent.runId, record.intent.ownerId, record.intent.agentId) as
      | { status: string; threadId: string | null }
      | undefined;
    if (
      !run ||
      run.threadId !== record.intent.threadId ||
      ["completed", "failed", "cancelled"].includes(run.status)
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Run cannot acquire execution authority");
    return grant;
  }

  reserve(input: ReserveAuthorizationInput): AuthorizationReservation {
    return this.db
      .transaction(() => {
        const id = `authorization-reservation:${input.intent.id}`;
        const existing = this.get(id);
        if (existing) {
          if (
            existing.grantId !== input.grantId ||
            canonicalAuthorizationSnapshot(existing.intent) !==
              canonicalAuthorizationSnapshot(input.intent)
          )
            this.fail("PORT_CONFLICT", "Reservation identity changed");
          if (existing.status === "released")
            this.fail("PORT_NOT_AUTHORITATIVE", "Released operation requires a new intent");
          this.live(existing, input.now);
          return existing;
        }
        if (
          this.db
            .prepare("SELECT 1 FROM authorization_usage WHERE id=?")
            .get(`authorization-usage:${input.intent.id}`)
        )
          this.fail("PORT_CONFLICT", "Historical committed usage requires receipt reconciliation");
        const grant = this.grant(input.grantId);
        if (!grant) this.fail("PORT_NOT_FOUND", "Reservation grant not found");
        const record: AuthorizationReservation = {
          id,
          grantId: grant.id,
          intent: input.intent,
          semanticSnapshotHash: actionIntentFingerprint(input.intent),
          status: "reserved",
          createdAt: input.now,
          expiresAt:
            grant.expiresAt < input.intent.expiresAt ? grant.expiresAt : input.intent.expiresAt,
          handleRef: null,
          invocationRef: null,
          resolvedAt: null,
          reasonCode: null,
        };
        this.live(record, input.now);
        const expired = this.db
          .prepare(
            "SELECT id FROM authorization_reservations WHERE grant_id = ? AND status = 'reserved' AND expires_at <= ?",
          )
          .all(grant.id, input.now) as { id: string }[];
        for (const row of expired)
          this.release({
            reservationId: row.id,
            now: input.now,
            reasonCode: "reservation_expired",
          });
        const held = this.capacity(grant.id);
        if (
          grant.uses + held.uses >= grant.maxUses ||
          grant.spentCostMicros + held.cost + input.intent.estimatedCostMicros >
            grant.maxTotalCostMicros
        )
          this.fail("PORT_CONFLICT", "Authorization quota is already reserved or committed", {
            reasonCode: "AUTHORIZATION_QUOTA_UNAVAILABLE",
          });
        return this.save(record);
      })
      .immediate();
  }

  release(input: {
    reservationId: string;
    now: string;
    reasonCode: string;
  }): AuthorizationReservation {
    return this.db
      .transaction(() => {
        const record = this.get(input.reservationId);
        if (!record) this.fail("PORT_NOT_FOUND", "Authorization reservation not found");
        if (record.status === "released") return record;
        if (record.status === "committed")
          this.fail("PORT_CONFLICT", "Possibly dispatched quota cannot be refunded");
        if (record.handleRef) {
          const row = this.db
            .prepare("SELECT record_json AS json FROM capability_handles WHERE id = ?")
            .get(record.handleRef) as { json: string } | undefined;
          const handle: GovernedCapabilityExecutionHandle | undefined = row
            ? JSON.parse(row.json)
            : undefined;
          if (
            handle?.uses ||
            this.db
              .prepare("SELECT 1 FROM capability_invocation_receipts WHERE handle_ref = ?")
              .get(record.handleRef)
          )
            this.fail("PORT_CONFLICT", "Execution authority has already been committed");
          if (handle)
            this.db
              .prepare(
                "UPDATE capability_handles SET status='revoked', revoked_at=?, record_json=? WHERE id=?",
              )
              .run(
                input.now,
                JSON.stringify({ ...handle, revision: handle.revision + 1, revokedAt: input.now }),
                handle.ref,
              );
        }
        return this.save({
          ...record,
          status: "released",
          resolvedAt: input.now,
          reasonCode: input.reasonCode,
        });
      })
      .immediate();
  }

  bind(id: string, source: CapabilityExecutionHandle): CapabilityExecutionHandle | undefined {
    const handle = source as GovernedCapabilityExecutionHandle;
    if (handle.handleVersion !== "capability-handle.v2")
      this.fail("PORT_NOT_AUTHORITATIVE", "Reservation requires a governed Handle");
    const record = this.get(id);
    if (!record || record.status !== "reserved")
      this.fail("PORT_NOT_AUTHORITATIVE", "Reservation cannot issue a Handle");
    this.live(record, handle.issuedAt);
    if (
      handle.authorization.type !== "grant" ||
      handle.authorization.ref !== record.grantId ||
      handle.ownerId !== record.intent.ownerId ||
      handle.agentId !== record.intent.agentId ||
      handle.runId !== record.intent.runId ||
      handle.capabilityRef !== record.intent.capabilityRef ||
      handle.capabilityVersion !== record.intent.capabilityVersion ||
      handle.operations.length !== 1 ||
      handle.operations[0] !== record.intent.operation ||
      handle.maxUses !== 1 ||
      handle.expiresAt > record.expiresAt ||
      handle.maxTotalCostMicros > record.intent.estimatedCostMicros
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Handle exceeds its authorization reservation");
    if (record.handleRef) {
      const row = this.db
        .prepare("SELECT record_json AS json FROM capability_handles WHERE id=?")
        .get(record.handleRef) as { json: string };
      const existing: CapabilityExecutionHandle = JSON.parse(row.json);
      const comparable = (value: CapabilityExecutionHandle) => ({
        ...value,
        ref: "",
        issuedAt: "",
      });
      if (
        canonicalAuthorizationSnapshot(comparable(existing)) !==
        canonicalAuthorizationSnapshot(comparable(handle))
      )
        this.fail("PORT_CONFLICT", "Reservation is already bound to different Handle inputs");
      return existing;
    }
    return undefined;
  }

  bound(id: string, handleRef: string): void {
    const record = this.get(id);
    if (!record) this.fail("PORT_NOT_FOUND", "Reservation disappeared");
    this.save({ ...record, handleRef });
  }

  releaseUnusedHandle(handleRef: string, now: string): void {
    const row = this.db
      .prepare("SELECT id FROM authorization_reservations WHERE handle_ref=? AND status='reserved'")
      .get(handleRef) as { id: string } | undefined;
    if (row)
      this.release({ reservationId: row.id, now, reasonCode: "handle_withdrawn_before_dispatch" });
  }

  releaseRun(ownerId: string, agentId: string, runId: string, now: string): void {
    const rows = this.db
      .prepare(`SELECT id FROM authorization_reservations WHERE status='reserved'
      AND json_extract(record_json, '$.intent.ownerId')=? AND json_extract(record_json, '$.intent.agentId')=?
      AND json_extract(record_json, '$.intent.runId')=?`)
      .all(ownerId, agentId, runId) as { id: string }[];
    for (const row of rows)
      this.release({ reservationId: row.id, now, reasonCode: "run_ended_before_dispatch" });
  }

  commit(handleRef: string, invocationRef: string, now: string): void {
    const row = this.db
      .prepare("SELECT id FROM authorization_reservations WHERE handle_ref=?")
      .get(handleRef) as { id: string } | undefined;
    if (!row) return; // Pre-migration Handles retain their already consumed quota.
    const record = this.get(row.id);
    if (!record) this.fail("PORT_NOT_FOUND", "Reservation disappeared during commit");
    if (record.status === "committed" && record.invocationRef === invocationRef) return;
    if (record.status !== "reserved")
      this.fail("PORT_CONFLICT", "Reservation cannot authorize another invocation");
    const grant = this.live(record, now);
    this.consume(
      {
        grantId: record.grantId,
        expectedRevision: grant.revision,
        consumedAt: now,
        costMicros: record.intent.estimatedCostMicros,
        usageId: `authorization-usage:${record.intent.id}`,
        intentId: record.intent.id,
        runId: record.intent.runId,
        operation: record.intent.operation,
      },
      record.id,
    );
    this.save({
      ...record,
      status: "committed",
      invocationRef,
      resolvedAt: now,
      reasonCode: "invocation_admitted",
    });
  }
}
