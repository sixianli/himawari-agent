import {
  type GatewayCommand,
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  type ThreadGatewayCommand,
  type ThreadGatewayRequestResult,
  type ThreadGatewayQuery,
  type ThreadGatewaySnapshot,
  gatewayV2MessageSchema,
  gatewayMessageSchema,
  threadGatewayMessageSchema,
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
  readonly authorizationRef?: string | null;
  readonly recentAuthenticationRef?: string | null;
  readonly primaryModel?: {
    readonly provider: string;
    readonly model: string;
    readonly version: string;
  } | null;
  readonly primaryModelRef?: string | null;
  readonly repositoryAllowlistRefs?: readonly string[];
  readonly disclosedDataClassifications?: readonly (
    | "public"
    | "private"
    | "sensitive"
    | "restricted"
  )[];
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
    readonly authorizationRef?: unknown;
    readonly recentAuthenticationRef?: unknown;
    readonly primaryModel?: unknown;
    readonly primaryModelRef?: unknown;
    readonly repositoryAllowlistRefs?: unknown;
    readonly disclosedDataClassifications?: unknown;
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
  const primaryModel =
    value.primaryModel &&
    typeof value.primaryModel === "object" &&
    !Array.isArray(value.primaryModel)
      ? (value.primaryModel as { provider?: unknown; model?: unknown; version?: unknown })
      : null;
  const normalizedPrimary =
    primaryModel &&
    typeof primaryModel.provider === "string" &&
    typeof primaryModel.model === "string" &&
    typeof primaryModel.version === "string"
      ? Object.freeze({
          provider: primaryModel.provider,
          model: primaryModel.model,
          version: primaryModel.version,
        })
      : null;
  const repositoryAllowlistRefs = Array.isArray(value.repositoryAllowlistRefs)
    ? value.repositoryAllowlistRefs.filter((item): item is string => typeof item === "string")
    : [];
  const disclosedDataClassifications: ("public" | "private" | "sensitive" | "restricted")[] =
    Array.isArray(value.disclosedDataClassifications)
      ? value.disclosedDataClassifications.filter(
          (item): item is "public" | "private" | "sensitive" | "restricted" =>
            item === "public" ||
            item === "private" ||
            item === "sensitive" ||
            item === "restricted",
        )
      : ["private"];
  const primaryModelRef =
    typeof value.primaryModelRef === "string" && value.primaryModelRef.length > 0
      ? value.primaryModelRef
      : null;
  const authorizationRef =
    typeof value.authorizationRef === "string" && value.authorizationRef.length > 0
      ? value.authorizationRef
      : null;
  const recentAuthenticationRef =
    typeof value.recentAuthenticationRef === "string" && value.recentAuthenticationRef.length > 0
      ? value.recentAuthenticationRef
      : null;
  return Object.freeze({
    ...(value as unknown as Omit<
      ControlCenterRuntimeConfiguration,
      | "primaryModel"
      | "primaryModelRef"
      | "repositoryAllowlistRefs"
      | "disclosedDataClassifications"
      | "authorizationRef"
      | "recentAuthenticationRef"
    >),
    authorizationRef,
    recentAuthenticationRef,
    primaryModel: normalizedPrimary,
    primaryModelRef,
    repositoryAllowlistRefs: Object.freeze(repositoryAllowlistRefs),
    disclosedDataClassifications: Object.freeze(disclosedDataClassifications),
  });
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

function threadResponse(value: unknown): ThreadGatewayRequestResult {
  const parsed = threadGatewayMessageSchema.parse(value);
  if (!["snapshot", "result", "conflict"].includes(parsed.kind)) {
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  }
  return parsed as ThreadGatewayRequestResult;
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

  async queryThread(message: ThreadGatewayQuery): Promise<ThreadGatewaySnapshot> {
    const parsed = threadGatewayMessageSchema.parse(message);
    if (parsed.kind !== "query") throw new Error("CONTROL_CENTER_THREAD_QUERY_INVALID");
    const response = await this.options.fetch("/api/gateway/thread/v3/queries", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: threadGatewayMessageSchema.serialize(parsed),
    });
    const result = threadResponse(await json(response));
    if (result.kind !== "snapshot") throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    return result;
  }

  async mutateThread(message: ThreadGatewayCommand): Promise<ThreadGatewayRequestResult> {
    const parsed = threadGatewayMessageSchema.parse(message);
    if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_THREAD_COMMAND_INVALID");
    const response = await this.options.fetch("/api/gateway/thread/v3/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": parsed.idempotencyKey,
        "x-csrf-token": this.options.csrfToken(),
      },
      body: threadGatewayMessageSchema.serialize(parsed),
    });
    return threadResponse(await json(response));
  }

  async protectText(
    content: string,
    dataClassification: "public" | "private" | "sensitive" | "restricted" = "private",
    idempotencyKey = `payload:${crypto.randomUUID()}`,
  ): Promise<string> {
    if (content.length === 0 || content.length > 64 * 1024) {
      throw new Error("CONTROL_CENTER_PAYLOAD_INVALID");
    }
    const response = await this.options.fetch("/api/payload/v1/text", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
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

  async readText(payloadRef: string): Promise<{
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
  }> {
    const response = await this.options.fetch("/api/payload/v1/text/read", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.options.csrfToken(),
      },
      body: JSON.stringify({ payloadRef }),
    });
    const body = await json(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    }
    const value = body as {
      readonly content?: unknown;
      readonly dataClassification?: unknown;
      readonly contentType?: unknown;
    };
    if (
      typeof value.content !== "string" ||
      !["public", "private", "sensitive", "restricted"].includes(
        value.dataClassification as string,
      ) ||
      value.contentType !== "text/plain"
    ) {
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    }
    return Object.freeze({
      content: value.content,
      dataClassification: value.dataClassification as
        | "public"
        | "private"
        | "sensitive"
        | "restricted",
    });
  }

  async prepareThreadSearch(query: string): Promise<{
    readonly queryRef: string;
    readonly tokenRefs: readonly string[];
    readonly projectionVersion: string;
  }> {
    const response = await this.options.fetch("/api/thread-search/v1/prepare", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.options.csrfToken(),
      },
      body: JSON.stringify({ query }),
    });
    const body = await json(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    }
    const value = body as {
      readonly queryRef?: unknown;
      readonly tokenRefs?: unknown;
      readonly projectionVersion?: unknown;
    };
    if (
      typeof value.queryRef !== "string" ||
      !Array.isArray(value.tokenRefs) ||
      value.tokenRefs.length === 0 ||
      value.tokenRefs.some((token) => typeof token !== "string") ||
      typeof value.projectionVersion !== "string"
    ) {
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    }
    return Object.freeze({
      queryRef: value.queryRef,
      tokenRefs: Object.freeze(value.tokenRefs as string[]),
      projectionVersion: value.projectionVersion,
    });
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
