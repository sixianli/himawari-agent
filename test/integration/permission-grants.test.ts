import {
  PermissionService,
  type ActionIntent,
  type AuthorizationStorePort,
  type PermissionPolicy,
} from "@himawari-agent/application";
import {
  createAgentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import { ManualClock, createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-permission");
const AGENT_ID = createAgentId("agent-permission");
const RUN_ID = createRunId("run-permission");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

const POLICY: PermissionPolicy = {
  version: "permission-policy-v1",
  rules: [
    {
      id: "deny-destructive-account-action",
      effect: "DENY",
      capabilityRefs: ["account-admin"],
      operations: ["delete-account"],
      resourcePrefixes: ["account:"],
      dataClassifications: ["restricted"],
      sideEffects: ["irreversible"],
      maxCostMicros: 0,
      reasonCode: "destructive_account_action_denied",
    },
    {
      id: "allow-readonly-restaurant-search",
      effect: "ALLOW",
      capabilityRefs: ["restaurant-search"],
      operations: ["search"],
      resourcePrefixes: ["city:"],
      dataClassifications: ["public", "private"],
      sideEffects: ["none"],
      maxCostMicros: 10_000,
      reasonCode: "readonly_search_allowed",
    },
  ],
};

function intent(overrides: Partial<ActionIntent> & Pick<ActionIntent, "id">): ActionIntent {
  const { id, ...rest } = overrides;
  return {
    id,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    capabilityRef: "restaurant-reservation",
    operation: "reserve",
    resourceRef: "restaurant:beef-house",
    dataClassification: "private",
    sideEffect: "reversible",
    estimatedCostMicros: 5_000,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: createIdempotencyKey(`intent-${id}`),
    reversible: true,
    requestedAt: T0,
    ...rest,
  };
}

function createService(
  options: { readonly clock?: ManualClock; readonly store?: AuthorizationStorePort } = {},
) {
  const clock = options.clock ?? new ManualClock(T0);
  const adapters = createReferenceAdapterSet({ clock });
  const store = options.store ?? adapters.authorization;
  return {
    adapters,
    clock,
    store,
    service: new PermissionService({ store, clock, ids: adapters.ids, policy: POLICY }),
  };
}

describe("Task 7 deterministic Permission and Grants", () => {
  it.each([
    {
      name: "ALLOW",
      action: intent({
        id: "allow-readonly",
        capabilityRef: "restaurant-search",
        operation: "search",
        resourceRef: "city:tokyo",
        sideEffect: "none",
        estimatedCostMicros: 1_000,
        reversible: true,
      }),
      expected: { decision: "ALLOW", basis: { type: "policy" } },
    },
    {
      name: "ASK",
      action: intent({ id: "ask-reservation" }),
      expected: { decision: "ASK", approvalRequest: { status: "pending" } },
    },
    {
      name: "DENY",
      action: intent({
        id: "deny-account",
        capabilityRef: "account-admin",
        operation: "delete-account",
        resourceRef: "account:owner",
        dataClassification: "restricted",
        sideEffect: "irreversible",
        estimatedCostMicros: 0,
        reversible: false,
      }),
      expected: { decision: "DENY", reasonCode: "destructive_account_action_denied" },
    },
  ])("returns $name from the deterministic decision table", async ({ action, expected }) => {
    const { service } = createService();
    await expect(
      service.evaluate(action, { uiAvailable: true, approvalExpiresAt: T2 }),
    ).resolves.toMatchObject(expected);
  });

  it("freezes the semantic approval snapshot and rejects a changed response hash", async () => {
    const { service } = createService();
    const decision = await service.evaluate(intent({ id: "snapshot" }), {
      uiAvailable: true,
      approvalExpiresAt: T2,
    });
    if (decision.decision !== "ASK") throw new Error("Expected ASK");

    expect(Object.isFrozen(decision.approvalRequest.intentSnapshot)).toBe(true);
    expect(Object.isFrozen(decision.approvalRequest.intentSnapshot.frequency)).toBe(true);
    await expect(
      service.respond({
        approvalRequestId: decision.approvalRequest.id,
        semanticSnapshotHash: "changed-hash",
        decision: "approved",
        grantKind: "one_time",
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  });

  it("consumes a one-time grant once and asks again after its use budget is exhausted", async () => {
    const { service } = createService();
    const action = intent({ id: "one-time" });
    const ask = await service.evaluate(action, { uiAvailable: true, approvalExpiresAt: T2 });
    if (ask.decision !== "ASK") throw new Error("Expected ASK");
    await service.respond({
      approvalRequestId: ask.approvalRequest.id,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      decision: "approved",
      grantKind: "one_time",
    });

    await expect(
      service.evaluate(action, { uiAvailable: true, approvalExpiresAt: T2 }),
    ).resolves.toMatchObject({ decision: "ALLOW", basis: { type: "grant" } });
    await expect(
      service.evaluate(action, { uiAvailable: true, approvalExpiresAt: T2 }),
    ).resolves.toMatchObject({ decision: "ASK" });
  });

  it("enforces long-term scope, expiration, total cost, use budget, and revocation", async () => {
    const { service, clock } = createService();
    const proposed = intent({
      id: "monitor-proposal",
      capabilityRef: "restaurant-monitor",
      estimatedCostMicros: 4_000,
    });
    const ask = await service.evaluate(proposed, { uiAvailable: true, approvalExpiresAt: T1 });
    if (ask.decision !== "ASK") throw new Error("Expected ASK");
    const approval = await service.respond({
      approvalRequestId: ask.approvalRequest.id,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      decision: "approved",
      grantKind: "long_term",
      longTermScope: {
        capabilityRef: "restaurant-monitor",
        operations: ["reserve", "scan"],
        resourcePrefixes: ["restaurant:"],
        maxDataClassification: "private",
        sideEffects: ["none", "reversible"],
        maxCostMicrosPerUse: 4_000,
        maxFrequency: { count: 1, intervalMs: 60_000 },
        maxTotalCostMicros: 8_000,
        maxUses: 2,
        expiresAt: T2,
      },
    });
    if (approval.status !== "approved" || !approval.grantId) {
      throw new Error("Expected approved grant");
    }

    const matching = intent({
      id: "monitor-match-1",
      capabilityRef: "restaurant-monitor",
      operation: "scan",
      estimatedCostMicros: 4_000,
    });
    await expect(
      service.evaluate(matching, { uiAvailable: false, approvalExpiresAt: T2 }),
    ).resolves.toMatchObject({ decision: "ALLOW" });
    await expect(
      service.evaluate(
        intent({ ...matching, id: "monitor-scope-mismatch", resourceRef: "hotel:outside" }),
        { uiAvailable: false, approvalExpiresAt: T2 },
      ),
    ).resolves.toMatchObject({ decision: "ASK" });
    await expect(
      service.evaluate(
        intent({
          ...matching,
          id: "monitor-frequency-mismatch",
          frequency: { count: 2, intervalMs: 1_000 },
        }),
        { uiAvailable: false, approvalExpiresAt: T2 },
      ),
    ).resolves.toMatchObject({ decision: "ASK" });
    await expect(
      service.evaluate(
        intent({ ...matching, id: "monitor-over-cost", estimatedCostMicros: 4_001 }),
        {
          uiAvailable: false,
          approvalExpiresAt: T2,
        },
      ),
    ).resolves.toMatchObject({ decision: "ASK" });
    await expect(
      service.evaluate(intent({ ...matching, id: "monitor-match-2" }), {
        uiAvailable: false,
        approvalExpiresAt: T2,
      }),
    ).resolves.toMatchObject({ decision: "ALLOW" });
    await expect(
      service.evaluate(intent({ ...matching, id: "monitor-budget-exhausted" }), {
        uiAvailable: false,
        approvalExpiresAt: T2,
      }),
    ).resolves.toMatchObject({ decision: "ASK" });

    await service.revokeGrant(approval.grantId, "owner_revoked");
    await expect(
      service.evaluate(intent({ ...matching, id: "monitor-revoked" }), {
        uiAvailable: false,
        approvalExpiresAt: T2,
      }),
    ).resolves.toMatchObject({ decision: "ASK" });

    clock.set(T2);
    await expect(
      service.evaluate(intent({ ...matching, id: "monitor-expired" }), {
        uiAvailable: false,
        approvalExpiresAt: "2026-08-25T00:00:03.000Z",
      }),
    ).resolves.toMatchObject({ decision: "ASK" });
  });

  it("persists no-UI approval waiting and resumes after service reconstruction", async () => {
    const first = createService();
    const action = intent({ id: "durable-wait" });
    const ask = await first.service.evaluate(action, {
      uiAvailable: false,
      approvalExpiresAt: T2,
    });
    if (ask.decision !== "ASK") throw new Error("Expected ASK");
    expect(ask.approvalRequest.deliveryState).toBe("queued_no_ui");

    const resumedService = new PermissionService({
      store: first.store,
      clock: first.clock,
      ids: first.adapters.ids,
      policy: POLICY,
    });
    await expect(resumedService.resume(ask.approvalRequest.id)).resolves.toMatchObject({
      status: "pending",
      deliveryState: "queued_no_ui",
    });
    const duplicate = await resumedService.evaluate(action, {
      uiAvailable: false,
      approvalExpiresAt: T2,
    });
    expect(duplicate).toEqual(ask);

    await resumedService.respond({
      approvalRequestId: ask.approvalRequest.id,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      decision: "denied",
    });
    await expect(resumedService.resume(ask.approvalRequest.id)).resolves.toMatchObject({
      status: "denied",
    });
  });

  it("expires pending approval without turning timeout or retry into ALLOW", async () => {
    const { service, clock } = createService();
    const action = intent({ id: "expires-no-ui" });
    const ask = await service.evaluate(action, { uiAvailable: false, approvalExpiresAt: T1 });
    if (ask.decision !== "ASK") throw new Error("Expected ASK");

    clock.set(T1);
    await expect(service.resume(ask.approvalRequest.id)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(
      service.evaluate(action, {
        uiAvailable: false,
        approvalExpiresAt: "2026-08-25T00:00:03.000Z",
      }),
    ).resolves.toMatchObject({ decision: "DENY", reasonCode: "approval_expired" });
  });

  it("fails closed when authorization state cannot be read", async () => {
    const broken: AuthorizationStorePort = {
      createApproval: async () => {
        throw new Error("unavailable");
      },
      findApprovalByIntent: async () => {
        throw new Error("unavailable");
      },
      getApproval: async () => {
        throw new Error("unavailable");
      },
      resolveApproval: async () => {
        throw new Error("unavailable");
      },
      listGrants: async () => {
        throw new Error("unavailable");
      },
      consumeGrant: async () => {
        throw new Error("unavailable");
      },
      revokeGrant: async () => {
        throw new Error("unavailable");
      },
    };
    const { service } = createService({ store: broken });
    await expect(
      service.evaluate(intent({ id: "fail-closed" }), {
        uiAvailable: true,
        approvalExpiresAt: T2,
      }),
    ).resolves.toMatchObject({
      decision: "DENY",
      reasonCode: "permission_component_error",
    });
  });
});
