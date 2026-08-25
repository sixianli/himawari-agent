import { PORT_ERROR_CODES } from "@himawari-agent/application";
import {
  createAgent,
  createAgentAuthorityLease,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createOwner,
} from "@himawari-agent/domain";
import {
  agentRuntimePortConformance,
  attentionPortConformance,
  attentionStatePortConformance,
  auditLedgerPortConformance,
  authorizationStorePortConformance,
  authorityLeasePortConformance,
  capabilityPortConformance,
  capabilityRegistryStorePortConformance,
  clockPortConformance,
  deliveryPortConformance,
  idGeneratorPortConformance,
  memoryPortConformance,
  modelPortConformance,
  payloadStorePortConformance,
  productStateRepositoryPortConformance,
  reliableEventPortConformance,
  reliableEventSinkPortConformance,
  runtimeToolPortConformance,
  schedulerPortConformance,
  secretPortConformance,
  stateStorePortConformance,
  traceStorePortConformance,
  workerRunPortConformance,
} from "@himawari-agent/testing/conformance";
import {
  DeterministicFailureScheduler,
  DeterministicIdGenerator,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

stateStorePortConformance({ create: () => createReferenceAdapterSet().state });
reliableEventPortConformance({ create: () => createReferenceAdapterSet().reliableEvents });
productStateRepositoryPortConformance({
  create: async ({ ownerId, agentId }) => {
    const adapters = createReferenceAdapterSet();
    const owner = createOwner(ownerId);
    const agent = createAgent({ id: agentId, owner });
    const lease = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-product-state-conformance"),
      agent,
      holderId: createAuthorityHolderId("holder-product-state-conformance"),
    });
    const authority = await adapters.authority.claim(lease, 60_000);
    return {
      repository: adapters.productState,
      authority: { leaseId: lease.id, fencingToken: authority.fencingToken },
    };
  },
});
reliableEventSinkPortConformance({ create: () => createReferenceAdapterSet().eventSink });
traceStorePortConformance({ create: () => createReferenceAdapterSet().trace });
payloadStorePortConformance({ create: () => createReferenceAdapterSet().payload });
auditLedgerPortConformance({ create: () => createReferenceAdapterSet().audit });
authorizationStorePortConformance({ create: () => createReferenceAdapterSet().authorization });
memoryPortConformance({ create: () => createReferenceAdapterSet().memory });
modelPortConformance({
  create: (model) => createReferenceAdapterSet({ model }).model,
});
agentRuntimePortConformance({
  create: (runtime) => createReferenceAdapterSet({ runtime }).runtime,
});
runtimeToolPortConformance({
  create: (runtimeTools) => createReferenceAdapterSet({ runtimeTools }).runtimeTools,
});
workerRunPortConformance({
  create: (workers) => createReferenceAdapterSet({ workers }).workers,
});
capabilityPortConformance({
  create: (capability) => createReferenceAdapterSet({ capability }).capability,
});
capabilityRegistryStorePortConformance({
  create: () => createReferenceAdapterSet().capabilityRegistry,
});
secretPortConformance({ create: () => createReferenceAdapterSet().secret });
schedulerPortConformance({ create: () => createReferenceAdapterSet().scheduler });
attentionPortConformance({
  create: (attention) => createReferenceAdapterSet({ attention }).attention,
});
attentionStatePortConformance({ create: () => createReferenceAdapterSet().attentionState });
deliveryPortConformance({
  create: (delivery) => createReferenceAdapterSet({ delivery }).delivery,
});
authorityLeasePortConformance({
  create: (clock) => createReferenceAdapterSet({ clock }).authority,
});
clockPortConformance({ create: () => createReferenceAdapterSet().clock });
idGeneratorPortConformance({ create: () => createReferenceAdapterSet().ids });

describe("deterministic reference controls", () => {
  it("advances injected time only when directed", () => {
    const clock = new ManualClock("2026-08-25T00:00:00.000Z");
    clock.advance(1250);
    expect(clock.now()).toBe("2026-08-25T00:00:01.250Z");
  });

  it("generates reproducible namespace-local identifiers", () => {
    const ids = new DeterministicIdGenerator();
    expect([ids.next("run"), ids.next("run"), ids.next("event")]).toEqual([
      "run-0001",
      "run-0002",
      "event-0001",
    ]);
  });

  it("injects a scheduled pre-write failure and permits a clean retry", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("state.compareAndSet", 1);
    const state = createReferenceAdapterSet({ failures }).state;

    await expect(
      state.compareAndSet({ key: "run:failure", expectedRevision: null, value: { status: "new" } }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INJECTED_FAILURE });
    expect(await state.read("run:failure")).toBeUndefined();
    await expect(
      state.compareAndSet({ key: "run:failure", expectedRevision: null, value: { status: "new" } }),
    ).resolves.toMatchObject({ revision: 1 });
    expect(failures.attemptsAt("state.compareAndSet")).toBe(2);
  });
});
