import type { CapabilityInvocationAuthority } from "../ports/capability-invocations.js";
import type { SandboxJobJournalPort } from "../ports/sandbox-execution.js";
import { SandboxJobLifecycleService } from "./sandbox-job-lifecycle-service.js";

/** Run under the new Agent Service authority before exposing admission or HTTP.
 * Recovery has no launch capability. Old Worker boot credentials are not reused.
 * This records uncertainty; it does not claim that old descendants have stopped. */
export async function recoverSandboxJobsAtStartup(options: {
  readonly journal: SandboxJobJournalPort;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
}): Promise<{ readonly examined: number; readonly quarantined: number }> {
  const lifecycle = new SandboxJobLifecycleService({
    journal: options.journal,
    authority: options.authority,
    now: options.now,
    verify: async () => {
      throw new Error("SANDBOX_RECOVERY_CANNOT_START");
    },
    prepareHost: async () => {
      throw new Error("SANDBOX_RECOVERY_CANNOT_START");
    },
  });
  let afterJobId: string | null = null;
  let examined = 0;
  let quarantined = 0;
  for (;;) {
    const page = await options.journal.listPending({ afterJobId, limit: 100 });
    if (!page.length) return { examined, quarantined };
    for (const record of page) {
      if (afterJobId !== null && record.plan.identity.jobId <= afterJobId)
        throw new Error("SANDBOX_RECOVERY_CURSOR_INVALID");
      afterJobId = record.plan.identity.jobId;
      examined++;
      if (record.observation.state === "quarantined") continue;
      if (record.observation.state === "prepared") {
        const now = options.now();
        await options.journal.append({
          authority: options.authority(),
          now,
          observation: {
            ...record.observation,
            sequence: record.observation.sequence + 1,
            state: "stopping",
            occurredAt: now,
            reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
          },
        });
      }
      const observation = await lifecycle.reconcile(record.plan.identity);
      if (observation.state !== "quarantined") throw new Error("SANDBOX_RECOVERY_INCOMPLETE");
      quarantined++;
    }
  }
}

/** Invalidate observations from an earlier supervisor before opening v2 admission.
 * This entry has no process or launch port. Existing operation/effect facts are
 * preserved and intersecting workspace claims remain held by the same journal.
 */
export async function recoverSandboxExecutionsAtStartup(options: {
  readonly journal: import("../ports/sandbox-execution-journal.js").SandboxExecutionJournalPort;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
}): Promise<{ readonly examined: number; readonly quarantined: number }> {
  let afterJobId: string | null = null;
  let examined = 0;
  let quarantined = 0;
  for (;;) {
    const page = await options.journal.listPending({ afterJobId, limit: 100 });
    if (!page.length) return { examined, quarantined };
    for (const record of page) {
      if (afterJobId !== null && record.plan.identity.jobId <= afterJobId)
        throw new Error("SANDBOX_RECOVERY_CURSOR_INVALID");
      afterJobId = record.plan.identity.jobId;
      examined++;
      const previous = record.facts.resource;
      // A released environment with unresolved effects retains its existing
      // occupancy. Restart cannot undo confirmed cleanup or resolve effects.
      if (previous.supervision === "lost" || previous.supervision === "released") continue;
      const now = options.now();
      const { supervision: _state, cleanup: _cleanup, ...fields } = previous;
      const {
        evidence: _evidence,
        reasonCode: _reason,
        ...common
      } = fields as typeof fields & {
        readonly evidence?: unknown;
        readonly reasonCode?: string;
      };
      const facts = {
        ...record.facts,
        resource: {
          ...common,
          sequence: previous.sequence + 1,
          occurredAt: now,
          status:
            previous.status.kind === "task"
              ? { kind: "task" as const, state: "unknown" as const }
              : previous.status.kind === "service"
                ? { kind: "service" as const, readiness: "unavailable" as const }
                : previous.status,
          supervision: "lost" as const,
          cleanup: "unknown" as const,
          reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
        },
      };
      const mutation = await options.journal.append({
        identity: record.plan.identity,
        expectedSequence: previous.sequence,
        expectedOperationRevision: record.operationRevision,
        facts,
        authority: options.authority(),
        now,
        context: {
          now,
          environment: record.facts.environment,
          operationContract: record.plan.operationContract,
          verification: null,
          currentResourceSequence: facts.resource.sequence,
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
      if (mutation.record.facts.resource.supervision !== "lost")
        throw new Error("SANDBOX_RECOVERY_INCOMPLETE");
      if (mutation.applied) quarantined++;
    }
  }
}
