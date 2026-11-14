import type {
  ModelEgress,
  ClockPort,
  ConfiguredCompletionsGenerationModelDescriptor,
  ConfiguredEmbeddingModelDescriptor,
  ConfiguredTypeSafeGenerationModelDescriptor,
  IdGeneratorPort,
  ModelCostDescriptor,
  ModelDescriptor,
  ModelInvocationAdmissionPort,
  ModelInvocationAdmissionResolver,
  ModelPort,
  ModelSecretRequirement,
  ModelUsagePurpose,
  ModelUsageStorePort,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadStorePort,
  ProactiveModelInvoker,
  ProductConfiguration,
  RuntimeRequest,
  SecretPort,
} from "@himawari-agent/application";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
  type TrustedModelAdmissionResolver,
  TrustedModelProviderAdapter,
  type TrustedModelTransport,
  TypeSafeJevTransport,
} from "@himawari-agent/platform-node";
import {
  admissionCostForConfiguredPiModel,
  ConfiguredPiModelBindingPort,
  type ConfiguredPiModelDescriptor,
  type PiModelBindingPort,
  type PiModelRuntimeFactory,
  PiModelTransport,
  type PiModelTransportOptions,
  ProtectedPiModelPayloadBoundary,
} from "@himawari-agent/runtime-pi";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];
type RunId = RuntimeRequest["runId"];

const UNMETERED_PERMIT = Object.freeze({
  assertActive: async () => undefined,
  markStarted: async () => undefined,
  releaseReserved: async () => undefined,
  settle: async () => undefined,
  markUnknown: async () => undefined,
});

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
  readonly generation: readonly ProductionGenerationDescriptor[];
  readonly embedding: ProductionEmbeddingModelDescriptor;
}

export type ProductionGenerationDescriptor =
  | ConfiguredPiModelDescriptor
  | ProductionTypeSafeDescriptor;

export interface ProductionTypeSafeDescriptor extends ModelDescriptor {
  readonly provider: string;
  readonly routingClass: "specialist";
  readonly secretRequirement: ModelSecretRequirement;
  readonly name: string;
  readonly api: "typesafe-systemone";
  readonly modelVersion?: string;
  readonly cost: ModelCostDescriptor;
}

export interface ProductionModelCompositionOptions {
  readonly egress: ModelEgress;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly descriptors: readonly ProductionGenerationDescriptor[];
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
  readonly admission?: ModelInvocationAdmissionResolver;
  readonly usage?: ModelUsageRecording;
  readonly egressThreadOf?: PiModelTransportOptions["egressThreadOf"];
}

export interface ModelUsageRecording {
  readonly store: ModelUsageStorePort;
  readonly onFailure: (error: unknown) => void;
}

export interface ProductionModelComposition {
  readonly model: ModelPort;
  generateTitle?(
    request: RuntimeRequest,
    prompt: string,
    admission: ModelInvocationAdmissionPort,
  ): Promise<string>;
  generateText?(
    request: RuntimeRequest,
    prompt: string,
    admission: ModelInvocationAdmissionPort,
    options: AuxiliaryTextOptions,
  ): Promise<string>;
  proactiveModel(
    modelRef: string,
    limits: {
      readonly maxOutputTokens: number;
      readonly requestTimeoutMs: number;
      readonly purpose?: ModelUsagePurpose;
    },
  ): ProactiveModelInvoker;
  readonly piModels: PiModelBindingPort;
  readonly transport: PiModelTransport;
  readonly payloadBoundary: ProtectedPiModelPayloadBoundary;
  close(): Promise<void>;
}

export interface AuxiliaryTextOptions {
  readonly purpose: ModelUsagePurpose;
  readonly invocationId: string;
  readonly maxOutputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly errorPrefix: string;
  readonly disableThinking?: boolean;
  readonly retryToolCall?: boolean;
}

export interface ProductionModelCompositionFromConfigurationOptions
  extends Omit<ProductionModelCompositionOptions, "descriptors"> {
  readonly configuration: ProductConfiguration;
}

export interface ProductionConfiguredModelComposition {
  readonly descriptors: ProductionModelDescriptorSet;
  readonly composition: ProductionModelComposition;
  readonly handles: SecretPort;
  readonly secretSource: HostProviderSecretSource;
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
  descriptor: ConfiguredCompletionsGenerationModelDescriptor,
): ConfiguredPiModelDescriptor {
  const provider = descriptor.provider;
  if (provider !== "vercel-ai-gateway" && provider !== "magpie") {
    throw new Error("MODEL_PI_PROVIDER_UNSUPPORTED");
  }
  const secretRequirement = resolveConfiguredSecretRequirement(configuration, descriptor.secretRef);
  if (secretRequirement === null) throw new Error("MODEL_PI_SECRET_REQUIRED");
  if (provider === "vercel-ai-gateway" && descriptor.providerRouting === undefined)
    throw new Error("MODEL_PI_ROUTING_REQUIRED");
  if (provider === "magpie" && descriptor.baseUrl === undefined)
    throw new Error("MODEL_PI_BASE_URL_REQUIRED");
  return Object.freeze({
    ref: descriptor.ref,
    provider,
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
      : {
          providerRouting: Object.freeze({
            order: Object.freeze([...descriptor.providerRouting.order]),
            sort: descriptor.providerRouting.sort,
          }),
        }),
    ...(descriptor.baseUrl === undefined ? {} : { baseUrl: descriptor.baseUrl }),
    name: descriptor.name,
    api: descriptor.api,
    reasoning: descriptor.reasoning,
    ...(descriptor.reasoningRequired === undefined
      ? {}
      : { reasoningRequired: descriptor.reasoningRequired }),
    ...(descriptor.thinkingLevels === undefined
      ? {}
      : { thinkingLevels: Object.freeze([...descriptor.thinkingLevels]) }),
    input: Object.freeze([...descriptor.input]),
    cost: Object.freeze({ ...descriptor.cost }),
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
  });
}

function typeSafeGenerationDescriptor(
  configuration: ProductConfiguration,
  descriptor: ConfiguredTypeSafeGenerationModelDescriptor,
): ProductionTypeSafeDescriptor {
  const secretRequirement = resolveConfiguredSecretRequirement(configuration, descriptor.secretRef);
  if (secretRequirement === null) throw new Error("MODEL_TYPESAFE_SECRET_REQUIRED");
  return Object.freeze({
    ref: descriptor.ref,
    provider: descriptor.provider,
    model: descriptor.model,
    version: descriptor.modelVersion ?? descriptor.version,
    routingClass: descriptor.role,
    priority: descriptor.priority,
    disclosure: descriptor.disclosure,
    capabilities: Object.freeze([...descriptor.capabilities]),
    allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
    secretRequirement,
    name: descriptor.name,
    api: "typesafe-systemone",
    ...(descriptor.modelVersion === undefined ? {} : { modelVersion: descriptor.modelVersion }),
    cost: Object.freeze({ ...descriptor.cost }),
  });
}

export function resolveConfiguredModelDescriptorSet(
  configuration: ProductConfiguration,
): ProductionModelDescriptorSet {
  const primaries = configuration.modelDescriptors.filter(
    (descriptor): descriptor is ConfiguredCompletionsGenerationModelDescriptor =>
      descriptor.role === "primary",
  );
  const primary = primaries[0];
  const embedding = configuration.modelDescriptors.find(
    (descriptor): descriptor is ConfiguredEmbeddingModelDescriptor =>
      descriptor.role === "embedding",
  );
  if (!primary || !embedding) throw new Error("MODEL_DESCRIPTOR_SET_INCOMPLETE");
  if (embedding.role !== "embedding") throw new Error("MODEL_DESCRIPTOR_SET_INCOMPLETE");
  if (configuration.memory.dimensions !== embedding.dimensions) {
    throw new Error("MODEL_EMBEDDING_DIMENSIONS_MISMATCH");
  }
  if (primary.api !== "openai-completions") {
    throw new Error("MODEL_PI_PROVIDER_UNSUPPORTED");
  }
  const specialist = configuration.modelDescriptors.find(
    (descriptor): descriptor is ConfiguredTypeSafeGenerationModelDescriptor =>
      descriptor.role === "specialist",
  );
  return Object.freeze({
    generation: Object.freeze([
      piGenerationDescriptor(configuration, primary),
      ...primaries.slice(1).map((descriptor) => piGenerationDescriptor(configuration, descriptor)),
      ...(specialist ? [typeSafeGenerationDescriptor(configuration, specialist)] : []),
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
  return Object.freeze({
    descriptors,
    composition,
    handles: options.handles,
    secretSource: options.secretSource,
  });
}

function modelTransportFor(
  options: ProductionModelCompositionOptions,
  payloadBoundary: ProtectedPiModelPayloadBoundary,
): { readonly trusted: TrustedModelTransport; readonly pi: PiModelTransport } {
  const piOnly = options.descriptors.filter(
    (descriptor): descriptor is ConfiguredPiModelDescriptor =>
      descriptor.api === "openai-completions",
  );
  const piTransport = new PiModelTransport({
    egress: options.egress,
    egressContext: {
      ownerId: options.ownerId,
      agentId: options.agentId,
      threadId: null,
      source: "background",
      purpose: "action-review",
    },
    ...(options.egressThreadOf === undefined ? {} : { egressThreadOf: options.egressThreadOf }),
    models: new ConfiguredPiModelBindingPort({
      descriptors: piOnly,
      secretSource: options.secretSource,
      ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
    }),
    payloads: payloadBoundary,
    clock: options.clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  });
  const configuredByRef = new Map(
    options.descriptors.map((descriptor) => [descriptor.ref, descriptor]),
  );
  const typeSafeTransport = new TypeSafeJevTransport({
    secrets: options.secretSource,
    payloads: payloadBoundary,
    clock: options.clock,
    pricingFor: (descriptor) => {
      const configured = configuredByRef.get(descriptor.ref);
      if (
        configured?.api !== "typesafe-systemone" ||
        configured.provider !== descriptor.provider ||
        configured.model !== descriptor.model ||
        configured.version !== descriptor.version
      )
        throw new Error("MODEL_DESCRIPTOR_BINDING_MISMATCH");
      return configured.cost;
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return {
    pi: piTransport,
    trusted: {
      invoke: (input) => {
        const configured = configuredByRef.get(input.descriptor.ref);
        if (!configured) throw new Error("MODEL_DESCRIPTOR_BINDING_MISMATCH");
        return configured.api === "typesafe-systemone"
          ? typeSafeTransport.invoke(input)
          : piTransport.invoke(input);
      },
    },
  };
}

export function createProductionModelComposition(
  options: ProductionModelCompositionOptions,
): ProductionModelComposition {
  assertProductionSecretSource(options.secretSource);
  const piModels = new ConfiguredPiModelBindingPort({
    descriptors: options.descriptors.filter(
      (descriptor): descriptor is ConfiguredPiModelDescriptor =>
        descriptor.api === "openai-completions",
    ),
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
  const transport = modelTransportFor(options, payloadBoundary);
  const configuredByRef = new Map(
    options.descriptors.map((descriptor) => [descriptor.ref, descriptor]),
  );
  const model = new TrustedModelProviderAdapter({
    ownerId: options.ownerId,
    agentId: options.agentId,
    descriptors: options.descriptors,
    handles: options.handles,
    secretSource: options.secretSource,
    transport: transport.trusted,
    clock: options.clock,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.usage === undefined
      ? {}
      : { usage: { purpose: "action-review" as const, ...options.usage } }),
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
      return configured.api === "typesafe-systemone"
        ? TypeSafeJevTransport.estimatedAdmissionCost(configured)
        : admissionCostForConfiguredPiModel(configured);
    },
  });
  const thinkingDisabledFor = (
    descriptor: ConfiguredPiModelDescriptor,
    text: Pick<AuxiliaryTextOptions, "disableThinking">,
  ): boolean => text.disableThinking === true && descriptor.provider === "magpie";
  const auxiliaryModelFor = (
    descriptor: ConfiguredPiModelDescriptor,
    text: Pick<
      AuxiliaryTextOptions,
      | "purpose"
      | "maxOutputTokens"
      | "reasoningOutputTokens"
      | "requestTimeoutMs"
      | "disableThinking"
    >,
    admission: TrustedModelAdmissionResolver,
    threadId: RuntimeRequest["threadId"] = null,
  ): TrustedModelProviderAdapter =>
    new TrustedModelProviderAdapter({
      ownerId: options.ownerId,
      agentId: options.agentId,
      descriptors: [descriptor],
      handles: options.handles,
      secretSource: options.secretSource,
      transport: new PiModelTransport({
        egress: options.egress,
        egressContext: {
          ownerId: options.ownerId,
          agentId: options.agentId,
          threadId,
          source: "background",
          purpose: text.purpose,
        },
        models: piModels,
        payloads: payloadBoundary,
        clock: options.clock,
        maxOutputTokens: Math.min(
          descriptor.maxTokens,
          descriptor.reasoning && !thinkingDisabledFor(descriptor, text)
            ? text.reasoningOutputTokens
            : text.maxOutputTokens,
        ),
        ...(thinkingDisabledFor(descriptor, text) ? { disableThinking: true } : {}),
        requestTimeoutMs: Math.min(
          options.requestTimeoutMs ?? text.requestTimeoutMs,
          text.requestTimeoutMs,
        ),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      clock: options.clock,
      admission,
      ...(options.usage === undefined
        ? {}
        : { usage: { purpose: text.purpose, ...options.usage } }),
      admissionCost: () => admissionCostForConfiguredPiModel(descriptor),
    });
  const proactiveModel = (
    modelRef: string,
    limits: {
      readonly maxOutputTokens: number;
      readonly requestTimeoutMs: number;
      readonly purpose?: ModelUsagePurpose;
    },
  ): ProactiveModelInvoker => {
    const descriptor = options.descriptors.find((item) => item.ref === modelRef);
    if (
      descriptor?.api !== "openai-completions" ||
      !descriptor.allowedDataClassifications.includes("private")
    )
      throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
    const model = auxiliaryModelFor(
      descriptor,
      {
        purpose: limits.purpose ?? "mail-judgment",
        maxOutputTokens: limits.maxOutputTokens,
        reasoningOutputTokens: limits.maxOutputTokens * 2,
        requestTimeoutMs: limits.requestTimeoutMs,
      },
      ({ runId }) => ({
        context: { ownerId: options.ownerId, agentId: options.agentId, runId },
        begin: async () => ({ disposition: "fresh" as const, permit: UNMETERED_PERMIT }),
      }),
    );
    return Object.freeze<ProactiveModelInvoker>({
      model,
      modelRef,
      allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
      async prepare({ invocationId, prompt, deadlineAt, dataClassification }) {
        if (!descriptor.allowedDataClassifications.includes(dataClassification))
          throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
        const runId = `proactive:${invocationId}` as RunId;
        const inputRef = await payloadBoundary.writeText({
          invocationId,
          sequence: 0,
          dataClassification,
          content: prompt,
          occurredAt: options.clock.now(),
        });
        let handle: Awaited<ReturnType<typeof options.handles.issueHandle>> | undefined;
        try {
          handle = descriptor.secretRequirement
            ? await options.handles.issueHandle({
                ownerId: options.ownerId,
                agentId: options.agentId,
                runId,
                ...descriptor.secretRequirement,
                scopeRef: invocationId,
                expiresAt: deadlineAt,
              })
            : undefined;
        } catch (error) {
          await payloadBoundary.release([inputRef]).catch(() => undefined);
          throw error;
        }
        return Object.freeze({
          runId,
          inputRef,
          allowedDisclosureRef: inputRef,
          secretHandleRefs: handle ? [handle.ref] : [],
          release: async () => {
            if (handle) await options.handles.revokeHandle(handle.ref, options.clock.now());
          },
        });
      },
      readOutput: (payloadRef) => payloadBoundary.readText(payloadRef),
      release: (payloadRefs) => payloadBoundary.release(payloadRefs),
    });
  };
  const generateTextOnce = async (
    request: RuntimeRequest,
    prompt: string,
    gate: ModelInvocationAdmissionPort,
    text: AuxiliaryTextOptions,
  ): Promise<string> => {
    const descriptor = options.descriptors.find((item) => item.ref === request.modelRef);
    if (
      descriptor?.api !== "openai-completions" ||
      !descriptor.allowedDataClassifications.includes(request.dataClassification)
    )
      throw new Error(`${text.errorPrefix}_DISCLOSURE_DENIED`);
    const invocationId = text.invocationId;
    const inputRef = await payloadBoundary.writeText({
      invocationId,
      sequence: 0,
      dataClassification: request.dataClassification,
      content: prompt,
      occurredAt: options.clock.now(),
    });
    const leftBehind = [inputRef];
    let handle: Awaited<ReturnType<typeof options.handles.issueHandle>> | undefined;
    let output = "";
    let completed = false;
    try {
      const auxiliaryModel = auxiliaryModelFor(
        descriptor,
        text,
        async () => gate,
        request.threadId,
      );
      handle = descriptor.secretRequirement
        ? await options.handles.issueHandle({
            ownerId: options.ownerId,
            agentId: options.agentId,
            runId: request.runId,
            ...descriptor.secretRequirement,
            scopeRef: invocationId,
            expiresAt: new Date(
              Date.parse(options.clock.now()) + text.requestTimeoutMs + 10000,
            ).toISOString(),
          })
        : undefined;
      for await (const event of auxiliaryModel.invoke({
        invocationId,
        runId: request.runId,
        modelRef: request.modelRef,
        inputRef,
        dataClassification: request.dataClassification,
        allowedDisclosureRef: request.systemInstructionRef,
        secretHandleRefs: handle ? [handle.ref] : [],
        correlationId: request.correlationId,
      })) {
        if (event.type === "model.output") {
          leftBehind.push(event.payloadRef);
          output += await payloadBoundary.readText(event.payloadRef);
        }
        if (event.type === "model.completed") completed = true;
        if (event.type === "model.failed") throw new Error(event.errorCode);
      }
      if (!completed) throw new Error(`${text.errorPrefix}_RESPONSE_INCOMPLETE`);
      return output;
    } finally {
      if (handle) await options.handles.revokeHandle(handle.ref, options.clock.now());
      await payloadBoundary.release(leftBehind).catch(() => undefined);
    }
  };

  const generateText = async (
    request: RuntimeRequest,
    prompt: string,
    gate: ModelInvocationAdmissionPort,
    text: AuxiliaryTextOptions,
  ): Promise<string> => {
    try {
      return await generateTextOnce(request, prompt, gate, text);
    } catch (error) {
      if (
        text.retryToolCall === false ||
        !(error instanceof Error) ||
        error.message !== "AI_GATEWAY_TOOL_CALL_UNSUPPORTED"
      )
        throw error;
      return generateTextOnce(request, prompt, gate, {
        ...text,
        invocationId: `${text.invocationId}:retry`,
      });
    }
  };

  return Object.freeze({
    model,
    piModels,
    transport: transport.pi,
    payloadBoundary,
    generateTitle: (request: RuntimeRequest, prompt: string, gate: ModelInvocationAdmissionPort) =>
      generateText(request, prompt, gate, {
        purpose: "thread-title",
        invocationId: `thread-title:${request.runId}`,
        maxOutputTokens: 128,
        disableThinking: true,
        reasoningOutputTokens: 1024,
        requestTimeoutMs: 20000,
        errorPrefix: "THREAD_TITLE",
      }),
    generateText,
    proactiveModel,
    close: () => piModels.close(),
  });
}
