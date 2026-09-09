import {
  type SandboxExecutionPlanCandidate,
  type SandboxScope,
  sandboxNetworkDomainSchema,
} from "@himawari-agent/execution-contracts";
import type { AuthorizationStorePort } from "../ports/authorization.js";
import { resolveSandboxActionGrant } from "./sandbox-action-grant.js";

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
    const { intent } = await resolveSandboxActionGrant(input);
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
