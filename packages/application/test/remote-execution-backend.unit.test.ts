import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { RemoteExecutionBackend } from "../src/services/remote-execution-backend.ts";

const identity = {
  schemaVersion: "execution-environment.v1",
  ownerId: "owner-1",
  agentId: "agent-1",
  runId: "run-1",
  hostId: "host-1",
  executionJobId: "execution-job-1",
  environmentId: "environment-1",
  environmentGeneration: 1,
  role: "primary",
} as const;
const locator = {
  backendRef: "container-docker:host-1",
  runtimeInstanceId: "daemon-1",
  runtimeEnvironmentId: "d".repeat(64),
  createIntentId: "create-1",
  effectivePolicyDigest: "e".repeat(64),
};
const envelope = {
  schemaVersion: "execution-envelope.v1",
  directories: [],
  network: [],
  resources: {
    cpuMillicores: 500,
    memoryBytes: 134217728,
    maxProcesses: 64,
    privateStorageBytes: 16777216,
  },
} as const;
const target = { identity, createIntentId: "create-1", locator };

type Reply =
  | { readonly outcome: "succeeded"; readonly result: unknown }
  | { readonly outcome: "failed"; readonly errorCode: string }
  | { readonly outcome: "result_unknown" }
  | { readonly outcome: "silent" };

class FakeWorker {
  readonly requests: Extract<ExecutionV2Request, { type: "environment.operation.execute" }>[] = [];
  readonly events: ExecutionV2Event[] = [];
  reply: (request: ExecutionV2Request) => Reply = () => ({ outcome: "silent" });
  private readonly seen = new Set<string>();
  private sequence = 0;

  readonly transport = {
    request: async (message: ExecutionV2Request) => {
      const parsed = executionV2MessageSchema.parse(message);
      if (parsed.kind !== "request" || parsed.type !== "environment.operation.execute")
        throw new Error("unexpected request");
      this.requests.push(parsed);
      if (this.seen.has(parsed.idempotencyKey)) return null;
      this.seen.add(parsed.idempotencyKey);
      const reply = this.reply(parsed);
      if (reply.outcome !== "silent") this.emit(parsed, reply);
      return null;
    },
    events: (afterCursor: string | null) => {
      const start =
        afterCursor === null
          ? 0
          : this.events.findIndex((event) => event.payload.cursor === afterCursor) + 1;
      const pending = this.events.slice(start);
      return (async function* () {
        yield* pending;
      })();
    },
  };

  emit(
    request: Extract<ExecutionV2Request, { type: "environment.operation.execute" }>,
    reply: Exclude<Reply, { outcome: "silent" }>,
    overrides: Record<string, unknown> = {},
  ) {
    this.sequence += 1;
    const event = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event",
      type: "environment.operation.result",
      messageId: `result-${this.sequence}`,
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload: {
        requestId: request.messageId,
        operation: request.payload.operation,
        cursor: `cursor-${this.sequence}`,
        sequence: 1,
        outcome: reply.outcome,
        result: reply.outcome === "succeeded" ? reply.result : null,
        errorCode: reply.outcome === "failed" ? reply.errorCode : null,
        completedAt: "2026-09-26T10:00:01.000Z",
      },
      ...overrides,
    });
    if (event.kind !== "event") throw new Error("not an event");
    this.events.push(event);
  }
}

function subject(worker: FakeWorker, resultTimeoutMs = 200) {
  let id = 0;
  return new RemoteExecutionBackend({
    transport: worker.transport,
    ownerId: "owner-1",
    agentId: "agent-1",
    authority: () => ({ deploymentId: "deployment-1", authorityEpoch: 4, fencingToken: 7 }),
    nextId: (scope) => `${scope}-${++id}`,
    now: () => "2026-09-26T10:00:00.000Z",
    requestTimeoutMs: 60_000,
    resultTimeoutMs,
    pollIntervalMs: 5,
  });
}

describe("remote execution backend over execution.v2", () => {
  it("sends each operation in the environment's Run scope and returns the Worker's typed result", async () => {
    const worker = new FakeWorker();
    worker.reply = (request) =>
      request.type === "environment.operation.execute" && request.payload.operation === "create"
        ? { outcome: "succeeded", result: locator }
        : {
            outcome: "succeeded",
            result: { outputRef: "output-1", observedAt: "2026-09-26T10:00:01.000Z" },
          };
    const backend = subject(worker);
    expect(
      await backend.create({
        identity,
        createIntentId: "create-1",
        envelope,
        policyDigest: "a".repeat(64),
        imageDigest: "b".repeat(64),
        runnerDigest: "c".repeat(64),
        deadlineAt: "2026-09-26T11:00:00.000Z",
      }),
    ).toEqual(locator);
    expect(
      await backend.execute({
        ...target,
        stopFence: 0,
        invocationId: "invocation-1",
        argumentsRef: "payload-arguments-1",
        deadlineAt: "2026-09-26T10:05:00.000Z",
        authorizationRef: "authorization-1",
      }),
    ).toEqual({ outputRef: "output-1", observedAt: "2026-09-26T10:00:01.000Z" });
    const [create, execute] = worker.requests;
    expect(create).toMatchObject({
      risk: "medium",
      authorizationRef: null,
      idempotencyKey: "environment-create:environment-1:create-1",
      scope: {
        deploymentId: "deployment-1",
        authorityEpoch: 4,
        fencingToken: 7,
        ownerId: "owner-1",
        agentId: "agent-1",
        runId: "run-1",
        workerRunId: "environment:environment-1",
      },
      payload: {
        operation: "create",
        environmentDeadlineAt: "2026-09-26T11:00:00.000Z",
        requestedAt: "2026-09-26T10:00:00.000Z",
        deadlineAt: "2026-09-26T10:01:00.000Z",
      },
    });
    expect(execute).toMatchObject({
      risk: "high",
      authorizationRef: "authorization-1",
      idempotencyKey: "environment-execute:environment-1:invocation-1",
      payload: {
        operation: "execute",
        invocationDeadlineAt: "2026-09-26T10:05:00.000Z",
        credential: null,
      },
    });
  });

  it("recovers a replayed state change from the earlier event instead of repeating it", async () => {
    const worker = new FakeWorker();
    worker.reply = () => ({ outcome: "succeeded", result: { accepted: true } });
    const backend = subject(worker);
    const stop = { ...target, stopIntentId: "stop-1", stopFence: 1 };
    await backend.stop(stop);
    await backend.stop(stop);
    expect(worker.requests.map((request) => request.idempotencyKey)).toEqual([
      "environment-stop:environment-1:stop-1",
      "environment-stop:environment-1:stop-1",
    ]);
    expect(worker.events).toHaveLength(1);
  });

  it("asks fresh for capabilities, observations and stop verification", async () => {
    const worker = new FakeWorker();
    worker.reply = (request) =>
      request.type === "environment.operation.execute" &&
      request.payload.operation === "capabilities"
        ? {
            outcome: "succeeded",
            result: {
              protocolVersion: "execution-backend.v1",
              backendRef: "container-docker:host-1",
              runtimeInstanceId: "daemon-1",
              guarantees: [],
              checkedAt: "2026-09-26T10:00:00.000Z",
            },
          }
        : {
            outcome: "succeeded",
            result: { state: "running", locator, observedAt: "2026-09-26T10:00:01.000Z" },
          };
    const backend = subject(worker);
    await backend.capabilities();
    await backend.capabilities();
    await backend.inspect(target);
    await backend.inspect(target);
    const keys = worker.requests.map((request) => request.idempotencyKey);
    expect(new Set(keys).size).toBe(4);
    expect(worker.requests[0]?.scope).toMatchObject({
      ownerId: "owner-1",
      agentId: "agent-1",
      runId: null,
      workerRunId: null,
    });
  });

  it("surfaces the Worker's error code and treats silence or an unknown result as unknown", async () => {
    const worker = new FakeWorker();
    const backend = subject(worker, 50);
    worker.reply = () => ({ outcome: "failed", errorCode: "CONTAINER_RUNTIME_CHANGED" });
    await expect(backend.inspect(target)).rejects.toMatchObject({
      code: "CONTAINER_RUNTIME_CHANGED",
    });
    worker.reply = () => ({ outcome: "result_unknown" });
    await expect(backend.destroy(target)).rejects.toMatchObject({
      code: "EXECUTION_ENVIRONMENT_RESULT_UNKNOWN",
    });
    worker.reply = (request) => {
      if (request.type !== "environment.operation.execute") throw new Error("unexpected");
      worker.emit(
        request,
        { outcome: "succeeded", result: { accepted: true } },
        { scope: { ...request.scope, fencingToken: 99 } },
      );
      worker.emit(
        request,
        { outcome: "succeeded", result: { accepted: true } },
        { causationId: "another-request" },
      );
      return { outcome: "silent" };
    };
    await expect(
      backend.stop({ ...target, stopIntentId: "stop-2", stopFence: 1 }),
    ).rejects.toMatchObject({ code: "EXECUTION_ENVIRONMENT_RESULT_UNKNOWN" });
  });
});
