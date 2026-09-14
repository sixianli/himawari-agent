import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";
import { RuntimeContinuationService, type RuntimeRequest } from "@himawari-agent/application";

const request = {
  ownerId: "owner-continuation",
  agentId: "agent-continuation",
  runId: "run-continuation",
  sessionId: "session-continuation",
  threadId: "thread-continuation",
  modelRef: "model-controlled",
  systemInstructionRef: "system-ref",
  contextEnvelopeRef: "context-ref",
  workerResultRefs: [],
  capabilityHandleRefs: [],
  budget: { cost: 1000 },
  correlationId: "correlation-continuation",
  executionDeadlineAt: "2026-09-07T12:00:00.000Z",
  dataClassification: "private",
  executionLease: Object.freeze({
    executionLeaseId: "lease-first",
    expectedLeaseRevision: 1,
    authorityLeaseId: "authority-lease",
    authorityFencingToken: 1,
    deploymentId: "deployment-continuation",
    authorityEpoch: 1,
    fencingToken: 1,
    consumerId: "first",
  }),
} as unknown as RuntimeRequest;

function fixture() {
  const adapters = createReferenceAdapterSet({
    scope: { ownerId: request.ownerId, agentId: request.agentId },
  });
  const assertActive = vi.fn(async () => {});
  const dependencies = {
    artifacts: adapters.runPayloadArtifacts,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    clock: { now: () => "2026-09-07T10:00:00.000Z" },
    ids: adapters.ids,
    assertActive,
  };
  return { dependencies, assertActive, service: new RuntimeContinuationService(dependencies) };
}

describe("protected runtime continuation boundary", () => {
  it("restores the same task with a new service and execution lease", async () => {
    const f = fixture();
    const snapshot = { tool: "controlled-action", parameters: { recipient: "synthetic" } };
    const ref = await f.service.save(request, snapshot);
    const resumed = {
      ...request,
      continuationRef: ref,
      executionLease: Object.freeze({
        ...request.executionLease,
        consumerId: "second",
        expectedLeaseRevision: 3,
        executionLeaseId: "lease-second" as RuntimeRequest["executionLease"]["executionLeaseId"],
      }),
    };
    expect(await new RuntimeContinuationService(f.dependencies).load(resumed, ref)).toEqual(
      snapshot,
    );
    expect(f.assertActive).toHaveBeenCalledTimes(4);
  });

  it.each([
    "ownerId",
    "agentId",
    "runId",
    "threadId",
    "modelRef",
    "systemInstructionRef",
    "executionDeadlineAt",
  ] as const)("rejects changed %s before returning the snapshot", async (field) => {
    const f = fixture();
    const ref = await f.service.save(request, { privateContent: "synthetic-only" });
    await expect(f.service.load({ ...request, [field]: "changed" }, ref)).rejects.toThrow(
      /RUNTIME_CONTINUATION/,
    );
  });

  it("rejects an authority change and checks cancellation before materializing content", async () => {
    const f = fixture();
    const ref = await f.service.save(request, { privateContent: "synthetic-only" });
    await expect(
      f.service.load(
        {
          ...request,
          executionLease: Object.freeze({ ...request.executionLease, authorityEpoch: 2 }),
        },
        ref,
      ),
    ).rejects.toThrow("RUNTIME_CONTINUATION_CONTEXT_CHANGED");
    const unprotect = vi.spyOn(f.dependencies.protector, "unprotect");
    f.assertActive.mockRejectedValue(new Error("RUN_CANCELLED"));
    await expect(f.service.load(request, ref)).rejects.toThrow("RUN_CANCELLED");
    expect(unprotect).not.toHaveBeenCalled();
  });
});
