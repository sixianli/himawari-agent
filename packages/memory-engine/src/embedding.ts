import {
  ApplicationPortError,
  type ModelInvocationUsage,
  PORT_ERROR_CODES,
  usdCostsEqual,
  usdCostToMicros,
} from "@himawari-agent/application";

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1" as const;
export const QWEN3_EMBEDDING_8B_MODEL = "alibaba/qwen3-embedding-8b" as const;
export const QWEN3_EMBEDDING_8B_DIMENSIONS = 4096 as const;
export const QWEN3_EMBEDDING_8B_VERSION = "catalog-2026-10-06" as const;
export const QWEN3_EMBEDDING_8B_COST = Object.freeze({
  input: 0.01,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const QWEN3_MEMORY_QUERY_INSTRUCTION =
  "Given a question from the owner of a personal assistant, retrieve the remembered facts about the owner that help answer it" as const;

export function instructedQuery(instruction: string, query: string): string {
  return `Instruct: ${instruction}\nQuery:${query}`;
}

export interface EmbeddingRequest {
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
  embed(text: string): Promise<Float32Array>;
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

export interface GatewayEmbedderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export class GatewayEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #options: GatewayEmbedderOptions;
  #boundary: EmbeddingBoundary | undefined;
  #timeoutMs = 0;

  constructor(options: GatewayEmbedderOptions) {
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1)
      throw new TypeError("EMBEDDING_DIMENSIONS_INVALID");
    if (options.model.trim().length === 0) throw new TypeError("EMBEDDING_MODEL_REQUIRED");
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.#options = options;
  }

  bindBoundary(boundary: EmbeddingBoundary, timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new TypeError("EMBEDDING_TIMEOUT_INVALID");
    this.#boundary = boundary;
    this.#timeoutMs = timeoutMs;
  }

  async embed(text: string): Promise<Float32Array> {
    const boundary = this.#boundary;
    if (!boundary)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "EMBEDDING_BOUNDARY_REQUIRED",
      );
    const request: EmbeddingRequest = Object.freeze({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    const response = await boundary(request, (options) => this.#send(request, options));
    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length !== this.dimensions)
      throw new Error("EMBEDDING_VECTOR_INVALID");
    return normalizedVector(embedding);
  }

  async #send(
    request: EmbeddingRequest,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<EmbeddingResponse> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.baseUrl.replace(/\/+$/u, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.#options.apiKey()}`,
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
