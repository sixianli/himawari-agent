import {
  type SandboxExecutionPlan,
  type SandboxJobIdentity,
  type SandboxJobReceipt,
  sandboxExecutionPlanSchema,
  sandboxJobIdentitySchema,
  sandboxJobReceiptSchema,
} from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "../ports/capability-invocations.js";
import type {
  SandboxExecutionPort,
  SandboxHostObservation,
  SandboxHostSession,
  SandboxJobJournalPort,
  SandboxJobRecord,
} from "../ports/sandbox-execution.js";

export interface SandboxJobLifecycleOptions {
  readonly journal: Pick<SandboxJobJournalPort, "read" | "append">;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
  /** Revalidate protected scope, current directory/network authority and host qualification. */
  readonly verify: (plan: SandboxExecutionPlan) => Promise<void>;
  /** Prepare trusted infrastructure only; the task must wait for start(). */
  readonly prepareHost: (plan: SandboxExecutionPlan) => Promise<SandboxHostSession>;
}

const unknown: SandboxHostObservation = {
  outcome: "unknown",
  cleanup: "unknown",
  effect: "unknown",
  outputRef: null,
  outputDigest: null,
  reasonCode: "SANDBOX_HOST_RESULT_UNKNOWN",
};

/** Coordinates the existing durable job ledger; does not own an Agent loop or
 * create permissions. Process-local serialization supplements, never replaces,
 * the journal's transactional start CAS and authority checks. */
export class SandboxJobLifecycleService implements SandboxExecutionPort {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly sessions = new Map<string, SandboxHostSession>();
  private readonly claimed = new Map<string, SandboxHostSession>();
  private readonly cancellations = new Set<string>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly options: SandboxJobLifecycleOptions;
  constructor(options: SandboxJobLifecycleOptions) {
    this.options = options;
  }

  private key(identity: SandboxJobIdentity): string {
    return JSON.stringify(sandboxJobIdentitySchema.parse(identity));
  }
  private serial<T>(identity: SandboxJobIdentity, action: () => Promise<T>): Promise<T> {
    const key = this.key(identity);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(key, next);
    void next
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async read(identity: SandboxJobIdentity): Promise<SandboxJobRecord> {
    const record = await this.options.journal.read(sandboxJobIdentitySchema.parse(identity));
    if (!record) throw new Error("SANDBOX_JOB_NOT_ADMITTED");
    return record;
  }
  private async append(record: SandboxJobRecord, fields: Partial<SandboxJobReceipt>) {
    const now = this.options.now();
    return this.options.journal.append({
      observation: sandboxJobReceiptSchema.parse({
        ...record.observation,
        ...fields,
        identity: record.plan.identity,
        sequence: record.observation.sequence + 1,
        policyDigest: record.observation.policyDigest,
        occurredAt: now,
      }),
      authority: this.options.authority(),
      now,
    });
  }
  async prepare(value: SandboxExecutionPlan): Promise<SandboxJobReceipt> {
    const plan = sandboxExecutionPlanSchema.parse(value);
    return this.serial(plan.identity, async () => {
      const record = await this.read(plan.identity);
      if (JSON.stringify(sandboxExecutionPlanSchema.parse(record.plan)) !== JSON.stringify(plan))
        throw new Error("SANDBOX_JOB_PLAN_CHANGED");
      if (record.observation.state === "prepared") await this.options.verify(plan);
      return record.observation;
    });
  }
  async start(value: SandboxJobIdentity): Promise<SandboxJobReceipt> {
    const identity = sandboxJobIdentitySchema.parse(value);
    return this.serial(identity, async () => {
      const record = await this.read(identity);
      if (record.observation.state !== "prepared") return record.observation;
      const key = this.key(identity);
      if (this.cancellations.has(key)) throw new Error("SANDBOX_JOB_CANCELLED");
      await this.options.verify(record.plan);
      const host = await this.options.prepareHost(record.plan);
      this.sessions.set(key, host);
      // Consume both success and rejection immediately, including preparation failure.
      const completion = host.result
        .catch(() => unknown)
        .then((result) =>
          this.serial(identity, async () => {
            if (this.claimed.get(key) === host) await this.settle(identity, result);
            else if (this.sessions.get(key) === host) this.sessions.delete(key);
          }),
        );
      this.completions.set(key, completion);
      void completion.catch(() => {}); // wait() exposes persistence failures to the Worker.
      try {
        if (this.cancellations.has(key)) host.cancel();
        await host.ready;
        if (host.policyDigest !== record.observation.policyDigest)
          throw new Error("SANDBOX_JOB_POLICY_CHANGED");
        if (this.cancellations.has(key)) throw new Error("SANDBOX_JOB_CANCELLED");
        await this.options.verify(record.plan);
        if (this.cancellations.has(key)) throw new Error("SANDBOX_JOB_CANCELLED");
        const admitted = await this.append(record, { state: "starting" });
        if (!admitted.applied) {
          host.cancel();
          return admitted.record.observation;
        }
        this.claimed.set(key, host);
        // Cancellation can race the durable append. Never launch after that request.
        if (this.cancellations.has(key)) {
          host.cancel();
          return admitted.record.observation;
        }
        host.start();
        return admitted.record.observation;
      } catch (error) {
        host.cancel();
        throw error;
      }
    });
  }
  private async settle(identity: SandboxJobIdentity, value: SandboxHostObservation): Promise<void> {
    let record = await this.read(identity);
    if (["completed", "failed", "quarantined"].includes(record.observation.state)) return;
    if (record.observation.state !== "stopping" && record.observation.state !== "reconciling")
      record = (await this.append(record, { state: "stopping" })).record;
    const confirmed = value.cleanup === "confirmed" && value.effect !== "unknown";
    const state =
      confirmed && value.outcome === "succeeded"
        ? "completed"
        : confirmed && ["failed", "cancelled", "timed_out"].includes(value.outcome)
          ? "failed"
          : "quarantined";
    await this.append(record, {
      ...value,
      state,
      reasonCode:
        state === "quarantined"
          ? (value.reasonCode ?? "SANDBOX_CLEANUP_UNKNOWN")
          : value.reasonCode,
    });
    this.sessions.delete(this.key(identity));
  }
  async observe(identity: SandboxJobIdentity): Promise<SandboxJobReceipt> {
    return (await this.read(identity)).observation;
  }
  /** Await this process's observation persistence; a restart only reads the ledger. */
  async wait(value: SandboxJobIdentity): Promise<SandboxJobReceipt> {
    const identity = sandboxJobIdentitySchema.parse(value);
    await this.completions.get(this.key(identity));
    return this.observe(identity);
  }
  async cancel(value: SandboxJobIdentity, reason: "owner_cancelled" | "deadline_exceeded") {
    const identity = sandboxJobIdentitySchema.parse(value);
    const key = this.key(identity);
    this.cancellations.add(key);
    this.sessions.get(key)?.cancel();
    return this.serial(identity, async () => {
      const record = await this.read(identity);
      if (
        ["completed", "failed", "quarantined", "reconciling", "stopping"].includes(
          record.observation.state,
        )
      )
        return record.observation;
      await this.append(record, { state: "stopping", reasonCode: reason });
      if (!this.claimed.has(key)) await this.settle(identity, unknown);
      return this.observe(identity);
    });
  }
  async reconcile(value: SandboxJobIdentity): Promise<SandboxJobReceipt> {
    const identity = sandboxJobIdentitySchema.parse(value);
    return this.serial(identity, async () => {
      let record = await this.read(identity);
      if (
        this.sessions.has(this.key(identity)) ||
        ["prepared", "completed", "failed", "quarantined"].includes(record.observation.state)
      )
        return record.observation;
      const recovery = {
        ...unknown,
        outputRef: record.observation.outputRef,
        outputDigest: record.observation.outputDigest,
      };
      if (record.observation.state !== "reconciling")
        record = (await this.append(record, { state: "reconciling", ...recovery })).record;
      return (await this.append(record, { state: "quarantined", ...recovery })).record.observation;
    });
  }
}
