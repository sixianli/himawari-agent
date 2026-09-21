import { mkdtemp, rm } from "node:fs/promises";
import {
  type CapabilityInvocationAuthority,
  ExecutionWorkerService,
} from "@himawari-agent/application";
import {
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { PayloadUdsServer } from "@himawari-agent/platform-node";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.ts";
import { ProductionExecutionWorker } from "../../apps/execution-worker/src/production-execution-worker.ts";
import { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.ts";
import { ProductionSandboxExecutionV2 } from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
import { WorkerDelegationStore } from "../../apps/execution-worker/src/worker-delegation-store.ts";
import type { productionSandboxScope } from "./production-sandbox-scope.ts";
import { AGENT_ID, OWNER_ID } from "./sqlite-capability-invocation-fixture.ts";

/** Real worker protocol and JobHost. Only the enclosing test supplies the model,
 * owner decision and controlled installation qualification. Execution messages
 * use the in-process port; protected payloads and resource facts use real UDS. */
export async function queuedLiveWorker(
  f: Awaited<ReturnType<typeof productionSandboxScope>>,
  authority: CapabilityInvocationAuthority,
  beforeResolvedReply?: () => Promise<void>,
) {
  const directory = await mkdtemp("/tmp/h-qr-");
  const clock = { now: () => new Date().toISOString() };
  let sequence = 0;
  const ids = { next: () => `queued-live:${++sequence}` };
  const common = {
    credential: { tokenRef: "queued-live", tokenValue: "0123456789abcdef0123456789abcdef" },
    agentServiceInstanceId: authority.agentServiceInstanceId,
    agentServiceBootId: authority.agentServiceBootId,
    authorityEpoch: authority.product.authorityEpoch,
    fencingToken: authority.product.fencingToken,
    maximumBodyBytes: 131072,
    maximumPayloadBytes: 49152,
    requestTimeoutMs: 60000,
  };
  const handler = new ProductionPayloadBrokerHandler({
    receipts: f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
    results: f.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID),
    payloadsFor: (owner, agent) => f.repository.payloadStore(owner, agent),
    protector: f.f.protector,
    currentAuthority: () => authority,
    clock,
    ids,
    agentServiceInstanceId: common.agentServiceInstanceId,
    agentServiceBootId: common.agentServiceBootId,
    maximumPayloadBytes: common.maximumPayloadBytes,
    allowedContentTypes: ["application/json", "application/octet-stream"],
    sandboxExecutions: f.services.brokerV2,
  });
  const identity = {
    workerInstanceId: authority.workerInstanceId,
    workerBootId: authority.workerBootId,
  };
  const server = new PayloadUdsServer({
    ...common,
    runtimeDirectory: directory,
    allowedWorkerIdentities: [identity],
    handler,
  });
  const payloads = new ProductionPayloadBrokerClient({
    ...common,
    ...identity,
    socketPath: server.socketPath,
    nextId: ids.next,
  });
  const rpc = payloads.sandboxExecution.bind(payloads);
  payloads.sandboxExecution = async (...args) => {
    try {
      const result = await rpc(...args);
      if (args[2].kind === "resolve") await beforeResolvedReply?.();
      return result;
    } catch (error) {
      console.error(JSON.stringify({ queuedLiveRpcFailure: args[2].kind, error: String(error) }));
      throw error;
    }
  };
  const sandbox = new ProductionSandboxExecutionV2({
    configuration: {
      capabilityDeployment: f.capabilityDeployment,
    },
    peer: { ...authority, ...authority.product },
    payloads,
    clock,
  });
  const adapters = [
    {
      capabilityId: f.input.capabilityRef,
      capabilityVersion: f.input.capabilityVersion,
      operations: [f.input.operation],
    },
  ];
  const delegations = new WorkerDelegationStore({
    authorityFence: authority.product.fencingToken,
    adapters,
    now: clock.now,
  });
  const reference = createReferenceAdapterSet({ clock });
  const service = new ExecutionWorkerService({
    handles: delegations,
    capability: {
      ...reference.capability,
      invoke: () => {
        throw new Error("LIVE_TEST_MUST_USE_SANDBOX");
      },
    },
    secrets: reference.secret,
    clock,
    ids,
  });
  const worker = new ProductionExecutionWorker({
    service,
    sandboxV2: sandbox,
    ...identity,
    bootTokenRef: common.credential.tokenRef,
    ...authority.product,
    maximumResourceCeiling: f.input.resourceCeiling,
    adapters,
    delegations,
    now: clock.now,
    nextId: ids.next,
  });
  const close = async () => {
    await worker.shutdown();
    payloads.disconnect();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await server.start();
    await payloads.connect();
    await worker.request(
      executionV2MessageSchema.parse({
        schemaVersion: "execution.v2",
        kind: "request",
        type: "worker.handshake",
        messageId: "queued-live-handshake",
        correlationId: "queued-live-handshake",
        causationId: null,
        dataClassification: "public",
        risk: "low",
        authorizationRef: null,
        idempotencyKey: "queued-live-handshake",
        scope: {
          ...authority.product,
          ownerId: null,
          agentId: null,
          runId: null,
          workerRunId: null,
        },
        payload: {
          agentServiceInstanceId: authority.agentServiceInstanceId,
          bootTokenRef: common.credential.tokenRef,
          supportedSchemaVersions: ["execution.v2"],
          requestedAt: clock.now(),
        },
      }) as ExecutionV2Request,
    );
    return { worker, close, directory };
  } catch (error) {
    await close();
    throw error;
  }
}
