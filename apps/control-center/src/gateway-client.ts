import {
  type GatewayCommand,
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  gatewayV2MessageSchema,
  gatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";

export type MutationStatus = "pending" | "accepted" | "rejected" | "expired" | "replayed";

export interface GatewayClientMutationResult {
  readonly resultRef: string;
  readonly replayed: boolean;
  readonly status: MutationStatus;
}

export interface GatewayClientOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly csrfToken: () => string;
}

export interface ControlCenterRuntimeConfiguration {
  readonly ownerId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly actorId: string;
  readonly csrfToken: string;
}

export async function loadRuntimeConfiguration(
  fetchImplementation: typeof globalThis.fetch,
): Promise<ControlCenterRuntimeConfiguration> {
  const body = await json(
    await fetchImplementation("/api/control-center/v1/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }),
  );
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("CONTROL_CENTER_CONFIGURATION_INVALID");
  }
  const value = body as {
    readonly ownerId?: unknown;
    readonly agentId?: unknown;
    readonly deploymentId?: unknown;
    readonly authorityEpoch?: unknown;
    readonly fencingToken?: unknown;
    readonly actorId?: unknown;
    readonly csrfToken?: unknown;
  };
  for (const key of ["ownerId", "agentId", "deploymentId", "actorId", "csrfToken"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("CONTROL_CENTER_CONFIGURATION_INVALID");
    }
  }
  if (
    !Number.isSafeInteger(value.authorityEpoch) ||
    (value.authorityEpoch as number) < 1 ||
    !Number.isSafeInteger(value.fencingToken) ||
    (value.fencingToken as number) < 1
  ) {
    throw new Error("CONTROL_CENTER_CONFIGURATION_INVALID");
  }
  return Object.freeze(value as unknown as ControlCenterRuntimeConfiguration);
}

function parsedResponseBody(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
  if (parsed.kind !== "snapshot") throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  return parsed;
}

function mutationResult(value: unknown): GatewayClientMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  }
  const record = value as { readonly resultRef?: unknown; readonly replayed?: unknown };
  if (typeof record.resultRef !== "string" || typeof record.replayed !== "boolean") {
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  }
  return Object.freeze({
    resultRef: record.resultRef,
    replayed: record.replayed,
    status: record.replayed ? "replayed" : "accepted",
  });
}

async function json(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
    const error = new Error(typeof code === "string" ? code : "CONTROL_CENTER_REQUEST_REJECTED");
    Object.assign(error, { status: response.status });
    throw error;
  }
  return body;
}

export class GatewayClient {
  private readonly options: GatewayClientOptions;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  async query(message: GatewayV2Query): Promise<GatewayV2Snapshot> {
    const parsed = gatewayV2MessageSchema.parse(message);
    if (parsed.kind !== "query") throw new Error("CONTROL_CENTER_QUERY_INVALID");
    const response = await this.options.fetch("/api/gateway/v2/queries", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: gatewayV2MessageSchema.serialize(parsed),
    });
    return parsedResponseBody(await json(response));
  }

  async mutate(message: GatewayV2Command): Promise<GatewayClientMutationResult> {
    const parsed = gatewayV2MessageSchema.parse(message);
    if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_COMMAND_INVALID");
    const response = await this.options.fetch("/api/gateway/v2/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": parsed.idempotencyKey,
        "x-csrf-token": this.options.csrfToken(),
      },
      body: gatewayV2MessageSchema.serialize(parsed),
    });
    return mutationResult(await json(response));
  }

  async mutateV1(message: GatewayCommand): Promise<GatewayClientMutationResult> {
    const parsed = gatewayMessageSchema.parse(message);
    if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_COMMAND_INVALID");
    const response = await this.options.fetch("/api/gateway/v1/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": parsed.idempotencyKey,
        "x-csrf-token": this.options.csrfToken(),
      },
      body: gatewayMessageSchema.serialize(parsed),
    });
    return mutationResult(await json(response));
  }

  async protectText(
    content: string,
    dataClassification: "public" | "private" | "sensitive" | "restricted" = "private",
  ): Promise<string> {
    if (content.length === 0 || content.length > 64 * 1024) {
      throw new Error("CONTROL_CENTER_PAYLOAD_INVALID");
    }
    const response = await this.options.fetch("/api/payload/v1/text", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.options.csrfToken(),
      },
      body: JSON.stringify({ content, dataClassification }),
    });
    const body = await json(response);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { payloadRef?: unknown }).payloadRef !== "string"
    ) {
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    }
    return (body as { payloadRef: string }).payloadRef;
  }
}

export interface SafeBrowserLogEntry {
  readonly code: string;
  readonly messageType: string | null;
  readonly messageId: string | null;
  readonly cursor: string | null;
}

export function safeBrowserLog(
  code: string,
  message?: { readonly type?: unknown; readonly messageId?: unknown; readonly payload?: unknown },
): SafeBrowserLogEntry {
  const payload =
    message?.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? (message.payload as { readonly cursor?: unknown })
      : undefined;
  return Object.freeze({
    code,
    messageType: typeof message?.type === "string" ? message.type : null,
    messageId: typeof message?.messageId === "string" ? message.messageId : null,
    cursor: typeof payload?.cursor === "string" ? payload.cursor : null,
  });
}
