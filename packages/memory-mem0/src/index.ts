import path from "node:path";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type ConfiguredEmbeddingModelDescriptor,
  type ConfiguredGenerationModelDescriptor,
  type ConfiguredMemoryDescriptor,
  type MemoryProviderHit,
  type MemoryProviderProjectionPort,
  type ModelSecretRequirement,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";

/**
 * Mem0's OpenAI embedder already supports an OpenAI-compatible base URL and
 * forwards `embeddingDims` as the provider `dimensions` request field. Keep
 * these product facts in one adapter-owned place so the production memory
 * composition does not grow a second embedding protocol implementation.
 */
export const MEM0_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1" as const;
export const QWEN3_EMBEDDING_8B_MODEL = "qwen/qwen3-embedding-8b" as const;
export const QWEN3_EMBEDDING_8B_DIMENSIONS = 4096 as const;
export const QWEN3_EMBEDDING_8B_VERSION = "catalog-2026-08-28" as const;
export const QWEN3_EMBEDDING_8B_COST = Object.freeze({
  input: 0.01,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const memoryMem0Workspace = {
  adapterKind: "memory-projection",
  provider: "mem0ai/oss@3.1.7",
  requiresExplicitProviders: true,
} as const;

export interface Mem0OpenAiDescriptor {
  readonly provider: "openai";
  readonly config: {
    readonly apiKey: string;
    readonly baseURL: string;
    readonly model: string;
    readonly embeddingDims?: number;
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
}

export interface Mem0ProjectionConfiguration {
  readonly stateRoot: string;
  readonly version: "v1.1";
  readonly llm: Mem0OpenAiDescriptor;
  readonly embedder: Mem0OpenAiDescriptor & {
    readonly config: Mem0OpenAiDescriptor["config"] & { readonly embeddingDims: number };
  };
  readonly vectorStore: {
    readonly provider: "memory";
    readonly config: {
      readonly collectionName: string;
      readonly dimension: number;
      readonly dbPath: string;
    };
  };
  readonly historyStore: {
    readonly provider: "sqlite";
    readonly config: { readonly historyDbPath: string };
  };
  readonly customInstructions: string;
}

interface Mem0Result {
  readonly id: string;
  readonly memory?: string;
  readonly score?: number;
  readonly metadata?: Readonly<{
    readonly product_memory_id?: unknown;
    readonly [key: string]: unknown;
  }>;
}

interface Mem0MemoryLike {
  add(
    content: string,
    options: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly results: readonly Mem0Result[] }>;
  update(
    providerRecordId: string,
    input: { readonly text: string; readonly metadata: Readonly<Record<string, unknown>> },
  ): Promise<unknown>;
  get(providerRecordId: string): Promise<Mem0Result | null>;
  getAll(
    input: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly results: readonly Mem0Result[] }>;
  search(
    query: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly results: readonly Mem0Result[] }>;
  delete(providerRecordId: string): Promise<unknown>;
  close?: () => Promise<unknown> | unknown;
}

type Mem0Constructor = new (configuration: Readonly<Record<string, unknown>>) => Mem0MemoryLike;
export type Mem0Loader = () => Promise<{ readonly Memory: Mem0Constructor }>;

export interface Mem0ProjectionAdapterOptions {
  readonly configuration: Mem0ProjectionConfiguration;
  readonly load?: Mem0Loader;
}

/**
 * A trusted, opaque provider-secret boundary for the Mem0 adapter. The raw
 * value is resolved only while constructing the third-party Mem0 object and
 * is never part of the product configuration or descriptor surface.
 */
export interface Mem0ProviderSecretSource {
  readonly productionSuitable: boolean;
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export interface OpenRouterMem0ProjectionOptions {
  readonly stateRoot: string;
  readonly memory: ConfiguredMemoryDescriptor;
  readonly llm: ConfiguredGenerationModelDescriptor;
  readonly embedding: ConfiguredEmbeddingModelDescriptor;
  readonly llmSecret: ModelSecretRequirement;
  readonly embeddingSecret: ModelSecretRequirement;
  readonly secretSource: Mem0ProviderSecretSource;
  readonly collectionName?: string;
  readonly customInstructions?: string;
  readonly load?: Mem0Loader;
}

function fail(message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, message, details);
}

function assertOpenRouterModel(
  descriptor: ConfiguredGenerationModelDescriptor | ConfiguredEmbeddingModelDescriptor,
  field: string,
): void {
  if (descriptor.provider !== "openrouter") {
    throw new TypeError(`${field}.provider must be openrouter`);
  }
  if (descriptor.secretRef === null) {
    throw new TypeError(`${field}.secretRef is required for an OpenRouter model`);
  }
  requiredText(descriptor.model, `${field}.model`);
  requiredText(descriptor.version, `${field}.version`);
}

function assertSafeMemoryPath(stateRoot: string, target: string, field: string): void {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) {
    throw new TypeError(`${field} must be a normalized absolute path`);
  }
  containedAbsolutePath(stateRoot, target, field);
}

function requiredText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }
}

function containedAbsolutePath(stateRoot: string, target: string, field: string): void {
  if (!path.isAbsolute(target)) throw new TypeError(`${field} must be absolute`);
  const relative = path.relative(stateRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${field} must remain inside stateRoot`);
  }
}

function validateConfiguration(configuration: Mem0ProjectionConfiguration): void {
  if (!path.isAbsolute(configuration.stateRoot)) throw new TypeError("stateRoot must be absolute");
  if (configuration.version !== "v1.1") throw new TypeError("Mem0 version must be v1.1");
  for (const [field, value] of [
    ["llm.apiKey", configuration.llm.config.apiKey],
    ["llm.baseURL", configuration.llm.config.baseURL],
    ["llm.model", configuration.llm.config.model],
    ["embedder.apiKey", configuration.embedder.config.apiKey],
    ["embedder.baseURL", configuration.embedder.config.baseURL],
    ["embedder.model", configuration.embedder.config.model],
    ["vectorStore.collectionName", configuration.vectorStore.config.collectionName],
    ["customInstructions", configuration.customInstructions],
  ] as const) {
    requiredText(value, field);
  }
  if (
    !Number.isSafeInteger(configuration.embedder.config.embeddingDims) ||
    configuration.embedder.config.embeddingDims <= 0 ||
    configuration.vectorStore.config.dimension !== configuration.embedder.config.embeddingDims
  ) {
    throw new TypeError("Mem0 vector and embedder dimensions must be equal positive integers");
  }
  containedAbsolutePath(
    configuration.stateRoot,
    configuration.vectorStore.config.dbPath,
    "vectorStore.dbPath",
  );
  containedAbsolutePath(
    configuration.stateRoot,
    configuration.historyStore.config.historyDbPath,
    "historyStore.historyDbPath",
  );
}

function metadata(memory: ProductMemoryRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    product_memory_id: memory.id,
    source_refs: [...memory.sourceRefs],
    classification: memory.dataClassification,
    product_revision: memory.revision,
    projection_policy_version: memory.policyVersion,
  });
}

function productMemoryId(result: Mem0Result): MemoryId | null {
  const value = result.metadata?.product_memory_id;
  return typeof value === "string" && value.length > 0 ? (value as MemoryId) : null;
}

export class Mem0ProjectionAdapter implements MemoryProviderProjectionPort {
  private readonly memory: Mem0MemoryLike;

  private constructor(memory: Mem0MemoryLike) {
    this.memory = memory;
  }

  static async create(options: Mem0ProjectionAdapterOptions): Promise<Mem0ProjectionAdapter> {
    validateConfiguration(options.configuration);
    Object.assign(process.env, {
      MEM0_TELEMETRY: "false",
      MEM0_TELEMETRY_SAMPLE_RATE: "0",
      MEM0_DIR: path.join(options.configuration.stateRoot, "config"),
    });
    const moduleSpecifier: string = "mem0ai/oss";
    const module = await (options.load ?? (() => import(moduleSpecifier)))();
    if (typeof module.Memory !== "function") fail("mem0ai/oss does not export Memory");
    const configuration = {
      version: options.configuration.version,
      llm: options.configuration.llm,
      embedder: options.configuration.embedder,
      vectorStore: options.configuration.vectorStore,
      historyStore: options.configuration.historyStore,
      historyDbPath: options.configuration.historyStore.config.historyDbPath,
      disableHistory: false,
      customInstructions: options.configuration.customInstructions,
    };
    return new Mem0ProjectionAdapter(new module.Memory(configuration));
  }

  async close(): Promise<void> {
    await this.memory.close?.();
  }

  async upsert(input: {
    readonly memory: ProductMemoryRecord;
    readonly content: string;
  }): Promise<string> {
    requiredText(input.content, "content");
    const providerMetadata = metadata(input.memory);
    if (input.memory.providerRecordId) {
      await this.memory.update(input.memory.providerRecordId, {
        text: input.content,
        metadata: providerMetadata,
      });
      const updated = await this.memory.get(input.memory.providerRecordId);
      if (productMemoryId(updated ?? { id: "" }) !== input.memory.id) {
        fail("Mem0 update lost the product Memory identity", { memoryId: input.memory.id });
      }
      return input.memory.providerRecordId;
    }
    const result = await this.memory.add(input.content, {
      userId: input.memory.ownerId,
      agentId: input.memory.agentId,
      runId: `product-memory:${input.memory.id}:${input.memory.revision}`,
      infer: false,
      metadata: providerMetadata,
    });
    if (result.results.length !== 1) {
      fail("Mem0 must return exactly one provider record for one product Memory", {
        memoryId: input.memory.id,
        resultCount: String(result.results.length),
      });
    }
    const created = result.results[0];
    if (!created?.id) fail("Mem0 returned an empty provider record identity");
    const roundTrip = await this.memory.get(created.id);
    if (productMemoryId(roundTrip ?? { id: "" }) !== input.memory.id) {
      await this.memory.delete(created.id);
      fail("Mem0 round-trip lost the product Memory identity", { memoryId: input.memory.id });
    }
    return created.id;
  }

  async delete(providerRecordId: string): Promise<void> {
    requiredText(providerRecordId, "providerRecordId");
    await this.memory.delete(providerRecordId);
    if ((await this.memory.get(providerRecordId)) !== null) {
      fail("Mem0 provider record remains after delete", { providerRecordId });
    }
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly MemoryProviderHit[]> {
    requiredText(input.query, "query");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 1000) {
      throw new RangeError("limit must be an integer between 0 and 1000");
    }
    const result = await this.memory.search(input.query, {
      filters: { user_id: input.ownerId, agent_id: input.agentId },
      topK: input.limit,
      threshold: 0,
    });
    return result.results.flatMap((candidate) => {
      const memoryId = productMemoryId(candidate);
      if (!memoryId) return [];
      return [
        Object.freeze({
          providerRecordId: candidate.id,
          productMemoryId: memoryId,
          score: typeof candidate.score === "number" ? candidate.score : 0,
        }),
      ];
    });
  }

  async clearScope(ownerId: OwnerId, agentId: AgentId): Promise<void> {
    const result = await this.memory.getAll({ filters: { user_id: ownerId, agent_id: agentId } });
    for (const record of result.results) await this.delete(record.id);
  }
}

/**
 * Compose the existing Mem0 OpenAI-compatible provider with explicit product
 * model descriptors. Mem0 remains responsible for embedding HTTP, vector
 * storage, and history; Himawari owns the selected identity, dimensions,
 * secret reference, and path boundary.
 */
export async function createOpenRouterMem0ProjectionAdapter(
  options: OpenRouterMem0ProjectionOptions,
): Promise<Mem0ProjectionAdapter> {
  if (!options.secretSource.productionSuitable) {
    throw new TypeError("MEM0_UNSAFE_PROVIDER_SECRET_SOURCE");
  }
  assertOpenRouterModel(options.llm, "llm");
  assertOpenRouterModel(options.embedding, "embedding");
  if (!options.embedding.capabilities.includes("embedding")) {
    throw new TypeError("embedding.capabilities must include embedding");
  }
  if (!options.llm.capabilities.includes("text")) {
    throw new TypeError("llm.capabilities must include text");
  }
  if (
    !Number.isSafeInteger(options.embedding.dimensions) ||
    options.embedding.dimensions <= 0 ||
    options.memory.dimensions !== options.embedding.dimensions
  ) {
    throw new TypeError("MEM0_EMBEDDING_DIMENSIONS_MISMATCH");
  }
  assertSafeMemoryPath(options.stateRoot, options.memory.storagePath, "memory.storagePath");

  const llmSecretRef = options.llm.secretRef;
  const embeddingSecretRef = options.embedding.secretRef;
  if (
    llmSecretRef === null ||
    embeddingSecretRef === null ||
    options.llmSecret.secretRef !== llmSecretRef ||
    options.embeddingSecret.secretRef !== embeddingSecretRef
  ) {
    throw new TypeError("MEM0_PROVIDER_SECRET_REQUIRED");
  }
  const resolvedSecrets = new Map<string, Promise<string>>();
  const resolveSecret = async (requirement: ModelSecretRequirement): Promise<string> => {
    const cacheKey = `${requirement.secretRef}@${requirement.secretVersion}:${requirement.purpose}`;
    const cached = resolvedSecrets.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolution = (async () => {
      let value: string;
      try {
        value = await options.secretSource.resolve(
          requirement.secretRef,
          requirement.secretVersion,
        );
      } catch {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          "Mem0 provider credential could not be resolved",
          { secretRef: requirement.secretRef, secretVersion: requirement.secretVersion },
        );
      }
      requiredText(value, `secret.${requirement.secretRef}`);
      return value;
    })();
    resolvedSecrets.set(cacheKey, resolution);
    return resolution;
  };

  const [llmKey, embedKey] = await Promise.all([
    resolveSecret(options.llmSecret),
    resolveSecret(options.embeddingSecret),
  ]);
  const memoryRoot = options.memory.storagePath;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(memoryRoot, { recursive: true, mode: 0o700 });

  return Mem0ProjectionAdapter.create({
    configuration: {
      stateRoot: options.stateRoot,
      version: "v1.1",
      llm: {
        provider: "openai",
        config: {
          apiKey: llmKey,
          baseURL: MEM0_OPENROUTER_BASE_URL,
          model: options.llm.model,
          temperature: 0,
          maxTokens: Math.min(options.llm.maxTokens, 256),
        },
      },
      embedder: {
        provider: "openai",
        config: {
          apiKey: embedKey,
          baseURL: MEM0_OPENROUTER_BASE_URL,
          model: options.embedding.model,
          embeddingDims: options.embedding.dimensions,
        },
      },
      vectorStore: {
        provider: "memory",
        config: {
          collectionName: options.collectionName ?? "himawari_memories",
          dimension: options.embedding.dimensions,
          dbPath: path.join(memoryRoot, "vectors.sqlite"),
        },
      },
      historyStore: {
        provider: "sqlite",
        config: { historyDbPath: path.join(memoryRoot, "history.sqlite") },
      },
      customInstructions: options.customInstructions ?? "只投影产品已经批准的一条 Memory。",
    },
    ...(options.load === undefined ? {} : { load: options.load }),
  });
}
