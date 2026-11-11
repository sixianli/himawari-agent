import {
  ApplicationPortError,
  EMBEDDING_PRIORITY_HEADER,
  type EmbeddingPriority,
  type EmbeddingProfile,
  embeddingDocumentText,
  embeddingQueryText,
  GATEWAY_EMBEDDING_PROVIDER,
  LOCAL_ONNX_EMBEDDING_PROVIDER,
  type ModelEgress,
  type ModelEgressContext,
  type ModelInvocationUsage,
  PORT_ERROR_CODES,
  QWEN3_EMBEDDING_8B_PROFILE,
  usdCostsEqual,
  usdCostToMicros,
} from "@himawari-agent/application";

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1" as const;
export const LOCAL_ONNX_BASE_URL = "http://local-onnx.invalid/v1" as const;
export const QWEN3_EMBEDDING_8B_MODEL = QWEN3_EMBEDDING_8B_PROFILE.model;
export const QWEN3_EMBEDDING_8B_DIMENSIONS = 4096 as const;
export const QWEN3_EMBEDDING_8B_VERSION = "catalog-2026-10-06" as const;
export const QWEN3_EMBEDDING_8B_COST = Object.freeze({
  input: 0.01,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export interface EmbeddingRequest {
  readonly identity: string;
  readonly model: string;
  readonly input: string;
  readonly dimensions: number;
}

export interface EmbeddingResponse {
  readonly model: string;
  readonly data: readonly { readonly embedding: readonly number[]; readonly index: number }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly total_tokens: number;
    readonly cost?: unknown;
  };
  readonly providerMetadata?: unknown;
}

export type EmbeddingBoundary = (
  request: EmbeddingRequest,
  send: (options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }) => Promise<EmbeddingResponse>,
) => Promise<EmbeddingResponse>;

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embedQuery(query: string): Promise<Float32Array>;
  embedDocument(text: string): Promise<Float32Array>;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function gatewayEmbeddingUsage(
  response: EmbeddingResponse,
  model: string,
  dimensions: number,
): ModelInvocationUsage {
  if (response.model !== model) throw new Error("EMBEDDING_MODEL_MISMATCH");
  if (
    !Number.isSafeInteger(response.usage?.prompt_tokens) ||
    response.usage.prompt_tokens < 0 ||
    !Number.isSafeInteger(response.usage.total_tokens) ||
    response.usage.total_tokens !== response.usage.prompt_tokens
  )
    throw new Error("EMBEDDING_USAGE_MISSING");
  if (
    !Array.isArray(response.data) ||
    response.data.length !== 1 ||
    response.data[0]?.index !== 0 ||
    !Array.isArray(response.data[0].embedding) ||
    response.data[0].embedding.length !== dimensions ||
    !response.data[0].embedding.every(Number.isFinite)
  )
    throw new Error("EMBEDDING_VECTOR_INVALID");
  const gateway = responseRecord(responseRecord(response.providerMetadata)?.["gateway"]);
  const routing = responseRecord(gateway?.["routing"]);
  if (
    typeof gateway?.["generationId"] !== "string" ||
    gateway["generationId"].trim().length === 0 ||
    typeof routing?.["finalProvider"] !== "string" ||
    routing["finalProvider"].trim().length === 0
  )
    throw new Error("EMBEDDING_GATEWAY_METADATA_MISSING");
  const cost = gateway["cost"];
  const reportedCostMicros = usdCostToMicros(cost);
  if ("cost" in response.usage && !usdCostsEqual(cost, response.usage.cost))
    throw new Error("EMBEDDING_GATEWAY_COST_CONFLICT");
  return Object.freeze({
    inputTokens: response.usage.prompt_tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostMicros,
  });
}

export function localEmbeddingUsage(
  response: EmbeddingResponse,
  model: string,
  dimensions: number,
): ModelInvocationUsage {
  if (response.model !== model) throw new Error("EMBEDDING_MODEL_MISMATCH");
  if (
    !Number.isSafeInteger(response.usage?.prompt_tokens) ||
    response.usage.prompt_tokens < 1 ||
    response.usage.total_tokens !== response.usage.prompt_tokens
  )
    throw new Error("EMBEDDING_USAGE_MISSING");
  if (
    !Array.isArray(response.data) ||
    response.data.length !== 1 ||
    response.data[0]?.index !== 0 ||
    !Array.isArray(response.data[0].embedding) ||
    response.data[0].embedding.length !== dimensions ||
    !response.data[0].embedding.every(Number.isFinite)
  )
    throw new Error("EMBEDDING_VECTOR_INVALID");
  const local = responseRecord(responseRecord(response.providerMetadata)?.["local"]);
  if (local?.["runtime"] !== "onnxruntime-node" || response.usage.cost !== 0)
    throw new Error("EMBEDDING_LOCAL_METADATA_MISSING");
  return Object.freeze({
    inputTokens: response.usage.prompt_tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostMicros: 0,
  });
}

export function embeddingUsageFor(
  provider: string,
): (response: EmbeddingResponse, model: string, dimensions: number) => ModelInvocationUsage {
  if (provider === LOCAL_ONNX_EMBEDDING_PROVIDER) return localEmbeddingUsage;
  if (provider === GATEWAY_EMBEDDING_PROVIDER) return gatewayEmbeddingUsage;
  throw new TypeError("MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED");
}

export function normalizedVector(values: readonly number[]): Float32Array {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("EMBEDDING_VECTOR_INVALID");
  for (let index = 0; index < vector.length; index += 1)
    vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

function decodedEmbedding(value: unknown, dimensions: number): readonly number[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error("EMBEDDING_VECTOR_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT)
    throw new Error("EMBEDDING_VECTOR_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: dimensions }, (_, index) =>
    view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true),
  );
}

export interface EgressEmbedderOptions {
  readonly egress: ModelEgress;
  readonly egressContext?: ModelEgressContext;
  readonly baseUrl: string;
  readonly profile: EmbeddingProfile;
  readonly identity: string;
  readonly dimensions: number;
  readonly apiKey?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly admit?: (priority: EmbeddingPriority) => void;
}

export class EgressEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly profile: EmbeddingProfile;
  readonly #options: EgressEmbedderOptions;
  #boundary: EmbeddingBoundary | undefined;
  #timeoutMs = 0;

  constructor(options: EgressEmbedderOptions) {
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1)
      throw new TypeError("EMBEDDING_DIMENSIONS_INVALID");
    if (!options.profile.dimensions.includes(options.dimensions))
      throw new TypeError("EMBEDDING_PROFILE_DIMENSIONS_UNSUPPORTED");
    if (options.identity.trim().length === 0) throw new TypeError("EMBEDDING_MODEL_REQUIRED");
    if (
      (options.profile.provider === GATEWAY_EMBEDDING_PROVIDER) !==
      (options.apiKey !== undefined)
    )
      throw new TypeError("EMBEDDING_API_KEY_POLICY");
    this.model = options.identity;
    this.dimensions = options.dimensions;
    this.profile = options.profile;
    this.#options = options;
  }

  bindBoundary(boundary: EmbeddingBoundary, timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new TypeError("EMBEDDING_TIMEOUT_INVALID");
    this.#boundary = boundary;
    this.#timeoutMs = timeoutMs;
  }

  embedQuery(query: string): Promise<Float32Array> {
    return this.#embed(embeddingQueryText(this.profile, query), "interactive");
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.#embed(embeddingDocumentText(this.profile, text), "background");
  }

  async #embed(text: string, priority: EmbeddingPriority): Promise<Float32Array> {
    const boundary = this.#boundary;
    if (!boundary)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "EMBEDDING_BOUNDARY_REQUIRED",
      );
    this.#options.admit?.(priority);
    const request: EmbeddingRequest = Object.freeze({
      identity: this.model,
      model: this.profile.model,
      input: text,
      dimensions: this.dimensions,
    });
    const response = await boundary(request, (options) => this.#send(request, priority, options));
    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length !== this.dimensions)
      throw new Error("EMBEDDING_VECTOR_INVALID");
    return normalizedVector(embedding);
  }

  async #send(
    request: EmbeddingRequest,
    priority: EmbeddingPriority,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<EmbeddingResponse> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const exchange = this.#options.egress.exchange(this.#options.egressContext);
    const apiKey = this.#options.apiKey;
    const response = await exchange.wrapFetch(this.#options.fetch ?? fetch)(
      `${this.#options.baseUrl.replace(/\/+$/u, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          ...(apiKey === undefined
            ? { [EMBEDDING_PRIORITY_HEADER]: priority }
            : { authorization: `Bearer ${await apiKey()}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          input: request.input,
          dimensions: request.dimensions,
          encoding_format: "base64",
        }),
        signal,
      },
    );
    if (!response.ok)
      throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, "EMBEDDING_HTTP_FAILURE", {
        status: String(response.status),
        ...(await gatewayErrorDetails(response)),
      });
    const body = (await response.json()) as Omit<EmbeddingResponse, "data"> & {
      readonly data: readonly { readonly embedding: unknown; readonly index: number }[];
    };
    return {
      ...body,
      data: Array.isArray(body.data)
        ? body.data.map((entry) => ({
            ...entry,
            embedding: decodedEmbedding(entry?.embedding, request.dimensions),
          }))
        : [],
    };
  }
}

async function gatewayErrorDetails(
  response: Response,
): Promise<{ readonly gatewayErrorType?: string; readonly gatewayErrorMessage?: string }> {
  const body = await response.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return {};
  const { type, message } = error as { type?: unknown; message?: unknown };
  return {
    ...(typeof type === "string" ? { gatewayErrorType: type.slice(0, 80) } : {}),
    ...(typeof message === "string" ? { gatewayErrorMessage: message.slice(0, 300) } : {}),
  };
}
