import type { PiModelBinding, PiModelBindingPort } from "./pi-runtime-adapter.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface PiProviderRouting {
  readonly order?: readonly string[];
  readonly allow_fallbacks?: boolean;
  readonly require_parameters?: boolean;
  readonly data_collection?: "allow" | "deny";
  readonly zdr?: boolean;
}

export interface PiModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * Product-owned model metadata used to construct a closed Pi model runtime.
 * The version is an immutable release or catalog snapshot reference; it is not
 * used as a dynamic marketplace selector.
 */
export interface PiConfiguredModelDescriptor {
  readonly ref: string;
  readonly role: "primary" | "fallback";
  readonly provider: "openrouter";
  readonly model: string;
  readonly version: string;
  readonly name: string;
  readonly api: "openai-completions";
  readonly baseUrl?: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly cost: PiModelCost;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly capabilities: readonly string[];
  readonly disclosure: "local_only" | "trusted_remote" | "external_remote";
  readonly allowedDataClassifications: readonly (
    | "public"
    | "private"
    | "sensitive"
    | "restricted"
  )[];
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly secretPurpose: string;
  readonly providerRouting?: PiProviderRouting;
}

export interface PiProviderSecretSource {
  readonly productionSuitable: boolean;
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export interface PiModelRuntime {
  getModel(providerId: string, modelId: string): unknown | undefined;
  registerProvider(providerId: string, config: Readonly<Record<string, unknown>>): void;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey?(providerId: string): Promise<void>;
}

export interface PiModelRuntimeFactory {
  create(options: Readonly<Record<string, unknown>>): Promise<PiModelRuntime>;
}

export interface ConfiguredPiModelBindingPortOptions {
  readonly descriptors: readonly PiConfiguredModelDescriptor[];
  readonly secretSource: PiProviderSecretSource;
  readonly runtimeFactory?: PiModelRuntimeFactory;
}

interface PiSdk {
  readonly ModelRuntime: {
    create(options: Readonly<Record<string, unknown>>): Promise<PiModelRuntime>;
  };
}

type EphemeralCredential = { readonly type: "api_key"; readonly key: string };

class EphemeralCredentialStore {
  readonly #credentials = new Map<string, EphemeralCredential>();

  async read(providerId: string, options?: { readonly signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    const credential = this.#credentials.get(providerId);
    return credential === undefined ? undefined : { ...credential };
  }

  async list(options?: { readonly signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    return [...this.#credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    update: (current: EphemeralCredential | undefined) => Promise<EphemeralCredential | undefined>,
    options?: { readonly signal?: AbortSignal },
  ) {
    options?.signal?.throwIfAborted();
    const next = await update(this.#credentials.get(providerId));
    options?.signal?.throwIfAborted();
    if (next === undefined) this.#credentials.delete(providerId);
    else this.#credentials.set(providerId, { ...next });
    return next === undefined ? undefined : { ...next };
  }

  async delete(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    this.#credentials.delete(providerId);
  }
}

async function loadPiSdk(): Promise<PiSdk> {
  const moduleSpecifier: string = "@earendil-works/pi-coding-agent";
  return (await import(moduleSpecifier)) as PiSdk;
}

async function defaultRuntimeFactory(
  options: Readonly<Record<string, unknown>>,
): Promise<PiModelRuntime> {
  const piSdk = await loadPiSdk();
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

function freezeRouting(routing: PiProviderRouting | undefined): PiProviderRouting | undefined {
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

function freezeDescriptor(descriptor: PiConfiguredModelDescriptor): PiConfiguredModelDescriptor {
  const providerRouting = freezeRouting(descriptor.providerRouting);
  return Object.freeze({
    ...descriptor,
    input: Object.freeze([...descriptor.input]),
    cost: Object.freeze({ ...descriptor.cost }),
    capabilities: Object.freeze([...descriptor.capabilities]),
    allowedDataClassifications: Object.freeze([...descriptor.allowedDataClassifications]),
    ...(providerRouting === undefined ? {} : { providerRouting }),
  });
}

function validateDescriptor(descriptor: PiConfiguredModelDescriptor, index: number): void {
  const field = `descriptors[${index}]`;
  for (const [name, value] of [
    ["ref", descriptor.ref],
    ["model", descriptor.model],
    ["version", descriptor.version],
    ["name", descriptor.name],
    ["secretRef", descriptor.secretRef],
    ["secretVersion", descriptor.secretVersion],
    ["secretPurpose", descriptor.secretPurpose],
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
  if (descriptor.role === "fallback") {
    if (
      descriptor.allowedDataClassifications.length !== 1 ||
      descriptor.allowedDataClassifications[0] !== "private"
    ) {
      throw new TypeError(`${field}.allowedDataClassifications must be exactly private`);
    }
  }
  assertPositiveInteger(descriptor.contextWindow, `${field}.contextWindow`);
  assertPositiveInteger(descriptor.maxTokens, `${field}.maxTokens`);
  for (const [name, value] of Object.entries(descriptor.cost)) {
    assertNonNegativeFinite(value, `${field}.cost.${name}`);
  }
  if (descriptor.baseUrl !== undefined) assertBaseUrl(descriptor.baseUrl);
}

function providerModelConfig(descriptor: PiConfiguredModelDescriptor, baseUrl: string) {
  const compat: Record<string, unknown> = {
    maxTokensField: "max_tokens",
    supportsUsageInStreaming: true,
    supportsStrictMode: descriptor.capabilities.includes("structured_outputs"),
    ...(descriptor.reasoning ? { thinkingFormat: "openrouter" } : {}),
    ...(descriptor.providerRouting === undefined
      ? {}
      : {
          openRouterRouting: {
            ...(descriptor.providerRouting.order === undefined
              ? {}
              : { order: [...descriptor.providerRouting.order] }),
            ...(descriptor.providerRouting.allow_fallbacks === undefined
              ? {}
              : { allow_fallbacks: descriptor.providerRouting.allow_fallbacks }),
            ...(descriptor.providerRouting.require_parameters === undefined
              ? {}
              : { require_parameters: descriptor.providerRouting.require_parameters }),
            ...(descriptor.providerRouting.data_collection === undefined
              ? {}
              : { data_collection: descriptor.providerRouting.data_collection }),
            ...(descriptor.providerRouting.zdr === undefined
              ? {}
              : { zdr: descriptor.providerRouting.zdr }),
          },
        }),
  };
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
    compat,
  };
}

export class ConfiguredPiModelBindingPort implements PiModelBindingPort {
  readonly #descriptors: readonly PiConfiguredModelDescriptor[];
  readonly #byRef: ReadonlyMap<string, PiConfiguredModelDescriptor>;
  readonly #secretSource: PiProviderSecretSource;
  readonly #runtimeFactory: PiModelRuntimeFactory;
  #runtime: PiModelRuntime | undefined;
  #initialization: Promise<PiModelRuntime> | undefined;

  constructor(options: ConfiguredPiModelBindingPortOptions) {
    if (!options.secretSource.productionSuitable) {
      throw new TypeError("PI_UNSAFE_PROVIDER_SECRET_SOURCE");
    }
    if (options.descriptors.length !== 2) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_PRIMARY_AND_FALLBACK");
    }
    const descriptors = options.descriptors.map(freezeDescriptor);
    descriptors.forEach(validateDescriptor);
    if (descriptors.filter(({ role }) => role === "primary").length !== 1) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
    }
    if (descriptors.filter(({ role }) => role === "fallback").length !== 1) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_ONE_FALLBACK");
    }
    if (new Set(descriptors.map(({ ref }) => ref)).size !== descriptors.length) {
      throw new TypeError("PI_MODEL_BINDING_REQUIRES_UNIQUE_REFS");
    }
    const provider = descriptors[0]?.provider;
    const baseUrl = descriptors[0]?.baseUrl ?? OPENROUTER_BASE_URL;
    const secretIdentity = descriptors[0]
      ? `${descriptors[0].secretRef}@${descriptors[0].secretVersion}:${descriptors[0].secretPurpose}`
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
        (descriptor) =>
          `${descriptor.secretRef}@${descriptor.secretVersion}:${descriptor.secretPurpose}` !==
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

  configuredDescriptors(): readonly PiConfiguredModelDescriptor[] {
    return this.#descriptors.map((descriptor) => freezeDescriptor(descriptor));
  }

  async resolve(modelRef: string): Promise<PiModelBinding> {
    const descriptor = this.#byRef.get(modelRef);
    if (descriptor === undefined) throw new Error("PI_MODEL_REF_NOT_CONFIGURED");
    const runtime = await this.runtime();
    const model = runtime.getModel(descriptor.provider, descriptor.model);
    if (model === undefined) throw new Error("PI_MODEL_NOT_REGISTERED");
    return { model, modelRuntime: runtime };
  }

  async close(): Promise<void> {
    await this.#initialization?.catch(() => undefined);
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#initialization = undefined;
    if (runtime?.removeRuntimeApiKey !== undefined) {
      await runtime.removeRuntimeApiKey("openrouter").catch(() => undefined);
    }
  }

  private async runtime(): Promise<PiModelRuntime> {
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

  private async initializeRuntime(): Promise<PiModelRuntime> {
    const first = this.#descriptors[0];
    if (first === undefined) throw new Error("PI_MODEL_BINDING_EMPTY");
    let secret: string;
    try {
      secret = await this.#secretSource.resolve(first.secretRef, first.secretVersion);
    } catch {
      throw new Error("PI_PROVIDER_SECRET_UNAVAILABLE");
    }
    if (secret.trim().length === 0) throw new Error("PI_PROVIDER_SECRET_UNAVAILABLE");

    const baseUrl = first.baseUrl ?? OPENROUTER_BASE_URL;
    const runtime = await this.#runtimeFactory.create({
      credentials: new EphemeralCredentialStore(),
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
      });
      await runtime.setRuntimeApiKey(first.provider, secret);
      for (const descriptor of this.#descriptors) {
        if (runtime.getModel(descriptor.provider, descriptor.model) === undefined) {
          throw new Error("PI_MODEL_NOT_REGISTERED");
        }
      }
    } catch {
      if (runtime.removeRuntimeApiKey !== undefined) {
        await runtime.removeRuntimeApiKey(first.provider).catch(() => undefined);
      }
      throw new Error("PI_MODEL_RUNTIME_CONFIGURATION_FAILED");
    }
    return runtime;
  }
}
