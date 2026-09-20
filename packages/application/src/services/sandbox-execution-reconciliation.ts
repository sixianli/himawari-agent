import {
  type SandboxJobIdentity,
  type SandboxResourceObservation,
  sandboxJobIdentitySchema,
  sandboxResourceObservationSchema,
} from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "../ports/capability-invocations.js";
import type { SandboxExecutionEvidencePort } from "../ports/sandbox-execution.js";
import type {
  SandboxExecutionJournalPort,
  SandboxExecutionRecord,
} from "../ports/sandbox-execution-journal.js";

/** Deliberately no prepare/start/invoke capability. The backend must match the
 * immutable environment and original process identity before any limited stop.
 * Absence of that identity is uncertainty, never permission to adopt a PID.
 */
export interface SandboxReconciliationBackend {
  inspect(record: SandboxExecutionRecord, signal: AbortSignal): Promise<SandboxResourceObservation>;
  stop(record: SandboxExecutionRecord, signal: AbortSignal): Promise<SandboxResourceObservation>;
}

/** Current Agent authority owns reconciliation; the original consumed Grant is
 * not consumed again and old Worker credentials are not inherited. Journal CAS
 * persists risk before a bounded backend request, and verifies any release.
 */
interface ReconciliationOptions {
  readonly hostId: string;
  readonly journal: Pick<
    SandboxExecutionJournalPort,
    "read" | "append" | "beginRecovery" | "finishRecovery"
  >;
  readonly evidence: SandboxExecutionEvidencePort;
  readonly backend?: SandboxReconciliationBackend;
  readonly timeoutMs: number;
  readonly now: () => string;
}
export class SandboxExecutionReconciliationService {
  private readonly options: ReconciliationOptions;
  constructor(options: ReconciliationOptions) {
    this.options = options;
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30000
    )
      throw new Error("SANDBOX_RECONCILIATION_TIMEOUT_INVALID");
  }

  async reconcile(input: {
    readonly identity: SandboxJobIdentity;
    readonly expectedSequence: number;
    readonly authority: CapabilityInvocationAuthority;
    readonly action: "inspect" | "stop";
  }): Promise<{ readonly record: SandboxExecutionRecord; readonly applied: boolean }> {
    const identity = sandboxJobIdentitySchema.parse(input.identity);
    let record = await this.options.journal.read(identity);
    if (!record || record.plan.identity.hostId !== this.options.hostId)
      throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
    if (record.facts.resource.sequence !== input.expectedSequence)
      throw new Error("SANDBOX_RECONCILIATION_SEQUENCE_CHANGED");
    if (
      record.facts.resource.supervision === "released" &&
      record.releaseReceipt &&
      !record.workspaceBlocked
    )
      return { record, applied: false };
    const startedAt = this.options.now();
    const recovery = await this.options.journal.beginRecovery({
      identity,
      expectedSequence: record.facts.resource.sequence,
      authority: input.authority,
      now: startedAt,
      action: input.action,
      deadlineAt: new Date(Date.parse(startedAt) + this.options.timeoutMs).toISOString(),
    });
    const refreshOwned = async () => {
      const latest = await this.options.journal.read(identity);
      if (!latest) throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
      if (
        latest.recovery?.status !== "running" ||
        latest.recovery.owner !== input.authority.agentServiceBootId ||
        latest.recovery.revision !== recovery.revision
      )
        throw new Error("SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED");
      record = latest;
      return latest;
    };
    const controller = new AbortController();
    const assertActive = () => {
      if (controller.signal.aborted || this.options.now() >= recovery.deadlineAt)
        throw new Error("SANDBOX_RECONCILIATION_TIMED_OUT");
    };

    const observation = (
      state: "reconciling" | "lost",
      reasonCode: string,
    ): SandboxResourceObservation => {
      if (!record) throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
      const old = record.facts.resource;
      return sandboxResourceObservationSchema.parse({
        schemaVersion: old.schemaVersion,
        environmentId: old.environmentId,
        creator: old.creator,
        policyDigest: old.policyDigest,
        scopeDigest: old.scopeDigest,
        sequence: old.sequence + 1,
        occurredAt: this.options.now(),
        supervisor: old.supervisor,
        resourceRef: old.resourceRef,
        status: old.status,
        metrics: old.metrics,
        supervision: state,
        cleanup: "unknown",
        reasonCode,
      });
    };
    const append = async (resource: SandboxResourceObservation, fromBackend = false) => {
      if (!record) throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
      if (fromBackend) assertActive();
      let now = this.options.now();
      const facts = { ...record.facts, resource };
      const verification =
        resource.supervision === "released"
          ? await this.options.evidence.verify({ plan: record.plan, facts, now })
          : null;
      now = this.options.now();
      if (fromBackend) assertActive();
      const mutation = await this.options.journal.append({
        identity,
        expectedSequence: record.facts.resource.sequence,
        expectedOperationRevision: record.operationRevision,
        expectedRecoveryRevision: recovery.revision,
        authority: input.authority,
        now,
        facts,
        context: {
          now,
          environment: record.facts.environment,
          operationContract: record.plan.operationContract,
          verification,
          currentResourceSequence: resource.sequence,
          runState: "terminated",
          currentAuthority: false,
          currentFence: false,
          userDisclosureAllowed: false,
          modelDisclosureAllowed: false,
          conflictingWorkspaceRisk: true,
          pendingApprovalOrReconciliation: true,
          resultAlreadyDelivered: false,
        },
      });
      record = mutation.record;
      return mutation;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reasonCode = "SANDBOX_RECONCILIATION_UNCONFIRMED";
    let applied = false;
    try {
      // Released observations are monotonic. Legacy rows need a fresh proof,
      // not a fabricated transition back into execution/reconciling.
      if (record.facts.resource.supervision !== "released") {
        const admitted = await append(
          observation("reconciling", "SANDBOX_RECONCILIATION_REQUESTED"),
        );
        if (!admitted.applied) throw new Error("SANDBOX_RECONCILIATION_SEQUENCE_CHANGED");
      }
      const backend = this.options.backend;
      if (!backend) throw new Error("SANDBOX_SUPERVISOR_UNAVAILABLE");
      assertActive();
      const mutation = await Promise.race([
        (async () => {
          const resource = await backend[input.action](structuredClone(record), controller.signal);
          assertActive();
          if (!["released", "lost"].includes(resource.supervision))
            throw new Error("SANDBOX_RECONCILIATION_INCONCLUSIVE");
          return append(sandboxResourceObservationSchema.parse(resource), true);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error("SANDBOX_RECONCILIATION_TIMED_OUT"));
            },
            Math.max(1, Date.parse(recovery.deadlineAt) - Date.parse(this.options.now())),
          );
        }),
      ]);
      reasonCode = mutation.record.workspaceBlocked
        ? "SANDBOX_PROTECTION_REMAINS"
        : "SANDBOX_RECONCILIATION_CONFIRMED";
      applied = mutation.applied;
    } catch (error) {
      // Stop accepting callbacks before persisting the terminal recovery state.
      controller.abort();
      if (
        error instanceof Error &&
        [
          "SANDBOX_RECONCILIATION_TIMED_OUT",
          "SANDBOX_SUPERVISOR_UNAVAILABLE",
          "SANDBOX_RECONCILIATION_INCONCLUSIVE",
        ].includes(error.message)
      )
        reasonCode = error.message;
      await refreshOwned();
      // Failure never revokes a historical release or invents isolation evidence.
      if (record.facts.resource.supervision !== "released")
        applied = (await append(observation("lost", reasonCode))).applied;
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Concurrent operation results are independent of resource recovery. Finish
      // against the latest sequence without replacing them or another owner.
      await refreshOwned();
      await this.options.journal.finishRecovery({
        identity,
        expectedSequence: record.facts.resource.sequence,
        expectedRecoveryRevision: recovery.revision,
        authority: input.authority,
        now: this.options.now(),
        reasonCode,
      });
    }
    const persisted = await this.options.journal.read(identity);
    if (!persisted) throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
    return { record: persisted, applied };
  }
}
