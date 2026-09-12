// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted

import { ModelInvocationAdmissionService } from "@himawari-agent/application";
import type {
  MemorySearchRequest,
  ModelInvocationPermit,
  RunExecutionSource,
} from "@himawari-agent/application";

import type { Mem0EmbeddingBoundary } from "@himawari-agent/memory-mem0";
import {
  embeddingAdmissionDescriptor,
  createProductionRunMemory,
} from "../src/production-run-memory.js";
import { createProductionRunPolicy } from "../src/production-run-policy.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import type {
  ConfiguredPiModelDescriptor,
  PiModelRuntime,
  PiModelRuntimeFactory,
} from "@himawari-agent/runtime-pi";
import { createReferenceAdapterSet, type ReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProductionMemoryCompositionFromConfiguration,
  createProductionModelComposition,
  resolveConfiguredModelDescriptorSet,
} from "../src/index.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "himawari-production-composition-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const primaryModel: ConfiguredPiModelDescriptor = {
  ref: "model-openrouter-primary",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash-0731",
  version: "catalog-2026-08-28",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text", "tool_calling", "structured_outputs"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  name: "DeepSeek V4 Flash 0731",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
};

const fallbackRouting = {
  order: ["z-ai"],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny" as const,
};

const fallbackModel: ConfiguredPiModelDescriptor = {
  ref: "model-openrouter-fallback",
  provider: "openrouter",
  model: "z-ai/glm-5.3-flash",
  version: "catalog-2026-08-28",
  routingClass: "fallback",
  priority: 2,
  disclosure: "external_remote",
  capabilities: ["text", "tool_calling", "structured_outputs"],
  allowedDataClassifications: ["private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  providerRouting: fallbackRouting,
  name: "GLM 5.3 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
};

const descriptors = [primaryModel, fallbackModel] as const;

class RecordingRuntime {
  readonly models = new Map<string, unknown>();
  readonly removedProviders: string[] = [];

  getModel(providerId: string, modelId: string): unknown | undefined {
    return this.models.get(`${providerId}:${modelId}`);
  }

  registerProvider(providerId: string, config: Readonly<Record<string, unknown>>): void {
    const models = config["models"];
    if (!Array.isArray(models)) throw new Error("models missing");
    for (const model of models) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw new Error("model invalid");
      }
      const id = (model as Record<string, unknown>)["id"];
      if (typeof id !== "string") throw new Error("model id missing");
      this.models.set(`${providerId}:${id}`, model);
    }
  }

  async setRuntimeApiKey(): Promise<void> {}

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.removedProviders.push(providerId);
  }
}

function compositionOptions(
  adapters: ReferenceAdapterSet,
  overrides: Partial<Parameters<typeof createProductionModelComposition>[0]> = {},
) {
  const resolve = vi.fn(async () => "fixture-provider-value");
  const options = {
    ownerId: "owner-production-model" as never,
    agentId: "agent-production-model" as never,
    descriptors,
    handles: adapters.secret,
    secretSource: {
      kind: "macos-keychain" as const,
      productionSuitable: true,
      resolve,
    },
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    ids: adapters.ids,
    clock: adapters.clock,
    ...overrides,
  };
  return { options, resolve };
}

function selectedEmbeddingConfiguration(stateRoot: string) {
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-production-memory",
      ownerId: "owner-production-memory",
      agentId: "agent-production-memory",
      stateRoot,
      runtimeDirectory: `${stateRoot}/runtime`,
      cacheDirectory: `${stateRoot}/cache`,
      publicOrigin: "http://127.0.0.1",
      publicMode: false,
      modelDescriptors: [
        {
          ref: "model-primary",
          role: "primary",
          provider: "openrouter",
          model: primaryModel.model,
          version: primaryModel.version,
          priority: primaryModel.priority,
          name: primaryModel.name,
          api: "openai-completions",
          reasoning: primaryModel.reasoning,
          input: [...primaryModel.input],
          capabilities: [...primaryModel.capabilities],
          cost: { ...primaryModel.cost },
          contextWindow: primaryModel.contextWindow,
          maxTokens: primaryModel.maxTokens,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
        {
          ref: "model-fallback",
          role: "fallback",
          provider: "openrouter",
          model: fallbackModel.model,
          version: fallbackModel.version,
          priority: fallbackModel.priority,
          name: fallbackModel.name,
          api: "openai-completions",
          reasoning: fallbackModel.reasoning,
          input: [...fallbackModel.input],
          capabilities: [...fallbackModel.capabilities],
          cost: { ...fallbackModel.cost },
          contextWindow: fallbackModel.contextWindow,
          maxTokens: fallbackModel.maxTokens,
          allowedDataClassifications: ["private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
          providerRouting: fallbackRouting,
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "openrouter",
          model: "qwen/qwen3-embedding-8b",
          version: "catalog-2026-08-28",
          capabilities: ["embedding"],
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 4096,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.1.7",
        storagePath: `${stateRoot}/data/memory`,
        dimensions: 4096,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: "openrouter-api-key",
          version: "v1",
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
      budgets: {
        globalCostMicros: 1_000_000,
        perRunCostMicros: 1_000_000,
        perClassificationCostMicros: {
          public: 1_000_000,
          private: 1_000_000,
          sensitive: 0,
          restricted: 0,
        },
      },
      concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
    },
    "2026-08-28T00:00:00.000Z",
  );
}

describe("production model composition", () => {
  it("wires the trusted transport and closed Pi binding to the same descriptors", async () => {
    const adapters = createReferenceAdapterSet();
    const runtime = new RecordingRuntime();
    const runtimeFactory: PiModelRuntimeFactory = {
      create: async () => runtime as unknown as PiModelRuntime,
    };
    const prepared = compositionOptions(adapters, { runtimeFactory });
    const composition = createProductionModelComposition(prepared.options);

    expect(await composition.model.listAvailable()).toEqual(descriptors);
    expect(prepared.resolve).not.toHaveBeenCalled();
    const binding = await composition.piModels.resolve(primaryModel.ref);
    expect(binding.model).toBe(runtime.models.get("openrouter:deepseek/deepseek-v4-flash-0731"));
    expect(prepared.resolve).not.toHaveBeenCalled();
    if (!binding.resolveSecret) throw new Error("Expected deferred provider secret resolver");
    await expect(binding.resolveSecret()).resolves.toBe("fixture-provider-value");
    expect(prepared.resolve).toHaveBeenCalledWith("openrouter-api-key", "v1");
    expect(prepared.resolve).toHaveBeenCalledTimes(1);
    expect(composition.transport).toBeDefined();
    expect(composition.payloadBoundary).toBeDefined();

    await composition.close();
    expect(runtime.removedProviders).toEqual([]);
  });

  it("rejects unsafe secret sources and conflicting canonical descriptors", () => {
    const adapters = createReferenceAdapterSet();
    expect(() =>
      createProductionModelComposition(
        compositionOptions(adapters, {
          secretSource: {
            kind: "macos-keychain",
            productionSuitable: false,
            resolve: async () => "fixture-provider-value",
          },
        }).options,
      ),
    ).toThrow("Development secret sources are forbidden in production or public profiles");

    expect(() =>
      createProductionModelComposition(
        compositionOptions(adapters, {
          descriptors: [
            primaryModel,
            {
              ...fallbackModel,
              secretRequirement: { ...fallbackModel.secretRequirement, secretVersion: "v2" },
            },
          ],
        }).options,
      ),
    ).toThrow("PI_MODEL_BINDING_REQUIRES_SHARED_PROVIDER_SECRET");
  });

  it("maps strict configuration into one Pi generation set and an independent embedding descriptor", () => {
    const stateRoot = temporaryDirectory;
    const configuration = parseProductConfiguration(
      {
        schemaVersion: "himawari.configuration.v1",
        deploymentId: "deployment-model-descriptor-test",
        ownerId: "owner-model-descriptor-test",
        agentId: "agent-model-descriptor-test",
        stateRoot,
        runtimeDirectory: `${stateRoot}/runtime`,
        cacheDirectory: `${stateRoot}/cache`,
        publicOrigin: "http://127.0.0.1",
        publicMode: false,
        modelDescriptors: [
          {
            ref: "model-primary",
            role: "primary",
            provider: "openrouter",
            model: primaryModel.model,
            version: primaryModel.version,
            priority: 1,
            name: primaryModel.name,
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            capabilities: [...primaryModel.capabilities],
            cost: { ...primaryModel.cost },
            contextWindow: primaryModel.contextWindow,
            maxTokens: primaryModel.maxTokens,
            allowedDataClassifications: ["public", "private"],
            disclosure: "external_remote",
            secretRef: "openrouter-api-key",
          },
          {
            ref: "model-fallback",
            role: "fallback",
            provider: "openrouter",
            model: fallbackModel.model,
            version: fallbackModel.version,
            priority: 2,
            name: fallbackModel.name,
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            capabilities: [...fallbackModel.capabilities],
            cost: { ...fallbackModel.cost },
            contextWindow: fallbackModel.contextWindow,
            maxTokens: fallbackModel.maxTokens,
            allowedDataClassifications: ["private"],
            disclosure: "external_remote",
            secretRef: "openrouter-api-key",
            providerRouting: fallbackRouting,
          },
          {
            ref: "model-embedding",
            role: "embedding",
            provider: "openai-compatible",
            model: "text-embedding-fixture",
            version: "catalog-2026-08-28",
            capabilities: ["embedding"],
            cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
            dimensions: 1536,
            allowedDataClassifications: ["public", "private"],
            disclosure: "trusted_remote",
            secretRef: "embedding-api-key",
          },
        ],
        memory: {
          adapter: "mem0-oss",
          version: "3.1.7",
          storagePath: `${stateRoot}/data/memory`,
          dimensions: 1536,
        },
        repositoryAllowlistRefs: [],
        secretReferences: [
          {
            ref: "openrouter-api-key",
            version: "v1",
            purpose: "model-provider-auth",
            scope: "model",
          },
          {
            ref: "embedding-api-key",
            version: "v2",
            purpose: "embedding-provider-auth",
            scope: "embedding",
          },
        ],
        budgets: {
          globalCostMicros: 0,
          perRunCostMicros: 0,
          perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
        },
        concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
        deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
      },
      "2026-08-27T00:00:00.000Z",
    );

    const resolved = resolveConfiguredModelDescriptorSet(configuration);
    expect(resolved.generation).toHaveLength(2);
    expect(resolved.generation[0]).toMatchObject({
      ref: "model-primary",
      provider: "openrouter",
      secretRequirement: {
        secretRef: "openrouter-api-key",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
    });
    expect(resolved.generation[1]?.providerRouting).toEqual(fallbackRouting);
    expect(resolved.embedding).toMatchObject({
      ref: "model-embedding",
      provider: "openai-compatible",
      model: "text-embedding-fixture",
      version: "catalog-2026-08-28",
      dimensions: 1536,
      secretRequirement: {
        secretRef: "embedding-api-key",
        secretVersion: "v2",
        purpose: "embedding-provider-auth",
      },
    });
    expect(resolved.embedding).not.toHaveProperty("input");
    expect(resolved.embedding).not.toHaveProperty("api");
  });

  it("fails closed instead of inventing a Pi route for an unregistered generation provider", () => {
    const configuration = {
      modelDescriptors: [
        { ...primaryModel, role: "primary" as const, provider: "unknown-provider" },
        { ...fallbackModel, role: "fallback" as const },
        {
          ref: "model-embedding",
          role: "embedding" as const,
          provider: "deterministic",
          model: "embedding-fixture",
          version: "fixture-1",
          dimensions: 8,
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          allowedDataClassifications: ["public", "private"],
          disclosure: "local_only" as const,
          secretRef: null,
        },
      ],
      memory: { dimensions: 8 },
      secretReferences: primaryModel.secretRequirement
        ? [{ ...primaryModel.secretRequirement, scope: "model" }]
        : [],
    } as never;
    expect(() => resolveConfiguredModelDescriptorSet(configuration)).toThrow(
      "MODEL_PI_PROVIDER_UNSUPPORTED",
    );
  });

  it("composes the selected 4096-dimensional Qwen embedding through Mem0", async () => {
    const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
    const resolvedSecrets: string[] = [];
    const composition = await createProductionMemoryCompositionFromConfiguration({
      configuration,
      secretSource: {
        kind: "macos-keychain",
        productionSuitable: true,
        resolve: async (secretRef, secretVersion) => {
          resolvedSecrets.push(`${secretRef}@${secretVersion}`);
          return "fixture-provider-value";
        },
      },
      load: async () => ({
        Memory: class {
          readonly configuration: Readonly<Record<string, unknown>>;

          constructor(configuration: Readonly<Record<string, unknown>>) {
            this.configuration = configuration;
          }
        } as never,
      }),
    });

    expect(composition.descriptor).toMatchObject({
      provider: "openrouter",
      model: "qwen/qwen3-embedding-8b",
      version: "catalog-2026-08-28",
      dimensions: 4096,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(resolvedSecrets).toEqual(["openrouter-api-key@v1"]);
    await composition.close();
  });
});

it("selects trusted Run policy and binds instruction content across configuration changes", async () => {
  const adapters = createReferenceAdapterSet();
  const configuration = {
    ...selectedEmbeddingConfiguration(temporaryDirectory),
    runPolicy: {
      version: "policy-v1",
      timeZone: "Asia/Tokyo",
      systemInstruction: "可信系统指令",
      memoryLimit: 10,
      maxSelectedMemories: 5,
      maxMemoryClassification: "private" as const,
    },
  };
  const source: RunExecutionSource = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId: "policy-run" as RunExecutionSource["runId"],
    sessionId: "policy-session" as RunExecutionSource["sessionId"],
    threadId: null,
    triggerId: "policy-trigger" as RunExecutionSource["triggerId"],
    sourceType: "user_message",
    sourceId: "owner-message",
    payloadRef: "owner-content",
    dataClassification: "private",
    occurredAt: "2026-09-10T23:04:00.000Z",
  };
  const list = vi.fn(async () => []);
  const options = {
    configuration,
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    handles: { getExecutionHandle: async () => undefined, listRunExecutionHandles: list },
    clock: adapters.clock,
    ids: adapters.ids,
  };
  const protect = vi.spyOn(adapters.payloadProtector, "protect");
  const policy = createProductionRunPolicy(options);
  const first = await policy(source);
  expect(first).toMatchObject({
    modelRef: "model-primary",
    policyVersion: "policy-v1",
    capabilityHandleRefs: [],
  });
  expect(new TextDecoder().decode(protect.mock.calls[0]?.[0].plaintext)).toContain(
    source.occurredAt,
  );
  expect(new TextDecoder().decode(protect.mock.calls[0]?.[0].plaintext)).toContain(
    "2026-09-11 08:04:00 GMT+09:00",
  );
  expect(list).toHaveBeenCalledWith(source.runId, adapters.clock.now());
  expect((await policy(source)).systemInstructionRef).toBe(first.systemInstructionRef);
  const threadSource = {
    ...source,
    threadId: "language-thread" as NonNullable<RunExecutionSource["threadId"]>,
  };
  const threadPolicy = await policy(threadSource);
  expect(threadPolicy.answerLocalePolicy).toBeUndefined();
  expect(threadPolicy.systemInstructionRef).toBe(first.systemInstructionRef);
  expect(protect).toHaveBeenCalledTimes(1);
  const changed = await createProductionRunPolicy({
    ...options,
    configuration: {
      ...configuration,
      runPolicy: {
        ...configuration.runPolicy,
        version: "policy-v2",
        systemInstruction: "另一条可信指令",
      },
    },
  })(source);
  expect(changed.systemInstructionRef).not.toBe(first.systemInstructionRef);
  await expect(
    policy({ ...source, ownerId: "another-owner" as RunExecutionSource["ownerId"] }),
  ).rejects.toThrow("RUN_POLICY_SCOPE_MISMATCH");
  await expect(policy({ ...source, dataClassification: "restricted" })).rejects.toThrow(
    "RUN_POLICY_MODEL_DISCLOSURE_DENIED",
  );
});

it("propagates Run cancellation and remaining deadline to embedding and retains uncertain spend", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: Mem0EmbeddingBoundary | undefined;
  const controller = new AbortController();
  const now = "2026-09-06T00:00:00.000Z";
  const permit: ModelInvocationPermit = {
    assertActive: vi.fn(async () => {}),
    markStarted: vi.fn(async () => {}),
    releaseReserved: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
  };
  const send = vi.fn(async (options?: { timeoutMs?: number; signal?: AbortSignal }) => {
    expect(options?.timeoutMs).toBe(500);
    controller.abort(new Error("RUN_CANCELLED"));
    options?.signal?.throwIfAborted();
    throw new Error("CANCELLATION_NOT_PROPAGATED");
  });
  const memory = createProductionRunMemory({
    configuration,
    projection: {
      bindEmbeddingBoundary: (value) => {
        boundary = value;
      },
    },
    payloads: { get: async () => ({ dataClassification: "private" }) as never },
    memory: {
      search: async () => {
        if (!boundary) throw new Error("BOUNDARY_MISSING");
        await boundary(
          { model: "qwen/qwen3-embedding-8b", input: "query", dimensions: 4096 },
          send,
        );
        return [];
      },
    },
    admission: async () => ({ begin: async () => ({ disposition: "fresh", permit }) }) as never,
    budget: {} as never,
    assertActive: async () => {},
    now: () => now,
  });
  const request: MemorySearchRequest = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId: "run-embedding" as never,
    executionLease: {} as never,
    dataClassification: "private",
    queryRef: "query" as never,
    queryTerms: [],
    limit: 3,
    signal: controller.signal,
    deadlineAt: "2026-09-06T00:00:00.500Z",
  };
  await expect(memory.search(request)).rejects.toThrow("RUN_CANCELLED");
  expect(send).toHaveBeenCalledTimes(1);
  expect(permit.markStarted).toHaveBeenCalledTimes(1);
  expect(permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
  expect(permit.settle).not.toHaveBeenCalled();
  expect(permit.releaseReserved).not.toHaveBeenCalled();
  await expect(
    memory.search({ ...request, signal: new AbortController().signal, deadlineAt: now }),
  ).rejects.toThrow("EMBEDDING_DEADLINE_EXCEEDED");
  expect(send).toHaveBeenCalledTimes(1);
});

it("retries only unstarted projection reservations and never repeats an uncertain provider request", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: Mem0EmbeddingBoundary | undefined;
  const reserve = vi
    .fn()
    .mockResolvedValueOnce({ replayed: true, allocation: { status: "released" } })
    .mockResolvedValueOnce({ replayed: false, allocation: { status: "reserved" } })
    .mockResolvedValueOnce({ replayed: true, allocation: { status: "unknown" } });
  const markStarted = vi.fn(async () => ({}) as never);
  const settle = vi.fn(async () => ({}) as never);
  const memory = createProductionRunMemory({
    configuration,
    projection: {
      bindEmbeddingBoundary: (value) => {
        boundary = value;
      },
    },
    payloads: { get: async () => undefined },
    memory: { search: async () => [] },
    admission: async () => undefined,
    budget: {
      reserve,
      markStarted,
      settle,
      read: async () => undefined,
      releaseReserved: async () => ({}) as never,
      markUnknown: async () => ({}) as never,
      finalize: async () => ({}) as never,
    },
    assertActive: async () => {},
    now: () => "2026-09-06T00:00:00.000Z",
  });
  const send = vi.fn(async () => ({
    data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => 0.1) }],
    usage: { prompt_tokens: 8, total_tokens: 8 },
  }));
  const project = () =>
    memory.project(
      {
        id: "projection-1",
        claimedBy: "consumer",
        attemptCount: 2,
        claimExpiresAt: "2026-09-06T00:00:30.000Z",
      } as never,
      { dataClassification: "private" } as never,
      async () => {
        if (!boundary) throw new Error("BOUNDARY_MISSING");
        await boundary(
          { model: "qwen/qwen3-embedding-8b", input: "memory", dimensions: 4096 },
          send,
        );
        return "provider-memory-1";
      },
    );
  await expect(project()).resolves.toBe("provider-memory-1");
  expect(reserve.mock.calls[1]?.[0].operationKey).toMatch(/:attempt:2$/u);
  expect(markStarted).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledTimes(1);
  await expect(project()).rejects.toThrow("EMBEDDING_RESULT_REQUIRES_RECONCILIATION");
  expect(send).toHaveBeenCalledTimes(1);
});

it("accepts the production embedding descriptor in the real invocation registry", () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  expect(
    () =>
      new ModelInvocationAdmissionService({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        runId: "run" as never,
        executionLease: {
          executionLeaseId: "execution" as never,
          expectedLeaseRevision: 1,
          authorityLeaseId: "authority" as never,
          authorityFencingToken: 1,
          deploymentId: configuration.deploymentId,
          authorityEpoch: 1,
          fencingToken: 1,
          consumerId: "consumer",
        },
        dispatch: {} as never,
        invocations: {} as never,
        clock: { now: () => "2026-09-06T00:00:00.000Z" },
        limits: {
          accountCostMicros: configuration.budgets.perRunCostMicros,
          globalCostMicros: configuration.budgets.globalCostMicros,
          perClassificationCostMicros: configuration.budgets.perClassificationCostMicros,
        },
        registry: [embeddingAdmissionDescriptor(configuration)],
      }),
  ).not.toThrow();
});
