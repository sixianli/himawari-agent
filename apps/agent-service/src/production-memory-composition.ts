import {
  type ConfiguredEmbeddingModelDescriptor,
  type EmbeddingProfile,
  embeddingIdentity,
  embeddingProfileFor,
  GATEWAY_EMBEDDING_PROVIDER,
  LOCAL_ONNX_EMBEDDING_PROVIDER,
  type MemoryIndexStorePort,
  type ModelEgress,
  type ProductConfiguration,
} from "@himawari-agent/application";
import {
  AI_GATEWAY_BASE_URL,
  EgressEmbedder,
  DEFAULT_RELEVANCE_TUNING,
  type EmbeddingBoundary,
  HybridMemoryProvider,
  type HybridMemoryProviderOptions,
  LOCAL_ONNX_BASE_URL,
} from "@himawari-agent/memory-engine";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
  LocalOnnxEmbeddingRuntime,
  type LocalOnnxLoader,
} from "@himawari-agent/platform-node";
import {
  type ProductionEmbeddingModelDescriptor,
  resolveConfiguredModelDescriptorSet,
  resolveConfiguredSecretRequirement,
} from "./production-model-composition.js";

export interface ProductionMemoryCompositionOptions {
  readonly egress: ModelEgress;
  readonly configuration: ProductConfiguration;
  readonly secretSource: HostProviderSecretSource;
  readonly index: MemoryIndexStorePort;
  readonly fetch?: typeof fetch;
  readonly onVectorFailure: NonNullable<HybridMemoryProviderOptions["onVectorFailure"]>;
  readonly localLoader?: LocalOnnxLoader;
  readonly onRelevanceUnknown?: HybridMemoryProviderOptions["onRelevanceUnknown"];
}

export interface ProductionMemoryComposition {
  readonly descriptor: ProductionEmbeddingModelDescriptor;
  readonly profile: EmbeddingProfile;
  readonly identity: string;
  readonly localRuntime: LocalOnnxEmbeddingRuntime | null;
  readonly projection: HybridMemoryProvider;
  readonly dedupeSameSource: boolean;
  bindEmbeddingBoundary(
    boundary: EmbeddingBoundary,
    timeoutMs: number,
    searchCancelled?: (error: unknown) => boolean,
  ): void;
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
  if (!embedding.capabilities.includes("embedding"))
    throw new TypeError("MEMORY_EMBEDDING_CAPABILITY_REQUIRED");
  if (embedding.dimensions !== options.configuration.memory.dimensions)
    throw new TypeError("MEMORY_EMBEDDING_DIMENSIONS_MISMATCH");
  const profile = embeddingProfileFor(embedding);
  const identity = embeddingIdentity(embedding);
  const egressContext = {
    ownerId: options.configuration.ownerId,
    agentId: options.configuration.agentId,
    threadId: null,
    source: "embedding" as const,
    purpose: null,
  };
  let localRuntime: LocalOnnxEmbeddingRuntime | null = null;
  let embedder: EgressEmbedder;
  if (embedding.provider === LOCAL_ONNX_EMBEDDING_PROVIDER) {
    if (embedding.disclosure !== "local_only" || embedding.secretRef !== null)
      throw new TypeError("MEMORY_LOCAL_EMBEDDING_POLICY");
    const artifactSha256 = embedding.artifactSha256;
    if (artifactSha256 === undefined)
      throw new TypeError("MEMORY_LOCAL_EMBEDDING_ARTIFACT_REQUIRED");
    const runtime = new LocalOnnxEmbeddingRuntime({
      stateRoot: options.configuration.stateRoot,
      profile,
      dimensions: embedding.dimensions,
      artifactSha256,
      ...(options.localLoader === undefined ? {} : { load: options.localLoader }),
    });
    localRuntime = runtime;
    embedder = new EgressEmbedder({
      egress: options.egress,
      egressContext,
      baseUrl: LOCAL_ONNX_BASE_URL,
      profile,
      identity,
      dimensions: embedding.dimensions,
      fetch: runtime.fetch as typeof fetch,
      admit: (priority) => runtime.assertAccepting(priority),
    });
  } else if (embedding.provider === GATEWAY_EMBEDDING_PROVIDER) {
    const secret = resolveConfiguredSecretRequirement(options.configuration, embedding.secretRef);
    if (!secret) throw new Error("MEMORY_PROVIDER_SECRET_REQUIRED");
    if (!options.secretSource.productionSuitable)
      throw new TypeError("MEMORY_UNSAFE_PROVIDER_SECRET_SOURCE");
    let apiKey: Promise<string> | undefined;
    embedder = new EgressEmbedder({
      egress: options.egress,
      egressContext,
      baseUrl: AI_GATEWAY_BASE_URL,
      profile,
      identity,
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
  } else throw new TypeError("MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED");
  const minimumSimilarity =
    options.configuration.memory.minimumSimilarity ?? profile.chatMinimumSimilarity;
  let searchCancelled: (error: unknown) => boolean = () => false;
  const retrieval = options.configuration.memory.retrieval;
  const projection = new HybridMemoryProvider({
    index: options.index,
    embedder,
    minimumSimilarity,
    embeddableClassifications: embedding.allowedDataClassifications,
    now: () => new Date().toISOString(),
    ...(options.configuration.runPolicy?.timeZone
      ? { timeZone: options.configuration.runPolicy.timeZone }
      : {}),
    onVectorFailure: (error, scope) => {
      if (!searchCancelled(error)) options.onVectorFailure(error, scope);
    },
    relevance: {
      keywordWeight: retrieval?.keywordWeight ?? DEFAULT_RELEVANCE_TUNING.keywordWeight,
      entityWeight: retrieval?.entityWeight ?? DEFAULT_RELEVANCE_TUNING.entityWeight,
      cutoffMargin: retrieval?.cutoffMargin ?? DEFAULT_RELEVANCE_TUNING.cutoffMargin,
    },
    ...(options.onRelevanceUnknown === undefined
      ? {}
      : { onRelevanceUnknown: options.onRelevanceUnknown }),
  });
  return Object.freeze({
    descriptor: resolveConfiguredModelDescriptorSet(options.configuration).embedding,
    profile,
    identity,
    localRuntime,
    projection,
    dedupeSameSource: retrieval?.dedupeSameSource ?? true,
    bindEmbeddingBoundary: (
      boundary: EmbeddingBoundary,
      timeoutMs: number,
      cancelled?: (error: unknown) => boolean,
    ) => {
      embedder.bindBoundary(boundary, timeoutMs);
      if (cancelled) searchCancelled = cancelled;
    },
    close: async () => {
      await localRuntime?.close();
    },
  });
}
