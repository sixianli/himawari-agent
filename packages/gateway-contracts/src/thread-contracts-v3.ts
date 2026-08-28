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

export const THREAD_GATEWAY_SCHEMA_VERSION = "gateway.thread.v3" as const;
export const THREAD_GATEWAY_MESSAGE_TYPES = [
  "thread.create",
  "thread.message.submit",
  "thread.message.commit_assistant",
  "thread.rename",
  "thread.pin",
  "thread.archive",
  "thread.restore",
  "thread.fork",
  "thread.set_answer_locale",
  "thread.trash",
  "thread.delete_permanently",
  "thread.task.resolve",
  "thread.deletion_impact",
  "thread.list",
  "thread.detail",
  "thread.search",
  "thread.lineage",
  "thread.checkpoint",
  "thread.snapshot",
  "thread.event",
] as const;
export type ThreadGatewayMessageType = (typeof THREAD_GATEWAY_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(["public", "private", "sensitive", "restricted"]);
const scopeSchema = object({ ownerId: machineString, agentId: machineString });
const authoritySchema = object({
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
});
const actorSchema = object({
  actorType: enumeration(["owner", "client", "system"]),
  actorId: machineString,
});
const answerLocaleSchema = enumeration(["zh-CN", "en", "ja"]);
const threadStatusSchema = enumeration([
  "active",
  "archived",
  "trashed",
  "deletion_pending",
  "deleted_verified",
]);

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(THREAD_GATEWAY_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    scope: scopeSchema,
    authority: authoritySchema,
    actor: actorSchema,
  } as const;
}

function commandEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("command", type), idempotencyKey: machineString } as const;
}

export const createThreadV3CommandSchema = object({
  ...commandEnvelope("thread.create"),
  payload: object({
    threadId: machineString,
    answerLocale: answerLocaleSchema,
    resultRef: machineString,
  }),
});

export const submitThreadMessageV3CommandSchema = object({
  ...commandEnvelope("thread.message.submit"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    messageId: machineString,
    turnId: machineString,
    runId: machineString,
    sessionId: machineString,
    contentRef: machineString,
    sourceProofRef: machineString,
    dataClassification: classificationSchema,
    occurredAt: timestamp,
    resultRef: machineString,
  }),
});

export const commitAssistantMessageV3CommandSchema = object({
  ...commandEnvelope("thread.message.commit_assistant"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    messageId: machineString,
    turnId: machineString,
    runId: machineString,
    contentRef: machineString,
    dataClassification: classificationSchema,
    committedAt: timestamp,
    resultRef: machineString,
  }),
});

export const renameThreadV3CommandSchema = object({
  ...commandEnvelope("thread.rename"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    titleRef: machineString,
    titleSource: enumeration(["automatic", "owner"]),
    resultRef: machineString,
  }),
});

export const pinThreadV3CommandSchema = object({
  ...commandEnvelope("thread.pin"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    pinOrder: nullable(integer(0)),
    resultRef: machineString,
  }),
});

function lifecycleCommand<const TType extends "thread.archive" | "thread.restore" | "thread.trash">(
  type: TType,
) {
  return object({
    ...commandEnvelope(type),
    payload: object({
      threadId: machineString,
      expectedRevision: integer(1),
      reasonCode: machineString,
      resultRef: machineString,
    }),
  });
}

export const archiveThreadV3CommandSchema = lifecycleCommand("thread.archive");
export const restoreThreadV3CommandSchema = lifecycleCommand("thread.restore");
export const trashThreadV3CommandSchema = lifecycleCommand("thread.trash");
export const deleteThreadPermanentlyV3CommandSchema = object({
  ...commandEnvelope("thread.delete_permanently"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
    authorizationRef: machineString,
    recentAuthenticationRef: machineString,
    resultRef: machineString,
  }),
});

const resolveThreadTaskPayloadSchema = object({
  threadId: machineString,
  taskId: machineString,
  expectedTaskRevision: integer(0),
  action: enumeration(["pause", "cancel", "rebind"]),
  targetThreadId: nullable(machineString),
  reasonCode: machineString,
  resultRef: machineString,
});

export const resolveThreadTaskV3CommandSchema = object({
  ...commandEnvelope("thread.task.resolve"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = resolveThreadTaskPayloadSchema.parse(input, path);
      if ((payload.action === "rebind") !== (payload.targetThreadId !== null)) {
        throw new ContractValidationError(
          `${path}.targetThreadId`,
          "must be present only for a rebind resolution",
        );
      }
      if (payload.targetThreadId === payload.threadId) {
        throw new ContractValidationError(`${path}.targetThreadId`, "must differ from threadId");
      }
      return payload;
    },
  },
});

export const forkThreadV3CommandSchema = object({
  ...commandEnvelope("thread.fork"),
  payload: object({
    sourceThreadId: machineString,
    sourceTurnId: machineString,
    sourceWatermark: integer(1),
    targetThreadId: machineString,
    summaryRefs: array(machineString),
    policyRefs: array(machineString),
    resultRef: machineString,
  }),
});

export const setThreadAnswerLocaleV3CommandSchema = object({
  ...commandEnvelope("thread.set_answer_locale"),
  payload: object({
    threadId: machineString,
    expectedRevision: integer(1),
    answerLocale: answerLocaleSchema,
    resultRef: machineString,
  }),
});

const page = { afterCursor: nullable(machineString), limit: integer(1, 1000) } as const;
export const listThreadsV3QuerySchema = object({
  ...envelope("query", "thread.list"),
  payload: object({ statuses: array(threadStatusSchema), pinnedOnly: booleanValue, ...page }),
});
export const threadDetailV3QuerySchema = object({
  ...envelope("query", "thread.detail"),
  payload: object({ threadId: machineString, afterSequence: integer(0), limit: integer(1, 1000) }),
});
export const searchThreadsV3QuerySchema = object({
  ...envelope("query", "thread.search"),
  payload: object({
    queryRef: machineString,
    tokenRefs: array(machineString),
    projectionVersion: machineString,
    statuses: array(threadStatusSchema),
    jobStatuses: array(enumeration(["active", "paused", "revoked"])),
    updatedAfter: nullable(timestamp),
    updatedBefore: nullable(timestamp),
    ...page,
  }),
});
export const threadLineageV3QuerySchema = object({
  ...envelope("query", "thread.lineage"),
  payload: object({ threadId: machineString }),
});
export const threadCheckpointV3QuerySchema = object({
  ...envelope("query", "thread.checkpoint"),
  payload: object({ threadId: machineString, sourceWatermark: nullable(integer(1)) }),
});
export const threadDeletionImpactV3QuerySchema = object({
  ...envelope("query", "thread.deletion_impact"),
  payload: object({ threadId: machineString }),
});

export const threadSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.snapshot"),
  payload: object({
    threadId: machineString,
    revision: integer(1),
    status: threadStatusSchema,
    titleRef: nullable(machineString),
    titleSource: nullable(enumeration(["automatic", "owner"])),
    pinOrder: nullable(integer(0)),
    answerLocale: answerLocaleSchema,
    messageWatermark: integer(0),
    lineageRef: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadEventV3Schema = object({
  ...envelope("event", "thread.event"),
  payload: object({
    eventId: machineString,
    threadId: machineString,
    revision: integer(1),
    cursor: machineString,
    causationCommandId: machineString,
    eventType: machineString,
    payloadRef: nullable(machineString),
    occurredAt: timestamp,
  }),
});

const schemasByType = {
  "thread.create": createThreadV3CommandSchema,
  "thread.message.submit": submitThreadMessageV3CommandSchema,
  "thread.message.commit_assistant": commitAssistantMessageV3CommandSchema,
  "thread.rename": renameThreadV3CommandSchema,
  "thread.pin": pinThreadV3CommandSchema,
  "thread.archive": archiveThreadV3CommandSchema,
  "thread.restore": restoreThreadV3CommandSchema,
  "thread.fork": forkThreadV3CommandSchema,
  "thread.set_answer_locale": setThreadAnswerLocaleV3CommandSchema,
  "thread.trash": trashThreadV3CommandSchema,
  "thread.delete_permanently": deleteThreadPermanentlyV3CommandSchema,
  "thread.task.resolve": resolveThreadTaskV3CommandSchema,
  "thread.deletion_impact": threadDeletionImpactV3QuerySchema,
  "thread.list": listThreadsV3QuerySchema,
  "thread.detail": threadDetailV3QuerySchema,
  "thread.search": searchThreadsV3QuerySchema,
  "thread.lineage": threadLineageV3QuerySchema,
  "thread.checkpoint": threadCheckpointV3QuerySchema,
  "thread.snapshot": threadSnapshotV3Schema,
  "thread.event": threadEventV3Schema,
} as const satisfies Record<ThreadGatewayMessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;
export type ThreadGatewayMessage = InferSchema<SchemaByType[keyof SchemaByType]>;
export type ThreadGatewayCommand = Extract<ThreadGatewayMessage, { kind: "command" }>;
export type ThreadGatewayQuery = Extract<ThreadGatewayMessage, { kind: "query" }>;

function readType(input: unknown): ThreadGatewayMessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected a Thread Gateway message object");
  }
  return enumeration(THREAD_GATEWAY_MESSAGE_TYPES).parse(
    (input as { readonly type?: unknown }).type,
    "$.type",
  );
}

function parseThreadGatewayMessage(input: unknown): ThreadGatewayMessage {
  return schemasByType[readType(input)].parse(input, "$") as ThreadGatewayMessage;
}

export const threadGatewayMessageSchema = Object.freeze({
  schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
  parse: parseThreadGatewayMessage,
  parseJson(json: string): ThreadGatewayMessage {
    return parseJson({ parse: parseThreadGatewayMessage }, json);
  },
  serialize(message: ThreadGatewayMessage): string {
    return JSON.stringify(parseThreadGatewayMessage(message));
  },
});
