import type {
  ClockPort,
  ConfiguredEmbeddingModelDescriptor,
  ConfiguredGenerationModelDescriptor,
  IdGeneratorPort,
  ModelCostDescriptor,
  ModelDescriptor,
  ModelInvocationAdmissionResolver,
  ModelInvocationAdmissionPort,
  RuntimeRequest,
  ModelPort,
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
  admissionCostForConfiguredPiModel,
  ConfiguredPiModelBindingPort,
  type ConfiguredPiModelDescriptor,
  type PiModelBindingPort,
  type PiModelRuntimeFactory,
  PiModelTransport,
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
  /** Resolves a gate bound to the current Run lease; omitted means fail closed. */
  readonly admission?: ModelInvocationAdmissionResolver;
}

export interface ProductionModelComposition {
  readonly model: ModelPort;
  generateTitle?(
    request: RuntimeRequest,
    prompt: string,
    admission: ModelInvocationAdmissionPort,
  ): Promise<string>;
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

export function resolveConfiguredSecretRequirement(
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
    secretRequirement: resolveConfiguredSecretRequirement(configuration, descriptor.secretRef),
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
  const secretRequirement = resolveConfiguredSecretRequirement(configuration, descriptor.secretRef);
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
    ...(descriptor.reasoningRequired === undefined
      ? {}
      : { reasoningRequired: descriptor.reasoningRequired }),
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
  const configuredByRef = new Map(
    options.descriptors.map((descriptor) => [descriptor.ref, descriptor]),
  );
  const model = new TrustedModelProviderAdapter({
    ownerId: options.ownerId,
    agentId: options.agentId,
    descriptors: options.descriptors,
    handles: options.handles,
    secretSource: options.secretSource,
    transport,
    clock: options.clock,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    admissionCost: (descriptor: ModelDescriptor) => {
      const configured = configuredByRef.get(descriptor.ref);
      if (
        configured === undefined ||
        configured.provider !== descriptor.provider ||
        configured.model !== descriptor.model ||
        configured.version !== descriptor.version
      ) {
        throw new Error("MODEL_DESCRIPTOR_BINDING_MISMATCH");
      }
      return admissionCostForConfiguredPiModel(configured);
    },
  });
  return Object.freeze({
    model,
    piModels,
    transport,
    payloadBoundary,
    generateTitle: async (
      request: RuntimeRequest,
      prompt: string,
      gate: ModelInvocationAdmissionPort,
    ) => {
      const descriptor = options.descriptors.find((item) => item.ref === request.modelRef);
      if (!descriptor?.allowedDataClassifications.includes(request.dataClassification))
        throw new Error("THREAD_TITLE_DISCLOSURE_DENIED");
      const invocationId = `thread-title:${request.runId}`;
      const inputRef = await payloadBoundary.writeText({
        invocationId,
        sequence: 0,
        dataClassification: request.dataClassification,
        content: prompt,
        occurredAt: options.clock.now(),
      });
      const titleTransport = new PiModelTransport({
        models: piModels,
        payloads: payloadBoundary,
        clock: options.clock,
        // Required reasoning shares the output allowance with the visible title.
        maxOutputTokens: Math.min(descriptor.maxTokens, descriptor.reasoningRequired ? 1024 : 128),
        requestTimeoutMs: Math.min(options.requestTimeoutMs ?? 20000, 20000),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const titleModel = new TrustedModelProviderAdapter({
        ownerId: options.ownerId,
        agentId: options.agentId,
        descriptors: [descriptor],
        handles: options.handles,
        secretSource: options.secretSource,
        transport: titleTransport,
        clock: options.clock,
        admission: async () => gate,
        admissionCost: () => admissionCostForConfiguredPiModel(descriptor),
      });
      const handle = descriptor.secretRequirement
        ? await options.handles.issueHandle({
            ownerId: options.ownerId,
            agentId: options.agentId,
            runId: request.runId,
            ...descriptor.secretRequirement,
            scopeRef: invocationId,
            expiresAt: new Date(Date.parse(options.clock.now()) + 30000).toISOString(),
          })
        : undefined;
      let output = "";
      let completed = false;
      try {
        for await (const event of titleModel.invoke({
          invocationId,
          runId: request.runId,
          modelRef: request.modelRef,
          inputRef,
          dataClassification: request.dataClassification,
          allowedDisclosureRef: request.systemInstructionRef,
          secretHandleRefs: handle ? [handle.ref] : [],
          correlationId: request.correlationId,
        })) {
          if (event.type === "model.output")
            output += await payloadBoundary.readText(event.payloadRef);
          if (event.type === "model.completed") completed = true;
          if (event.type === "model.failed") throw new Error(event.errorCode);
        }
        if (!completed) throw new Error("THREAD_TITLE_RESPONSE_INCOMPLETE");
        return output;
      } finally {
        if (handle) await options.handles.revokeHandle(handle.ref, options.clock.now());
      }
    },
    close: () => piModels.close(),
  });
}
