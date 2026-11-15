import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  initializeStateRoot,
  readWorkerQualifiedDeployment,
  readWorkerServiceBootBinding,
  writeAgentServiceBootBinding,
  writeAuthorityFile,
  writeWorkerQualifiedDeployment,
} from "@himawari-agent/platform-node";
import { createV02Fixture } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTION_WORKER_SERVICE_ERROR_CODES,
  runExecutionWorkerService,
} from "../src/service-main.js";

const qualification = vi.hoisted(() => ({
  started: 0,
  admittedSnapshotDigest: undefined as string | undefined,
  rejectAfterBinding: undefined as (() => Promise<void>) | undefined,
  beforeCompositionFails: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../src/production-worker-composition.js", async (original) => {
  const actual = await original<typeof import("../src/production-worker-composition.js")>();
  return {
    ...actual,
    qualifyProductionWorkerDeployment: (
      options: Parameters<typeof actual.qualifyProductionWorkerDeployment>[0],
    ) => {
      qualification.started += 1;
      if (qualification.rejectAfterBinding)
        return qualification.rejectAfterBinding().then(() => {
          throw new Error("QUALIFICATION_FAILED_AFTER_BINDING");
        });
      if (qualification.admittedSnapshotDigest)
        return Promise.resolve({
          deployment: { snapshotDigest: qualification.admittedSnapshotDigest, manifests: [] },
          isolation: {},
        } as unknown as Awaited<ReturnType<typeof actual.qualifyProductionWorkerDeployment>>);
      return actual.qualifyProductionWorkerDeployment(options);
    },
    createProductionWorkerComposition: async (
      ...parameters: Parameters<typeof actual.createProductionWorkerComposition>
    ) => {
      if (!qualification.beforeCompositionFails)
        return actual.createProductionWorkerComposition(...parameters);
      await qualification.beforeCompositionFails();
      throw new Error("COMPOSITION_FAILED_AFTER_PUBLISH");
    },
  };
});

const roots: string[] = [];
const FIXTURE_SCOPE = createV02Fixture().scope;
const FAST_STARTUP_TIMING = Object.freeze({
  startupWaitTimeoutMs: 100,
  startupRetryDelayMs: 1,
});

afterEach(async () => {
  qualification.started = 0;
  qualification.admittedSnapshotDigest = undefined;
  qualification.rejectAfterBinding = undefined;
  qualification.beforeCompositionFails = undefined;
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
      adapter: "himawari-sqlite",
      version: "fixture",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
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

  it("checks its capability deployment while the Agent boot binding is still absent", async () => {
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
    expect(qualification.started).toBe(1);
    expect(JSON.parse(diagnostics.text())).toMatchObject({
      code: EXECUTION_WORKER_SERVICE_ERROR_CODES.STARTUP_TIMEOUT,
    });
  }, 5_000);

  it("clears an earlier boot's qualified record and publishes none when startup fails", async () => {
    const { configurationPath, layout } = await fixture();
    await writeWorkerQualifiedDeployment(layout, {
      workerInstanceId: `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`,
      workerBootId: "worker-boot:old",
      deploymentId: FIXTURE_SCOPE.authority.deploymentId,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
    });
    const diagnostics = capture();

    await expect(
      runExecutionWorkerService(
        serviceArguments(configurationPath),
        diagnostics.stream,
        diagnostics.stream,
        FAST_STARTUP_TIMING,
      ),
    ).resolves.toBe(1);
    await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
      code: "STATE_ROOT_BOOT_BINDING_INVALID",
    });
  }, 5_000);

  it("clears an earlier boot's qualified record even when the authority check fails", async () => {
    const { configurationPath, layout } = await fixture();
    await writeWorkerQualifiedDeployment(layout, {
      workerInstanceId: `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`,
      workerBootId: "worker-boot:old",
      deploymentId: FIXTURE_SCOPE.authority.deploymentId,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
    });
    await writeAuthorityFile(layout, { ...authority(2, 2), status: "inactive_ready" });
    const diagnostics = capture();

    await expect(
      runExecutionWorkerService(
        serviceArguments(configurationPath),
        diagnostics.stream,
        diagnostics.stream,
        FAST_STARTUP_TIMING,
      ),
    ).resolves.toBe(1);
    expect(qualification.started).toBe(0);
    await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
      code: "STATE_ROOT_BOOT_BINDING_INVALID",
    });
  }, 5_000);

  it("keeps the qualified record when the authority belongs to another deployment", async () => {
    const { configurationPath, layout } = await fixture();
    const record = {
      workerInstanceId: `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`,
      workerBootId: "worker-boot:other",
      deploymentId: FIXTURE_SCOPE.authority.deploymentId,
      snapshotDigest: `sha256:${"b".repeat(64)}`,
    };
    await writeWorkerQualifiedDeployment(layout, record);
    const base = authority(2, 2);
    await writeAuthorityFile(layout, { ...base, id: `${base.id}-other` as typeof base.id });
    const diagnostics = capture();

    await expect(
      runExecutionWorkerService(
        serviceArguments(configurationPath),
        diagnostics.stream,
        diagnostics.stream,
        FAST_STARTUP_TIMING,
      ),
    ).resolves.toBe(1);
    expect(qualification.started).toBe(0);
    expect(JSON.parse(diagnostics.text())).toMatchObject({
      event: "service.failed",
      code: EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH,
    });
    await expect(readWorkerQualifiedDeployment(layout)).resolves.toMatchObject({
      workerBootId: "worker-boot:other",
    });
  }, 5_000);

  it("publishes no qualified record when the Agent binding arrives but the checks fail", async () => {
    const { configurationPath, layout, currentAuthority } = await fixture();
    let bound = false;
    let publishedBeforeChecksFailed: boolean | undefined;
    qualification.rejectAfterBinding = async () => {
      while (!bound) await new Promise<void>((resolve) => setTimeout(resolve, 2));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      publishedBeforeChecksFailed = await readWorkerQualifiedDeployment(layout).then(
        () => true,
        () => false,
      );
    };
    const diagnostics = capture();
    const running = runExecutionWorkerService(
      serviceArguments(configurationPath),
      diagnostics.stream,
      diagnostics.stream,
      { startupWaitTimeoutMs: 4_000, startupRetryDelayMs: 1 },
    );
    let workerBootId: string | undefined;
    for (let attempt = 0; attempt < 2_000 && !workerBootId; attempt += 1) {
      workerBootId = (await readWorkerServiceBootBinding(layout).catch(() => undefined))
        ?.workerBootId;
      if (!workerBootId) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    await writeAgentServiceBootBinding(layout, {
      workerInstanceId: `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`,
      workerBootId: workerBootId as string,
      agentServiceInstanceId: `agent-service:${FIXTURE_SCOPE.authority.deploymentId}`,
      agentServiceBootId: "agent-service-boot:current",
      authorityLeaseId: "authority:worker-service-main:current",
      authority: currentAuthority,
    });
    bound = true;

    await expect(running).resolves.toBe(1);
    expect(diagnostics.text()).toContain("service.failed");
    expect(publishedBeforeChecksFailed).toBe(false);
    await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
      code: "STATE_ROOT_BOOT_BINDING_INVALID",
    });
  }, 10_000);

  it("publishes the qualified record only after its checks pass and removes it when startup then fails", async () => {
    const { configurationPath, layout, currentAuthority } = await fixture();
    const digest = `sha256:${"b".repeat(64)}`;
    const workerInstanceId = `execution-worker:${FIXTURE_SCOPE.authority.deploymentId}`;
    qualification.admittedSnapshotDigest = digest;
    let publishedBeforeFailure: unknown;
    qualification.beforeCompositionFails = async () => {
      publishedBeforeFailure = await readWorkerQualifiedDeployment(layout);
    };
    const diagnostics = capture();
    const running = runExecutionWorkerService(
      serviceArguments(configurationPath),
      diagnostics.stream,
      diagnostics.stream,
      { startupWaitTimeoutMs: 4_000, startupRetryDelayMs: 1 },
    );
    let workerBootId: string | undefined;
    for (let attempt = 0; attempt < 2_000 && !workerBootId; attempt += 1) {
      workerBootId = (await readWorkerServiceBootBinding(layout).catch(() => undefined))
        ?.workerBootId;
      if (!workerBootId) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(workerBootId).toBeDefined();
    await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
      code: "STATE_ROOT_BOOT_BINDING_INVALID",
    });
    await writeAgentServiceBootBinding(layout, {
      workerInstanceId,
      workerBootId: workerBootId as string,
      agentServiceInstanceId: `agent-service:${FIXTURE_SCOPE.authority.deploymentId}`,
      agentServiceBootId: "agent-service-boot:current",
      authorityLeaseId: "authority:worker-service-main:current",
      authority: currentAuthority,
    });

    await expect(running).resolves.toBe(1);
    expect(publishedBeforeFailure).toEqual({
      schemaVersion: 1,
      workerInstanceId,
      workerBootId,
      deploymentId: FIXTURE_SCOPE.authority.deploymentId,
      snapshotDigest: digest,
    });
    await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
      code: "STATE_ROOT_BOOT_BINDING_INVALID",
    });
  }, 10_000);

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
