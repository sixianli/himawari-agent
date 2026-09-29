import { createHash } from "node:crypto";
import type {
  CapabilityInvocationAuthority,
  SandboxExecutionAdmissionRecord,
  SandboxRecoveryState,
  SandboxReservationReleaseReceipt,
  SandboxReservationReleaseVerification,
} from "@himawari-agent/application";
import type { SandboxExecutionPlanV2 } from "@himawari-agent/execution-contracts";
import { SANDBOX_PREPARATION_PROTOCOL } from "@himawari-agent/execution-contracts";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Reservation = Extract<SandboxExecutionAdmissionRecord, { phase: "reserved" }>;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const reference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/** Called only inside the execution journal writer transaction. No launch authority. */
export class SqliteSandboxReservationRelease {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  constructor(db: Database.Database, fail: SqliteApplicationFailure) {
    this.db = db;
    this.fail = fail;
  }

  private validate(
    plan: SandboxExecutionPlanV2,
    stoppedAt: string | undefined,
    proof: SandboxReservationReleaseVerification,
    acceptedAt: string,
  ): void {
    if (
      !stoppedAt ||
      !proof ||
      proof.schemaVersion !== "sandbox-reservation-release.v1" ||
      !proof.identity ||
      Object.keys(proof.identity).length !== Object.keys(plan.identity).length ||
      Object.entries(plan.identity).some(
        ([key, value]) => proof.identity[key as keyof typeof plan.identity] !== value,
      ) ||
      proof.environmentId !== plan.environmentId ||
      proof.semanticFingerprint !== plan.semanticFingerprint ||
      proof.stopRequestedAt !== stoppedAt ||
      !instant(proof.checkedAt) ||
      !instant(proof.validUntil) ||
      !instant(acceptedAt) ||
      proof.checkedAt < stoppedAt ||
      proof.checkedAt > acceptedAt ||
      proof.validUntil <= acceptedAt ||
      Date.parse(proof.validUntil) - Date.parse(proof.checkedAt) > 30_000 ||
      !this.basisHolds(plan, proof) ||
      !reference(proof.evidence?.ref) ||
      typeof proof.evidence?.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof.evidence.digest)
    )
      this.fail("PORT_INVALID_OPERATION", "Invalid reservation release verification");
  }

  private basisHolds(
    plan: SandboxExecutionPlanV2,
    proof: SandboxReservationReleaseVerification,
  ): boolean {
    if (proof.basis === "preparation_not_authorized") {
      if (plan.preparationProtocol !== SANDBOX_PREPARATION_PROTOCOL)
        return this.fail("PORT_INVALID_OPERATION", "SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE");
      return (
        plan.backendRef === "srt" &&
        Boolean(
          this.db
            .prepare(`
        SELECT 1 FROM sandbox_execution_records r
        JOIN run_payload_artifacts a ON a.owner_id=r.owner_id AND a.agent_id=r.agent_id AND a.run_id=r.run_id
        WHERE r.job_id=? AND r.owner_id=? AND r.agent_id=? AND r.preparation_state='reserved'
          AND r.started_at IS NULL AND r.reservation_stopped_at IS NOT NULL
          AND json_extract(r.plan_json,'$.backendRef')='srt'
          AND json_extract(r.plan_json,'$.preparationProtocol')=?
          AND a.purpose='trace' AND a.operation_key=? AND a.payload_ref=? AND a.content_digest=?
      `)
            .get(
              plan.identity.jobId,
              plan.identity.ownerId,
              plan.identity.agentId,
              SANDBOX_PREPARATION_PROTOCOL,
              `sandbox-control:${createHash("sha256").update(JSON.stringify(plan.identity)).digest("hex")}:preparation`,
              proof.evidence?.ref ?? null,
              `sha256:${proof.evidence?.digest}`,
            ),
        )
      );
    }
    if (proof.basis === "host_never_started")
      return (
        reference(proof.processIdentityRef) &&
        /^job-host-process:/.test(proof.processIdentityRef) &&
        typeof proof.controlSessionId === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(proof.controlSessionId)
      );
    if (proof.basis !== "task_environment_released" || !Array.isArray(proof.taskEnvironmentIds))
      return false;
    const rows = this.db
      .prepare(
        `SELECT e.environment_id AS environmentId,r.environment_id AS released
         FROM execution_environments e
         JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id
         LEFT JOIN execution_environment_release_receipts r ON r.environment_id=e.environment_id
         WHERE e.role='primary' AND e.backend_ref=? AND j.owner_id=? AND j.agent_id=? AND j.run_id=? AND j.host_id=?
         ORDER BY e.environment_id`,
      )
      .all(
        plan.backendRef,
        plan.identity.ownerId,
        plan.identity.agentId,
        plan.identity.runId,
        plan.identity.hostId,
      ) as { environmentId: string; released: string | null }[];
    const claimed = [...proof.taskEnvironmentIds].sort();
    return (
      rows.length > 0 &&
      rows.every((row) => row.released !== null) &&
      claimed.length === rows.length &&
      rows.every((row, index) => row.environmentId === claimed[index])
    );
  }

  read(
    plan: SandboxExecutionPlanV2,
    stoppedAt: string | undefined,
  ): SandboxReservationReleaseReceipt | undefined {
    const row = this.db
      .prepare(
        "SELECT accepted_at AS acceptedAt,verification_json AS verification FROM sandbox_reservation_release_receipts WHERE job_id=?",
      )
      .get(plan.identity.jobId) as { acceptedAt: string; verification: string } | undefined;
    if (!row) return undefined;
    const verification = JSON.parse(row.verification) as SandboxReservationReleaseVerification;
    // Recheck the original acceptance, never today's clock, when reading history.
    this.validate(plan, stoppedAt, verification, row.acceptedAt);
    return { acceptedAt: row.acceptedAt, verification };
  }

  accept(
    admission: Reservation,
    verification: SandboxReservationReleaseVerification,
    authority: CapabilityInvocationAuthority,
    now: string,
    expectedRecoveryRevision?: number,
  ): boolean {
    if (admission.releaseReceipt) return false;
    const attempt = admission.recovery;
    if (
      expectedRecoveryRevision !== undefined &&
      (attempt?.status !== "running" ||
        attempt.revision !== expectedRecoveryRevision ||
        attempt.owner !== authority.agentServiceBootId ||
        attempt.deadlineAt <= now)
    )
      return this.fail("PORT_CONFLICT", "Reservation recovery ownership changed");
    this.validate(admission.plan, admission.stopRequestedAt, verification, now);
    const jobId = admission.plan.identity.jobId;
    this.db
      .prepare(
        "INSERT INTO sandbox_reservation_release_receipts(job_id,accepted_at,verification_json,authority_json) VALUES(?,?,?,?)",
      )
      .run(jobId, now, JSON.stringify(verification), JSON.stringify(authority));
    this.db
      .prepare(
        "UPDATE sandbox_workspace_occupancy SET released_at=? WHERE job_id=? AND released_at IS NULL",
      )
      .run(now, jobId);
    const recovery: SandboxRecoveryState = {
      revision: (admission.recovery?.revision ?? 0) + 1,
      attempts:
        (admission.recovery?.attempts ?? 0) + (expectedRecoveryRevision === undefined ? 1 : 0),
      owner: authority.agentServiceBootId,
      status: "resolved",
      action: expectedRecoveryRevision === undefined ? "inspect" : "stop",
      startedAt:
        expectedRecoveryRevision === undefined
          ? verification.checkedAt
          : (attempt?.startedAt ?? verification.checkedAt),
      deadlineAt:
        expectedRecoveryRevision === undefined
          ? verification.validUntil
          : (attempt?.deadlineAt ?? verification.validUntil),
      finishedAt: now,
      reasonCode: "SANDBOX_RESERVATION_RELEASE_CONFIRMED",
      nextAttemptAt: null,
    };
    this.db
      .prepare("UPDATE sandbox_execution_records SET recovery_json=? WHERE job_id=?")
      .run(JSON.stringify(recovery), jobId);
    return true;
  }
}
