import {
  array,
  booleanValue,
  boundedString,
  ContractValidationError,
  enumeration,
  type InferSchema,
  integer,
  literal,
  machineString,
  modelRefString,
  nullable,
  object,
  parseJson,
  type Schema,
  timestamp,
} from "./validation.js";

export const THREAD_GATEWAY_SCHEMA_VERSION = "gateway.thread.v3" as const;
export const THREAD_GATEWAY_MESSAGE_TYPES = [
  "thread.create",
  "thread.message.submit",
  "thread.message.submit_configured",
  "thread.run.cancel",
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
  "thread.option.choose",
  "thread.deletion_impact",
  "thread.events",
  "thread.execution_events",
  "thread.list",
  "thread.detail",
  "thread.main",
  "thread.execution",
  "thread.execution_snapshot",
  "thread.execution_state",
  "thread.execution_state_snapshot",
  "thread.execution_environment",
  "thread.execution_environment_snapshot",
  "thread.background_work",
  "thread.background_work_snapshot",
  "thread.search",
  "thread.lineage",
  "thread.checkpoint",
  "thread.snapshot",
  "thread.collection_snapshot",
  "thread.main_snapshot",
  "thread.detail_snapshot",
  "thread.search_snapshot",
  "thread.lineage_snapshot",
  "thread.checkpoint_snapshot",
  "thread.deletion_impact_snapshot",
  "thread.command_result",
  "thread.conflict",
  "thread.event",
  "thread.execution_changed",
  "thread.execution_text",
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
const threadCommandTypeSchema = enumeration([
  "thread.create",
  "thread.message.submit",
  "thread.message.submit_configured",
  "thread.run.cancel",
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
  "thread.option.choose",
]);
const runStatusSchema = enumeration([
  "accepted",
  "building_context",
  "running",
  "awaiting_approval",
  "reconciling_external_result",
  "completed",
  "failed",
  "cancelled",
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

export const chooseThreadOptionV3CommandSchema = object({
  ...commandEnvelope("thread.option.choose"),
  payload: object({
    threadId: machineString,
    messageId: machineString,
    setId: machineString,
    optionId: machineString,
  }),
});

export const submitConfiguredThreadMessageSchema = object({
  ...commandEnvelope("thread.message.submit_configured"),
  payload: object({
    modelRef: modelRefString,
    thinkingLevel: enumeration(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
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

const cancelThreadRunSchema = object({
  ...commandEnvelope("thread.run.cancel"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    expectedRunRevision: integer(1),
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
export const mainThreadV3QuerySchema = object({
  ...envelope("query", "thread.main"),
  payload: object({}),
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
export const threadEventsV3SubscriptionSchema = object({
  ...envelope("subscription", "thread.events"),
  payload: object({ afterCursor: nullable(machineString) }),
});

export const threadExecutionEventsSubscriptionSchema = object({
  ...envelope("subscription", "thread.execution_events"),
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

export const threadSummaryV3Schema = object({
  threadId: machineString,
  revision: integer(1),
  status: threadStatusSchema,
  titleRef: nullable(machineString),
  titleSource: nullable(enumeration(["automatic", "owner"])),
  titleRevision: integer(0),
  pinOrder: nullable(integer(0)),
  answerLocale: answerLocaleSchema,
  messageWatermark: integer(0),
  sourceThreadId: nullable(machineString),
  sourceWatermark: nullable(integer(1)),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const MESSAGE_OPTION_DISMISS_ID = "dismiss" as const;

export const messageOptionsV3Schema = object({
  setId: machineString,
  items: array(
    object({
      optionId: machineString,
      label: boundedString(200),
      reason: nullable(boundedString(500)),
      action: nullable(object({ tool: machineString, summary: boundedString(1000) })),
      state: enumeration(["open", "chosen", "stale"]),
    }),
  ),
});
export type MessageOptionsV3 = InferSchema<typeof messageOptionsV3Schema>;

export const chosenOptionV3Schema = object({ setId: machineString, optionId: machineString });

export const threadMessageSummaryV3Schema = object({
  messageId: machineString,
  sequence: integer(1),
  role: enumeration(["owner", "agent", "system"]),
  contentRef: machineString,
  dataClassification: classificationSchema,
  status: enumeration(["committed", "partial", "failed"]),
  turnId: nullable(machineString),
  runId: nullable(machineString),
  committedAt: timestamp,
  options: nullable(messageOptionsV3Schema),
  chosenFrom: nullable(chosenOptionV3Schema),
  spoken: booleanValue,
});

export const threadRunSummaryV3Schema = object({
  runId: machineString,
  revision: integer(1),
  status: runStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  background: nullable(
    object({
      count: integer(1, 16),
      startedAt: timestamp,
      deadlineAt: timestamp,
    }),
  ),
  backgroundCommands: array(
    object({
      taskRef: machineString,
      commandRef: nullable(machineString),
      outputRef: nullable(machineString),
      startedAt: timestamp,
      deadlineAt: timestamp,
      endedAt: nullable(timestamp),
      outcome: nullable(
        enumeration(["completed", "failed", "stopped", "timed_out", "interrupted"]),
      ),
      noticeRunId: nullable(machineString),
    }),
  ),
});

export const threadCollectionSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.collection_snapshot"),
  payload: object({
    threads: array(threadSummaryV3Schema),
    nextCursor: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const mainThreadSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.main_snapshot"),
  payload: object({
    thread: threadSummaryV3Schema,
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadDetailSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.detail_snapshot"),
  payload: object({
    thread: threadSummaryV3Schema,
    messages: array(threadMessageSummaryV3Schema),
    runs: array(threadRunSummaryV3Schema),
    nextSequence: nullable(integer(1)),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadSearchSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.search_snapshot"),
  payload: object({
    queryRef: machineString,
    projectionVersion: machineString,
    threads: array(threadSummaryV3Schema),
    nextCursor: nullable(machineString),
    degraded: booleanValue,
    reasonCode: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadLineageSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.lineage_snapshot"),
  payload: object({
    threadId: machineString,
    sourceThreadId: nullable(machineString),
    sourceTurnId: nullable(machineString),
    sourceWatermark: nullable(integer(1)),
    summaryRefs: array(machineString),
    policyRefs: array(machineString),
    sourceContentAvailable: booleanValue,
    forkedAt: nullable(timestamp),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadCheckpointSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.checkpoint_snapshot"),
  payload: object({
    threadId: machineString,
    jobId: nullable(machineString),
    generationId: nullable(machineString),
    sourceWatermark: nullable(integer(1)),
    policyVersion: nullable(machineString),
    modelDescriptorRef: nullable(machineString),
    trigger: nullable(
      enumeration(["owner_explicit", "controlled_idle", "pre_compaction", "source_threshold"]),
    ),
    summaryRef: nullable(machineString),
    status: nullable(
      enumeration(["pending", "running", "completed", "retry_wait", "failed_terminal"]),
    ),
    revision: nullable(integer(1)),
    attemptCount: nullable(integer(0)),
    nextRetryAt: nullable(timestamp),
    errorCode: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

const threadTaskBindingV3Schema = object({
  taskId: machineString,
  revision: integer(0),
  threadId: machineString,
  status: enumeration(["active", "paused", "cancelled"]),
});

export const threadDeletionImpactSnapshotV3Schema = object({
  ...envelope("snapshot", "thread.deletion_impact_snapshot"),
  payload: object({
    threadId: machineString,
    threadRevision: integer(1),
    associatedTasks: array(threadTaskBindingV3Schema),
    activeTaskIds: array(machineString),
    deletionAllowed: booleanValue,
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

export const threadCommandResultV3Schema = object({
  ...envelope("result", "thread.command_result"),
  payload: object({
    commandType: threadCommandTypeSchema,
    commandId: machineString,
    threadId: machineString,
    threadRevision: integer(1),
    resultRef: machineString,
    replayed: booleanValue,
    committedAt: timestamp,
  }),
});

export const threadConflictV3Schema = object({
  ...envelope("conflict", "thread.conflict"),
  payload: object({
    commandType: threadCommandTypeSchema,
    threadId: machineString,
    reasonCode: machineString,
    latest: nullable(threadSummaryV3Schema),
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

const displayText: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || value.length > 65536)
      throw new ContractValidationError(path, "expected bounded display text");
    return value;
  },
};

export const threadExecutionChangedSchema = object({
  ...envelope("event", "thread.execution_changed"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    runRevision: integer(1),
    traceSequence: integer(0),
    resourceRevision: nullable(machineString),
    observedAt: timestamp,
  }),
});

export const threadExecutionTextSchema = object({
  ...envelope("event", "thread.execution_text"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    itemId: machineString,
    offset: integer(0),
    text: displayText,
    emittedAt: nullable(timestamp),
    observedAt: timestamp,
  }),
});

export const threadExecutionRecordSchema = object({
  id: machineString,
  sequence: integer(1),
  itemId: machineString,
  kind: enumeration(["message", "tool", "status"]),
  phase: enumeration([
    "started",
    "updated",
    "completed",
    "failed",
    "waiting",
    "stopped",
    "unavailable",
  ]),
  name: displayText,
  text: displayText,
  input: displayText,
  output: displayText,
  activity: displayText,
  activityIcon: displayText,
  occurredAt: timestamp,
});
export type ThreadExecutionRecord = InferSchema<typeof threadExecutionRecordSchema>;
const threadExecutionQuerySchema = object({
  ...envelope("query", "thread.execution"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    afterSequence: integer(0),
    limit: integer(1, 1000),
  }),
});
const threadExecutionSnapshotSchema = object({
  ...envelope("snapshot", "thread.execution_snapshot"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    records: array(threadExecutionRecordSchema),
    nextSequence: nullable(integer(1)),
    generatedAt: timestamp,
  }),
});

export const threadExecutionDisplayPhaseSchema = enumeration([
  "preparing",
  "awaiting_approval",
  "reviewing",
  "model_waiting",
  "model_thinking",
  "model_output",
  "completed",
  "failed",
  "stopped",
  "unresolved",
  "not_dispatched",
]);
const executionTimingSchema = object({
  reviewMilliseconds: nullable(integer(0)),
  executionMilliseconds: nullable(integer(0)),
});
const executionEffectSchema = enumeration([
  "succeeded",
  "failed",
  "unknown",
  "not_dispatched",
  "pending",
]);
export const threadExecutionStateSchema = object({
  runRevision: integer(1),
  revision: machineString,
  lastObservedAt: timestamp,
  displayPhase: threadExecutionDisplayPhaseSchema,
  reasonCode: machineString,
  availableActions: array(enumeration(["stop", "review_approval", "retry_cleanup"])),
  needsAttention: booleanValue,
  timing: executionTimingSchema,
  effectSummary: array(object({ itemId: machineString, outcome: executionEffectSchema })),
  operations: array(
    object({
      itemId: machineString,
      displayPhase: threadExecutionDisplayPhaseSchema,
      reasonCode: machineString,
      lastObservedAt: timestamp,
      executionMilliseconds: nullable(integer(0)),
    }),
  ),
});
export type ThreadExecutionState = InferSchema<typeof threadExecutionStateSchema>;
const threadExecutionStateQuerySchema = object({
  ...envelope("query", "thread.execution_state"),
  payload: object({ threadId: machineString, runId: machineString }),
});
const threadExecutionStateSnapshotSchema = object({
  ...envelope("snapshot", "thread.execution_state_snapshot"),
  payload: object({
    threadId: machineString,
    runId: machineString,
    state: threadExecutionStateSchema,
    generatedAt: timestamp,
  }),
});

export const threadExecutionEnvironmentSchema = object({
  mode: enumeration(["srt", "strict"]),
  programs: array(
    object({
      threadId: nullable(machineString),
      kind: enumeration(["background", "service"]),
      toolName: machineString,
      startedAt: timestamp,
    }),
  ),
  unavailableTools: array(
    object({
      toolName: machineString,
      reasonCode: enumeration(["SANDBOX_OPERATION_SRT_ONLY", "SANDBOX_BINDING_SRT_ONLY"]),
    }),
  ),
});
export type ThreadExecutionEnvironment = InferSchema<typeof threadExecutionEnvironmentSchema>;
const threadExecutionEnvironmentQuerySchema = object({
  ...envelope("query", "thread.execution_environment"),
  payload: object({}),
});
const threadExecutionEnvironmentSnapshotSchema = object({
  ...envelope("snapshot", "thread.execution_environment_snapshot"),
  payload: object({ environment: threadExecutionEnvironmentSchema, generatedAt: timestamp }),
});

export const threadBackgroundWorkSchema = object({
  matters: array(
    object({
      matter: boundedString(128),
      subthreads: array(
        object({
          subthreadId: machineString,
          status: enumeration(["open", "returned", "stopped"]),
          activity: enumeration([
            "queued",
            "running",
            "waiting_answer",
            "waiting_result",
            "idle",
            "over_budget",
            "finished",
          ]),
          openedAt: timestamp,
          updatedAt: timestamp,
          progress: nullable(boundedString(2000)),
          progressAt: nullable(timestamp),
          runCount: integer(0),
          spentMicros: integer(0),
          budgetMicros: integer(1),
          title: nullable(boundedString(20)),
          runs: array(
            object({
              runId: machineString,
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
              startedAt: timestamp,
              updatedAt: timestamp,
            }),
          ),
          exchanges: array(
            object({
              direction: enumeration(["to_subthread", "to_main"]),
              kind: enumeration([
                "brief",
                "message",
                "result_board",
                "progress",
                "question",
                "stuck",
                "result",
                "budget",
              ]),
              text: boundedString(2000),
              at: timestamp,
            }),
          ),
          tasks: array(
            object({
              number: integer(1),
              status: enumeration(["pending", "in_progress", "completed"]),
              subject: nullable(boundedString(400)),
              activeForm: nullable(boundedString(400)),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type ThreadBackgroundWork = InferSchema<typeof threadBackgroundWorkSchema>;
const threadBackgroundWorkQuerySchema = object({
  ...envelope("query", "thread.background_work"),
  payload: object({}),
});
const threadBackgroundWorkSnapshotSchema = object({
  ...envelope("snapshot", "thread.background_work_snapshot"),
  payload: object({ work: threadBackgroundWorkSchema, generatedAt: timestamp }),
});

const schemasByType = {
  "thread.background_work": threadBackgroundWorkQuerySchema,
  "thread.background_work_snapshot": threadBackgroundWorkSnapshotSchema,
  "thread.message.submit_configured": submitConfiguredThreadMessageSchema,
  "thread.run.cancel": cancelThreadRunSchema,
  "thread.execution": threadExecutionQuerySchema,
  "thread.execution_state": threadExecutionStateQuerySchema,
  "thread.execution_state_snapshot": threadExecutionStateSnapshotSchema,
  "thread.execution_environment": threadExecutionEnvironmentQuerySchema,
  "thread.execution_environment_snapshot": threadExecutionEnvironmentSnapshotSchema,
  "thread.execution_snapshot": threadExecutionSnapshotSchema,
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
  "thread.option.choose": chooseThreadOptionV3CommandSchema,
  "thread.deletion_impact": threadDeletionImpactV3QuerySchema,
  "thread.events": threadEventsV3SubscriptionSchema,
  "thread.execution_events": threadExecutionEventsSubscriptionSchema,
  "thread.list": listThreadsV3QuerySchema,
  "thread.detail": threadDetailV3QuerySchema,
  "thread.main": mainThreadV3QuerySchema,
  "thread.search": searchThreadsV3QuerySchema,
  "thread.lineage": threadLineageV3QuerySchema,
  "thread.checkpoint": threadCheckpointV3QuerySchema,
  "thread.snapshot": threadSnapshotV3Schema,
  "thread.collection_snapshot": threadCollectionSnapshotV3Schema,
  "thread.main_snapshot": mainThreadSnapshotV3Schema,
  "thread.detail_snapshot": threadDetailSnapshotV3Schema,
  "thread.search_snapshot": threadSearchSnapshotV3Schema,
  "thread.lineage_snapshot": threadLineageSnapshotV3Schema,
  "thread.checkpoint_snapshot": threadCheckpointSnapshotV3Schema,
  "thread.deletion_impact_snapshot": threadDeletionImpactSnapshotV3Schema,
  "thread.command_result": threadCommandResultV3Schema,
  "thread.conflict": threadConflictV3Schema,
  "thread.event": threadEventV3Schema,
  "thread.execution_changed": threadExecutionChangedSchema,
  "thread.execution_text": threadExecutionTextSchema,
} as const satisfies Record<ThreadGatewayMessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;
export type ThreadGatewayMessage = InferSchema<SchemaByType[keyof SchemaByType]>;
export type ThreadGatewayCommand = Extract<ThreadGatewayMessage, { kind: "command" }>;
export type ThreadGatewayQuery = Extract<ThreadGatewayMessage, { kind: "query" }>;
export type ThreadGatewaySubscription = Extract<ThreadGatewayMessage, { type: "thread.events" }>;
export type ThreadExecutionEventsSubscription = Extract<
  ThreadGatewayMessage,
  { type: "thread.execution_events" }
>;
export type ThreadGatewaySnapshot = Extract<ThreadGatewayMessage, { kind: "snapshot" }>;
export type ThreadGatewayEvent = Extract<ThreadGatewayMessage, { type: "thread.event" }>;
export type ThreadExecutionChangedEvent = Extract<
  ThreadGatewayMessage,
  { type: "thread.execution_changed" }
>;
export type ThreadExecutionTextEvent = Extract<
  ThreadGatewayMessage,
  { type: "thread.execution_text" }
>;
export type ThreadExecutionStreamEvent = ThreadExecutionChangedEvent | ThreadExecutionTextEvent;
export type ThreadGatewayRequestResult = Extract<
  ThreadGatewayMessage,
  { kind: "snapshot" | "result" | "conflict" }
>;

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
