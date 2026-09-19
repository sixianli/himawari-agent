import Database from "better-sqlite3";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeToolInvocation } from "@himawari-agent/application";
import type { ExecutionV2Event, ExecutionV2Request } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.ts";
import { createProductionWorkerParentBindingRegistry } from "../../apps/agent-service/src/production-worker-parent-binding-registry.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  AGENT_ID,
  OWNER_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});
function runtimeFingerprint(call: RuntimeToolInvocation) {
  if (!call.context) throw new Error("context missing");
  const { executionLease, continuationRef: _continuation, ...context } = call.context;
  return createHash("sha256")
    .update(
      JSON.stringify(
        {
          ...call,
          context: {
            ...context,
            authority: {
              deploymentId: executionLease.deploymentId,
              authorityEpoch: executionLease.authorityEpoch,
              fencingToken: executionLease.fencingToken,
            },
          },
        },
        (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
      ),
    )
    .digest("hex");
}
async function fixture() {
  const f = await productionSandboxScope(
    {
      operation: "bash",
      mode: "foreground",
      contract: { ref: "bash", version: "1", kind: "command" },
      backendRef: "srt",
      scopeSource: "grant_targets",
      directoryOperations: ["read", "create", "update"],
      network: "grant_targets",
    },
    (intent) => intent,
    { runtimeFingerprint },
  );
  close.push(f.close);
  const peer = {
    ...SERVICE_AUTHORITY.product,
    agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
    agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
    workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
    workerBootId: SERVICE_AUTHORITY.workerBootId,
  };
  const registry = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
  let sent: Extract<ExecutionV2Request, { type: "work.execute" }> | undefined;
  let id = 0;
  let authority = SERVICE_AUTHORITY;
  const request = vi.fn(async (message: ExecutionV2Request) => {
    if (message.type === "work.delegate")
      return {
        ...message,
        kind: "response" as const,
        type: "work.delegate.accepted" as const,
        messageId: "accepted",
        causationId: message.messageId,
        payload: {
          handleRef: message.payload.handle.ref,
          workerBootId: peer.workerBootId,
          acceptedAt: T1,
        },
      };
    if (message.type === "work.execute") sent = message;
    return null;
  });
  const tool = (maxCpuTimeMs = f.input.resourceCeiling.maxCpuTimeMs) =>
    new ProductionRuntimeTools({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      capabilities: f.repository.capabilityStore(OWNER_ID, AGENT_ID),
      invocations: f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
      results: { lookupOutput: async () => undefined },
      artifacts: f.artifacts(),
      payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.f.protector,
      sandbox: f.services.runtime,
      authority: () => authority,
      peer: () => peer,
      parents: registry.writer,
      assertRunActive: async () => {},
      ceiling: { ...f.input.resourceCeiling, maxCpuTimeMs },
      clock: { now: () => T1 },
      ids: { next: (scope) => `${scope}:reentry:${++id}` },
      transport: {
        request,
        async *events() {
          if (!sent) return;
          yield {
            ...sent,
            kind: "event",
            type: "work.cancelled",
            messageId: "cancelled",
            causationId: sent.messageId,
            payload: {
              requestId: sent.messageId,
              cursor: "1",
              sequence: 1,
              cancelledAt: T1,
              reasonCode: "TEST_WORKER_CANCELLED",
            },
          } satisfies ExecutionV2Event;
        },
      },
    });
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  const position = await f.services.brokerV2.preparations.enqueue({
    ...prepared,
    invocation: f.input,
  });
  return {
    ...f,
    tool,
    request,
    prepared,
    position,
    changeBoot: () => {
      authority = { ...SERVICE_AUTHORITY, workerBootId: "new-worker-boot" };
    },
  };
}
it("resumes a durable unconsumed queue with one original receipt and no deadline extension", async () => {
  const f = await fixture();
  const resumed = f.tool();
  await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
  expect(await resumed.execute(f.call)).toMatchObject({
    outcome: "failed",
    errorCode: "TEST_WORKER_CANCELLED",
  });
  const dispatched = f.request.mock.calls.filter(([message]) => message.type === "work.execute");
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.[0]).toMatchObject({
    messageId: f.input.invocationId,
    payload: { requestedAt: f.input.requestedAt, deadlineAt: f.input.deadlineAt },
  });
  const db = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(db.prepare("SELECT receipt_ref FROM capability_invocation_receipts").pluck().get()).toBe(
      f.input.receiptRef,
    );
    expect(db.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get()).toBe(1);
  } finally {
    db.close();
  }
  expect(
    await f.services.brokerV2.preparations.readQueuedByInvocation({
      runId: f.call.runId,
      invocationId: f.input.invocationId,
    }),
  ).toMatchObject({ sequence: f.position.sequence, status: "admitted" });
  const replay = f.tool();
  await replay.listAuthorized(f.call.runId, [f.input.handleRef]);
  expect((await replay.execute(f.call)).errorCode).toBe("TEST_WORKER_CANCELLED");
  expect(f.request.mock.calls.filter(([message]) => message.type === "work.execute")).toHaveLength(
    1,
  );
});
it.each(["cancelled", "admitted", "changed-boot"] as const)(
  "does not resume queue state %s",
  async (state) => {
    const f = await fixture();
    if (state === "cancelled")
      await f.services.brokerV2.preparations.cancelQueued({
        identity: f.prepared.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
      });
    if (state === "admitted")
      await f.services.brokerV2.preparations.reserve({ ...f.prepared, invocation: f.input });
    if (state === "changed-boot") f.changeBoot();
    const resumed = f.tool();
    await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
    if (state === "changed-boot")
      await expect(resumed.execute(f.call)).rejects.toThrow("current authority");
    else expect((await resumed.execute(f.call)).outcome).toBe("result_unknown");
    expect(f.request).not.toHaveBeenCalled();
  },
);

it("concurrent re-entry commits one receipt and forwards only one executable message", async () => {
  const f = await fixture();
  const first = f.tool(),
    second = f.tool();
  await Promise.all([
    first.listAuthorized(f.call.runId, [f.input.handleRef]),
    second.listAuthorized(f.call.runId, [f.input.handleRef]),
  ]);
  const results = await Promise.all([first.execute(f.call), second.execute(f.call)]);
  expect(results.every((result) => result.errorCode === "TEST_WORKER_CANCELLED")).toBe(true);
  expect(f.request.mock.calls.filter(([message]) => message.type === "work.execute")).toHaveLength(
    1,
  );
  const db = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(db.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get()).toBe(1);
  } finally {
    db.close();
  }
});

it("does not resume an original request that exceeds a tightened resource ceiling", async () => {
  const f = await fixture();
  const resumed = f.tool(1);
  await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
  await expect(resumed.execute(f.call)).rejects.toThrow("current authority");
  expect(f.request).not.toHaveBeenCalled();
  expect(
    await f.services.brokerV2.preparations.readAdmission(f.prepared.plan.identity),
  ).toBeUndefined();
});
