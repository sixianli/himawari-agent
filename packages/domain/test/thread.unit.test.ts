import {
  createAgentId,
  createOwnerId,
  createThreadId,
  renameProductThread,
  setThreadAnswerLocale,
  setThreadPinOrder,
  transitionProductThread,
  type ProductThread,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";

const THREAD: ProductThread = Object.freeze({
  id: createThreadId("thread-s2"),
  ownerId: createOwnerId("owner-s2"),
  agentId: createAgentId("agent-s2"),
  revision: 1,
  status: "active",
  titleRef: null,
  titleSource: null,
  titleRevision: 0,
  pinOrder: null,
  answerLocale: "zh-CN",
  messageWatermark: 0,
  lineage: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
});

describe("Product Thread domain", () => {
  it("enforces the lifecycle and immutable deleted state", () => {
    const archived = transitionProductThread(THREAD, "archived", "2026-08-28T00:01:00.000Z");
    const trashed = transitionProductThread(archived, "trashed", "2026-08-28T00:02:00.000Z");
    const pending = transitionProductThread(
      trashed,
      "deletion_pending",
      "2026-08-28T00:03:00.000Z",
    );
    const deleted = transitionProductThread(
      pending,
      "deleted_verified",
      "2026-08-28T00:04:00.000Z",
    );
    expect(deleted).toMatchObject({ revision: 5, status: "deleted_verified" });
    expect(() => transitionProductThread(deleted, "active", "2026-08-28T00:05:00.000Z")).toThrow();
    expect(() => transitionProductThread(THREAD, "deleted_verified", THREAD.updatedAt)).toThrow();
  });

  it("keeps Owner titles authoritative over late automatic results", () => {
    const automatic = renameProductThread(THREAD, {
      titleRef: "payload:title:auto",
      source: "automatic",
      updatedAt: THREAD.updatedAt,
    });
    const owner = renameProductThread(automatic, {
      titleRef: "payload:title:owner",
      source: "owner",
      updatedAt: THREAD.updatedAt,
    });
    expect(owner).toMatchObject({ titleSource: "owner", titleRevision: 2, revision: 3 });
    expect(() =>
      renameProductThread(owner, {
        titleRef: "payload:title:late",
        source: "automatic",
        updatedAt: THREAD.updatedAt,
      }),
    ).toThrow();
  });

  it("accepts only explicit answer locales and stable pin ordering", () => {
    expect(setThreadAnswerLocale(THREAD, "ja", THREAD.updatedAt)).toMatchObject({
      answerLocale: "ja",
      revision: 2,
    });
    expect(setThreadPinOrder(THREAD, 0, THREAD.updatedAt)).toMatchObject({
      pinOrder: 0,
      revision: 2,
    });
    expect(() => setThreadAnswerLocale(THREAD, "zh", THREAD.updatedAt)).toThrow();
    expect(() => setThreadPinOrder(THREAD, -1, THREAD.updatedAt)).toThrow();
  });
});
