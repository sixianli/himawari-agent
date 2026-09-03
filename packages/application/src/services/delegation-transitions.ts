import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type AutonomyScope,
  type Delegation,
  type DelegationStatePort,
  type DelegationHandleLifecyclePort,
} from "../ports/index.js";

export function delegationIsTerminal(value: Delegation): boolean {
  return value.status === "completed" || value.status === "failed" || value.status === "cancelled";
}

export function ownsDelegationClaim(value: Delegation, claimId: string, now: string): boolean {
  return (
    !delegationIsTerminal(value) &&
    value.executionClaim?.id === claimId &&
    value.executionClaim.leaseUntil > now
  );
}

export function assertDelegationTransition(previous: Delegation, next: Delegation): void {
  const immutable = (value: Delegation) => [
    value.id,
    value.ownerId,
    value.agentId,
    value.parentRunId,
    value.workerRunId,
    value.traceRef,
    value.subtaskRef,
    value.outputSchema,
    value.contextRefs,
    value.capabilityHandleRefs,
    value.allowedModelRefs,
    value.selectedModelRef,
    value.budget,
    value.deadlineAt,
    value.dataClassification,
    value.depth,
    value.createdAt,
  ];
  const states: Record<Delegation["status"], readonly Delegation["status"][]> = {
    created: ["created", "running", "failed", "cancelled"],
    running: ["running", "validating", "failed", "cancelled"],
    validating: ["validating", "completed", "failed", "cancelled"],
    completed: ["completed"],
    failed: ["failed"],
    cancelled: ["cancelled"],
  };
  if (
    JSON.stringify(immutable(previous)) !== JSON.stringify(immutable(next)) ||
    !states[previous.status].includes(next.status) ||
    next.progressEventsObserved < previous.progressEventsObserved ||
    next.executionGeneration < previous.executionGeneration ||
    (delegationIsTerminal(next) && next.executionClaim !== null) ||
    (next.status === "completed" && next.workerResult === null) ||
    (next.status !== "completed" && next.workerResult !== null) ||
    (delegationIsTerminal(previous) &&
      (previous.failureReasonCode !== next.failureReasonCode ||
        JSON.stringify(previous.workerResult) !== JSON.stringify(next.workerResult)))
  )
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Invalid Delegation state transition",
    );
}

export async function updateDelegation(
  state: DelegationStatePort,
  scope: AutonomyScope,
  id: string,
  update: (current: Delegation) => Delegation,
): Promise<Delegation> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await state.read(scope, id);
    if (!current)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Delegation was not found");
    const updated = update(current);
    if (updated === current) return current;
    const next = { ...updated, revision: current.revision + 1 };
    assertDelegationTransition(current, next);
    try {
      return await state.save(next, current.revision);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
        throw error;
    }
  }
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Delegation remained concurrent");
}

export async function settleDelegationHandles(
  state: DelegationStatePort,
  handles: DelegationHandleLifecyclePort,
  delegation: Delegation,
): Promise<Delegation> {
  if (!delegationIsTerminal(delegation) || delegation.handlesEndedAt !== null) return delegation;
  await handles.endHandles({
    ownerId: delegation.ownerId,
    agentId: delegation.agentId,
    parentRunId: delegation.parentRunId,
    handleRefs: delegation.capabilityHandleRefs,
    endedAt: delegation.updatedAt,
  });
  return updateDelegation(state, delegation, delegation.id, (current) =>
    current.handlesEndedAt !== null
      ? current
      : { ...current, handlesEndedAt: delegation.updatedAt },
  );
}
