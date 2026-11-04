import type { DelegatedCapabilityHandleV2 } from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { WorkerDelegationStore } from "../src/worker-delegation-store.ts";

const NOW = "2026-11-04T00:00:00.000Z";
const store = () =>
  new WorkerDelegationStore({
    authorityFence: 3,
    adapters: [
      {
        capabilityId: "restaurant-search",
        capabilityVersion: "1.0.0",
        operations: ["search", "details"],
      },
    ],
    now: () => NOW,
  });

function handle(overrides: Partial<DelegatedCapabilityHandleV2> = {}): DelegatedCapabilityHandleV2 {
  return {
    handleVersion: "capability-handle.v2",
    ref: "capability-handle-unit",
    revision: 1,
    authorityFence: 3,
    ownerId: "owner-unit",
    agentId: "agent-unit",
    runId: "run-unit",
    capabilityRef: "restaurant-search",
    capabilityVersion: "1.0.0",
    authorizationType: "policy",
    authorizationRef: "allow-unit",
    operations: ["search"],
    inputRefs: [],
    delegatedContextRefs: [],
    secretRefs: [],
    maxDataClassification: "private",
    issuedAt: "2026-11-03T23:00:00.000Z",
    expiresAt: "2026-11-04T01:00:00.000Z",
    revokedAt: null,
    operation: "search",
    maxUses: 1,
    uses: 0,
    maxTotalCostMicros: 0,
    spentCostMicros: 0,
    idempotencyKeys: [],
    workerEndedAt: null,
    ...overrides,
  } as DelegatedCapabilityHandleV2;
}

describe("Worker delegation admission", () => {
  it.each([[["search"]], [["search", "details"]]])(
    "admits a delegation whose operations %j the Worker adapter declares",
    (operations) => {
      expect(store().accept(handle({ operations })).operations).toEqual(operations);
    },
  );

  it.each([[["search", "book-table"]], [["search", "search"]]])(
    "refuses a delegation whose operations %j reach beyond the Worker adapter",
    (operations) => {
      expect(() => store().accept(handle({ operations }))).toThrow(
        "does not match a registered Worker adapter",
      );
    },
  );
});
