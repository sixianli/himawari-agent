import type { ExecutionTransportPort } from "@himawari-agent/application";
import type {
  ExecutionAdmissionPeerBinding,
  ExecutionV2Event,
  ExecutionV2Request,
  ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import type { ProductionExecutionAdmissionParentBinding } from "../src/production-execution-admission-handler.js";
import {
  PRODUCTION_WORKER_FORWARD_ERROR_CODES,
  ProductionWorkerForwardTransport,
} from "../src/production-worker-forward-transport.js";
import {
  createProductionWorkerParentBindingRegistry,
  PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES,
} from "../src/production-worker-parent-binding-registry.js";

const peer: ExecutionAdmissionPeerBinding = {
  agentServiceInstanceId: "agent-service:worker-forward",
  agentServiceBootId: "agent-boot:worker-forward",
  workerInstanceId: "worker:worker-forward",
  workerBootId: "worker-boot:worker-forward",
  deploymentId: "deployment:worker-forward",
  authorityEpoch: 3,
  fencingToken: 7,
};

const resourceCeiling: ResourceCeiling = {
  maxWallTimeMs: 30_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 268_435_456,
  maxOutputBytes: 1_048_576,
  maxProgressEvents: 100,
};

const parentBinding: ProductionExecutionAdmissionParentBinding = {
  parentMessageId: "execute:worker-forward",
  parentCorrelationId: "correlation:worker-forward",
  bindingRevision: 1,
  bindingDigest: "digest:worker-forward:v1",
  scope: {
    deploymentId: peer.deploymentId,
    authorityEpoch: peer.authorityEpoch,
    fencingToken: peer.fencingToken,
    ownerId: "owner:worker-forward",
    agentId: "agent:worker-forward",
    runId: "run:worker-forward",
    workerRunId: "worker-run:worker-forward",
  },
  authority: peer,
  dataClassification: "private",
  resourceCeiling,
  deadlineAt: "2026-09-05T01:00:00.000Z",
  capabilityHandleRefs: ["handle:worker-forward"],
  delegatedContextRefs: [],
};

const handle = {
  handleVersion: "capability-handle.v2" as const,
  ref: "handle:worker-forward",
  revision: 1,
  authorityFence: peer.fencingToken,
  ownerId: parentBinding.scope.ownerId,
  agentId: parentBinding.scope.agentId,
  runId: parentBinding.scope.runId,
  capabilityRef: "capability:worker-forward",
  capabilityVersion: "1.0.0",
  authorizationType: "policy" as const,
  authorizationRef: "policy:worker-forward",
  operations: ["execute"],
  inputRefs: ["payload:worker-forward"],
  delegatedContextRefs: [],
  secretRefs: [],
  maxDataClassification: "private" as const,
  issuedAt: "2026-09-05T00:00:00.000Z",
  expiresAt: "2026-09-05T01:00:00.000Z",
  revokedAt: null,
  operation: "execute",
  maxUses: 1,
  uses: 0,
  maxTotalCostMicros: 0,
  spentCostMicros: 0,
  idempotencyKeys: [],
  workerEndedAt: null,
};

function delegateMessage(): Extract<ExecutionV2Request, { type: "work.delegate" }> {
  const parsed = executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.delegate",
    messageId: "delegate:worker-forward",
    correlationId: parentBinding.parentCorrelationId,
    causationId: parentBinding.parentMessageId,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: parentBinding.scope,
    idempotencyKey: "idempotency:worker-forward:delegate",
    payload: {
      handle,
      requestedAt: "2026-09-05T00:00:00.000Z",
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "work.delegate") {
    throw new TypeError("worker forward delegate fixture is invalid");
  }
  return parsed;
}

function executeMessage(): Extract<ExecutionV2Request, { type: "work.execute" }> {
  const parsed = executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: parentBinding.parentMessageId,
    correlationId: parentBinding.parentCorrelationId,
    causationId: parentBinding.parentMessageId,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: parentBinding.scope,
    idempotencyKey: "idempotency:worker-forward:execute",
    payload: {
      capabilityId: "capability:worker-forward",
      capabilityVersion: "1.0.0",
      operation: "execute",
      inputRef: "payload:worker-forward",
      capabilityHandleRef: "handle:worker-forward",
      delegatedContextRefs: [],
      secretRefs: [],
      resourceCeiling,
      requestedAt: "2026-09-05T00:00:00.000Z",
      deadlineAt: "2026-09-05T01:00:00.000Z",
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "work.execute") {
    throw new TypeError("worker forward execute fixture is invalid");
  }
  return parsed;
}

function registryFixture() {
  const registry = createProductionWorkerParentBindingRegistry({
    trustedPeerBinding: () => peer,
  });
  return registry;
}

function emptyEvents(): AsyncIterable<ExecutionV2Event> {
  return (async function* () {})();
}

describe("ProductionWorkerForwardTransport", () => {
  it("registers the complete parent before the first delegate and execute send", async () => {
    const registry = registryFixture();
    const observed: Array<{
      readonly type: string;
      readonly binding: ProductionExecutionAdmissionParentBinding | undefined;
    }> = [];
    const transport: ExecutionTransportPort = {
      request: async (message) => {
        observed.push({
          type: message.type,
          binding: await registry.reader.lookup(parentBinding.parentMessageId),
        });
        return null;
      },
      events: () => emptyEvents(),
    };
    const delegate = delegateMessage();
    const execute = executeMessage();
    expect(delegate.causationId).toBe(execute.messageId);
    expect(execute.messageId).toBe(parentBinding.parentMessageId);
    const forward = new ProductionWorkerForwardTransport({
      transport,
      parentBindingWriter: registry.writer,
      parentBindingFor: () => parentBinding,
    });

    await forward.request(delegate);
    await forward.request(execute);

    expect(observed.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
    expect(observed.map(({ binding }) => binding)).toEqual([parentBinding, parentBinding]);
  });

  it("rejects delegate identity mismatches before registry write or send", async () => {
    const mismatches: readonly ProductionExecutionAdmissionParentBinding[] = [
      { ...parentBinding, parentMessageId: "parent:wrong" },
      { ...parentBinding, parentCorrelationId: "correlation:wrong" },
      {
        ...parentBinding,
        scope: { ...parentBinding.scope, runId: "run:wrong" },
      },
      { ...parentBinding, dataClassification: "sensitive" },
      { ...parentBinding, capabilityHandleRefs: [] },
      {
        ...parentBinding,
        capabilityHandleRefs: [...parentBinding.capabilityHandleRefs, "handle:extra"],
      },
      { ...parentBinding, delegatedContextRefs: ["context:extra"] },
      { ...parentBinding, deadlineAt: "2026-09-05T02:00:00.000Z" },
    ];

    for (const mismatch of mismatches) {
      const registry = registryFixture();
      let sendCalls = 0;
      const transport: ExecutionTransportPort = {
        request: async () => {
          sendCalls += 1;
          return null;
        },
        events: () => emptyEvents(),
      };
      const forward = new ProductionWorkerForwardTransport({
        transport,
        parentBindingWriter: registry.writer,
        parentBindingFor: () => mismatch,
      });

      await expect(forward.request(delegateMessage())).rejects.toMatchObject({
        code: PRODUCTION_WORKER_FORWARD_ERROR_CODES.BINDING_MESSAGE_MISMATCH,
      });
      expect(sendCalls).toBe(0);
      expect(await registry.reader.lookup(parentBinding.parentMessageId)).toBeUndefined();
    }
  });

  it("rejects execute identity and resource mismatches before registry write or send", async () => {
    const mismatches: readonly ProductionExecutionAdmissionParentBinding[] = [
      { ...parentBinding, parentMessageId: "parent:wrong" },
      { ...parentBinding, parentCorrelationId: "correlation:wrong" },
      {
        ...parentBinding,
        scope: { ...parentBinding.scope, workerRunId: "worker-run:wrong" },
      },
      { ...parentBinding, dataClassification: "sensitive" },
      {
        ...parentBinding,
        resourceCeiling: { ...parentBinding.resourceCeiling, maxOutputBytes: 2_097_152 },
      },
      { ...parentBinding, deadlineAt: "2026-09-05T02:00:00.000Z" },
      { ...parentBinding, capabilityHandleRefs: [] },
      {
        ...parentBinding,
        capabilityHandleRefs: [...parentBinding.capabilityHandleRefs, "handle:extra"],
      },
      { ...parentBinding, delegatedContextRefs: ["context:extra"] },
    ];

    for (const mismatch of mismatches) {
      const registry = registryFixture();
      let sendCalls = 0;
      const transport: ExecutionTransportPort = {
        request: async () => {
          sendCalls += 1;
          return null;
        },
        events: () => emptyEvents(),
      };
      const forward = new ProductionWorkerForwardTransport({
        transport,
        parentBindingWriter: registry.writer,
        parentBindingFor: () => mismatch,
      });

      await expect(forward.request(executeMessage())).rejects.toMatchObject({
        code: PRODUCTION_WORKER_FORWARD_ERROR_CODES.BINDING_MESSAGE_MISMATCH,
      });
      expect(sendCalls).toBe(0);
      expect(await registry.reader.lookup(parentBinding.parentMessageId)).toBeUndefined();
    }
  });

  it("keeps the binding and performs no automatic retry after an unknown send", async () => {
    const registry = registryFixture();
    let sendCalls = 0;
    const transport: ExecutionTransportPort = {
      request: async () => {
        sendCalls += 1;
        throw new Error("private transport detail");
      },
      events: () => emptyEvents(),
    };
    const forward = new ProductionWorkerForwardTransport({
      transport,
      parentBindingWriter: registry.writer,
      parentBindingFor: () => parentBinding,
    });

    await expect(forward.request(executeMessage())).rejects.toThrow("private transport detail");
    expect(sendCalls).toBe(1);
    expect(await registry.reader.lookup(parentBinding.parentMessageId)).toEqual(parentBinding);
  });

  it("rejects a changed identity on manual retry without resending", async () => {
    const registry = registryFixture();
    let currentBinding = parentBinding;
    let sendCalls = 0;
    const transport: ExecutionTransportPort = {
      request: async () => {
        sendCalls += 1;
        throw new Error("send outcome unknown");
      },
      events: () => emptyEvents(),
    };
    const forward = new ProductionWorkerForwardTransport({
      transport,
      parentBindingWriter: registry.writer,
      parentBindingFor: () => currentBinding,
    });

    await expect(forward.request(executeMessage())).rejects.toThrow("send outcome unknown");
    currentBinding = {
      ...parentBinding,
      bindingDigest: "digest:worker-forward:v2",
    };
    await expect(forward.request(executeMessage())).rejects.toMatchObject({
      code: PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.IDENTITY_CONFLICT,
    });
    expect(sendCalls).toBe(1);
    expect(await registry.reader.lookup(parentBinding.parentMessageId)).toEqual(parentBinding);
  });
});
