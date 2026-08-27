import type {
  ClockPort,
  IdGeneratorPort,
  ModelPort,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadStorePort,
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
