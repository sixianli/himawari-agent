import type {
  ClockPort,
  IdGeneratorPort,
  ModelDescriptor,
  ModelPort,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadStorePort,
  SecretPort,
} from "@himawari-agent/application";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
  OpenRouterModelTransport,
  ProtectedOpenRouterPayloadBoundary,
  TrustedModelProviderAdapter,
} from "@himawari-agent/platform-node";
import {
  ConfiguredPiModelBindingPort,
  type PiConfiguredModelDescriptor,
  type PiModelBindingPort,
  type PiModelRuntimeFactory,
} from "@himawari-agent/runtime-pi";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];

export interface ProductionModelDescriptorBinding {
  readonly model: ModelDescriptor;
  readonly pi: PiConfiguredModelDescriptor;
}

export interface ProductionModelCompositionOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly descriptors: readonly ProductionModelDescriptorBinding[];
  readonly handles: SecretPort;
  readonly secretSource: HostProviderSecretSource;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  readonly runtimeFactory?: PiModelRuntimeFactory;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly temperature?: number;
  readonly siteUrl?: string;
  readonly appName?: string;
}

export interface ProductionModelComposition {
  readonly model: ModelPort;
  readonly piModels: PiModelBindingPort;
  readonly transport: OpenRouterModelTransport;
  readonly payloadBoundary: ProtectedOpenRouterPayloadBoundary;
  close(): Promise<void>;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function assertDescriptorPair(binding: ProductionModelDescriptorBinding, index: number): void {
  const model = binding.model;
  const pi = binding.pi;
  const field = `descriptors[${index}]`;
  const expectedRole = model.routingClass === "primary" ? "primary" : "fallback";
  const secret = model.secretRequirement;
  if (
    model.provider !== "openrouter" ||
    pi.provider !== "openrouter" ||
    model.ref !== pi.ref ||
    model.model !== pi.model ||
    model.version !== pi.version ||
    model.disclosure !== pi.disclosure ||
    !sameValues(model.capabilities, pi.capabilities) ||
    !sameValues(model.allowedDataClassifications, pi.allowedDataClassifications) ||
    model.routingClass !== pi.role ||
    pi.role !== expectedRole ||
    secret === null ||
    secret.secretRef !== pi.secretRef ||
    secret.secretVersion !== pi.secretVersion ||
    secret.purpose !== pi.secretPurpose ||
    !sameJson(model.providerRouting, pi.providerRouting)
  ) {
    throw new TypeError(`${field} model and Pi descriptors do not describe the same binding`);
  }
}

function assertModelSet(descriptors: readonly ProductionModelDescriptorBinding[]): void {
  if (descriptors.length !== 2) {
    throw new TypeError("PRODUCTION_MODEL_COMPOSITION_REQUIRES_PRIMARY_AND_FALLBACK");
  }
  descriptors.forEach(assertDescriptorPair);
  if (descriptors.filter(({ model }) => model.routingClass === "primary").length !== 1) {
    throw new TypeError("PRODUCTION_MODEL_COMPOSITION_REQUIRES_ONE_PRIMARY");
  }
  if (descriptors.filter(({ model }) => model.routingClass === "fallback").length !== 1) {
    throw new TypeError("PRODUCTION_MODEL_COMPOSITION_REQUIRES_ONE_FALLBACK");
  }
  if (new Set(descriptors.map(({ model }) => model.ref)).size !== descriptors.length) {
    throw new TypeError("PRODUCTION_MODEL_COMPOSITION_REQUIRES_UNIQUE_REFS");
  }
}

export function createProductionModelComposition(
  options: ProductionModelCompositionOptions,
): ProductionModelComposition {
  assertProductionSecretSource(options.secretSource);
  assertModelSet(options.descriptors);
  const modelDescriptors = Object.freeze(options.descriptors.map(({ model }) => model));
  const piDescriptors = Object.freeze(options.descriptors.map(({ pi }) => pi));
  const payloadBoundary = new ProtectedOpenRouterPayloadBoundary({
    ownerId: options.ownerId,
    agentId: options.agentId,
    payloads: options.payloads,
    protector: options.protector,
    ids: options.ids,
    clock: options.clock,
  });
  const transport = new OpenRouterModelTransport({
    payloads: payloadBoundary,
    clock: options.clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
    ...(options.appName === undefined ? {} : { appName: options.appName }),
  });
  const model = new TrustedModelProviderAdapter({
    descriptors: modelDescriptors,
    handles: options.handles,
    secretSource: options.secretSource,
    transport,
    clock: options.clock,
  });
  const piModels = new ConfiguredPiModelBindingPort({
    descriptors: piDescriptors,
    secretSource: options.secretSource,
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
  });
  return Object.freeze({
    model,
    piModels,
    transport,
    payloadBoundary,
    close: () => piModels.close(),
  });
}
