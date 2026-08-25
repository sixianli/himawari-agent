import {
  CapabilityRegistryService,
  ExecutionWorkerService,
  PORT_ERROR_CODES,
  type CapabilityDeclaration,
  type PermissionAllowDecision,
} from "@himawari-agent/application";
import {
  EXECUTION_SCHEMA_VERSION,
  type ExecuteWorkRequest,
  executionMessageSchema,
} from "@himawari-agent/execution-contracts";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  DeterministicRestaurantCapabilityPort,
  InMemoryCapabilityRegistryStore,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-capability");
const AGENT_ID = createAgentId("agent-capability");
const RUN_ID = createRunId("run-capability");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const SEARCH_DECLARATION: CapabilityDeclaration = {
  ref: "restaurant-search",
  displayName: "Restaurant Search",
  version: "1.0.0",
  source: { type: "builtin", locator: "builtin:restaurant-search" },
  integrity: HASH_A,
  operations: ["search"],
  permissionRefs: ["network:maps.test", "secret:map-provider"],
  isolation: "worker",
};

const RESERVATION_DECLARATION: CapabilityDeclaration = {
  ref: "restaurant-reservation",
  displayName: "Restaurant Reservation",
  version: "1.0.0",
  source: { type: "builtin", locator: "builtin:restaurant-reservation" },
  integrity: HASH_A,
  operations: ["reserve"],
  permissionRefs: ["network:booking.test", "secret:booking-provider"],
  isolation: "worker",
};

function permission(capabilityRef: string, operation: string): PermissionAllowDecision {
  return {
    decision: "ALLOW",
    basis: { type: "grant", ref: `grant-${capabilityRef}` },
    executionScope: {
      capabilityRef,
      operations: [operation],
      exactResourceRef: null,
      resourcePrefixes: ["restaurant:"],
      maxDataClassification: "private",
      sideEffects: ["none", "reversible"],
      maxCostMicrosPerUse: 10_000,
      maxFrequency: { count: 1, intervalMs: null },
    },
  };
}

function executeRequest(overrides: Partial<ExecuteWorkRequest> = {}): ExecuteWorkRequest {
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: "execution-request-search",
    correlationId: "correlation-capability",
    causationId: "trace-capability-intent",
    dataClassification: "private",
    scope: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run-capability",
    },
    idempotencyKey: "execute-capability",
    payload: {
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: "payload-search-input",
      capabilityHandleRef: "placeholder-handle",
      delegatedContextRefs: ["payload-search-context"],
      secretRefs: [
        {
          secretRef: "map-provider",
          secretVersion: "v1",
          purpose: "restaurant-search",
        },
      ],
      requestedAt: T0,
      deadlineAt: T2,
    },
    ...overrides,
  };
}

async function collect<TValue>(source: AsyncIterable<TValue>): Promise<readonly TValue[]> {
  const values: TValue[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function install(
  registry: CapabilityRegistryService,
  declaration: CapabilityDeclaration,
): Promise<void> {
  await registry.discover(declaration);
  await registry.proposeInstallation(declaration.ref);
  await registry.approveInstallation(declaration.ref, `approval-install-${declaration.ref}`);
  await registry.activate(declaration.ref);
}

describe("Task 8 Capability Registry and execution isolation", () => {
  it("moves through discovery, install approval, activation, update approval, disable, and uninstall", async () => {
    const clock = new ManualClock(T0);
    const store = new InMemoryCapabilityRegistryStore();
    const registry = new CapabilityRegistryService({
      store,
      clock,
      ids: createReferenceAdapterSet().ids,
    });

    await expect(registry.discover(SEARCH_DECLARATION)).resolves.toMatchObject({
      lifecycle: "discovered",
    });
    await expect(registry.proposeInstallation(SEARCH_DECLARATION.ref)).resolves.toMatchObject({
      lifecycle: "installation_proposed",
    });
    await expect(
      registry.approveInstallation(SEARCH_DECLARATION.ref, "approval-install-search"),
    ).resolves.toMatchObject({ lifecycle: "installation_approved" });
    await expect(registry.activate(SEARCH_DECLARATION.ref)).resolves.toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.0.0", integrity: HASH_A },
    });

    const expanded = {
      ...SEARCH_DECLARATION,
      version: "1.1.0",
      integrity: HASH_B,
      operations: ["search", "review"],
      permissionRefs: [...SEARCH_DECLARATION.permissionRefs, "network:reviews.test"],
    };
    await expect(registry.proposeUpdate(SEARCH_DECLARATION.ref, expanded)).resolves.toMatchObject({
      lifecycle: "update_proposed",
      permissionExpansion: true,
      pendingDeclaration: { version: "1.1.0", integrity: HASH_B },
    });
    await expect(registry.activate(SEARCH_DECLARATION.ref)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INVALID_OPERATION,
    });
    await registry.approveUpdate(SEARCH_DECLARATION.ref, "approval-update-search");
    await expect(registry.activate(SEARCH_DECLARATION.ref)).resolves.toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.1.0", operations: ["search", "review"] },
      pendingDeclaration: null,
    });
    await expect(registry.disable(SEARCH_DECLARATION.ref)).resolves.toMatchObject({
      lifecycle: "disabled",
    });
    await expect(registry.uninstall(SEARCH_DECLARATION.ref)).resolves.toMatchObject({
      lifecycle: "uninstalled",
    });
  });

  it.each([
    { ...SEARCH_DECLARATION, version: "latest" },
    { ...SEARCH_DECLARATION, integrity: "sha256:not-a-digest" },
    { ...SEARCH_DECLARATION, version: "1.0.0", integrity: HASH_A, operations: [] },
  ])("rejects unpinned or unverifiable executable declarations", async (declaration) => {
    const registry = new CapabilityRegistryService({
      store: new InMemoryCapabilityRegistryStore(),
      clock: new ManualClock(T0),
      ids: createReferenceAdapterSet().ids,
    });
    await expect(registry.discover(declaration)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INVALID_OPERATION,
    });
  });

  it("keeps declarations, Grants, and short-lived execution handles separate", async () => {
    const clock = new ManualClock(T0);
    const store = new InMemoryCapabilityRegistryStore();
    const registry = new CapabilityRegistryService({
      store,
      clock,
      ids: createReferenceAdapterSet().ids,
    });
    await install(registry, SEARCH_DECLARATION);
    const handle = await registry.issueExecutionHandle({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: SEARCH_DECLARATION.ref,
      operation: "search",
      permission: permission(SEARCH_DECLARATION.ref, "search"),
      inputRefs: ["payload-search-input"],
      delegatedContextRefs: ["payload-search-context"],
      secretRefs: [
        { secretRef: "map-provider", secretVersion: "v1", purpose: "restaurant-search" },
      ],
      expiresAt: T1,
    });

    expect(handle).toMatchObject({
      capabilityRef: SEARCH_DECLARATION.ref,
      capabilityVersion: "1.0.0",
      authorization: { type: "grant", ref: "grant-restaurant-search" },
      expiresAt: T1,
      revokedAt: null,
    });
    expect(JSON.stringify(handle)).not.toContain("maxTotalCostMicros");
    expect(await store.getExecutionHandle(handle.ref)).toEqual(handle);

    clock.set(T1);
    await expect(registry.requireUsableExecutionHandle(handle.ref)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.HANDLE_REVOKED,
    });
  });

  it.each([
    { capability: SEARCH_DECLARATION, operation: "search", resultRef: "restaurant-search-result" },
    {
      capability: RESERVATION_DECLARATION,
      operation: "reserve",
      resultRef: "restaurant-reservation-result",
    },
  ])(
    "maps deterministic $operation progress and result events",
    async ({ capability, operation, resultRef }) => {
      const clock = new ManualClock(T0);
      const adapters = createReferenceAdapterSet({ clock });
      const store = new InMemoryCapabilityRegistryStore();
      const registry = new CapabilityRegistryService({ store, clock, ids: adapters.ids });
      await install(registry, capability);
      const secretRef = operation === "search" ? "map-provider" : "booking-provider";
      const inputRef = `payload-${operation}-input`;
      const contextRef = `payload-${operation}-context`;
      const handle = await registry.issueExecutionHandle({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        capabilityRef: capability.ref,
        operation,
        permission: permission(capability.ref, operation),
        inputRefs: [inputRef],
        delegatedContextRefs: [contextRef],
        secretRefs: [{ secretRef, secretVersion: "v1", purpose: `restaurant-${operation}` }],
        expiresAt: T2,
      });
      const capabilityPort = new DeterministicRestaurantCapabilityPort(T0, T1);
      const worker = new ExecutionWorkerService({
        handles: store,
        capability: capabilityPort,
        secrets: adapters.secret,
        clock,
        ids: adapters.ids,
      });
      const base = executeRequest();
      const request = executeRequest({
        messageId: `execution-request-${operation}`,
        payload: {
          ...base.payload,
          capabilityId: capability.ref,
          capabilityVersion: capability.version,
          operation,
          inputRef,
          capabilityHandleRef: handle.ref,
          delegatedContextRefs: [contextRef],
          secretRefs: [{ secretRef, secretVersion: "v1", purpose: `restaurant-${operation}` }],
        },
      });

      const events = await collect(worker.execute(request));
      for (const event of events) expect(() => executionMessageSchema.parse(event)).not.toThrow();
      expect(events.map(({ type }) => type)).toEqual(["work.progress", "work.result"]);
      expect(events[1]).toMatchObject({
        type: "work.result",
        payload: { outcome: "succeeded", outputRef: expect.stringContaining(resultRef) },
      });
      expect(capabilityPort.observedInvocations()).toMatchObject([
        {
          capabilityRef: capability.ref,
          operation,
          inputRef,
          delegatedContextRefs: [contextRef],
          secretHandleRefs: [expect.stringMatching(/^secret-handle-/)],
        },
      ]);
    },
  );

  it("maps cancellation and deadline expiry without executing after either boundary", async () => {
    const clock = new ManualClock(T0);
    const adapters = createReferenceAdapterSet({ clock });
    const store = new InMemoryCapabilityRegistryStore();
    const registry = new CapabilityRegistryService({ store, clock, ids: adapters.ids });
    await install(registry, SEARCH_DECLARATION);
    const handle = await registry.issueExecutionHandle({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: SEARCH_DECLARATION.ref,
      operation: "search",
      permission: permission(SEARCH_DECLARATION.ref, "search"),
      inputRefs: ["payload-search-input"],
      delegatedContextRefs: ["payload-search-context"],
      secretRefs: [],
      expiresAt: T2,
    });
    const capability = new DeterministicRestaurantCapabilityPort(T0, T1);
    const worker = new ExecutionWorkerService({
      handles: store,
      capability,
      secrets: adapters.secret,
      clock,
      ids: adapters.ids,
    });
    const base = executeRequest();
    const request = executeRequest({
      payload: {
        ...base.payload,
        capabilityHandleRef: handle.ref,
        secretRefs: [],
      },
    });
    await worker.cancel({
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      kind: "request",
      type: "work.cancel",
      messageId: "execution-cancel-search",
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      scope: request.scope,
      idempotencyKey: "cancel-search",
      payload: {
        targetRequestId: request.messageId,
        reasonCode: "owner_requested",
        requestedAt: T0,
      },
    });
    await expect(collect(worker.execute(request))).resolves.toMatchObject([
      { type: "work.cancelled", payload: { reasonCode: "owner_requested" } },
    ]);
    expect(capability.observedInvocations()).toEqual([]);

    clock.set(T2);
    const expiredRequest = executeRequest({
      messageId: "execution-request-expired",
      payload: {
        ...base.payload,
        capabilityHandleRef: handle.ref,
        secretRefs: [],
        deadlineAt: T1,
      },
    });
    await expect(collect(worker.execute(expiredRequest))).resolves.toMatchObject([
      { type: "work.result", payload: { outcome: "failed", errorCode: "EXECUTION_TIMEOUT" } },
    ]);
    expect(capability.observedInvocations()).toEqual([]);
  });

  it.each([
    {
      name: "capability",
      mutate: (request: ExecuteWorkRequest) => ({
        ...request,
        payload: { ...request.payload, capabilityId: "undelegated-capability" },
      }),
    },
    {
      name: "context",
      mutate: (request: ExecuteWorkRequest) => ({
        ...request,
        payload: {
          ...request.payload,
          delegatedContextRefs: [...request.payload.delegatedContextRefs, "payload-private"],
        },
      }),
    },
    {
      name: "secret",
      mutate: (request: ExecuteWorkRequest) => ({
        ...request,
        payload: {
          ...request.payload,
          secretRefs: [
            ...request.payload.secretRefs,
            { secretRef: "owner-master", secretVersion: "v1", purpose: "unrelated" },
          ],
        },
      }),
    },
  ])("rejects undelegated $name access before invoking a capability", async ({ mutate }) => {
    const clock = new ManualClock(T0);
    const adapters = createReferenceAdapterSet({ clock });
    const store = new InMemoryCapabilityRegistryStore();
    const registry = new CapabilityRegistryService({ store, clock, ids: adapters.ids });
    await install(registry, SEARCH_DECLARATION);
    const handle = await registry.issueExecutionHandle({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: SEARCH_DECLARATION.ref,
      operation: "search",
      permission: permission(SEARCH_DECLARATION.ref, "search"),
      inputRefs: ["payload-search-input"],
      delegatedContextRefs: ["payload-search-context"],
      secretRefs: [
        { secretRef: "map-provider", secretVersion: "v1", purpose: "restaurant-search" },
      ],
      expiresAt: T2,
    });
    const capability = new DeterministicRestaurantCapabilityPort(T0, T1);
    const worker = new ExecutionWorkerService({
      handles: store,
      capability,
      secrets: adapters.secret,
      clock,
      ids: adapters.ids,
    });
    const base = executeRequest();
    const request = executeRequest({
      payload: { ...base.payload, capabilityHandleRef: handle.ref },
    });

    await expect(collect(worker.execute(mutate(request)))).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    expect(capability.observedInvocations()).toEqual([]);
  });
});
