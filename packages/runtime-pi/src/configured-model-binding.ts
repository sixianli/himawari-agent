import {
  type Api,
  type ApiKeyAuth,
  createProvider,
  InMemoryCredentialStore,
  type Model,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { CreateModelRuntimeOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelDescriptor,
  ModelInvocationPricing,
  ModelProviderRouting,
  ModelSecretRequirement,
} from "@himawari-agent/application/runtime-port";
import type { PiModelBinding, PiModelBindingPort } from "./pi-runtime-adapter.js";

const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

const MODEL_THINKING_LEVEL_MAPS: Readonly<Record<string, ThinkingLevelMap>> = Object.freeze({
  "deepseek/deepseek-v4.1-flash": Object.freeze({
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    max: "max",
  }),
});

function advertisedThinkingLevelMap(levels: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const)
    map[level] = levels.includes(level) ? level : null;
  return map;
}

function thinkingLevelMap(descriptor: ConfiguredPiModelDescriptor): ThinkingLevelMap | undefined {
  if (!descriptor.reasoning) return undefined;
  const map: ThinkingLevelMap = {
    ...MODEL_THINKING_LEVEL_MAPS[descriptor.model],
    ...(descriptor.thinkingLevels === undefined
      ? {}
      : advertisedThinkingLevelMap(descriptor.thinkingLevels)),
    ...(descriptor.reasoningRequired ? { off: null } : {}),
  };
  return Object.keys(map).length === 0 ? undefined : map;
}

export interface PiModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PiModelAdmissionCost {
  readonly pricing: ModelInvocationPricing;
  readonly estimatedCostMicros: number;
}

export type ConfiguredPiModelProvider = "vercel-ai-gateway" | "magpie";

export interface ConfiguredPiModelDescriptor extends ModelDescriptor {
  readonly provider: ConfiguredPiModelProvider;
  readonly routingClass: "primary";
  readonly secretRequirement: ModelSecretRequirement;
  readonly providerRouting?: ModelProviderRouting;
  readonly name: string;
  readonly api: "openai-completions";
  readonly baseUrl?: string;
  readonly reasoning: boolean;
  readonly reasoningRequired?: boolean;
  readonly thinkingLevels?: readonly string[];
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
      "Pi AI Gateway base URL must be an absolute HTTP(S) URL without credentials",
    );
  }
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new TypeError("Pi AI Gateway HTTP base URL must be loopback-only");
  }
}

function assertMagpieBaseUrl(value: string, field: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new TypeError(`${field} must be a loopback HTTP URL`);
  }
}

function freezeRouting(routing: ModelProviderRouting | undefined): ModelProviderRouting {
  if (
    routing === undefined ||
    !Array.isArray(routing.order) ||
    routing.order.length === 0 ||
    routing.order.some(
      (provider) => typeof provider !== "string" || provider.trim().length === 0,
    ) ||
    new Set(routing.order).size !== routing.order.length
  ) {
    throw new TypeError("providerRouting.order must contain unique non-empty provider names");
  }
  if (
    routing.sort !== "cost" ||
    Object.keys(routing).some((key) => key !== "order" && key !== "sort")
  ) {
    throw new TypeError("providerRouting must contain only order and sort: cost");
  }
  return Object.freeze({ order: Object.freeze([...routing.order]), sort: "cost" });
}

function freezeDescriptor(descriptor: ConfiguredPiModelDescriptor): ConfiguredPiModelDescriptor {
  const frozen = {
    ...descriptor,
    input: Object.freeze([...descriptor.input]),
    cost: Object.freeze({ ...descriptor.cost }),
    capabilities: Object.freeze([...descriptor.capabilities]),
    secretRequirement: Object.freeze({ ...descriptor.secretRequirement }),
  };
  if (descriptor.provider === "magpie") {
    if (descriptor.providerRouting !== undefined) {
      throw new TypeError("providerRouting is only supported for vercel-ai-gateway");
    }
    return Object.freeze(frozen);
  }
  return Object.freeze({ ...frozen, providerRouting: freezeRouting(descriptor.providerRouting) });
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
  if (
    descriptor.reasoningRequired !== undefined &&
    (typeof descriptor.reasoningRequired !== "boolean" ||
      (descriptor.reasoningRequired && !descriptor.reasoning))
  ) {
    throw new TypeError(`${field}.reasoningRequired requires reasoning capability`);
  }
  if (descriptor.provider === "vercel-ai-gateway") {
    if (descriptor.model !== "deepseek/deepseek-v4.1-flash")
      throw new TypeError(`${field}.model is unsupported`);
  } else if (descriptor.provider === "magpie") {
    if (descriptor.baseUrl === undefined) throw new TypeError(`${field}.baseUrl is required`);
    assertMagpieBaseUrl(descriptor.baseUrl, `${field}.baseUrl`);
  } else {
    throw new TypeError(`${field}.provider is unsupported`);
  }
  if (descriptor.routingClass !== "primary")
    throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
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
  assertPositiveInteger(descriptor.priority, `${field}.priority`);
  assertPositiveInteger(descriptor.contextWindow, `${field}.contextWindow`);
  assertPositiveInteger(descriptor.maxTokens, `${field}.maxTokens`);
  if (descriptor.maxTokens > 32768) throw new TypeError(`${field}.maxTokens must not exceed 32768`);
  for (const [name, value] of Object.entries(descriptor.cost)) {
    assertNonNegativeFinite(value, `${field}.cost.${name}`);
  }
  if (descriptor.baseUrl !== undefined) assertBaseUrl(descriptor.baseUrl);
}

export function admissionCostForConfiguredPiModel(
  descriptor: ConfiguredPiModelDescriptor,
): PiModelAdmissionCost {
  const estimatedCostMicros = Math.ceil(
    descriptor.contextWindow *
      Math.max(descriptor.cost.input, descriptor.cost.cacheRead, descriptor.cost.cacheWrite) +
      descriptor.maxTokens * descriptor.cost.output,
  );
  if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) {
    throw new TypeError("PI_MODEL_ADMISSION_ESTIMATE_UNSAFE");
  }
  return Object.freeze({
    pricing: Object.freeze({ ...descriptor.cost }),
    estimatedCostMicros,
  });
}

const HOST_SECRET_SOURCE = "himawari-host-secret";

function hostSecretAuth(): ApiKeyAuth {
  return {
    name: "Himawari host-managed model key",
    check: async () => ({ type: "api_key", source: HOST_SECRET_SOURCE }),
    resolve: async ({ credential }) => {
      const key = credential?.type === "api_key" ? credential.key : undefined;
      return typeof key === "string" && key.length > 0
        ? { auth: { apiKey: key }, source: HOST_SECRET_SOURCE }
        : undefined;
    },
  };
}

function providerModel(
  descriptor: ConfiguredPiModelDescriptor,
  baseUrl: string,
): Model<"openai-completions"> {
  const levelMap = thinkingLevelMap(descriptor);
  return {
    id: descriptor.model,
    name: descriptor.name,
    api: descriptor.api,
    provider: descriptor.provider,
    baseUrl,
    reasoning: descriptor.reasoning,
    ...(levelMap === undefined ? {} : { thinkingLevelMap: levelMap }),
    input: [...descriptor.input],
    cost: { ...descriptor.cost },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    compat: {
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
      supportsStrictMode: descriptor.capabilities.includes("structured_outputs"),
      ...(descriptor.reasoning && descriptor.provider === "vercel-ai-gateway"
        ? { thinkingFormat: "openrouter" as const }
        : {}),
      ...(descriptor.provider === "magpie" ? { sendSessionAffinityHeaders: true } : {}),
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
    const [first] = options.descriptors;
    if (
      first === undefined ||
      options.descriptors.some(
        (descriptor) =>
          descriptor.provider !== first.provider ||
          descriptor.baseUrl !== first.baseUrl ||
          (descriptor.provider !== "magpie" && descriptor !== first),
      ) ||
      new Set(options.descriptors.map(({ ref }) => ref)).size !== options.descriptors.length
    ) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
    }
    const descriptors = options.descriptors.map(freezeDescriptor);
    descriptors.forEach(validateDescriptor);
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
    const secretRequirement = descriptor.secretRequirement;
    return {
      model: model as Model<Api>,
      modelRuntime: runtime,
      descriptor,
      admissionCost: admissionCostForConfiguredPiModel(descriptor),
      resolveSecret: async () => {
        const secret = await this.#secretSource.resolve(
          secretRequirement.secretRef,
          secretRequirement.secretVersion,
        );
        if (typeof secret !== "string" || secret.trim().length === 0) {
          throw new Error("PI_PROVIDER_SECRET_UNAVAILABLE");
        }
        return secret;
      },
    };
  }

  async close(): Promise<void> {
    await this.#initialization?.catch(() => undefined);
    this.#runtime = undefined;
    this.#initialization = undefined;
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
    const baseUrl = first.baseUrl ?? AI_GATEWAY_BASE_URL;
    const runtime = await this.#runtimeFactory.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    try {
      const hostAuth = hostSecretAuth();
      runtime.registerNativeProvider(
        createProvider({
          id: first.provider,
          name: first.provider === "magpie" ? "Himawari Magpie" : "Himawari AI Gateway",
          baseUrl,
          auth: { apiKey: hostAuth },
          models: this.#descriptors.map((descriptor) => providerModel(descriptor, baseUrl)),
          api: openAICompletionsApi(),
        }),
      );
      await runtime.refresh({ allowNetwork: false });
      for (const descriptor of this.#descriptors) {
        if (runtime.getModel(descriptor.provider, descriptor.model) === undefined) {
          throw new Error("PI_MODEL_NOT_REGISTERED");
        }
      }
    } catch {
      throw new Error("PI_MODEL_RUNTIME_CONFIGURATION_FAILED");
    }
    return runtime;
  }
}
