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
