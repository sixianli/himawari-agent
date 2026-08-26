import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentServiceExecutionClient } from "@himawari-agent/agent-service";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { EXECUTION_UDS_ERROR_CODES } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const childFixture = path.join(repositoryRoot, "test/fixtures/execution-uds-child.test.ts");
const childConfig = path.join(repositoryRoot, "test/fixtures/vitest.execution-uds-child.config.ts");
const agentChildFixture = path.join(repositoryRoot, "test/fixtures/execution-agent-child.test.ts");
const agentChildConfig = path.join(
  repositoryRoot,
  "test/fixtures/vitest.execution-agent-child.config.ts",
);
const vitestPath = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs");
const credential = Object.freeze({
  tokenRef: "secret-ref-worker-boot-process",
  tokenValue: "abcdef0123456789abcdef0123456789",
});
const agentServiceInstanceId = "agent-service-process-test";
const deploymentId = "deployment-process-test";
const cleanupPaths: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let nextId = 0;

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const cleanupPath of cleanupPaths.splice(0)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
});

async function newRuntime(): Promise<string> {
  const runtime = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-process-"));
  cleanupPaths.push(runtime);
  return runtime;
}

async function startWorker(runtimeDirectory: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [vitestPath, "run", "--config", childConfig, "--run", childFixture],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HIMAWARI_EXECUTION_TEST_RUNTIME: runtimeDirectory,
        HIMAWARI_EXECUTION_TEST_TOKEN_REF: credential.tokenRef,
        HIMAWARI_EXECUTION_TEST_TOKEN_VALUE: credential.tokenValue,
        HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE: agentServiceInstanceId,
        HIMAWARI_EXECUTION_TEST_DEPLOYMENT: deploymentId,
        HIMAWARI_EXECUTION_TEST_STOP: path.join(runtimeDirectory, "stop-worker"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Worker child readiness timed out: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"ready":true')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Worker child exited before ready: ${code ?? signal}: ${stderr}`));
    });
  });
  return child;
}

async function startAgentClient(runtimeDirectory: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [vitestPath, "run", "--config", agentChildConfig, "--run", agentChildFixture],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HIMAWARI_EXECUTION_TEST_RUNTIME: runtimeDirectory,
        HIMAWARI_EXECUTION_TEST_TOKEN_REF: credential.tokenRef,
        HIMAWARI_EXECUTION_TEST_TOKEN_VALUE: credential.tokenValue,
        HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE: agentServiceInstanceId,
        HIMAWARI_EXECUTION_TEST_DEPLOYMENT: deploymentId,
        HIMAWARI_EXECUTION_AGENT_TEST_STOP: path.join(runtimeDirectory, "stop-agent"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`Agent child acceptance timed out: ${stderr}`)),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"accepted":true')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Agent child exited before acceptance: ${code ?? signal}: ${stderr}`));
    });
  });
  return child;
}

async function stopWorker(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  runtimeDirectory: string,
) {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (signal === "SIGKILL") child.kill(signal);
  else await writeFile(path.join(runtimeDirectory, "stop-worker"), "stop", { mode: 0o600 });
  await exited;
  children.delete(child);
}

function client(runtimeDirectory: string): AgentServiceExecutionClient {
  return new AgentServiceExecutionClient({
    socketPath: path.join(runtimeDirectory, "execution.sock"),
    credential,
    agentServiceInstanceId,
    maximumBodyBytes: 65_536,
    requestTimeoutMs: 1_000,
    deploymentId,
    authorityEpoch: 4,
    fencingToken: 7,
    now: () => new Date().toISOString(),
    nextId: (scope) => {
      nextId += 1;
      return `${scope}-${nextId}`;
    },
  });
}

function requestEnvelope(type: string, fence = 7) {
  nextId += 1;
  return {
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type,
    messageId: `process-message-${nextId}`,
    correlationId: "correlation-worker-process",
    causationId: "worker-delegated-process",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: {
      deploymentId,
      authorityEpoch: 4,
      fencingToken: fence,
      ownerId: "owner-worker-process",
      agentId: "agent-worker-process",
      runId: "run-worker-process",
      workerRunId: "worker-run-process",
    },
    idempotencyKey: `process-idempotency-${nextId}`,
  };
}

function execute(
  options: {
    readonly capabilityId?: string;
    readonly capabilityHandleRef?: string;
    readonly fence?: number;
  } = {},
): Extract<ExecutionV2Request, { type: "work.execute" }> {
  return executionV2MessageSchema.parse({
    ...requestEnvelope("work.execute", options.fence),
    payload: {
      capabilityId: options.capabilityId ?? "child-read-adapter",
      capabilityVersion: "1.0.0",
      operation: "read",
      inputRef: "payload-input-worker-process",
      capabilityHandleRef: options.capabilityHandleRef ?? "capability-handle-worker-process",
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
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

async function events(
  executionClient: AgentServiceExecutionClient,
  afterCursor: string | null = null,
): Promise<ExecutionV2Event[]> {
  const result: ExecutionV2Event[] = [];
  for await (const event of executionClient.events(afterCursor)) result.push(event);
  return result;
}

describe("Execution Worker real process boundary", () => {
  it("runs work, cancellation, cursor reconnect and unknown-result reconciliation across UDS", async () => {
    const runtime = await newRuntime();
    const worker = await startWorker(runtime);
    const executionClient = client(runtime);
    await expect(executionClient.start()).resolves.toMatchObject({
      type: "worker.handshake.accepted",
      payload: { ready: true, selectedSchemaVersion: "execution.v2" },
    });
    expect((await lstat(runtime)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(runtime, "execution.sock"))).mode & 0o777).toBe(0o600);

    const successful = execute();
    await executionClient.request(successful);
    await executionClient.request(successful);
    const initial = await events(executionClient);
    expect(initial).toMatchObject([{ type: "work.result", payload: { outcome: "succeeded" } }]);
    const initialPayload = initial[0]?.payload;
    if (!initialPayload || !("cursor" in initialPayload)) throw new TypeError("cursor missing");

    const replacementClient = client(runtime);
    await replacementClient.start();
    await expect(events(replacementClient, initialPayload.cursor)).resolves.toEqual([]);

    const staleHandle = execute({ capabilityHandleRef: "capability-handle-stale" });
    await replacementClient.request(staleHandle);
    const unknown = execute({ capabilityId: "external-unknown" });
    await replacementClient.request(unknown);
    const cancel = executionV2MessageSchema.parse({
      ...requestEnvelope("work.cancel"),
      payload: {
        targetRequestId: successful.messageId,
        reasonCode: "owner-requested",
        requestedAt: new Date().toISOString(),
      },
    });
    if (cancel.kind !== "request") throw new TypeError("cancel fixture is invalid");
    await replacementClient.request(cancel);
    const reconcile = executionV2MessageSchema.parse({
      ...requestEnvelope("work.reconcile"),
      payload: {
        targetRequestId: unknown.messageId,
        externalActionId: `external:${unknown.messageId}`,
        resultLookupRef: "payload-result-lookup-process",
        requestedAt: new Date().toISOString(),
      },
    });
    if (reconcile.kind !== "request") throw new TypeError("reconcile fixture is invalid");
    await replacementClient.request(reconcile);
    const resumed = await events(replacementClient, initialPayload.cursor);
    expect(resumed.map(({ type }) => type)).toEqual([
      "work.result",
      "work.result",
      "work.cancelled",
      "work.reconciled",
    ]);
    expect(resumed[0]).toMatchObject({ payload: { errorCode: "PORT_HANDLE_REVOKED" } });
    expect(resumed[1]).toMatchObject({
      payload: { outcome: "result_unknown", externalActionId: `external:${unknown.messageId}` },
    });
    expect(resumed[3]).toMatchObject({ payload: { outcome: "still_unknown" } });
    await stopWorker(worker, "SIGTERM", runtime);
  });

  it("rejects stale fences and never falls back in-process when the Worker crashes", async () => {
    const runtime = await newRuntime();
    const worker = await startWorker(runtime);
    const executionClient = client(runtime);
    await executionClient.start();
    await expect(executionClient.request(execute({ fence: 6 }))).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED,
    });
    await stopWorker(worker, "SIGKILL", runtime);
    await expect(executionClient.request(execute())).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    });
    expect(executionClient.isReady()).toBe(false);

    const restarted = await startWorker(runtime);
    const reconnected = client(runtime);
    await expect(reconnected.start()).resolves.toMatchObject({ payload: { ready: true } });
    await reconnected.request(execute());
    await expect(events(reconnected)).resolves.toMatchObject([
      { type: "work.result", payload: { outcome: "succeeded" } },
    ]);
    await stopWorker(restarted, "SIGTERM", runtime);
  });

  it("keeps one result when the real Agent client process crashes after dispatch", async () => {
    const runtime = await newRuntime();
    const worker = await startWorker(runtime);
    const agentChild = await startAgentClient(runtime);
    await stopWorker(agentChild, "SIGKILL", runtime);

    const reconnected = client(runtime);
    await reconnected.start();
    const accepted = await events(reconnected);
    expect(accepted).toMatchObject([
      {
        type: "work.result",
        payload: { requestId: "agent-child-execute", outcome: "succeeded" },
      },
    ]);
    const duplicate = executionV2MessageSchema.parse({
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
        deploymentId,
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
    if (duplicate.kind !== "request") throw new TypeError("duplicate fixture is invalid");
    await reconnected.request(duplicate);
    expect(await events(reconnected)).toHaveLength(1);
    await stopWorker(worker, "SIGTERM", runtime);
  });
});
