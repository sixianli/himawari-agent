import { RuntimeContinuationService, type RuntimeRequest } from "@himawari-agent/application";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";

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

  it("keeps a known-result delivery binding out of the original task scope", async () => {
    const f = fixture();
    const snapshot = { waitingToolCallId: "original-call" };
    const ref = await f.service.save(request, snapshot);
    const resumed = {
      ...request,
      continuationRef: ref,
      knownToolResult: {
        capabilityRef: "original-capability",
        continuationRef: ref,
        toolCallId: "original-call",
        jobId: "original-job",
        invocationId: "original-invocation",
      },
    };
    expect(await f.service.load(resumed, ref)).toEqual(snapshot);
    await expect(f.service.load({ ...resumed, modelRef: "changed" }, ref)).rejects.toThrow(
      "RUNTIME_CONTINUATION_CONTEXT_CHANGED",
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

it("requires explicit queue proof for a changed authority and preserves every semantic input", async () => {
  const f = fixture();
  const snapshot = { originalBatch: true };
  const ref = await f.service.save(request, snapshot);
  const authorizeAuthorityChange = vi.fn(async () => true);
  const resumed = {
    ...request,
    continuationRef: ref,
    executionLease: Object.freeze({
      ...request.executionLease,
      fencingToken: 2,
      authorityFencingToken: 2,
    }),
  };
  const service = new RuntimeContinuationService({ ...f.dependencies, authorizeAuthorityChange });
  expect(await service.load(resumed, ref)).toEqual(snapshot);
  expect(authorizeAuthorityChange).toHaveBeenCalledWith(resumed, ref, {
    deploymentId: request.executionLease.deploymentId,
    authorityEpoch: 1,
    fencingToken: 1,
  });
  for (const mutation of [
    { budget: { cost: 2000 } },
    { capabilityHandleRefs: ["another-handle"] },
    { contextEnvelopeRef: "another-context" },
    { modelRef: "another-model" },
    { executionDeadlineAt: "2026-09-07T13:00:00.000Z" },
  ]) {
    await expect(service.load({ ...resumed, ...mutation }, ref)).rejects.toThrow(
      "RUNTIME_CONTINUATION_CONTEXT_CHANGED",
    );
  }
  expect(authorizeAuthorityChange).toHaveBeenCalledTimes(1);
  authorizeAuthorityChange.mockResolvedValue(false);
  await expect(service.load(resumed, ref)).rejects.toThrow("RUNTIME_CONTINUATION_CONTEXT_CHANGED");
});
