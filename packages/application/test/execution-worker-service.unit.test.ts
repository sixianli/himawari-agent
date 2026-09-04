import type {
  CapabilityExecutionHandle,
  CapabilityExecutionHandleStorePort,
  CapabilityInvocationEvent,
  CapabilityPort,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
  SecretHandle,
  SecretPort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  EXECUTION_SCHEMA_VERSION,
  type ExecuteWorkRequest,
  executionMessageSchema,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { ExecutionWorkerService } from "../src/services/execution-worker-service.js";

const OWNER_ID = createOwnerId("owner-execution-worker-result");
const AGENT_ID = createAgentId("agent-execution-worker-result");
const RUN_ID = createRunId("run-execution-worker-result");
const HANDLE_REF = "handle-execution-worker-result";
const CAPABILITY_REF = "capability-execution-worker-result";
const INPUT_REF = "payload:execution-worker-input";
const REQUESTED_AT = "2026-09-04T00:00:00.000Z";
const DEADLINE_AT = "2026-09-04T00:00:01.000Z";
const LATE_AT = "2026-09-04T00:00:02.000Z";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const handle: CapabilityExecutionHandle = {
  ref: HANDLE_REF,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  capabilityRef: CAPABILITY_REF,
  capabilityVersion: "1.0.0",
  authorization: { type: "policy", ref: "policy:execution-worker-result" },
  operations: ["execute"],
  inputRefs: [INPUT_REF],
  delegatedContextRefs: [],
  secretRefs: [],
  maxDataClassification: "private",
  issuedAt: REQUESTED_AT,
  expiresAt: DEADLINE_AT,
  revokedAt: null,
};

const capabilityRecord: CapabilityRegistryRecord = {
  ref: CAPABILITY_REF,
  revision: 1,
  lifecycle: "active",
  declaration: {
    ref: CAPABILITY_REF,
    displayName: CAPABILITY_REF,
    version: "1.0.0",
    source: { type: "builtin", locator: "fixture" },
    integrity: `sha256:${"a".repeat(64)}`,
    operations: ["execute"],
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
  discoveredAt: REQUESTED_AT,
  updatedAt: REQUESTED_AT,
};

function handlesFixture(): CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort {
  return {
    create: async (record) => record,
    get: async (capabilityRef) =>
      capabilityRef === capabilityRecord.ref ? capabilityRecord : undefined,
    list: async () => [capabilityRecord],
    save: async (record) => record,
    createExecutionHandle: async (created) => created,
    getExecutionHandle: async (handleRef) => (handleRef === HANDLE_REF ? handle : undefined),
    revokeExecutionHandle: async () => handle,
  };
}

function secretsFixture(): SecretPort {
  return {
    issueHandle: async () => {
      throw new Error("secret issuance was not expected in this test");
    },
    inspectHandle: async () => undefined,
    revokeHandle: async (_handleRef: string, _revokedAt: string): Promise<SecretHandle> => {
      throw new Error("secret revocation was not expected in this test");
    },
  };
}

function request(): ExecuteWorkRequest {
  const parsed = executionMessageSchema.parse({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: "invocation:execution-worker-result",
    correlationId: "correlation:execution-worker-result",
    causationId: "delegation:execution-worker-result",
    dataClassification: "private",
    scope: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run:execution-worker-result",
    },
    idempotencyKey: "idempotency:execution-worker-result",
    payload: {
      capabilityId: CAPABILITY_REF,
      capabilityVersion: "1.0.0",
      operation: "execute",
      inputRef: INPUT_REF,
      capabilityHandleRef: HANDLE_REF,
      delegatedContextRefs: [],
      secretRefs: [],
      requestedAt: REQUESTED_AT,
      deadlineAt: DEADLINE_AT,
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "work.execute") {
    throw new TypeError("execution request fixture is invalid");
  }
  return parsed;
}

function cancelRequest(targetRequestId: string) {
  const parsed = executionMessageSchema.parse({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    kind: "request",
    type: "work.cancel",
    messageId: "cancel:execution-worker-result",
    correlationId: "correlation:execution-worker-result",
    causationId: "invocation:execution-worker-result",
    dataClassification: "private",
    scope: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run:execution-worker-result",
    },
    idempotencyKey: "idempotency:cancel-execution-worker-result",
    payload: {
      targetRequestId,
      reasonCode: "USER_CANCELLED",
      requestedAt: REQUESTED_AT,
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "work.cancel") {
    throw new TypeError("cancel request fixture is invalid");
  }
  return parsed;
}

function workerFixture(event: CapabilityInvocationEvent) {
  const started = deferred<void>();
  const release = deferred<void>();
  const cancellationReasons: string[] = [];
  const capability: CapabilityPort = {
    list: async () => [],
    invoke: async function* () {
      started.resolve(undefined);
      await release.promise;
      yield event;
    },
    cancel: async (_invocationId, reasonCode) => {
      cancellationReasons.push(reasonCode);
    },
  };
  let now = REQUESTED_AT;
  const service = new ExecutionWorkerService({
    handles: handlesFixture(),
    capability,
    secrets: secretsFixture(),
    clock: { now: () => now },
    ids: { next: (namespace) => `${namespace}:execution-worker-result` },
  });
  return {
    service,
    started: started.promise,
    release: () => release.resolve(undefined),
    cancellationReasons,
    advanceClock: (value: string) => {
      now = value;
    },
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("ExecutionWorkerService result publication gate", () => {
  it("does not publish success when completion arrives after cancellation", async () => {
    const harness = workerFixture({
      type: "capability.completed",
      invocationId: "invocation:execution-worker-result",
      resultRef: "payload:late-completed",
      occurredAt: REQUESTED_AT,
    });
    const execution = collect(harness.service.execute(request()));
    await harness.started;

    await harness.service.cancel(cancelRequest("invocation:execution-worker-result"));
    harness.release();

    const events = await execution;
    expect(events).toMatchObject([
      { type: "work.cancelled", payload: { reasonCode: "USER_CANCELLED" } },
    ]);
    expect(events.some((event) => event.type === "work.result")).toBe(false);
    expect(harness.cancellationReasons).toContain("USER_CANCELLED");
  });

  it("preserves a late result_unknown and its external action identity", async () => {
    const harness = workerFixture({
      type: "capability.result_unknown",
      invocationId: "invocation:execution-worker-result",
      externalActionId: "external-action:late-result",
      occurredAt: LATE_AT,
    });
    const execution = collect(harness.service.execute(request()));
    await harness.started;
    harness.advanceClock(LATE_AT);
    harness.release();

    const events = await execution;
    expect(events).toMatchObject([
      {
        type: "work.result",
        payload: {
          outcome: "result_unknown",
          externalActionId: "external-action:late-result",
          outputRef: null,
          errorCode: null,
        },
      },
    ]);
    expect(
      events.some((event) => event.type === "work.result" && event.payload.outcome === "failed"),
    ).toBe(false);
  });

  it("preserves an external action fact when cancellation races with result_unknown", async () => {
    const harness = workerFixture({
      type: "capability.result_unknown",
      invocationId: "invocation:execution-worker-result",
      externalActionId: "external-action:cancel-race",
      occurredAt: REQUESTED_AT,
    });
    const execution = collect(harness.service.execute(request()));
    await harness.started;

    await harness.service.cancel(cancelRequest("invocation:execution-worker-result"));
    harness.release();

    const events = await execution;
    expect(events).toMatchObject([
      {
        type: "work.result",
        payload: { outcome: "result_unknown", externalActionId: "external-action:cancel-race" },
      },
    ]);
    expect(events.some((event) => event.type === "work.cancelled")).toBe(false);
  });

  it("applies the wall-clock deadline even when an event timestamp is early", async () => {
    const harness = workerFixture({
      type: "capability.completed",
      invocationId: "invocation:execution-worker-result",
      resultRef: "payload:clock-late-completed",
      occurredAt: REQUESTED_AT,
    });
    const execution = collect(harness.service.execute(request()));
    await harness.started;
    harness.advanceClock(DEADLINE_AT);
    harness.release();

    const events = await execution;
    expect(events).toMatchObject([
      { type: "work.result", payload: { outcome: "failed", errorCode: "EXECUTION_TIMEOUT" } },
    ]);
    expect(
      events.some((event) => event.type === "work.result" && event.payload.outcome === "succeeded"),
    ).toBe(false);
    expect(harness.cancellationReasons).toContain("deadline_exceeded");
  });

  it("does not publish success when completion arrives after the deadline", async () => {
    const harness = workerFixture({
      type: "capability.completed",
      invocationId: "invocation:execution-worker-result",
      resultRef: "payload:late-completed-deadline",
      occurredAt: LATE_AT,
    });
    const execution = collect(harness.service.execute(request()));
    await harness.started;
    harness.release();

    const events = await execution;
    expect(events).toMatchObject([
      { type: "work.result", payload: { outcome: "failed", errorCode: "EXECUTION_TIMEOUT" } },
    ]);
    expect(
      events.some((event) => event.type === "work.result" && event.payload.outcome === "succeeded"),
    ).toBe(false);
    expect(harness.cancellationReasons).toContain("deadline_exceeded");
  });
});
