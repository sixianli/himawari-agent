import { PORT_ERROR_CODES } from "@himawari-agent/application";
import {
  agentRuntimePortConformance,
  attentionPortConformance,
  auditLedgerPortConformance,
  authorityLeasePortConformance,
  capabilityPortConformance,
  clockPortConformance,
  idGeneratorPortConformance,
  memoryPortConformance,
  modelPortConformance,
  payloadStorePortConformance,
  reliableEventPortConformance,
  schedulerPortConformance,
  secretPortConformance,
  stateStorePortConformance,
  traceStorePortConformance,
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
traceStorePortConformance({ create: () => createReferenceAdapterSet().trace });
payloadStorePortConformance({ create: () => createReferenceAdapterSet().payload });
auditLedgerPortConformance({ create: () => createReferenceAdapterSet().audit });
memoryPortConformance({ create: () => createReferenceAdapterSet().memory });
modelPortConformance({
  create: (model) => createReferenceAdapterSet({ model }).model,
});
agentRuntimePortConformance({
  create: (runtime) => createReferenceAdapterSet({ runtime }).runtime,
});
capabilityPortConformance({
  create: (capability) => createReferenceAdapterSet({ capability }).capability,
});
secretPortConformance({ create: () => createReferenceAdapterSet().secret });
schedulerPortConformance({ create: () => createReferenceAdapterSet().scheduler });
attentionPortConformance({
  create: (attention) => createReferenceAdapterSet({ attention }).attention,
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
