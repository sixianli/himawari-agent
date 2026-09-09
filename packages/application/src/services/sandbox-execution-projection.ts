import {
  type SandboxEnvironment,
  type SandboxExecutionFacts,
  type SandboxExecutionPlanV2,
  type SandboxJobIdentity,
  type SandboxOperationContract,
  sandboxExecutionFactsSchema,
  validateSandboxExecutionFacts,
} from "@himawari-agent/execution-contracts";
import type { SandboxExecutionVerification } from "../ports/sandbox-execution.js";

export interface SandboxExecutionProjectionContext {
  readonly now: string;
  readonly environment: SandboxEnvironment;
  /** Resolve by capability/version from the trusted catalog, not request arguments. */
  readonly operationContract: SandboxOperationContract;
  readonly verification: SandboxExecutionVerification | null;
  readonly currentResourceSequence: number;
  readonly runState: "active" | "cancelled" | "expired" | "terminated";
  readonly currentAuthority: boolean;
  readonly currentFence: boolean;
  readonly userDisclosureAllowed: boolean;
  readonly modelDisclosureAllowed: boolean;
  readonly conflictingWorkspaceRisk: boolean;
  readonly pendingApprovalOrReconciliation: boolean;
  readonly resultAlreadyDelivered: boolean;
}
export interface SandboxExecutionProjection {
  readonly conclusion: "pending" | "unknown" | "succeeded" | "failed" | "started";
  readonly showResult: boolean;
  readonly deliverToolResult: boolean;
  readonly continuePi: boolean;
  readonly dispatchNewOperation: boolean;
  readonly invokeService: boolean;
  readonly reuseEnvironment: boolean;
  readonly resourceObligationReleased: boolean;
  readonly operationSettled: boolean;
  readonly needsReconciliation: boolean;
  readonly resourcePending: boolean;
}
const sameIdentity = (a: SandboxJobIdentity, b: SandboxJobIdentity) =>
  (Object.keys(b) as (keyof SandboxJobIdentity)[]).every((key) => a[key] === b[key]);
/** Shared read projection for Worker, Run and UI. It grants no authority and performs no dispatch.
 * Consumers must CAS the returned decision against the current sequence/fence, then recheck at dispatch.
 */
export function projectSandboxExecution(
  plan: SandboxExecutionPlanV2,
  input: SandboxExecutionFacts,
  context: SandboxExecutionProjectionContext,
): SandboxExecutionProjection {
  const facts = validateSandboxExecutionFacts(plan, input, context);
  const { result, effect, resource } = facts;
  const now = Date.parse(context.now);
  const proof = context.verification;
  const snapshotVerified =
    proof !== null &&
    JSON.stringify(sandboxExecutionFactsSchema.parse(proof.facts)) === JSON.stringify(facts) &&
    sameIdentity(proof.identity, plan.identity) &&
    proof.environmentId === plan.environmentId &&
    proof.policyDigest === facts.environment.policyDigest &&
    proof.resourceSequence === resource.sequence &&
    context.currentResourceSequence === resource.sequence &&
    Date.parse(proof.checkedAt) <= now &&
    now < Date.parse(proof.validUntil) &&
    Date.parse(resource.occurredAt) <= Date.parse(proof.checkedAt) &&
    (!result || Date.parse(result.occurredAt) <= Date.parse(proof.checkedAt)) &&
    (effect.kind !== "verified" || Date.parse(effect.occurredAt) <= Date.parse(proof.checkedAt));
  const hasEvidence = (value: { readonly ref: string; readonly digest: string }) =>
    snapshotVerified &&
    proof !== null &&
    proof.evidence.some((item) => item.ref === value.ref && item.digest === value.digest);
  const outputProtected =
    result !== null &&
    result.kind !== "unknown" &&
    snapshotVerified &&
    proof !== null &&
    proof.outputs.some(
      (item) =>
        item.ref === result.output.ref &&
        item.digest === result.output.digest &&
        item.byteLength === result.output.byteLength,
    ) &&
    result.output.byteLength <= plan.resourceCeiling.maxOutputBytes;
  const supervisionVerified =
    (resource.supervision === "controlled" || resource.supervision === "released") &&
    hasEvidence(resource.evidence) &&
    now < Date.parse(resource.evidence.validUntil);
  const released = resource.supervision === "released" && supervisionVerified;
  const controlled =
    resource.supervision === "controlled" &&
    supervisionVerified &&
    now < Date.parse(facts.environment.deadlineAt);
  const effectKnown =
    effect.kind === "not_applicable" ||
    effect.kind === "not_asserted" ||
    (effect.kind === "verified" && hasEvidence(effect.evidence));
  const readinessKnown =
    result?.kind !== "started" ||
    result.handle.kind !== "service" ||
    (result.readinessEvidence !== null && hasEvidence(result.readinessEvidence));
  let conclusion: SandboxExecutionProjection["conclusion"] = "pending";
  if (result) {
    if (result.kind === "unknown" || !outputProtected) conclusion = "unknown";
    else if (result.kind === "error") conclusion = "failed";
    else if (!effectKnown || !readinessKnown) conclusion = "unknown";
    else if (result.kind === "started") conclusion = "started";
    else
      conclusion =
        result.completion.type === "exit" && result.completion.exitCode !== 0
          ? "failed"
          : "succeeded";
  }
  const settled = conclusion !== "pending" && conclusion !== "unknown" && effectKnown;
  const needsReconciliation =
    (effect.kind === "unknown" && result !== null) ||
    (released && !settled) ||
    conclusion === "unknown" ||
    resource.cleanup === "unknown" ||
    resource.supervision === "reconciling" ||
    ((resource.supervision === "controlled" || resource.supervision === "released") &&
      !supervisionVerified);
  const active = context.runState === "active" && now < Date.parse(plan.effectiveDeadlineAt);
  const canAct =
    active &&
    context.currentAuthority &&
    context.currentFence &&
    context.modelDisclosureAllowed &&
    !context.conflictingWorkspaceRisk &&
    !context.pendingApprovalOrReconciliation &&
    settled &&
    !needsReconciliation &&
    (controlled || released);
  return Object.freeze({
    conclusion,
    // Known output remains visible after resource loss; user and model disclosure are independent.
    showResult: context.userDisclosureAllowed && outputProtected,
    deliverToolResult: canAct && !context.resultAlreadyDelivered,
    continuePi: canAct,
    dispatchNewOperation: canAct,
    invokeService:
      canAct &&
      controlled &&
      resource.status.kind === "service" &&
      resource.status.readiness === "ready" &&
      plan.mode === "service" &&
      (plan.operationContract.kind !== "service_start" ||
        (result?.kind === "started" && readinessKnown)),
    reuseEnvironment:
      released &&
      context.currentFence &&
      !context.conflictingWorkspaceRisk &&
      !needsReconciliation &&
      !context.pendingApprovalOrReconciliation,
    resourceObligationReleased: released,
    operationSettled: settled,
    needsReconciliation,
    resourcePending: !released,
  });
}

/** A Run can own many operations and resources. Completeness comes from its existing coordinator.
 * This is permission to finish normally, not an inference that the user's goal succeeded.
 */
export function projectSandboxRunCompletion(input: {
  readonly runState: SandboxExecutionProjectionContext["runState"];
  readonly inventoryComplete: boolean;
  readonly currentFence: boolean;
  readonly pendingApprovalOrReconciliation: boolean;
  readonly operations: readonly SandboxExecutionProjection[];
}): { readonly canCompleteNormally: boolean } {
  return Object.freeze({
    canCompleteNormally:
      input.runState === "active" &&
      input.inventoryComplete &&
      input.currentFence &&
      !input.pendingApprovalOrReconciliation &&
      input.operations.every(
        (item) =>
          item.operationSettled && item.resourceObligationReleased && !item.needsReconciliation,
      ),
  });
}
