import type { FetchFunction } from "@earendil-works/pi-ai";
import {
  type ModelProviderRouting,
  usdCostsEqual,
  usdCostToMicros,
} from "@himawari-agent/application/runtime-port";

export interface GatewayBilling {
  readonly generationId: string;
  readonly provider: string;
  readonly model: string;
  readonly costMicros: number;
  readonly costUsd: string | number;
}

export type GatewayObservation =
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "verified"; readonly billing: GatewayBilling };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
}

function billingFrame(data: Record<string, unknown>, expectedModel: string): GatewayObservation {
  if (data["model"] !== undefined && data["model"] !== expectedModel) return { status: "invalid" };
  const usage = record(data["usage"]);
  const choices = data["choices"];
  const choice = Array.isArray(choices)
    ? choices.map(record).find((value) => value?.["index"] === 0)
    : undefined;
  const delta = record(choice?.["delta"]);
  const message = record(choice?.["message"]);
  const metadata = record(delta?.["provider_metadata"] ?? message?.["provider_metadata"]);
  const gateway = record(metadata?.["gateway"]);
  if (!Object.hasOwn(usage ?? {}, "cost") && gateway === undefined) return { status: "missing" };
  const generationId = gateway?.["generationId"];
  const provider = record(gateway?.["routing"])?.["finalProvider"];
  const metadataCost = gateway?.["cost"];
  const usageCost = usage?.["cost"];
  if (
    data["model"] !== expectedModel ||
    !identifier(generationId) ||
    !identifier(provider) ||
    (typeof usageCost !== "string" && typeof usageCost !== "number")
  ) {
    return { status: "invalid" };
  }
  try {
    if (!usdCostsEqual(usageCost, metadataCost)) return { status: "invalid" };
    return {
      status: "verified",
      billing: Object.freeze({
        generationId,
        provider,
        model: expectedModel,
        costMicros: usdCostToMicros(usageCost),
        costUsd: usageCost,
      }),
    };
  } catch {
    return { status: "invalid" };
  }
}

async function observeResponse(
  response: Response,
  expectedModel: string,
): Promise<GatewayObservation> {
  if (response.body === null) return { status: "missing" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let observation: GatewayObservation = { status: "missing" };
  let ended = false;
  const observeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0) return;
    if (ended) {
      observation = { status: "invalid" };
      return;
    }
    if (payload === "[DONE]") {
      ended = true;
      return;
    }
    try {
      const data = record(JSON.parse(payload));
      if (data === undefined) {
        observation = { status: "invalid" };
        return;
      }
      const current = billingFrame(data, expectedModel);
      if (observation.status === "invalid" || current.status === "missing") return;
      if (current.status === "invalid") {
        observation = current;
      } else if (observation.status === "verified") {
        const previous = observation.billing;
        const next = current.billing;
        if (
          previous.generationId !== next.generationId ||
          previous.provider !== next.provider ||
          previous.model !== next.model ||
          !usdCostsEqual(previous.costUsd, next.costUsd)
        ) {
          observation = { status: "invalid" };
        }
      } else {
        observation = current;
      }
    } catch {
      observation = { status: "invalid" };
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
    return ended ? observation : { status: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

export function observeGatewayFetch(
  fetch: FetchFunction,
  expectedModel: string,
): {
  readonly fetch: FetchFunction;
  readonly result: () => Promise<GatewayObservation>;
} {
  let sent = false;
  let repeated = false;
  let observation: Promise<GatewayObservation> = Promise.resolve({ status: "missing" });
  return {
    fetch: async (input, init) => {
      if (sent) {
        repeated = true;
        throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
      }
      sent = true;
      const response = await fetch(input, init);
      if (response.ok && response.body !== null) {
        observation = observeResponse(response.clone(), expectedModel).catch(() => ({
          status: "invalid",
        }));
      }
      return response;
    },
    result: async () => {
      const result = await observation;
      return repeated ? { status: "invalid" } : result;
    },
  };
}

export function gatewayPayload(
  payload: unknown,
  routing: ModelProviderRouting | undefined,
): unknown {
  const body = record(payload);
  if (body === undefined || routing === undefined)
    throw new Error("AI_GATEWAY_ROUTING_UNAVAILABLE");
  return {
    ...body,
    providerOptions: {
      ...record(body["providerOptions"]),
      gateway: { order: [...routing.order], sort: routing.sort },
    },
  };
}
