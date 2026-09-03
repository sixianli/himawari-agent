import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ConfiguredEmbeddingModelDescriptor,
  ConfiguredGenerationModelDescriptor,
  ConfiguredMemoryDescriptor,
  ProductMemoryRecord,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenRouterMem0ProjectionAdapter,
  MEM0_OPENROUTER_BASE_URL,
  Mem0ProjectionAdapter,
  type Mem0ProjectionConfiguration,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
} from "../src/index.ts";

const OWNER_ID = createOwnerId("owner-mem0-contract");
const AGENT_ID = createAgentId("agent-mem0-contract");
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "himawari-mem0-contract-"));
});

afterEach(async () => {
  FakeMem0Memory.latest = null;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

interface FakeRecord {
  readonly id: string;
  readonly memory: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

class FakeMem0Memory {
  static latest: FakeMem0Memory | null = null;
  readonly records = new Map<string, FakeRecord>();
  readonly adds: Array<{
    readonly content: string;
    readonly options: Readonly<Record<string, unknown>>;
  }> = [];
  readonly configuration: Readonly<Record<string, unknown>>;
  resultCount = 1;

  constructor(configuration: Readonly<Record<string, unknown>>) {
    this.configuration = configuration;
    FakeMem0Memory.latest = this;
  }

  async add(content: string, options: Readonly<Record<string, unknown>>) {
    this.adds.push({ content, options });
    const metadata = (options as { readonly metadata: Readonly<Record<string, unknown>> }).metadata;
    const results = Array.from({ length: this.resultCount }, (_, index) => {
      const id = `provider-${this.records.size + index + 1}`;
      const record = { id, memory: content, score: 0.9, metadata };
      this.records.set(id, record);
      return record;
    });
    return { results };
  }

  async update(
    providerRecordId: string,
    input: { readonly text: string; readonly metadata: Readonly<Record<string, unknown>> },
  ) {
    const current = this.records.get(providerRecordId);
    if (!current) throw new Error("missing provider record");
    this.records.set(providerRecordId, {
      ...current,
      memory: input.text,
      metadata: input.metadata,
    });
  }

  async get(providerRecordId: string) {
    return this.records.get(providerRecordId) ?? null;
  }

  async getAll() {
    return { results: [...this.records.values()] };
  }

  async search() {
    return { results: [...this.records.values()] };
  }

  async delete(providerRecordId: string) {
    this.records.delete(providerRecordId);
  }
}

function configuration(
  stateRoot = path.join(temporaryDirectory, "state"),
): Mem0ProjectionConfiguration {
  return {
    stateRoot,
    version: "v1.1",
    llm: {
      provider: "openai",
      config: {
        apiKey: "secret-ref-material",
        baseURL: "http://127.0.0.1:41001/v1",
        model: "exact-llm-v1",
        temperature: 0,
        maxTokens: 256,
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: "secret-ref-material",
        baseURL: "http://127.0.0.1:41002/v1",
        model: "exact-embedder-v1",
        embeddingDims: 12,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: "himawari_memories",
        dimension: 12,
        dbPath: path.join(stateRoot, "vectors.sqlite"),
      },
    },
    historyStore: {
      provider: "sqlite",
      config: { historyDbPath: path.join(stateRoot, "history.sqlite") },
    },
    customInstructions: "只投影产品已经批准的一条 Memory。",
  };
}

function productMemory(providerRecordId: string | null = null): ProductMemoryRecord {
  return {
    id: createMemoryId("memory-contract-01"),
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: providerRecordId ? 2 : 1,
    status: "active",
    contentRef: "payload-memory-contract-01",
    dataClassification: "private",
    sourceThreadId: createThreadId("thread-contract-01"),
    sourceRefs: ["message-contract-01"],
    inference: false,
    confidencePermille: 1000,
    policyVersion: "memory-policy-v1",
    providerRecordId,
    lastUsedAt: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

async function adapter() {
  return Mem0ProjectionAdapter.create({
    configuration: configuration(),
    load: async () => ({ Memory: FakeMem0Memory }),
  });
}

describe("Mem0 product projection adapter", () => {
  it("uses one non-inferred provider add and round-trips the product identity", async () => {
    const projection = await adapter();
    const providerId = await projection.upsert({
      memory: productMemory(),
      content: "所有者偏好安静的餐厅",
    });
    const fake = FakeMem0Memory.latest as FakeMem0Memory;

    expect(providerId).toBe("provider-1");
    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0]?.options).toMatchObject({
      userId: OWNER_ID,
      agentId: AGENT_ID,
      infer: false,
      metadata: {
        product_memory_id: "memory-contract-01",
        source_refs: ["message-contract-01"],
        classification: "private",
        product_revision: 1,
        projection_policy_version: "memory-policy-v1",
      },
    });
    expect(
      await projection.search({ ownerId: OWNER_ID, agentId: AGENT_ID, query: "安静", limit: 5 }),
    ).toEqual([
      {
        providerRecordId: "provider-1",
        productMemoryId: "memory-contract-01",
        score: 0.9,
      },
    ]);
  });

  it("updates an existing provider ID and verifies delete readback", async () => {
    const projection = await adapter();
    const providerId = await projection.upsert({ memory: productMemory(), content: "旧内容" });
    expect(
      await projection.upsert({
        memory: productMemory(providerId),
        content: "更正后的内容",
      }),
    ).toBe(providerId);
    expect(FakeMem0Memory.latest?.records.get(providerId)?.memory).toBe("更正后的内容");

    await projection.delete(providerId);
    expect(FakeMem0Memory.latest?.records.has(providerId)).toBe(false);
  });

  it("rejects partial or duplicate provider results for one product Memory", async () => {
    const projection = await adapter();
    if (!FakeMem0Memory.latest) throw new Error("Fake Mem0 was not created");
    FakeMem0Memory.latest.resultCount = 2;

    await expect(
      projection.upsert({ memory: productMemory(), content: "不得批量投影" }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.PROVIDER_FAILURE });
  });

  it("rejects implicit or escaping storage configuration before loading Mem0", async () => {
    const invalid = configuration();
    await expect(
      Mem0ProjectionAdapter.create({
        configuration: {
          ...invalid,
          vectorStore: {
            ...invalid.vectorStore,
            config: {
              ...invalid.vectorStore.config,
              dbPath: path.join(temporaryDirectory, "outside.sqlite"),
            },
          },
        },
        load: async () => ({ Memory: FakeMem0Memory }),
      }),
    ).rejects.toThrow("vectorStore.dbPath must remain inside stateRoot");
  });

  it("maps the selected OpenRouter Qwen embedding identity through Mem0's OpenAI provider", async () => {
    const stateRoot = path.join(temporaryDirectory, "qwen");
    const primary: ConfiguredGenerationModelDescriptor = {
      ref: "model-primary",
      role: "primary",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      version: "catalog-2026-08-28",
      priority: 1,
      name: "Primary",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      capabilities: ["text"],
      contextWindow: 1_000,
      maxTokens: 256,
      allowedDataClassifications: ["public", "private"],
      disclosure: "external_remote",
      secretRef: "openrouter-api-key",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const embedding: ConfiguredEmbeddingModelDescriptor = {
      ref: "model-embedding",
      role: "embedding",
      provider: "openrouter",
      model: QWEN3_EMBEDDING_8B_MODEL,
      version: "catalog-2026-08-28",
      dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
      capabilities: ["embedding"],
      allowedDataClassifications: ["public", "private"],
      disclosure: "external_remote",
      secretRef: "openrouter-api-key",
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const memory: ConfiguredMemoryDescriptor = {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: `${stateRoot}/data/memory`,
      dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
    };
    const resolutions: string[] = [];
    const projection = await createOpenRouterMem0ProjectionAdapter({
      stateRoot,
      memory,
      llm: primary,
      embedding,
      llmSecret: {
        secretRef: "openrouter-api-key",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
      embeddingSecret: {
        secretRef: "openrouter-api-key",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
      secretSource: {
        productionSuitable: true,
        resolve: async (secretRef, secretVersion) => {
          resolutions.push(`${secretRef}@${secretVersion}`);
          return "opaque-provider-secret";
        },
      },
      load: async () => ({ Memory: FakeMem0Memory }),
    });
    const fake = FakeMem0Memory.latest as FakeMem0Memory;

    expect(resolutions).toEqual(["openrouter-api-key@v1"]);
    expect(fake.configuration).toMatchObject({
      llm: {
        provider: "openai",
        config: {
          baseURL: MEM0_OPENROUTER_BASE_URL,
          model: primary.model,
        },
      },
      embedder: {
        provider: "openai",
        config: {
          baseURL: MEM0_OPENROUTER_BASE_URL,
          model: QWEN3_EMBEDDING_8B_MODEL,
          embeddingDims: QWEN3_EMBEDDING_8B_DIMENSIONS,
        },
      },
      vectorStore: {
        config: { dimension: QWEN3_EMBEDDING_8B_DIMENSIONS },
      },
    });
    await projection.close();
  });
});
