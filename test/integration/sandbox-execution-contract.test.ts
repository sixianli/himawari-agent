import { createHash } from "node:crypto";
import type {
  FrozenCapabilityInvocationReceipt,
  RuntimeRequest,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { createSandboxExecutionPlan } from "@himawari-agent/application";
import {
  type SandboxJobReceipt,
  sandboxExecutionPlanSchema,
  sandboxJobReceiptSchema,
  validateSandboxJobObservation,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const request = {
    ownerId: "owner",
    agentId: "agent",
    runId: "run",
    threadId: "thread",
    modelRef: "model",
    executionDeadlineAt: "2026-09-07T00:01:00.000Z",
    executionLease: {
      executionLeaseId: "execution",
      expectedLeaseRevision: 1,
      authorityLeaseId: "lease",
      authorityFencingToken: 1,
      deploymentId: "deployment",
      authorityEpoch: 1,
      fencingToken: 1,
      consumerId: "consumer",
    },
  } as RuntimeRequest;
  const invocation: RuntimeToolInvocation = {
    runId: request.runId,
    toolCallId: "call",
    capabilityRef: "host.file.read",
    capabilityHandleRef: "handle",
    arguments: { inputRef: "input" },
    dataClassification: "private",
    executionDeadlineAt: request.executionDeadlineAt,
    context: {
      threadId: request.threadId,
      modelRef: request.modelRef,
      executionLease: request.executionLease,
    },
  } as RuntimeToolInvocation;
  const invocationId = `runtime-tool:${digest(JSON.stringify([request.runId, invocation.toolCallId]))}`;
  const receipt = {
    receiptVersion: "capability-invocation.v1",
    receiptRef: "receipt",
    ownerId: request.ownerId,
    agentId: request.agentId,
    runId: request.runId,
    handleRef: "handle",
    handleRevision: 2,
    invocationId,
    idempotencyKey: invocationId,
    workerRunId: "worker-run",
    capabilityRef: "host.file.read",
    capabilityVersion: "1",
    operation: "read",
    inputRef: "input",
    authorizationRef: "authorization",
    semanticFingerprint: `sha256:${digest("frozen")}`,
    deadlineAt: "2026-09-07T00:02:00.000Z",
    effectiveExpiresAt: "2026-09-07T00:00:30.000Z",
    authority: {
      product: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
      lease: { leaseId: "lease", fencingToken: 1 },
    },
    resourceCeiling: {
      maxWallTimeMs: 60_000,
      maxCpuTimeMs: 10_000,
      maxMemoryBytes: 1024,
      maxOutputBytes: 1024,
      maxProgressEvents: 10,
    },
  } as FrozenCapabilityInvocationReceipt;
  return {
    request,
    invocation,
    receipt,
    jobId: "job",
    attemptId: "attempt",
    hostId: "mac",
    now: "2026-09-07T00:00:00.000Z",
    digest,
    binding: {
      scopeRef: "scope",
      scopeDigest: digest("scope"),
      profileRef: "host-readonly.v1",
      runtimeDigest: digest("runtime"),
      runnerDigest: digest("runner"),
      qualificationRef: "qualification",
      requiredGuarantees: ["bounded-output"],
    },
  };
}

function observation(): SandboxJobReceipt {
  return {
    schemaVersion: "sandbox-execution.v1",
    identity: createSandboxExecutionPlan(fixture()).identity,
    sequence: 1,
    state: "prepared",
    policyDigest: digest("policy"),
    occurredAt: "2026-09-07T00:00:00.000Z",
    outcome: "pending",
    cleanup: "pending",
    effect: "not_started",
    outputRef: null,
    outputDigest: null,
    reasonCode: null,
  };
}

describe("sandbox execution authority projection", () => {
  it("freezes a detached identity and narrows deadlines/ceilings from the existing receipt", () => {
    const input = fixture();
    const plan = createSandboxExecutionPlan(input);
    expect(plan.identity.toolCallId).toBe("call");
    expect(plan.effectiveDeadlineAt).toBe("2026-09-07T00:00:30.000Z");
    expect(plan.resourceCeiling.maxWallTimeMs).toBe(30_000);
    input.binding.requiredGuarantees.push("later");
    expect(plan.binding.requiredGuarantees).toEqual(["bounded-output"]);
    expect(Object.isFrozen(plan.identity)).toBe(true);
    expect(Object.isFrozen(plan.executionLease)).toBe(true);
  });
  it.each(["ownerId", "agentId", "runId"] as const)("rejects a receipt from another %s", (key) => {
    const input = fixture();
    expect(() =>
      createSandboxExecutionPlan({ ...input, receipt: { ...input.receipt, [key]: "other" } }),
    ).toThrow("SCOPE_MISMATCH");
  });
  it("rejects receipt substitution between tool calls and protected inputs", () => {
    const input = fixture();
    expect(() =>
      createSandboxExecutionPlan({
        ...input,
        invocation: { ...input.invocation, toolCallId: "other" },
      }),
    ).toThrow("INVOCATION_MISMATCH");
    expect(() =>
      createSandboxExecutionPlan({
        ...input,
        invocation: { ...input.invocation, arguments: { inputRef: "other" } },
      }),
    ).toThrow("INVOCATION_MISMATCH");
  });
  it("rejects a stale execution lease, mismatched thread/model and expired execution", () => {
    const input = fixture();
    const context = input.invocation.context;
    if (!context) throw new Error("missing fixture context");
    for (const override of [{ threadId: "other" }, { modelRef: "other" }]) {
      expect(() =>
        createSandboxExecutionPlan({
          ...input,
          invocation: {
            ...input.invocation,
            context: { ...context, ...override },
          } as RuntimeToolInvocation,
        }),
      ).toThrow("SCOPE_MISMATCH");
    }
    expect(() =>
      createSandboxExecutionPlan({
        ...input,
        invocation: {
          ...input.invocation,
          context: {
            ...context,
            executionLease: { ...context.executionLease, expectedLeaseRevision: 2 },
          },
        },
      }),
    ).toThrow("LEASE_MISMATCH");
    expect(() => createSandboxExecutionPlan({ ...input, now: "2026-09-07T00:00:30.000Z" })).toThrow(
      "EXPIRED",
    );
    expect(() =>
      createSandboxExecutionPlan({
        ...input,
        receipt: {
          ...input.receipt,
          authority: {
            ...input.receipt.authority,
            product: { ...input.receipt.authority.product, fencingToken: 2 },
          },
        },
      }),
    ).toThrow("AUTHORITY_MISMATCH");
  });
  it("rejects raw policy/credential fields instead of forwarding unknown data", () => {
    const plan = createSandboxExecutionPlan(fixture());
    expect(() => sandboxExecutionPlanSchema.parse({ ...plan, env: { TOKEN: "dummy" } })).toThrow(
      "unknown field",
    );
    expect(() =>
      sandboxExecutionPlanSchema.parse({ ...plan, binding: { ...plan.binding, allowAll: true } }),
    ).toThrow("unknown field");
  });
});

describe("sandbox job observation invariants", () => {
  it("requires matching identity, monotonic observations and confirmed cleanup before completion", () => {
    const plan = createSandboxExecutionPlan(fixture());
    let receipt = validateSandboxJobObservation(plan, observation());
    for (const state of ["starting", "running", "stopping"] as const) {
      receipt = validateSandboxJobObservation(
        plan,
        { ...receipt, sequence: receipt.sequence + 1, state },
        receipt,
      );
    }
    expect(() =>
      validateSandboxJobObservation(
        plan,
        { ...receipt, sequence: 5, state: "completed", outcome: "succeeded", effect: "confirmed" },
        receipt,
      ),
    ).toThrow("cleanup");
    const completed = validateSandboxJobObservation(
      plan,
      {
        ...receipt,
        sequence: 5,
        state: "completed",
        outcome: "succeeded",
        effect: "confirmed",
        cleanup: "confirmed",
        outputRef: "output",
        outputDigest: digest("output"),
      },
      receipt,
    );
    expect(() =>
      validateSandboxJobObservation(
        plan,
        { ...observation(), state: "starting", sequence: 6 },
        completed,
      ),
    ).toThrow("transition");
    expect(() =>
      validateSandboxJobObservation(plan, {
        ...observation(),
        identity: { ...plan.identity, toolCallId: "other" },
      }),
    ).toThrow("identity mismatch");
  });
  it("routes unknown effects to reconciliation and never back to execution", () => {
    const plan = createSandboxExecutionPlan(fixture());
    const prepared = validateSandboxJobObservation(plan, observation());
    const unknown = validateSandboxJobObservation(
      plan,
      {
        ...prepared,
        sequence: 2,
        state: "reconciling",
        outcome: "unknown",
        effect: "unknown",
        reasonCode: "worker_lost",
      },
      prepared,
    );
    expect(() =>
      validateSandboxJobObservation(plan, { ...unknown, sequence: 3, state: "starting" }, unknown),
    ).toThrow("transition");
    const quarantine = validateSandboxJobObservation(
      plan,
      { ...unknown, sequence: 3, state: "quarantined", cleanup: "unknown" },
      unknown,
    );
    expect(quarantine.state).toBe("quarantined");
    expect(() =>
      sandboxJobReceiptSchema.parse({
        ...unknown,
        state: "failed",
        outcome: "failed",
        cleanup: "confirmed",
      }),
    ).toThrow("effect");
  });
  it("rejects changed policy, observation replay and incomplete payload metadata", () => {
    const plan = createSandboxExecutionPlan(fixture());
    const first = observation();
    expect(() =>
      validateSandboxJobObservation(
        plan,
        { ...first, sequence: 2, state: "starting", policyDigest: digest("other") },
        first,
      ),
    ).toThrow("transition");
    expect(() => validateSandboxJobObservation(plan, first, first)).toThrow("transition");
    expect(() => sandboxJobReceiptSchema.parse({ ...first, outputRef: "output" })).toThrow(
      "paired",
    );
    expect(() =>
      sandboxJobReceiptSchema.parse({
        ...first,
        state: "completed",
        outcome: "succeeded",
        cleanup: "confirmed",
        effect: "confirmed",
      }),
    ).toThrow("success");
    expect(() =>
      validateSandboxJobObservation(plan, { ...first, occurredAt: "2026-09-06T23:59:59.000Z" }),
    ).toThrow("predates");
  });
});
