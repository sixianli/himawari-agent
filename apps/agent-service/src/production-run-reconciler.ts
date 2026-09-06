import {
  type AgentId,
  ApplicationPortError,
  type ClockPort,
  type OwnerId,
  PORT_ERROR_CODES,
  type RunLifecyclePort,
  type RunReconciliationPort,
} from "@himawari-agent/application";
import type { ProductionRunReconciler } from "./production-run-dispatcher.js";

/** Records uncertainty without calling a provider, replaying a tool or inventing a result. */
export function createProductionRunReconciler(options: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runs: Pick<RunLifecyclePort, "readRun">;
  readonly recovery: RunReconciliationPort;
  readonly clock: ClockPort;
}): ProductionRunReconciler {
  return async ({ candidate, reasonCode, executionLease }) => {
    if (candidate.ownerId !== options.ownerId || candidate.agentId !== options.agentId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "Recovery scope mismatch");
    const current = await options.runs.readRun(candidate.runId);
    if (!current)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Recovery Run missing");
    if (["completed", "failed", "cancelled"].includes(current.run.status)) return;
    await options.recovery.quarantine({
      runId: candidate.runId,
      expectedRunRevision: current.revision,
      expectedLeaseRevision: executionLease?.revision ?? candidate.leaseRevision,
      ...(executionLease ? { executionLeaseId: executionLease.executionLeaseId } : {}),
      reasonCode,
      at: options.clock.now(),
    });
  };
}
