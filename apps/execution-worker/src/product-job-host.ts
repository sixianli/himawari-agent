import type {
  SandboxExecutionPlan,
  SandboxHostObservation,
  SandboxHostSession,
} from "@himawari-agent/application";
import type { JobHostRequest, JobHostResult } from "@himawari-agent/runtime-sandbox";
import { prepareSandboxJobHost } from "@himawari-agent/runtime-sandbox";

/** Resolved by trusted host inventory and protected scope, never model arguments. */
export type ResolvedSandboxHostInput = Pick<
  JobHostRequest,
  "policy" | "policyDigest" | "executable" | "args" | "cleanupTimeoutMs" | "stdinBase64"
>;

/** Bridge infrastructure observations into the product lifecycle without treating
 * exit(0) as proof of complete cleanup. The output callback must use the existing
 * protected Payload/invocation result store. This function does not grant authority. */
export function createProductSandboxHostSession(
  plan: SandboxExecutionPlan,
  resolved: ResolvedSandboxHostInput,
  protectOutput: (
    result: JobHostResult,
  ) => Promise<{ readonly outputRef: string; readonly outputDigest: string }>,
): SandboxHostSession {
  const host = prepareSandboxJobHost({
    ...resolved,
    jobId: plan.identity.jobId,
    attemptId: plan.identity.attemptId,
    deadlineAt: new Date(
      Math.min(
        Date.parse(plan.effectiveDeadlineAt),
        Date.parse(plan.requestedAt) + plan.resourceCeiling.maxWallTimeMs,
      ),
    ).toISOString(),
    maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
    resourceLimits: {
      maxCpuTimeMs: plan.resourceCeiling.maxCpuTimeMs,
      maxMemoryBytes: plan.resourceCeiling.maxMemoryBytes,
    },
  });
  const result: Promise<SandboxHostObservation> = host.result.then(async (observation) => {
    const outcome =
      observation.reason === "cancelled"
        ? "cancelled"
        : observation.reason === "deadline"
          ? "timed_out"
          : observation.reason === "exited"
            ? observation.exitCode === 0
              ? "succeeded"
              : "failed"
            : observation.reason === "output_limit" || observation.reason === "resource_limit"
              ? "failed"
              : "unknown";
    let output: { outputRef: string; outputDigest: string } | undefined;
    if (observation.stdout.byteLength || observation.stderr.byteLength || observation.resources) {
      try {
        output = await protectOutput(observation);
      } catch {
        return {
          ...(observation.resources ? { resources: observation.resources } : {}),
          outcome: "unknown",
          cleanup: "unknown",
          effect: "unknown",
          outputRef: null,
          outputDigest: null,
          reasonCode: "SANDBOX_OUTPUT_PERSISTENCE_UNKNOWN",
        };
      }
    }
    return {
      ...(observation.resources ? { resources: observation.resources } : {}),
      outcome,
      // Current SRT adapter cannot certify all descendants/auxiliary processes.
      cleanup: "unknown",
      effect: observation.taskStarted === false ? "not_started" : "unknown",
      outputRef: output?.outputRef ?? null,
      outputDigest: output?.outputDigest ?? null,
      reasonCode:
        observation.reason === "exited"
          ? observation.exitCode === 0
            ? "SANDBOX_CLEANUP_UNKNOWN"
            : `SANDBOX_EXIT_${observation.exitCode ?? "UNKNOWN"}`
          : `SANDBOX_${observation.reason.toUpperCase()}`,
    };
  });
  void result.catch(() => {});
  return Object.freeze({
    policyDigest: resolved.policyDigest,
    ready: host.ready,
    result,
    start: () => host.start(),
    cancel: () => host.cancel(),
  });
}
