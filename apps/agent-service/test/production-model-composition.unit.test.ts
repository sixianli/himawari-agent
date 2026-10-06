// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted

import { ModelInvocationAdmissionService } from "@himawari-agent/application";
import type {
  MemorySearchRequest,
  ModelInvocationPermit,
  RunExecutionSource,
} from "@himawari-agent/application";

import type { Mem0EmbeddingBoundary, Mem0EmbeddingResponse } from "@himawari-agent/memory-mem0";
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
import { createProductionMemoryCompositionFromConfiguration } from "../src/production-memory-composition.js";
import {
  createProductionModelComposition,
  resolveConfiguredModelDescriptorSet,
} from "../src/production-model-composition.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "himawari-production-composition-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const primaryModel: ConfiguredPiModelDescriptor = {
  ref: "model-vercel-ai-gateway-primary",
  provider: "vercel-ai-gateway",
  model: "deepseek/deepseek-v4.1-flash",
  version: "catalog-2026-10-06",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text", "tool_calling", "structured_outputs"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: {
    secretRef: "vercel-ai-gateway-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
  contextWindow: 1_048_576,
  maxTokens: 32768,
};

const descriptors = [primaryModel] as const;

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
          provider: "vercel-ai-gateway",
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
          providerRouting: primaryModel.providerRouting,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "vercel-ai-gateway-api-key",
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "vercel-ai-gateway",
          model: "alibaba/qwen3-embedding-8b",
          version: "catalog-2026-10-06",
          capabilities: ["embedding"],
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 4096,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "vercel-ai-gateway-api-key",
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.3.1",
        storagePath: `${stateRoot}/data/memory`,
        dimensions: 4096,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: "vercel-ai-gateway-api-key",
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
    expect(binding.model).toBe(
      runtime.models.get("vercel-ai-gateway:deepseek/deepseek-v4.1-flash"),
    );
    expect(prepared.resolve).not.toHaveBeenCalled();
    if (!binding.resolveSecret) throw new Error("Expected deferred provider secret resolver");
    await expect(binding.resolveSecret()).resolves.toBe("fixture-provider-value");
    expect(prepared.resolve).toHaveBeenCalledWith("vercel-ai-gateway-api-key", "v1");
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
              ...primaryModel,
              secretRequirement: { ...primaryModel.secretRequirement, secretVersion: "v2" },
            },
          ],
        }).options,
      ),
    ).toThrow("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
  });

  it("[R2-L5] maps strict configuration into one Pi generation set and an independent embedding descriptor", () => {
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
            provider: "vercel-ai-gateway",
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
            providerRouting: primaryModel.providerRouting,
            allowedDataClassifications: ["public", "private"],
            disclosure: "external_remote",
            secretRef: "vercel-ai-gateway-api-key",
          },
          {
            ref: "model-embedding",
            role: "embedding",
            provider: "vercel-ai-gateway",
            model: "alibaba/qwen3-embedding-8b",
            version: "catalog-2026-10-06",
            capabilities: ["embedding"],
            cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
            dimensions: 4096,
            allowedDataClassifications: ["public", "private"],
            disclosure: "trusted_remote",
            secretRef: "embedding-api-key",
          },
        ],
        memory: {
          adapter: "mem0-oss",
          version: "3.3.1",
          storagePath: `${stateRoot}/data/memory`,
          dimensions: 4096,
        },
        repositoryAllowlistRefs: [],
        secretReferences: [
          {
            ref: "vercel-ai-gateway-api-key",
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
    expect(resolved.generation).toHaveLength(1);
    expect(resolved.generation[0]).toMatchObject({
      ref: "model-primary",
      provider: "vercel-ai-gateway",
      secretRequirement: {
        secretRef: "vercel-ai-gateway-api-key",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
    });
    expect(resolved.generation[0]?.providerRouting).toEqual(primaryModel.providerRouting);
    expect(resolved.embedding).toMatchObject({
      ref: "model-embedding",
      provider: "vercel-ai-gateway",
      model: "alibaba/qwen3-embedding-8b",
      version: "catalog-2026-10-06",
      dimensions: 4096,
      secretRequirement: {
        secretRef: "embedding-api-key",
        secretVersion: "v2",
        purpose: "embedding-provider-auth",
      },
    });
    expect(resolved.embedding).not.toHaveProperty("input");
    expect(resolved.embedding).not.toHaveProperty("api");
  });

  it("keeps a dedicated TypeSafe reviewer outside the single Pi generation route", () => {
    const base = selectedEmbeddingConfiguration(temporaryDirectory);
    const configuration = {
      ...base,
      modelDescriptors: [
        ...base.modelDescriptors,
        {
          ref: "model-specialist",
          role: "specialist" as const,
          provider: "typesafe",
          model: "jev-latest",
          version: "review-config-1",
          modelVersion: "jev-1.13.0",
          priority: 3,
          name: "JEV reviewer",
          api: "typesafe-systemone" as const,
          capabilities: ["text"],
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
          allowedDataClassifications: ["private" as const],
          disclosure: "external_remote" as const,
          secretRef: "typesafe-api-key",
        },
      ],
      secretReferences: [
        ...base.secretReferences,
        { ref: "typesafe-api-key", version: "v1", purpose: "model-provider-auth", scope: "model" },
      ],
    };
    const resolved = resolveConfiguredModelDescriptorSet(configuration);
    expect(resolved.generation).toHaveLength(2);
    expect(resolved.generation.map(({ routingClass }) => routingClass)).toEqual([
      "primary",
      "specialist",
    ]);
    expect(resolved.generation[1]).toMatchObject({
      api: "typesafe-systemone",
      model: "jev-latest",
      version: "jev-1.13.0",
      secretRequirement: { secretRef: "typesafe-api-key", secretVersion: "v1" },
    });
    const piRoutes = resolved.generation.filter(
      (descriptor): descriptor is ConfiguredPiModelDescriptor =>
        descriptor.api === "openai-completions",
    );
    expect(piRoutes).toHaveLength(1);
  });

  it("fails closed instead of inventing a Pi route for an unregistered generation provider", () => {
    const configuration = {
      modelDescriptors: [
        { ...primaryModel, role: "primary" as const, provider: "unknown-provider" },
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

  it("[R2-L5] composes the selected 4096-dimensional Qwen embedding through Mem0", async () => {
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
        VectorStoreFactory: { create: () => ({ initialize: async () => undefined }) },
        Memory: class {
          readonly configuration: Readonly<Record<string, unknown>>;

          constructor(configuration: Readonly<Record<string, unknown>>) {
            this.configuration = configuration;
          }
        } as never,
      }),
    });

    expect(composition.descriptor).toMatchObject({
      provider: "vercel-ai-gateway",
      model: "alibaba/qwen3-embedding-8b",
      version: "catalog-2026-10-06",
      dimensions: 4096,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(resolvedSecrets).toEqual(["vercel-ai-gateway-api-key@v1"]);
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
          { model: "alibaba/qwen3-embedding-8b", input: "query", dimensions: 4096 },
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
    model: "alibaba/qwen3-embedding-8b",
    providerMetadata: {
      gateway: {
        cost: "0.00000019",
        generationId: "projection-generation",
        routing: { finalProvider: "deepinfra" },
      },
    },
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
          { model: "alibaba/qwen3-embedding-8b", input: "memory", dimensions: 4096 },
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

it.each([false, true])(
  "generates a title through the selected Pi transport (required reasoning: %s)",
  async (reasoningRequired) => {
    const adapters = createReferenceAdapterSet();
    const streamOptions: Record<string, unknown>[] = [];
    class TitleRuntime extends RecordingRuntime {
      override getModel(providerId: string, modelId: string): unknown {
        const value = super.getModel(providerId, modelId);
        return value ? { ...(value as Record<string, unknown>), provider: providerId } : undefined;
      }
      stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
        streamOptions.push(options);
        return (async function* () {
          await (options["fetch"] as typeof fetch)(
            "https://ai-gateway.vercel.sh/v1/chat/completions",
          );
          yield {
            type: "done",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "日本今日头条" }],
              api: "openai-completions",
              provider: "vercel-ai-gateway",
              model: primaryModel.model,
              stopReason:
                reasoningRequired && Number(options["maxTokens"]) < 512 ? "length" : "stop",
              timestamp: Date.now(),
              usage: {
                input: 30,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 40,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
              },
            },
          };
        })();
      }
    }
    const runtime = new TitleRuntime();
    const permit: ModelInvocationPermit = {
      assertActive: vi.fn(async () => {}),
      markStarted: vi.fn(async () => {}),
      releaseReserved: vi.fn(async () => {}),
      settle: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
    };
    const begin = vi.fn(async () => ({ disposition: "fresh", permit }));
    const prepared = compositionOptions(adapters, {
      runtimeFactory: { create: async () => runtime as unknown as PiModelRuntime },
      fetch: vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ id: "generation:title", model: primaryModel.model, usage: { cost: 0.000001 }, choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "generation:title", routing: { finalProvider: "deepinfra" }, cost: 0.000001 } } } }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    const composition = createProductionModelComposition({
      ...prepared.options,
      descriptors: prepared.options.descriptors.map((descriptor) => ({
        ...descriptor,
        ...(descriptor.api === "openai-completions"
          ? { reasoning: reasoningRequired || descriptor.reasoning, reasoningRequired }
          : {}),
      })),
    });
    try {
      const request = {
        ownerId: prepared.options.ownerId,
        agentId: prepared.options.agentId,
        runId: "run:title",
        threadId: "thread:title",
        modelRef: primaryModel.ref,
        dataClassification: "private",
        systemInstructionRef: "disclosure:title",
        correlationId: "title:test",
      };
      const gate = {
        context: { ownerId: request.ownerId, agentId: request.agentId, runId: request.runId },
        begin,
      };
      expect(
        await composition.generateTitle?.(
          request as never,
          "Generate a short title",
          gate as never,
        ),
      ).toBe("日本今日头条");
      expect(begin).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "model-port",
          modelRef: primaryModel.ref,
          logicalSlot: "thread-title:run:title",
        }),
      );
      expect(permit.markStarted).toHaveBeenCalledTimes(1);
      expect(permit.settle).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 30, outputTokens: 10, reportedCostMicros: 1 }),
      );
      expect(permit.markUnknown).not.toHaveBeenCalled();
      expect(streamOptions[0]).toMatchObject({
        maxTokens: reasoningRequired ? 1024 : 128,
        maxRetries: 0,
        timeoutMs: 20000,
      });
    } finally {
      await composition.close();
    }
  },
);

function embeddingAccountingFixture(mode: "query" | "projection", response: unknown) {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: Mem0EmbeddingBoundary | undefined;
  const controller = new AbortController();
  const time = { now: "2026-10-06T00:00:00.000Z" };
  const permit = {
    assertActive: vi.fn(async () => undefined),
    markStarted: vi.fn(async () => undefined),
    releaseReserved: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    markUnknown: vi.fn(async () => undefined),
  };
  const budget = {
    reserve: vi.fn(async () => ({ allocation: { status: "reserved" }, replayed: false })),
    markStarted: vi.fn(async () => undefined),
    releaseReserved: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    markUnknown: vi.fn(async () => undefined),
  };
  const send = vi.fn(async () => response as Mem0EmbeddingResponse);
  const request: MemorySearchRequest = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId: "embedding-accounting-run" as never,
    executionLease: {} as never,
    queryRef: "embedding-query" as never,
    queryTerms: [],
    dataClassification: "private",
    limit: 3,
    signal: controller.signal,
    deadlineAt: "2026-10-06T00:00:30.000Z",
  };
  const invoke = () => {
    if (!boundary) throw new Error("BOUNDARY_MISSING");
    return boundary(
      { model: "alibaba/qwen3-embedding-8b", input: "memory", dimensions: 4096 },
      send,
    );
  };
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
        await invoke();
        return [];
      },
    },
    admission: async () => ({ begin: async () => ({ disposition: "fresh", permit }) }) as never,
    budget: budget as never,
    assertActive: async () => undefined,
    now: () => time.now,
  });
  const run =
    mode === "query"
      ? () => memory.search(request)
      : () =>
          memory.project(
            {
              id: "projection-accounting",
              claimedBy: "consumer",
              attemptCount: 1,
              claimExpiresAt: request.deadlineAt,
            } as never,
            { dataClassification: "private" } as never,
            async () => {
              await invoke();
              return "provider-memory";
            },
          );
  return {
    run,
    send,
    controller,
    permit,
    budget,
    time,
    ledger: mode === "query" ? permit : budget,
  };
}

function gatewayEmbeddingResponse(cost: unknown = "0.000077") {
  return {
    model: "alibaba/qwen3-embedding-8b",
    data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => 0.1) }],
    usage: { prompt_tokens: 8, total_tokens: 8 },
    providerMetadata: {
      gateway: {
        generationId: "embedding-generation",
        routing: { finalProvider: "deepinfra" },
        cost,
      },
    },
  };
}

for (const mode of ["query", "projection"] as const) {
  it.each([
    [0, 0],
    ["0.00000019", 1],
    ["0.000077", 77],
  ])("[R2-L5] settles embedding %s as %s actual micros for " + mode, async (cost, micros) => {
    const fixture = embeddingAccountingFixture(mode, gatewayEmbeddingResponse(cost));
    await fixture.run();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.markStarted).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.markUnknown).not.toHaveBeenCalled();
    if (mode === "query") {
      expect(fixture.permit.settle).toHaveBeenCalledWith({
        inputTokens: 8,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostMicros: micros,
      });
    } else {
      expect(fixture.budget.settle).toHaveBeenCalledWith(
        expect.objectContaining({ actualCostMicros: micros }),
      );
    }
  });

  it.each([
    { name: "missing gateway", change: { providerMetadata: undefined } },
    {
      name: "missing cost",
      change: {
        providerMetadata: {
          gateway: { generationId: "generation", routing: { finalProvider: "deepinfra" } },
        },
      },
    },
    {
      name: "negative cost",
      change: {
        providerMetadata: {
          gateway: {
            generationId: "generation",
            routing: { finalProvider: "deepinfra" },
            cost: "-0.1",
          },
        },
      },
    },
    {
      name: "unsafe cost",
      change: {
        providerMetadata: {
          gateway: {
            generationId: "generation",
            routing: { finalProvider: "deepinfra" },
            cost: "9007199254.7409910001",
          },
        },
      },
    },
    {
      name: "boolean cost",
      change: {
        providerMetadata: {
          gateway: {
            generationId: "generation",
            routing: { finalProvider: "deepinfra" },
            cost: false,
          },
        },
      },
    },
    {
      name: "missing generation",
      change: {
        providerMetadata: { gateway: { routing: { finalProvider: "deepinfra" }, cost: "0.1" } },
      },
    },
    {
      name: "missing provider",
      change: { providerMetadata: { gateway: { generationId: "generation", cost: "0.1" } } },
    },
    { name: "model drift", change: { model: "another-embedding" } },
    { name: "conflicting token totals", change: { usage: { prompt_tokens: 8, total_tokens: 7 } } },
    { name: "missing total", change: { usage: { prompt_tokens: 8 } } },
    { name: "invalid total", change: { usage: { prompt_tokens: 8, total_tokens: Number.NaN } } },
    {
      name: "conflicting optional fee",
      change: { usage: { prompt_tokens: 8, total_tokens: 8, cost: "0.0000771" } },
    },
    {
      name: "invalid optional fee",
      change: { usage: { prompt_tokens: 8, total_tokens: 8, cost: null } },
    },
    { name: "missing vector", change: { data: [] } },
    { name: "wrong dimensions", change: { data: [{ index: 0, embedding: [0.1] }] } },
    {
      name: "nonfinite vector",
      change: { data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => Number.NaN) }] },
    },
  ])("[R2-L5] retains unknown embedding $name for " + mode, async ({ change }) => {
    const fixture = embeddingAccountingFixture(mode, { ...gatewayEmbeddingResponse(), ...change });
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.markUnknown).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.settle).not.toHaveBeenCalled();
    expect(fixture.ledger.releaseReserved).not.toHaveBeenCalled();
  });
}

it("[R2-L5] retains unknown embedding when cancellation occurs before final settlement", async () => {
  const fixture = embeddingAccountingFixture("query", gatewayEmbeddingResponse());
  fixture.send.mockImplementation(async () => {
    fixture.controller.abort(new Error("RUN_CANCELLED"));
    return gatewayEmbeddingResponse();
  });
  await expect(fixture.run()).rejects.toThrow("RUN_CANCELLED");
  expect(fixture.permit.markUnknown).toHaveBeenCalledTimes(1);
  expect(fixture.permit.settle).not.toHaveBeenCalled();
});

it.each(["cancel", "deadline"] as const)(
  "[R2-L5] retains unknown embedding when %s occurs during the final authority check",
  async (ending) => {
    const fixture = embeddingAccountingFixture("query", gatewayEmbeddingResponse());
    fixture.permit.assertActive
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        if (ending === "cancel") fixture.controller.abort(new Error("RUN_CANCELLED_DURING_CHECK"));
        else fixture.time.now = "2026-10-06T00:00:30.000Z";
      });
    await expect(fixture.run()).rejects.toThrow(
      ending === "cancel" ? "RUN_CANCELLED_DURING_CHECK" : "EMBEDDING_DEADLINE_EXCEEDED",
    );
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
    expect(fixture.permit.settle).not.toHaveBeenCalled();
    expect(fixture.permit.releaseReserved).not.toHaveBeenCalled();
  },
);
