import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import type {
  CreateModelRuntimeOptions,
  ModelRuntime,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelDescriptor,
  ModelProviderRouting,
  ModelSecretRequirement,
} from "@himawari-agent/application/runtime-port";
import type { PiModelBinding, PiModelBindingPort } from "./pi-runtime-adapter.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface PiModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * The single product-owned descriptor for a model that is executable through
 * Pi. Product policy fields and Pi runtime fields live on one immutable
 * identity so no paired descriptor can drift.
 */
export interface ConfiguredPiModelDescriptor extends ModelDescriptor {
  readonly provider: "openrouter";
  readonly routingClass: "primary" | "fallback";
  readonly secretRequirement: ModelSecretRequirement;
  readonly name: string;
  readonly api: "openai-completions";
  readonly baseUrl?: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly cost: PiModelCost;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface PiProviderSecretSource {
  readonly productionSuitable: boolean;
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export type PiModelRuntime = ModelRuntime;

export interface PiModelRuntimeFactory {
  create(options: CreateModelRuntimeOptions): Promise<ModelRuntime>;
}

export interface ConfiguredPiModelBindingPortOptions {
  readonly descriptors: readonly ConfiguredPiModelDescriptor[];
  readonly secretSource: PiProviderSecretSource;
  readonly runtimeFactory?: PiModelRuntimeFactory;
}

async function defaultRuntimeFactory(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const piSdk: typeof import("@earendil-works/pi-coding-agent") = await import(
    "@earendil-works/pi-coding-agent"
  );
  return piSdk.ModelRuntime.create(options);
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
}

function assertBaseUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
    throw new TypeError(
      "Pi OpenRouter base URL must be an absolute HTTP(S) URL without credentials",
    );
  }
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new TypeError("Pi OpenRouter HTTP base URL must be loopback-only");
  }
}

function freezeRouting(
  routing: ModelProviderRouting | undefined,
): ModelProviderRouting | undefined {
  if (routing === undefined) return undefined;
  if (routing.order !== undefined) {
    if (
      routing.order.length === 0 ||
      routing.order.some(
        (provider) => typeof provider !== "string" || provider.trim().length === 0,
      ) ||
      new Set(routing.order).size !== routing.order.length
    ) {
      throw new TypeError("providerRouting.order must contain unique non-empty provider names");
    }
  }
  if (
    routing.data_collection !== undefined &&
    routing.data_collection !== "allow" &&
    routing.data_collection !== "deny"
  ) {
    throw new TypeError("providerRouting.data_collection is invalid");
  }
  return Object.freeze({
    ...(routing.order === undefined ? {} : { order: Object.freeze([...routing.order]) }),
    ...(routing.allow_fallbacks === undefined ? {} : { allow_fallbacks: routing.allow_fallbacks }),
    ...(routing.require_parameters === undefined
      ? {}
      : { require_parameters: routing.require_parameters }),
    ...(routing.data_collection === undefined ? {} : { data_collection: routing.data_collection }),
    ...(routing.zdr === undefined ? {} : { zdr: routing.zdr }),
  });
}

function freezeDescriptor(descriptor: ConfiguredPiModelDescriptor): ConfiguredPiModelDescriptor {
  const providerRouting = freezeRouting(descriptor.providerRouting);
  return Object.freeze({
    ...descriptor,
    input: Object.freeze([...descriptor.input]),
    cost: Object.freeze({ ...descriptor.cost }),
    capabilities: Object.freeze([...descriptor.capabilities]),
    allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
    secretRequirement: Object.freeze({ ...descriptor.secretRequirement }),
    ...(providerRouting === undefined ? {} : { providerRouting }),
  });
}

function validateDescriptor(descriptor: ConfiguredPiModelDescriptor, index: number): void {
  const field = `descriptors[${index}]`;
  for (const [name, value] of [
    ["ref", descriptor.ref],
    ["model", descriptor.model],
    ["version", descriptor.version],
    ["name", descriptor.name],
    ["secretRequirement.secretRef", descriptor.secretRequirement.secretRef],
    ["secretRequirement.secretVersion", descriptor.secretRequirement.secretVersion],
    ["secretRequirement.purpose", descriptor.secretRequirement.purpose],
  ] as const) {
    assertNonEmpty(value, `${field}.${name}`);
  }
  if (descriptor.provider !== "openrouter") throw new TypeError(`${field}.provider is unsupported`);
  if (descriptor.api !== "openai-completions") throw new TypeError(`${field}.api is unsupported`);
  if (descriptor.input.length === 0 || !descriptor.input.includes("text")) {
    throw new TypeError(`${field}.input must include text`);
  }
  if (new Set(descriptor.input).size !== descriptor.input.length) {
    throw new TypeError(`${field}.input must not contain duplicates`);
  }
  if (descriptor.capabilities.length === 0 || !descriptor.capabilities.includes("text")) {
    throw new TypeError(`${field}.capabilities must include text`);
  }
  if (
    descriptor.allowedDataClassifications.length === 0 ||
    new Set(descriptor.allowedDataClassifications).size !==
      descriptor.allowedDataClassifications.length
  ) {
    throw new TypeError(`${field}.allowedDataClassifications must be non-empty and unique`);
  }
  if (
    descriptor.routingClass === "fallback" &&
    (descriptor.allowedDataClassifications.length !== 1 ||
      descriptor.allowedDataClassifications[0] !== "private")
  ) {
    throw new TypeError(`${field}.allowedDataClassifications must be exactly private`);
  }
  assertPositiveInteger(descriptor.priority, `${field}.priority`);
  assertPositiveInteger(descriptor.contextWindow, `${field}.contextWindow`);
  assertPositiveInteger(descriptor.maxTokens, `${field}.maxTokens`);
  for (const [name, value] of Object.entries(descriptor.cost)) {
    assertNonNegativeFinite(value, `${field}.cost.${name}`);
  }
  if (descriptor.baseUrl !== undefined) assertBaseUrl(descriptor.baseUrl);
}

function providerModelConfig(
  descriptor: ConfiguredPiModelDescriptor,
  baseUrl: string,
): ProviderModelConfig {
  return {
    id: descriptor.model,
    name: descriptor.name,
    api: descriptor.api,
    baseUrl,
    reasoning: descriptor.reasoning,
    input: [...descriptor.input],
    cost: { ...descriptor.cost },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    compat: {
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
      supportsStrictMode: descriptor.capabilities.includes("structured_outputs"),
      ...(descriptor.reasoning ? { thinkingFormat: "openrouter" as const } : {}),
      ...(descriptor.providerRouting === undefined
        ? {}
        : { openRouterRouting: structuredClone(descriptor.providerRouting) }),
    },
  };
}

export class ConfiguredPiModelBindingPort implements PiModelBindingPort {
  readonly #descriptors: readonly ConfiguredPiModelDescriptor[];
  readonly #byRef: ReadonlyMap<string, ConfiguredPiModelDescriptor>;
  readonly #secretSource: PiProviderSecretSource;
  readonly #runtimeFactory: PiModelRuntimeFactory;
  #runtime: ModelRuntime | undefined;
  #initialization: Promise<ModelRuntime> | undefined;

  constructor(options: ConfiguredPiModelBindingPortOptions) {
    if (!options.secretSource.productionSuitable) {
      throw new TypeError("PI_UNSAFE_PROVIDER_SECRET_SOURCE");
    }
    if (options.descriptors.length !== 2) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_PRIMARY_AND_FALLBACK");
    }
    const descriptors = options.descriptors.map(freezeDescriptor);
    descriptors.forEach(validateDescriptor);
    if (descriptors.filter(({ routingClass }) => routingClass === "primary").length !== 1) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
    }
    if (descriptors.filter(({ routingClass }) => routingClass === "fallback").length !== 1) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_FALLBACK");
    }
    if (new Set(descriptors.map(({ ref }) => ref)).size !== descriptors.length) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_UNIQUE_REFS");
    }
    const first = descriptors[0];
    const provider = first?.provider;
    const baseUrl = first?.baseUrl ?? OPENROUTER_BASE_URL;
    const firstSecret = first?.secretRequirement;
    const secretIdentity = firstSecret
      ? `${firstSecret.secretRef}@${firstSecret.secretVersion}:${firstSecret.purpose}`
      : "";
    if (
      provider === undefined ||
      descriptors.some((descriptor) => descriptor.provider !== provider)
    ) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_PROVIDER");
    }
    if (descriptors.some((descriptor) => (descriptor.baseUrl ?? OPENROUTER_BASE_URL) !== baseUrl)) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_BASE_URL");
    }
    if (
      descriptors.some(
        ({ secretRequirement }) =>
          `${secretRequirement.secretRef}@${secretRequirement.secretVersion}:${secretRequirement.purpose}` !==
          secretIdentity,
      )
    ) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_SHARED_PROVIDER_SECRET");
    }
    this.#descriptors = Object.freeze(descriptors);
    this.#byRef = new Map(descriptors.map((descriptor) => [descriptor.ref, descriptor]));
    this.#secretSource = options.secretSource;
    this.#runtimeFactory = options.runtimeFactory ?? { create: defaultRuntimeFactory };
  }

  configuredDescriptors(): readonly ConfiguredPiModelDescriptor[] {
    return this.#descriptors.map((descriptor) => freezeDescriptor(descriptor));
  }

  async resolve(modelRef: string): Promise<PiModelBinding> {
    const descriptor = this.#byRef.get(modelRef);
    if (descriptor === undefined) throw new Error("PI_MODEL_REF_NOT_CONFIGURED");
    const runtime = await this.runtime();
    const model = runtime.getModel(descriptor.provider, descriptor.model);
    if (model === undefined) throw new Error("PI_MODEL_NOT_REGISTERED");
    return { model: model as Model<Api>, modelRuntime: runtime };
  }

  async close(): Promise<void> {
    await this.#initialization?.catch(() => undefined);
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#initialization = undefined;
    if (runtime !== undefined) {
      await runtime.removeRuntimeApiKey("openrouter").catch(() => undefined);
    }
  }

  private async runtime(): Promise<ModelRuntime> {
    if (this.#runtime !== undefined) return this.#runtime;
    if (this.#initialization !== undefined) return this.#initialization;
    const initialization = this.initializeRuntime();
    this.#initialization = initialization;
    try {
      this.#runtime = await initialization;
      return this.#runtime;
    } finally {
      if (this.#initialization === initialization) this.#initialization = undefined;
    }
  }

  private async initializeRuntime(): Promise<ModelRuntime> {
    const first = this.#descriptors[0];
    if (first === undefined) throw new Error("PI_MODEL_BINDING_EMPTY");
    const secretRequirement = first.secretRequirement;
    let secret: string;
    try {
      secret = await this.#secretSource.resolve(
        secretRequirement.secretRef,
        secretRequirement.secretVersion,
      );
    } catch {
      throw new Error("PI_PROVIDER_SECRET_UNAVAILABLE");
    }
    if (secret.trim().length === 0) throw new Error("PI_PROVIDER_SECRET_UNAVAILABLE");

    const baseUrl = first.baseUrl ?? OPENROUTER_BASE_URL;
    const runtime = await this.#runtimeFactory.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    try {
      runtime.registerProvider(first.provider, {
        name: "Himawari OpenRouter",
        baseUrl,
        api: first.api,
        authHeader: true,
        models: this.#descriptors.map((descriptor) => providerModelConfig(descriptor, baseUrl)),
      } satisfies ProviderConfig);
      await runtime.setRuntimeApiKey(first.provider, secret);
      for (const descriptor of this.#descriptors) {
        if (runtime.getModel(descriptor.provider, descriptor.model) === undefined) {
          throw new Error("PI_MODEL_NOT_REGISTERED");
        }
      }
    } catch {
      await runtime.removeRuntimeApiKey(first.provider).catch(() => undefined);
      throw new Error("PI_MODEL_RUNTIME_CONFIGURATION_FAILED");
    }
    return runtime;
  }
}
