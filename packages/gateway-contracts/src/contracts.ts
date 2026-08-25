import {
  ContractValidationError,
  type InferSchema,
  type Schema,
  array,
  enumeration,
  integer,
  literal,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "./validation.js";

export const GATEWAY_SCHEMA_VERSION = "gateway.v1" as const;
export const DATA_CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
export const GATEWAY_MESSAGE_TYPES = [
  "trigger.admit",
  "thread.create",
  "thread.close",
  "run.cancel",
  "approval.respond",
  "thread.get_snapshot",
  "run.get_snapshot",
  "trace.query",
  "events.subscribe",
  "thread.snapshot",
  "run.snapshot",
  "stream.event",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];
export type GatewayMessageType = (typeof GATEWAY_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(DATA_CLASSIFICATIONS);
const actorSchema = object({
  actorType: enumeration(["owner", "client", "scheduler", "external_adapter", "system"]),
  actorId: machineString,
});
const scopeSchema = object({ ownerId: machineString, agentId: machineString });

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(GATEWAY_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    dataClassification: classificationSchema,
    scope: scopeSchema,
    actor: actorSchema,
  } as const;
}

function commandEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("command", type), idempotencyKey: machineString } as const;
}

export const admitTriggerCommandSchema = object({
  ...commandEnvelope("trigger.admit"),
  payload: object({
    triggerId: machineString,
    sourceType: enumeration(["user_message", "schedule", "external_event"]),
    sourceId: machineString,
    occurredAt: timestamp,
    threadId: nullable(machineString),
    payloadRef: machineString,
    sourceProofRef: machineString,
  }),
});

export const createThreadCommandSchema = object({
  ...commandEnvelope("thread.create"),
  payload: object({ threadId: machineString, metadataRef: nullable(machineString) }),
});

export const closeThreadCommandSchema = object({
  ...commandEnvelope("thread.close"),
  payload: object({ threadId: machineString, reasonCode: machineString }),
});

export const cancelRunCommandSchema = object({
  ...commandEnvelope("run.cancel"),
  payload: object({ runId: machineString, reasonCode: machineString }),
});

export const respondApprovalCommandSchema = object({
  ...commandEnvelope("approval.respond"),
  payload: object({
    approvalRequestId: machineString,
    runId: machineString,
    decision: enumeration(["approved", "denied"]),
    semanticSnapshotHash: machineString,
  }),
});

export const getThreadSnapshotQuerySchema = object({
  ...envelope("query", "thread.get_snapshot"),
  payload: object({ threadId: machineString }),
});

export const getRunSnapshotQuerySchema = object({
  ...envelope("query", "run.get_snapshot"),
  payload: object({ runId: machineString }),
});

export const traceQuerySchema = object({
  ...envelope("query", "trace.query"),
  payload: object({
    sessionId: machineString,
    runId: nullable(machineString),
    afterSequence: integer(0),
    limit: integer(1, 1000),
  }),
});

export const eventSubscriptionSchema = object({
  ...envelope("subscription", "events.subscribe"),
  payload: object({
    subscriptionId: machineString,
    sessionId: nullable(machineString),
    threadId: nullable(machineString),
    runId: nullable(machineString),
    afterCursor: nullable(machineString),
  }),
});

export const threadSnapshotSchema = object({
  ...envelope("snapshot", "thread.snapshot"),
  payload: object({
    threadId: machineString,
    status: enumeration(["open", "closed"]),
    revision: integer(0),
    sessionIds: array(machineString),
    runIds: array(machineString),
  }),
});

export const runSnapshotSchema = object({
  ...envelope("snapshot", "run.snapshot"),
  payload: object({
    runId: machineString,
    threadId: nullable(machineString),
    sessionId: machineString,
    triggerId: machineString,
    status: enumeration([
      "accepted",
      "building_context",
      "running",
      "awaiting_approval",
      "reconciling_external_result",
      "completed",
      "failed",
      "cancelled",
    ]),
    revision: integer(0),
    latestSequence: integer(0),
    activeApprovalRequestId: nullable(machineString),
  }),
});

export const streamEventSchema = object({
  ...envelope("event", "stream.event"),
  payload: object({
    cursor: machineString,
    sessionId: machineString,
    threadId: nullable(machineString),
    runId: machineString,
    turnId: nullable(machineString),
    parentEventId: nullable(machineString),
    sequence: integer(1),
    occurredAt: timestamp,
    recordedAt: timestamp,
    eventType: machineString,
    payloadRef: nullable(machineString),
  }),
});

const schemasByType = {
  "trigger.admit": admitTriggerCommandSchema,
  "thread.create": createThreadCommandSchema,
  "thread.close": closeThreadCommandSchema,
  "run.cancel": cancelRunCommandSchema,
  "approval.respond": respondApprovalCommandSchema,
  "thread.get_snapshot": getThreadSnapshotQuerySchema,
  "run.get_snapshot": getRunSnapshotQuerySchema,
  "trace.query": traceQuerySchema,
  "events.subscribe": eventSubscriptionSchema,
  "thread.snapshot": threadSnapshotSchema,
  "run.snapshot": runSnapshotSchema,
  "stream.event": streamEventSchema,
} as const satisfies Record<GatewayMessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type AdmitTriggerCommand = InferSchema<typeof admitTriggerCommandSchema>;
export type CreateThreadCommand = InferSchema<typeof createThreadCommandSchema>;
export type CloseThreadCommand = InferSchema<typeof closeThreadCommandSchema>;
export type CancelRunCommand = InferSchema<typeof cancelRunCommandSchema>;
export type RespondApprovalCommand = InferSchema<typeof respondApprovalCommandSchema>;
export type GetThreadSnapshotQuery = InferSchema<typeof getThreadSnapshotQuerySchema>;
export type GetRunSnapshotQuery = InferSchema<typeof getRunSnapshotQuerySchema>;
export type TraceQuery = InferSchema<typeof traceQuerySchema>;
export type EventSubscription = InferSchema<typeof eventSubscriptionSchema>;
export type ThreadSnapshot = InferSchema<typeof threadSnapshotSchema>;
export type RunSnapshot = InferSchema<typeof runSnapshotSchema>;
export type StreamEvent = InferSchema<typeof streamEventSchema>;
export type GatewayMessage = InferSchema<SchemaByType[keyof SchemaByType]>;
export type GatewayCommand = Extract<GatewayMessage, { kind: "command" }>;
export type GatewayQuery = Extract<GatewayMessage, { kind: "query" }>;
export type GatewaySnapshot = Extract<GatewayMessage, { kind: "snapshot" }>;

function readType(input: unknown): GatewayMessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected a Gateway message object");
  }
  const type = (input as { readonly type?: unknown }).type;
  return enumeration(GATEWAY_MESSAGE_TYPES).parse(type, "$.type");
}

export const gatewayMessageSchema = Object.freeze({
  schemaVersion: GATEWAY_SCHEMA_VERSION,
  parse(input: unknown): GatewayMessage {
    return parseGatewayMessage(input);
  },
  parseJson(json: string): GatewayMessage {
    return parseJson({ parse: parseGatewayMessage }, json);
  },
  serialize(message: GatewayMessage): string {
    return JSON.stringify(parseGatewayMessage(message));
  },
});

function parseGatewayMessage(input: unknown): GatewayMessage {
  const type = readType(input);
  return schemasByType[type].parse(input, "$") as GatewayMessage;
}
