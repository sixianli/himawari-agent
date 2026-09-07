import { createHash } from "node:crypto";
import type {
  CapabilityRegistryRecord,
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
  GovernedCapabilityExecutionHandle,
  PayloadRecord,
  RunPayloadArtifact,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";
import type { ExecutionV2Event, ExecutionV2Request } from "@himawari-agent/execution-contracts";
import { createBeefRestaurantFixture, createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";
import {
  ProductionRuntimeTools,
  type ProductionRuntimeToolsOptions,
} from "../src/production-runtime-tools.js";
import { createProductionWorkerParentBindingRegistry } from "../src/production-worker-parent-binding-registry.js";

const identities = createBeefRestaurantFixture();
const deploymentId = createV02Fixture().scope.authority.deploymentId;
const leaseId = createApplicationServiceIdentityFactory().createAuthorityLease({
  ownerId: identities.owner.id,
  agentId: identities.agent.id,
  leaseId: "lease:tools",
  holderId: "holder:tools",
}).id;
const now = "2026-09-06T00:00:00.000Z";
const invocation = {
  runId: identities.runs.recommendation.id,
  toolCallId: "call:tools",
  capabilityRef: "capability:tools",
  capabilityHandleRef: "handle:tools",
  arguments: { inputRef: "input:tools" },
  dataClassification: "private",
} satisfies RuntimeToolInvocation;
function fixture(wallTime = 1000) {
  let handle: GovernedCapabilityExecutionHandle = {
    handleVersion: "capability-handle.v2",
    ref: "handle:tools",
    revision: 1,
    ownerId: identities.owner.id,
    agentId: identities.agent.id,
    runId: invocation.runId,
    authorityFence: 1,
    capabilityRef: invocation.capabilityRef,
    capabilityVersion: "1.0.0",
    authorization: { type: "policy", ref: "policy:tools" },
    authorizationRef: "policy:tools",
    operations: ["read"],
    operation: "read",
    inputRefs: ["input:tools"],
    delegatedContextRefs: [],
    secretRefs: [],
    maxDataClassification: "private",
    maxUses: 2,
    uses: 0,
    maxTotalCostMicros: 0,
    spentCostMicros: 0,
    idempotencyKeys: [],
    issuedAt: now,
    expiresAt: "2026-09-06T01:00:00.000Z",
    revokedAt: null,
    workerEndedAt: null,
  };
  const capability: CapabilityRegistryRecord = {
    ref: invocation.capabilityRef,
    revision: 1,
    lifecycle: "active",
    declaration: {
      ref: invocation.capabilityRef,
      displayName: "test",
      version: "1.0.0",
      source: { type: "builtin", locator: "builtin:test" },
      integrity: "test",
      operations: ["read"],
      permissionRefs: [],
      isolation: "worker",
    },
    pendingDeclaration: null,
    permissionExpansion: false,
    runtimeQualification: null,
    pendingUpdateAssessment: null,
    rollbackDeclaration: null,
    rollbackQualification: null,
    lastVersionTransition: null,
    approvalRefs: [],
    discoveredAt: now,
    updatedAt: now,
  };
  const peer = {
    agentServiceInstanceId: "agent-instance",
    agentServiceBootId: "agent-boot",
    workerInstanceId: "worker-instance",
    workerBootId: "worker-boot",
    deploymentId: deploymentId,
    authorityEpoch: 1,
    fencingToken: 1,
  };
  const authority = {
    ...peer,
    product: { deploymentId: peer.deploymentId, authorityEpoch: 1, fencingToken: 1 },
    lease: { leaseId: leaseId, fencingToken: 1 },
  };
  const payloads = new Map<string, PayloadRecord>();
  const artifacts = new Map<string, RunPayloadArtifact>();
  const registry = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
  let sequence = 0;
  let sent: Extract<ExecutionV2Request, { type: "work.execute" }> | undefined;
  let mode: "success" | "unobserved" | "wrong-scope" | "cancelled" | "hang" | "revoke" = "success";
  const output: PayloadRecord = {
    ref: "output:tools",
    dataClassification: "private",
    contentType: "text/plain",
    ciphertext: new TextEncoder().encode("已读取结果"),
    encryption: { algorithm: "test", keyRef: "test" },
    contentDigest: "output",
    createdAt: now,
  };
  payloads.set(output.ref, output);
  const request = vi.fn(async (message: ExecutionV2Request) => {
    if (message.type === "work.delegate") {
      expect(await registry.reader.lookup(message.causationId ?? "")).toBeDefined();
      return {
        ...message,
        kind: "response" as const,
        type: "work.delegate.accepted" as const,
        messageId: "accepted:tools",
        causationId: message.messageId,
        payload: { handleRef: handle.ref, workerBootId: peer.workerBootId, acceptedAt: now },
      };
    }
    if (message.type === "work.execute") sent = message;
    return null;
  });
  let receipt: FrozenCapabilityInvocationReceipt | undefined;
  const options: ProductionRuntimeToolsOptions = {
    ownerId: handle.ownerId,
    agentId: handle.agentId,
    capabilities: { get: async () => capability, getExecutionHandle: async () => handle },
    invocations: {
      read: async () => receipt,
      consume: vi.fn(async (input: ConsumeCapabilityInvocationInput) => {
        receipt = {
          ...input,
          receiptVersion: "capability-invocation.v1",
          ownerId: handle.ownerId,
          agentId: handle.agentId,
          runId: handle.runId,
          workerRunId: input.requestScope.workerRunId,
          handleRevision: 2,
          authorization: handle.authorization,
          authorizationRef: handle.authorizationRef,
          effectiveExpiresAt: input.deadlineAt,
          semanticFingerprint: "test",
        };
        return { replayed: false, receipt };
      }),
    },
    transport: {
      request,
      async *events() {
        if (mode === "hang") {
          await new Promise(() => {});
          return;
        }
        if (!sent) return;
        if (mode === "revoke") handle = { ...handle, revokedAt: now };
        // Field order is deliberately different from the request scope.
        const scope = {
          workerRunId: sent.scope.workerRunId,
          runId: sent.scope.runId,
          agentId: sent.scope.agentId,
          ownerId: mode === "wrong-scope" ? "intruder" : sent.scope.ownerId,
          fencingToken: 1,
          authorityEpoch: 1,
          deploymentId: peer.deploymentId,
        };
        const envelope = {
          ...sent,
          kind: "event" as const,
          messageId: "result:tools",
          causationId: sent.messageId,
          scope,
        };
        const event: ExecutionV2Event =
          mode === "cancelled"
            ? {
                ...envelope,
                type: "work.cancelled",
                payload: {
                  requestId: sent.messageId,
                  cursor: "1",
                  sequence: 1,
                  cancelledAt: now,
                  reasonCode: "CANCELLED",
                },
              }
            : {
                ...envelope,
                type: "work.result",
                payload: {
                  requestId: sent.messageId,
                  cursor: "1",
                  sequence: 1,
                  completedAt: now,
                  outcome: "succeeded",
                  outputRef: output.ref,
                  errorCode: null,
                  externalActionId: null,
                },
              };
        yield event;
      },
    },
    parents: registry.writer,
    peer: () => peer,
    authority: () => authority,
    assertRunActive: vi.fn(async () => {}),
    results: {
      lookupOutput: async () =>
        mode === "unobserved"
          ? undefined
          : {
              ownerId: handle.ownerId,
              agentId: handle.agentId,
              runId: handle.runId,
              purpose: "worker_result",
              operationKey: "output",
              payloadRef: output.ref,
              contentDigest: output.contentDigest,
              contentType: output.contentType,
              dataClassification: "private",
              createdAt: now,
            },
    },
    artifacts: {
      lookup: async (input) => artifacts.get(input.operationKey),
      commit: async (input) => {
        const existing = artifacts.get(input.operationKey);
        if (existing) return { ref: existing.payloadRef, artifact: existing, replayed: true };
        const artifact: RunPayloadArtifact = {
          ...input,
          ownerId: handle.ownerId,
          agentId: handle.agentId,
          payloadRef: input.payload.ref,
          contentDigest: input.payload.contentDigest,
          contentType: input.payload.contentType,
          dataClassification: input.payload.dataClassification,
          createdAt: now,
        };
        artifacts.set(input.operationKey, artifact);
        payloads.set(input.payload.ref, input.payload);
        return { ref: input.payload.ref, artifact, replayed: false };
      },
    },
    payloads: { get: async (ref) => payloads.get(ref) },
    protector: {
      protect: async (input) => ({
        ...input,
        ciphertext: input.plaintext,
        encryption: { algorithm: "test", keyRef: "test" },
        contentDigest: createHash("sha256").update(input.plaintext).digest("hex"),
      }),
      unprotect: async ({ payload }) => payload.ciphertext,
    },
    ceiling: {
      maxWallTimeMs: wallTime,
      maxCpuTimeMs: 1000,
      maxMemoryBytes: 1000000,
      maxOutputBytes: 1000,
      maxProgressEvents: 10,
    },
    clock: { now: () => now },
    ids: { next: (scope) => `${scope}:${++sequence}` },
  };
  return {
    options,
    request,
    artifacts,
    tool: () => new ProductionRuntimeTools(options),
    setMode(next: typeof mode) {
      mode = next;
    },
    revoke() {
      handle = { ...handle, revokedAt: now };
    },
  };
}
async function exposed(f: ReturnType<typeof fixture>) {
  const tool = f.tool();
  await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  return tool;
}

describe("ProductionRuntimeTools", () => {
  it("offers a path request without a Handle and never dispatches it before authorization exists", async () => {
    const f = fixture();
    const tool = f.tool();
    const descriptors = await tool.listAuthorized(invocation.runId, []);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      name: "read",
      definition: "builtin-read",
      capabilityHandleRef: null,
    });
    const call: RuntimeToolInvocation = {
      ...invocation,
      capabilityRef: "host.file.read",
      capabilityHandleRef: null,
      arguments: { path: "/test/中文.txt", offset: 1, limit: 10 },
    };
    expect(await tool.preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE",
    });
    // Calling execute directly must not bypass preflight.
    await expect(tool.execute(call)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.artifacts.size).toBe(0);
    expect(await f.tool().preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_REQUEST_INVALID",
    });
    expect(
      await tool.preflight({ ...call, capabilityHandleRef: invocation.capabilityHandleRef }),
    ).toMatchObject({
      allowed: false,
      reasonCode: "GOVERNED_HANDLE_INVALID",
    });
  });

  it("does not mistake model-provided approval fields for execution authority", async () => {
    const f = fixture();
    const tool = await exposed(f);
    const call = {
      ...invocation,
      capabilityRef: "host.file.read",
      capabilityHandleRef: null,
      arguments: { path: "/test.txt", approved: true, capabilityHandleRef: "forged" },
    };
    expect(await tool.preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE",
    });
    await expect(tool.execute(call)).rejects.toThrow();
    expect(await tool.preflight({ ...call, capabilityRef: "shell" })).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_REQUEST_INVALID",
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("caps Worker execution at the parent Run deadline and rejects expired calls", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await expect(tool.execute({ ...invocation, executionDeadlineAt: now })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    const deadline = new Date(Date.parse(now) + 500).toISOString();
    expect((await tool.execute({ ...invocation, executionDeadlineAt: deadline })).outcome).toBe(
      "succeeded",
    );
    const execute = f.request.mock.calls.find(([message]) => message.type === "work.execute")?.[0];
    expect(execute).toMatchObject({ type: "work.execute", payload: { deadlineAt: deadline } });
  });

  it("uses the delegated Worker and reads only an observed result; restart replays without dispatch", async () => {
    const f = fixture();
    const tool = await exposed(f);
    expect(await tool.preflight(invocation)).toMatchObject({ allowed: true });
    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      outcome: "succeeded",
      modelContent: "已读取结果",
      resultRef: "output:tools",
    });
    expect(f.request.mock.calls.map(([message]) => message.type)).toEqual([
      "work.delegate",
      "work.execute",
    ]);
    expect(await (await exposed(f)).execute(invocation)).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rejects expanded input, cross-Run and revoked handles without dispatch", async () => {
    const f = fixture();
    const tool = await exposed(f);
    for (const changed of [
      { ...invocation, arguments: { inputRef: "other" } },
      { ...invocation, runId: identities.runs.monitoring.id },
    ]) {
      expect(await tool.preflight(changed)).toMatchObject({ allowed: false });
      await expect(tool.execute(changed)).rejects.toThrow();
    }
    f.revoke();
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("admits at most one dispatch when independent executors race", async () => {
    const f = fixture();
    const first = await exposed(f);
    const second = await exposed(f);
    const results = await Promise.all([first.execute(invocation), second.execute(invocation)]);
    expect(results.some((result) => result.outcome === "succeeded")).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each(["unobserved", "wrong-scope", "hang", "revoke"] as const)(
    "never discloses an untrusted result (%s) or resends uncertain work",
    async (mode) => {
      const f = fixture(25);
      f.setMode(mode);
      const tool = await exposed(f);
      expect(await tool.execute(invocation)).toMatchObject({
        outcome: "result_unknown",
        resultRef: null,
      });
      f.setMode("success");
      if (mode === "revoke") await expect(exposed(f)).rejects.toThrow();
      else
        expect(await (await exposed(f)).execute(invocation)).toMatchObject({
          outcome: "result_unknown",
        });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it("records a cancellation as failed", async () => {
    const f = fixture();
    f.setMode("cancelled");
    expect(await (await exposed(f)).execute(invocation)).toMatchObject({
      outcome: "failed",
      errorCode: "CANCELLED",
    });
  });
  it("denies disclosure of a previously successful result after revocation", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await tool.execute(invocation);
    f.revoke();
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rechecks the live receipt before replaying a saved successful result", async () => {
    const f = fixture();
    const tool = await exposed(f);
    expect((await tool.execute(invocation)).outcome).toBe("succeeded");
    vi.spyOn(f.options.invocations, "read").mockResolvedValue(undefined);
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("does not disclose output when the Handle is revoked during decryption", async () => {
    const f = fixture();
    const tool = await exposed(f);
    const original = f.options.protector.unprotect;
    vi.spyOn(f.options.protector, "unprotect").mockImplementation(async (input) => {
      const bytes = await original(input);
      if (input.payload.ref === "output:tools") f.revoke();
      return bytes;
    });
    expect(await tool.execute(invocation)).toMatchObject({
      outcome: "result_unknown",
      resultRef: null,
    });
  });
  it("rejects reuse of a call identity with changed arguments", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await tool.execute(invocation);
    await expect(tool.execute({ ...invocation, dataClassification: "public" })).rejects.toThrow(
      "Tool call identity changed",
    );
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
