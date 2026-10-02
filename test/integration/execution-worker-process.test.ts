import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const childFixture = path.join(repositoryRoot, "test/fixtures/execution-uds-child.mjs");
const agentChildFixture = path.join(repositoryRoot, "test/fixtures/execution-agent-child.mjs");
let runtimeRoot = path.join(repositoryRoot, "dist/node-runtime");
let installation: string | undefined;
beforeAll(async () => {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  if (!artifact && !context) return;
  if (!artifact || !context) throw new Error("EXECUTION_PROCESS_ARTIFACT_CONTEXT_REQUIRED");
  installation = await mkdtemp(path.join(testTemporaryRoot(), "execution-process-install-"));
  const installed = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      installation,
      "--artifact",
      artifact,
      "--context",
      context,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  if (installed.status !== 0)
    throw new Error(`EXECUTION_PROCESS_INSTALL_FAILED:${installed.stderr}`);
  runtimeRoot = path.join(installation, "lib/himawari-agent");
}, 240_000);
afterAll(async () => {
  if (installation) await rm(installation, { recursive: true, force: true });
});
const credential = Object.freeze({
  tokenRef: "secret-ref-worker-boot-process",
  tokenValue: "abcdef0123456789abcdef0123456789",
});
const agentServiceInstanceId = "agent-service-process-test";
const deploymentId = "deployment-process-test";
const cleanupPaths: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const startupStages: Record<string, unknown>[] = [];
const startupOutput = new Map<number, { stdout: string; stderr: string }>();
const stageFiles = new Map<number, { role: string; file: string }>();
let nextStageId = 0;
async function newStageFile(role: string, runtimeDirectory: string) {
  const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"] ?? runtimeDirectory;
  nextStageId += 1;
  const file = path.join(output, `${role}-stages-${nextStageId}.jsonl`);
  await writeFile(file, "", { mode: 0o600, flag: "wx" });
  return file;
}
function observeStartup(child: ChildProcessWithoutNullStreams, role: string, startedAt: number) {
  const output = { stdout: "", stderr: "" };
  const pending = { stdout: "", stderr: "" };
  function receive(stream: "stdout" | "stderr", chunk: Buffer) {
    const receivedAt = Date.now();
    if (!output[stream].length)
      startupStages.push({ stage: `${role}.first_${stream}`, at: receivedAt, pid: child.pid });
    const content = chunk.toString();
    output[stream] += content;
    pending[stream] += content;
    const lines = pending[stream].split("\n");
    pending[stream] = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let reported: Record<string, unknown>;
      try {
        reported = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        reported["event"] !== `${role}-child.startup` ||
        typeof reported["stage"] !== "string" ||
        typeof reported["at"] !== "number"
      )
        continue;
      startupStages.push({
        stage: `${role}.reported.${reported["stage"]}`,
        at: receivedAt,
        childAt: reported["at"],
        forwardingDelayMs: receivedAt - reported["at"],
        uptimeMs: reported["uptimeMs"],
        pid: child.pid,
        stream,
      });
    }
  }
  startupOutput.set(child.pid ?? -1, output);
  startupStages.push({ stage: `${role}.spawn_called`, at: startedAt, pid: child.pid });
  child.on("spawn", () =>
    startupStages.push({ stage: `${role}.spawned`, at: Date.now(), pid: child.pid }),
  );
  child.stdout.on("data", (chunk: Buffer) => receive("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => receive("stderr", chunk));
  child.once("exit", (code, signal) =>
    startupStages.push({ stage: `${role}.exited`, at: Date.now(), pid: child.pid, code, signal }),
  );
}
let nextId = 0;

afterEach(async (context) => {
  if (
    context.task.result?.state === "fail" ||
    process.env["HIMAWARI_TEST_TIMING_DIAGNOSTICS"] === "1"
  )
    Object.assign(context.task.meta, {
      startupTiming: {
        stages: [...startupStages],
        children: [...startupOutput].map(([pid, output]) => ({ pid, ...output })),
      },
    });
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    }),
  );
  const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
  if (output) {
    const timing = {
      taskId: context.task.id,
      testName: context.task.name,
      runtimeRoot,
      state: context.task.result?.state,
      stages: [...startupStages],
      children: [...startupOutput].map(([pid, captured]) => ({ pid, ...captured })),
      directStages: await Promise.all(
        [...stageFiles].map(async ([pid, entry]) => ({
          pid,
          ...entry,
          stages: (await readFile(entry.file, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        })),
      ),
    };
    Object.assign(context.task.meta, { startupTiming: timing });
    await writeFile(path.join(output, `startup-${context.task.id}.json`), JSON.stringify(timing), {
      mode: 0o600,
      flag: "wx",
    });
  }
  if (context.task.result?.state === "fail" && output)
    for (const cleanupPath of cleanupPaths)
      await cp(cleanupPath, path.join(output, path.basename(cleanupPath)), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (entry) => !(await lstat(entry)).isSocket(),
      });
  children.clear();
  startupStages.length = 0;
  startupOutput.clear();
  stageFiles.clear();
  for (const cleanupPath of cleanupPaths.splice(0)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
});

async function newRuntime(): Promise<string> {
  const runtime = await mkdtemp(path.join(testTemporaryRoot(), "himawari-worker-process-"));
  cleanupPaths.push(runtime);
  return runtime;
}

async function startWorker(runtimeDirectory: string): Promise<ChildProcessWithoutNullStreams> {
  const stageFile = await newStageFile("worker", runtimeDirectory);
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--no-global-search-paths", childFixture], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HIMAWARI_TEST_RUNTIME_ROOT: runtimeRoot,
      NODE_PATH: "",
      HIMAWARI_EXECUTION_TEST_STAGE_FILE: stageFile,
      HIMAWARI_EXECUTION_TEST_RUNTIME: runtimeDirectory,
      HIMAWARI_EXECUTION_TEST_TOKEN_REF: credential.tokenRef,
      HIMAWARI_EXECUTION_TEST_TOKEN_VALUE: credential.tokenValue,
      HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE: agentServiceInstanceId,
      HIMAWARI_EXECUTION_TEST_DEPLOYMENT: deploymentId,
      HIMAWARI_EXECUTION_TEST_STOP: path.join(runtimeDirectory, "stop-worker"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  observeStartup(child, "worker", startedAt);
  stageFiles.set(child.pid ?? -1, { role: "worker", file: stageFile });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Worker child readiness timed out: ${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"ready":true')) {
        startupStages.push({ stage: "worker.ready", at: Date.now(), pid: child.pid });
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
  const stageFile = await newStageFile("agent", runtimeDirectory);
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--no-global-search-paths", agentChildFixture], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HIMAWARI_TEST_RUNTIME_ROOT: runtimeRoot,
      NODE_PATH: "",
      HIMAWARI_EXECUTION_TEST_STAGE_FILE: stageFile,
      HIMAWARI_EXECUTION_TEST_RUNTIME: runtimeDirectory,
      HIMAWARI_EXECUTION_TEST_TOKEN_REF: credential.tokenRef,
      HIMAWARI_EXECUTION_TEST_TOKEN_VALUE: credential.tokenValue,
      HIMAWARI_EXECUTION_TEST_AGENT_INSTANCE: agentServiceInstanceId,
      HIMAWARI_EXECUTION_TEST_DEPLOYMENT: deploymentId,
      HIMAWARI_EXECUTION_AGENT_TEST_STOP: path.join(runtimeDirectory, "stop-agent"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  observeStartup(child, "agent", startedAt);
  stageFiles.set(child.pid ?? -1, { role: "agent", file: stageFile });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`Agent child acceptance timed out: ${stderr}`)),
      15_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"accepted":true')) {
        startupStages.push({ stage: "agent.accepted", at: Date.now(), pid: child.pid });
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

// Restart/crash cases have two serial 15-second readiness phases plus UDS operations.
describe("Execution Worker real process boundary", { timeout: 60_000 }, () => {
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
