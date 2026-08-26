import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentServiceExecutionClient } from "@himawari-agent/agent-service";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { describe, it } from "vitest";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

describe("Execution Agent client child process fixture", () => {
  it("dispatches one stable request and remains alive until killed", async () => {
    const runtimeDirectory = required("HIMAWARI_EXECUTION_TEST_RUNTIME");
    const stopPath = required("HIMAWARI_EXECUTION_AGENT_TEST_STOP");
    const client = new AgentServiceExecutionClient({
      socketPath: path.join(runtimeDirectory, "execution.sock"),
      credential: {
        tokenRef: required("HIMAWARI_EXECUTION_TEST_TOKEN_REF"),
        tokenValue: required("HIMAWARI_EXECUTION_TEST_TOKEN_VALUE"),
      },
      agentServiceInstanceId: required("HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE"),
      maximumBodyBytes: 65_536,
      requestTimeoutMs: 1_000,
      deploymentId: required("HIMAWARI_EXECUTION_TEST_DEPLOYMENT"),
      authorityEpoch: 4,
      fencingToken: 7,
      now: () => new Date().toISOString(),
      nextId: (scope) => `${scope}-agent-child`,
    });
    await client.start();
    const request = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.execute",
      messageId: "agent-child-execute",
      correlationId: "correlation-agent-child",
      causationId: "worker-delegated-agent-child",
      dataClassification: "private",
      risk: "low",
      authorizationRef: null,
      scope: {
        deploymentId: required("HIMAWARI_EXECUTION_TEST_DEPLOYMENT"),
        authorityEpoch: 4,
        fencingToken: 7,
        ownerId: "owner-worker-process",
        agentId: "agent-worker-process",
        runId: "run-worker-process",
        workerRunId: "worker-run-agent-child",
      },
      idempotencyKey: "agent-child-idempotency",
      payload: {
        capabilityId: "child-read-adapter",
        capabilityVersion: "1.0.0",
        operation: "read",
        inputRef: "payload-input-agent-child",
        capabilityHandleRef: "capability-handle-agent-child",
        delegatedContextRefs: [],
        secretRefs: [],
        resourceCeiling: {
          maxWallTimeMs: 10_000,
          maxCpuTimeMs: 5_000,
          maxMemoryBytes: 16_777_216,
          maxOutputBytes: 1_024,
          maxProgressEvents: 10,
        },
        requestedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    if (request.kind !== "request") throw new TypeError("Agent child request is invalid");
    await client.request(request);
    process.stdout.write(`${JSON.stringify({ accepted: true })}\n`);
    while (true) {
      try {
        await access(stopPath);
        break;
      } catch {
        await delay(20);
      }
    }
  }, 30_000);
});
