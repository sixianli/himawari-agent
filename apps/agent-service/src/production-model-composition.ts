import type {
  ClockPort,
  ConfiguredEmbeddingModelDescriptor,
  ConfiguredGenerationModelDescriptor,
  IdGeneratorPort,
  ModelPort,
  ModelCostDescriptor,
  ModelSecretRequirement,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  SecretPort,
} from "@himawari-agent/application";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
  TrustedModelProviderAdapter,
} from "@himawari-agent/platform-node";
import {
  type ConfiguredPiModelDescriptor,
  ConfiguredPiModelBindingPort,
  PiModelTransport,
  type PiModelBindingPort,
  type PiModelRuntimeFactory,
  ProtectedPiModelPayloadBoundary,
} from "@himawari-agent/runtime-pi";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];

/**
 * Embeddings are deliberately not represented as a Pi ModelDescriptor. Pi
 * Mono's published runtime exposes generation models, not an embedding
 * runtime, so this product-owned descriptor is passed to the Memory adapter
 * separately and cannot accidentally enter the generation router.
 */
export interface ProductionEmbeddingModelDescriptor {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  readonly capabilities: readonly string[];
  readonly allowedDataClassifications: ConfiguredEmbeddingModelDescriptor["allowedDataClassifications"];
  readonly disclosure: ConfiguredEmbeddingModelDescriptor["disclosure"];
  readonly secretRequirement: ModelSecretRequirement | null;
  readonly cost: ModelCostDescriptor;
}

export interface ProductionModelDescriptorSet {
  readonly generation: readonly ConfiguredPiModelDescriptor[];
  readonly embedding: ProductionEmbeddingModelDescriptor;
}

export interface ProductionModelCompositionOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly descriptors: readonly ConfiguredPiModelDescriptor[];
  readonly handles: SecretPort;
  readonly secretSource: HostProviderSecretSource;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  readonly runtimeFactory?: PiModelRuntimeFactory;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxOutputTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly temperature?: number;
  readonly siteUrl?: string;
  readonly appName?: string;
}

export interface ProductionModelComposition {
  readonly model: ModelPort;
  readonly piModels: PiModelBindingPort;
  readonly transport: PiModelTransport;
  readonly payloadBoundary: ProtectedPiModelPayloadBoundary;
  close(): Promise<void>;
}

export interface ProductionModelCompositionFromConfigurationOptions
  extends Omit<ProductionModelCompositionOptions, "descriptors"> {
  readonly configuration: ProductConfiguration;
}

export interface ProductionConfiguredModelComposition {
  readonly descriptors: ProductionModelDescriptorSet;
  readonly composition: ProductionModelComposition;
}

function secretRequirementFor(
  configuration: ProductConfiguration,
  secretRef: string | null,
): ModelSecretRequirement | null {
  if (secretRef === null) return null;
  const matches = configuration.secretReferences.filter(({ ref }) => ref === secretRef);
  if (matches.length !== 1) {
    throw new Error("MODEL_SECRET_REFERENCE_AMBIGUOUS");
  }
  const reference = matches[0];
  if (!reference) throw new Error("MODEL_SECRET_REFERENCE_AMBIGUOUS");
  return Object.freeze({
    secretRef,
    secretVersion: reference.version,
    purpose: reference.purpose,
  });
}

function embeddingDescriptor(
  configuration: ProductConfiguration,
  descriptor: ConfiguredEmbeddingModelDescriptor,
): ProductionEmbeddingModelDescriptor {
  return Object.freeze({
    ref: descriptor.ref,
    provider: descriptor.provider,
    model: descriptor.model,
    version: descriptor.version,
    dimensions: descriptor.dimensions,
    capabilities: Object.freeze([...descriptor.capabilities]),
    allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
    disclosure: descriptor.disclosure,
    secretRequirement: secretRequirementFor(configuration, descriptor.secretRef),
    cost: Object.freeze({ ...descriptor.cost }),
  });
}

function piGenerationDescriptor(
  configuration: ProductConfiguration,
  descriptor: ConfiguredGenerationModelDescriptor,
): ConfiguredPiModelDescriptor {
  if (descriptor.provider !== "openrouter") {
    throw new Error("MODEL_PI_PROVIDER_UNSUPPORTED");
  }
  const secretRequirement = secretRequirementFor(configuration, descriptor.secretRef);
  if (secretRequirement === null) throw new Error("MODEL_PI_SECRET_REQUIRED");
  return Object.freeze({
    ref: descriptor.ref,
    provider: "openrouter",
    model: descriptor.model,
    version: descriptor.version,
    routingClass: descriptor.role,
    priority: descriptor.priority,
    disclosure: descriptor.disclosure,
    capabilities: Object.freeze([...descriptor.capabilities]),
    allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
    secretRequirement,
    ...(descriptor.providerRouting === undefined
      ? {}
      : { providerRouting: Object.freeze({ ...descriptor.providerRouting }) }),
    name: descriptor.name,
    api: descriptor.api,
    reasoning: descriptor.reasoning,
    input: Object.freeze([...descriptor.input]),
    cost: Object.freeze({ ...descriptor.cost }),
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
  });
}

/**
 * Resolve the strict product configuration into one canonical generation
 * binding for Pi and one independent embedding identity for Memory.
 */
export function resolveConfiguredModelDescriptorSet(
  configuration: ProductConfiguration,
): ProductionModelDescriptorSet {
  const primary = configuration.modelDescriptors.find(({ role }) => role === "primary");
  const fallback = configuration.modelDescriptors.find(({ role }) => role === "fallback");
  const embedding = configuration.modelDescriptors.find(({ role }) => role === "embedding");
  if (!primary || !fallback || !embedding) throw new Error("MODEL_DESCRIPTOR_SET_INCOMPLETE");
  if (embedding.role !== "embedding") throw new Error("MODEL_DESCRIPTOR_SET_INCOMPLETE");
  if (configuration.memory.dimensions !== embedding.dimensions) {
    throw new Error("MODEL_EMBEDDING_DIMENSIONS_MISMATCH");
  }
  if (primary.role === "embedding" || fallback.role === "embedding") {
    throw new Error("MODEL_DESCRIPTOR_SET_INCOMPLETE");
  }
  return Object.freeze({
    generation: Object.freeze([
      piGenerationDescriptor(configuration, primary),
      piGenerationDescriptor(configuration, fallback),
    ]),
    embedding: embeddingDescriptor(configuration, embedding),
  });
}

export const toProductionModelDescriptorSet = resolveConfiguredModelDescriptorSet;

export function createProductionModelCompositionFromConfiguration(
  options: ProductionModelCompositionFromConfigurationOptions,
): ProductionConfiguredModelComposition {
  const descriptors = resolveConfiguredModelDescriptorSet(options.configuration);
  const composition = createProductionModelComposition({
    ...options,
    descriptors: descriptors.generation,
  });
  return Object.freeze({ descriptors, composition });
}

export function createProductionModelComposition(
  options: ProductionModelCompositionOptions,
): ProductionModelComposition {
  assertProductionSecretSource(options.secretSource);
  const piModels = new ConfiguredPiModelBindingPort({
    descriptors: options.descriptors,
    secretSource: options.secretSource,
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
  });
  const payloadBoundary = new ProtectedPiModelPayloadBoundary({
    ownerId: options.ownerId,
    agentId: options.agentId,
    payloads: options.payloads,
    protector: options.protector,
    ids: options.ids,
    clock: options.clock,
  });
  const transport = new PiModelTransport({
    models: piModels,
    payloads: payloadBoundary,
    clock: options.clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
    ...(options.appName === undefined ? {} : { appName: options.appName }),
  });
  const model = new TrustedModelProviderAdapter({
    descriptors: options.descriptors,
    handles: options.handles,
    secretSource: options.secretSource,
    transport,
    clock: options.clock,
  });
  return Object.freeze({
    model,
    piModels,
    transport,
    payloadBoundary,
    close: () => piModels.close(),
  });
}
