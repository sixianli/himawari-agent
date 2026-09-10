import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import { describe, expect, it, vi } from "vitest";
import type {
  GovernedActionIntent,
  GovernedApprovalRequest,
  GrantRecord,
} from "../src/ports/authorization.js";
import { actionIntentFingerprint } from "../src/services/permission-service.js";
import { resolveSandboxNetworkAuthorization } from "../src/services/sandbox-network-authorization.js";

const now = "2026-09-09T00:00:00.000Z";
const end = "2026-09-09T00:01:00.000Z";
function fixture() {
  const ownerId = createOwnerId("owner");
  const agentId = createAgentId("agent");
  const runId = createRunId("run");
  const intent = {
    contractVersion: "authorization.v2",
    id: "intent",
    ownerId,
    agentId,
    runId,
    threadId: "thread",
    capabilityRef: "program",
    capabilityVersion: "1",
    operation: "execute",
    resourceRef: "input",
    resourceRefs: ["input"],
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: "intent" as GovernedActionIntent["idempotencyKey"],
    reversible: true,
    requestedAt: now,
    expiresAt: end,
    targets: [{ type: "network-domain", ref: "example.com:443" }],
    actionKind: "READ",
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    modelClassification: { actionKind: "READ", suggestedRisk: "LOW", reasonCode: "fixture" },
    deterministicFacts: [],
    finalRisk: "LOW",
  } satisfies GovernedActionIntent;
  const hash = actionIntentFingerprint(intent);
  const grant: GrantRecord = {
    id: "grant",
    revision: 1,
    ownerId,
    agentId,
    kind: "one_time",
    scope: {
      capabilityRef: "program",
      operations: ["execute"],
      exactResourceRef: "input",
      resourcePrefixes: [],
      maxDataClassification: "private",
      sideEffects: ["none"],
      maxCostMicrosPerUse: 0,
      maxFrequency: { count: 1, intervalMs: null },
    },
    intentFingerprint: hash,
    sourceApprovalRequestId: "approval",
    validFrom: now,
    expiresAt: end,
    maxUses: 1,
    uses: 1,
    maxTotalCostMicros: 0,
    spentCostMicros: 0,
    revokedAt: null,
    revocationReasonCode: null,
  };
  const approval: GovernedApprovalRequest = {
    id: "approval",
    revision: 1,
    ownerId,
    agentId,
    runId,
    intentId: intent.id,
    intentSnapshot: intent,
    semanticSnapshotHash: hash,
    status: "approved",
    deliveryState: "deliverable",
    requestedAt: now,
    expiresAt: end,
    decidedAt: now,
    grantId: grant.id,
    finalRisk: "LOW",
    recentAuthenticationRequired: false,
    recentAuthenticationRef: null,
  };
  const plan: Parameters<typeof resolveSandboxNetworkAuthorization>[0]["plan"] = {
    identity: { ownerId, agentId, runId, threadId: "thread" },
    authorizationRef: "grant",
    capabilityRef: "program",
    capabilityVersion: "1",
    operation: "execute",
    effectiveDeadlineAt: end,
  };
  const scope: Parameters<typeof resolveSandboxNetworkAuthorization>[0]["scope"] = {
    authorizationRef: "grant",
    networkAuthorizationRef: "grant",
  };
  const authorizations = {
    listGrants: vi.fn(async () => [grant]),
    getApproval: vi.fn(async () => approval),
  };
  return {
    grant,
    approval,
    plan,
    scope,
    authorizations,
    maximumDomains: ["example.com:443", "unapproved.example:443"],
    now: () => now,
  };
}
describe("network scope from the same action Grant", () => {
  it("uses approved exact hosts without granting the larger inventory or consuming again", async () => {
    const input = fixture();
    await expect(resolveSandboxNetworkAuthorization(input)).resolves.toEqual(["example.com:443"]);
    expect(input.grant.uses).toBe(1);
    expect(input.authorizations.listGrants).toHaveBeenCalledWith(
      input.grant.ownerId,
      input.grant.agentId,
    );
  });
  it("keeps a no-network scope offline without using inventory as permission", async () => {
    const input = fixture();
    input.scope = { ...input.scope, networkAuthorizationRef: null };
    await expect(resolveSandboxNetworkAuthorization(input)).resolves.toEqual([]);
    expect(input.authorizations.listGrants).not.toHaveBeenCalled();
  });
  it.each([
    "other-grant",
    "revoked",
    "expired",
    "unapproved",
    "changed-snapshot",
    "changed-disclosure",
    "other-port",
    "other-run",
    "other-operation",
    "outside-inventory",
    "wildcard",
    "missing-domain",
  ])("rejects %s", async (mode) => {
    const input = fixture();
    if (mode === "other-grant") input.scope = { ...input.scope, networkAuthorizationRef: "other" };
    if (mode === "revoked") Object.assign(input.grant, { revokedAt: now });
    if (mode === "expired") input.now = () => end;
    if (mode === "unapproved") Object.assign(input.approval, { status: "pending" });
    if (mode === "changed-snapshot")
      Object.assign(input.approval, {
        intentSnapshot: {
          ...input.approval.intentSnapshot,
          targets: [{ type: "network-domain", ref: "unapproved.example:443" }],
        },
      });
    if (mode === "changed-disclosure")
      Object.assign(input.approval, {
        intentSnapshot: { ...input.approval.intentSnapshot, disclosure: "external" },
      });
    if (mode === "other-port") input.maximumDomains = ["example.com:80"];
    if (mode === "other-run")
      input.plan = { ...input.plan, identity: { ...input.plan.identity, runId: "other" } };
    if (mode === "other-operation") input.plan = { ...input.plan, operation: "write" };
    if (mode === "outside-inventory") input.maximumDomains = [];
    if (mode === "wildcard" || mode === "missing-domain") {
      const intent = {
        ...input.approval.intentSnapshot,
        targets: mode === "wildcard" ? [{ type: "network-domain", ref: "*.example.com" }] : [],
      };
      const hash = actionIntentFingerprint(intent);
      Object.assign(input.approval, { intentSnapshot: intent, semanticSnapshotHash: hash });
      Object.assign(input.grant, { intentFingerprint: hash });
    }
    await expect(resolveSandboxNetworkAuthorization(input)).rejects.toThrow(
      "SANDBOX_NETWORK_AUTHORIZATION_UNAVAILABLE",
    );
  });
});
