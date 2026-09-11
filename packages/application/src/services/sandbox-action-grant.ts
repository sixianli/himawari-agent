import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { SandboxExecutionPlanCandidate } from "@himawari-agent/execution-contracts";
import type { AuthorizationStorePort, GovernedActionIntent } from "../ports/authorization.js";
import { actionIntentFingerprint } from "./permission-service.js";

/** Re-read the existing action Grant and its approved semantic snapshot. This
 * authenticates scope; it never consumes another use. */
export async function resolveSandboxActionGrant(input: {
  readonly plan: Pick<
    SandboxExecutionPlanCandidate,
    "authorizationRef" | "capabilityRef" | "capabilityVersion" | "operation" | "effectiveDeadlineAt"
  > & {
    readonly identity: Pick<
      SandboxExecutionPlanCandidate["identity"],
      "ownerId" | "agentId" | "runId" | "threadId"
    >;
  };
  readonly authorizations: Pick<
    AuthorizationStorePort,
    "listGrants" | "getApproval" | "isPolicyAuthorizationCurrent"
  >;
  readonly now: () => string;
}) {
  const { plan } = input;
  const grants = await input.authorizations.listGrants(
    createOwnerId(plan.identity.ownerId),
    createAgentId(plan.identity.agentId),
  );
  const grant = grants.find((entry) => entry.id === plan.authorizationRef);
  if (!grant) throw new Error("missing grant");
  const approval = await input.authorizations.getApproval(grant.sourceApprovalRequestId);
  if (
    approval?.policyAuthorization &&
    !(await input.authorizations.isPolicyAuthorizationCurrent?.({
      ownerId: approval.ownerId,
      agentId: approval.agentId,
      ...approval.policyAuthorization,
    }))
  )
    throw new Error("owner policy revoked or changed");
  const now = input.now();
  const intent = approval?.intentSnapshot as GovernedActionIntent | undefined;
  if (
    !approval ||
    !intent ||
    intent.contractVersion !== "authorization.v2" ||
    approval.status !== "approved" ||
    approval.grantId !== grant.id ||
    approval.ownerId !== plan.identity.ownerId ||
    approval.agentId !== plan.identity.agentId ||
    approval.runId !== plan.identity.runId ||
    grant.ownerId !== plan.identity.ownerId ||
    grant.agentId !== plan.identity.agentId ||
    grant.revokedAt !== null ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now ||
    now < grant.validFrom ||
    now >= grant.expiresAt ||
    plan.effectiveDeadlineAt > grant.expiresAt ||
    intent.ownerId !== plan.identity.ownerId ||
    intent.agentId !== plan.identity.agentId ||
    intent.runId !== plan.identity.runId ||
    intent.threadId !== plan.identity.threadId ||
    intent.capabilityRef !== plan.capabilityRef ||
    intent.capabilityVersion !== plan.capabilityVersion ||
    intent.operation !== plan.operation ||
    grant.scope.capabilityRef !== plan.capabilityRef ||
    !grant.scope.operations.includes(plan.operation) ||
    now >= intent.expiresAt ||
    plan.effectiveDeadlineAt > intent.expiresAt ||
    approval.semanticSnapshotHash !== actionIntentFingerprint(intent) ||
    (grant.intentFingerprint !== null && grant.intentFingerprint !== approval.semanticSnapshotHash)
  )
    throw new Error("grant or approval changed");
  return { grant, intent };
}
