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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
    allowUntrustedTools: true,
  };
  expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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
      maxMemoryClassification: "private",
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
    maxMemoryClassification: "private",
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

it("[PG-12] accepts proactive Gmail checks only with a Google client secret and a private-capable model", () => {
  const raw = config("/tmp/himawari-proactive-config");
  const policy = {
    version: "1",
    systemInstruction: "test",
    memoryLimit: 10,
    maxSelectedMemories: 1,
    maxMemoryClassification: "private",
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
    perCheckCostMicros: 100_000,
    perCheckMs: 180_000,
    dailyCostMicros: 1_000_000,
  });
  for (const invalid of [
    { ...proactive, modelRef: "model-embedding" },
    { ...proactive, modelRef: "model-missing" },
    { ...proactive, gmail: { ...proactive.gmail, clientSecretRef: "missing-secret" } },
    { ...proactive, gmail: { ...proactive.gmail, clientId: "bad id" } },
    { ...proactive, gmail: { ...proactive.gmail, clientSecret: "inline" } },
    { ...proactive, perCheckCostMicros: 2_000_000 },
    { ...proactive, intervalMs: 1_000 },
  ]) {
    raw["runPolicy"] = { ...policy, proactive: invalid };
    expect(() => parseProductConfiguration(raw, "2026-09-06T00:00:00.000Z")).toThrow();
  }
});
