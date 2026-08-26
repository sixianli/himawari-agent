import { ExecutionWorkerService } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  createBeefRestaurantFixture,
  createReferenceAdapterSet,
  ScriptedExternalActionReconciliationPort,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import { PRODUCTION_WORKER_ERROR_CODES, ProductionExecutionWorker } from "../src/index.js";

const fixture = createBeefRestaurantFixture();
const deploymentId = "deployment-worker-unit";
const bootTokenRef = "secret-ref-worker-boot-unit";

function scope(fence = 3) {
  return {
    deploymentId,
    authorityEpoch: 2,
    fencingToken: fence,
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    runId: fixture.runs.monitoring.id,
    workerRunId: "worker-run-unit",
  };
}

function requestEnvelope(type: string, fence = 3) {
  return {
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type,
    messageId: `message-${type.replaceAll(".", "-")}-${fence}`,
    correlationId: fixture.correlationId,
    causationId: "worker-delegated-unit",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: scope(fence),
    idempotencyKey: `idempotency-${type.replaceAll(".", "-")}-${fence}`,
  };
}

function handshake(fence = 3): Extract<ExecutionV2Request, { type: "worker.handshake" }> {
  return executionV2MessageSchema.parse({
    ...requestEnvelope("worker.handshake", fence),
    causationId: null,
    scope: { ...scope(fence), ownerId: null, agentId: null, runId: null, workerRunId: null },
    payload: {
      agentServiceInstanceId: "agent-service-worker-unit",
      bootTokenRef,
      supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
      requestedAt: fixture.times.start,
    },
  }) as Extract<ExecutionV2Request, { type: "worker.handshake" }>;
}

function execute(
  overrides: {
    readonly fence?: number;
    readonly messageId?: string;
    readonly idempotencyKey?: string;
    readonly maxProgressEvents?: number;
    readonly handleRef?: string;
  } = {},
): Extract<ExecutionV2Request, { type: "work.execute" }> {
  const fence = overrides.fence ?? 3;
  return executionV2MessageSchema.parse({
    ...requestEnvelope("work.execute", fence),
    ...(overrides.messageId ? { messageId: overrides.messageId } : {}),
    ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    payload: {
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: fixture.payloads.restaurantSearchInput,
      capabilityHandleRef: overrides.handleRef ?? "capability-handle-worker-unit",
      delegatedContextRefs: [],
      secretRefs: [],
      resourceCeiling: {
        maxWallTimeMs: 10_000,
        maxCpuTimeMs: 5_000,
        maxMemoryBytes: 16_777_216,
        maxOutputBytes: 1_024,
        maxProgressEvents: overrides.maxProgressEvents ?? 10,
      },
      requestedAt: fixture.times.start,
      deadlineAt: fixture.times.deadline,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

async function workerFixture(options: { readonly unknownResult?: boolean } = {}) {
  const events = options.unknownResult
    ? [
        {
          type: "capability.result_unknown" as const,
          invocationId: "message-work-execute-3",
          externalActionId: "external-worker-unit",
          occurredAt: fixture.times.providerCompleted,
        },
      ]
    : [
        {
          type: "capability.progress" as const,
          invocationId: "message-work-execute-3",
          sequence: 1,
          stage: "reading",
          progressPermille: 500,
          payloadRef: null,
          occurredAt: fixture.times.start,
        },
        {
          type: "capability.completed" as const,
          invocationId: "message-work-execute-3",
          resultRef: "payload-worker-result-unit",
          occurredAt: fixture.times.providerCompleted,
        },
      ];
  const adapters = createReferenceAdapterSet({
    capability: {
      descriptors: [
        {
          ref: "restaurant-search",
          version: "1.0.0",
          integrity: `sha256:${"a".repeat(64)}`,
          lifecycle: "active",
          permissionRefs: [],
          isolation: "worker",
        },
      ],
      events,
    },
  });
  const declaration = fixture.capabilityDeclarations[0];
  if (!declaration) throw new TypeError("restaurant search declaration fixture is missing");
  await adapters.capabilityRegistry.create({
    ref: "restaurant-search",
    revision: 1,
    lifecycle: "active",
    declaration,
    pendingDeclaration: null,
    permissionExpansion: false,
    approvalRefs: ["approval-worker-unit"],
    discoveredAt: fixture.times.start,
    updatedAt: fixture.times.start,
  });
  await adapters.capabilityRegistry.createExecutionHandle({
    ref: "capability-handle-worker-unit",
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    runId: fixture.runs.monitoring.id,
    capabilityRef: "restaurant-search",
    capabilityVersion: "1.0.0",
    authorization: { type: "policy", ref: "allow-readonly-worker-unit" },
    operations: ["search"],
    inputRefs: [fixture.payloads.restaurantSearchInput],
    delegatedContextRefs: [],
    secretRefs: [],
    maxDataClassification: "private",
    issuedAt: fixture.times.start,
    expiresAt: fixture.times.deadline,
    revokedAt: null,
  });
  const service = new ExecutionWorkerService({
    handles: adapters.capabilityRegistry,
    capability: adapters.capability,
    secrets: adapters.secret,
    reconciliation: new ScriptedExternalActionReconciliationPort({
      "external-worker-unit": {
        outcome: "confirmed_succeeded",
        resultRef: "payload-worker-reconciled-unit",
        errorCode: null,
      },
    }),
    clock: adapters.clock,
    ids: adapters.ids,
  });
  return {
    adapters,
    worker: new ProductionExecutionWorker({
      service,
      workerInstanceId: "execution-worker-unit",
      workerBootId: "worker-boot-unit",
      bootTokenRef,
      deploymentId,
      authorityEpoch: 2,
      fencingToken: 3,
      maximumResourceCeiling: {
        maxWallTimeMs: 30_000,
        maxCpuTimeMs: 10_000,
        maxMemoryBytes: 67_108_864,
        maxOutputBytes: 4_096,
        maxProgressEvents: 100,
      },
      adapters: [
        {
          capabilityId: "restaurant-search",
          capabilityVersion: "1.0.0",
          operations: ["search"],
        },
      ],
      now: () => adapters.clock.now(),
      nextId: (type) => adapters.ids.next(type),
    }),
  };
}

async function readEvents(worker: ProductionExecutionWorker, afterCursor: string | null = null) {
  const events: ExecutionV2Event[] = [];
  for await (const event of worker.events(afterCursor)) events.push(event);
  return events;
}

describe("production execution Worker", () => {
  it("requires a compatible boot-scoped handshake and reports minimal readiness", async () => {
    const { worker } = await workerFixture();
    await expect(worker.request(execute())).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.HANDSHAKE_REQUIRED,
    });
    await expect(worker.request(handshake())).resolves.toMatchObject({
      type: "worker.handshake.accepted",
      payload: {
        workerInstanceId: "execution-worker-unit",
        selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        ready: true,
      },
    });
    const readiness = executionV2MessageSchema.parse({
      ...requestEnvelope("worker.readiness.query"),
      causationId: null,
      scope: { ...scope(), ownerId: null, agentId: null, runId: null, workerRunId: null },
      payload: { requestedAt: fixture.times.start },
    });
    if (readiness.kind !== "request" || readiness.type !== "worker.readiness.query") {
      throw new TypeError("readiness fixture is invalid");
    }
    await expect(worker.request(readiness)).resolves.toMatchObject({
      type: "worker.readiness.snapshot",
      payload: { live: true, ready: true, supportedSchemaVersions: ["execution.v2"] },
    });
  });

  it("executes registered bounded work once and resumes events after a cursor", async () => {
    const { worker } = await workerFixture();
    await worker.request(handshake());
    const request = execute();
    await expect(worker.request(request)).resolves.toBeNull();
    await worker.waitForIdle();
    await expect(worker.request(request)).resolves.toBeNull();
    await worker.waitForIdle();
    const events = await readEvents(worker);
    expect(events.map(({ type }) => type)).toEqual(["work.progress", "work.result"]);
    expect(events[1]).toMatchObject({ payload: { outcome: "succeeded" } });
    const firstPayload = events[0]?.payload;
    if (!firstPayload || !("cursor" in firstPayload)) throw new TypeError("cursor missing");
    await expect(readEvents(worker, firstPayload.cursor)).resolves.toEqual([events[1]]);
  });

  it("rejects stale fences, unregistered adapters and excessive ceilings before invocation", async () => {
    const { worker } = await workerFixture();
    await worker.request(handshake());
    await expect(worker.request(execute({ fence: 2 }))).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.STALE_FENCE,
    });
    const excessive = execute({ maxProgressEvents: 101 });
    await expect(worker.request(excessive)).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED,
    });
    const unregistered = executionV2MessageSchema.parse({
      ...execute({ messageId: "execute-unregistered", idempotencyKey: "execute-unregistered" }),
      payload: { ...execute().payload, capabilityId: "unregistered-adapter" },
    });
    if (unregistered.kind !== "request") throw new TypeError("request fixture is invalid");
    await expect(worker.request(unregistered)).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED,
    });
    expect(await readEvents(worker)).toEqual([]);
  });

  it("turns a stale capability handle into one stable failed result", async () => {
    const { adapters, worker } = await workerFixture();
    await adapters.capabilityRegistry.revokeExecutionHandle(
      "capability-handle-worker-unit",
      fixture.times.start,
    );
    await worker.request(handshake());
    await worker.request(execute());
    await worker.waitForIdle();
    await expect(readEvents(worker)).resolves.toMatchObject([
      { type: "work.result", payload: { outcome: "failed", errorCode: "PORT_HANDLE_REVOKED" } },
    ]);
  });

  it("preserves unknown external results and reconciles them without replaying execution", async () => {
    const { worker } = await workerFixture({ unknownResult: true });
    await worker.request(handshake());
    await worker.request(execute());
    await worker.waitForIdle();
    const unknown = await readEvents(worker);
    expect(unknown).toMatchObject([
      {
        type: "work.result",
        payload: { outcome: "result_unknown", externalActionId: "external-worker-unit" },
      },
    ]);
    const reconcile = executionV2MessageSchema.parse({
      ...requestEnvelope("work.reconcile"),
      messageId: "reconcile-worker-unit",
      idempotencyKey: "reconcile-worker-unit",
      payload: {
        targetRequestId: execute().messageId,
        externalActionId: "external-worker-unit",
        resultLookupRef: "payload-result-lookup-worker-unit",
        requestedAt: fixture.times.start,
      },
    });
    if (reconcile.kind !== "request") throw new TypeError("reconcile fixture is invalid");
    await worker.request(reconcile);
    await worker.waitForIdle();
    const reconciled = await readEvents(worker);
    expect(reconciled.at(-1)).toMatchObject({
      type: "work.reconciled",
      payload: { outcome: "confirmed_succeeded", resultRef: "payload-worker-reconciled-unit" },
    });
    expect(reconciled.filter(({ type }) => type === "work.result")).toHaveLength(1);
  });

  it("emits cancellation and rejects conflicting duplicate identities", async () => {
    const { worker } = await workerFixture();
    await worker.request(handshake());
    const cancel = executionV2MessageSchema.parse({
      ...requestEnvelope("work.cancel"),
      payload: {
        targetRequestId: execute().messageId,
        reasonCode: "owner-requested",
        requestedAt: fixture.times.start,
      },
    });
    if (cancel.kind !== "request") throw new TypeError("cancel fixture is invalid");
    await worker.request(cancel);
    await worker.waitForIdle();
    expect(await readEvents(worker)).toMatchObject([{ type: "work.cancelled" }]);

    const first = execute({ messageId: "duplicate-worker-unit", idempotencyKey: "duplicate-key" });
    await worker.request(first);
    await worker.waitForIdle();
    await expect(
      worker.request(
        execute({ messageId: "duplicate-worker-unit", idempotencyKey: "different-key" }),
      ),
    ).rejects.toMatchObject({ code: PRODUCTION_WORKER_ERROR_CODES.DUPLICATE_CONFLICT });
  });
});
