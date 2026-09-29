import { mkdtemp, rm } from "node:fs/promises";
import { executionV2MessageSchema } from "@himawari-agent/execution-contracts";
import {
  PayloadUdsServer,
  PayloadUdsClient,
  PAYLOAD_UDS_ERROR_CODES,
  ExecutionAdmissionUdsServer,
  ExecutionAdmissionUdsClient,
  EXECUTION_ADMISSION_UDS_ERROR_CODES,
} from "@himawari-agent/platform-node";
import { udsFaultProxy } from "@himawari-agent/testing";
import { expect, it, vi } from "vitest";
import { serviceRequest, handle, T1 } from "../fixtures/sqlite-capability-invocation-fixture.ts";

it.each(
  (["Payload", "Admission"] as const).flatMap((channel) =>
    (["next-call", "concurrent", "rejected", "closed"] as const).map(
      (mode) => [channel, mode] as const,
    ),
  ),
)("recovers subsequent %s operations through authenticated UDS: %s", async (channel, mode) => {
  const root = await mkdtemp("/tmp/h-f-uds-");
  const execute = serviceRequest();
  const peer = {
    agentServiceInstanceId: "agent",
    agentServiceBootId: "agent-boot",
    workerInstanceId: "worker",
    workerBootId: "worker-boot",
    deploymentId: execute.scope.deploymentId,
    authorityEpoch: execute.scope.authorityEpoch,
    fencingToken: execute.scope.fencingToken,
  };
  let sequence = 0;
  const common = {
    credential: { tokenRef: "credential", tokenValue: "f".repeat(32) },
    maximumBodyBytes: 65536,
    requestTimeoutMs: 1000,
    nextId: () => `message:${++sequence}`,
    now: () => T1,
  };
  const identity = {
    ...peer,
    handleRef: execute.payload.capabilityHandleRef,
    invocationId: execute.messageId,
  };
  const server =
    channel === "Payload"
      ? new PayloadUdsServer({
          ...common,
          ...peer,
          runtimeDirectory: root,
          maximumPayloadBytes: 16384,
          allowedWorkerIdentities: [peer],
          handler: {
            readInput: async () => new TextEncoder().encode("next invocation"),
            writeOutput: async () => ({ outputRef: "unused", replayed: false }),
          },
        })
      : new ExecutionAdmissionUdsServer({
          ...common,
          runtimeDirectory: root,
          trustedPeerBinding: () => peer,
          handler: {
            admit: async ({ payload: { execute: request } }) => {
              const { authorization, ...baseHandle } = handle();
              const delegate = executionV2MessageSchema.parse({
                ...request,
                type: "work.delegate",
                messageId: "delegate",
                causationId: request.messageId,
                idempotencyKey: `${request.idempotencyKey}:delegate`,
                payload: {
                  handle: { ...baseHandle, authorizationType: authorization.type },
                  requestedAt: request.payload.requestedAt,
                },
              });
              if (delegate.kind !== "request" || delegate.type !== "work.delegate")
                throw new Error("Invalid fixture delegate");
              return {
                disposition: "consumed",
                reasonCode: null,
                receipt: {
                  receiptRef: `receipt:${request.messageId}`,
                  handleRef: request.payload.capabilityHandleRef,
                  invocationId: request.messageId,
                  idempotencyKey: request.idempotencyKey,
                  ownerId: request.scope.ownerId ?? "missing",
                  agentId: request.scope.agentId ?? "missing",
                  runId: request.scope.runId ?? "missing",
                  workerRunId: request.scope.workerRunId ?? "missing",
                },
                projection: { execute: request, delegate },
              };
            },
          },
        });
  await server.start();
  const proxy = await udsFaultProxy(`${root}/proxy.sock`, server.socketPath);
  const next = { ...execute, messageId: "next-invocation", idempotencyKey: "next-invocation" };
  const payloadClient = new PayloadUdsClient({
    ...common,
    ...peer,
    socketPath: `${root}/proxy.sock`,
    maximumPayloadBytes: 16384,
  });
  const admissionClient = new ExecutionAdmissionUdsClient({
    ...common,
    peerBinding: peer,
    socketPath: `${root}/proxy.sock`,
  });
  const client = channel === "Payload" ? payloadClient : admissionClient;
  const firstPath =
    channel === "Payload" ? "/payload/v1/output/write" : "/admission/v1/work/execute";
  const first = () =>
    channel === "Payload"
      ? payloadClient.writeOutput(identity, new TextEncoder().encode("first"), "text/plain")
      : admissionClient.admit(execute);
  const following = () =>
    channel === "Payload"
      ? payloadClient.readInput({ ...identity, invocationId: "next" })
      : admissionClient.admit(next);
  const codes =
    channel === "Payload" ? PAYLOAD_UDS_ERROR_CODES : EXECUTION_ADMISSION_UDS_ERROR_CODES;
  try {
    await client.connect();
    proxy.dropNext(firstPath);
    await expect(first()).rejects.toThrow();
    expect(client.isReady()).toBe(false);
    if (mode === "next-call") {
      const result = await following();
      if (channel === "Payload")
        expect(result).toEqual(new TextEncoder().encode("next invocation"));
      else expect(result).toMatchObject({ disposition: "consumed" });
    } else {
      proxy.blockHandshakes(mode === "rejected");
      const pending = Promise.allSettled([following(), following(), client.connect()]);
      await vi.waitFor(() =>
        expect(proxy.requests.filter((p) => p.endsWith("/handshake"))).toHaveLength(2),
      );
      expect(client.isReady()).toBe(false);
      if (mode === "closed") client.disconnect();
      proxy.releaseHandshakes();
      const results = await pending;
      expect(results.map((r) => r.status)).toEqual(
        Array(3).fill(mode === "concurrent" ? "fulfilled" : "rejected"),
      );
      if (mode === "rejected" || mode === "closed")
        for (const result of results) {
          if (result.status !== "rejected") throw new Error("Handshake unexpectedly succeeded");
          expect(result.reason).toMatchObject({
            code: mode === "closed" ? codes.HANDSHAKE_REQUIRED : codes.REQUEST_FAILED,
          });
        }
    }
    expect(client.isReady()).toBe(mode === "next-call" || mode === "concurrent");
    expect(proxy.requests.filter((p) => p.endsWith("/handshake"))).toHaveLength(2);
    const followingCount = mode === "next-call" ? 1 : mode === "concurrent" ? 2 : 0;
    expect(proxy.requests.filter((p) => p === firstPath)).toHaveLength(
      channel === "Payload" ? 1 : 1 + followingCount,
    );
    if (channel === "Payload")
      expect(proxy.requests.filter((p) => p === "/payload/v1/input/read")).toHaveLength(
        followingCount,
      );
  } finally {
    client.disconnect();
    await proxy.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
