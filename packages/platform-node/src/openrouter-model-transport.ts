// biome-ignore-all lint/complexity/useLiteralKeys: untrusted OpenRouter JSON remains index-signature typed until validated
import {
  assertMachineSecretFree,
  type ClockPort,
  type DataClassification,
  type IdGeneratorPort,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type ModelProviderObservation,
  type ModelProviderRouting,
  type PayloadProtectorPort,
  type PayloadStorePort,
  redactMachineSecrets,
} from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type {
  TrustedModelTransport,
  TrustedModelTransportInput,
} from "./trusted-model-provider.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterModelPayloadBoundary {
  readText(ref: string): Promise<string>;
  writeText(input: {
    readonly invocationId: string;
    readonly sequence: number;
    readonly dataClassification: DataClassification;
    readonly content: string;
    readonly occurredAt: string;
  }): Promise<string>;
}

export type OpenRouterProviderRouting = ModelProviderRouting;

export interface OpenRouterModelTransportOptions {
  readonly payloads: OpenRouterModelPayloadBoundary;
  readonly clock: ClockPort;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly temperature?: number;
  readonly siteUrl?: string;
  readonly appName?: string;
  readonly provider?: OpenRouterProviderRouting;
}

export interface ProtectedOpenRouterPayloadBoundaryOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
}

export class ProtectedOpenRouterPayloadBoundary implements OpenRouterModelPayloadBoundary {
  readonly #ownerId: OwnerId;
  readonly #agentId: AgentId;
  readonly #payloads: PayloadStorePort;
  readonly #protector: PayloadProtectorPort;
  readonly #ids: IdGeneratorPort;
  readonly #clock: ClockPort;

  constructor(options: ProtectedOpenRouterPayloadBoundaryOptions) {
    this.#ownerId = options.ownerId;
    this.#agentId = options.agentId;
    this.#payloads = options.payloads;
    this.#protector = options.protector;
    this.#ids = options.ids;
    this.#clock = options.clock;
  }

  async readText(ref: string): Promise<string> {
    const payload = await this.#payloads.get(ref);
    if (!payload) throw new Error("MODEL_INPUT_PAYLOAD_MISSING");
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

export interface OpenRouterTransportObservation {
  readonly invocationId: string;
  readonly requestedModel: string;
  readonly generationId: string | null;
  readonly provider: string | null;
  readonly responseModel: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costMicros: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const candidate = typeof value === "string" && value.length > 0 ? Number(value) : value;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : null;
}

function costMicros(value: unknown): number | null {
  const dollars = nonNegativeNumber(value);
  if (dollars === null) return null;
  const micros = Math.round(dollars * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function errorEvent(
  request: ModelInvocationRequest,
  errorCode: string,
  retryable: boolean,
  occurredAt: string,
  latencyMs: number,
): ModelInvocationEvent {
  return Object.freeze({
    type: "model.failed" as const,
    invocationId: request.invocationId,
    errorCode,
    retryable,
    latencyMs,
    occurredAt,
  });
}

function statusErrorCode(status: number): { readonly code: string; readonly retryable: boolean } {
  if (status === 408) return { code: "OPENROUTER_REQUEST_TIMEOUT", retryable: true };
  if (status === 429) return { code: "OPENROUTER_RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "OPENROUTER_PROVIDER_UNAVAILABLE", retryable: true };
  if (status === 401 || status === 403)
    return { code: "OPENROUTER_AUTH_REJECTED", retryable: false };
  if (status === 402) return { code: "OPENROUTER_PAYMENT_REQUIRED", retryable: false };
  return { code: "OPENROUTER_REQUEST_REJECTED", retryable: false };
}

function providerObservation(data: JsonRecord): ModelProviderObservation {
  const metadata = record(data["openrouter_metadata"]);
  const attempts = metadata ? metadata["attempts"] : null;
  const firstAttempt = Array.isArray(attempts) ? record(attempts[0]) : null;
  const endpoints = metadata ? record(metadata["endpoints"]) : null;
  const available =
    endpoints && Array.isArray(endpoints["available"]) ? endpoints["available"] : [];
  const selected = available.map(record).find((entry) => entry?.["selected"] === true) ?? null;
  return Object.freeze({
    provider: string(firstAttempt?.["provider"]) ?? string(selected?.["provider"]),
    model: string(data["model"]) ?? string(firstAttempt?.["model"]) ?? string(selected?.["model"]),
    generationId: string(data["id"]),
  });
}

function mergeObservation(
  current: ModelProviderObservation,
  previous: ModelProviderObservation | null,
): ModelProviderObservation {
  return Object.freeze({
    provider: current.provider ?? (previous === null ? null : previous.provider),
    model: current.model ?? (previous === null ? null : previous.model),
    generationId: current.generationId ?? (previous === null ? null : previous.generationId),
  });
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
      }
      if (chunk.done) break;
    }
    const finalLine = buffer.trimEnd();
    if (finalLine.startsWith("data:")) dataLines.push(finalLine.slice("data:".length).trimStart());
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
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

/**
 * Keep a possible secret together until its complete value is available. This
 * prevents a credential split over two provider deltas from escaping before
 * the shared machine-secret redactor can replace it.
 */
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

export class OpenRouterModelTransport implements TrustedModelTransport {
  readonly #payloads: OpenRouterModelPayloadBoundary;
  readonly #clock: ClockPort;
  readonly #fetch: typeof globalThis.fetch;
  readonly #url: string;
  readonly #maxOutputTokens: number;
  readonly #requestTimeoutMs: number;
  readonly #temperature: number | undefined;
  readonly #siteUrl: string | undefined;
  readonly #appName: string | undefined;
  readonly #provider: OpenRouterProviderRouting | undefined;
  readonly #observations: OpenRouterTransportObservation[] = [];

  constructor(options: OpenRouterModelTransportOptions) {
    const baseUrl = options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL;
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password || !["https:", "http:"].includes(parsed.protocol)) {
      throw new TypeError(
        "OpenRouter base URL must be an absolute HTTP(S) URL without credentials",
      );
    }
    if (
      parsed.protocol === "http:" &&
      !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)
    ) {
      throw new TypeError("OpenRouter HTTP base URL must be loopback-only");
    }
    if (options.siteUrl) {
      const site = new URL(options.siteUrl);
      if (site.origin !== options.siteUrl || site.username || site.password) {
        throw new TypeError("OpenRouter site URL must contain only an origin");
      }
    }
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 131_072
    ) {
      throw new RangeError("OpenRouter maxOutputTokens must be an integer from 1 to 131072");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 300_000
    ) {
      throw new RangeError("OpenRouter requestTimeoutMs must be an integer from 1 to 300000");
    }
    if (
      options.temperature !== undefined &&
      (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
    ) {
      throw new RangeError("OpenRouter temperature must be between 0 and 2");
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== "function") {
      throw new TypeError("OpenRouter requires fetch");
    }
    this.#payloads = options.payloads;
    this.#clock = options.clock;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.#maxOutputTokens = maxOutputTokens;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#temperature = options.temperature;
    this.#siteUrl = options.siteUrl;
    this.#appName = options.appName;
    this.#provider = options.provider;
  }

  observations(): readonly OpenRouterTransportObservation[] {
    return structuredClone(this.#observations);
  }

  async *invoke(input: TrustedModelTransportInput): AsyncIterable<ModelInvocationEvent> {
    const { descriptor, request, secretValues } = input;
    const startedAt = Date.now();
    const now = () => this.#clock.now();
    yield Object.freeze({
      type: "model.started" as const,
      invocationId: request.invocationId,
      occurredAt: now(),
    });

    if (descriptor.provider !== "openrouter") {
      yield errorEvent(
        request,
        "OPENROUTER_PROVIDER_MISMATCH",
        false,
        now(),
        Date.now() - startedAt,
      );
      return;
    }
    const secret = secretValues[0];
    if (secret === undefined || secret.length === 0 || secretValues.length !== 1) {
      yield errorEvent(
        request,
        "OPENROUTER_CREDENTIAL_MISSING",
        false,
        now(),
        Date.now() - startedAt,
      );
      return;
    }

    let prompt: string;
    try {
      prompt = await this.#payloads.readText(request.inputRef);
      assertMachineSecretFree(prompt);
    } catch {
      yield errorEvent(request, "OPENROUTER_INPUT_REJECTED", false, now(), Date.now() - startedAt);
      return;
    }

    const providerRouting = descriptor.providerRouting ?? this.#provider;
    const body = {
      model: descriptor.model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.#maxOutputTokens,
      ...(this.#temperature === undefined ? {} : { temperature: this.#temperature }),
      ...(providerRouting === undefined ? {} : { provider: providerRouting }),
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Metadata": "enabled",
          ...(this.#siteUrl === undefined ? {} : { "HTTP-Referer": this.#siteUrl }),
          ...(this.#appName === undefined ? {} : { "X-OpenRouter-Title": this.#appName }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      yield errorEvent(request, "OPENROUTER_NETWORK_ERROR", true, now(), Date.now() - startedAt);
      return;
    }
    if (!response.ok) {
      const failure = statusErrorCode(response.status);
      yield errorEvent(request, failure.code, failure.retryable, now(), Date.now() - startedAt);
      return;
    }
    if (!response.body) {
      yield errorEvent(request, "OPENROUTER_EMPTY_BODY", true, now(), Date.now() - startedAt);
      return;
    }

    let usage: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly costMicros: number;
    } | null = null;
    let observation: ModelProviderObservation | null = null;
    const redactor = new StreamingMachineSecretRedactor();
    let sequence = 0;
    try {
      for await (const rawEvent of readSseEvents(response.body)) {
        if (rawEvent === "[DONE]") continue;
        const data = record(JSON.parse(rawEvent));
        if (!data) continue;
        const error = record(data["error"]);
        if (error) {
          yield errorEvent(
            request,
            "OPENROUTER_RESPONSE_ERROR",
            false,
            now(),
            Date.now() - startedAt,
          );
          return;
        }
        const currentObservation = providerObservation(data);
        const previousObservation: ModelProviderObservation | null = observation;
        observation = mergeObservation(currentObservation, previousObservation);
        const usageData = record(data["usage"]);
        if (usageData) {
          const promptTokens = nonNegativeInteger(usageData["prompt_tokens"]);
          const completionTokens = nonNegativeInteger(usageData["completion_tokens"]);
          const cost = costMicros(usageData["cost"]);
          if (promptTokens !== null && completionTokens !== null && cost !== null) {
            usage = Object.freeze({
              promptTokens,
              completionTokens,
              costMicros: cost,
            });
          }
        }
        const choices = Array.isArray(data["choices"]) ? data["choices"] : [];
        const choice = record(choices[0]);
        const delta = choice ? record(choice["delta"]) : null;
        if (delta && delta["tool_calls"] !== undefined) {
          yield errorEvent(
            request,
            "OPENROUTER_TOOL_CALL_UNSUPPORTED",
            false,
            now(),
            Date.now() - startedAt,
          );
          return;
        }
        const content = string(delta?.["content"]);
        if (content === null) continue;
        const safeContent = redactor.append(content);
        if (safeContent.length === 0) continue;
        sequence += 1;
        const occurredAt = now();
        let payloadRef: string;
        try {
          payloadRef = await this.#payloads.writeText({
            invocationId: request.invocationId,
            sequence,
            dataClassification: request.dataClassification,
            content: safeContent,
            occurredAt,
          });
        } catch {
          yield errorEvent(
            request,
            "OPENROUTER_OUTPUT_PERSIST_FAILED",
            false,
            now(),
            Date.now() - startedAt,
          );
          return;
        }
        yield Object.freeze({
          type: "model.output" as const,
          invocationId: request.invocationId,
          sequence,
          payloadRef,
          occurredAt,
        });
      }
    } catch {
      yield errorEvent(request, "OPENROUTER_STREAM_ERROR", true, now(), Date.now() - startedAt);
      return;
    }
    if (!usage) {
      yield errorEvent(request, "OPENROUTER_USAGE_MISSING", false, now(), Date.now() - startedAt);
      return;
    }
    const trailingContent = redactor.flush();
    if (trailingContent.length > 0) {
      sequence += 1;
      const occurredAt = now();
      let payloadRef: string;
      try {
        payloadRef = await this.#payloads.writeText({
          invocationId: request.invocationId,
          sequence,
          dataClassification: request.dataClassification,
          content: trailingContent,
          occurredAt,
        });
      } catch {
        yield errorEvent(
          request,
          "OPENROUTER_OUTPUT_PERSIST_FAILED",
          false,
          now(),
          Date.now() - startedAt,
        );
        return;
      }
      yield Object.freeze({
        type: "model.output" as const,
        invocationId: request.invocationId,
        sequence,
        payloadRef,
        occurredAt,
      });
    }
    if (
      observation === null ||
      observation.provider === null ||
      observation.model === null ||
      observation.generationId === null
    ) {
      yield errorEvent(
        request,
        "OPENROUTER_PROVIDER_METADATA_MISSING",
        false,
        now(),
        Date.now() - startedAt,
      );
      return;
    }
    const provider = observation;
    this.#observations.push(
      Object.freeze({
        invocationId: request.invocationId,
        requestedModel: descriptor.model,
        generationId: provider.generationId,
        provider: provider.provider,
        responseModel: provider.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costMicros: usage.costMicros,
      }),
    );
    yield Object.freeze({
      type: "model.completed" as const,
      invocationId: request.invocationId,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costMicros: usage.costMicros,
      latencyMs: Date.now() - startedAt,
      providerObservation: provider,
      occurredAt: now(),
    });
  }
}
