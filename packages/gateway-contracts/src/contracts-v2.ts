import {
  ContractValidationError,
  type InferSchema,
  type Schema,
  array,
  booleanValue,
  enumeration,
  integer,
  literal,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "./validation.js";

export const GATEWAY_V2_SCHEMA_VERSION = "gateway.v2" as const;
export const GATEWAY_V2_MESSAGE_TYPES = [
  "thread.message.submit",
  "thread.checkpoint.request",
  "approval.respond",
  "task.set_state",
  "memory.mutate",
  "session.revoke",
  "thread.list",
  "thread.timeline",
  "approval.list",
  "task.list",
  "inbox.list",
  "memory.search",
  "trace.timeline",
  "identity.sessions",
  "health.status",
  "collection.snapshot",
  "health.snapshot",
  "stream.event",
] as const;

export type GatewayV2MessageType = (typeof GATEWAY_V2_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(["public", "private", "sensitive", "restricted"]);
const riskSchema = enumeration(["low", "medium", "high", "critical"]);
const actorSchema = object({
  actorType: enumeration(["owner", "client", "scheduler", "external_adapter", "system"]),
  actorId: machineString,
});
const scopeSchema = object({ ownerId: machineString, agentId: machineString });
const authoritySchema = object({
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
});

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(GATEWAY_V2_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    dataClassification: classificationSchema,
    risk: riskSchema,
    authorizationRef: nullable(machineString),
    scope: scopeSchema,
    authority: authoritySchema,
    actor: actorSchema,
  } as const;
}

function commandEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("command", type), idempotencyKey: machineString } as const;
}

export const submitThreadMessageCommandSchema = object({
  ...commandEnvelope("thread.message.submit"),
  payload: object({
    threadId: machineString,
    messageId: machineString,
    contentRef: machineString,
    clientCreatedAt: timestamp,
  }),
});

export const requestThreadCheckpointCommandSchema = object({
  ...commandEnvelope("thread.checkpoint.request"),
  payload: object({
    threadId: machineString,
    sourceWatermark: integer(1),
    policyVersion: machineString,
  }),
});

export const respondApprovalV2CommandSchema = object({
  ...commandEnvelope("approval.respond"),
  payload: object({
    approvalRequestId: machineString,
    decision: enumeration(["approved", "denied"]),
    semanticSnapshotHash: machineString,
    editedPayloadRef: nullable(machineString),
  }),
});

export const setTaskStateCommandSchema = object({
  ...commandEnvelope("task.set_state"),
  payload: object({
    jobId: machineString,
    action: enumeration(["pause", "resume", "revoke"]),
    reasonCode: machineString,
  }),
});

const memoryMutationPayloadSchema = object({
  memoryId: machineString,
  action: enumeration(["correct", "archive", "delete"]),
  expectedRevision: integer(0),
  contentRef: nullable(machineString),
});

export const mutateMemoryCommandSchema = object({
  ...commandEnvelope("memory.mutate"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = memoryMutationPayloadSchema.parse(input, path);
      if (
        (payload.action === "correct" && payload.contentRef === null) ||
        (payload.action !== "correct" && payload.contentRef !== null)
      ) {
        throw new ContractValidationError(
          `${path}.contentRef`,
          "must be present only for a correction",
        );
      }
      return payload;
    },
  },
});

export const revokeSessionCommandSchema = object({
  ...commandEnvelope("session.revoke"),
  payload: object({
    sessionId: machineString,
    deviceId: machineString,
    recentAuthenticationRef: machineString,
    reasonCode: machineString,
  }),
});

const pagePayload = {
  afterCursor: nullable(machineString),
  limit: integer(1, 500),
} as const;

export const listThreadsQuerySchema = object({
  ...envelope("query", "thread.list"),
  payload: object(pagePayload),
});

export const threadTimelineQuerySchema = object({
  ...envelope("query", "thread.timeline"),
  payload: object({ threadId: machineString, afterSequence: integer(0), limit: integer(1, 1000) }),
});

export const listApprovalsQuerySchema = object({
  ...envelope("query", "approval.list"),
  payload: object({
    status: nullable(enumeration(["pending", "approved", "denied", "expired"])),
    ...pagePayload,
  }),
});

export const listTasksQuerySchema = object({
  ...envelope("query", "task.list"),
  payload: object({
    status: nullable(enumeration(["active", "paused", "revoked"])),
    ...pagePayload,
  }),
});

export const listInboxQuerySchema = object({
  ...envelope("query", "inbox.list"),
  payload: object({ unreadOnly: booleanValue, ...pagePayload }),
});

export const searchMemoryQuerySchema = object({
  ...envelope("query", "memory.search"),
  payload: object({
    queryRef: machineString,
    status: nullable(enumeration(["active", "archived", "trashed"])),
    limit: integer(1, 100),
  }),
});

export const traceTimelineV2QuerySchema = object({
  ...envelope("query", "trace.timeline"),
  payload: object({
    threadId: nullable(machineString),
    runId: nullable(machineString),
    afterSequence: integer(0),
    limit: integer(1, 1000),
  }),
});

export const identitySessionsQuerySchema = object({
  ...envelope("query", "identity.sessions"),
  payload: object({ includeRevoked: booleanValue, ...pagePayload }),
});

export const healthStatusQuerySchema = object({
  ...envelope("query", "health.status"),
  payload: object({ includeDependencies: booleanValue }),
});

export const collectionSnapshotSchema = object({
  ...envelope("snapshot", "collection.snapshot"),
  payload: object({
    category: enumeration([
      "threads",
      "messages",
      "approvals",
      "tasks",
      "inbox",
      "memories",
      "trace",
      "sessions",
      "devices",
    ]),
    itemRefs: array(machineString),
    nextCursor: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const healthSnapshotV2Schema = object({
  ...envelope("snapshot", "health.snapshot"),
  payload: object({
    deploymentId: machineString,
    activeHost: machineString,
    authorityEpoch: integer(1),
    live: booleanValue,
    ready: booleanValue,
    status: enumeration(["healthy", "degraded", "not_ready", "not_live"]),
    componentRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const streamEventV2Schema = object({
  ...envelope("event", "stream.event"),
  payload: object({
    cursor: machineString,
    retentionStartCursor: machineString,
    eventId: machineString,
    scopeKind: enumeration(["agent", "thread", "run", "job", "inbox", "memory", "identity"]),
    scopeId: machineString,
    sequence: integer(1),
    occurredAt: timestamp,
    eventType: machineString,
    payloadRef: nullable(machineString),
  }),
});

const schemasByType = {
  "thread.message.submit": submitThreadMessageCommandSchema,
  "thread.checkpoint.request": requestThreadCheckpointCommandSchema,
  "approval.respond": respondApprovalV2CommandSchema,
  "task.set_state": setTaskStateCommandSchema,
  "memory.mutate": mutateMemoryCommandSchema,
  "session.revoke": revokeSessionCommandSchema,
  "thread.list": listThreadsQuerySchema,
  "thread.timeline": threadTimelineQuerySchema,
  "approval.list": listApprovalsQuerySchema,
  "task.list": listTasksQuerySchema,
  "inbox.list": listInboxQuerySchema,
  "memory.search": searchMemoryQuerySchema,
  "trace.timeline": traceTimelineV2QuerySchema,
  "identity.sessions": identitySessionsQuerySchema,
  "health.status": healthStatusQuerySchema,
  "collection.snapshot": collectionSnapshotSchema,
  "health.snapshot": healthSnapshotV2Schema,
  "stream.event": streamEventV2Schema,
} as const satisfies Record<GatewayV2MessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type GatewayV2Message = InferSchema<SchemaByType[keyof SchemaByType]>;
export type GatewayV2Command = Extract<GatewayV2Message, { kind: "command" }>;
export type GatewayV2Query = Extract<GatewayV2Message, { kind: "query" }>;
export type GatewayV2Snapshot = Extract<GatewayV2Message, { kind: "snapshot" }>;
export type GatewayV2Event = Extract<GatewayV2Message, { kind: "event" }>;

function readType(input: unknown): GatewayV2MessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected a Gateway v2 message object");
  }
  return enumeration(GATEWAY_V2_MESSAGE_TYPES).parse(
    (input as { readonly type?: unknown }).type,
    "$.type",
  );
}

function parseGatewayV2Message(input: unknown): GatewayV2Message {
  const parsed = schemasByType[readType(input)].parse(input, "$") as GatewayV2Message;
  if (
    parsed.kind === "command" &&
    (parsed.risk === "high" || parsed.risk === "critical") &&
    parsed.authorizationRef === null
  ) {
    throw new ContractValidationError(
      "$.authorizationRef",
      "high and critical risk commands require an authorization reference",
    );
  }
  return parsed;
}

export const gatewayV2MessageSchema = Object.freeze({
  schemaVersion: GATEWAY_V2_SCHEMA_VERSION,
  parse(input: unknown): GatewayV2Message {
    return parseGatewayV2Message(input);
  },
  parseJson(json: string): GatewayV2Message {
    return parseJson({ parse: parseGatewayV2Message }, json);
  },
  serialize(message: GatewayV2Message): string {
    return JSON.stringify(parseGatewayV2Message(message));
  },
});
