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
  readonly journal: Pick<SandboxExecutionJournalPort, "read" | "append">;
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
    if (record.facts.resource.supervision === "released") return { record, applied: false };

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
    const append = async (resource: SandboxResourceObservation) => {
      if (!record) throw new Error("SANDBOX_RECONCILIATION_BINDING_INVALID");
      const now = this.options.now();
      const facts = { ...record.facts, resource };
      const verification =
        resource.supervision === "released"
          ? await this.options.evidence.verify({ plan: record.plan, facts, now })
          : null;
      const mutation = await this.options.journal.append({
        identity,
        expectedSequence: record.facts.resource.sequence,
        expectedOperationRevision: record.operationRevision,
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
    const admitted = await append(observation("reconciling", "SANDBOX_RECONCILIATION_REQUESTED"));
    if (!admitted.applied) return admitted;
    const backend = this.options.backend;
    if (!backend) return append(observation("lost", "SANDBOX_SUPERVISOR_UNAVAILABLE"));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resource = await Promise.race([
        // Pass a copy: a backend cannot alter the known operation/effect facts.
        backend[input.action](structuredClone(record), controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("SANDBOX_RECONCILIATION_TIMED_OUT"));
          }, this.options.timeoutMs);
        }),
      ]);
      if (!["released", "lost"].includes(resource.supervision))
        throw new Error("SANDBOX_RECONCILIATION_INCONCLUSIVE");
      return await append(sandboxResourceObservationSchema.parse(resource));
    } catch {
      // No positive proof, backend failure, or a rejected release never unlocks
      // the environment. A concurrent update/fence change still fails this CAS.
      return append(observation("lost", "SANDBOX_RECONCILIATION_UNCONFIRMED"));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
