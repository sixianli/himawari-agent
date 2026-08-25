import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  SessionDeletionCoordinator,
  SessionTraceRecorder,
  type TraceEvent,
} from "@himawari-agent/application";
import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTurnId,
} from "@himawari-agent/domain";
import {
  DeterministicFailureScheduler,
  InMemoryDeletionTarget,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-trace");
const AGENT_ID = createAgentId("agent-trace");
const SESSION_ID = createSessionId("session-trace");
const THREAD_ID = createThreadId("thread-trace");
const RUN_ID = createRunId("run-trace");
const TURN_ID = createTurnId("turn-trace");

function createRecorder() {
  const adapters = createReferenceAdapterSet();
  const recorder = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock: adapters.clock,
    ids: adapters.ids,
  });
  return { adapters, recorder };
}

function traceInput(eventType: string) {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    parentEventId: null,
    causationId: "trigger-trace",
    correlationId: "correlation-trace",
    actorId: "agent-control-plane",
    dataClassification: "sensitive" as const,
    eventType,
  };
}

describe("Task 6 Session Trace", () => {
  it("records ordered model, tool, and approval payload references with causal relationships", async () => {
    const { adapters, recorder } = createRecorder();
    const model = await recorder.record({
      ...traceInput("model.request"),
      payload: { prompt: "find a beef restaurant" },
    });
    const tool = await recorder.record({
      ...traceInput("tool.result"),
      parentEventId: model.event.id,
      causationId: model.event.id,
      payload: { restaurants: ["A", "B"] },
    });
    const approval = await recorder.record({
      ...traceInput("approval.requested"),
      parentEventId: tool.event.id,
      causationId: tool.event.id,
      payload: { action: "reserve", restaurant: "A" },
      audit: { action: "approval.request", outcome: "accepted" },
    });

    const events = await adapters.trace.readRun(RUN_ID, 0, 10);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(events.map(({ payloadRef }) => payloadRef)).toEqual([
      model.payloadRef,
      tool.payloadRef,
      approval.payloadRef,
    ]);
    expect(events[1]).toMatchObject({
      parentEventId: model.event.id,
      causationId: model.event.id,
      correlationId: "correlation-trace",
    });
    expect(events[2]).toMatchObject({
      parentEventId: tool.event.id,
      causationId: tool.event.id,
      correlationId: "correlation-trace",
    });
    expect((await adapters.audit.listByAgent(AGENT_ID, null))[0]).toEqual({
      id: "audit-0001",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      action: "approval.request",
      targetRef: RUN_ID,
      outcome: "accepted",
      occurredAt: "2026-08-25T00:00:00.000Z",
    });
  });

  it("rejects sequence gaps and parents outside the Run", async () => {
    const adapters = createReferenceAdapterSet();
    const first: TraceEvent = {
      id: "trace-order-01",
      schemaVersion: "trace.v1",
      ...traceInput("run.accepted"),
      sequence: 1,
      occurredAt: "2026-08-25T00:00:00.000Z",
      recordedAt: "2026-08-25T00:00:00.000Z",
      payloadRef: null,
    };
    await adapters.trace.append(first);

    await expect(
      adapters.trace.append({ ...first, id: "trace-order-03", sequence: 3 }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
    await expect(
      adapters.trace.append({
        ...first,
        id: "trace-parent-missing",
        sequence: 2,
        parentEventId: "trace-not-in-run",
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
  });

  it("redacts structured secrets, headers, URLs, errors, and nested tool results before protection", async () => {
    const { adapters, recorder } = createRecorder();
    const literalSecret = "literal-secret-123";
    const recorded = await recorder.record({
      ...traceInput("tool.result"),
      sensitiveLiterals: [literalSecret],
      payload: {
        apiKey: "api-key-value",
        headers: { Authorization: "Bearer header-secret", Accept: "application/json" },
        url: "https://example.test/search?q=beef&token=url-secret",
        error: new Error(`provider rejected ${literalSecret}`),
        result: { nested: [{ accessToken: "nested-secret", note: literalSecret }] },
      },
    });

    const stored = await adapters.payload.get(recorded.payloadRef as string);
    expect(stored).toBeDefined();
    if (!stored) throw new Error("Expected a protected payload");
    expect(stored).toMatchObject({
      encryption: { algorithm: "test-xor-v1", keyRef: "test-payload-key" },
    });
    const ciphertext = JSON.stringify([...(stored?.ciphertext ?? [])]);
    for (const secret of [
      "api-key-value",
      "header-secret",
      "url-secret",
      "nested-secret",
      literalSecret,
    ]) {
      expect(ciphertext).not.toContain(secret);
    }

    const protectedPayload = await adapters.payloadProtector.revealForTest(stored);
    expect(protectedPayload).toMatchObject({
      apiKey: "[REDACTED]",
      headers: { Authorization: "[REDACTED]", Accept: "application/json" },
      result: { nested: [{ accessToken: "[REDACTED]", note: "[REDACTED]" }] },
    });
    expect((protectedPayload as { url: string }).url).toBe(
      "https://example.test/search?q=beef&token=%5BREDACTED%5D",
    );
    expect((protectedPayload as { error: { message: string } }).error.message).toBe(
      "provider rejected [REDACTED]",
    );
  });

  it("writes a safe incomplete-detail event when a payload cannot be redacted", async () => {
    const { adapters, recorder } = createRecorder();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const result = await recorder.record({
      ...traceInput("model.response"),
      payload: cyclic,
    });

    expect(result).toMatchObject({ payloadRef: null });
    expect(result.event.eventType).toBe("trace.redaction_failed");
    expect(await adapters.payload.get("payload-0001")).toBeUndefined();
    expect(await adapters.audit.listByAgent(AGENT_ID, null)).toMatchObject([
      { action: "trace.redaction_failed", outcome: "failed", targetRef: RUN_ID },
    ]);
  });

  it("keeps partial deletion incomplete until payload, search, cache, and archive all verify", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("deletion.archive.delete", 1);
    const adapters = createReferenceAdapterSet({ failures });
    const targets = ["payload", "search", "cache", "archive"].map(
      (target) => new InMemoryDeletionTarget(target, failures),
    );
    for (const target of targets) target.seed(SESSION_ID);

    const coordinator = new SessionDeletionCoordinator({
      state: adapters.deletionState,
      targets,
      audit: adapters.audit,
      clock: adapters.clock,
      ids: adapters.ids,
    });
    const partial = await coordinator.request({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });

    expect(partial.status).toBe("incomplete");
    expect(partial.targets).toMatchObject({
      payload: { status: "verified" },
      search: { status: "verified" },
      cache: { status: "verified" },
      archive: { status: "failed" },
    });
    expect(() => coordinator.assertVerified(partial)).toThrow(ApplicationPortError);

    const resumed = await new SessionDeletionCoordinator({
      state: adapters.deletionState,
      targets,
      audit: adapters.audit,
      clock: adapters.clock,
      ids: adapters.ids,
    }).resume(partial.id);
    expect(resumed.status).toBe("verified");
    expect(Object.values(resumed.targets).every(({ status }) => status === "verified")).toBe(true);
    expect(() => coordinator.assertVerified(resumed)).not.toThrow();
  });
});
