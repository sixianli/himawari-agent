import { createHash, randomUUID } from "node:crypto";
import type {
  AgentGatewayPort,
  AgentGatewayV2Port,
  AgentThreadGatewayPort,
  AuditLedgerPort,
  GatewayAuthenticationContext,
  GatewayRequestMessage,
  GatewayV2InboundMessage,
  ThreadGatewayRequestMessage,
} from "@himawari-agent/application";
import {
  CLIENT_GATEWAY_SCHEMAS,
  CLIENT_GATEWAYS,
  type ClientCapabilityEntry,
  type ClientCapabilityTier,
  type ClientGateway,
  findClientCapability,
  requiredClientTier,
} from "@himawari-agent/gateway-contracts";

export const DEVICE_GATEWAY_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: "DEVICE_GATEWAY_REQUEST_INVALID",
  TYPE_UNKNOWN: "DEVICE_GATEWAY_TYPE_UNKNOWN",
  NOT_ON_PHONE: "DEVICE_GATEWAY_NOT_ON_PHONE",
  CONFIRM_REQUIRED: "DEVICE_GATEWAY_CONFIRM_REQUIRED",
  GATEWAY_UNAVAILABLE: "DEVICE_GATEWAY_UNAVAILABLE",
  HOME_ACTION_STALE: "DEVICE_HOME_ACTION_STALE",
  HOME_ACTION_INVALID: "DEVICE_HOME_ACTION_INVALID",
} as const);

export type DeviceGatewayErrorCode =
  (typeof DEVICE_GATEWAY_ERROR_CODES)[keyof typeof DEVICE_GATEWAY_ERROR_CODES];

export class DeviceGatewayError extends Error {
  readonly code: DeviceGatewayErrorCode;
  readonly statusCode: number;

  constructor(code: DeviceGatewayErrorCode, statusCode: number) {
    super(code);
    this.name = "DeviceGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface DeviceGateways {
  readonly v1?: AgentGatewayPort;
  readonly v2?: AgentGatewayV2Port;
  readonly "thread-v3"?: AgentThreadGatewayPort;
}

export interface DeviceGatewayAuthority {
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface DeviceGatewayAuditFailure {
  readonly action: string;
  readonly targetRef: string;
  readonly outcome: "completed" | "failed";
  readonly error: unknown;
}

export interface DeviceGatewayRequest {
  readonly entry: ClientCapabilityEntry;
  readonly tier: Exclude<ClientCapabilityTier, "not_on_phone">;
  readonly body: Readonly<Record<string, unknown>>;
}

const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RECENT_AUTHENTICATION_KEY = "recentAuthenticationRef";
const AUTHORIZATION_KEY = "authorizationRef";
export const SERVER_FILLED_PAYLOAD_KEYS = [AUTHORIZATION_KEY, RECENT_AUTHENTICATION_KEY] as const;
export const DEVICE_REFERENCE_PLACEHOLDER = "device";

const BODY_KEYS: Readonly<Record<ClientGateway, readonly string[]>> = Object.freeze({
  v1: ["gateway", "type", "messageId", "idempotencyKey", "dataClassification", "payload"],
  v2: ["gateway", "type", "messageId", "idempotencyKey", "dataClassification", "risk", "payload"],
  "thread-v3": ["gateway", "type", "messageId", "idempotencyKey", "payload"],
});

function invalid(): never {
  throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
}

export function classifyDeviceGatewayRequest(body: Record<string, unknown>): DeviceGatewayRequest {
  const gateway = body["gateway"];
  if (typeof gateway !== "string" || !(CLIENT_GATEWAYS as readonly string[]).includes(gateway))
    invalid();
  const allowed = BODY_KEYS[gateway as ClientGateway];
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid();
  const type = body["type"];
  if (typeof type !== "string") invalid();
  const entry = findClientCapability(gateway as ClientGateway, type);
  if (!entry) throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.TYPE_UNKNOWN, 404);
  if (entry.tier === "not_on_phone")
    throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.NOT_ON_PHONE, 403);
  if (typeof body["messageId"] !== "string" || !MACHINE_STRING.test(body["messageId"])) invalid();
  const hasIdempotencyKey = Object.hasOwn(body, "idempotencyKey");
  if (entry.kind === "command") {
    if (typeof body["idempotencyKey"] !== "string" || !MACHINE_STRING.test(body["idempotencyKey"]))
      invalid();
  } else if (hasIdempotencyKey) invalid();
  const payload = body["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid();
  if (
    SERVER_FILLED_PAYLOAD_KEYS.some(
      (key) =>
        Object.hasOwn(payload, key) &&
        (payload as Record<string, unknown>)[key] !== DEVICE_REFERENCE_PLACEHOLDER,
    )
  )
    invalid();
  const tier = requiredClientTier(entry, payload);
  return { entry, tier: tier as DeviceGatewayRequest["tier"], body };
}

function correlation(deviceId: string, messageId: string): string {
  return `device:${createHash("sha256").update(`${deviceId}\n${messageId}`).digest("hex").slice(0, 40)}`;
}

function withServerFilledReferences(
  payload: Record<string, unknown>,
  authentication: GatewayAuthenticationContext,
  confirmed: boolean,
): Record<string, unknown> {
  const filled = { ...payload };
  if (Object.hasOwn(payload, AUTHORIZATION_KEY))
    filled[AUTHORIZATION_KEY] = authentication.authenticationRef;
  if (Object.hasOwn(payload, RECENT_AUTHENTICATION_KEY))
    filled[RECENT_AUTHENTICATION_KEY] =
      confirmed && authentication.recentAuthenticationEvidence
        ? authentication.authenticationRef
        : null;
  return filled;
}

export async function dispatchDeviceGatewayRequest(input: {
  readonly request: DeviceGatewayRequest;
  readonly confirmed: boolean;
  readonly notificationAction?: boolean;
  readonly pairedDeviceId: string;
  readonly authentication: GatewayAuthenticationContext;
  readonly authority: DeviceGatewayAuthority;
  readonly gateways: DeviceGateways;
  readonly audit: AuditLedgerPort;
  readonly onAuditFailed?: (failure: DeviceGatewayAuditFailure) => void;
  readonly auditAction?: string;
  readonly now: () => Date;
}): Promise<unknown> {
  if (input.request.tier === "change" && !input.confirmed && !input.notificationAction)
    throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.CONFIRM_REQUIRED, 403);
  if (input.request.tier === "read" || input.request.tier === "routine") return forward(input);
  const attempt = randomUUID();
  const action = input.notificationAction
    ? "device.notification.action"
    : (input.auditAction ?? `device.gateway.${input.request.tier}`);
  const targetRef = `${input.pairedDeviceId}:${input.request.entry.gateway}:${input.request.entry.type}`;
  const record = (outcome: "accepted" | "completed" | "failed") =>
    input.audit.append({
      id: `audit:device-gateway:${attempt}:${outcome}`,
      ownerId: input.authentication.ownerId as Parameters<AuditLedgerPort["append"]>[0]["ownerId"],
      agentId: input.authority.agentId as Parameters<AuditLedgerPort["append"]>[0]["agentId"],
      action,
      targetRef,
      outcome,
      occurredAt: input.now().toISOString(),
    });
  const settle = (outcome: "completed" | "failed") =>
    record(outcome).catch((error: unknown) =>
      Promise.resolve()
        .then(() => input.onAuditFailed?.({ action, targetRef, outcome, error }))
        .catch(() => undefined),
    );
  await record("accepted");
  let result: unknown;
  try {
    result = await forward(input);
  } catch (error) {
    await settle("failed");
    throw error;
  }
  await settle("completed");
  return result;
}

async function forward(input: {
  readonly request: DeviceGatewayRequest;
  readonly confirmed: boolean;
  readonly pairedDeviceId: string;
  readonly authentication: GatewayAuthenticationContext;
  readonly authority: DeviceGatewayAuthority;
  readonly gateways: DeviceGateways;
}): Promise<unknown> {
  const { request, authentication, authority } = input;
  const { entry, body } = request;
  const gateway = input.gateways[entry.gateway];
  if (!gateway) throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.GATEWAY_UNAVAILABLE, 503);
  const messageId = body["messageId"] as string;
  const common = {
    schemaVersion: CLIENT_GATEWAY_SCHEMAS[entry.gateway].schemaVersion,
    kind: entry.kind,
    type: entry.type,
    messageId,
    correlationId: correlation(input.pairedDeviceId, messageId),
    causationId: null,
    scope: { ownerId: authentication.ownerId, agentId: authority.agentId },
    actor: { actorType: "owner", actorId: authentication.ownerId },
    ...(entry.kind === "command" ? { idempotencyKey: body["idempotencyKey"] } : {}),
    payload: withServerFilledReferences(
      body["payload"] as Record<string, unknown>,
      authentication,
      input.confirmed,
    ),
  };
  const fence = {
    deploymentId: authority.deploymentId,
    authorityEpoch: authority.authorityEpoch,
    fencingToken: authority.fencingToken,
  };
  const schema = CLIENT_GATEWAY_SCHEMAS[entry.gateway].schema;
  switch (entry.gateway) {
    case "v1":
      return (gateway as AgentGatewayPort).request(
        authentication,
        schema.parse({
          ...common,
          dataClassification: body["dataClassification"],
        }) as GatewayRequestMessage,
      );
    case "v2":
      return (gateway as AgentGatewayV2Port).request(
        authentication,
        schema.parse({
          ...common,
          dataClassification: body["dataClassification"],
          risk: body["risk"],
          authorizationRef: entry.kind === "command" ? authentication.authenticationRef : null,
          authority: fence,
        }) as GatewayV2InboundMessage,
      );
    default:
      return (gateway as AgentThreadGatewayPort).request(
        authentication,
        schema.parse({ ...common, authority: fence }) as ThreadGatewayRequestMessage,
      );
  }
}
