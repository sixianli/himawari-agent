import {
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import type { ControlCenterRuntimeConfiguration } from "./gateway-client.js";

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function base(
  configuration: ControlCenterRuntimeConfiguration,
  kind: "command" | "query",
  type: string,
) {
  return {
    schemaVersion: "gateway.v2" as const,
    kind,
    type,
    messageId: id("message"),
    correlationId: id("correlation"),
    causationId: null,
    dataClassification: "private" as const,
    risk: "low" as const,
    authorizationRef: null,
    scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
    authority: {
      deploymentId: configuration.deploymentId,
      authorityEpoch: configuration.authorityEpoch,
      fencingToken: configuration.fencingToken,
    },
    actor: { actorType: "owner" as const, actorId: configuration.actorId },
  };
}

export function queryMessage(
  configuration: ControlCenterRuntimeConfiguration,
  type:
    | "thread.list"
    | "thread.timeline"
    | "approval.list"
    | "task.list"
    | "inbox.list"
    | "memory.search"
    | "trace.timeline"
    | "identity.sessions"
    | "health.status",
  payload: unknown,
): GatewayV2Query {
  const parsed = gatewayV2MessageSchema.parse({
    ...base(configuration, "query", type),
    payload,
  });
  if (parsed.kind !== "query") throw new Error("CONTROL_CENTER_QUERY_INVALID");
  return parsed;
}

export function commandMessage(
  configuration: ControlCenterRuntimeConfiguration,
  type:
    | "thread.message.submit"
    | "thread.checkpoint.request"
    | "approval.respond"
    | "task.set_state"
    | "github.monitor.set_state"
    | "memory.mutate"
    | "session.revoke",
  payload: unknown,
  options: { readonly risk?: "low" | "medium" | "high"; readonly authorizationRef?: string } = {},
): GatewayV2Command {
  const parsed = gatewayV2MessageSchema.parse({
    ...base(configuration, "command", type),
    risk: options.risk ?? "low",
    authorizationRef: options.authorizationRef ?? null,
    idempotencyKey: id("idempotency"),
    payload,
  });
  if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_COMMAND_INVALID");
  return parsed;
}
