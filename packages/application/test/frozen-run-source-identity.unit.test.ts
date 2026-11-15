import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createTriggerId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import { frozenRunSourceIdentity, type RunExecutionSource } from "../src/index.js";
import { canonicalAuthorizationSnapshot } from "../src/services/action-intent-snapshot.js";

const frozenBeforeOwnerApprovedTask: RunExecutionSource = {
  ownerId: createOwnerId("owner-1"),
  agentId: createAgentId("agent-1"),
  runId: createRunId("run-1"),
  sessionId: createSessionId("session-1"),
  threadId: null,
  triggerId: createTriggerId("trigger-1"),
  sourceType: "external_event",
  sourceId: "task:proposal-1",
  payloadRef: "payload-1",
  dataClassification: "private",
  occurredAt: "2026-11-15T00:00:00.000Z",
};

describe("frozenRunSourceIdentity", () => {
  it("lets a snapshot frozen without ownerApprovedTask match the live source that now carries it", () => {
    const live: RunExecutionSource = { ...frozenBeforeOwnerApprovedTask, ownerApprovedTask: true };
    expect(canonicalAuthorizationSnapshot(frozenBeforeOwnerApprovedTask)).not.toBe(
      canonicalAuthorizationSnapshot(live),
    );
    expect(
      canonicalAuthorizationSnapshot(frozenRunSourceIdentity(frozenBeforeOwnerApprovedTask)),
    ).toBe(canonicalAuthorizationSnapshot(frozenRunSourceIdentity(live)));
  });

  it("still tells apart sources that differ in a stored field", () => {
    const other: RunExecutionSource = {
      ...frozenBeforeOwnerApprovedTask,
      sourceId: "task:proposal-2",
    };
    expect(
      canonicalAuthorizationSnapshot(frozenRunSourceIdentity(frozenBeforeOwnerApprovedTask)),
    ).not.toBe(canonicalAuthorizationSnapshot(frozenRunSourceIdentity(other)));
  });
});
