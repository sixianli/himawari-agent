import type { SandboxExecutionPlanV2 } from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "../ports/capability-invocations.js";
import type {
  SandboxExecutionAdmissionRecord,
  SandboxExecutionPreparationPort,
  SandboxReservationReleaseVerification,
} from "../ports/sandbox-execution-journal.js";
import {
  type SandboxExecutionReconciliationService,
  sandboxReconciliationFailureReason,
} from "./sandbox-execution-reconciliation.js";

interface Options {
  readonly hostId: string;
  readonly preparations: Pick<
    SandboxExecutionPreparationPort,
    | "listRecoveryCandidates"
    | "scheduleRecovery"
    | "readAdmission"
    | "beginReservationRecovery"
    | "finishReservationRecovery"
    | "releaseReservation"
  >;
  readonly reconciliation: Pick<SandboxExecutionReconciliationService, "reconcile">;
  readonly reservations: {
    stop(plan: SandboxExecutionPlanV2, signal: AbortSignal): Promise<void>;
    verify(
      plan: SandboxExecutionPlanV2,
      stoppedAt: string,
      signal: AbortSignal,
    ): Promise<SandboxReservationReleaseVerification | undefined>;
  };
  readonly authority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
  readonly timeoutMs: number;
}

function expectedRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "PORT_CONFLICT") ||
      [
        "SANDBOX_RECONCILIATION_SEQUENCE_CHANGED",
        "SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED",
      ].includes(error.message))
  );
}

/** Resource-only work over the existing journal. No model, tool dispatch or grant port.
 * The cursor advances across paused/foreign-host records so they cannot starve later work. */
export class SandboxResourceRecoveryService {
  private readonly options: Options;
  private afterJobId: string | null = null;
  constructor(options: Options) {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30000
    )
      throw new Error("SANDBOX_RECONCILIATION_TIMEOUT_INVALID");
    this.options = options;
  }

  async pump(signal: AbortSignal, maximum: number): Promise<void> {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error("SANDBOX_RECOVERY_LIMIT_INVALID");
    if (signal.aborted) return;
    const page = await this.options.preparations.listRecoveryCandidates({
      now: this.options.now(),
      afterJobId: this.afterJobId,
      limit: 100,
    });
    if (!page.length) {
      this.afterJobId = null;
      return;
    }
    const tasks: Array<() => Promise<void>> = [];
    for (const admission of page) {
      if (signal.aborted) return;
      const record = admission.phase === "bound" ? admission.record : admission;
      const identity = record.plan.identity;
      if (this.afterJobId !== null && identity.jobId <= this.afterJobId)
        throw new Error("SANDBOX_RECOVERY_CURSOR_INVALID");
      this.afterJobId = identity.jobId;
      if (identity.hostId !== this.options.hostId) continue;
      try {
        const scheduled = await this.options.preparations.scheduleRecovery({
          identity,
          now: this.options.now(),
          authority: this.options.authority(),
          expectedSequence:
            admission.phase === "bound" ? admission.record.facts.resource.sequence : null,
          expectedRecoveryRevision: record.recovery?.revision ?? 0,
        });
        if (scheduled?.status !== "scheduled" || scheduled.nextAttemptAt > this.options.now())
          continue;
        tasks.push(async () => {
          if (signal.aborted) return;
          try {
            if (admission.phase === "bound")
              await this.options.reconciliation.reconcile({
                identity,
                authority: this.options.authority(),
                action: scheduled.action,
                expectedSequence: admission.record.facts.resource.sequence,
                expectedRecoveryRevision: scheduled.revision,
                signal,
              });
            else await this.recoverReservation(admission, scheduled.revision, signal);
          } catch (error) {
            if (
              expectedRace(error) ||
              (signal.aborted &&
                error instanceof Error &&
                error.message === "SANDBOX_RECONCILIATION_INTERRUPTED")
            )
              return;
            throw error;
          }
        });
        if (tasks.length >= Math.min(maximum, 100)) break;
      } catch (error) {
        if (!expectedRace(error)) throw error;
      }
    }
    const outcomes = await Promise.allSettled(tasks.map((task) => task()));
    const failed = outcomes.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async recoverReservation(
    admission: Extract<SandboxExecutionAdmissionRecord, { phase: "reserved" }>,
    expectedRecoveryRevision: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { preparations, reservations } = this.options;
    const identity = admission.plan.identity;
    const authority = this.options.authority();
    const startedAt = this.options.now();
    const attempt = await preparations.beginReservationRecovery({
      identity,
      authority,
      now: startedAt,
      expectedRecoveryRevision,
      deadlineAt: new Date(Date.parse(startedAt) + this.options.timeoutMs).toISOString(),
    });
    const controller = new AbortController();
    const assertActive = () => {
      if (signal.aborted) throw new Error("SANDBOX_RECONCILIATION_INTERRUPTED");
      if (controller.signal.aborted || this.options.now() >= attempt.deadlineAt)
        throw new Error("SANDBOX_RECONCILIATION_TIMED_OUT");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = () => {};
    let reasonCode = "SANDBOX_CONTROL_UNCONFIRMED";
    try {
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          const abort = () => {
            controller.abort();
            reject(new Error("SANDBOX_RECONCILIATION_INTERRUPTED"));
          };
          signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error("SANDBOX_RECONCILIATION_TIMED_OUT"));
            },
            Math.max(1, Date.parse(attempt.deadlineAt) - Date.parse(this.options.now())),
          );
        }),
        (async () => {
          assertActive();
          const current = await preparations.readAdmission(identity);
          if (
            current?.phase !== "reserved" ||
            !current.stopRequestedAt ||
            current.recovery?.status !== "running" ||
            current.recovery.revision !== attempt.revision ||
            current.recovery.owner !== authority.agentServiceBootId
          )
            throw new Error("SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED");
          assertActive();
          let stopFailure: unknown;
          try {
            await reservations.stop(current.plan, controller.signal);
          } catch (error) {
            if (
              !["SANDBOX_SUPERVISOR_UNAVAILABLE", "SANDBOX_HOST_UNAVAILABLE"].includes(
                sandboxReconciliationFailureReason(error),
              )
            )
              throw error;
            stopFailure = error;
          }
          assertActive();
          const verification = await reservations.verify(
            current.plan,
            current.stopRequestedAt,
            controller.signal,
          );
          assertActive();
          if (verification)
            await preparations.releaseReservation({
              identity,
              authority,
              now: this.options.now(),
              verification,
              expectedRecoveryRevision: attempt.revision,
            });
          else if (stopFailure) throw stopFailure;
        })(),
      ]);
    } catch (error) {
      reasonCode = sandboxReconciliationFailureReason(error);
      if (expectedRace(error)) throw error;
    } finally {
      controller.abort();
      clearTimeout(timer);
      removeAbortListener();
      const current = await preparations.readAdmission(identity);
      if (
        current?.phase === "reserved" &&
        current.recovery?.status === "running" &&
        current.recovery.revision === attempt.revision &&
        current.recovery.owner === authority.agentServiceBootId
      )
        await preparations.finishReservationRecovery({
          identity,
          authority,
          now: this.options.now(),
          expectedRecoveryRevision: attempt.revision,
          reasonCode,
        });
    }
  }
}
