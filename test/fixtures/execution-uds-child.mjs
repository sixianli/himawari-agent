import { appendFileSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = process.env.HIMAWARI_TEST_RUNTIME_ROOT;
if (!root) throw new Error("INSTALLED_RUNTIME_REQUIRED");
const loadPackage = (name) =>
  import(pathToFileURL(path.join(root, "node_modules", name, "dist/index.js")).href);
const [{ ExecutionUdsServer }, { EXECUTION_V2_SCHEMA_VERSION, executionV2MessageSchema }] =
  await Promise.all([
    loadPackage("@himawari-agent/platform-node"),
    loadPackage("@himawari-agent/execution-contracts"),
  ]);

function startupStage(stage) {
  const line = `${JSON.stringify({
    event: "worker-child.startup",
    stage,
    at: Date.now(),
    uptimeMs: process.uptime() * 1000,
    pid: process.pid,
  })}\n`;
  const stageFile = process.env["HIMAWARI_EXECUTION_TEST_STAGE_FILE"];
  if (stageFile) appendFileSync(stageFile, line);
  process.stderr.write(line);
}
startupStage("module_loaded");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const runtimeDirectory = requiredEnvironment("HIMAWARI_EXECUTION_TEST_RUNTIME");
const tokenRef = requiredEnvironment("HIMAWARI_EXECUTION_TEST_TOKEN_REF");
const tokenValue = requiredEnvironment("HIMAWARI_EXECUTION_TEST_TOKEN_VALUE");
const agentServiceInstanceId = requiredEnvironment("HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE");
const deploymentId = requiredEnvironment("HIMAWARI_EXECUTION_TEST_DEPLOYMENT");
const authorityEpoch = 4;
const fencingToken = 7;
let nextMessageId = 0;

class ChildWorkerTransport {
  storedEvents = [];
  handled = new Set();
  sequence = new Map();
  cursor = 0;

  async request(message) {
    this.assertFence(message);
    if (message.type === "worker.handshake") {
      if (
        message.payload.bootTokenRef !== tokenRef ||
        message.payload.agentServiceInstanceId !== agentServiceInstanceId ||
        !message.payload.supportedSchemaVersions.includes(EXECUTION_V2_SCHEMA_VERSION)
      ) {
        throw new Error("WORKER_HANDSHAKE_REJECTED");
      }
      return this.response(message, "worker.handshake.accepted", {
        workerInstanceId: "execution-worker-child",
        workerBootId: `worker-boot-${String(process.pid)}`,
        selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        ready: true,
        acceptedAt: new Date().toISOString(),
      });
    }
    if (message.type === "worker.readiness.query") {
      return this.response(message, "worker.readiness.snapshot", {
        workerInstanceId: "execution-worker-child",
        live: true,
        ready: true,
        supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
        reasonCodes: [],
        observedAt: new Date().toISOString(),
      });
    }
    if (message.type === "work.events.replay") return null;
    if (this.handled.has(message.idempotencyKey)) return null;
    this.handled.add(message.idempotencyKey);

    if (message.type === "work.delegate") {
      return this.response(message, "work.delegate.accepted", {
        handleRef: message.payload.handle.ref,
        workerBootId: `worker-boot-${String(process.pid)}`,
        acceptedAt: new Date().toISOString(),
      });
    }

    if (message.type === "work.execute") {
      if (message.payload.capabilityHandleRef === "capability-handle-stale") {
        this.result(message, "failed", null, "PORT_HANDLE_REVOKED", null);
      } else if (message.payload.capabilityId === "external-unknown") {
        this.result(message, "result_unknown", null, null, `external:${message.messageId}`);
      } else {
        this.result(message, "succeeded", `payload-result:${message.messageId}`, null, null);
      }
      return null;
    }
    if (message.type === "work.cancel") {
      this.append(message, "work.cancelled", {
        requestId: message.payload.targetRequestId,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(message.payload.targetRequestId),
        cancelledAt: new Date().toISOString(),
        reasonCode: message.payload.reasonCode,
      });
      return null;
    }
    if (message.type === "environment.operation.execute") {
      this.append(message, "environment.operation.result", {
        requestId: message.messageId,
        operation: message.payload.operation,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(message.messageId),
        outcome: "failed",
        result: null,
        errorCode: "WORKER_ADAPTER_NOT_REGISTERED",
        completedAt: new Date().toISOString(),
      });
      return null;
    }
    if (message.type === "host.operation.execute") {
      this.append(message, "host.operation.result", {
        requestId: message.messageId,
        operation: message.payload.operation,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(message.messageId),
        outcome: "failed",
        outputRef: null,
        errorCode: "WORKER_ADAPTER_NOT_REGISTERED",
        fileObservationRefs: [],
        networkObservationRefs: [],
        completedAt: new Date().toISOString(),
      });
      return null;
    }
    if (message.type === "worker.subtask.execute") {
      this.append(message, "worker.subtask.result", {
        requestId: message.messageId,
        delegationId: message.payload.delegationId,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(message.messageId),
        outcome: "failed",
        workerResultRef: null,
        errorCode: "WORKER_SUBTASK_ADAPTER_NOT_REGISTERED",
        actualModelRef: null,
        actualCostMicros: 0,
        durationMs: 0,
        completedAt: new Date().toISOString(),
      });
      return null;
    }
    this.append(message, "work.reconciled", {
      requestId: message.payload.targetRequestId,
      externalActionId: message.payload.externalActionId,
      cursor: this.nextCursor(),
      sequence: this.nextSequence(message.payload.targetRequestId),
      reconciledAt: new Date().toISOString(),
      outcome: "still_unknown",
      resultRef: null,
      errorCode: null,
    });
    return null;
  }

  async *events(afterCursor) {
    let start = 0;
    if (afterCursor !== null) {
      const index = this.storedEvents.findIndex(
        (event) => "cursor" in event.payload && event.payload.cursor === afterCursor,
      );
      if (index < 0) throw new Error("WORKER_CURSOR_NOT_FOUND");
      start = index + 1;
    }
    for (const event of this.storedEvents.slice(start)) yield event;
  }

  assertFence(message) {
    if (
      message.scope.deploymentId !== deploymentId ||
      message.scope.authorityEpoch !== authorityEpoch ||
      message.scope.fencingToken !== fencingToken
    ) {
      throw new Error("WORKER_STALE_FENCE");
    }
  }

  result(message, outcome, outputRef, errorCode, externalActionId) {
    this.append(message, "work.result", {
      requestId: message.messageId,
      cursor: this.nextCursor(),
      sequence: this.nextSequence(message.messageId),
      completedAt: new Date().toISOString(),
      outcome,
      outputRef,
      errorCode,
      externalActionId,
    });
  }

  append(request, type, payload) {
    nextMessageId += 1;
    const parsed = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event",
      type,
      messageId: `worker-child-event-${nextMessageId}`,
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload,
    });
    if (parsed.kind !== "event") throw new TypeError("Child Worker event is invalid");
    this.storedEvents.push(parsed);
  }

  response(request, type, payload) {
    nextMessageId += 1;
    const parsed = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response",
      type,
      messageId: `worker-child-response-${nextMessageId}`,
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload,
    });
    if (parsed.kind !== "response" || parsed.type !== type) {
      throw new TypeError("Child Worker response is invalid");
    }
    return parsed;
  }

  nextCursor() {
    this.cursor += 1;
    return `worker-child-cursor-${this.cursor}`;
  }

  nextSequence(requestId) {
    const value = (this.sequence.get(requestId) ?? 0) + 1;
    this.sequence.set(requestId, value);
    return value;
  }
}

async function startExecutionUdsChild() {
  const server = new ExecutionUdsServer({
    runtimeDirectory,
    credential: { tokenRef, tokenValue },
    allowedAgentServiceInstanceIds: [agentServiceInstanceId],
    transport: new ChildWorkerTransport(),
    maximumBodyBytes: 65_536,
    requestTimeoutMs: 2_000,
  });
  await server.start();
  return server;
}

const { HIMAWARI_EXECUTION_TEST_STOP: stopPath } = process.env;
if (!stopPath) throw new Error("Missing HIMAWARI_EXECUTION_TEST_STOP");
startupStage("test_entered");
startupStage("server_start.begin");
const server = await startExecutionUdsChild();
startupStage("server_start.end");
process.stdout.write(`${JSON.stringify({ ready: true, socketPath: server.socketPath })}\n`);
while (true) {
  try {
    await access(stopPath);
    break;
  } catch {
    await delay(20);
  }
}
await server.stop();
