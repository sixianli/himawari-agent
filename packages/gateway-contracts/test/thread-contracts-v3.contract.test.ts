import {
  archiveThreadV3CommandSchema,
  ContractValidationError,
  chooseThreadOptionV3CommandSchema,
  deleteThreadPermanentlyV3CommandSchema,
  forkThreadV3CommandSchema,
  messageOptionsV3Schema,
  resolveThreadTaskV3CommandSchema,
  searchThreadsV3QuerySchema,
  setThreadAnswerLocaleV3CommandSchema,
  submitThreadMessageV3CommandSchema,
  THREAD_GATEWAY_SCHEMA_VERSION,
  threadBackgroundWorkSchema,
  threadCollectionSnapshotV3Schema,
  threadConflictV3Schema,
  threadDetailSnapshotV3Schema,
  threadEventsV3SubscriptionSchema,
  threadExecutionEnvironmentSchema,
  threadExecutionRecordSchema,
  threadExecutionStateSchema,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";

const scope = { ownerId: "owner-s2", agentId: "agent-s2" };
const authority = { deploymentId: "deployment-s2", authorityEpoch: 2, fencingToken: 7 };
const actor = { actorType: "owner" as const, actorId: "owner-s2" };
const envelope = {
  schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
  messageId: "message-command-s2",
  correlationId: "correlation-s2",
  causationId: null,
  scope,
  authority,
  actor,
};

describe("Thread Gateway v3 contracts", () => {
  it("adds an independent execution-state query without changing the strict legacy snapshot", () => {
    const query = {
      ...envelope,
      kind: "query",
      type: "thread.execution_state",
      payload: { threadId: "thread-s2", runId: "run-s2" },
    };
    expect(threadGatewayMessageSchema.parse(query)).toEqual(query);
    expect(() =>
      threadGatewayMessageSchema.parse({
        ...query,
        payload: { ...query.payload, afterSequence: 0 },
      }),
    ).toThrow();
    const legacy = {
      ...envelope,
      kind: "snapshot",
      type: "thread.execution_snapshot",
      payload: {
        threadId: "thread-s2",
        runId: "run-s2",
        records: [],
        nextSequence: null,
        generatedAt: "2026-09-20T00:00:00.000Z",
      },
    };
    expect(threadGatewayMessageSchema.parse(legacy)).toEqual(legacy);
    expect(() =>
      threadGatewayMessageSchema.parse({ ...legacy, payload: { ...legacy.payload, state: {} } }),
    ).toThrow();
  });

  it("describes the execution environment without internal identities or command text", () => {
    const query = {
      ...envelope,
      kind: "query",
      type: "thread.execution_environment",
      payload: {},
    };
    expect(threadGatewayMessageSchema.parse(query)).toEqual(query);
    expect(() =>
      threadGatewayMessageSchema.parse({ ...query, payload: { threadId: "thread-s2" } }),
    ).toThrow();
    const environment = {
      mode: "strict",
      programs: [
        {
          threadId: "thread-s2",
          kind: "service",
          toolName: "bash",
          startedAt: "2026-09-27T00:00:00.000Z",
        },
        {
          threadId: null,
          kind: "background",
          toolName: "bash",
          startedAt: "2026-09-27T00:01:00.000Z",
        },
      ],
      unavailableTools: [
        { toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" },
        { toolName: "read", reasonCode: "SANDBOX_BINDING_SRT_ONLY" },
      ],
    };
    expect(threadExecutionEnvironmentSchema.parse(environment)).toEqual(environment);
    const snapshot = {
      ...envelope,
      kind: "snapshot",
      type: "thread.execution_environment_snapshot",
      payload: { environment, generatedAt: "2026-09-27T00:00:00.000Z" },
    };
    expect(threadGatewayMessageSchema.parse(snapshot)).toEqual(snapshot);
    const [program] = environment.programs;
    for (const patch of [
      { mode: "default" },
      { programs: [{ ...program, kind: "foreground" }] },
      { programs: [{ ...program, command: "npm run dev" }] },
      { programs: [{ ...program, jobId: "job-s2" }] },
      { programs: [{ ...program, startedAt: null }] },
      { unavailableTools: [{ toolName: "bash", reasonCode: "SANDBOX_STRICT_MODE_UNAVAILABLE" }] },
    ])
      expect(() => threadExecutionEnvironmentSchema.parse({ ...environment, ...patch })).toThrow();
  });

  it("[ADR-0285] describes background work by matter with each subthread's activity and visible to-dos", () => {
    const query = { ...envelope, kind: "query", type: "thread.background_work", payload: {} };
    expect(threadGatewayMessageSchema.parse(query)).toEqual(query);
    expect(() =>
      threadGatewayMessageSchema.parse({ ...query, payload: { threadId: "thread-s2" } }),
    ).toThrow();
    const subthread = {
      subthreadId: "thread:subthread:abc",
      status: "open",
      activity: "running",
      openedAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:01:00.000Z",
      progress: "查到三个选项，正在比价",
      progressAt: "2026-11-25T00:01:00.000Z",
      runCount: 2,
      spentMicros: 120_000,
      budgetMicros: 500_000,
      tasks: [{ number: 1, status: "in_progress", subject: "查航班", activeForm: "正在查航班" }],
    };
    const work = { matters: [{ matter: "大阪出差", subthreads: [subthread] }] };
    expect(threadBackgroundWorkSchema.parse(work)).toEqual(work);
    const snapshot = {
      ...envelope,
      kind: "snapshot",
      type: "thread.background_work_snapshot",
      payload: { work, generatedAt: "2026-11-25T00:02:00.000Z" },
    };
    expect(threadGatewayMessageSchema.parse(snapshot)).toEqual(snapshot);
    for (const patch of [
      { activity: "thinking" },
      { status: "failed" },
      { tasks: [{ ...subthread.tasks[0], status: "deleted" }] },
      { runCount: -1 },
      { spentMicros: -1 },
      { budgetMicros: 0 },
      { brief: "任务说明原文" },
    ])
      expect(() =>
        threadBackgroundWorkSchema.parse({
          matters: [{ matter: "大阪出差", subthreads: [{ ...subthread, ...patch }] }],
        }),
      ).toThrow();
  });

  it("rejects invented phases, timing and unknown action commands in execution state", () => {
    const state = {
      runRevision: 1,
      revision: "state-v1",
      lastObservedAt: "2026-09-20T00:00:00.000Z",
      displayPhase: "unresolved",
      reasonCode: "EXECUTION_RESULT_UNCONFIRMED",
      availableActions: [],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      effectSummary: [],
      operations: [],
    };
    expect(threadExecutionStateSchema.parse(state)).toEqual(state);
    for (const patch of [
      { displayPhase: "executing_without_start" },
      { availableActions: ["rerun_tool"] },
      { timing: { executionMilliseconds: -1, reviewMilliseconds: null } },
    ])
      expect(() => threadExecutionStateSchema.parse({ ...state, ...patch })).toThrow();
  });

  it("freezes idempotent revision-checked message admission", () => {
    expect(
      submitThreadMessageV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.message.submit",
        idempotencyKey: "submit-s2",
        payload: {
          threadId: "thread-s2",
          expectedRevision: 1,
          messageId: "message-s2",
          turnId: "turn-s2",
          runId: "run-s2",
          sessionId: "session-s2",
          contentRef: "payload:message-s2",
          sourceProofRef: "source-proof-s2",
          dataClassification: "private",
          occurredAt: "2026-08-28T00:00:00.000Z",
          resultRef: "payload:result-s2",
        },
      }),
    ).toMatchObject({ type: "thread.message.submit", payload: { expectedRevision: 1 } });
  });

  it("freezes lifecycle, locale, Fork and opaque search contracts", () => {
    expect(
      archiveThreadV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.archive",
        idempotencyKey: "archive-s2",
        payload: {
          threadId: "thread-s2",
          expectedRevision: 2,
          reasonCode: "owner_requested",
          resultRef: "payload:archive-result",
        },
      }),
    ).toMatchObject({ type: "thread.archive" });
    expect(
      setThreadAnswerLocaleV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.set_answer_locale",
        idempotencyKey: "locale-s2",
        payload: {
          threadId: "thread-s2",
          expectedRevision: 3,
          answerLocale: "ja",
          resultRef: "payload:locale-result",
        },
      }),
    ).toMatchObject({ payload: { answerLocale: "ja" } });
    expect(
      forkThreadV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.fork",
        idempotencyKey: "fork-s2",
        payload: {
          sourceThreadId: "thread-s2",
          sourceTurnId: "turn-s2",
          sourceWatermark: 2,
          targetThreadId: "thread-fork-s2",
          summaryRefs: ["payload:summary-s2"],
          policyRefs: ["policy:answer-locale:ja"],
          resultRef: "payload:fork-result",
        },
      }),
    ).toMatchObject({ payload: { sourceWatermark: 2 } });
    expect(
      searchThreadsV3QuerySchema.parse({
        ...envelope,
        kind: "query",
        type: "thread.search",
        payload: {
          queryRef: "payload:query-s2",
          tokenRefs: ["search-token:001"],
          projectionVersion: "projection-v1",
          statuses: ["active", "archived"],
          jobStatuses: ["active"],
          updatedAfter: null,
          updatedBefore: null,
          afterCursor: null,
          limit: 20,
        },
      }),
    ).toMatchObject({ payload: { tokenRefs: ["search-token:001"] } });
  });

  it("[OPTIONS-CONTRACT] carries options under a message and the owner's choice of one", () => {
    expect(
      chooseThreadOptionV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.option.choose",
        idempotencyKey: "device-option-s2",
        payload: {
          threadId: "thread-s2",
          messageId: "message-s2",
          setId: "set:s2",
          optionId: "o1",
        },
      }),
    ).toMatchObject({ payload: { setId: "set:s2", optionId: "o1" } });
    const options = {
      setId: "set:s2",
      items: [
        {
          optionId: "o1",
          label: "回复 田中：周四可以",
          reason: null,
          action: { tool: "mail_reply", summary: "给田中回邮件：周四可以" },
          state: "open",
        },
        { optionId: "dismiss", label: "不用了", reason: null, action: null, state: "open" },
      ],
    };
    expect(messageOptionsV3Schema.parse(options).items).toHaveLength(2);
    expect(() =>
      messageOptionsV3Schema.parse({
        ...options,
        items: [{ ...options.items[1], state: "hidden" }],
      }),
    ).toThrow(ContractValidationError);
  });

  it("requires explicit task resolution and one-time permanent-delete authorization", () => {
    expect(
      resolveThreadTaskV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.task.resolve",
        idempotencyKey: "resolve-task-s2",
        payload: {
          threadId: "thread-s2",
          taskId: "task-s2",
          expectedTaskRevision: 4,
          action: "rebind",
          targetThreadId: "thread-target-s2",
          reasonCode: "owner_selected_rebind",
          resultRef: "payload:task-resolution-result",
        },
      }),
    ).toMatchObject({ payload: { action: "rebind", targetThreadId: "thread-target-s2" } });
    expect(() =>
      resolveThreadTaskV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.task.resolve",
        idempotencyKey: "resolve-task-invalid-s2",
        payload: {
          threadId: "thread-s2",
          taskId: "task-s2",
          expectedTaskRevision: 4,
          action: "pause",
          targetThreadId: "thread-target-s2",
          reasonCode: "invalid_extra_target",
          resultRef: "payload:task-resolution-result",
        },
      }),
    ).toThrow(ContractValidationError);
    expect(
      deleteThreadPermanentlyV3CommandSchema.parse({
        ...envelope,
        kind: "command",
        type: "thread.delete_permanently",
        idempotencyKey: "delete-permanently-s2",
        payload: {
          threadId: "thread-s2",
          expectedRevision: 5,
          reasonCode: "owner_requested",
          authorizationRef: "approval:delete-s2",
          recentAuthenticationRef: "recent-auth:owner-s2",
          resultRef: "payload:delete-result",
        },
      }),
    ).toMatchObject({ type: "thread.delete_permanently" });
  });

  it("freezes collection, detail, conflict and durable event subscription responses", () => {
    const thread = {
      threadId: "thread-s2",
      revision: 4,
      status: "active",
      titleRef: "payload:title-s2",
      titleSource: "owner",
      titleRevision: 1,
      pinOrder: 0,
      answerLocale: "ja",
      messageWatermark: 2,
      sourceThreadId: null,
      sourceWatermark: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
    } as const;
    expect(
      threadCollectionSnapshotV3Schema.parse({
        ...envelope,
        kind: "snapshot",
        type: "thread.collection_snapshot",
        actor: { actorType: "system", actorId: "thread-gateway" },
        payload: {
          threads: [thread],
          nextCursor: "2026-08-28T00:01:00.000Z",
          snapshotRef: "snapshot:collection-s2",
          generatedAt: "2026-08-28T00:02:00.000Z",
        },
      }),
    ).toMatchObject({ payload: { threads: [{ revision: 4 }] } });
    expect(
      threadDetailSnapshotV3Schema.parse({
        ...envelope,
        kind: "snapshot",
        type: "thread.detail_snapshot",
        actor: { actorType: "system", actorId: "thread-gateway" },
        payload: {
          thread,
          messages: [
            {
              messageId: "message-s2",
              sequence: 1,
              role: "owner",
              contentRef: "payload:message-s2",
              dataClassification: "private",
              status: "committed",
              turnId: "turn-s2",
              runId: "run-s2",
              committedAt: "2026-08-28T00:00:30.000Z",
              options: null,
              chosenFrom: null,
            },
          ],
          runs: [
            {
              runId: "run-s2",
              revision: 2,
              status: "running",
              createdAt: "2026-08-28T00:00:30.000Z",
              updatedAt: "2026-08-28T00:01:00.000Z",
              background: {
                count: 1,
                startedAt: "2026-08-28T00:00:40.000Z",
                deadlineAt: "2026-08-28T00:30:40.000Z",
              },
              backgroundCommands: [
                {
                  taskRef: "background-command:s2",
                  commandRef: "payload:command-s2",
                  outputRef: null,
                  startedAt: "2026-08-28T00:00:40.000Z",
                  deadlineAt: "2026-08-28T00:30:40.000Z",
                  endedAt: null,
                  outcome: null,
                  noticeRunId: null,
                },
              ],
            },
          ],
          nextSequence: null,
          snapshotRef: "snapshot:detail-s2",
          generatedAt: "2026-08-28T00:02:00.000Z",
        },
      }),
    ).toMatchObject({ payload: { messages: [{ contentRef: "payload:message-s2" }] } });
    expect(
      threadConflictV3Schema.parse({
        ...envelope,
        kind: "conflict",
        type: "thread.conflict",
        actor: { actorType: "system", actorId: "thread-gateway" },
        payload: {
          commandType: "thread.pin",
          threadId: "thread-s2",
          reasonCode: "PORT_CONFLICT",
          latest: thread,
          generatedAt: "2026-08-28T00:02:00.000Z",
        },
      }),
    ).toMatchObject({ payload: { latest: { revision: 4 } } });
    expect(
      threadEventsV3SubscriptionSchema.parse({
        ...envelope,
        kind: "subscription",
        type: "thread.events",
        payload: { afterCursor: "thread-cursor:42" },
      }),
    ).toMatchObject({ payload: { afterCursor: "thread-cursor:42" } });
  });

  it.each([
    ["stale-compatible zero revision", { expectedRevision: 0 }],
    ["unknown field injection", { unexpected: "value" }],
    ["invalid locale", { answerLocale: "zh" }],
  ])("rejects %s", (name, patch) => {
    const base = {
      ...envelope,
      kind: "command",
      type: "thread.set_answer_locale",
      idempotencyKey: `invalid-${name}`,
      payload: {
        threadId: "thread-s2",
        expectedRevision: 1,
        answerLocale: "en",
        resultRef: "payload:locale-result",
        ...patch,
      },
    };
    expect(() => setThreadAnswerLocaleV3CommandSchema.parse(base)).toThrow(ContractValidationError);
  });
});

describe("displayable execution records", () => {
  const record = {
    id: "record",
    sequence: 1,
    itemId: "item",
    kind: "tool",
    phase: "started",
    name: "read",
    text: "",
    input: "fixture input",
    output: "",
    activity: "",
    activityIcon: "",
    occurredAt: "2026-09-14T00:00:00.000Z",
  };
  it("preserves empty and bounded display content without treating it as a machine identifier", () => {
    expect(threadExecutionRecordSchema.parse(record)).toEqual(record);
    expect(
      threadExecutionRecordSchema.parse({
        ...record,
        input: "a".repeat(65536),
        output: "line one\nline two",
      }).output,
    ).toBe("line one\nline two");
  });
  it("[ICON-2] carries the model's activity and icon and rejects a record without them", () => {
    const step = { ...record, activity: "查东京明天的天气", activityIcon: "cloud" };
    expect(threadExecutionRecordSchema.parse(step)).toEqual(step);
    const { activity: _activity, ...withoutActivity } = step;
    expect(() => threadExecutionRecordSchema.parse(withoutActivity)).toThrow("$.activity");
    expect(() => threadExecutionRecordSchema.parse({ ...step, activityIcon: 7 })).toThrow(
      "$.activityIcon",
    );
  });
  it.each([null, 42, "a".repeat(65537)])(
    "rejects non-text or oversized execution input",
    (input) => {
      expect(() => threadExecutionRecordSchema.parse({ ...record, input })).toThrow("$.input");
    },
  );
});
