import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  initializeStateRoot,
  writeAgentServiceBootBinding,
  writeAuthorityFile,
} from "@himawari-agent/platform-node";
import { createV02Fixture } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_WORKER_SERVICE_ERROR_CODES,
  runExecutionWorkerService,
} from "../src/service-main.js";

const roots: string[] = [];
const FIXTURE_SCOPE = createV02Fixture().scope;
const FAST_STARTUP_TIMING = Object.freeze({
  startupWaitTimeoutMs: 100,
  startupRetryDelayMs: 1,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configuration(stateRoot: string) {
  return {
    schemaVersion: "himawari.configuration.v1",
    deploymentId: FIXTURE_SCOPE.authority.deploymentId,
    ownerId: FIXTURE_SCOPE.ownerId,
    agentId: FIXTURE_SCOPE.agentId,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "deterministic",
        model: "primary",
        version: "v1",
        priority: 1,
        name: "Primary",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 1_024,
        allowedDataClassifications: ["public"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "deterministic",
        model: "fallback",
        version: "v1",
        priority: 2,
        name: "Fallback",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 1_024,
        allowedDataClassifications: ["private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "embedding",
        version: "v1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1,
        allowedDataClassifications: ["public"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "fixture",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 0, perCategory: {} },
    deadlines: { runMs: 10_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

function authority(authorityEpoch: number, fencingToken: number) {
  return {
    id: FIXTURE_SCOPE.authority.deploymentId,
    ownerId: FIXTURE_SCOPE.ownerId,
    agentId: FIXTURE_SCOPE.agentId,
    revision: authorityEpoch,
    status: "active" as const,
    authorityEpoch,
    fencingToken,
    transferId: null,
  };
}

function capture() {
  let contents = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      contents += chunk.toString();
      callback();
    },
  });
  return Object.freeze({ stream, text: () => contents });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-service-main-"));
  roots.push(root);
  const layout = await initializeStateRoot(root);
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(configurationPath, JSON.stringify(configuration(root)), { mode: 0o600 });
  await writeFile(
    path.join(root, "worker-token.json"),
    JSON.stringify({
      tokenRef: "worker-service-main",
      tokenValue: "0123456789abcdef0123456789abcdef",
    }),
    { mode: 0o600 },
  );
  const currentAuthority = authority(1, 1);
  await writeAuthorityFile(layout, currentAuthority);
  return Object.freeze({ root, layout, configurationPath, currentAuthority });
}

function serviceArguments(configurationPath: string): readonly string[] {
  return [
    "--config",
    configurationPath,
    "--worker-token-file",
    path.join(path.dirname(configurationPath), "worker-token.json"),
    "--profile",
    "production",
  ];
}

describe("execution Worker service main", () => {
  it("fails closed when Agent boot binding is absent", async () => {
    const { configurationPath } = await fixture();
    const diagnostics = capture();

    await expect(
      runExecutionWorkerService(
        serviceArguments(configurationPath),
        diagnostics.stream,
        diagnostics.stream,
        FAST_STARTUP_TIMING,
      ),
    ).resolves.toBe(1);
    expect(JSON.parse(diagnostics.text())).toMatchObject({
      component: "execution-worker",
      event: "service.failed",
      code: EXECUTION_WORKER_SERVICE_ERROR_CODES.STARTUP_TIMEOUT,
    });
  }, 5_000);

  it.each([true, false])(
    "rejects a stale worker boot binding (authority advanced: %s)",
    async (advanceAuthority) => {
      const { configurationPath, layout, currentAuthority } = await fixture();
      await writeAgentServiceBootBinding(layout, {
        workerInstanceId: `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`,
        workerBootId: "worker-boot:old",
        agentServiceInstanceId: `agent-service:${FIXTURE_SCOPE.authority.deploymentId}`,
        agentServiceBootId: "agent-service-boot:old",
        authorityLeaseId: "authority:worker-service-main:old",
        authority: currentAuthority,
      });
      if (advanceAuthority) await writeAuthorityFile(layout, authority(2, 2));
      const diagnostics = capture();

      await expect(
        runExecutionWorkerService(
          serviceArguments(configurationPath),
          diagnostics.stream,
          diagnostics.stream,
          FAST_STARTUP_TIMING,
        ),
      ).resolves.toBe(1);
      expect(JSON.parse(diagnostics.text())).toMatchObject({
        component: "execution-worker",
        event: "service.failed",
        code: EXECUTION_WORKER_SERVICE_ERROR_CODES.STARTUP_TIMEOUT,
      });
    },
    5_000,
  );
});
