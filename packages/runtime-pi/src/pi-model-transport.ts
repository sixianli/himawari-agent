// biome-ignore-all lint/complexity/useLiteralKeys: provider metadata is parsed as an untrusted record
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  FetchFunction,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  assertMachineSecretFree,
  redactMachineSecrets,
  type ClockPort,
  type DataClassification,
  type ModelDescriptor,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type PayloadProtectionRequest,
  type PayloadProtectorPort,
  type PayloadStorePort,
} from "@himawari-agent/application/runtime-port";
import type { PiModelBindingPort } from "./pi-runtime-adapter.js";

export interface PiModelPayloadBoundary {
  readText(payloadRef: string): Promise<string>;
  writeText(input: {
    readonly invocationId: string;
    readonly sequence: number;
    readonly dataClassification: DataClassification;
    readonly content: string;
    readonly occurredAt: string;
  }): Promise<string>;
}

export interface ProtectedPiModelPayloadBoundaryOptions {
  readonly ownerId: PayloadProtectionRequest["ownerId"];
  readonly agentId: PayloadProtectionRequest["agentId"];
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly ids: { next(scope: string): string };
  readonly clock: ClockPort;
}

export class ProtectedPiModelPayloadBoundary implements PiModelPayloadBoundary {
  readonly #ownerId: PayloadProtectionRequest["ownerId"];
  readonly #agentId: PayloadProtectionRequest["agentId"];
  readonly #payloads: PayloadStorePort;
  readonly #protector: PayloadProtectorPort;
  readonly #ids: { next(scope: string): string };
  readonly #clock: ClockPort;

  constructor(options: ProtectedPiModelPayloadBoundaryOptions) {
    this.#ownerId = options.ownerId;
    this.#agentId = options.agentId;
    this.#payloads = options.payloads;
    this.#protector = options.protector;
    this.#ids = options.ids;
    this.#clock = options.clock;
  }

  async readText(payloadRef: string): Promise<string> {
    const payload = await this.#payloads.get(payloadRef);
    if (!payload) throw new Error("MODEL_PAYLOAD_NOT_FOUND");
    const plaintext = await this.#protector.unprotect({
      ownerId: this.#ownerId,
      agentId: this.#agentId,
      payload,
    });
    return new TextDecoder().decode(plaintext);
  }

  async writeText(input: {
    readonly invocationId: string;
    readonly sequence: number;
    readonly dataClassification: DataClassification;
    readonly content: string;
    readonly occurredAt: string;
  }): Promise<string> {
    const ref = this.#ids.next("model-output");
    const payload = await this.#protector.protect({
      ownerId: this.#ownerId,
      agentId: this.#agentId,
      ref,
      dataClassification: input.dataClassification,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode(input.content),
      createdAt: input.occurredAt || this.#clock.now(),
    });
    await this.#payloads.put(payload);
    return ref;
  }
}

export interface PiModelTransportInput {
  readonly descriptor: ModelDescriptor;
  readonly request: ModelInvocationRequest;
  readonly secretValues: readonly string[];
}

export interface PiModelTransportOptions {
  readonly models: PiModelBindingPort;
  readonly payloads: PiModelPayloadBoundary;
  readonly clock: ClockPort;
  readonly fetch?: FetchFunction;
  readonly maxOutputTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly temperature?: number;
  readonly siteUrl?: string;
  readonly appName?: string;
}

export interface PiModelTransportObservation {
  readonly invocationId: string;
  readonly requestedModel: string;
  readonly generationId: string | null;
  readonly provider: string | null;
  readonly responseModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}

interface OpenRouterObservation {
  readonly generationId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly costMicros: number | null;
}

const EMPTY_OBSERVATION: OpenRouterObservation = Object.freeze({
  generationId: null,
  provider: null,
  model: null,
  costMicros: null,
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function providerObservation(data: Record<string, unknown>): OpenRouterObservation {
  const metadata = record(data["openrouter_metadata"]);
  const attempts = metadata?.["attempts"];
  const firstAttempt = Array.isArray(attempts) ? record(attempts[0]) : null;
  const endpoints = record(metadata?.["endpoints"]);
  const available = Array.isArray(endpoints?.["available"]) ? endpoints["available"] : [];
  const selected = available.map(record).find((entry) => entry?.["selected"] === true) ?? null;
  const rawCost = record(data["usage"])?.["cost"];
  const dollars =
    typeof rawCost === "number"
      ? rawCost
      : typeof rawCost === "string" && rawCost.length > 0
        ? Number(rawCost)
        : Number.NaN;
  const costMicros =
    Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 1_000_000) : null;
  return {
    generationId: nonEmptyString(data["id"]),
    provider: nonEmptyString(firstAttempt?.["provider"]) ?? nonEmptyString(selected?.["provider"]),
    model:
      nonEmptyString(data["model"]) ??
      nonEmptyString(firstAttempt?.["model"]) ??
      nonEmptyString(selected?.["model"]),
    costMicros: costMicros !== null && Number.isSafeInteger(costMicros) ? costMicros : null,
  };
}

function mergeObservation(
  previous: OpenRouterObservation,
  current: OpenRouterObservation,
): OpenRouterObservation {
  return {
    generationId: current.generationId ?? previous.generationId,
    provider: current.provider ?? previous.provider,
    model: current.model ?? previous.model,
    costMicros: current.costMicros ?? previous.costMicros,
  };
}

async function observeOpenRouterResponse(response: Response): Promise<OpenRouterObservation> {
  if (!response.body) return EMPTY_OBSERVATION;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let observation = EMPTY_OBSERVATION;
  const observeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trimStart();
    if (payload.length === 0 || payload === "[DONE]") return;
    try {
      const data = record(JSON.parse(payload));
      if (data) observation = mergeObservation(observation, providerObservation(data));
    } catch {
      // Pi remains the authoritative parser. This observer only enriches
      // metadata Pi 0.84.2 does not expose and must never affect output.
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
      if (chunk.done) break;
    }
    if (buffer.length > 0) observeLine(buffer);
  } finally {
    reader.releaseLock();
  }
  return observation;
}

const POTENTIAL_SECRET_MARKERS = Object.freeze([
  "Bearer ",
  "password",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "refresh_token",
  "refresh-token",
  "client_secret",
  "client-secret",
  "webhook_secret",
  "webhook-secret",
  "sk-",
  "gho_",
  "ghp_",
  "ghs_",
  "ghu_",
  "ghr_",
  "github_pat_",
  "AKIA",
  "ASIA",
  "eyJ",
  "-----BEGIN",
] as const);

const ACTIVE_SECRET_SUFFIXES = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]*$/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]*$/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]*$/,
  /\b(?:gh[opsu]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*)$/,
  /\b(?:AKIA|ASIA)[A-Z0-9]*$/,
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/,
] as const);

function redactionHoldStart(value: string): number | null {
  let holdStart: number | null = null;
  const hold = (index: number) => {
    holdStart = holdStart === null ? index : Math.min(holdStart, index);
  };
  const privateKeyStart = value.search(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  if (
    privateKeyStart >= 0 &&
    !/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value.slice(privateKeyStart))
  ) {
    hold(privateKeyStart);
  }
  for (const pattern of ACTIVE_SECRET_SUFFIXES) {
    const match = pattern.exec(value);
    if (match?.index !== undefined) hold(match.index);
  }
  for (const marker of POTENTIAL_SECRET_MARKERS) {
    const maximum = Math.min(marker.length - 1, value.length);
    for (let length = maximum; length > 0; length -= 1) {
      if (value.endsWith(marker.slice(0, length))) {
        hold(value.length - length);
        break;
      }
    }
  }
  return holdStart;
}

class StreamingMachineSecretRedactor {
  #pending = "";

  append(value: string): string {
    this.#pending += value;
    const holdStart = redactionHoldStart(this.#pending);
    if (holdStart === null) {
      const safe = this.#pending;
      this.#pending = "";
      return redactMachineSecrets(safe);
    }
    if (holdStart === 0) return "";
    const safe = this.#pending.slice(0, holdStart);
    this.#pending = this.#pending.slice(holdStart);
    return redactMachineSecrets(safe);
  }

  flush(): string {
    const safe = redactMachineSecrets(this.#pending);
    this.#pending = "";
    return safe;
  }
}

function statusFailure(status: number): { readonly code: string; readonly retryable: boolean } {
  if (status === 408) return { code: "OPENROUTER_REQUEST_TIMEOUT", retryable: true };
  if (status === 429) return { code: "OPENROUTER_RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "OPENROUTER_PROVIDER_UNAVAILABLE", retryable: true };
  if (status === 401 || status === 403) {
    return { code: "OPENROUTER_AUTH_REJECTED", retryable: false };
  }
  if (status === 402) return { code: "OPENROUTER_PAYMENT_REQUIRED", retryable: false };
  return { code: "OPENROUTER_REQUEST_REJECTED", retryable: false };
}

function isFailureStatus(status: number): boolean {
  return status > 0 && (status < 200 || status >= 300);
}

function failed(
  request: ModelInvocationRequest,
  code: string,
  retryable: boolean,
  latencyMs: number,
  occurredAt: string,
): ModelInvocationEvent {
  return Object.freeze({
    type: "model.failed" as const,
    invocationId: request.invocationId,
    errorCode: code,
    retryable,
    latencyMs,
    occurredAt,
  });
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter(
      (item): item is Extract<(typeof message.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map(({ text }) => text)
    .join("");
}

export class PiModelTransport {
  readonly #models: PiModelBindingPort;
  readonly #payloads: PiModelPayloadBoundary;
  readonly #clock: ClockPort;
  readonly #fetch: FetchFunction;
  readonly #maxOutputTokens: number;
  readonly #requestTimeoutMs: number;
  readonly #temperature: number | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #observations: PiModelTransportObservation[] = [];

  constructor(options: PiModelTransportOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 131_072
    ) {
      throw new RangeError("Pi maxOutputTokens must be an integer from 1 to 131072");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 300_000
    ) {
      throw new RangeError("Pi requestTimeoutMs must be an integer from 1 to 300000");
    }
    if (
      options.temperature !== undefined &&
      (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
    ) {
      throw new RangeError("Pi temperature must be between 0 and 2");
    }
    if (options.siteUrl !== undefined) {
      const site = new URL(options.siteUrl);
      if (site.origin !== options.siteUrl || site.username || site.password) {
        throw new TypeError("OpenRouter site URL must contain only an origin");
      }
    }
    const fetch = options.fetch ?? globalThis.fetch;
    if (typeof fetch !== "function") throw new TypeError("Pi model transport requires fetch");
    this.#models = options.models;
    this.#payloads = options.payloads;
    this.#clock = options.clock;
    this.#fetch = fetch;
    this.#maxOutputTokens = maxOutputTokens;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#temperature = options.temperature;
    this.#headers = Object.freeze({
      "X-OpenRouter-Metadata": "enabled",
      ...(options.siteUrl === undefined ? {} : { "HTTP-Referer": options.siteUrl }),
      ...(options.appName === undefined ? {} : { "X-OpenRouter-Title": options.appName }),
    });
  }

  observations(): readonly PiModelTransportObservation[] {
    return structuredClone(this.#observations);
  }

  async *invoke(input: PiModelTransportInput): AsyncIterable<ModelInvocationEvent> {
    const { descriptor, request, secretValues } = input;
    const startedAt = Date.now();
    const now = () => this.#clock.now();
    yield Object.freeze({
      type: "model.started" as const,
      invocationId: request.invocationId,
      occurredAt: now(),
    });
    if (descriptor.provider !== "openrouter" || request.modelRef !== descriptor.ref) {
      yield failed(request, "OPENROUTER_PROVIDER_MISMATCH", false, Date.now() - startedAt, now());
      return;
    }
    const secret = secretValues[0];
    if (secret === undefined || secret.length === 0 || secretValues.length !== 1) {
      yield failed(request, "OPENROUTER_CREDENTIAL_MISSING", false, Date.now() - startedAt, now());
      return;
    }

    let prompt: string;
    try {
      prompt = await this.#payloads.readText(request.inputRef);
      assertMachineSecretFree(prompt);
    } catch {
      yield failed(request, "OPENROUTER_INPUT_REJECTED", false, Date.now() - startedAt, now());
      return;
    }

    let binding: Awaited<ReturnType<PiModelBindingPort["resolve"]>>;
    try {
      binding = await this.#models.resolve(descriptor.ref);
    } catch {
      yield failed(request, "PI_MODEL_BINDING_FAILED", false, Date.now() - startedAt, now());
      return;
    }
    if (binding.model.provider !== descriptor.provider || binding.model.id !== descriptor.model) {
      yield failed(request, "PI_MODEL_BINDING_MISMATCH", false, Date.now() - startedAt, now());
      return;
    }
    const message: UserMessage = { role: "user", content: prompt, timestamp: Date.now() };
    const context: Context = { messages: [message] };
    let responseStatus = 0;
    let observationPromise: Promise<OpenRouterObservation> = Promise.resolve(EMPTY_OBSERVATION);
    const observedFetch: FetchFunction = async (fetchInput, init) => {
      const response = await this.#fetch(fetchInput, init);
      responseStatus = response.status;
      if (response.ok && response.body) {
        observationPromise = observeOpenRouterResponse(response.clone()).catch(
          () => EMPTY_OBSERVATION,
        );
      }
      return response;
    };

    const redactor = new StreamingMachineSecretRedactor();
    let sequence = 0;
    let sawTextDelta = false;
    let terminalMessage: AssistantMessage | undefined;
    let terminalError = false;
    const persist = async (content: string): Promise<ModelInvocationEvent> => {
      sequence += 1;
      const occurredAt = now();
      const payloadRef = await this.#payloads.writeText({
        invocationId: request.invocationId,
        sequence,
        dataClassification: request.dataClassification,
        content,
        occurredAt,
      });
      return Object.freeze({
        type: "model.output" as const,
        invocationId: request.invocationId,
        sequence,
        payloadRef,
        occurredAt,
      });
    };
    try {
      const stream = binding.modelRuntime.stream(binding.model, context, {
        apiKey: secret,
        fetch: observedFetch,
        headers: this.#headers,
        maxTokens: this.#maxOutputTokens,
        maxRetries: 0,
        timeoutMs: this.#requestTimeoutMs,
        ...(this.#temperature === undefined ? {} : { temperature: this.#temperature }),
      });
      for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
        if (event.type === "text_delta") {
          sawTextDelta = true;
          const content = redactor.append(event.delta);
          if (content.length > 0) {
            try {
              yield await persist(content);
            } catch {
              yield failed(
                request,
                "OPENROUTER_OUTPUT_PERSIST_FAILED",
                false,
                Date.now() - startedAt,
                now(),
              );
              return;
            }
          }
        } else if (event.type === "done") {
          terminalMessage = event.message;
        } else if (event.type === "error") {
          terminalMessage = event.error;
          terminalError = true;
        }
      }
    } catch {
      const failure = isFailureStatus(responseStatus)
        ? statusFailure(responseStatus)
        : { code: "PI_MODEL_STREAM_ERROR", retryable: true };
      yield failed(request, failure.code, failure.retryable, Date.now() - startedAt, now());
      return;
    }

    if (terminalError || terminalMessage === undefined) {
      const failure = isFailureStatus(responseStatus)
        ? statusFailure(responseStatus)
        : { code: "OPENROUTER_RESPONSE_ERROR", retryable: false };
      yield failed(request, failure.code, failure.retryable, Date.now() - startedAt, now());
      return;
    }
    if (
      terminalMessage.stopReason === "toolUse" ||
      terminalMessage.content.some((item) => item.type === "toolCall")
    ) {
      yield failed(
        request,
        "OPENROUTER_TOOL_CALL_UNSUPPORTED",
        false,
        Date.now() - startedAt,
        now(),
      );
      return;
    }
    if (!sawTextDelta) {
      const content = redactor.append(textOf(terminalMessage));
      if (content.length > 0) {
        try {
          yield await persist(content);
        } catch {
          yield failed(
            request,
            "OPENROUTER_OUTPUT_PERSIST_FAILED",
            false,
            Date.now() - startedAt,
            now(),
          );
          return;
        }
      }
    }
    const trailing = redactor.flush();
    if (trailing.length > 0) {
      try {
        yield await persist(trailing);
      } catch {
        yield failed(
          request,
          "OPENROUTER_OUTPUT_PERSIST_FAILED",
          false,
          Date.now() - startedAt,
          now(),
        );
        return;
      }
    }

    const observation = await observationPromise;
    if (
      observation.provider === null ||
      observation.model === null ||
      observation.generationId === null ||
      observation.costMicros === null
    ) {
      yield failed(
        request,
        "OPENROUTER_PROVIDER_METADATA_MISSING",
        false,
        Date.now() - startedAt,
        now(),
      );
      return;
    }
    const usage = terminalMessage.usage;
    const providerObservation = Object.freeze({
      provider: observation.provider,
      model: observation.model,
      generationId: observation.generationId,
    });
    this.#observations.push(
      Object.freeze({
        invocationId: request.invocationId,
        requestedModel: descriptor.model,
        generationId: providerObservation.generationId,
        provider: providerObservation.provider,
        responseModel: providerObservation.model,
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
        costMicros: observation.costMicros,
      }),
    );
    yield Object.freeze({
      type: "model.completed" as const,
      invocationId: request.invocationId,
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      costMicros: observation.costMicros,
      latencyMs: Date.now() - startedAt,
      providerObservation,
      occurredAt: now(),
    });
  }
}
