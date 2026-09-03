import type { DataClassification } from "@himawari-agent/gateway-contracts";
import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface AutonomyScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export type { DataClassification };

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type PayloadRef = string;
export type TraceEventId = string;
export type CorrelationId = string;
export type CausationId = string;

export const PORT_ERROR_CODES = Object.freeze({
  CONFLICT: "PORT_CONFLICT",
  NOT_FOUND: "PORT_NOT_FOUND",
  DUPLICATE: "PORT_DUPLICATE",
  INVALID_OPERATION: "PORT_INVALID_OPERATION",
  NOT_AUTHORITATIVE: "PORT_NOT_AUTHORITATIVE",
  PROVIDER_FAILURE: "PORT_PROVIDER_FAILURE",
  HANDLE_REVOKED: "PORT_HANDLE_REVOKED",
  INJECTED_FAILURE: "PORT_INJECTED_FAILURE",
} as const);

export type PortErrorCode = (typeof PORT_ERROR_CODES)[keyof typeof PORT_ERROR_CODES];

export class ApplicationPortError extends Error {
  readonly code: PortErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: PortErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApplicationPortError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
