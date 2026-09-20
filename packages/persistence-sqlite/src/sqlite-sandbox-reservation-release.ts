import type {
  CapabilityInvocationAuthority,
  SandboxExecutionAdmissionRecord,
  SandboxRecoveryState,
  SandboxReservationReleaseReceipt,
  SandboxReservationReleaseVerification,
} from "@himawari-agent/application";
import type { SandboxExecutionPlanV2 } from "@himawari-agent/execution-contracts";
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
      proof.basis !== "host_never_started" ||
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
      !reference(proof.processIdentityRef) ||
      !/^job-host-process:/.test(proof.processIdentityRef) ||
      typeof proof.controlSessionId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(proof.controlSessionId) ||
      !reference(proof.evidence?.ref) ||
      typeof proof.evidence?.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof.evidence.digest)
    )
      this.fail("PORT_INVALID_OPERATION", "Invalid reservation release verification");
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
