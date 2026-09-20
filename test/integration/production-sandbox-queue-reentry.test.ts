import { createHash } from "node:crypto";
import path from "node:path";
import {
  claimFromRunExecutionLease,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createRunExecutionLeaseId,
} from "@himawari-agent/domain";
import type { ExecutionV2Event, ExecutionV2Request } from "@himawari-agent/execution-contracts";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.ts";
import { createProductionWorkerParentBindingRegistry } from "../../apps/agent-service/src/production-worker-parent-binding-registry.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  AGENT_ID,
  OWNER_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
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
  let authority = SERVICE_AUTHORITY;
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
    { runtimeFingerprint, authority: () => authority },
  );
  close.push(f.close);
  const peer = {
    ...SERVICE_AUTHORITY.product,
    agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
    agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
    workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
    workerBootId: SERVICE_AUTHORITY.workerBootId,
  };
  let registry = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
  let sent: Extract<ExecutionV2Request, { type: "work.execute" }> | undefined;
  let id = 0;
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
  // This service-level fixture starts from a claimable context checkpoint.
  // It does not simulate recovery of a crashed runtime_running Pi loop.
  if (!f.call.context) throw new Error("context required");
  const contextPayload = await f.persist("queue-test-context", { context: "service fixture" });
  await f.repository
    .runCheckpointStore(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product)
    .compareAndSet({
      runId: f.call.runId,
      expectedRevision: null,
      executionLease: f.call.context.executionLease,
      checkpoint: {
        phase: "context_formed",
        contextRef: contextPayload.ref,
        workerResults: {},
        runtimeEventCount: 0,
        lastTraceEventId: null,
        terminalStatus: null,
        output: null,
        diagnosticCode: null,
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
    changeFence: async () => {
      if (!f.call.context) throw new Error("context required");
      const oldDispatch = f.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        authority.product,
        authority.lease,
        "sandbox-consumer",
      );
      const released = await oldDispatch.release({
        runId: f.call.runId,
        executionLeaseId: f.call.context.executionLease.executionLeaseId,
        expectedLeaseRevision: 1,
        releasedAt: T1,
      });
      const leases = f.repository.authorityLeasePort({ now: () => T1 });
      await leases.release(authority.lease.leaseId);
      const next = await leases.claim(
        {
          id: createAuthorityLeaseId("queue-next-authority"),
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          holderId: createAuthorityHolderId("queue-next-holder"),
        },
        600_000,
      );
      authority = {
        ...authority,
        product: { ...authority.product, fencingToken: next.fencingToken },
        lease: { leaseId: next.lease.id, fencingToken: next.fencingToken },
      };
      Object.assign(peer, authority.product);
      registry = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
      const db = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
        readonly: true,
      });
      let revision: number;
      try {
        revision = db
          .prepare("SELECT revision FROM runs WHERE id=?")
          .pluck()
          .get(f.call.runId) as number;
      } finally {
        db.close();
      }
      const dispatch = f.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        authority.product,
        authority.lease,
        "queue-next-consumer",
      );
      const nextLease = await dispatch.claim({
        runId: f.call.runId,
        expectedRunRevision: revision,
        expectedLeaseRevision: released.revision,
        executionLeaseId: createRunExecutionLeaseId("queue-next-execution"),
        claimedAt: T1,
        expiresAt: T2,
      });
      return {
        ...f.call,
        context: { ...f.call.context, executionLease: claimFromRunExecutionLease(nextLease) },
      };
    },
    changeBoot: () => {
      authority = { ...SERVICE_AUTHORITY, workerBootId: "new-worker-boot" };
      peer.workerBootId = authority.workerBootId;
      registry = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
    },
  };
}
it("resumes a durable unconsumed queue with one original receipt and no deadline extension", async () => {
  const f = await fixture();
  const resumed = f.tool();
  await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
  expect(await resumed.execute(f.call)).toMatchObject({
    outcome: "result_unknown",
    dispatchState: "accepted",
    errorCode: "WORKER_RESULT_RECONCILIATION_REQUIRED",
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
  expect(await replay.execute(f.call)).toMatchObject({
    outcome: "result_unknown",
    errorCode: "WORKER_RESULT_RECONCILIATION_REQUIRED",
  });
  // The fixture only delivered a cancellation notification, not a host release proof.
  expect(
    await f.services.brokerV2.preparations.readAdmission(f.prepared.plan.identity),
  ).toMatchObject({ phase: "reserved" });
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
  expect(results).toEqual(
    results.map(() =>
      expect.objectContaining({
        outcome: "result_unknown",
        errorCode: "WORKER_RESULT_RECONCILIATION_REQUIRED",
      }),
    ),
  );
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

it("rebinds a changed Worker boot through production services before exposing tools", async () => {
  const f = await fixture();
  f.changeBoot();
  if (!f.call.context) throw new Error("context required");
  await f.services.rebindQueuedRun({
    runId: f.call.runId,
    ...f.call.context,
    capabilityHandleRefs: [f.input.handleRef],
  });
  const rebound = await f.services.brokerV2.preparations.readQueuedByInvocation({
    runId: f.call.runId,
    invocationId: f.input.invocationId,
  });
  expect(rebound).toMatchObject({
    bindingRevision: 1,
    sequence: f.position.sequence,
    invocation: { authority: { workerBootId: "new-worker-boot" } },
  });
  const resumed = f.tool();
  await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
  const result = await resumed.execute(f.call);
  const diagnostic = await f.artifacts().lookup({
    runId: f.call.runId,
    purpose: "trace",
    operationKey: `runtime-tool-diagnostic:${f.input.invocationId.slice("runtime-tool:".length)}`,
  });
  const payload =
    diagnostic && (await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(diagnostic.payloadRef));
  const detail =
    payload && (await f.f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }));
  expect(
    "dispatchState" in result ? result.dispatchState : undefined,
    detail ? Buffer.from(detail).toString() : JSON.stringify(result),
  ).toBe("accepted");
  expect(f.request.mock.calls.filter(([message]) => message.type === "work.execute")).toHaveLength(
    1,
  );
});

it("rebinds the original approval after real authority and Run lease replacement", async () => {
  const f = await fixture();
  const resumedCall = await f.changeFence();
  const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"));
  const originalHandle = database
    .prepare("SELECT record_json FROM capability_handles WHERE id=?")
    .pluck()
    .get(f.input.handleRef);
  database.exec(
    "CREATE TRIGGER queue_storage_failure BEFORE INSERT ON sandbox_queue_authority_bindings BEGIN SELECT RAISE(ABORT, 'queue storage failed'); END",
  );
  await expect(
    f.services.rebindQueuedRun({
      runId: resumedCall.runId,
      ...resumedCall.context,
      capabilityHandleRefs: [f.input.handleRef],
    }),
  ).rejects.toThrow("queue storage failed");
  expect(
    database
      .prepare("SELECT record_json FROM capability_handles WHERE id=?")
      .pluck()
      .get(f.input.handleRef),
  ).toBe(originalHandle);
  expect(
    database.prepare("SELECT count(*) FROM sandbox_queue_authority_bindings").pluck().get(),
  ).toBe(0);
  database.exec("DROP TRIGGER queue_storage_failure");
  database.close();
  await f.services.rebindQueuedRun({
    runId: resumedCall.runId,
    ...resumedCall.context,
    capabilityHandleRefs: [f.input.handleRef],
  });
  const rebound = await f.services.brokerV2.preparations.readQueuedByInvocation({
    runId: f.call.runId,
    invocationId: f.input.invocationId,
  });
  expect(rebound).toMatchObject({
    bindingRevision: 1,
    sequence: f.position.sequence,
    plan: {
      handleRef: f.input.handleRef,
      effectiveDeadlineAt: f.prepared.plan.effectiveDeadlineAt,
    },
    invocation: { authority: { product: { fencingToken: 2 } } },
  });
  const resumed = f.tool();
  await resumed.listAuthorized(f.call.runId, [f.input.handleRef]);
  await expect(resumed.execute(f.call)).rejects.toThrow("current authority");
  const result = await resumed.execute(resumedCall);
  expect("dispatchState" in result ? result.dispatchState : undefined, JSON.stringify(result)).toBe(
    "accepted",
  );
  expect((await resumed.execute(resumedCall)).outcome).toBe("result_unknown");
  const messages = f.request.mock.calls.filter(([message]) => message.type === "work.execute");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.[0]).toMatchObject({
    scope: { fencingToken: 2 },
    payload: { requestedAt: f.input.requestedAt, deadlineAt: f.input.deadlineAt },
  });
});
