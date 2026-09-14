import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";

const now = "2026-09-07T00:00:00.000Z";
export const envelope = {
  schemaVersion: "gateway.v2",
  kind: "snapshot",
  messageId: "snapshot",
  correlationId: "correlation",
  causationId: null,
  dataClassification: "private",
  risk: "high",
  authorizationRef: null,
  scope: { ownerId: "owner", agentId: "agent" },
  authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
  actor: { actorType: "system", actorId: "system" },
} as const;
export function collection(itemRefs: string[], nextCursor: string | null): GatewayV2Snapshot {
  return {
    ...envelope,
    type: "collection.snapshot",
    payload: {
      category: "approvals",
      itemRefs,
      nextCursor,
      snapshotRef: "collection",
      generatedAt: now,
    },
  };
}
export function approval(
  id: string,
  runId: string,
  status: "pending" | "approved",
): Extract<GatewayV2Snapshot, { type: "approval.snapshot" }> {
  return {
    ...envelope,
    type: "approval.snapshot",
    payload: {
      approvalRequestId: id,
      revision: 1,
      status,
      deliveryState: "deliverable",
      semanticSnapshotHash: "hash",
      finalRisk: "high",
      recentAuthenticationRequired: false,
      recentAuthenticationRef: null,
      requestedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: null,
      grantId: null,
      trueResultRef: null,
      generatedAt: now,
      intent: {
        intentId: id,
        threadId: "thread",
        runId,
        actionKind: "COMMUNICATE",
        capabilityRef: "test.send",
        capabilityVersion: "1",
        operation: "send",
        targetRefs: ["target"],
        resourceRefs: ["target"],
        dataClassification: "private",
        disclosure: "named_recipients",
        recipientRefs: ["target"],
        sideEffect: "irreversible",
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        credentialOrAccessChange: false,
        reversible: false,
        idempotencyKey: id,
        deterministicFactCodes: [],
        modelReasonCode: "controlled",
        requestedAt: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  };
}
