// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MemorySearchRequest,
  ModelInvocationPermit,
  RunExecutionSource,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  ModelInvocationAdmissionService,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import type { EmbeddingBoundary, EmbeddingResponse } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import type {
  ConfiguredPiModelDescriptor,
  PiModelRuntime,
  PiModelRuntimeFactory,
} from "@himawari-agent/runtime-pi";
import {
  createReferenceAdapterSet,
  inMemoryMemoryIndex,
  type ReferenceAdapterSet,
  testModelEgress,
} from "@himawari-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../src/production-memory-composition.js";
import {
  createProductionModelComposition,
  resolveConfiguredModelDescriptorSet,
} from "../src/production-model-composition.js";
import {
  createProductionModelEgress,
  productionEgressThreadOf,
  productionSensitiveInterceptionRecorder,
} from "../src/production-model-egress.js";
import {
  createProductionRunMemory,
  embeddingAdmissionDescriptor,
} from "../src/production-run-memory.js";
import {
  configuredWorkspaceRoot,
  createProductionRunPolicy,
  DOCUMENT_SKILL_DIRECTORY,
  HIMAWARI_IDENTITY,
  runCapabilityNotice,
  runtimeEnvironmentNotice,
} from "../src/production-run-policy.js";

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
  readonly refreshes: { readonly allowNetwork?: boolean }[] = [];

  getModel(providerId: string, modelId: string): unknown | undefined {
    return this.models.get(`${providerId}:${modelId}`);
  }

  registerNativeProvider(provider: { readonly id: string; getModels(): readonly unknown[] }): void {
    const providerId = provider.id;
    for (const model of provider.getModels()) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw new Error("model invalid");
      }
      const id = (model as Record<string, unknown>)["id"];
      if (typeof id !== "string") throw new Error("model id missing");
      this.models.set(`${providerId}:${id}`, model);
    }
  }

  async refresh(options: { readonly allowNetwork?: boolean }): Promise<void> {
    this.refreshes.push(options);
  }
}

function compositionOptions(
  adapters: ReferenceAdapterSet,
  overrides: Partial<Parameters<typeof createProductionModelComposition>[0]> = {},
) {
  const resolve = vi.fn(async () => "fixture-provider-value");
  const options = {
    egress: testModelEgress(),
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
        adapter: "himawari-sqlite",
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

    expect(runtime.refreshes).toEqual([{ allowNetwork: false }]);
    await composition.close();
    expect(runtime.refreshes).toEqual([{ allowNetwork: false }]);
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
          adapter: "himawari-sqlite",
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

  it("maps a Magpie primary to a loopback Pi route without gateway routing", () => {
    const { providerRouting: _routing, ...primary } = primaryModel;
    const configuration = {
      modelDescriptors: [
        {
          ...primary,
          role: "primary" as const,
          provider: "magpie",
          model: "group/himawari-main",
          baseUrl: "http://127.0.0.1:3425/v1",
          secretRef: "magpie-gateway-key",
        },
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
      secretReferences: [
        {
          ref: "magpie-gateway-key",
          version: "v1",
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
    } as never;

    const resolved = resolveConfiguredModelDescriptorSet(configuration);

    expect(resolved.generation[0]).toMatchObject({
      provider: "magpie",
      model: "group/himawari-main",
      baseUrl: "http://127.0.0.1:3425/v1",
    });
    expect(resolved.generation[0]).not.toHaveProperty("providerRouting");
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

  it("[R2-L5] composes the selected 4096-dimensional Qwen embedding through the memory engine", async () => {
    const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
    const resolvedSecrets: string[] = [];
    const composition = await createProductionMemoryCompositionFromConfiguration({
      onVectorFailure: () => {},
      egress: testModelEgress(),
      configuration,
      secretSource: {
        kind: "macos-keychain",
        productionSuitable: true,
        resolve: async (secretRef, secretVersion) => {
          resolvedSecrets.push(`${secretRef}@${secretVersion}`);
          return "fixture-provider-value";
        },
      },
      index: inMemoryMemoryIndex(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "alibaba/qwen3-embedding-8b",
            data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => 0.5) }],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        ),
    });
    composition.bindEmbeddingBoundary((_request, send) => send(), 1000);
    await composition.projection.search({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      query: "蓝色",
      limit: 3,
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

  it("[I-23] brings no Memory when the closest one is below the relevance threshold", async () => {
    const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
    const basis = (weights: Readonly<Record<number, number>>) =>
      Array.from({ length: 4096 }, (_value, index) => weights[index] ?? 0);
    const vectors: Readonly<Record<string, readonly number[]>> = {
      主人有一个前同事叫陪坤: basis({ 0: 1 }),
      写到一个pdf文件: basis({ 0: 0.55, 2: Math.sqrt(1 - 0.55 ** 2) }),
      陪坤是谁: basis({ 0: 0.9, 2: Math.sqrt(1 - 0.9 ** 2) }),
    };
    const memoryIndex = inMemoryMemoryIndex();
    const composition = await createProductionMemoryCompositionFromConfiguration({
      onVectorFailure: () => {},
      egress: testModelEgress(),
      configuration,
      secretSource: {
        kind: "macos-keychain",
        productionSuitable: true,
        resolve: async () => "fixture-provider-value",
      },
      index: memoryIndex,
      fetch: async (_url, init) => {
        const input = String(JSON.parse(String(init?.body))["input"]);
        const key = Object.keys(vectors).find((text) => input.endsWith(text));
        return new Response(
          JSON.stringify({
            model: "alibaba/qwen3-embedding-8b",
            data: [{ index: 0, embedding: key ? vectors[key] : basis({ 3: 1 }) }],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        );
      },
    });
    composition.bindEmbeddingBoundary((_request, send) => send(), 1000);
    const memoryId = "memory-former-colleague" as never;
    await composition.projection.upsert({
      memory: {
        id: memoryId,
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        revision: 1,
        status: "active",
        contentRef: "memory-content:colleague",
        dataClassification: "private",
        sourceThreadId: null,
        sourceRefs: ["source-colleague"],
        inference: false,
        confidencePermille: 1000,
        policyVersion: "memory-capture:v2",
        providerRecordId: null,
        lastUsedAt: null,
        updatedAt: "2026-10-29T00:00:00.000Z",
      } as never,
      content: "主人有一个前同事叫陪坤",
    });
    const search = (query: string) =>
      composition.projection.search({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        query,
        limit: 3,
      });

    expect(await search("写到一个pdf文件")).toEqual([]);
    expect((await search("陪坤是谁")).map(({ productMemoryId }) => productMemoryId)).toEqual([
      memoryId,
    ]);
    expect(composition.projection.minimumSimilarity).toBe(0.6);
    await composition.close();
  });

  it("[I-23] refuses to start memory search for an embedding model without a calibrated relevance threshold", async () => {
    const base = selectedEmbeddingConfiguration(temporaryDirectory);
    const configuration = {
      ...base,
      modelDescriptors: base.modelDescriptors.map((descriptor) =>
        descriptor.role === "embedding"
          ? { ...descriptor, model: "fixture/unthresholded-embedding" }
          : descriptor,
      ),
    };
    const options = {
      secretSource: {
        kind: "macos-keychain" as const,
        productionSuitable: true,
        resolve: async () => "fixture-provider-value",
      },
      index: inMemoryMemoryIndex(),
    };
    await expect(
      createProductionMemoryCompositionFromConfiguration({
        onVectorFailure: () => {},
        egress: testModelEgress(),
        ...options,
        configuration,
      }),
    ).rejects.toThrow("EMBEDDING_PROFILE_UNKNOWN");
    const configured = await createProductionMemoryCompositionFromConfiguration({
      onVectorFailure: () => {},
      egress: testModelEgress(),
      ...options,
      configuration: {
        ...base,
        memory: { ...base.memory, minimumSimilarity: 0.7 },
      },
    });
    expect(configured.projection.minimumSimilarity).toBe(0.7);
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
  const instructionText = new TextDecoder().decode(protect.mock.calls[0]?.[0].plaintext);
  expect(instructionText.startsWith(`${HIMAWARI_IDENTITY}\n\n可信系统指令\n\n`)).toBe(true);
  expect(instructionText).toContain("你是 Himawari");
  expect(instructionText).not.toContain("coding assistant");
  expect(instructionText).not.toContain("本轮请求时间");
  expect(instructionText).not.toContain("2026-09-1");
  expect(instructionText).toContain("联网搜索没开时");
  expect(instructionText).toContain("运行环境说明");
  expect(instructionText).not.toContain("联网搜索：本轮没有");
  const environmentText = new TextDecoder().decode(protect.mock.calls[1]?.[0].plaintext);
  expect(environmentText).toContain("联网搜索：本轮没有。");
  expect(environmentText).toContain("本轮没有文件和命令工具。");
  expect(first.runtimeEnvironmentRef).toEqual(expect.any(String));
  expect(new TextDecoder().decode(protect.mock.calls[0]?.[0].plaintext)).toContain(
    "主人本轮明确指定的语言；主人的要求里定下的语言；主人本轮提问用的语言；都没有时用简体中文。主人只是换了一种语言提问，不算明确指定。调用工具之前或之间写给主人看的说明也用这种语言",
  );
  expect(instructionText).not.toContain("沙箱没有外网");
  expect(list).toHaveBeenCalledWith(source.runId, adapters.clock.now());
  expect((await policy(source)).systemInstructionRef).toBe(first.systemInstructionRef);
  const threadSource = {
    ...source,
    threadId: "language-thread" as NonNullable<RunExecutionSource["threadId"]>,
  };
  const threadPolicy = await policy(threadSource);
  expect(threadPolicy.answerLocalePolicy).toBeUndefined();
  expect(threadPolicy.systemInstructionRef).toBe(first.systemInstructionRef);
  expect(threadPolicy.runtimeEnvironmentRef).toBe(first.runtimeEnvironmentRef);
  expect(protect).toHaveBeenCalledTimes(2);
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

describe("Run capability notice", () => {
  it("keeps only rules in the system prompt and moves every changing value to the runtime environment", () => {
    const notice = runCapabilityNotice({ coding: true });
    expect(notice).toContain("沙箱没有外网");
    expect(notice).toContain("目录之外的路径会被拒绝");
    expect(notice).toContain("命令可以在工作目录里新建、修改和删除文件");
    expect(notice).toContain("临时文件放到 $TMPDIR");
    expect(notice).toContain("不要让主人去配置网络或代理");
    expect(notice).toContain("见最近附上的运行环境说明");
    expect(notice).toContain("和本规则一样约束本轮的工具使用");
    expect(notice).not.toContain("/var/lib/himawari/workspace");
    expect(notice).not.toContain(DOCUMENT_SKILL_DIRECTORY);
    const environment = runtimeEnvironmentNotice({
      coding: true,
      workspaceRoot: "/var/lib/himawari/workspace",
    });
    expect(environment).toContain("工作目录：/var/lib/himawari/workspace。");
    expect(environment).toContain("联网搜索：本轮没有。");
    expect(environment).toContain("抓取网页：本轮没有。");
  });

  it("states in the runtime environment that the workspace is gone after the grant expires", () => {
    const environment = runtimeEnvironmentNotice({ coding: true, workspaceRoot: null });
    expect(environment).toContain("工作目录：本轮没有。");
    expect(environment).not.toContain("/var/lib/himawari/workspace");
    expect(runCapabilityNotice({ coding: true })).toBe(runCapabilityNotice({ coding: true }));
  });

  it("names search and fetch providers and the fetch limit only in the runtime environment", () => {
    const environment = runtimeEnvironmentNotice({
      coding: false,
      workspaceRoot: null,
      publicSearch: { providers: ["exa-public", "deepseek"] },
      publicFetch: { providers: ["exa-public"], maximumBytes: 512 * 1024 },
    });
    expect(environment).toContain("本轮没有文件和命令工具。");
    expect(environment).toMatch(/联网搜索：已开启，查询发送给 .+（失败时依次改用 .+）。/u);
    expect(environment).toContain("一次最多返回约 512 KiB。");
    expect(environment.split("\n").at(-1)).not.toMatch(/\d/u);
  });

  it("points the model to the document skill only when it has the coding sandbox", () => {
    const withSandbox = runCapabilityNotice({ coding: true });
    expect(withSandbox).toContain("文档技能目录下的 SKILL.md");
    expect(withSandbox).toContain("不要探测或安装");
    expect(
      runtimeEnvironmentNotice({
        coding: true,
        workspaceRoot: null,
        documentSkillDirectory: DOCUMENT_SKILL_DIRECTORY,
      }),
    ).toContain(`文档技能目录：${DOCUMENT_SKILL_DIRECTORY}`);
    expect(runCapabilityNotice({ coding: false })).not.toContain("SKILL.md");
    expect(
      runtimeEnvironmentNotice({
        coding: false,
        workspaceRoot: null,
        documentSkillDirectory: DOCUMENT_SKILL_DIRECTORY,
      }),
    ).not.toContain("SKILL.md");
  });

  it("ships every file the document skill names next to it", async () => {
    const skill = await readFile(path.join(DOCUMENT_SKILL_DIRECTORY, "SKILL.md"), "utf8");
    for (const name of ["make_pdf.py", "a4.css", "reference.docx"]) {
      expect(skill).toContain(name);
      expect(existsSync(path.join(DOCUMENT_SKILL_DIRECTORY, name))).toBe(true);
    }
  });

  it("keeps the web_search rule in the system prompt whether or not search is configured", () => {
    const notice = runCapabilityNotice({ coding: false });
    expect(notice).toContain("web_search");
    expect(notice).toContain("核对来源日期");
    expect(notice).not.toContain("沙箱没有外网");
    expect(notice).not.toContain("工作目录：");
  });

  it("names the workspace only from a current coding grant", async () => {
    const now = "2026-10-24T00:00:00.000Z";
    const grant = {
      id: "directory:workspace",
      hostId: "host",
      displayPath: "/var/lib/himawari/workspace",
      revokedAt: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const configuration = {
      ownerId: "owner",
      agentId: "agent",
      runPolicy: { coding: { grantId: grant.id, hostId: grant.hostId } },
    } as unknown as Parameters<typeof configuredWorkspaceRoot>[0];
    const read = (value: unknown) => ({
      readScopedState: vi.fn(async () => (value ? { value } : undefined)) as never,
    });
    const clock = { now: () => now };
    expect(await configuredWorkspaceRoot(configuration, read(grant), clock)()).toBe(
      grant.displayPath,
    );
    expect(
      await configuredWorkspaceRoot(configuration, read({ ...grant, revokedAt: now }), clock)(),
    ).toBeNull();
    expect(
      await configuredWorkspaceRoot(configuration, read({ ...grant, hostId: "other" }), clock)(),
    ).toBeNull();
    expect(await configuredWorkspaceRoot(configuration, read(undefined), clock)()).toBeNull();
  });
});

it("propagates Run cancellation and remaining deadline to embedding and retains uncertain spend", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: EmbeddingBoundary | undefined;
  const controller = new AbortController();
  let searchCancelled: ((error: unknown) => boolean) | undefined;
  const providerDown = new Error("PROVIDER_DOWN");
  const cancelledBefore: (boolean | null)[] = [];
  const cancelledAfter: (boolean | null)[] = [];
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
      bindEmbeddingBoundary: (value, _timeoutMs, cancelled) => {
        boundary = value;
        searchCancelled = cancelled;
      },
    },
    payloads: { get: async () => ({ dataClassification: "private" }) as never },
    memory: {
      search: async () => {
        if (!boundary) throw new Error("BOUNDARY_MISSING");
        cancelledBefore.push(searchCancelled?.(providerDown) ?? null);
        try {
          await boundary(
            {
              identity: "fixture",
              model: "alibaba/qwen3-embedding-8b",
              input: "query",
              dimensions: 4096,
            },
            send,
          );
        } finally {
          cancelledAfter.push(searchCancelled?.(providerDown) ?? null);
        }
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
  expect(cancelledBefore).toEqual([false, false]);
  expect(cancelledAfter).toEqual([true, false]);
  expect(searchCancelled?.(providerDown)).toBe(false);
});

it("[P3-2] a memory tool search whose Run lost its execution lease while embedding leaves no retrieval-degrade record", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: EmbeddingBoundary | undefined;
  let searchCancelled: ((error: unknown) => boolean) | undefined;
  const now = "2026-09-06T00:00:00.000Z";
  let leaseHeld = true;
  const leaseError = () =>
    new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "Run execution lease is no longer active",
    );
  const permit: ModelInvocationPermit = {
    assertActive: vi.fn(async () => {
      if (!leaseHeld)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Run execution lease is no longer active",
        );
    }),
    markStarted: vi.fn(async () => {}),
    releaseReserved: vi.fn(async () => {
      if (!leaseHeld) throw leaseError();
    }),
    settle: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
  };
  const memory = createProductionRunMemory({
    configuration,
    projection: {
      bindEmbeddingBoundary: (value, _timeoutMs, cancelled) => {
        boundary = value;
        searchCancelled = cancelled;
      },
    },
    payloads: { get: async () => undefined },
    memory: { search: async () => [] },
    admission: async () => ({ begin: async () => ({ disposition: "fresh", permit }) }) as never,
    budget: {} as never,
    assertActive: async () => {},
    now: () => now,
    diagnostic: () => {
      throw new Error("LOG_SINK_DOWN");
    },
  });
  const recorded: boolean[] = [];
  const toolSearch = (send: () => Promise<never>) =>
    memory.embedWithin(
      {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        runId: "run-tool-embedding" as never,
        executionLease: {} as never,
        deadlineAt: "2026-09-06T00:00:05.000Z",
        dataClassification: "private",
        slot: "memory-recall:call-1",
      },
      async () => {
        if (!boundary || !searchCancelled) throw new Error("BOUNDARY_MISSING");
        try {
          await boundary(
            {
              identity: "fixture",
              model: "alibaba/qwen3-embedding-8b",
              input: "query",
              dimensions: 4096,
            },
            send,
          );
        } catch (error) {
          recorded.push(!searchCancelled(error));
        }
      },
    );
  leaseHeld = false;
  await toolSearch(async () => {
    throw new Error("SEND_AFTER_LEASE_LOST");
  });
  leaseHeld = true;
  await toolSearch(async () => {
    throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, "EMBEDDING_HTTP_FAILURE");
  });
  await toolSearch(async () => {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "EMBEDDING_BOUNDARY_REQUIRED",
    );
  });
  const mailController = new AbortController();
  await memory.embedForExternalRead(
    { deadlineAt: "2026-09-06T00:00:05.000Z", signal: mailController.signal, costMicros: 0 },
    async () => {
      if (!searchCancelled) throw new Error("BOUNDARY_MISSING");
      const failure = new Error("TRANSPORT_CLOSED");
      recorded.push(!searchCancelled(failure));
      mailController.abort(new Error("CLIENT_GONE"));
      recorded.push(!searchCancelled(failure));
    },
  );
  expect(recorded).toEqual([false, true, true, true, false]);
});

it("drops the automatic memory lookup for the turn when its embedding takes over three seconds", async () => {
  const selected = selectedEmbeddingConfiguration(temporaryDirectory);
  const configuration = {
    ...selected,
    deadlines: { ...selected.deadlines, providerRequestMs: 30_000 },
  };
  let boundary: EmbeddingBoundary | undefined;
  const permits: ModelInvocationPermit[] = [];
  const begin = vi.fn(
    async (_input: { readonly ordinal: number; readonly logicalSlot: string }) => {
      const permit: ModelInvocationPermit = {
        assertActive: vi.fn(async () => {}),
        markStarted: vi.fn(async () => {}),
        releaseReserved: vi.fn(async () => {}),
        settle: vi.fn(async () => {}),
        markUnknown: vi.fn(async () => {}),
      };
      permits.push(permit);
      return { disposition: "fresh", permit };
    },
  );
  const diagnostics: Readonly<Record<string, string>>[] = [];
  const send = vi.fn(
    (options?: { timeoutMs?: number; signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      }),
  );
  const vectorFailures: unknown[] = [];
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
        try {
          await boundary(
            {
              identity: "fixture",
              model: "alibaba/qwen3-embedding-8b",
              input: "query",
              dimensions: 4096,
            },
            send,
          );
        } catch (error) {
          vectorFailures.push(error);
        }
        return [{ memory: { id: "keyword-only-hit" }, score: 0.5 }] as never;
      },
    },
    admission: async () => ({ begin }) as never,
    budget: {} as never,
    assertActive: async () => {},
    now: () => "2026-09-06T00:00:00.000Z",
    diagnostic: (event) => diagnostics.push(event),
  });
  const started = performance.now();
  await expect(
    memory.search({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      runId: "run-embedding-skip" as never,
      executionLease: {} as never,
      dataClassification: "private",
      queryRef: "query" as never,
      queryTerms: [],
      limit: 3,
      deadlineAt: "2026-09-06T00:01:00.000Z",
    }),
  ).resolves.toEqual([]);
  const waited = performance.now() - started;
  expect(waited).toBeGreaterThanOrEqual(2900);
  expect(waited).toBeLessThan(4500);
  expect(send).toHaveBeenCalledTimes(1);
  expect(vectorFailures).toHaveLength(1);
  expect(begin.mock.calls.map(([input]) => input.logicalSlot)).toEqual([
    "context-memory-search:v1",
  ]);
  expect(permits[0]?.markUnknown).not.toHaveBeenCalled();
  expect(permits[0]?.settle).toHaveBeenCalledWith(
    expect.objectContaining({ reportedCostMicros: 164, outputTokens: 0 }),
  );
  expect(diagnostics).toEqual([
    { component: "agent-service", event: "memory.embedding_skipped", afterMs: "3000" },
  ]);
});

it("gives a slow recall-tool embedding three seconds, then asks once more under a new invocation", async () => {
  const selected = selectedEmbeddingConfiguration(temporaryDirectory);
  const configuration = {
    ...selected,
    deadlines: { ...selected.deadlines, providerRequestMs: 30_000 },
  };
  let boundary: EmbeddingBoundary | undefined;
  const now = "2026-09-06T00:00:00.000Z";
  const permits: ModelInvocationPermit[] = [];
  const begin = vi.fn(
    async (_input: { readonly ordinal: number; readonly logicalSlot: string }) => {
      const permit: ModelInvocationPermit = {
        assertActive: vi.fn(async () => {}),
        markStarted: vi.fn(async () => {}),
        releaseReserved: vi.fn(async () => {}),
        settle: vi.fn(async () => {}),
        markUnknown: vi.fn(async () => {}),
      };
      permits.push(permit);
      return { disposition: "fresh", permit };
    },
  );
  const diagnostics: Readonly<Record<string, string>>[] = [];
  const send = vi
    .fn()
    .mockImplementationOnce(
      (options?: { timeoutMs?: number; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(options?.timeoutMs).toBe(3000);
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        }),
    )
    .mockImplementationOnce(async (options?: { timeoutMs?: number }) => {
      expect(options?.timeoutMs).toBe(30_000);
      return {
        data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => 0.1) }],
        model: "alibaba/qwen3-embedding-8b",
        providerMetadata: {
          gateway: {
            cost: "0.00000019",
            generationId: "retry-generation",
            routing: { finalProvider: "deepinfra" },
          },
        },
        usage: { prompt_tokens: 8, total_tokens: 8 },
      };
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
          {
            identity: "fixture",
            model: "alibaba/qwen3-embedding-8b",
            input: "query",
            dimensions: 4096,
          },
          send,
        );
        return [];
      },
    },
    admission: async () => ({ begin }) as never,
    budget: {} as never,
    assertActive: async () => {},
    now: () => now,
    diagnostic: (event) => diagnostics.push(event),
  });
  const started = performance.now();
  await expect(
    memory.embedWithin(
      {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        runId: "run-embedding-retry" as never,
        executionLease: {} as never,
        deadlineAt: "2026-09-06T00:01:00.000Z",
        dataClassification: "private",
        slot: "memory-recall:call-1",
      },
      async () => {
        if (!boundary) throw new Error("BOUNDARY_MISSING");
        await boundary(
          {
            identity: "fixture",
            model: "alibaba/qwen3-embedding-8b",
            input: "query",
            dimensions: 4096,
          },
          send,
        );
        return [];
      },
    ),
  ).resolves.toEqual([]);
  expect(performance.now() - started).toBeGreaterThanOrEqual(2900);
  expect(send).toHaveBeenCalledTimes(2);
  expect(begin.mock.calls.map(([input]) => input.ordinal)).toEqual([1, 2]);
  expect(begin.mock.calls.map(([input]) => input.logicalSlot)).toEqual([
    "memory-recall:call-1",
    "memory-recall:call-1:attempt:2",
  ]);
  expect(permits[0]?.markUnknown).not.toHaveBeenCalled();
  expect(permits[0]?.settle).toHaveBeenCalledWith(
    expect.objectContaining({ reportedCostMicros: 164, outputTokens: 0 }),
  );
  expect(permits[1]?.settle).toHaveBeenCalledTimes(1);
  expect(diagnostics).toEqual([
    { component: "agent-service", event: "memory.embedding_retried", afterMs: "3000" },
  ]);
});

it("retries only unstarted projection reservations and never repeats an uncertain provider request", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: EmbeddingBoundary | undefined;
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
          {
            identity: "fixture",
            model: "alibaba/qwen3-embedding-8b",
            input: "memory",
            dimensions: 4096,
          },
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
        registry: [embeddingAdmissionDescriptor(configuration)],
      }),
  ).not.toThrow();
});

it.each([
  { reasoning: false, reasoningRequired: false, maxTokens: 128 },
  { reasoning: true, reasoningRequired: false, maxTokens: 1024 },
  { reasoning: true, reasoningRequired: true, maxTokens: 1024 },
])(
  "generates a title through the selected Pi transport with room for thinking when the model can think (%o)",
  async ({ reasoning, reasoningRequired, maxTokens }) => {
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
              stopReason: reasoning && Number(options["maxTokens"]) < 512 ? "length" : "stop",
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
        ...(descriptor.api === "openai-completions" ? { reasoning, reasoningRequired } : {}),
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
        maxTokens,
        maxRetries: 0,
        timeoutMs: 20000,
      });
    } finally {
      await composition.close();
    }
  },
);

it.each([
  { provider: "magpie", thinkingOff: true, maxTokens: 128 },
  { provider: "vercel-ai-gateway", thinkingOff: false, maxTokens: 1024 },
])(
  "turns thinking off for a title only on Magpie and keeps room for thinking elsewhere (%o)",
  async ({ provider, thinkingOff, maxTokens }) => {
    const adapters = createReferenceAdapterSet();
    const payloads: unknown[] = [];
    const streamOptions: Record<string, unknown>[] = [];
    class TitleRuntime extends RecordingRuntime {
      override getModel(providerId: string, modelId: string): unknown {
        const value = super.getModel(providerId, modelId);
        return value ? { ...(value as Record<string, unknown>), provider: providerId } : undefined;
      }
      stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
        streamOptions.push(options);
        const onPayload = options["onPayload"] as ((payload: unknown) => unknown) | undefined;
        payloads.push(onPayload?.({ model: "m" }));
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
              provider,
              model: primaryModel.model,
              stopReason: "stop",
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
    const permit: ModelInvocationPermit = {
      assertActive: vi.fn(async () => {}),
      markStarted: vi.fn(async () => {}),
      releaseReserved: vi.fn(async () => {}),
      settle: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
    };
    const begin = vi.fn(async () => ({ disposition: "fresh", permit }));
    const prepared = compositionOptions(adapters, {
      runtimeFactory: { create: async () => new TitleRuntime() as unknown as PiModelRuntime },
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
      descriptors: prepared.options.descriptors.map((descriptor) => {
        if (descriptor.api !== "openai-completions") return descriptor;
        const { providerRouting: _routing, ...withoutRouting } = descriptor;
        return provider === "magpie"
          ? {
              ...withoutRouting,
              reasoning: true,
              reasoningRequired: false,
              provider,
              baseUrl: "http://127.0.0.1:3425/v1",
            }
          : { ...descriptor, reasoning: true, reasoningRequired: false };
      }),
    });
    try {
      const request = {
        ownerId: prepared.options.ownerId,
        agentId: prepared.options.agentId,
        runId: "run:title-thinking",
        threadId: "thread:title-thinking",
        modelRef: primaryModel.ref,
        dataClassification: "private",
        systemInstructionRef: "disclosure:title",
        correlationId: "title:thinking",
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
      expect(streamOptions[0]).toMatchObject({ maxTokens });
      const rewritten = payloads[0] as Record<string, unknown> | undefined;
      if (thinkingOff) {
        expect(rewritten).toMatchObject({ thinking: { type: "disabled" } });
      } else {
        expect(rewritten?.["thinking"]).toBeUndefined();
      }
    } finally {
      await composition.close();
    }
  },
);

it("retries an auxiliary text call once when the model answers with a tool call instead of text", async () => {
  const adapters = createReferenceAdapterSet();
  let calls = 0;
  class FlakyRuntime extends RecordingRuntime {
    override getModel(providerId: string, modelId: string): unknown {
      const value = super.getModel(providerId, modelId);
      return value ? { ...(value as Record<string, unknown>), provider: providerId } : undefined;
    }
    stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
      calls += 1;
      const first = calls === 1;
      return (async function* () {
        await (options["fetch"] as typeof fetch)(
          "https://ai-gateway.vercel.sh/v1/chat/completions",
        );
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: first
              ? [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }]
              : [{ type: "text", text: "日本今日头条" }],
            api: "openai-completions",
            provider: "vercel-ai-gateway",
            model: primaryModel.model,
            stopReason: first ? "toolUse" : "stop",
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
  const permit: ModelInvocationPermit = {
    assertActive: vi.fn(async () => {}),
    markStarted: vi.fn(async () => {}),
    releaseReserved: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
  };
  const begin = vi.fn(async () => ({ disposition: "fresh", permit }));
  const prepared = compositionOptions(adapters, {
    runtimeFactory: { create: async () => new FlakyRuntime() as unknown as PiModelRuntime },
    fetch: vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ id: "generation:title", model: primaryModel.model, usage: { cost: 0.000001 }, choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "generation:title", routing: { finalProvider: "deepinfra" }, cost: 0.000001 } } } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  });
  const composition = createProductionModelComposition(prepared.options);
  try {
    const request = {
      ownerId: prepared.options.ownerId,
      agentId: prepared.options.agentId,
      runId: "run:title-retry",
      threadId: "thread:title-retry",
      modelRef: primaryModel.ref,
      dataClassification: "private",
      systemInstructionRef: "disclosure:title",
      correlationId: "title:retry",
    };
    const gate = {
      context: { ownerId: request.ownerId, agentId: request.agentId, runId: request.runId },
      begin,
    };
    expect(
      await composition.generateTitle?.(request as never, "Generate a short title", gate as never),
    ).toBe("日本今日头条");
    expect(calls).toBe(2);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ logicalSlot: "thread-title:run:title-retry:retry" }),
    );
  } finally {
    await composition.close();
  }
});

it("[PG-12] judges mail through the selected Pi transport with its own invocation and no Run lease", async () => {
  const adapters = createReferenceAdapterSet();
  const streamOptions: Record<string, unknown>[] = [];
  class MailRuntime extends RecordingRuntime {
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
            content: [{ type: "text", text: '{"items":[]}' }],
            api: "openai-completions",
            provider: "vercel-ai-gateway",
            model: primaryModel.model,
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 300,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 320,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000002 },
            },
          },
        };
      })();
    }
  }
  const prepared = compositionOptions(adapters, {
    runtimeFactory: { create: async () => new MailRuntime() as unknown as PiModelRuntime },
    fetch: vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ id: "generation:mail", model: primaryModel.model, usage: { cost: 0.000002 }, choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "generation:mail", routing: { finalProvider: "deepinfra" }, cost: 0.000002 } } } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  });
  const composition = createProductionModelComposition(prepared.options);
  try {
    expect(() =>
      composition.proactiveModel("missing-model", { maxOutputTokens: 4096, requestTimeoutMs: 1 }),
    ).toThrow("PROACTIVE_MODEL_DISCLOSURE_DENIED");
    const invoker = composition.proactiveModel(primaryModel.ref, {
      maxOutputTokens: 4096,
      requestTimeoutMs: 60_000,
    });
    const authority = await invoker.prepare({
      invocationId: "proactive-model-1",
      prompt: "判断这些新邮件",
      dataClassification: "private",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    expect(authority.runId).toBe("proactive:proactive-model-1");
    expect(authority.secretHandleRefs).toHaveLength(1);
    let output = "";
    let costMicros = -1;
    for await (const event of invoker.model.invoke({
      invocationId: "proactive-model-1",
      runId: authority.runId,
      modelRef: primaryModel.ref,
      inputRef: authority.inputRef,
      dataClassification: "private",
      allowedDisclosureRef: authority.allowedDisclosureRef,
      secretHandleRefs: [...authority.secretHandleRefs],
      correlationId: "proactive-model-1" as never,
    })) {
      if (event.type === "model.output") output += await invoker.readOutput(event.payloadRef);
      if (event.type === "model.completed") costMicros = event.costMicros;
      if (event.type === "model.failed") throw new Error(event.errorCode);
    }
    await authority.release();
    const [handleRef] = authority.secretHandleRefs;
    expect(
      (await prepared.options.handles.inspectHandle(handleRef ?? ""))?.revokedAt,
    ).not.toBeNull();
    expect(output).toBe('{"items":[]}');
    expect(costMicros).toBe(2);
    expect(streamOptions[0]).toMatchObject({ maxTokens: 4096, timeoutMs: 60_000, maxRetries: 0 });
  } finally {
    await composition.close();
  }
});

it("[P4-5] releases the stored prompt when a proactive call cannot get its secret handle", async () => {
  const adapters = createReferenceAdapterSet();
  const prepared = compositionOptions(adapters, {
    runtimeFactory: { create: async () => new RecordingRuntime() as unknown as PiModelRuntime },
  });
  const released: string[][] = [];
  const release = adapters.payload.delete.bind(adapters.payload);
  vi.spyOn(adapters.payload, "delete").mockImplementation(async (ref) => {
    released.push([ref]);
    return release(ref);
  });
  vi.spyOn(prepared.options.handles, "issueHandle").mockRejectedValue(new Error("HANDLE_FAILED"));
  const composition = createProductionModelComposition(prepared.options);
  try {
    const invoker = composition.proactiveModel(primaryModel.ref, {
      maxOutputTokens: 256,
      requestTimeoutMs: 60_000,
    });
    await expect(
      invoker.prepare({
        invocationId: "handle-fails",
        prompt: "判断这些新邮件",
        dataClassification: "private",
        deadlineAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("HANDLE_FAILED");
    expect(released).toHaveLength(1);
    expect(await adapters.payload.get(released[0]?.[0] as never)).toBeUndefined();
  } finally {
    await composition.close();
  }
});

function embeddingAccountingFixture(mode: "query" | "projection", response: unknown) {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  let boundary: EmbeddingBoundary | undefined;
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
  const send = vi.fn(async () => response as EmbeddingResponse);
  const diagnostics: Readonly<Record<string, string>>[] = [];
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
      {
        identity: "fixture",
        model: "alibaba/qwen3-embedding-8b",
        input: "memory",
        dimensions: 4096,
      },
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
    diagnostic: (event) => diagnostics.push(event),
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
    diagnostics,
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
  ])(
    mode === "query"
      ? "[P3-2] settles a chat embedding with $name at the estimate so the Run can still answer"
      : "[R2-L5] retains unknown embedding $name for projection",
    async ({ change }) => {
      const fixture = embeddingAccountingFixture(mode, {
        ...gatewayEmbeddingResponse(),
        ...change,
      });
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.send).toHaveBeenCalledTimes(1);
      expect(fixture.ledger.releaseReserved).not.toHaveBeenCalled();
      if (mode === "query") {
        expect(fixture.permit.markUnknown).not.toHaveBeenCalled();
        expect(fixture.permit.settle).toHaveBeenCalledTimes(1);
        expect(fixture.permit.settle).toHaveBeenCalledWith(
          expect.objectContaining({ inputTokens: 16384, outputTokens: 0 }),
        );
      } else {
        expect(fixture.ledger.markUnknown).toHaveBeenCalledTimes(1);
        expect(fixture.ledger.settle).not.toHaveBeenCalled();
      }
    },
  );
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
  "[R2-L5][P3-2] keeps a cancelled chat embedding unknown and settles a late one at the estimate when %s occurs during the final authority check",
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
    if (ending === "cancel") {
      expect(fixture.permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
      expect(fixture.permit.settle).not.toHaveBeenCalled();
    } else {
      expect(fixture.permit.markUnknown).not.toHaveBeenCalled();
      expect(fixture.permit.settle).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 16384, outputTokens: 0 }),
      );
    }
    expect(fixture.permit.releaseReserved).not.toHaveBeenCalled();
  },
);

it("[P3-2] keeps the embedding error and marks the call unknown when settling a failed chat embedding fails", async () => {
  const fixture = embeddingAccountingFixture("query", {
    ...gatewayEmbeddingResponse(),
    data: [],
  });
  fixture.permit.settle.mockRejectedValueOnce(new Error("SETTLE_REFUSED"));
  const failure = await fixture.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ message: "EMBEDDING_VECTOR_INVALID" });
  expect(fixture.permit.settle).toHaveBeenCalledTimes(1);
  expect(fixture.permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
  expect(fixture.permit.releaseReserved).not.toHaveBeenCalled();
  expect(fixture.diagnostics).toContainEqual(
    expect.objectContaining({ event: "memory.embedding_settle_failed", error: "SETTLE_REFUSED" }),
  );
});

it("[P3-2] keeps the embedding error when marking a failed projection embedding unknown fails", async () => {
  const fixture = embeddingAccountingFixture("projection", {
    ...gatewayEmbeddingResponse(),
    data: [],
  });
  fixture.budget.markUnknown.mockRejectedValueOnce(new Error("UNKNOWN_REFUSED"));
  const failure = await fixture.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ message: "EMBEDDING_VECTOR_INVALID" });
  expect(fixture.budget.settle).not.toHaveBeenCalled();
  expect(fixture.diagnostics).toContainEqual(
    expect.objectContaining({ event: "memory.embedding_unknown_failed", error: "UNKNOWN_REFUSED" }),
  );
});

it("[P3-2] keeps the embedding error when both settling and marking a failed chat embedding unknown fail", async () => {
  const fixture = embeddingAccountingFixture("query", {
    ...gatewayEmbeddingResponse(),
    data: [],
  });
  fixture.permit.settle.mockRejectedValueOnce(new Error("SETTLE_REFUSED"));
  fixture.permit.markUnknown.mockRejectedValueOnce(new Error("UNKNOWN_REFUSED"));
  const failure = await fixture.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ message: "EMBEDDING_VECTOR_INVALID" });
  expect(fixture.permit.markUnknown).toHaveBeenCalledWith("transport_unresolved");
  expect(fixture.diagnostics).toContainEqual(
    expect.objectContaining({ event: "memory.embedding_unknown_failed", error: "UNKNOWN_REFUSED" }),
  );
});

async function sensitiveInterceptionRepository(ownerId: string, agentId: string) {
  const stateRoot = path.join(temporaryDirectory, "sensitive-state");
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  const at = "2026-11-06T00:00:00.000Z";
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES ('thread-review', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(ownerId, agentId, at, at);
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
         content_digest, lifecycle_state, created_at, content_type)
       VALUES ('payload-review-trigger', ?, ?, 'private', 'sqlite_blob', X'00',
         'sha256:review-trigger', 'active', ?, 'application/octet-stream')`,
    )
    .run(ownerId, agentId, at);
  database
    .prepare(
      `INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key, source_type,
         source_id, payload_ref, source_proof_ref, occurred_at)
       VALUES ('trigger-review', ?, ?, 'thread-review', 'trigger-review', 'user_message',
         'fixture-review', 'payload-review-trigger', 'proof-review', ?)`,
    )
    .run(ownerId, agentId, at);
  database
    .prepare(
      `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
         status, created_at, updated_at)
       VALUES ('run-review', ?, ?, 'thread-review', 'session-review', 'trigger-review', 1,
         'running', ?, ?)`,
    )
    .run(ownerId, agentId, at, at);
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => at,
  });
  return { repository, databasePath };
}

it("[SI-2] files what an action review masked under its run's conversation, even after the run alone is deleted", async () => {
  const adapters = createReferenceAdapterSet();
  const ownerId = "owner-production-model";
  const agentId = "agent-production-model";
  const { repository, databasePath } = await sensitiveInterceptionRepository(ownerId, agentId);
  const sent: string[] = [];
  class ReviewRuntime extends RecordingRuntime {
    override getModel(providerId: string, modelId: string): unknown {
      const value = super.getModel(providerId, modelId);
      return value ? { ...(value as Record<string, unknown>), provider: providerId } : undefined;
    }
    stream(
      _model: unknown,
      context: { messages: { content: unknown }[] },
      options: Record<string, unknown>,
    ) {
      return (async function* () {
        await (options["fetch"] as typeof fetch)(
          "https://ai-gateway.vercel.sh/v1/chat/completions",
          { method: "POST", body: JSON.stringify({ messages: context.messages }) },
        );
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "{}" }],
            api: "openai-completions",
            provider: "vercel-ai-gateway",
            model: primaryModel.model,
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 10,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 11,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
            },
          },
        };
      })();
    }
  }
  const recorder = productionSensitiveInterceptionRecorder(repository);
  const egress = createProductionModelEgress(
    {
      secretReferences: [{ ref: "payload-key", version: "v1", purpose: "payload-encryption" }],
    } as never,
    { keys: { resolve: async () => new TextEncoder().encode("payload-key-material") } } as never,
    recorder,
  );
  const prepared = compositionOptions(adapters, {
    egress,
    egressThreadOf: productionEgressThreadOf(repository, {
      ownerId: ownerId as never,
      agentId: agentId as never,
    }),
    admission: (({ runId }: { readonly runId: string }) => ({
      context: { ownerId, agentId, runId },
      begin: async () => ({
        disposition: "fresh" as const,
        permit: {
          assertActive: async () => undefined,
          markStarted: async () => undefined,
          releaseReserved: async () => undefined,
          settle: async () => undefined,
          markUnknown: async () => undefined,
        },
      }),
    })) as never,
    runtimeFactory: { create: async () => new ReviewRuntime() as unknown as PiModelRuntime },
    fetch: vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push(typeof init?.body === "string" ? init.body : "");
      return new Response(
        `data: ${JSON.stringify({ id: "generation:review", model: primaryModel.model, usage: { cost: 0.000001 }, choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "generation:review", routing: { finalProvider: "deepinfra" }, cost: 0.000001 } } } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as never,
  });
  const composition = createProductionModelComposition(prepared.options);
  try {
    const invoker = composition.proactiveModel(primaryModel.ref, {
      maxOutputTokens: 256,
      requestTimeoutMs: 60_000,
    });
    const input = await invoker.prepare({
      invocationId: "review-masked",
      prompt: "这次动作要用的验证码 482910",
      dataClassification: "private",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    await input.release();
    const handle = await prepared.options.handles.issueHandle({
      ownerId: ownerId as never,
      agentId: agentId as never,
      runId: "run-review" as never,
      ...primaryModel.secretRequirement,
      scopeRef: "review-masked",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const events: string[] = [];
    for await (const event of composition.model.invoke({
      invocationId: "review-masked",
      runId: "run-review" as never,
      modelRef: primaryModel.ref,
      inputRef: input.inputRef,
      dataClassification: "private",
      allowedDisclosureRef: input.allowedDisclosureRef,
      secretHandleRefs: [handle.ref],
      correlationId: "review-masked" as never,
    }))
      events.push(event.type);
    expect(events).toContain("model.completed");
    expect(sent.join("\n")).not.toContain("482910");
    const writer = openQualifiedDatabase(databasePath);
    try {
      writer.prepare("DELETE FROM runs WHERE id = 'run-review'").run();
    } finally {
      writer.close();
    }
    await recorder.flush();
    const page = await repository
      .sensitiveInterceptions()
      .list({ ownerId: ownerId as never, agentId: agentId as never, limit: 10, before: null });
    expect(
      page.items.map(({ threadId, source, purpose, category, outcome }) => ({
        threadId,
        source,
        purpose,
        category,
        outcome,
      })),
    ).toEqual([
      {
        threadId: "thread-review",
        source: "background",
        purpose: "action-review",
        category: "verification-code",
        outcome: "masked",
      },
    ]);
  } finally {
    await composition.close();
    await repository.close();
  }
});

it("[MEMORY-DATE] hands each selected memory's recorded date and validity range to context formation", async () => {
  const configuration = selectedEmbeddingConfiguration(temporaryDirectory);
  const memory = createProductionRunMemory({
    configuration,
    projection: { bindEmbeddingBoundary: () => {} },
    payloads: { get: async () => ({ dataClassification: "private" }) as never },
    memory: {
      search: async () =>
        [
          {
            memory: {
              id: "memory-dated",
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              contentRef: "payload-dated",
              sourceRefs: ["message-dated"],
              dataClassification: "private",
              updatedAt: "2026-11-09T00:00:00.000Z",
              recordedAt: "2026-10-01T00:00:00.000Z",
              attributes: { validFrom: "2026-09-01", validTo: null },
            },
            providerRecordId: "provider-dated",
            score: 0.9,
          },
        ] as never,
    },
    admission: async () => undefined,
    budget: {} as never,
    assertActive: async () => {},
    now: () => "2026-11-10T00:00:00.000Z",
  });
  const found = await memory.search({
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId: "run-dated" as never,
    executionLease: {} as never,
    dataClassification: "private",
    queryRef: "query" as never,
    queryTerms: [],
    limit: 3,
  });
  expect(found.map(({ id, dates }) => ({ id, dates }))).toEqual([
    {
      id: "memory-dated",
      dates: { recordedAt: "2026-10-01T00:00:00.000Z", validFrom: "2026-09-01", validTo: null },
    },
  ]);
});
