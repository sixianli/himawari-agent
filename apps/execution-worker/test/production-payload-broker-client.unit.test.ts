import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapabilityInvocationRequest } from "@himawari-agent/application";
import {
  PAYLOAD_UDS_ERROR_CODES,
  type PayloadBrokerTrustedHandler,
  PayloadUdsServer,
  type PayloadUdsServerOptions,
} from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import {
  ProductionPayloadBrokerClient,
  type ProductionPayloadBrokerClientOptions,
} from "../src/index.js";

const credential = Object.freeze({
  tokenRef: "worker-boot-token-ref",
  tokenValue: "0123456789abcdef0123456789abcdef",
});
const agentServiceInstanceId = "agent-service:worker-client";
const agentServiceBootId = "agent-boot:worker-client";
const workerInstanceId = "worker:worker-client";
const workerBootId = "worker-boot:worker-client";
const authorityEpoch = 2;
const fencingToken = 6;
const maximumBodyBytes = 16_384;
const maximumPayloadBytes = 1_024;

const invocation: CapabilityInvocationRequest = {
  invocationId: "invocation:worker-client",
  ownerId: "owner:worker-client" as CapabilityInvocationRequest["ownerId"],
  agentId: "agent:worker-client" as CapabilityInvocationRequest["agentId"],
  runId: "run:worker-client" as CapabilityInvocationRequest["runId"],
  capabilityRef: "capability:worker-client",
  capabilityHandleRef: "handle:worker-client",
  operation: "execute",
  inputRef: "payload:input:worker-client",
  delegatedContextRefs: ["payload:delegated:worker-client"],
  secretHandleRefs: ["secret-handle:worker-client"],
  dataClassification: "sensitive",
  resourceCeiling: {
    maxWallTimeMs: 1_000,
    maxCpuTimeMs: 500,
    maxMemoryBytes: 16_777_216,
    maxOutputBytes: maximumPayloadBytes,
    maxProgressEvents: 8,
  },
};

let idSequence = 0;

function nextId(scope: string): string {
  idSequence += 1;
  return `${scope}:${idSequence}`;
}

function options(socketPath: string): ProductionPayloadBrokerClientOptions {
  return {
    socketPath,
    credential,
    agentServiceInstanceId,
    agentServiceBootId,
    workerInstanceId,
    workerBootId,
    authorityEpoch,
    fencingToken,
    maximumBodyBytes,
    maximumPayloadBytes,
    requestTimeoutMs: 500,
    nextId,
  };
}

function serverOptions(
  runtimeDirectory: string,
  handler: PayloadBrokerTrustedHandler,
): PayloadUdsServerOptions {
  return {
    runtimeDirectory,
    credential,
    agentServiceInstanceId,
    agentServiceBootId,
    allowedWorkerIdentities: [{ workerInstanceId, workerBootId }],
    authorityEpoch,
    fencingToken,
    maximumBodyBytes,
    maximumPayloadBytes,
    requestTimeoutMs: 500,
    handler,
  };
}

async function withServer<T>(
  handler: PayloadBrokerTrustedHandler,
  run: (server: PayloadUdsServer) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-payload-"));
  const server = new PayloadUdsServer(serverOptions(directory, handler));
  await server.start();
  try {
    return await run(server);
  } finally {
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

describe("ProductionPayloadBrokerClient", () => {
  it("implements only the narrow boundary and maps trusted transport receipts to refs", async () => {
    const readRequests: Array<{ readonly payload: Record<string, unknown> }> = [];
    const writeCalls: Array<{
      readonly request: { readonly payload: Record<string, unknown> };
      readonly plaintext: Uint8Array;
      readonly contentType: string;
    }> = [];
    await withServer(
      {
        readInput: async (request) => {
          readRequests.push(request as (typeof readRequests)[number]);
          return new TextEncoder().encode("trusted input");
        },
        writeOutput: async (request, plaintext, contentType) => {
          writeCalls.push({
            request: request as (typeof writeCalls)[number]["request"],
            plaintext,
            contentType,
          });
          return { outputRef: "payload:worker-client-output", replayed: true };
        },
      },
      async (server) => {
        const client = new ProductionPayloadBrokerClient(options(server.socketPath));
        expect(client.isReady()).toBe(false);
        await client.connect();
        expect(client.isReady()).toBe(true);

        await expect(client.readInput(invocation)).resolves.toEqual(
          new TextEncoder().encode("trusted input"),
        );
        await expect(
          client.writeOutput(invocation, new TextEncoder().encode("worker output"), "text/plain"),
        ).resolves.toBe("payload:worker-client-output");

        expect(readRequests[0]?.payload).toEqual({
          handleRef: invocation.capabilityHandleRef,
          invocationId: invocation.invocationId,
          workerInstanceId,
          workerBootId,
          authorityEpoch,
          fencingToken,
        });
        expect(readRequests[0]?.payload).not.toHaveProperty("ownerId");
        expect(readRequests[0]?.payload).not.toHaveProperty("agentId");
        expect(readRequests[0]?.payload).not.toHaveProperty("runId");
        expect(readRequests[0]?.payload).not.toHaveProperty("inputRef");
        expect(writeCalls[0]?.contentType).toBe("text/plain");
        expect(new TextDecoder().decode(writeCalls[0]?.plaintext)).toBe("worker output");
        expect(writeCalls[0]?.request.payload).not.toHaveProperty("ownerId");
        expect(writeCalls[0]?.request.payload).not.toHaveProperty("dataClassification");
        expect(writeCalls[0]?.request.payload).not.toHaveProperty("runId");
        expect(Object.keys(client)).not.toContain("database");
        expect(Object.keys(client)).not.toContain("protector");
        client.disconnect();
        expect(client.isReady()).toBe(false);
      },
    );
  });

  it("fails closed before handshake and preserves stable broker errors without a success fallback", async () => {
    const notConnected = new ProductionPayloadBrokerClient(
      options("/tmp/himawari-payload-client-no-server.sock"),
    );
    await expect(notConnected.readInput(invocation)).rejects.toMatchObject({
      code: PAYLOAD_UDS_ERROR_CODES.HANDSHAKE_REQUIRED,
    });

    await withServer(
      {
        readInput: async () => {
          throw new Error("private input details");
        },
        writeOutput: async () => {
          throw new Error("private output details");
        },
      },
      async (server) => {
        const client = new ProductionPayloadBrokerClient(options(server.socketPath));
        await client.connect();
        await expect(client.readInput(invocation)).rejects.toMatchObject({
          code: PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED,
        });
        await expect(
          client.writeOutput(invocation, new TextEncoder().encode("worker output"), "text/plain"),
        ).rejects.toMatchObject({ code: PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED });
        expect(client.isReady()).toBe(true);
      },
    );
  });
});
