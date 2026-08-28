import {
  ContractValidationError,
  THREAD_GATEWAY_SCHEMA_VERSION,
  archiveThreadV3CommandSchema,
  deleteThreadPermanentlyV3CommandSchema,
  forkThreadV3CommandSchema,
  resolveThreadTaskV3CommandSchema,
  searchThreadsV3QuerySchema,
  setThreadAnswerLocaleV3CommandSchema,
  submitThreadMessageV3CommandSchema,
  threadCollectionSnapshotV3Schema,
  threadDetailSnapshotV3Schema,
  threadEventsV3SubscriptionSchema,
  threadConflictV3Schema,
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
            },
          ],
          runs: [
            {
              runId: "run-s2",
              revision: 2,
              status: "running",
              createdAt: "2026-08-28T00:00:30.000Z",
              updatedAt: "2026-08-28T00:01:00.000Z",
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
