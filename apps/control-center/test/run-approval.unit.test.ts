import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { expect, it, vi } from "vitest";
import { findPendingRunApproval } from "../src/run-approval.js";

const configuration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf",
};
const now = "2026-09-07T00:00:00.000Z";
const envelope = {
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
function collection(itemRefs: string[], nextCursor: string | null): GatewayV2Snapshot {
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
function approval(id: string, runId: string, status: "pending" | "approved"): GatewayV2Snapshot {
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
it("finds the current Run across pages and skips another Run or a stale decision", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce(collection(["other", "stale"], "page-2"))
    .mockResolvedValueOnce(approval("other", "another-run", "pending"))
    .mockResolvedValueOnce(approval("stale", "target-run", "approved"))
    .mockResolvedValueOnce(collection(["target"], null))
    .mockResolvedValueOnce(approval("target", "target-run", "pending"));
  expect(await findPendingRunApproval({ query }, configuration, "target-run")).toBe("target");
  expect(query.mock.calls[3]?.[0]).toMatchObject({
    type: "approval.list",
    payload: { afterCursor: "page-2" },
  });
});
it("stops on a repeated pagination cursor", async () => {
  const query = vi.fn().mockResolvedValue(collection([], "same-page"));
  await expect(findPendingRunApproval({ query }, configuration, "target-run")).rejects.toThrow(
    "APPROVAL_CURSOR_REPEATED",
  );
  expect(query).toHaveBeenCalledTimes(2);
});
it("returns no pending approval when the collection is empty", async () => {
  const query = vi.fn().mockResolvedValue(collection([], null));
  expect(await findPendingRunApproval({ query }, configuration, "target-run")).toBeNull();
});
