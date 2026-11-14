// biome-ignore-all lint/complexity/useLiteralKeys: mutable unknown-record fixtures exercise strict JSON parsing
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_HOME_FEED,
  DEFAULT_SEARCH_ASK,
  DEVICE_HARD_LIMIT_KEYS,
  IMPORT_DUPLICATE_DEFAULTS,
  PERCEPTION_CONFIGURATION_DEFAULTS,
  PERCEPTION_CONFIGURATION_RANGES,
  type PerceptionConfiguration,
} from "@himawari-agent/application";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIGURATION_ERROR_CODES,
  CONFIGURATION_SCHEMA_VERSION,
  DEVICE_ACCESS_SECRET_PURPOSES,
  DRAIN_PHASES,
  initializeStateRoot,
  JsonFileConfigurationPort,
  parseProductConfiguration,
  RuntimeHealthModel,
  readAgentServiceBootBinding,
  readAuthorityFile,
  ServiceLifecycleError,
  STARTUP_PHASES,
  STATE_ROOT_ERROR_CODES,
  StartupDrainCoordinator,
  writeAgentServiceBootBinding,
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
        provider: "vercel-ai-gateway",
        model: "deepseek/deepseek-v4.1-flash",
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
        providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
        allowedDataClassifications: ["public", "private"],
        disclosure: "trusted_remote",
        secretRef: "provider-primary",
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "vercel-ai-gateway",
        model: "alibaba/qwen3-embedding-8b",
        version: "snapshot-1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 4096,
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "trusted_remote",
        secretRef: "provider-embedding",
      },
    ],
    memory: {
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 4096,
    },
    repositoryAllowlistRefs: ["sixianli/himawari-agent"],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "provider-primary", version: "v1", purpose: "model-auth", scope: "model-primary" },
      {
        ref: "provider-embedding",
        version: "v1",
        purpose: "embedding-auth",
        scope: "model-embedding",
      },
    ],
    concurrency: {
      totalRuns: 8,
      foregroundReserved: 2,
      perCategory: { research: 4, maintenance: 2 },
    },
    deadlines: { runMs: 300_000, workerRequestMs: 30_000, providerRequestMs: 60_000 },
  };
}

describe("strict product configuration", () => {
  it("[R2-L5] accepts one configured primary with the approved gateway routing", () => {
    const parsed = parseProductConfiguration(
      config(path.join(tmpdir(), "himawari-gateway-single-primary")),
      "2026-10-06T00:00:00.000Z",
    );
    expect(parsed.modelDescriptors.map(({ role }) => role)).toEqual(["primary", "embedding"]);
    expect(parsed.modelDescriptors[0]?.providerRouting).toEqual({
      order: ["runware", "deepinfra", "morph"],
      sort: "cost",
    });
    expect(Object.isFrozen(parsed.modelDescriptors[0]?.providerRouting?.order)).toBe(true);
  });

  it.each([
    { name: "unknown sort", change: { providerRouting: { order: ["runware"], sort: "latency" } } },
    { name: "missing sort", change: { providerRouting: { order: ["runware"] } } },
    { name: "empty order", change: { providerRouting: { order: [], sort: "cost" } } },
    {
      name: "duplicate order",
      change: { providerRouting: { order: ["runware", "runware"], sort: "cost" } },
    },
    {
      name: "unapproved data policy",
      change: {
        providerRouting: { order: ["runware"], sort: "cost", disallowPromptTraining: true },
      },
    },
    { name: "missing routing", change: { providerRouting: undefined } },
    { name: "extra fallback", change: { role: "fallback" } },
    { name: "unsupported text model", change: { model: "unsupported-text-model" } },
    { name: "too many output tokens", change: { maxTokens: 32769 } },
    { name: "missing gateway credential", change: { secretRef: null } },
  ])("[R2-L5] refuses $name in a gateway configuration", ({ change }) => {
    const input = config(path.join(tmpdir(), "himawari-gateway-invalid"));
    const models = input["modelDescriptors"] as Record<string, unknown>[];
    input["modelDescriptors"] = [{ ...models[0], ...change }, models[1]];
    expect(() => parseProductConfiguration(input, "2026-10-06T00:00:00.000Z")).toThrow();
  });

  it("[I-23] accepts a memory relevance threshold only between 0 and 1", () => {
    const withThreshold = (minimumSimilarity: unknown) => {
      const input = config(path.join(tmpdir(), "himawari-memory-threshold"));
      input["memory"] = { ...(input["memory"] as Record<string, unknown>), minimumSimilarity };
      return input;
    };
    expect(
      parseProductConfiguration(withThreshold(0.65), "2026-10-29T00:00:00.000Z").memory
        .minimumSimilarity,
    ).toBe(0.65);
    expect(
      parseProductConfiguration(
        config(path.join(tmpdir(), "himawari-memory-threshold")),
        "2026-10-29T00:00:00.000Z",
      ).memory.minimumSimilarity,
    ).toBeUndefined();
    for (const invalid of [0, 1, 1.2, -0.1, "0.6"])
      expect(() =>
        parseProductConfiguration(withThreshold(invalid), "2026-10-29T00:00:00.000Z"),
      ).toThrow();
  });

  it("[P3-1] accepts a local ONNX embedding profile only with a pinned artifact, no secret and no cost", () => {
    const artifactSha256 = "a".repeat(64);
    const local = {
      ref: "model-embedding",
      role: "embedding",
      provider: "local-onnx",
      model: "jina-embeddings-v5-text-small-retrieval-int8",
      version: "artifact-v1",
      capabilities: ["embedding"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dimensions: 1024,
      allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
      disclosure: "local_only",
      secretRef: null,
      artifactSha256,
    };
    const withEmbedding = (change: Record<string, unknown>) => {
      const input = config(path.join(tmpdir(), "himawari-local-embedding"));
      const models = input["modelDescriptors"] as Record<string, unknown>[];
      input["modelDescriptors"] = [models[0], { ...local, ...change }];
      input["memory"] = {
        ...(input["memory"] as Record<string, unknown>),
        dimensions: (change["dimensions"] as number | undefined) ?? 1024,
      };
      input["secretReferences"] = (input["secretReferences"] as Record<string, unknown>[]).filter(
        ({ ref }) => ref !== "provider-embedding",
      );
      return input;
    };
    const parsed = parseProductConfiguration(withEmbedding({}), "2026-11-11T00:00:00.000Z");
    expect(parsed.modelDescriptors.find(({ role }) => role === "embedding")).toMatchObject({
      provider: "local-onnx",
      artifactSha256,
    });
    for (const [change, reason] of [
      [{ disclosure: "trusted_remote" }, "must be local_only"],
      [{ secretRef: "provider-embedding" }, "must be null"],
      [{ cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 } }, "must be zero"],
      [{ artifactSha256: undefined }, "is required for local-onnx"],
      [{ artifactSha256: "A".repeat(64) }, "lowercase sha256"],
      [{ model: "jina-embeddings-v5-text-small" }, "not a known embedding profile"],
      [{ dimensions: 768 }, "must be one of 1024"],
    ] as const)
      expect(() =>
        parseProductConfiguration(withEmbedding(change), "2026-11-11T00:00:00.000Z"),
      ).toThrow(
        expect.objectContaining({
          details: expect.objectContaining({ reason: expect.stringContaining(reason) }),
        }),
      );
    const gateway = config(path.join(tmpdir(), "himawari-local-embedding"));
    const models = gateway["modelDescriptors"] as Record<string, unknown>[];
    gateway["modelDescriptors"] = [models[0], { ...models[1], artifactSha256 }];
    expect(() => parseProductConfiguration(gateway, "2026-11-11T00:00:00.000Z")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "is only supported for local-onnx" }),
      }),
    );
  });

  it("accepts memory retrieval tuning only as non-negative numbers below 1 and a boolean dedupe switch", () => {
    const withRetrieval = (retrieval: unknown) => {
      const input = config(path.join(tmpdir(), "himawari-memory-retrieval"));
      input["memory"] = { ...(input["memory"] as Record<string, unknown>), retrieval };
      return input;
    };
    const at = "2026-11-11T00:00:00.000Z";
    expect(
      parseProductConfiguration(
        withRetrieval({
          keywordWeight: 0.2,
          entityWeight: 0,
          cutoffMargin: 0.05,
          dedupeSameSource: false,
        }),
        at,
      ).memory.retrieval,
    ).toEqual({ keywordWeight: 0.2, entityWeight: 0, cutoffMargin: 0.05, dedupeSameSource: false });
    expect(parseProductConfiguration(withRetrieval({}), at).memory.retrieval).toEqual({});
    expect(
      parseProductConfiguration(config(path.join(tmpdir(), "himawari-memory-retrieval")), at).memory
        .retrieval,
    ).toBeUndefined();
    for (const invalid of [
      { keywordWeight: -0.1 },
      { keywordWeight: 1 },
      { entityWeight: Number.NaN },
      { entityWeight: Number.POSITIVE_INFINITY },
      { cutoffMargin: "0.03" },
      { dedupeSameSource: "yes" },
      { minimumScore: 0.5 },
      "on",
    ])
      expect(() => parseProductConfiguration(withRetrieval(invalid), at)).toThrow();
  });

  it("accepts a Magpie primary on a loopback address without gateway routing", () => {
    const input = config(path.join(tmpdir(), "himawari-magpie-primary"));
    const models = input["modelDescriptors"] as Record<string, unknown>[];
    const { providerRouting: _routing, ...primary } = models[0] ?? {};
    input["modelDescriptors"] = [
      {
        ...primary,
        provider: "magpie",
        model: "group/himawari-main",
        baseUrl: "http://127.0.0.1:3425/v1",
      },
      models[1],
    ];
    const parsed = parseProductConfiguration(input, "2026-10-29T00:00:00.000Z");
    expect(parsed.modelDescriptors[0]).toMatchObject({
      provider: "magpie",
      model: "group/himawari-main",
      baseUrl: "http://127.0.0.1:3425/v1",
    });
    expect(parsed.modelDescriptors[0]?.providerRouting).toBeUndefined();
  });

  it.each([
    { name: "a missing base URL", change: { baseUrl: undefined } },
    { name: "a remote base URL", change: { baseUrl: "http://203.0.113.5:3425/v1" } },
    { name: "an HTTPS base URL", change: { baseUrl: "https://127.0.0.1:3425/v1" } },
    {
      name: "gateway routing",
      change: { providerRouting: { order: ["runware"], sort: "cost" } },
    },
    { name: "a missing credential", change: { secretRef: null } },
  ])("refuses $name in a Magpie configuration", ({ change }) => {
    const input = config(path.join(tmpdir(), "himawari-magpie-invalid"));
    const models = input["modelDescriptors"] as Record<string, unknown>[];
    const { providerRouting: _routing, ...primary } = models[0] ?? {};
    input["modelDescriptors"] = [
      {
        ...primary,
        provider: "magpie",
        model: "group/himawari-main",
        baseUrl: "http://127.0.0.1:3425/v1",
        ...change,
      },
      models[1],
    ];
    expect(() => parseProductConfiguration(input, "2026-10-29T00:00:00.000Z")).toThrow();
  });

  it("refuses a base URL on an AI Gateway primary", () => {
    const input = config(path.join(tmpdir(), "himawari-gateway-base-url"));
    const models = input["modelDescriptors"] as Record<string, unknown>[];
    input["modelDescriptors"] = [{ ...models[0], baseUrl: "http://127.0.0.1:3425/v1" }, models[1]];
    expect(() => parseProductConfiguration(input, "2026-10-29T00:00:00.000Z")).toThrow();
  });

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
    expect(parsed.modelDescriptors[0]?.providerRouting).toEqual({
      order: ["runware", "deepinfra", "morph"],
      sort: "cost",
    });
    expect(parsed.modelDescriptors[0]).toMatchObject({
      role: "primary",
      capabilities: ["text", "tool_calling"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    });
    expect(parsed.modelDescriptors[1]).toMatchObject({
      role: "embedding",
      capabilities: ["embedding"],
      dimensions: 4096,
    });
    expect(parsed.stateRoot).not.toBe(process.cwd());
    expect(parsed.capabilityDeployment).toBeUndefined();
  });

  it("validates an endpoint requiring reasoning without accepting contradictory capabilities", () => {
    const input = config(path.join(tmpdir(), "himawari-reasoning-config"));
    const models = input["modelDescriptors"] as Record<string, unknown>[];
    const primary = models[0];
    if (!primary) throw new Error("Primary fixture missing");
    primary["reasoning"] = true;
    primary["reasoningRequired"] = true;
    expect(
      parseProductConfiguration(input, "2026-08-27T00:00:00.000Z").modelDescriptors[0],
    ).toMatchObject({ reasoningRequired: true });
    primary["reasoning"] = false;
    expect(() => parseProductConfiguration(input, "2026-08-27T00:00:00.000Z")).toThrow();
    primary["reasoning"] = true;
    primary["reasoningRequired"] = "yes";
    expect(() => parseProductConfiguration(input, "2026-08-27T00:00:00.000Z")).toThrow();
  });

  it("accepts an optional capability deployment snapshot reference with strict fields", () => {
    const stateRoot = path.join(tmpdir(), "himawari-capability-deployment-config");
    const input = config(stateRoot);
    input["capabilityDeployment"] = {
      snapshotPath: path.join(stateRoot, "runtime", "capability-deployment.json"),
      sha256: `sha256:${"a".repeat(64)}`,
    };
    expect(
      parseProductConfiguration(input, "2026-08-27T00:00:00.000Z").capabilityDeployment,
    ).toEqual(input["capabilityDeployment"]);

    const unknown = config(stateRoot);
    unknown["capabilityDeployment"] = {
      snapshotPath: path.join(stateRoot, "runtime", "capability-deployment.json"),
      sha256: `sha256:${"a".repeat(64)}`,
      unexpected: true,
    };
    expect(() => parseProductConfiguration(unknown, "2026-08-27T00:00:00.000Z")).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD }),
    );

    const invalidDigest = config(stateRoot);
    invalidDigest["capabilityDeployment"] = {
      snapshotPath: path.join(stateRoot, "runtime", "capability-deployment.json"),
      sha256: "not-a-digest",
    };
    expect(() => parseProductConfiguration(invalidDigest, "2026-08-27T00:00:00.000Z")).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
    );
  });

  it("accepts an optional task environment backend with pinned images and rejects unsafe shapes", () => {
    const stateRoot = path.join(tmpdir(), "himawari-task-environment-config");
    const taskEnvironments = () => ({
      backendRef: "container-docker:local",
      dockerExecutable: "/usr/local/bin/docker",
      dockerHost: "unix:///var/run/docker.sock",
      image: { reference: "himawari/runner", digest: "b".repeat(64), pin: "image-id" },
      egressImage: {
        reference: "docker.io/library/node",
        digest: "c".repeat(64),
        pin: "registry-digest",
      },
    });
    const parse = (value: unknown) => {
      const input = config(stateRoot);
      input["taskEnvironments"] = value;
      return parseProductConfiguration(input, "2026-08-27T00:00:00.000Z");
    };
    expect(
      parseProductConfiguration(config(stateRoot), "2026-08-27T00:00:00.000Z"),
    ).not.toHaveProperty("taskEnvironments");
    expect(parse(taskEnvironments()).taskEnvironments).toEqual(taskEnvironments());
    expect(
      parse({ ...taskEnvironments(), dockerHost: null }).taskEnvironments?.dockerHost,
    ).toBeNull();
    const { dockerHost: _omitted, ...withoutDockerHost } = taskEnvironments();
    expect(parse(withoutDockerHost).taskEnvironments).toEqual({
      ...withoutDockerHost,
      dockerHost: null,
    });
    for (const required of ["backendRef", "dockerExecutable", "image", "egressImage"]) {
      const incomplete: Record<string, unknown> = taskEnvironments();
      delete incomplete[required];
      expect(() => parse(incomplete)).toThrowError(
        expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
      );
    }

    for (const unknown of [
      { ...taskEnvironments(), unexpected: true },
      { ...taskEnvironments(), runnerDigest: "d".repeat(64) },
      { ...taskEnvironments(), image: { ...taskEnvironments().image, unexpected: true } },
    ])
      expect(() => parse(unknown)).toThrowError(
        expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD }),
      );
    for (const invalid of [
      { ...taskEnvironments(), backendRef: "srt" },
      { ...taskEnvironments(), dockerExecutable: "docker" },
      { ...taskEnvironments(), dockerHost: "" },
      { ...taskEnvironments(), image: { ...taskEnvironments().image, digest: "b".repeat(63) } },
      { ...taskEnvironments(), image: { ...taskEnvironments().image, pin: "tag" } },
      {
        ...taskEnvironments(),
        egressImage: { ...taskEnvironments().egressImage, digest: `sha256:${"c".repeat(64)}` },
      },
    ])
      expect(() => parse(invalid)).toThrowError(
        expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
      );
  });

  it("accepts no model cost budgets and rejects the removed budgets section", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-budgets");
    const parsed = parseProductConfiguration(config(stateRoot), new Date().toISOString());
    expect("budgets" in parsed).toBe(false);
    expect(() =>
      parseProductConfiguration(
        {
          ...config(stateRoot),
          budgets: {
            globalCostMicros: 1_000_000,
            perRunCostMicros: 100_000,
            perClassificationCostMicros: {
              public: 1_000_000,
              private: 100_000,
              sensitive: 0,
              restricted: 0,
            },
          },
        },
        new Date().toISOString(),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD,
        details: { field: "configuration.budgets" },
      }),
    );
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
        index === 0
          ? { ...entry, providerRouting: { order: ["runware", "runware"], sort: "cost" } }
          : entry,
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
    const missingPrimary = config(stateRoot);
    missingPrimary["modelDescriptors"] = (missingPrimary["modelDescriptors"] as unknown[]).filter(
      (entry) => (entry as { role: string }).role !== "primary",
    );
    expect(() =>
      parseProductConfiguration(missingPrimary, new Date().toISOString()),
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
    const extraPrimary = config(stateRoot);
    const primaryModels = extraPrimary["modelDescriptors"] as Record<string, unknown>[];
    extraPrimary["modelDescriptors"] = [
      ...primaryModels,
      { ...primaryModels[0], ref: "second-primary" },
    ];
    expect(() => parseProductConfiguration(extraPrimary, new Date().toISOString())).toThrowError();
    const generationFieldOnEmbedding = config(stateRoot);
    const embeddingModels = generationFieldOnEmbedding["modelDescriptors"] as Record<
      string,
      unknown
    >[];
    generationFieldOnEmbedding["modelDescriptors"] = embeddingModels.map((entry, index) =>
      index === 1 ? { ...entry, input: ["text"] } : entry,
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
      (entry, index) => (index === 1 ? { ...entry, capabilities: ["text"] } : entry),
    );
    expect(() =>
      parseProductConfiguration(missingEmbeddingCapability, new Date().toISOString()),
    ).toThrowError();
  });

  it("parses bounded public HTTP and identity configuration without defaults", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-public");
    const input = config(stateRoot);
    input["http"] = {
      listenHost: "127.0.0.1",
      listenPort: 8787,
      staticRoot: path.join(stateRoot, "browser"),
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 262_144,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 15_000,
    };
    input["identity"] = {
      issuer: "https://team.cloudflareaccess.com",
      audience: "access-audience-v1",
      jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: {
        maximumAgeMilliseconds: 900_000,
        clockSkewMilliseconds: 30_000,
      },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: {
        keySecretRef: "identity-csrf",
        ttlMilliseconds: 1_800_000,
      },
    };
    (input["secretReferences"] as unknown[]).push(
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    );
    const parsed = parseProductConfiguration(input, "2026-08-27T00:00:00.000Z");
    expect(parsed.http).toEqual(input["http"]);
    const http = input["http"] as Record<string, unknown>;
    expect(
      parseProductConfiguration(
        { ...input, http: { ...http, previewOrigin: "https://files.example.test" } },
        "2026-08-27T00:00:00.000Z",
      ).http?.previewOrigin,
    ).toBe("https://files.example.test");
    for (const previewOrigin of [
      "http://files.example.test",
      "https://files.example.test/",
      "https://files.example.test/preview",
      "https://user@files.example.test",
      "files.example.test",
      new URL(String(input["publicOrigin"])).origin,
    ]) {
      expect(
        () =>
          parseProductConfiguration(
            { ...input, http: { ...http, previewOrigin } },
            "2026-08-27T00:00:00.000Z",
          ),
        previewOrigin,
      ).toThrowError(
        expect.objectContaining({
          details: expect.objectContaining({ field: "configuration.http.previewOrigin" }),
        }),
      );
    }
    expect(parsed.identity).toMatchObject({
      issuer: "https://team.cloudflareaccess.com",
      jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      recentAuthentication: {
        maximumAgeMilliseconds: 900_000,
        clockSkewMilliseconds: 30_000,
      },
    });
  });

  it("accepts built-in accounts without external identity fields and rejects unbounded sessions", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-built-in");
    const input = config(stateRoot);
    input["http"] = {
      listenHost: "127.0.0.1",
      listenPort: 8787,
      staticRoot: path.join(stateRoot, "browser"),
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 262144,
      maximumStaticAssetBytes: 8388608,
      heartbeatMilliseconds: 15000,
    };
    input["identity"] = {
      kind: "built-in",
      sessionIdleMilliseconds: 86400000,
      sessionAbsoluteMilliseconds: 604800000,
      recentAuthentication: { maximumAgeMilliseconds: 900000, clockSkewMilliseconds: 30000 },
      csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1800000 },
    };
    (input["secretReferences"] as unknown[]).push({
      ref: "identity-csrf",
      version: "v1",
      purpose: "identity-csrf",
      scope: "agent",
    });
    expect(parseProductConfiguration(input, "2026-09-10T00:00:00.000Z").identity).toEqual(
      input["identity"],
    );
    input["identity"] = {
      ...(input["identity"] as Record<string, unknown>),
      sessionIdleMilliseconds: 0,
    };
    expect(() => parseProductConfiguration(input, "2026-09-10T00:00:00.000Z")).toThrow();
  });

  it("accepts an explicit HTTPS origin port only when the fixed endpoint matches it", () => {
    const stateRoot = path.join(tmpdir(), "himawari-config-explicit-port");
    const input = config(stateRoot);
    input["http"] = {
      listenHost: "127.0.0.1",
      listenPort: 8787,
      staticRoot: path.join(stateRoot, "browser"),
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 262_144,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 15_000,
    };
    input["identity"] = {
      issuer: "https://team.cloudflareaccess.com:8443",
      audience: "access-audience-v1",
      jwksUrl: "https://team.cloudflareaccess.com:8443/cdn-cgi/access/certs",
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: {
        maximumAgeMilliseconds: 900_000,
        clockSkewMilliseconds: 30_000,
      },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: {
        keySecretRef: "identity-csrf",
        ttlMilliseconds: 1_800_000,
      },
    };
    (input["secretReferences"] as unknown[]).push(
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    );

    const parsed = parseProductConfiguration(input, "2026-08-27T00:00:00.000Z");
    if (parsed.identity?.kind === "built-in") throw new Error("Expected external identity");
    expect(parsed.identity?.issuer).toBe("https://team.cloudflareaccess.com:8443");
    expect(parsed.identity?.jwksUrl).toBe(
      "https://team.cloudflareaccess.com:8443/cdn-cgi/access/certs",
    );

    const crossPort = structuredClone(input) as Record<string, unknown>;
    crossPort["identity"] = {
      ...(crossPort["identity"] as Record<string, unknown>),
      jwksUrl: "https://team.cloudflareaccess.com:9443/cdn-cgi/access/certs",
    };
    expect(() => parseProductConfiguration(crossPort, "2026-08-27T00:00:00.000Z")).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
    );

    const crossHost = structuredClone(input) as Record<string, unknown>;
    crossHost["identity"] = {
      ...(crossHost["identity"] as Record<string, unknown>),
      jwksUrl: "https://other.example:8443/cdn-cgi/access/certs",
    };
    expect(() => parseProductConfiguration(crossHost, "2026-08-27T00:00:00.000Z")).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
    );
  });

  it.each([
    ["configuration.http.listenHost", { http: { listenHost: "0.0.0.0" } }],
    ["configuration.identity.issuer", { identity: { issuer: "http://team.cloudflareaccess.com" } }],
    ["configuration.identity.jwksUrl", { identity: { jwksUrl: "https://other.example/certs" } }],
    [
      "configuration.identity.recentAuthentication.maximumAgeMilliseconds",
      { identity: { recentAuthentication: { maximumAgeMilliseconds: undefined } } },
    ],
  ])("rejects unsafe or incomplete public field %s", (_field, override) => {
    const stateRoot = path.join(tmpdir(), "himawari-config-public-invalid");
    const input = config(stateRoot);
    const complete = {
      http: {
        listenHost: "127.0.0.1",
        listenPort: 8787,
        staticRoot: path.join(stateRoot, "browser"),
        sessionCookieName: "himawari_session",
        maximumBodyBytes: 262_144,
        maximumStaticAssetBytes: 8 * 1024 * 1024,
        heartbeatMilliseconds: 15_000,
      },
      identity: {
        issuer: "https://team.cloudflareaccess.com",
        audience: "access-audience-v1",
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        jwksCacheMilliseconds: 300_000,
        jwksTimeoutMilliseconds: 2_000,
        jwksMaximumBodyBytes: 65_536,
        clockToleranceSeconds: 30,
        identityLookupTimeoutMilliseconds: 2_000,
        identityLookupMaximumBodyBytes: 65_536,
        recentAuthentication: {
          maximumAgeMilliseconds: 900_000,
          clockSkewMilliseconds: 30_000,
        },
        bootstrap: {
          enabled: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecretRef: "identity-bootstrap",
        },
        csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
      },
    };
    input["http"] = { ...complete.http, ...((override as { http?: object }).http ?? {}) };
    input["identity"] = {
      ...complete.identity,
      ...((override as { identity?: object }).identity ?? {}),
    };
    if (
      (override as { identity?: { recentAuthentication?: object } }).identity?.recentAuthentication
    ) {
      input["identity"] = {
        ...(input["identity"] as object),
        recentAuthentication: {
          ...complete.identity.recentAuthentication,
          ...((override as { identity?: { recentAuthentication?: object } }).identity
            ?.recentAuthentication ?? {}),
        },
      };
    }
    (input["secretReferences"] as unknown[]).push(
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    );
    expect(() => parseProductConfiguration(input, new Date().toISOString())).toThrowError(
      expect.objectContaining({ code: CONFIGURATION_ERROR_CODES.INVALID_VALUE }),
    );
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

  it("atomically publishes and generation-checks the Agent Service boot binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-state-root-boot-"));
    roots.push(root);
    const layout = await initializeStateRoot(path.join(root, "state"));
    const authority = Object.freeze({
      id: createDeploymentId("deployment-boot-binding"),
      ownerId: createOwnerId("owner-boot-binding"),
      agentId: createAgentId("agent-boot-binding"),
      revision: 1,
      status: "active" as const,
      authorityEpoch: 2,
      fencingToken: 3,
      transferId: null,
    });
    const first = await writeAgentServiceBootBinding(layout, {
      workerInstanceId: "worker:fixture",
      workerBootId: "worker-boot:old",
      agentServiceInstanceId: "agent-service:deployment-boot-binding",
      agentServiceBootId: "agent-service-boot:first",
      authorityLeaseId: "authority:agent-boot-binding:first",
      authority,
    });
    expect((await lstat(layout.agentServiceBootBindingFile)).mode & 0o077).toBe(0);
    await expect(readAgentServiceBootBinding(layout)).resolves.toEqual(first);

    const second = await writeAgentServiceBootBinding(layout, {
      workerInstanceId: "worker:fixture",
      workerBootId: "worker-boot:old",
      agentServiceInstanceId: first.agentServiceInstanceId,
      agentServiceBootId: "agent-service-boot:second",
      authorityLeaseId: "authority:agent-boot-binding:second",
      authority,
    });
    await expect(readAgentServiceBootBinding(layout)).resolves.toEqual(second);
    expect((await lstat(layout.agentServiceBootBindingFile)).isFile()).toBe(true);
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

it("validates the versioned Run policy and rejects inconsistent Memory bounds", () => {
  const raw = config("/tmp/himawari-policy-config");
  raw["runPolicy"] = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
  };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.version).toBe(
    "policy-v1",
  );
  raw["runPolicy"] = { ...(raw["runPolicy"] as object), maxSelectedMemories: 11 };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  raw["runPolicy"] = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
    allowUntrustedTools: true,
  };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
});

it("[HOME-settings] fills home feed settings from the defaults and rejects values outside their bounds", () => {
  const raw = config("/tmp/himawari-home-feed-config");
  const policy = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
  };
  raw["runPolicy"] = policy;
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.homeFeed,
  ).toBeUndefined();
  raw["runPolicy"] = { ...policy, homeFeed: { deadlineLeadMinutes: 0, awaitingLimit: 50 } };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.homeFeed).toEqual({
    ...DEFAULT_HOME_FEED,
    deadlineLeadMinutes: 0,
    awaitingLimit: 50,
  });
  for (const homeFeed of [
    { awaitingLimit: 0 },
    { sourceReadLimit: 201 },
    { recentHours: 1.5 },
    { deadlineLeadMinutes: -1 },
    { unknownSetting: 1 },
  ]) {
    raw["runPolicy"] = { ...policy, homeFeed };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("reads the search answer limits from runPolicy.searchAsk and rejects values outside the bounds", () => {
  const raw = config("/tmp/himawari-policy-config");
  const policy = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
  };
  raw["runPolicy"] = policy;
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.searchAsk,
  ).toBeUndefined();
  raw["runPolicy"] = { ...policy, searchAsk: { askLimit: 8, basisLimit: 3 } };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.searchAsk).toEqual({
    ...DEFAULT_SEARCH_ASK,
    askLimit: 8,
    basisLimit: 3,
  });
  for (const searchAsk of [
    { candidateLimit: 0 },
    { basisLimit: 11 },
    { minimumCoveragePercent: 101 },
    { answerCharacters: 1.5 },
    { unknownSetting: 1 },
  ]) {
    raw["runPolicy"] = { ...policy, searchAsk };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("[RULE-memory-visible] accepts the retired maxMemoryClassification key without letting it limit Memory", () => {
  const raw = config("/tmp/himawari-policy-config");
  raw["runPolicy"] = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
    maxMemoryClassification: "public",
  };
  const policy = parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy;
  expect(policy?.retiredKeys).toEqual(["maxMemoryClassification"]);
  expect(policy && "maxMemoryClassification" in policy).toBe(false);
});

it("parses private search without allowing a mixed directory grant", () => {
  const raw = config("/tmp/config-fixture");
  const route = {
    scopeSource: "private_temp",
    hostId: "host",
    workerInstanceId: "worker",
    capabilityRef: "search",
    capabilityVersion: "1",
    maximumBytes: 4096,
  };
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
    publicSearch: route,
  };
  raw["runPolicy"] = policy;
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.publicSearch,
  ).toEqual(route);
  for (const changed of [
    { ...route, grantId: "directory" },
    { ...route, scopeSource: "directory" },
  ]) {
    raw["runPolicy"] = { ...policy, publicSearch: changed };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("parses ordered web providers and a fetch route without accepting unregistered or secret-only providers", () => {
  const raw = config("/tmp/config-fixture");
  const route = {
    scopeSource: "private_temp",
    hostId: "host",
    workerInstanceId: "worker",
    capabilityRef: "fetch",
    capabilityVersion: "1",
    maximumBytes: 32768,
  };
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = {
    ...policy,
    publicSearch: { ...route, capabilityRef: "search", providers: ["exa-public"] },
    publicFetch: route,
  };
  const parsed = parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy;
  expect(parsed?.publicSearch).toEqual({
    ...route,
    capabilityRef: "search",
    providers: ["exa-public"],
  });
  expect(parsed?.publicFetch).toEqual(route);
  for (const providers of [[], ["bing"], ["exa-public", "exa-public"], "exa-public"]) {
    raw["runPolicy"] = { ...policy, publicFetch: { ...route, providers } };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
  raw["runPolicy"] = { ...policy, publicFetch: { ...route, scopeSource: undefined, grantId: "g" } };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
});

it("[NL-11] lets a page fetch return up to 100 KiB while search keeps its own limit", () => {
  const raw = config("/tmp/config-fixture");
  const route = {
    scopeSource: "private_temp",
    hostId: "host",
    workerInstanceId: "worker",
    capabilityRef: "fetch",
    capabilityVersion: "1",
    maximumBytes: 100 * 1024,
  };
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = { ...policy, publicFetch: route };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.publicFetch?.maximumBytes,
  ).toBe(100 * 1024);
  raw["runPolicy"] = { ...policy, publicFetch: { ...route, maximumBytes: 100 * 1024 + 1 } };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  raw["runPolicy"] = { ...policy, publicSearch: { ...route, capabilityRef: "search" } };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
});

it("requires a configured web-provider secret for each provider that needs one", () => {
  const raw = config("/tmp/himawari-web-secret-config");
  const route = {
    scopeSource: "private_temp",
    hostId: "host",
    workerInstanceId: "worker",
    capabilityRef: "fetch",
    capabilityVersion: "1",
    maximumBytes: 32768,
    providers: ["exa-public", "deepseek"],
  };
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "deepseek-web", version: "v1", purpose: "web-provider", scope: "agent" },
  ];
  raw["runPolicy"] = {
    ...policy,
    publicFetch: { ...route, providerSecrets: { deepseek: "deepseek-web" } },
  };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.publicFetch).toEqual(
    { ...route, providerSecrets: { deepseek: "deepseek-web" } },
  );
  for (const providerSecrets of [
    undefined,
    {},
    { deepseek: "missing-secret" },
    { deepseek: "deepseek-web", "exa-public": "deepseek-web" },
  ]) {
    raw["runPolicy"] = {
      ...policy,
      publicFetch: { ...route, ...(providerSecrets ? { providerSecrets } : {}) },
    };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
  raw["secretReferences"] = [
    ...references,
    { ref: "deepseek-web", version: "v1", purpose: "payload-encryption", scope: "agent" },
  ];
  raw["runPolicy"] = {
    ...policy,
    publicFetch: { ...route, providerSecrets: { deepseek: "deepseek-web" } },
  };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
});

it("accepts a dedicated review model and rejects one the router could also select", () => {
  const raw = config("/tmp/himawari-review-config");
  const review = {
    delegationKey: "automatic-review-delegation",
    configurationVersion: "review-config:1",
    modelRef: "model-primary",
    maximumWaitMs: 30_000,
    maxOutputBytes: 32_768,
  };
  const policy = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
    automaticReview: review,
  };
  raw["runPolicy"] = policy;
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.automaticReview,
  ).toEqual(review);
  for (const changed of [
    { ...review, modelRef: "model-unknown" },
    { ...review, modelRef: "model-embedding" },
    { ...review, modelRef: "model-embedding" },
    { ...review, maximumWaitMs: 0 },
    { ...review, maximumWaitMs: 300_001 },
    { ...review, maxOutputBytes: 0 },
    { ...review, extra: true },
    { delegationKey: review.delegationKey, configurationVersion: review.configurationVersion },
  ]) {
    raw["runPolicy"] = { ...policy, automaticReview: changed };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("accepts a TypeSafe decision model as the configured reviewer and rejects its invalid shapes", () => {
  const raw = config("/tmp/himawari-jev-config");
  const decisionModel = {
    ref: "model-reviewer",
    role: "specialist",
    provider: "typesafe",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
    version: "snapshot-1",
    priority: 2,
    name: "Jev reviewer",
    api: "typesafe-systemone",
    capabilities: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    allowedDataClassifications: ["private"],
    disclosure: "external_remote",
    secretRef: "provider-reviewer",
  };
  const descriptors = raw["modelDescriptors"] as Record<string, unknown>[];
  descriptors.push(decisionModel);
  (raw["secretReferences"] as Record<string, unknown>[]).push({
    ref: "provider-reviewer",
    version: "v1",
    purpose: "model-auth",
    scope: "model-reviewer",
  });
  const review = {
    delegationKey: "automatic-review-delegation",
    configurationVersion: "review-config:1",
    modelRef: "model-reviewer",
    maximumWaitMs: 30_000,
    maxOutputBytes: 32_768,
  };
  const policy = {
    version: "policy-v1",
    systemInstruction: "可信指令",
    memoryLimit: 10,
    maxSelectedMemories: 5,
    automaticReview: review,
  };
  raw["runPolicy"] = policy;
  const parsed = parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z");
  expect(parsed.modelDescriptors.at(-1)).toMatchObject({
    api: "typesafe-systemone",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
  });
  expect(parsed.runPolicy?.automaticReview).toEqual(review);

  raw["runPolicy"] = { ...policy, automaticReview: { ...review, confidenceThreshold: 0.8 } };
  expect(
    parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z").runPolicy?.automaticReview,
  ).toMatchObject({ confidenceThreshold: 0.8 });
  for (const changed of [
    { ...review, confidenceThreshold: -0.1 },
    { ...review, confidenceThreshold: 1.1 },
    { ...review, confidenceThreshold: 1 },
    { ...review, confidenceThreshold: 0 },
  ]) {
    raw["runPolicy"] = { ...policy, automaticReview: changed };
    if (changed.confidenceThreshold === 0 || changed.confidenceThreshold === 1) {
      expect(() => parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z")).not.toThrow();
    } else {
      expect(() => parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z")).toThrow();
    }
  }

  for (const [mutate, label] of [
    [
      (m: Record<string, unknown>) => ({ ...m, cost: { ...(m["cost"] as object), output: 1 } }),
      "output",
    ],
    [(m: Record<string, unknown>) => ({ ...m, reasoning: false }), "reasoning"],
    [(m: Record<string, unknown>) => ({ ...m, contextWindow: 8192 }), "contextWindow"],
    [(m: Record<string, unknown>) => ({ ...m, maxTokens: 16 }), "maxTokens"],
    [(m: Record<string, unknown>) => ({ ...m, input: ["text"] }), "input"],
  ] as const) {
    const descriptorsNext = [...descriptors];
    descriptorsNext[descriptorsNext.length - 1] = mutate(decisionModel);
    raw["modelDescriptors"] = descriptorsNext;
    expect(() => parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z")).toThrow();
    void label;
  }
  raw["modelDescriptors"] = [...descriptors, { ...decisionModel, ref: "second-reviewer" }];
  expect(() => parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z")).toThrow();
  raw["modelDescriptors"] = [...descriptors.slice(0, -1), { ...decisionModel, role: "fallback" }];
  expect(() => parseProductConfiguration(raw, "2026-09-22T00:00:00.000Z")).toThrow();
});

describe("[R2-T2] coding route approval mode", () => {
  const AT = "2026-10-13T00:00:00.000Z";
  function withCoding(approval?: string): Record<string, unknown> {
    const raw = config(path.join(tmpdir(), "himawari-coding-approval"));
    raw["runPolicy"] = {
      version: "policy-v1",
      systemInstruction: "test",
      memoryLimit: 10,
      maxSelectedMemories: 1,
      coding: {
        hostId: "host",
        workerInstanceId: "worker",
        grantId: "directory:grant",
        capabilityRef: "himawari.pi-coding",
        capabilityVersion: "1.0.0",
        maximumBytes: 4096,
        enabledTools: ["read", "write", "edit", "bash", "find", "grep", "ls"],
        ...(approval === undefined ? {} : { approval }),
      },
    };
    return raw;
  }

  it("[R2-T2] accepts workspace_auto and ask, and defaults an omitted value to workspace_auto", () => {
    expect(
      parseProductConfiguration(withCoding("workspace_auto"), AT).runPolicy?.coding?.approval,
    ).toBe("workspace_auto");
    expect(parseProductConfiguration(withCoding("ask"), AT).runPolicy?.coding?.approval).toBe(
      "ask",
    );
    expect(parseProductConfiguration(withCoding(), AT).runPolicy?.coding?.approval).toBe(
      "workspace_auto",
    );
  });

  it("[R2-T2] rejects an unknown approval value and an undeclared coding field", () => {
    expect(() => parseProductConfiguration(withCoding("maybe"), AT)).toThrow();
    const raw = withCoding("ask");
    (raw["runPolicy"] as { coding: Record<string, unknown> }).coding["approval2"] = "ask";
    expect(() => parseProductConfiguration(raw, AT)).toThrow();
  });
});

it("[WP-7] accepts web push only with a web-push secret and an https or mailto subject", () => {
  const raw = config("/tmp/himawari-web-push-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "web-push-vapid", version: "v1", purpose: "web-push", scope: "agent" },
  ];
  raw["runPolicy"] = {
    ...policy,
    webPush: { secretRef: "web-push-vapid", subject: "https://himawari.siyi.win" },
  };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.webPush).toEqual({
    secretRef: "web-push-vapid",
    subject: "https://himawari.siyi.win",
  });
  raw["runPolicy"] = {
    ...policy,
    webPush: { secretRef: "web-push-vapid", subject: "mailto:owner@example.com" },
  };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.webPush?.subject,
  ).toBe("mailto:owner@example.com");
  for (const webPush of [
    { secretRef: "missing-secret", subject: "https://himawari.siyi.win" },
    { secretRef: "web-push-vapid", subject: "http://himawari.siyi.win" },
    { secretRef: "web-push-vapid", subject: "https://himawari.siyi.win/settings" },
    { secretRef: "web-push-vapid", subject: "owner@example.com" },
    { secretRef: "web-push-vapid", subject: "https://himawari.siyi.win", privateKey: "inline" },
  ]) {
    raw["runPolicy"] = { ...policy, webPush };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
  raw["runPolicy"] = { ...policy, reminderPush: { channel: "bark", secretRef: "web-push-vapid" } };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
});

it("[P3] parses every perception setting with its default and rejects unknown or out-of-range keys", () => {
  const raw = config("/tmp/himawari-perception-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const parse = (perception: unknown) => {
    raw["runPolicy"] = { ...policy, perception };
    return parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.perception;
  };
  expect(parse({})).toEqual(PERCEPTION_CONFIGURATION_DEFAULTS);
  const keys = Object.keys(PERCEPTION_CONFIGURATION_DEFAULTS) as (keyof PerceptionConfiguration)[];
  for (const key of keys) {
    const [minimum, maximum] = PERCEPTION_CONFIGURATION_RANGES[key];
    expect(() => parse({ [key]: minimum - 1 })).toThrow();
    expect(() => parse({ [key]: maximum + 1 })).toThrow();
    expect(() => parse({ [key]: "1" })).toThrow();
  }
  expect(parse({ previewCharacters: 40 })?.previewCharacters).toBe(40);
  expect(() => parse({ unknownSetting: 5 })).toThrow();
  expect(() => parse({ episodeSilenceSeconds: 600, episodeMaximumSeconds: 300 })).toThrow();
});

it("[IOS-4] accepts Apple push only with an apple-push secret, web push, Apple identifiers and listed topics", () => {
  const raw = config("/tmp/himawari-apple-push-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
    webPush: { secretRef: "web-push-vapid", subject: "https://himawari.siyi.win" },
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "web-push-vapid", version: "v1", purpose: "web-push", scope: "agent" },
    { ref: "apple-push-key", version: "v1", purpose: "apple-push", scope: "agent" },
  ];
  const base = {
    secretRef: "apple-push-key",
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    topics: ["win.siyi.himawari", "win.siyi.himawari.watchkitapp"],
    environments: ["production"],
  };
  const parse = (applePush: unknown, extra: Record<string, unknown> = policy) => {
    raw["runPolicy"] = { ...extra, applePush };
    return parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.applePush;
  };
  expect(parse(base)).toEqual({
    ...base,
    widgetRefreshMinimumSeconds: 900,
    liveActivityUpdateMinimumSeconds: 15,
    liveActivityStartAfterSeconds: 30,
    liveActivityStaleAfterSeconds: 600,
    actionTokenLifetimeSeconds: 86_400,
    requestTimeoutSeconds: 10,
    liveActivityRegistrationsPerDevice: 8,
  });
  expect(
    parse({
      ...base,
      widgetRefreshMinimumSeconds: 60,
      environments: ["development", "production"],
    }),
  ).toMatchObject({ widgetRefreshMinimumSeconds: 60, environments: ["development", "production"] });
  for (const applePush of [
    { ...base, secretRef: "web-push-vapid" },
    { ...base, secretRef: "missing-secret" },
    { ...base, teamId: "team" },
    { ...base, keyId: "KEY12345678" },
    { ...base, topics: [] },
    { ...base, topics: ["win.siyi.himawari", "win.siyi.himawari"] },
    { ...base, topics: ["bad topic"] },
    { ...base, topics: [`w${"a".repeat(232)}`] },
    { ...base, environments: ["staging"] },
    { ...base, environments: [] },
    { ...base, widgetRefreshMinimumSeconds: 0 },
    { ...base, liveActivityStaleAfterSeconds: 86_401 },
    { ...base, actionTokenLifetimeSeconds: 59 },
    { ...base, requestTimeoutSeconds: 1.5 },
    { ...base, liveActivityRegistrationsPerDevice: 0 },
    { ...base, liveActivityRegistrationsPerDevice: 65 },
    { ...base, signingKey: "inline" },
  ])
    expect(() => parse(applePush), JSON.stringify(applePush)).toThrow();
  const { webPush: _webPush, ...withoutWebPush } = policy;
  expect(() => parse(base, withoutWebPush)).toThrow();
});

it("[P1-1] parses the ten device hard limits with defaults and rejects unknown or out-of-range keys", () => {
  const raw = config("/tmp/himawari-device-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const parse = (device: unknown) => {
    raw["runPolicy"] = { ...policy, device };
    return parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.device;
  };
  const defaults = parse({});
  expect(defaults?.signatureToleranceSeconds).toBe(60);
  expect(Object.keys(defaults?.limits ?? {}).sort()).toEqual([...DEVICE_HARD_LIMIT_KEYS].sort());
  expect(defaults?.limits["device.request.body_bytes"]).toBe(1_048_576);
  expect(defaults?.limits["device.nonce.retained"]).toBe(10_000);
  expect(parse({ "device.track.batch_points": 5 })?.limits["device.track.batch_points"]).toBe(5);
  for (const key of DEVICE_HARD_LIMIT_KEYS) {
    expect(() => parse({ [key]: 0 })).toThrow();
    expect(() => parse({ [key]: 10 ** 12 })).toThrow();
  }
  expect(() => parse({ "device.unknown.limit": 5 })).toThrow();
  expect(() => parse({ heartbeatSeconds: 100, connectionMaxSeconds: 60 })).toThrow();
  expect(defaults?.streamConnections).toBe(4);
  expect(parse({ streamConnections: 8 })?.streamConnections).toBe(8);
  expect(() => parse({ streamConnections: 0 })).toThrow();
  expect(() => parse({ streamConnections: 65 })).toThrow();
});

it("[PG-12] accepts proactive Gmail checks only with a Google client secret and a private-capable model", () => {
  const raw = config("/tmp/himawari-proactive-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "google-oauth", version: "v1", purpose: "google-oauth-client", scope: "agent" },
  ];
  const proactive = {
    modelRef: "model-primary",
    gmail: { clientId: "123-abc.apps.googleusercontent.com", clientSecretRef: "google-oauth" },
  };
  raw["runPolicy"] = { ...policy, proactive };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive).toEqual({
    ...proactive,
    intervalMs: 900_000,
    perCheckMs: 180_000,
    dailyCostMicros: 1_000_000,
    bodyCharactersPerMail: 16_000,
    bodyCharactersPerBatch: 64_000,
    relatedMailsPerMail: 6,
    relatedCharactersPerMail: 12_000,
    relatedCharactersPerRelatedMail: 2_000,
    relatedRequestsPerCheck: 300,
    wholeThreadMailsPerMail: 50,
    wholeThreadCharactersPerMail: 60_000,
    ruleReplayDays: 30,
    ruleReplayMailsPerOutcome: 300,
    reviewBudgetSeconds: 120,
    reviewSecondsPerItem: 5,
    reviewSilentSharePermille: 500,
    reviewPrereview: {
      enabled: true,
      dailyLimit: 50,
      dailyCostMicros: 100_000,
      perRun: 10,
      requestTimeoutMs: 30_000,
      historyDays: 28,
      historyMinimum: 20,
      reduction: {
        enabled: false,
        hiddenAgreementPermille: 900,
        confidencePermille: 800,
        auditPermille: 200,
        windowDays: 28,
      },
    },
    reviewMemoryUnusedDays: 90,
    backoffThreshold: 3,
  });
  raw["runPolicy"] = {
    ...policy,
    proactive: {
      ...proactive,
      reviewPrereview: {
        dailyLimit: 20,
        reduction: { enabled: true, hiddenAgreementPermille: 950 },
      },
    },
  };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive
      ?.reviewPrereview,
  ).toMatchObject({
    enabled: true,
    dailyLimit: 20,
    reduction: { enabled: true, hiddenAgreementPermille: 950, auditPermille: 200 },
  });
  raw["runPolicy"] = {
    ...policy,
    proactive: {
      ...proactive,
      reviewBudgetSeconds: 300,
      reviewSecondsPerItem: 10,
      reviewSilentSharePermille: 200,
      reviewMemoryUnusedDays: 30,
      backoffThreshold: 5,
    },
  };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive,
  ).toMatchObject({
    reviewBudgetSeconds: 300,
    reviewSecondsPerItem: 10,
    reviewSilentSharePermille: 200,
    reviewMemoryUnusedDays: 30,
    backoffThreshold: 5,
  });
  raw["runPolicy"] = {
    ...policy,
    proactive: { ...proactive, relatedMailsPerMail: 0, relatedRequestsPerCheck: 40 },
  };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive,
  ).toMatchObject({ relatedMailsPerMail: 0, relatedRequestsPerCheck: 40 });
  raw["runPolicy"] = { ...policy, proactive: { ...proactive, perCheckCostMicros: 100_000 } };
  const legacy = parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive;
  expect(legacy).toBeDefined();
  expect(legacy).not.toHaveProperty("perCheckCostMicros");
  expect(legacy?.dailyCostMicros).toBe(1_000_000);
  for (const invalid of [
    { ...proactive, modelRef: "model-embedding" },
    { ...proactive, modelRef: "model-missing" },
    { ...proactive, gmail: { ...proactive.gmail, clientSecretRef: "missing-secret" } },
    { ...proactive, gmail: { ...proactive.gmail, clientId: "bad id" } },
    { ...proactive, gmail: { ...proactive.gmail, clientSecret: "inline" } },
    { ...proactive, perCheckCostMicros: 0 },
    { ...proactive, intervalMs: 1_000 },
    { ...proactive, memoryMinimumSimilarity: 1.5 },
    { ...proactive, reviewBudgetSeconds: 5 },
    { ...proactive, reviewSecondsPerItem: 0 },
    { ...proactive, reviewSilentSharePermille: 1_001 },
    { ...proactive, reviewSilentSharePermille: -1 },
    { ...proactive, reviewPrereview: { dailyLimit: 0 } },
    { ...proactive, reviewPrereview: { enabled: "yes" } },
    { ...proactive, reviewPrereview: { unknown: 1 } },
    { ...proactive, reviewPrereview: { reduction: { auditPermille: 0 } } },
    { ...proactive, reviewPrereview: { reduction: { hiddenAgreementPermille: 1_000 } } },
    { ...proactive, reviewPrereview: { reduction: { threshold: 900 } } },
    { ...proactive, reviewMemoryUnusedDays: 6 },
    { ...proactive, reviewMemoryUnusedDays: 3_651 },
    { ...proactive, backoffThreshold: 11 },
    { ...proactive, backoffThreshold: -1 },
    { ...proactive, relatedMailsPerMail: 51 },
    { ...proactive, relatedRequestsPerCheck: 0 },
    { ...proactive, wholeThreadMailsPerMail: 0 },
    { ...proactive, wholeThreadCharactersPerMail: 1_000 },
    { ...proactive, ruleReplayDays: 0 },
    { ...proactive, ruleReplayMailsPerOutcome: 0 },
    { ...proactive, relatedCharactersPerMail: 300, relatedCharactersPerRelatedMail: 400 },
  ]) {
    raw["runPolicy"] = { ...policy, proactive: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("[PG-12][reverse] rejects a proactive model that the mail check cannot call, before the service starts", () => {
  const raw = config("/tmp/himawari-proactive-specialist-config");
  (raw["modelDescriptors"] as Record<string, unknown>[]).push({
    ref: "model-specialist",
    role: "specialist",
    provider: "typesafe",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
    version: "snapshot-1",
    priority: 2,
    name: "Jev reviewer",
    api: "typesafe-systemone",
    capabilities: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    allowedDataClassifications: ["private"],
    disclosure: "external_remote",
    secretRef: "provider-specialist",
  });
  raw["secretReferences"] = [
    ...(raw["secretReferences"] as unknown[]),
    { ref: "provider-specialist", version: "v1", purpose: "model-auth", scope: "model-specialist" },
    { ref: "google-oauth", version: "v1", purpose: "google-oauth-client", scope: "agent" },
  ];
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const gmail = { clientId: "123-abc.apps.googleusercontent.com", clientSecretRef: "google-oauth" };
  raw["runPolicy"] = { ...policy, proactive: { modelRef: "model-primary", gmail } };
  expect(() => parseProductConfiguration(raw, "2026-11-13T00:00:00.000Z")).not.toThrow();
  raw["runPolicy"] = { ...policy, proactive: { modelRef: "model-specialist", gmail } };
  expect(() => parseProductConfiguration(raw, "2026-11-13T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ field: "configuration.runPolicy.proactive.modelRef" }),
    }),
  );
});

it("[P6-demo] accepts a fake inbox in place of Gmail, in one of the offered languages, and never both at once", () => {
  const raw = config("/tmp/himawari-demo-inbox-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "google-oauth", version: "v1", purpose: "google-oauth-client", scope: "agent" },
  ];
  const gmail = {
    clientId: "123-abc.apps.googleusercontent.com",
    clientSecretRef: "google-oauth",
  };
  for (const locale of ["ja", "en"]) {
    raw["runPolicy"] = { ...policy, proactive: { modelRef: "model-primary", demoInbox: locale } };
    const parsed = parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.proactive;
    expect(parsed?.demoInbox).toBe(locale);
    expect(parsed).not.toHaveProperty("gmail");
  }
  for (const invalid of [
    { modelRef: "model-primary" },
    { modelRef: "model-primary", gmail, demoInbox: "ja" },
    { modelRef: "model-primary", demoInbox: "zh-CN" },
    { modelRef: "model-primary", demoInbox: "" },
    { modelRef: "model-primary", demoInbox: true },
  ]) {
    raw["runPolicy"] = { ...policy, proactive: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("[P5-3] accepts the MCP entry only behind Cloudflare Access, with its own audience and no shared secret", () => {
  const raw = config("/tmp/himawari-mcp-access-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const accessIdentity = {
    issuer: "https://team.cloudflareaccess.com",
    audience: "access-audience-v1",
    jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    jwksCacheMilliseconds: 300_000,
    jwksTimeoutMilliseconds: 2_000,
    jwksMaximumBodyBytes: 65_536,
    clockToleranceSeconds: 30,
    identityLookupTimeoutMilliseconds: 2_000,
    identityLookupMaximumBodyBytes: 65_536,
    recentAuthentication: { maximumAgeMilliseconds: 900_000, clockSkewMilliseconds: 30_000 },
    bootstrap: {
      enabled: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSecretRef: "identity-bootstrap",
    },
    csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
  };
  raw["secretReferences"] = [
    ...(raw["secretReferences"] as unknown[]),
    { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
    { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
  ];
  raw["http"] = {
    listenHost: "127.0.0.1",
    listenPort: 8787,
    staticRoot: path.join("/tmp/himawari-mcp-access-config", "browser"),
    sessionCookieName: "himawari_session",
    maximumBodyBytes: 262_144,
    maximumStaticAssetBytes: 8 * 1024 * 1024,
    heartbeatMilliseconds: 15_000,
  };
  raw["identity"] = accessIdentity;
  for (const ownerProposals of [
    {},
    { pendingLimit: 1 },
    { pendingLimit: 200, expiresAfterDays: 3650 },
  ]) {
    raw["runPolicy"] = { ...policy, ownerProposals };
    expect(
      parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.ownerProposals,
    ).toEqual(ownerProposals);
  }
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.ownerProposals,
  ).toBeUndefined();
  for (const invalid of [
    { pendingLimit: 0 },
    { pendingLimit: 201 },
    { pendingLimit: 1.5 },
    { expiresAfterDays: 0 },
    { expiresAfterDays: 3651 },
    { limit: 20 },
    20,
  ]) {
    raw["runPolicy"] = { ...policy, ownerProposals: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
  for (const mcpRead of [
    { audience: "mcp-access-audience" },
    { audience: "mcp-access-audience", proposals: true },
  ]) {
    raw["runPolicy"] = { ...policy, mcpRead };
    expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.mcpRead).toEqual(
      mcpRead,
    );
  }
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.mcpRead,
  ).toBeUndefined();
  for (const invalid of [
    {},
    { secretRef: "mcp-read-secret" },
    { audience: "mcp-access-audience", secretRef: "mcp-read-secret" },
    { audience: "mcp-access-audience", writeSecretRef: "mcp-write-secret" },
    { audience: "mcp-access-audience", proposals: false },
    { audience: "mcp access audience" },
    "mcp-access-audience",
  ]) {
    raw["runPolicy"] = { ...policy, mcpRead: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
  const webAudience = (raw["identity"] as { audience: string }).audience;
  raw["runPolicy"] = { ...policy, mcpRead: { audience: webAudience } };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: {
        field: "configuration.runPolicy.mcpRead.audience",
        reason: "must differ from configuration.identity.audience",
      },
    }),
  );
  raw["runPolicy"] = { ...policy, mcpRead: { audience: "mcp-access-audience" } };
  const withoutIdentity = { ...raw };
  delete withoutIdentity["http"];
  delete withoutIdentity["identity"];
  expect(() => parseProductConfiguration(withoutIdentity, "2026-09-06T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: {
        field: "configuration.runPolicy.mcpRead",
        reason: "requires configuration.identity to use Cloudflare Access",
      },
    }),
  );
  raw["identity"] = {
    kind: "built-in",
    sessionIdleMilliseconds: 86_400_000,
    sessionAbsoluteMilliseconds: 604_800_000,
    recentAuthentication: { maximumAgeMilliseconds: 900_000, clockSkewMilliseconds: 30_000 },
    csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
  };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: {
        field: "configuration.runPolicy.mcpRead",
        reason: "requires configuration.identity to use Cloudflare Access",
      },
    }),
  );
});

it("accepts Muse intake only with a boolean switch and one secret whose purpose is muse-intake", () => {
  const raw = config("/tmp/himawari-muse-intake-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const references = raw["secretReferences"] as unknown[];
  raw["secretReferences"] = [
    ...references,
    { ref: "muse-intake-secret", version: "v1", purpose: "muse-intake", scope: "agent" },
    { ref: "other-secret", version: "v1", purpose: "google-oauth-client", scope: "agent" },
    { ref: "gap-export-secret", version: "v1", purpose: "gap-export", scope: "agent" },
  ];
  const museIntake = { enabled: true, secretRef: "muse-intake-secret" };
  raw["runPolicy"] = { ...policy, museIntake };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.museIntake).toEqual(
    museIntake,
  );
  const withGapExport = { ...museIntake, gapExportSecretRef: "gap-export-secret" };
  raw["runPolicy"] = { ...policy, museIntake: withGapExport };
  expect(parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.museIntake).toEqual(
    withGapExport,
  );
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.museIntake,
  ).toBeUndefined();
  for (const invalid of [
    { ...museIntake, enabled: "yes" },
    { secretRef: "muse-intake-secret" },
    { ...museIntake, secretRef: "other-secret" },
    { ...museIntake, secretRef: "missing-secret" },
    { ...museIntake, secret: "inline" },
    { ...museIntake, gapExportSecretRef: "muse-intake-secret" },
    { ...museIntake, gapExportSecretRef: "missing-secret" },
  ]) {
    raw["runPolicy"] = { ...policy, museIntake: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});

it("accepts home urgency scoring settings, fills in the defaults, and refuses values out of range", () => {
  const raw = config("/tmp/himawari-home-urgency-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = { ...policy, homeUrgency: {} };
  expect(parseProductConfiguration(raw, "2026-11-12T00:00:00.000Z").runPolicy?.homeUrgency).toEqual(
    {
      enabled: true,
      dailyLimit: 1_000,
      dailyCostMicros: 1_000_000,
      perCall: 20,
      referenceLimit: 30,
      requestTimeoutMs: 30_000,
      checkIntervalSeconds: 60,
      retryAfterHours: 24,
      affirmLabelMax: { "zh-CN": 6, ja: 8, en: 16 },
    },
  );
  raw["runPolicy"] = {
    ...policy,
    homeUrgency: {
      enabled: false,
      modelRef: "model-primary",
      dailyLimit: 0,
      perCall: 5,
      affirmLabelMax: { "zh-CN": 4, fr: 12 },
    },
  };
  expect(
    parseProductConfiguration(raw, "2026-11-12T00:00:00.000Z").runPolicy?.homeUrgency,
  ).toMatchObject({
    enabled: false,
    modelRef: "model-primary",
    dailyLimit: 0,
    perCall: 5,
    referenceLimit: 30,
    affirmLabelMax: { "zh-CN": 4, fr: 12 },
  });
  raw["runPolicy"] = policy;
  expect(
    parseProductConfiguration(raw, "2026-11-12T00:00:00.000Z").runPolicy?.homeUrgency,
  ).toBeUndefined();
  for (const invalid of [
    { enabled: "yes" },
    { unknown: 1 },
    { modelRef: "model-embedding" },
    { modelRef: "model-missing" },
    { dailyLimit: -1 },
    { dailyLimit: 100_001 },
    { perCall: 0 },
    { perCall: 51 },
    { referenceLimit: 201 },
    { requestTimeoutMs: 10 },
    { checkIntervalSeconds: 5 },
    { retryAfterHours: 0 },
    { affirmLabelMax: { "zh-CN": 0 } },
    { affirmLabelMax: { "zh-CN": 65 } },
    { affirmLabelMax: { "not a tag": 6 } },
    { affirmLabelMax: [6] },
  ]) {
    raw["runPolicy"] = { ...policy, homeUrgency: invalid };
    expect(() => parseProductConfiguration(raw, "2026-11-12T00:00:00.000Z")).toThrow();
  }
  (raw["modelDescriptors"] as Record<string, unknown>[]).push({
    ref: "model-specialist",
    role: "specialist",
    provider: "typesafe",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
    version: "snapshot-1",
    priority: 2,
    name: "Jev reviewer",
    api: "typesafe-systemone",
    capabilities: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    allowedDataClassifications: ["private", "sensitive"],
    disclosure: "external_remote",
    secretRef: "provider-specialist",
  });
  (raw["secretReferences"] as Record<string, unknown>[]).push({
    ref: "provider-specialist",
    version: "v1",
    purpose: "model-auth",
    scope: "model-specialist",
  });
  raw["runPolicy"] = { ...policy, homeUrgency: { modelRef: "model-specialist" } };
  expect(() => parseProductConfiguration(raw, "2026-11-12T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ field: "configuration.runPolicy.homeUrgency.modelRef" }),
    }),
  );
});

it("[A4] accepts a duplicate-judgement route that names a model-auth secret, fills the defaults and rejects bad values", () => {
  const raw = config("/tmp/himawari-import-duplicates-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const secrets = raw["secretReferences"] as Record<string, unknown>[];
  const modelAuth = secrets.find(({ purpose }) => purpose === "model-auth");
  if (!modelAuth) throw new Error("fixture secret missing");
  const base = {
    model: "typesafe-ai/jev",
    secretRef: modelAuth["ref"],
  };
  const parse = (importDuplicates: unknown) => {
    raw["runPolicy"] = { ...policy, importDuplicates };
    return parseProductConfiguration(raw, "2026-11-13T00:00:00.000Z").runPolicy?.importDuplicates;
  };
  expect(parse(base)).toEqual({ ...IMPORT_DUPLICATE_DEFAULTS, ...base });
  expect(parse({ ...base, yesAtLeastPermille: 850, noAtMostPermille: 150 })).toMatchObject({
    yesAtLeastPermille: 850,
    noAtMostPermille: 150,
  });
  const { model: _model, ...withoutModel } = base;
  for (const invalid of [
    withoutModel,
    { ...base, secretRef: "missing-secret" },
    { ...base, inputMicrosPerMillionTokens: 42_000 },
    { ...base, dailyMaximumRequests: 0 },
    { ...base, yesAtLeastPermille: 400 },
    { ...base, noAtMostPermille: 800 },
    { ...base, candidatesPerRequest: 0 },
    { ...base, apiKey: "inline" },
  ])
    expect(() => parse(invalid)).toThrow();
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-11-13T00:00:00.000Z").runPolicy?.importDuplicates,
  ).toBeUndefined();
});

it("[P4-5] accepts a real memory eval with a model that may see private and sensitive data and a weekly cap of at most 0.5 USD", () => {
  const raw = config("/tmp/himawari-real-eval-config");
  const descriptors = raw["modelDescriptors"] as Record<string, unknown>[];
  const primary = descriptors.find(({ ref }) => ref === "model-primary");
  if (!primary) throw new Error("fixture model missing");
  primary["allowedDataClassifications"] = ["public", "private", "sensitive"];
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  const realEval = {
    mode: "once",
    modelRef: "model-primary",
    weeklyCapMicros: 500_000,
    newMemoriesPerRun: 50,
    requestTimeoutMs: 60_000,
  };
  raw["runPolicy"] = { ...policy, realEval };
  expect(parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z").runPolicy?.realEval).toEqual(
    realEval,
  );
  for (const invalid of [
    { ...realEval, mode: "daily" },
    { ...realEval, modelRef: "model-embedding" },
    { ...realEval, modelRef: "model-missing" },
    { ...realEval, weeklyCapMicros: 500_001 },
    { ...realEval, weeklyCapMicros: 0 },
    { ...realEval, newMemoriesPerRun: 0 },
    { ...realEval, newMemoriesPerRun: 201 },
    { ...realEval, requestTimeoutMs: 10 },
    { ...realEval, budgetKey: "production" },
  ]) {
    raw["runPolicy"] = { ...policy, realEval: invalid };
    expect(() => parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z")).toThrow();
  }
  const embedding = descriptors.find(({ ref }) => ref === "model-embedding");
  if (!embedding) throw new Error("fixture embedding missing");
  embedding["allowedDataClassifications"] = ["public", "private"];
  raw["runPolicy"] = { ...policy, realEval };
  expect(() => parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ field: "configuration.runPolicy.realEval.mode" }),
    }),
  );
  raw["runPolicy"] = { ...policy, realEval: { ...realEval, mode: "off" } };
  expect(parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z").runPolicy?.realEval?.mode).toBe(
    "off",
  );
  embedding["allowedDataClassifications"] = ["public", "private", "sensitive", "restricted"];
  descriptors.push({
    ref: "model-specialist",
    role: "specialist",
    provider: "typesafe",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
    version: "snapshot-1",
    priority: 2,
    name: "Jev reviewer",
    api: "typesafe-systemone",
    capabilities: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    allowedDataClassifications: ["private", "sensitive"],
    disclosure: "external_remote",
    secretRef: "provider-specialist",
  });
  (raw["secretReferences"] as Record<string, unknown>[]).push({
    ref: "provider-specialist",
    version: "v1",
    purpose: "model-auth",
    scope: "model-specialist",
  });
  raw["runPolicy"] = { ...policy, realEval: { ...realEval, modelRef: "model-specialist" } };
  expect(() => parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ field: "configuration.runPolicy.realEval.modelRef" }),
    }),
  );
  primary["allowedDataClassifications"] = ["public", "private"];
  raw["runPolicy"] = { ...policy, realEval };
  expect(() => parseProductConfiguration(raw, "2026-11-11T00:00:00.000Z")).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ field: "configuration.runPolicy.realEval.modelRef" }),
    }),
  );
});

it("[P1-1] accepts the device access client id and secret only as one declared pair", () => {
  const at = "2026-11-12T00:00:00.000Z";
  const withAccess = (purposes: readonly string[]) => {
    const raw = config("/tmp/himawari-device-access");
    raw["secretReferences"] = [
      ...(raw["secretReferences"] as Record<string, unknown>[]),
      ...purposes.map((purpose, index) => ({
        ref: `device-access-${index}`,
        version: "v1",
        purpose,
        scope: "agent",
      })),
    ];
    return () => parseProductConfiguration(raw, at);
  };
  expect(withAccess([])).not.toThrow();
  expect(withAccess([...DEVICE_ACCESS_SECRET_PURPOSES])).not.toThrow();
  for (const purposes of [
    ["device-access-client-id"],
    ["device-access-client-secret"],
    [...DEVICE_ACCESS_SECRET_PURPOSES, "device-access-client-id"],
    [...DEVICE_ACCESS_SECRET_PURPOSES, ...DEVICE_ACCESS_SECRET_PURPOSES],
  ])
    expect(withAccess(purposes), purposes.join(",")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: expect.stringContaining("device access client id and secret"),
        }),
      }),
    );
});

it("accepts the approval preview length only from 1 to 2000 characters and leaves it unset by default", () => {
  const raw = config("/tmp/himawari-approval-preview-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy
      ?.approvalBodyPreviewCharacters,
  ).toBeUndefined();
  for (const value of [1, 300, 2000]) {
    raw["runPolicy"] = { ...policy, approvalBodyPreviewCharacters: value };
    expect(
      parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy
        ?.approvalBodyPreviewCharacters,
    ).toBe(value);
  }
  for (const value of [0, 2001, -1, 1.5, "300", null]) {
    raw["runPolicy"] = { ...policy, approvalBodyPreviewCharacters: value };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          field: "configuration.runPolicy.approvalBodyPreviewCharacters",
        }),
      }),
    );
  }
});

it("[ADR-0257] reads the owner intent check settings and rejects values out of range", () => {
  const raw = config("/tmp/himawari-owner-intent-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.ownerIntentCheck,
  ).toBeUndefined();
  const valid = {
    enabled: true,
    minConfidence: 900,
    timeoutMs: 5000,
    model: "typesafe-ai/jev",
    secretRef: "secret:owner-intent",
  };
  raw["runPolicy"] = { ...policy, ownerIntentCheck: valid };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.ownerIntentCheck,
  ).toEqual(valid);
  for (const ownerIntentCheck of [
    { ...valid, minConfidence: 499 },
    { ...valid, timeoutMs: 100 },
    { ...valid, enabled: "yes" },
    { ...valid, model: "bad ref" },
    { ...valid, secretRef: "bad ref" },
    { enabled: true, minConfidence: 900, timeoutMs: 5000, model: "typesafe-ai/jev" },
    { ...valid, extra: 1 },
  ]) {
    raw["runPolicy"] = { ...policy, ownerIntentCheck };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          field: expect.stringContaining("configuration.runPolicy.ownerIntentCheck"),
        }),
      }),
    );
  }
});

it("[ADR-0257] reads the tool refusal limits from the run policy and rejects values out of range", () => {
  const raw = config("/tmp/himawari-tool-refusals-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
  };
  raw["runPolicy"] = { ...policy };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.toolRefusals,
  ).toBeUndefined();
  raw["runPolicy"] = { ...policy, toolRefusals: { consecutive: 2, total: 9 } };
  expect(
    parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z").runPolicy?.toolRefusals,
  ).toEqual({ consecutive: 2, total: 9 });
  for (const toolRefusals of [
    { consecutive: 0, total: 9 },
    { consecutive: 2, total: 0 },
    { consecutive: 2 },
    { consecutive: 2, total: 9, extra: 1 },
  ]) {
    raw["runPolicy"] = { ...policy, toolRefusals };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          field: expect.stringContaining("configuration.runPolicy.toolRefusals"),
        }),
      }),
    );
  }
});
