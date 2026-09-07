// biome-ignore-all lint/complexity/useLiteralKeys: untrusted provider records require index access
import type { ProductConfiguration } from "@himawari-agent/application";
import { redactMachineSecrets } from "@himawari-agent/application/runtime-port";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PROBE_BAD_OBJECT");
  return value as Record<string, unknown>;
}

export interface ProbeRequest {
  model: string;
  kind: "generation" | "embedding";
  status: number | null;
  maxTokens: number | null;
  providerRouting: unknown;
  toolDefinitions: number;
  toolResults: number;
  reservedCostMicros: number;
  responseModel: string | null;
  error: string | null;
  retryAfter: string | null;
}

/** Test-only outbound guard. Reservations survive failed requests and cannot fund retries. */
export function boundedOpenRouterFetch(
  configuration: ProductConfiguration,
  send: typeof globalThis.fetch,
  signal: AbortSignal,
  priorReservationMicros = 0,
) {
  const requests: ProbeRequest[] = [];
  if (!Number.isSafeInteger(priorReservationMicros) || priorReservationMicros < 0) {
    throw new Error("PROBE_INVALID_PRIOR_RESERVATION");
  }
  let reserved = priorReservationMicros;
  let metadataRequests = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    if (url.origin !== "https://openrouter.ai" || url.username || url.password) {
      throw new Error("PROBE_ENDPOINT_DENIED");
    }
    signal.throwIfAborted();
    const options = {
      ...init,
      redirect: "error" as const,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    };
    if (url.pathname === "/api/v1/generation" && (init?.method ?? "GET") === "GET") {
      if (++metadataRequests > 12) throw new Error("PROBE_METADATA_LIMIT");
      return send(input, options);
    }
    const kind =
      url.pathname === "/api/v1/chat/completions"
        ? "generation"
        : url.pathname === "/api/v1/embeddings"
          ? "embedding"
          : null;
    if (!kind || init?.method !== "POST" || typeof init.body !== "string" || url.search) {
      throw new Error("PROBE_REQUEST_DENIED");
    }
    if (Buffer.byteLength(init.body) > 32768) throw new Error("PROBE_INPUT_LIMIT");
    const body = record(JSON.parse(init.body));
    const descriptor = configuration.modelDescriptors.find(
      (model) => model.model === body["model"],
    );
    if (!descriptor || (descriptor["role"] === "embedding") !== (kind === "embedding")) {
      throw new Error("PROBE_MODEL_DENIED");
    }
    let cost: number;
    let maxTokens: number | null = null;
    if (descriptor["role"] === "embedding") {
      if (body["dimensions"] !== descriptor["dimensions"] || typeof body["input"] !== "string") {
        throw new Error("PROBE_EMBEDDING_SHAPE");
      }
      if (Buffer.byteLength(body["input"]) > 16384) throw new Error("PROBE_EMBEDDING_INPUT_LIMIT");
      cost = Math.ceil(16384 * descriptor.cost.input);
    } else {
      const maximum = body["max_tokens"] ?? body["max_completion_tokens"];
      if (maximum !== 2048 || body["stream"] !== true) throw new Error("PROBE_OUTPUT_LIMIT");
      if (JSON.stringify(body["provider"]) !== JSON.stringify(descriptor.providerRouting)) {
        throw new Error("PROBE_ROUTING_MISMATCH");
      }
      maxTokens = maximum;
      cost = Math.ceil(
        descriptor.contextWindow * Math.max(descriptor.cost.input, descriptor.cost.cacheRead) +
          maximum * descriptor.cost.output,
      );
    }
    if (requests.filter((request) => request.kind === kind).length >= 3) {
      throw new Error("PROBE_CALL_LIMIT");
    }
    if (reserved + cost > Math.min(1_000_000, configuration.budgets.globalCostMicros)) {
      throw new Error("PROBE_BUDGET_LIMIT");
    }
    reserved += cost;
    const observation: ProbeRequest = {
      model: descriptor["model"],
      kind,
      status: null,
      maxTokens,
      providerRouting: body["provider"] ?? null,
      toolDefinitions: Array.isArray(body["tools"]) ? body["tools"].length : 0,
      toolResults: Array.isArray(body["messages"])
        ? body["messages"].filter((message) => record(message)["role"] === "tool").length
        : 0,
      reservedCostMicros: cost,
      responseModel: null,
      error: null,
      retryAfter: null,
    };
    requests.push(observation);
    const response = await send(input, options);
    observation.status = response.status;
    observation.retryAfter = response.headers.get("retry-after");
    if (!response.ok) {
      const failure = await response
        .clone()
        .json()
        .catch(() => null);
      if (failure) {
        const detail = record(failure)["error"];
        if (detail && typeof detail === "object") {
          const message = record(detail)["message"];
          if (typeof message === "string")
            observation.error = redactMachineSecrets(message).slice(0, 500);
        }
      }
    }
    if (kind === "embedding" && response.ok) {
      const result = record(await response.clone().json());
      observation.responseModel = typeof result["model"] === "string" ? result["model"] : null;
    }
    return response;
  };
  return { fetch, requests, reservedCostMicros: () => reserved };
}
