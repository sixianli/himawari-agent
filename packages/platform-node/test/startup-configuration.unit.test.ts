// biome-ignore-all lint/complexity/useLiteralKeys: mutable unknown-record fixtures exercise strict JSON parsing
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIGURATION_ERROR_CODES,
  CONFIGURATION_SCHEMA_VERSION,
  DRAIN_PHASES,
  initializeStateRoot,
  JsonFileConfigurationPort,
  parseProductConfiguration,
  RuntimeHealthModel,
  readAuthorityFile,
  ServiceLifecycleError,
  STARTUP_PHASES,
  STATE_ROOT_ERROR_CODES,
  StartupDrainCoordinator,
  writeAuthorityFile,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(stateRoot: string): Record<string, unknown> {
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-config-01",
    ownerId: "owner-config-01",
    agentId: "agent-config-01",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "https://agent.example.test",
    publicMode: true,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "provider-primary",
        model: "model-a",
        version: "snapshot-1",
        priority: 1,
        name: "Primary fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text", "tool_calling"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["public", "private"],
        disclosure: "trusted_remote",
        secretRef: "provider-primary",
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "provider-fallback",
        model: "model-b",
        version: "snapshot-1",
        priority: 2,
        name: "Fallback fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["private"],
        disclosure: "external_remote",
        secretRef: "provider-fallback",
        providerRouting: {
          order: ["z-ai"],
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
        },
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "provider-embedding",
        model: "embed-a",
        version: "snapshot-1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1536,
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "trusted_remote",
        secretRef: "provider-embedding",
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: ["sixianli/himawari-agent"],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "provider-primary", version: "v1", purpose: "model-auth", scope: "model-primary" },
      {
        ref: "provider-fallback",
        version: "v1",
        purpose: "model-auth",
        scope: "model-fallback",
      },
      {
        ref: "provider-embedding",
        version: "v1",
        purpose: "embedding-auth",
        scope: "model-embedding",
      },
    ],
    budgets: {
      globalCostMicros: 10_000_000,
      perRunCostMicros: 100_000,
      perClassificationCostMicros: {
        public: 100_000,
        private: 100_000,
        sensitive: 50_000,
        restricted: 0,
      },
    },
    concurrency: {
      totalRuns: 8,
      foregroundReserved: 2,
      perCategory: { research: 4, maintenance: 2 },
    },
    deadlines: { runMs: 300_000, workerRequestMs: 30_000, providerRequestMs: 60_000 },
  };
}

describe("strict product configuration", () => {
  it("loads a versioned configuration without deriving paths from cwd", async () => {
    const stateRoot = path.join(tmpdir(), "himawari-explicit-state-root");
    const parsed = parseProductConfiguration(config(stateRoot), "2026-08-27T00:00:00.000Z");
    expect(parsed).toMatchObject({
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      stateRoot,
      runtimeDirectory: path.join(stateRoot, "runtime"),
      cacheDirectory: path.join(stateRoot, "cache"),
      publicMode: true,
      concurrency: { totalRuns: 8, foregroundReserved: 2 },
    });
    expect(parsed.modelDescriptors[1]?.providerRouting).toEqual({
      order: ["z-ai"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    });
    expect(parsed.modelDescriptors[0]).toMatchObject({
      role: "primary",
      capabilities: ["text", "tool_calling"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    });
    expect(parsed.modelDescriptors[2]).toMatchObject({
      role: "embedding",
      capabilities: ["embedding"],
      dimensions: 1536,
    });
    expect(parsed.stateRoot).not.toBe(process.cwd());
  });

  it("rejects unknown fields recursively and raw machine-secret material", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-reject");
    expect(() =>
      parseProductConfiguration({ ...config(stateRoot), surprise: true }, new Date().toISOString()),
    ).toThrowError(expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD }));
    const nested = config(stateRoot);
    nested["memory"] = { ...(nested["memory"] as object), vendorDefault: true };
    expect(() => parseProductConfiguration(nested, new Date().toISOString())).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD }),
    );
    const invalidRouting = config(stateRoot);
    const invalidModels = invalidRouting["modelDescriptors"] as Record<string, unknown>[];
    invalidRouting["modelDescriptors"] = [
      ...invalidModels.map((entry, index) =>
        index === 1 ? { ...entry, providerRouting: { order: ["z-ai", "z-ai"] } } : entry,
      ),
    ];
    expect(() => parseProductConfiguration(invalidRouting, new Date().toISOString())).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
    );
    const secret = config(stateRoot);
    secret["repositoryAllowlistRefs"] = ["password=machine-secret-value"];
    expect(() => parseProductConfiguration(secret, new Date().toISOString())).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.SECRET_MATERIAL }),
    );
  });

  it("rejects relative paths, insecure public origins, duplicate descriptors, and unsafe limits", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-invalid");
    const relative = config(stateRoot);
    relative["stateRoot"] = "relative/state";
    expect(() => parseProductConfiguration(relative, new Date().toISOString())).toThrowError();
    const insecure = config(stateRoot);
    insecure["publicOrigin"] = "http://agent.example.test";
    expect(() => parseProductConfiguration(insecure, new Date().toISOString())).toThrowError();
    const missingFallback = config(stateRoot);
    missingFallback["modelDescriptors"] = (missingFallback["modelDescriptors"] as unknown[]).filter(
      (entry) => (entry as { role: string }).role !== "fallback",
    );
    expect(() =>
      parseProductConfiguration(missingFallback, new Date().toISOString()),
    ).toThrowError();
    const invalidConcurrency = config(stateRoot);
    invalidConcurrency["concurrency"] = {
      totalRuns: 1,
      foregroundReserved: 2,
      perCategory: {},
    };
    expect(() =>
      parseProductConfiguration(invalidConcurrency, new Date().toISOString()),
    ).toThrowError();
    const mismatchedEmbedding = config(stateRoot);
    mismatchedEmbedding["memory"] = {
      ...(mismatchedEmbedding["memory"] as object),
      dimensions: 1024,
    };
    expect(() =>
      parseProductConfiguration(mismatchedEmbedding, new Date().toISOString()),
    ).toThrowError();
    const publicFallback = config(stateRoot);
    const publicFallbackModels = publicFallback["modelDescriptors"] as Record<string, unknown>[];
    publicFallback["modelDescriptors"] = publicFallbackModels.map((entry, index) =>
      index === 1 ? { ...entry, allowedDataClassifications: ["public"] } : entry,
    );
    expect(() =>
      parseProductConfiguration(publicFallback, new Date().toISOString()),
    ).toThrowError();
    const generationFieldOnEmbedding = config(stateRoot);
    const embeddingModels = generationFieldOnEmbedding["modelDescriptors"] as Record<
      string,
      unknown
    >[];
    generationFieldOnEmbedding["modelDescriptors"] = embeddingModels.map((entry, index) =>
      index === 2 ? { ...entry, input: ["text"] } : entry,
    );
    expect(() =>
      parseProductConfiguration(generationFieldOnEmbedding, new Date().toISOString()),
    ).toThrowError(expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD }));
    const missingGenerationCapability = config(stateRoot);
    const missingGenerationCapabilityModels = missingGenerationCapability[
      "modelDescriptors"
    ] as Record<string, unknown>[];
    missingGenerationCapability["modelDescriptors"] = missingGenerationCapabilityModels.map(
      (entry, index) => (index === 0 ? { ...entry, capabilities: ["tool_calling"] } : entry),
    );
    expect(() =>
      parseProductConfiguration(missingGenerationCapability, new Date().toISOString()),
    ).toThrowError();
    const missingEmbeddingCapability = config(stateRoot);
    const missingEmbeddingCapabilityModels = missingEmbeddingCapability[
      "modelDescriptors"
    ] as Record<string, unknown>[];
    missingEmbeddingCapability["modelDescriptors"] = missingEmbeddingCapabilityModels.map(
      (entry, index) => (index === 2 ? { ...entry, capabilities: ["text"] } : entry),
    );
    expect(() =>
      parseProductConfiguration(missingEmbeddingCapability, new Date().toISOString()),
    ).toThrowError();
  });

  it("reads only a regular non-writable-by-others JSON file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-config-file-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const configurationPath = path.join(root, "configuration.json");
    await writeFile(configurationPath, JSON.stringify(config(stateRoot)), { mode: 0o600 });
    await expect(
      new JsonFileConfigurationPort(configurationPath, () => "2026-08-27T00:00:00.000Z").load(),
    ).resolves.toMatchObject({ stateRoot });
    await chmod(configurationPath, 0o666);
    await expect(new JsonFileConfigurationPort(configurationPath).load()).rejects.toMatchObject({
      code: CONFIGURATION_ERROR_CODES.FILE_UNSAFE,
    });
    const link = path.join(root, "configuration-link.json");
    await symlink(configurationPath, link);
    await expect(new JsonFileConfigurationPort(link).load()).rejects.toMatchObject({
      code: CONFIGURATION_ERROR_CODES.FILE_UNSAFE,
    });
  });
});

describe("state-root lifecycle", () => {
  it("creates restricted data/runtime/cache partitions and atomically round-trips authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-state-root-parent-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const layout = await initializeStateRoot(stateRoot);
    for (const directory of [layout.root, layout.data, layout.runtime, layout.cache]) {
      expect((await lstat(directory)).mode & 0o077).toBe(0);
    }
    const authority = Object.freeze({
      id: createDeploymentId("deployment-state-root"),
      ownerId: createOwnerId("owner-state-root"),
      agentId: createAgentId("agent-state-root"),
      revision: 1,
      status: "active" as const,
      authorityEpoch: 2,
      fencingToken: 3,
      transferId: null,
    });
    await writeAuthorityFile(layout, authority);
    expect((await lstat(layout.authorityFile)).mode & 0o077).toBe(0);
    await expect(readAuthorityFile(layout)).resolves.toEqual(authority);
    expect(await readFile(layout.authorityFile, "utf8")).not.toContain(process.cwd());
  });

  it("refuses an existing broadly accessible root and an unknown authority field", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-state-root-unsafe-"));
    roots.push(root);
    await chmod(root, 0o755);
    await expect(initializeStateRoot(root)).rejects.toMatchObject({
      code: STATE_ROOT_ERROR_CODES.PERMISSIONS_UNSAFE,
    });
    await chmod(root, 0o700);
    const layout = await initializeStateRoot(root);
    await writeFile(layout.authorityFile, '{"schemaVersion":1,"unexpected":true}\n', {
      mode: 0o600,
    });
    await expect(readAuthorityFile(layout)).rejects.toMatchObject({
      code: STATE_ROOT_ERROR_CODES.AUTHORITY_INVALID,
    });
  });
});

function healthyRequired(model: RuntimeHealthModel): void {
  for (const name of [
    "authority",
    "schema",
    "sqlite",
    "payload-keyring",
    "worker",
    "memory-persistence",
    "recovery",
  ]) {
    model.observe({ name, required: true, status: "healthy", reasonCode: null });
  }
}

describe("runtime health model", () => {
  it("separates liveness, readiness, required dependencies and provider degradation", () => {
    const model = new RuntimeHealthModel({ publicMode: false, now: () => "2026-08-27T00:00:00Z" });
    model.setLive(true);
    model.setAuthorityActive(true);
    expect(model.publicSnapshot()).toMatchObject({ live: true, ready: false, status: "not_ready" });
    healthyRequired(model);
    expect(model.publicSnapshot()).toMatchObject({ live: true, ready: true, status: "degraded" });
    model.observe({ name: "model-provider", required: false, status: "healthy", reasonCode: null });
    expect(model.publicSnapshot()).toMatchObject({ ready: true, status: "healthy" });
  });

  it("requires identity trust in public mode and authenticates detailed status", () => {
    const model = new RuntimeHealthModel({ publicMode: true });
    model.setLive(true);
    model.setAuthorityActive(true);
    healthyRequired(model);
    expect(model.publicSnapshot().ready).toBe(false);
    model.observe({ name: "identity-trust", required: true, status: "healthy", reasonCode: null });
    expect(() => model.authenticatedSnapshot(false)).toThrowError("HEALTH_AUTHENTICATION_REQUIRED");
    expect(model.authenticatedSnapshot(true).ready).toBe(true);
  });
});

describe("startup and drain coordinator", () => {
  it.each(STARTUP_PHASES)("rolls back cleanly when startup phase %s fails", async (failedPhase) => {
    const events: string[] = [];
    let fail = true;
    const startup = Object.fromEntries(
      STARTUP_PHASES.map((phase) => [
        phase,
        {
          async start() {
            events.push(`start:${phase}`);
            if (phase === failedPhase && fail) throw new Error("sk-proj-secret-must-not-escape");
          },
          async rollback() {
            events.push(`rollback:${phase}`);
          },
        },
      ]),
    ) as ConstructorParameters<typeof StartupDrainCoordinator>[0]["startup"];
    const drain = Object.fromEntries(
      DRAIN_PHASES.map((phase) => [phase, { async run() {} }]),
    ) as ConstructorParameters<typeof StartupDrainCoordinator>[0]["drain"];
    const coordinator = new StartupDrainCoordinator({ startup, drain });
    const failure = await coordinator.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceLifecycleError);
    expect(JSON.stringify(failure)).not.toContain("secret-must-not-escape");
    expect(coordinator.ready).toBe(false);
    const completedBeforeFailure = STARTUP_PHASES.slice(0, STARTUP_PHASES.indexOf(failedPhase));
    expect(events.filter((event) => event.startsWith("rollback:"))).toEqual(
      [...completedBeforeFailure].reverse().map((phase) => `rollback:${phase}`),
    );
    fail = false;
    await coordinator.start();
    expect(coordinator.ready).toBe(true);
  });

  it.each(DRAIN_PHASES)(
    "continues safe shutdown after drain phase %s fails",
    async (failedPhase) => {
      const events: string[] = [];
      const startup = Object.fromEntries(
        STARTUP_PHASES.map((phase) => [phase, { async start() {}, async rollback() {} }]),
      ) as ConstructorParameters<typeof StartupDrainCoordinator>[0]["startup"];
      const drain = Object.fromEntries(
        DRAIN_PHASES.map((phase) => [
          phase,
          {
            async run() {
              events.push(phase);
              if (phase === failedPhase) throw new Error("private shutdown detail");
            },
          },
        ]),
      ) as ConstructorParameters<typeof StartupDrainCoordinator>[0]["drain"];
      const coordinator = new StartupDrainCoordinator({ startup, drain });
      await coordinator.start();
      await expect(coordinator.drain()).rejects.toMatchObject({
        code: `DRAIN_${failedPhase.toUpperCase().replaceAll("-", "_")}_FAILED`,
      });
      expect(events).toEqual(DRAIN_PHASES);
      expect(coordinator.ready).toBe(false);
    },
  );
});
