import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type SandboxExecutionPlanCandidate,
  type SandboxScope,
  sandboxNetworkDomainSchema,
} from "@himawari-agent/execution-contracts";
import type { AuthorizationStorePort, GovernedActionIntent } from "../ports/authorization.js";
import { actionIntentFingerprint } from "./permission-service.js";

/** Network scope is a projection of the same action Grant, not another grant
 * consumption. The original admission/start transaction still owns live use.
 * Exact approved hosts are bounded by host inventory; inventory cannot add hosts. */
export async function resolveSandboxNetworkAuthorization(input: {
  readonly plan: Pick<
    SandboxExecutionPlanCandidate,
    "authorizationRef" | "capabilityRef" | "capabilityVersion" | "operation" | "effectiveDeadlineAt"
  > & {
    readonly identity: Pick<
      SandboxExecutionPlanCandidate["identity"],
      "ownerId" | "agentId" | "runId" | "threadId"
    >;
  };
  readonly scope: Pick<SandboxScope, "authorizationRef" | "networkAuthorizationRef">;
  readonly authorizations: Pick<AuthorizationStorePort, "listGrants" | "getApproval">;
  readonly maximumDomains: readonly string[];
  readonly now: () => string;
}): Promise<readonly string[]> {
  const { plan, scope } = input;
  if (scope.networkAuthorizationRef === null) return [];
  try {
    if (
      scope.networkAuthorizationRef !== plan.authorizationRef ||
      scope.authorizationRef !== plan.authorizationRef
    )
      throw new Error("different grant");
    const grants = await input.authorizations.listGrants(
      createOwnerId(plan.identity.ownerId),
      createAgentId(plan.identity.agentId),
    );
    const grant = grants.find((entry) => entry.id === plan.authorizationRef);
    if (!grant) throw new Error("missing grant");
    const approval = await input.authorizations.getApproval(grant.sourceApprovalRequestId);
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
      (grant.intentFingerprint !== null &&
        grant.intentFingerprint !== approval.semanticSnapshotHash)
    )
      throw new Error("grant or approval changed");
    const domains = intent.targets
      .filter((target) => target.type === "network-domain")
      .map((target) => sandboxNetworkDomainSchema.parse(target.ref));
    if (
      domains.length === 0 ||
      domains.length > 128 ||
      new Set(domains).size !== domains.length ||
      domains.some((domain) => !input.maximumDomains.includes(domain))
    )
      throw new Error("network scope unavailable");
    return Object.freeze([...domains].sort());
  } catch {
    throw new Error("SANDBOX_NETWORK_AUTHORIZATION_UNAVAILABLE");
  }
}
