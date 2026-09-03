import {
  type GatewayV2Command,
  type GatewayV2Query,
  type ThreadGatewayCommand,
  type ThreadGatewayQuery,
  type ThreadGatewaySubscription,
  gatewayV2MessageSchema,
  threadGatewayMessageSchema,
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
  type: GatewayV2Query["type"],
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
  type: GatewayV2Command["type"],
  payload: unknown,
  options: {
    readonly risk?: "low" | "medium" | "high" | "critical";
    readonly authorizationRef?: string;
    readonly idempotencyKey?: string;
  } = {},
): GatewayV2Command {
  const parsed = gatewayV2MessageSchema.parse({
    ...base(configuration, "command", type),
    risk: options.risk ?? "low",
    authorizationRef: options.authorizationRef ?? null,
    idempotencyKey: options.idempotencyKey ?? id("idempotency"),
    payload,
  });
  if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_COMMAND_INVALID");
  return parsed;
}

function threadBase(
  configuration: ControlCenterRuntimeConfiguration,
  kind: "command" | "query" | "subscription",
  type: string,
) {
  return {
    schemaVersion: "gateway.thread.v3" as const,
    kind,
    type,
    messageId: id("message"),
    correlationId: id("correlation"),
    causationId: null,
    scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
    authority: {
      deploymentId: configuration.deploymentId,
      authorityEpoch: configuration.authorityEpoch,
      fencingToken: configuration.fencingToken,
    },
    actor: { actorType: "owner" as const, actorId: configuration.actorId },
  };
}

export function threadQueryMessage(
  configuration: ControlCenterRuntimeConfiguration,
  type:
    | "thread.list"
    | "thread.detail"
    | "thread.search"
    | "thread.lineage"
    | "thread.checkpoint"
    | "thread.deletion_impact",
  payload: unknown,
): ThreadGatewayQuery {
  const parsed = threadGatewayMessageSchema.parse({
    ...threadBase(configuration, "query", type),
    payload,
  });
  if (parsed.kind !== "query") throw new Error("CONTROL_CENTER_THREAD_QUERY_INVALID");
  return parsed;
}

export function threadCommandMessage(
  configuration: ControlCenterRuntimeConfiguration,
  type:
    | "thread.create"
    | "thread.message.submit"
    | "thread.rename"
    | "thread.pin"
    | "thread.archive"
    | "thread.restore"
    | "thread.fork"
    | "thread.set_answer_locale"
    | "thread.trash"
    | "thread.delete_permanently"
    | "thread.task.resolve",
  payload: unknown,
  idempotencyKey: string,
): ThreadGatewayCommand {
  const parsed = threadGatewayMessageSchema.parse({
    ...threadBase(configuration, "command", type),
    idempotencyKey,
    payload,
  });
  if (parsed.kind !== "command") throw new Error("CONTROL_CENTER_THREAD_COMMAND_INVALID");
  return parsed;
}

export function threadSubscriptionMessage(
  configuration: ControlCenterRuntimeConfiguration,
  afterCursor: string | null,
): ThreadGatewaySubscription {
  const parsed = threadGatewayMessageSchema.parse({
    ...threadBase(configuration, "subscription", "thread.events"),
    payload: { afterCursor },
  });
  if (parsed.kind !== "subscription") {
    throw new Error("CONTROL_CENTER_THREAD_SUBSCRIPTION_INVALID");
  }
  return parsed;
}
