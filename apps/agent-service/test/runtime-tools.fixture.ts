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
import { expect, vi } from "vitest";
import {
  ProductionRuntimeTools,
  type ProductionRuntimeToolsOptions,
} from "../src/production-runtime-tools.js";
import { createProductionWorkerParentBindingRegistry } from "../src/production-worker-parent-binding-registry.js";

export const identities = createBeefRestaurantFixture();
const deploymentId = createV02Fixture().scope.authority.deploymentId;
const leaseId = createApplicationServiceIdentityFactory().createAuthorityLease({
  ownerId: identities.owner.id,
  agentId: identities.agent.id,
  leaseId: "lease:tools",
  holderId: "holder:tools",
}).id;
export const now = "2026-09-06T00:00:00.000Z";
export const invocation = {
  runId: identities.runs.recommendation.id,
  toolCallId: "call:tools",
  capabilityRef: "capability:tools",
  capabilityHandleRef: "handle:tools",
  arguments: { inputRef: "input:tools" },
  dataClassification: "private",
} satisfies RuntimeToolInvocation;
export function runtimeToolFixture(wallTime = 1000) {
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
  let onExecute:
    | ((request: Extract<ExecutionV2Request, { type: "work.execute" }>) => Promise<string>)
    | undefined;
  let executionError: string | null = null;
  let output: PayloadRecord = {
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
        payload: {
          handleRef: message.payload.handle.ref,
          workerBootId: peer.workerBootId,
          acceptedAt: now,
        },
      };
    }
    if (message.type === "work.execute") {
      sent = message;
      if (onExecute) {
        output = {
          ...output,
          ref: `output:${message.messageId}`,
          ciphertext: new TextEncoder().encode(
            await onExecute(message).catch((error: unknown) => {
              executionError = error instanceof Error ? error.message : "WORKER_FAILURE";
              return "";
            }),
          ),
        };
        payloads.set(output.ref, output);
        outputs.set(message.messageId, output);
      }
    }
    return null;
  });
  const outputs = new Map<string, PayloadRecord>();
  const receipts = new Map<string, FrozenCapabilityInvocationReceipt>();
  const options: ProductionRuntimeToolsOptions = {
    ownerId: handle.ownerId,
    agentId: handle.agentId,
    capabilities: { get: async () => capability, getExecutionHandle: async () => handle },
    invocations: {
      read: async ({ invocationId }) => receipts.get(invocationId),
      consume: vi.fn(async (input: ConsumeCapabilityInvocationInput) => {
        const receipt: FrozenCapabilityInvocationReceipt = {
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
        receipts.set(input.invocationId, receipt);
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
                  outcome: executionError ? "failed" : "succeeded",
                  outputRef: executionError ? null : output.ref,
                  errorCode: executionError,
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
      lookupOutput: async ({ invocationId }) => {
        const observed = outputs.get(invocationId) ?? output;
        return mode === "unobserved"
          ? undefined
          : {
              ownerId: handle.ownerId,
              agentId: handle.agentId,
              runId: handle.runId,
              purpose: "worker_result",
              operationKey: "output",
              payloadRef: observed.ref,
              contentDigest: observed.contentDigest,
              contentType: observed.contentType,
              dataClassification: "private",
              createdAt: now,
            };
      },
    },
    artifacts: {
      lookup: async (input) => artifacts.get(input.operationKey),
      commit: async (input) => {
        const existing = artifacts.get(input.operationKey);
        if (existing) {
          if (
            existing.contentDigest !== input.payload.contentDigest ||
            existing.contentType !== input.payload.contentType ||
            existing.dataClassification !== input.payload.dataClassification
          ) {
            throw new Error(
              "Run Payload artifact operation identity conflicts with its existing receipt",
            );
          }
          return { ref: existing.payloadRef, artifact: existing, replayed: true };
        }
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
    payloads,
    capability,
    setExecutor(execute: NonNullable<typeof onExecute>) {
      onExecute = execute;
    },
    tool: () => new ProductionRuntimeTools(options),
    setMode(next: typeof mode) {
      mode = next;
    },
    revoke() {
      handle = { ...handle, revokedAt: now };
    },
  };
}
