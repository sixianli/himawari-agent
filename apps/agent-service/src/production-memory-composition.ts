import type {
  ConfiguredEmbeddingModelDescriptor,
  MemoryIndexStorePort,
  ProductConfiguration,
} from "@himawari-agent/application";
import {
  AI_GATEWAY_BASE_URL,
  type EmbeddingBoundary,
  GatewayEmbedder,
  HybridMemoryProvider,
  type HybridMemoryProviderOptions,
  QWEN3_EMBEDDING_8B_MODEL,
  QWEN3_MEMORY_MINIMUM_SIMILARITY,
  QWEN3_MEMORY_QUERY_INSTRUCTION,
} from "@himawari-agent/memory-engine";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
} from "@himawari-agent/platform-node";
import {
  type ProductionEmbeddingModelDescriptor,
  resolveConfiguredModelDescriptorSet,
  resolveConfiguredSecretRequirement,
} from "./production-model-composition.js";

export interface ProductionMemoryCompositionOptions {
  readonly configuration: ProductConfiguration;
  readonly secretSource: HostProviderSecretSource;
  readonly index: MemoryIndexStorePort;
  readonly fetch?: typeof fetch;
  readonly onVectorFailure?: HybridMemoryProviderOptions["onVectorFailure"];
}

export interface ProductionMemoryComposition {
  readonly descriptor: ProductionEmbeddingModelDescriptor;
  readonly projection: HybridMemoryProvider;
  bindEmbeddingBoundary(boundary: EmbeddingBoundary, timeoutMs: number): void;
  close(): Promise<void>;
}

function embeddingDescriptor(
  configuration: ProductConfiguration,
): ConfiguredEmbeddingModelDescriptor {
  const descriptor = configuration.modelDescriptors.find(({ role }) => role === "embedding");
  if (!descriptor || descriptor.role !== "embedding") {
    throw new Error("MEMORY_EMBEDDING_DESCRIPTOR_MISSING");
  }
  return descriptor;
}

export async function createProductionMemoryCompositionFromConfiguration(
  options: ProductionMemoryCompositionOptions,
): Promise<ProductionMemoryComposition> {
  assertProductionSecretSource(options.secretSource);
  const embedding = embeddingDescriptor(options.configuration);
  if (embedding.provider !== "vercel-ai-gateway")
    throw new TypeError("MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED");
  if (!embedding.capabilities.includes("embedding"))
    throw new TypeError("MEMORY_EMBEDDING_CAPABILITY_REQUIRED");
  if (embedding.dimensions !== options.configuration.memory.dimensions)
    throw new TypeError("MEMORY_EMBEDDING_DIMENSIONS_MISMATCH");
  const secret = resolveConfiguredSecretRequirement(options.configuration, embedding.secretRef);
  if (!secret) throw new Error("MEMORY_PROVIDER_SECRET_REQUIRED");
  if (!options.secretSource.productionSuitable)
    throw new TypeError("MEMORY_UNSAFE_PROVIDER_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  const embedder = new GatewayEmbedder({
    baseUrl: AI_GATEWAY_BASE_URL,
    model: embedding.model,
    dimensions: embedding.dimensions,
    apiKey: () => {
      apiKey ??= options.secretSource
        .resolve(secret.secretRef, secret.secretVersion)
        .then((value) => {
          if (value.trim().length === 0) throw new Error("MEMORY_PROVIDER_SECRET_EMPTY");
          return value;
        });
      return apiKey;
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const minimumSimilarity =
    options.configuration.memory.minimumSimilarity ??
    (embedding.model === QWEN3_EMBEDDING_8B_MODEL ? QWEN3_MEMORY_MINIMUM_SIMILARITY : undefined);
  if (minimumSimilarity === undefined || minimumSimilarity <= 0)
    throw new TypeError("MEMORY_MINIMUM_SIMILARITY_REQUIRED");
  const projection = new HybridMemoryProvider({
    index: options.index,
    embedder,
    minimumSimilarity,
    embeddableClassifications: embedding.allowedDataClassifications,
    ...(embedding.model === QWEN3_EMBEDDING_8B_MODEL
      ? { queryInstruction: QWEN3_MEMORY_QUERY_INSTRUCTION }
      : {}),
    now: () => new Date().toISOString(),
    ...(options.configuration.runPolicy?.timeZone
      ? { timeZone: options.configuration.runPolicy.timeZone }
      : {}),
    ...(options.onVectorFailure === undefined ? {} : { onVectorFailure: options.onVectorFailure }),
  });
  return Object.freeze({
    descriptor: resolveConfiguredModelDescriptorSet(options.configuration).embedding,
    projection,
    bindEmbeddingBoundary: (boundary: EmbeddingBoundary, timeoutMs: number) =>
      embedder.bindBoundary(boundary, timeoutMs),
    close: async () => {},
  });
}
