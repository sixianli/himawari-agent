import { describe, expect, it } from "vitest";
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  createAgent,
  createAgentId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createRun,
  createRunId,
  createSession,
  createSessionId,
  createThread,
  createThreadId,
  createTrigger,
  createTriggerId,
  createTurn,
  createTurnId,
} from "../src/index.js";

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected a DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("stable identities", () => {
  it("publishes stable machine-readable error codes", () => {
    expect(DOMAIN_ERROR_CODES).toEqual({
      INVALID_IDENTIFIER: "DOMAIN_INVALID_IDENTIFIER",
      OWNERSHIP_MISMATCH: "DOMAIN_OWNERSHIP_MISMATCH",
      INVALID_RUN_TRANSITION: "DOMAIN_INVALID_RUN_TRANSITION",
      RUN_ALREADY_TERMINAL: "DOMAIN_RUN_ALREADY_TERMINAL",
      AUTHORITY_LEASE_CONFLICT: "DOMAIN_AUTHORITY_LEASE_CONFLICT",
      AUTHORITY_LEASE_NOT_HELD: "DOMAIN_AUTHORITY_LEASE_NOT_HELD",
      AUTHORITY_LEASE_SCOPE_MISMATCH: "DOMAIN_AUTHORITY_LEASE_SCOPE_MISMATCH",
      INVALID_STATE_TRANSITION: "DOMAIN_INVALID_STATE_TRANSITION",
      STALE_AUTHORITY_FENCE: "DOMAIN_STALE_AUTHORITY_FENCE",
      INVALID_STATE_VALUE: "DOMAIN_INVALID_STATE_VALUE",
    });
    expect(Object.isFrozen(DOMAIN_ERROR_CODES)).toBe(true);
  });

  it("keeps every accepted identifier byte-for-byte stable", () => {
    const cases = [
      [createOwnerId, "owner-01"],
      [createAgentId, "agent:primary"],
      [createThreadId, "thread_01"],
      [createSessionId, "session.01"],
      [createRunId, "run-01"],
      [createTurnId, "turn-01"],
      [createTriggerId, "trigger-01"],
    ] as const;

    for (const [createId, value] of cases) expect(createId(value)).toBe(value);
  });

  it.each(["", " owner-01", "owner-01 ", "owner/01", "owner\n01"])(
    "rejects an invalid machine identifier %j",
    (value) => {
      expectDomainError(() => createOwnerId(value), DOMAIN_ERROR_CODES.INVALID_IDENTIFIER);
    },
  );

  it("rejects blank or padded idempotency keys", () => {
    for (const value of ["", " duplicate-key", "duplicate-key "]) {
      expectDomainError(() => createIdempotencyKey(value), DOMAIN_ERROR_CODES.INVALID_IDENTIFIER);
    }
  });
});

describe("identity ownership", () => {
  it("derives an immutable ownership chain from Owner through Turn", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const thread = createThread({ id: createThreadId("thread-01"), agent });
    const session = createSession({ id: createSessionId("session-01"), agent, thread });
    const trigger = createTrigger({
      id: createTriggerId("trigger-01"),
      idempotencyKey: createIdempotencyKey("message-01"),
      agent,
      thread,
    });
    const run = createRun({ id: createRunId("run-01"), session, trigger });
    const turn = createTurn({ id: createTurnId("turn-01"), run });

    expect(agent.ownerId).toBe(owner.id);
    expect(thread).toMatchObject({ ownerId: owner.id, agentId: agent.id });
    expect(session).toMatchObject({
      ownerId: owner.id,
      agentId: agent.id,
      threadId: thread.id,
    });
    expect(run).toMatchObject({
      ownerId: owner.id,
      agentId: agent.id,
      threadId: thread.id,
      sessionId: session.id,
      triggerId: trigger.id,
      status: "accepted",
    });
    expect(turn).toMatchObject({
      ownerId: owner.id,
      agentId: agent.id,
      threadId: thread.id,
      sessionId: session.id,
      runId: run.id,
    });

    for (const entity of [owner, agent, thread, session, trigger, run, turn]) {
      expect(Object.isFrozen(entity)).toBe(true);
    }
  });

  it("rejects a Thread owned by another Agent when creating a Session or Trigger", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const otherOwner = createOwner(createOwnerId("owner-02"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const otherAgent = createAgent({ id: createAgentId("agent-02"), owner: otherOwner });
    const thread = createThread({ id: createThreadId("thread-01"), agent });

    expectDomainError(
      () => createSession({ id: createSessionId("session-01"), agent: otherAgent, thread }),
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
    );
    expectDomainError(
      () =>
        createTrigger({
          id: createTriggerId("trigger-01"),
          idempotencyKey: createIdempotencyKey("message-01"),
          agent: otherAgent,
          thread,
        }),
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
    );
  });

  it("rejects a Trigger associated with another Agent when creating a Run", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const otherAgent = createAgent({ id: createAgentId("agent-02"), owner });
    const thread = createThread({ id: createThreadId("thread-01"), agent });
    const session = createSession({ id: createSessionId("session-01"), agent, thread });
    const trigger = createTrigger({
      id: createTriggerId("trigger-01"),
      idempotencyKey: createIdempotencyKey("message-01"),
      agent: otherAgent,
    });

    expectDomainError(
      () => createRun({ id: createRunId("run-01"), session, trigger }),
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
    );
  });

  it("rejects a Trigger targeting a different Thread in the same Agent", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const sessionThread = createThread({ id: createThreadId("thread-01"), agent });
    const triggerThread = createThread({ id: createThreadId("thread-02"), agent });
    const session = createSession({
      id: createSessionId("session-01"),
      agent,
      thread: sessionThread,
    });
    const trigger = createTrigger({
      id: createTriggerId("trigger-01"),
      idempotencyKey: createIdempotencyKey("message-01"),
      agent,
      thread: triggerThread,
    });

    expectDomainError(
      () => createRun({ id: createRunId("run-01"), session, trigger }),
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
    );
  });

  it("allows admission to associate a Thread when the original Trigger had none", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const thread = createThread({ id: createThreadId("thread-01"), agent });
    const session = createSession({ id: createSessionId("session-01"), agent, thread });
    const trigger = createTrigger({
      id: createTriggerId("trigger-01"),
      idempotencyKey: createIdempotencyKey("message-01"),
      agent,
    });

    const run = createRun({ id: createRunId("run-01"), session, trigger });
    expect(run.threadId).toBe(thread.id);
  });
});
