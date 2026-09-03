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
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_WORKER_ERROR_CODES,
  ProductionExecutionWorker,
  WorkerDelegationStore,
  type WorkerSubtaskExecutionContext,
} from "../src/index.js";

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

function delegation() {
  return executionV2MessageSchema.parse({
    ...requestEnvelope("work.delegate"),
    authorizationRef: "allow-readonly-worker-unit",
    payload: {
      handle: {
        handleVersion: "capability-handle.v2",
        ref: "capability-handle-worker-unit",
        revision: 1,
        authorityFence: 3,
        ownerId: fixture.owner.id,
        agentId: fixture.agent.id,
        runId: fixture.runs.monitoring.id,
        capabilityRef: "restaurant-search",
        capabilityVersion: "1.0.0",
        authorizationType: "policy",
        authorizationRef: "allow-readonly-worker-unit",
        operations: ["search"],
        inputRefs: [fixture.payloads.restaurantSearchInput],
        delegatedContextRefs: [],
        secretRefs: [],
        maxDataClassification: "private",
        issuedAt: fixture.times.start,
        expiresAt: fixture.times.deadline,
        revokedAt: null,
        operation: "search",
        maxUses: 1,
        uses: 0,
        maxTotalCostMicros: 0,
        spentCostMicros: 0,
        idempotencyKeys: [],
        workerEndedAt: null,
      },
      requestedAt: fixture.times.start,
    },
  }) as Extract<ExecutionV2Request, { type: "work.delegate" }>;
}

async function workerFixture(
  options: {
    readonly unknownResult?: boolean;
    readonly now?: () => string;
    readonly hostOperations?: ConstructorParameters<
      typeof ProductionExecutionWorker
    >[0]["hostOperations"];
  } = {},
) {
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
    runtimeQualification: null,
    pendingUpdateAssessment: null,
    rollbackDeclaration: null,
    rollbackQualification: null,
    lastVersionTransition: null,
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
      ...(options.hostOperations ? { hostOperations: options.hostOperations } : {}),
      now: options.now ?? (() => adapters.clock.now()),
      nextId: (type) => adapters.ids.next(type),
    }),
  };
}

async function readEvents(worker: ProductionExecutionWorker, afterCursor: string | null = null) {
  const events: ExecutionV2Event[] = [];
  for await (const event of worker.events(afterCursor)) events.push(event);
  return events;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("production execution Worker", () => {
  it("admits a boot-scoped one-use delegation without opening durable state", async () => {
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
        events: [
          {
            type: "capability.completed",
            invocationId: "message-work-execute-3",
            resultRef: "payload-worker-result-unit",
            occurredAt: fixture.times.providerCompleted,
          },
        ],
      },
    });
    const registered = [
      {
        capabilityId: "restaurant-search",
        capabilityVersion: "1.0.0",
        operations: ["search"],
      },
    ];
    const delegations = new WorkerDelegationStore({
      authorityFence: 3,
      adapters: registered,
      now: () => adapters.clock.now(),
    });
    const service = new ExecutionWorkerService({
      handles: delegations,
      capability: adapters.capability,
      secrets: adapters.secret,
      clock: adapters.clock,
      ids: adapters.ids,
      authorityFence: () => 3,
      authorization: adapters.authorization,
    });
    const worker = new ProductionExecutionWorker({
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
      adapters: registered,
      delegations,
      now: () => adapters.clock.now(),
      nextId: (type) => adapters.ids.next(type),
    });

    await worker.request(handshake());
    await expect(worker.request(execute())).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.DELEGATION_REQUIRED,
    });
    await expect(worker.request(delegation())).resolves.toMatchObject({
      type: "work.delegate.accepted",
      payload: { handleRef: "capability-handle-worker-unit" },
    });
    await expect(worker.request(execute())).resolves.toBeNull();
    await worker.waitForIdle();
    await expect(readEvents(worker)).resolves.toContainEqual(
      expect.objectContaining({
        type: "work.result",
        payload: expect.objectContaining({ outcome: "succeeded" }),
      }),
    );
  });

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

  it("routes registered host operations and fails closed when no host adapter exists", async () => {
    const absent = await workerFixture();
    await absent.worker.request(handshake());
    const request = executionV2MessageSchema.parse({
      ...requestEnvelope("host.operation.execute"),
      messageId: "host-operation-unit",
      idempotencyKey: "host-operation-unit",
      risk: "high",
      authorizationRef: "authorization-host-unit",
      payload: {
        operation: "workspace.snapshot",
        hostId: "host-unit",
        grantRef: null,
        workspaceRef: "workspace-unit",
        frozenPlanRef: "workspace-plan-unit",
        expectedRevision: 1,
        canonicalHash: `sha256:${"a".repeat(64)}`,
        inputPayloadRefs: [],
        secretRefs: [],
        recentAuthenticationRef: null,
        requestedAt: fixture.times.start,
        deadlineAt: fixture.times.deadline,
      },
    });
    if (request.kind !== "request" || request.type !== "host.operation.execute")
      throw new TypeError("host request fixture is invalid");
    await expect(absent.worker.request(request)).rejects.toMatchObject({
      code: PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED,
    });

    const registered = await workerFixture({
      hostOperations: {
        operations: ["workspace.snapshot"],
        execute: async () => ({
          outcome: "succeeded",
          outputRef: "payload-host-snapshot-unit",
          errorCode: null,
          fileObservationRefs: ["file-observation-unit"],
          networkObservationRefs: [],
        }),
      },
    });
    await registered.worker.request(handshake());
    await registered.worker.request(request);
    await registered.worker.waitForIdle();
    expect(await readEvents(registered.worker)).toContainEqual(
      expect.objectContaining({
        type: "host.operation.result",
        payload: expect.objectContaining({ outcome: "succeeded" }),
      }),
    );
    let expiredCalls = 0;
    const expired = await workerFixture({
      now: () => fixture.times.deadline,
      hostOperations: {
        operations: ["workspace.snapshot"],
        execute: async () => {
          expiredCalls += 1;
          return {
            outcome: "succeeded",
            outputRef: "payload-expired-operation",
            errorCode: null,
            fileObservationRefs: [],
            networkObservationRefs: [],
          };
        },
      },
    });
    await expired.worker.request(handshake());
    await expect(expired.worker.request(request)).rejects.toMatchObject({
      code: "WORKER_DEADLINE_EXPIRED",
    });
    expect(expiredCalls).toBe(0);
  });

  it("runs a frozen Worker subtask with only delegated Handles and rejects model expansion", async () => {
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
        events: [],
      },
    });
    let now = adapters.clock.now();
    let capabilityCalls = 0;
    let adapterCalls = 0;
    const registered = [
      { capabilityId: "restaurant-search", capabilityVersion: "1.0.0", operations: ["search"] },
    ];
    const delegations = new WorkerDelegationStore({
      authorityFence: 3,
      adapters: registered,
      now: () => now,
    });
    const service = new ExecutionWorkerService({
      handles: delegations,
      capability: {
        list: () => adapters.capability.list(),
        cancel: (id, reason) => adapters.capability.cancel(id, reason),
        async *invoke(input) {
          capabilityCalls += 1;
          yield* adapters.capability.invoke(input);
        },
      },
      secrets: adapters.secret,
      clock: { now: () => now },
      ids: adapters.ids,
      authorityFence: () => 3,
      authorization: adapters.authorization,
    });
    let completedContext: WorkerSubtaskExecutionContext | undefined;
    let waitForCancellation = false;
    let cancelledContext: WorkerSubtaskExecutionContext | undefined;
    const cancellationStarted = deferred();
    const tool = {
      invocationId: "search-once",
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: fixture.payloads.restaurantSearchInput,
      capabilityHandleRef: "capability-handle-worker-unit",
      delegatedContextRefs: [],
    };
    const worker = new ProductionExecutionWorker({
      service,
      workerInstanceId: "execution-worker-subtask-unit",
      workerBootId: "worker-boot-subtask-unit",
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
      adapters: registered,
      delegations,
      subtasks: {
        allowedModelRefs: ["model-worker-unit"],
        maximumCostMicros: 1000,
        maximumDurationMs: 30_000,
        execute: async (_request, context) => {
          adapterCalls += 1;
          if (waitForCancellation) {
            cancelledContext = context;
            cancellationStarted.resolve();
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            return {
              workerResultRef: "payload:cancelled-result",
              actualModelRef: "model-worker-unit",
              actualCostMicros: 0,
              durationMs: 0,
            };
          }
          expect(await delegations.getExecutionHandle(tool.capabilityHandleRef)).toMatchObject({
            uses: 0,
          });
          await expect(
            collect(
              context.executeCapability({
                ...tool,
                invocationId: "invalid-operation",
                operation: "outside-operation",
              }),
            ),
          ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
          const concurrent = await Promise.allSettled([
            collect(context.executeCapability(tool)),
            collect(context.executeCapability(tool)),
          ]);
          expect(concurrent.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
          await expect(
            collect(context.executeCapability({ ...tool, inputRef: "payload:changed" })),
          ).rejects.toMatchObject({ code: "WORKER_DUPLICATE_CONFLICT" });
          expect(capabilityCalls).toBe(1);
          expect(await delegations.getExecutionHandle(tool.capabilityHandleRef)).toMatchObject({
            uses: 1,
          });
          completedContext = context;
          return {
            workerResultRef: "payload-worker-subtask-result-unit",
            actualModelRef: "model-worker-unit",
            actualCostMicros: 100,
            durationMs: 500,
          };
        },
      },
      now: () => now,
      nextId: (type) => adapters.ids.next(type),
    });
    await worker.request(handshake());
    await worker.request(delegation());
    const subtask = executionV2MessageSchema.parse({
      ...requestEnvelope("worker.subtask.execute"),
      messageId: "worker-subtask-unit",
      idempotencyKey: "delegation-unit",
      payload: {
        delegationId: "delegation-unit",
        subtaskRef: "payload-subtask-unit",
        outputSchemaRef: "payload-output-schema-unit",
        delegatedContextRefs: [],
        capabilityHandleRefs: ["capability-handle-worker-unit"],
        allowedModelRefs: ["model-worker-unit"],
        selectedModelRef: "model-worker-unit",
        maximumCostMicros: 1000,
        maximumDurationMs: 30_000,
        maximumProgressEvents: 10,
        depth: 1,
        requestedAt: fixture.times.start,
        deadlineAt: fixture.times.deadline,
      },
    });
    if (subtask.kind !== "request" || subtask.type !== "worker.subtask.execute")
      throw new TypeError("subtask fixture is invalid");
    await expect(
      worker.request({
        ...subtask,
        messageId: "wrong-agent-subtask",
        idempotencyKey: "wrong-agent-subtask",
        scope: { ...subtask.scope, agentId: "other-agent-unit" },
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    const replayReadStarted = deferred();
    const releaseReplayRead = deferred();
    const getHandle = delegations.getExecutionHandle.bind(delegations);
    let admissionReads = 0;
    const replayRead = vi
      .spyOn(delegations, "getExecutionHandle")
      .mockImplementation(async (ref) => {
        admissionReads += 1;
        if (admissionReads === 2) {
          replayReadStarted.resolve();
          await releaseReplayRead.promise;
        }
        return getHandle(ref);
      });
    const originalRequest = worker.request(subtask);
    const concurrentReplay = worker.request(subtask);
    await replayReadStarted.promise;
    await originalRequest;
    await worker.waitForIdle();
    releaseReplayRead.resolve();
    await expect(concurrentReplay).resolves.toBeNull();
    replayRead.mockRestore();
    expect(adapterCalls).toBe(1);
    expect(await readEvents(worker)).toContainEqual(
      expect.objectContaining({
        type: "worker.subtask.result",
        payload: expect.objectContaining({
          outcome: "succeeded",
          actualModelRef: "model-worker-unit",
        }),
      }),
    );
    if (!completedContext) throw new Error("Subtask context was not exposed to the adapter");
    await expect(collect(completedContext.executeCapability(tool))).rejects.toMatchObject({
      code: "WORKER_SUBTASK_NOT_ACTIVE",
    });
    await expect(worker.request(subtask)).resolves.toBeNull();
    await expect(
      worker.request({
        ...subtask,
        messageId: "consumed-subtask",
        idempotencyKey: "consumed-subtask",
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    for (const invalidState of ["revoked", "expired"] as const) {
      const source = delegation();
      const handleRef = `handle-${invalidState}-subtask`;
      await worker.request({
        ...source,
        messageId: `delegate-${invalidState}`,
        idempotencyKey: `delegate-${invalidState}`,
        payload: {
          ...source.payload,
          handle: {
            ...source.payload.handle,
            ref: handleRef,
            expiresAt:
              invalidState === "expired"
                ? new Date(Date.parse(now) + 1_000).toISOString()
                : fixture.times.deadline,
          },
        },
      });
      if (invalidState === "revoked") await delegations.revokeExecutionHandle(handleRef, now);
      else now = new Date(Date.parse(now) + 1_000).toISOString();
      await expect(
        worker.request({
          ...subtask,
          messageId: `subtask-${invalidState}`,
          idempotencyKey: `subtask-${invalidState}`,
          payload: { ...subtask.payload, capabilityHandleRefs: [handleRef] },
        }),
      ).rejects.toMatchObject({ code: "PORT_HANDLE_REVOKED" });
    }
    const expanded = {
      ...subtask,
      messageId: "worker-subtask-expanded-unit",
      idempotencyKey: "delegation-expanded-unit",
      payload: {
        ...subtask.payload,
        allowedModelRefs: ["model-worker-unit", "model-expensive-unit"],
        selectedModelRef: "model-expensive-unit",
      },
    };
    expect(() => executionV2MessageSchema.parse(expanded)).not.toThrow();
    await expect(
      worker.request(
        executionV2MessageSchema.parse(expanded) as Extract<
          ExecutionV2Request,
          { type: "worker.subtask.execute" }
        >,
      ),
    ).rejects.toMatchObject({ code: PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED });
    waitForCancellation = true;
    const source = delegation();
    const handleRef = "handle-cancellable-subtask";
    await worker.request({
      ...source,
      messageId: "delegate-cancellable",
      idempotencyKey: "delegate-cancellable",
      payload: { ...source.payload, handle: { ...source.payload.handle, ref: handleRef } },
    });
    const cancellable = {
      ...subtask,
      messageId: "cancellable-subtask",
      idempotencyKey: "cancellable-subtask",
      payload: { ...subtask.payload, capabilityHandleRefs: [handleRef] },
    };
    await worker.request(cancellable);
    await cancellationStarted.promise;
    await worker.request(
      executionV2MessageSchema.parse({
        ...requestEnvelope("work.cancel"),
        messageId: "cancel-subtask",
        idempotencyKey: "cancel-subtask",
        payload: {
          targetRequestId: cancellable.messageId,
          reasonCode: "OWNER_CANCELLED",
          requestedAt: now,
        },
      }) as Extract<ExecutionV2Request, { type: "work.cancel" }>,
    );
    await worker.waitForIdle();
    if (!cancelledContext) throw new Error("No cancellable context");
    await expect(
      collect(cancelledContext.executeCapability({ ...tool, capabilityHandleRef: handleRef })),
    ).rejects.toMatchObject({ code: "WORKER_SUBTASK_NOT_ACTIVE" });
    expect(
      (await readEvents(worker)).filter(
        (event) =>
          event.type === "worker.subtask.result" &&
          event.payload.requestId === cancellable.messageId,
      ),
    ).toMatchObject([{ payload: { outcome: "cancelled" } }]);
    expect(capabilityCalls).toBe(1);
    const admissionStarted = deferred();
    const releaseAdmission = deferred();
    const validate = service.assertSubtaskDelegation.bind(service);
    vi.spyOn(service, "assertSubtaskDelegation").mockImplementation(async (input) => {
      admissionStarted.resolve();
      await releaseAdmission.promise;
      return validate(input);
    });
    const pendingRequest = worker.request({
      ...subtask,
      messageId: "shutdown-subtask",
      idempotencyKey: "shutdown-subtask",
      payload: { ...subtask.payload, capabilityHandleRefs: [] },
    });
    await admissionStarted.promise;
    const callsBeforeShutdown = adapterCalls;
    await worker.shutdown();
    releaseAdmission.resolve();
    await expect(pendingRequest).rejects.toMatchObject({ code: "WORKER_NOT_READY" });
    expect(adapterCalls).toBe(callsBeforeShutdown);
  });
});
