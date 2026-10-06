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
  type ClockPort,
  type DataClassification,
  type ModelDescriptor,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type PayloadProtectionRequest,
  type PayloadProtectorPort,
  type PayloadStorePort,
  redactMachineSecrets,
} from "@himawari-agent/application/runtime-port";
import { gatewayPayload, observeGatewayFetch } from "./gateway-observation.js";
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
  if (status === 408) return { code: "AI_GATEWAY_REQUEST_TIMEOUT", retryable: true };
  if (status === 429) return { code: "AI_GATEWAY_RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "AI_GATEWAY_PROVIDER_UNAVAILABLE", retryable: true };
  if (status === 401 || status === 403) {
    return { code: "AI_GATEWAY_AUTH_REJECTED", retryable: false };
  }
  if (status === 402) return { code: "AI_GATEWAY_PAYMENT_REQUIRED", retryable: false };
  return { code: "AI_GATEWAY_REQUEST_REJECTED", retryable: false };
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
  readonly #observations: PiModelTransportObservation[] = [];

  constructor(options: PiModelTransportOptions) {
    const maxOutputTokens = options.maxOutputTokens ?? 512;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) {
      throw new RangeError("Pi maxOutputTokens must be an integer from 1 to 32768");
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
    const fetch = options.fetch ?? globalThis.fetch;
    if (typeof fetch !== "function") throw new TypeError("Pi model transport requires fetch");
    this.#models = options.models;
    this.#payloads = options.payloads;
    this.#clock = options.clock;
    this.#fetch = fetch;
    this.#maxOutputTokens = maxOutputTokens;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#temperature = options.temperature;
  }

  observations(): readonly PiModelTransportObservation[] {
    return structuredClone(this.#observations);
  }

  async *invoke(input: PiModelTransportInput): AsyncIterable<ModelInvocationEvent> {
    const { descriptor, request, secretValues } = input;
    request.signal?.throwIfAborted();
    const startedAt = Date.now();
    const now = () => this.#clock.now();
    yield Object.freeze({
      type: "model.started" as const,
      invocationId: request.invocationId,
      occurredAt: now(),
    });
    if (descriptor.provider !== "vercel-ai-gateway" || request.modelRef !== descriptor.ref) {
      yield failed(request, "AI_GATEWAY_PROVIDER_MISMATCH", false, Date.now() - startedAt, now());
      return;
    }
    const secret = secretValues[0];
    if (secret === undefined || secret.length === 0 || secretValues.length !== 1) {
      yield failed(request, "AI_GATEWAY_CREDENTIAL_MISSING", false, Date.now() - startedAt, now());
      return;
    }

    let prompt: string;
    try {
      prompt = await this.#payloads.readText(request.inputRef);
      assertMachineSecretFree(prompt);
    } catch {
      yield failed(request, "AI_GATEWAY_INPUT_REJECTED", false, Date.now() - startedAt, now());
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
    const observed = observeGatewayFetch(async (fetchInput, init) => {
      const response = await this.#fetch(fetchInput, init);
      responseStatus = response.status;
      return response;
    }, descriptor.model);

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
      request.signal?.throwIfAborted();
      const stream = binding.modelRuntime.stream(binding.model, context, {
        apiKey: secret,
        fetch: observed.fetch,
        onPayload: (payload) => gatewayPayload(payload, descriptor.providerRouting),
        maxTokens: Math.min(this.#maxOutputTokens, binding.model.maxTokens),
        maxRetries: 0,
        timeoutMs: this.#requestTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
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
                "AI_GATEWAY_OUTPUT_PERSIST_FAILED",
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
      const failure = request.signal?.aborted
        ? { code: "MODEL_REQUEST_CANCELLED", retryable: false }
        : isFailureStatus(responseStatus)
          ? statusFailure(responseStatus)
          : { code: "PI_MODEL_STREAM_ERROR", retryable: true };
      yield failed(request, failure.code, failure.retryable, Date.now() - startedAt, now());
      return;
    }

    if (terminalError || terminalMessage === undefined) {
      const failure = request.signal?.aborted
        ? { code: "MODEL_REQUEST_CANCELLED", retryable: false }
        : isFailureStatus(responseStatus)
          ? statusFailure(responseStatus)
          : { code: "AI_GATEWAY_RESPONSE_ERROR", retryable: false };
      yield failed(request, failure.code, failure.retryable, Date.now() - startedAt, now());
      return;
    }
    if (
      terminalMessage.stopReason === "toolUse" ||
      terminalMessage.content.some((item) => item.type === "toolCall")
    ) {
      yield failed(
        request,
        "AI_GATEWAY_TOOL_CALL_UNSUPPORTED",
        false,
        Date.now() - startedAt,
        now(),
      );
      return;
    }
    if (terminalMessage.stopReason === "length") {
      yield failed(request, "AI_GATEWAY_OUTPUT_TRUNCATED", false, Date.now() - startedAt, now());
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
            "AI_GATEWAY_OUTPUT_PERSIST_FAILED",
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
          "AI_GATEWAY_OUTPUT_PERSIST_FAILED",
          false,
          Date.now() - startedAt,
          now(),
        );
        return;
      }
    }
    if (sequence === 0) {
      yield failed(request, "AI_GATEWAY_EMPTY_RESPONSE", true, Date.now() - startedAt, now());
      return;
    }

    const observedResponse = await observed.result();
    if (observedResponse.status !== "verified") {
      yield failed(
        request,
        "AI_GATEWAY_PROVIDER_METADATA_MISSING",
        false,
        Date.now() - startedAt,
        now(),
      );
      return;
    }
    const observation = observedResponse.billing;
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
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costMicros: observation.costMicros,
      latencyMs: Date.now() - startedAt,
      providerObservation,
      occurredAt: now(),
    });
  }
}
