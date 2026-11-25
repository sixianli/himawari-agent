import type { DecisionLedgerWrite, ThreadDistillationStatePort } from "@himawari-agent/application";
import { ContextFormationService, SessionTraceRecorder } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import { createReferenceAdapterSet, DeterministicFailureScheduler } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";

const OWNER_ID = createOwnerId("owner-context");
const AGENT_ID = createAgentId("agent-context");
const SESSION_ID = createSessionId("session-context");
const THREAD_ID = createThreadId("thread-context");
const RUN_ID = createRunId("run-context");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";

async function seedMemory(
  memory: ReturnType<typeof createReferenceAdapterSet>["memory"],
  input: {
    readonly id: string;
    readonly contentRef: string;
    readonly sourceRef: string;
    readonly searchTerms: readonly string[];
    readonly dataClassification: "private" | "restricted";
  },
): Promise<void> {
  await memory.proposeWrite({
    id: `proposal-${input.id}`,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    contentRef: input.contentRef,
    sourceRef: input.sourceRef,
    searchTerms: input.searchTerms,
    dataClassification: input.dataClassification,
    proposedAt: T0,
  });
  await memory.commitWrite(`proposal-${input.id}`, input.id, T1);
}

function createService(
  threadSummaries?: Pick<ThreadDistillationStatePort, "latestSummary">,
  ledger?: { append(write: DecisionLedgerWrite): Promise<void> },
) {
  const adapters = createReferenceAdapterSet({ scope: { ownerId: OWNER_ID, agentId: AGENT_ID } });
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock: adapters.clock,
    ids: adapters.ids,
  });
  return {
    adapters,
    service: new ContextFormationService({
      memory: adapters.memory,
      trace,
      artifacts: adapters.runPayloadArtifacts,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      clock: adapters.clock,
      ids: adapters.ids,
      ...(threadSummaries ? { threadSummaries } : {}),
      ...(ledger
        ? {
            ledger: {
              append: (write: DecisionLedgerWrite) => ledger.append(write),
              appendIfChanged: async ({ write }: { readonly write: DecisionLedgerWrite }) => {
                await ledger.append(write);
                return true;
              },
            },
          }
        : {}),
    }),
  };
}

function request(sourceType: "user_message" | "schedule" | "external_event") {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    trigger: {
      id: `trigger-${sourceType}`,
      sourceType,
      payloadRef: `payload-trigger-${sourceType}`,
      occurredAt: T1,
    },
    threadMessages: [
      {
        id: "message-context-01",
        role: "user" as const,
        payloadRef: "payload-thread-message-01",
        occurredAt: T0,
      },
    ],
    sourceWatermark: null,
    policyVersion: "context-policy-v1",
    policies: [{ ref: "policy-owner-01", payloadRef: "payload-policy-owner-01" }],
    memoryQueryRef: "payload-memory-query-01",
    memoryQueryTerms: ["beef", "dinner"],
    memoryLimit: 10,
    capabilities: [
      {
        ref: "restaurant-search",
        version: "1.0.0",
        summaryRef: "payload-capability-summary-01",
        authorizationRef: "policy-readonly-search",
      },
    ],
    correlationId: `correlation-${sourceType}`,
    causationId: `trigger-event-${sourceType}`,
    parentEventId: null,
    actorId: "run-coordinator",
    dataClassification: "private" as const,
  };
}

describe("Task 9 Memory and context formation", () => {
  it("searches memory while the owner profile is still being composed", async () => {
    const adapters = createReferenceAdapterSet({ scope: { ownerId: OWNER_ID, agentId: AGENT_ID } });
    const trace = new SessionTraceRecorder({
      trace: adapters.trace,
      artifacts: adapters.runPayloadArtifacts,
      protector: adapters.payloadProtector,
      audit: adapters.audit,
      clock: adapters.clock,
      ids: adapters.ids,
    });
    let releaseProfile = () => {};
    const profileHeld = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    const steps: string[] = [];
    const service = new ContextFormationService({
      memory: {
        search: async (input) => {
          steps.push("search.started");
          releaseProfile();
          return adapters.memory.search(input);
        },
      },
      profile: {
        compose: async () => {
          steps.push("profile.started");
          await profileHeld;
          steps.push("profile.finished");
          return { blocks: [], memoryIds: [] };
        },
      },
      trace,
      artifacts: adapters.runPayloadArtifacts,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      clock: adapters.clock,
      ids: adapters.ids,
    });

    await service.form(request("user_message"));

    expect(steps).toEqual(["profile.started", "search.started", "profile.finished"]);
  });

  it("freezes historical cancellation with the selected message across replay", async () => {
    const { service } = createService();
    const input = request("user_message");
    const previous = input.threadMessages[0];
    if (!previous) throw new Error("Expected history");
    const runState = { runId: createRunId("run-previous"), status: "cancelled" as const };
    const formed = await service.form({
      ...input,
      threadMessages: [{ ...previous, runState }],
    });
    expect(formed.envelope.history[0]).toMatchObject({ runState });
    const replayed = await service.form(input);
    expect(replayed.envelope.history[0]).toMatchObject({ runState });
  });

  it("replays an existing context artifact without reselecting after Trace failure", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("trace.append", 4);
    const adapters = createReferenceAdapterSet({
      failures,
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    });
    const trace = new SessionTraceRecorder({
      trace: adapters.trace,
      artifacts: adapters.runPayloadArtifacts,
      protector: adapters.payloadProtector,
      audit: adapters.audit,
      clock: adapters.clock,
      ids: adapters.ids,
    });
    const service = new ContextFormationService({
      memory: adapters.memory,
      trace,
      artifacts: adapters.runPayloadArtifacts,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      clock: adapters.clock,
      ids: adapters.ids,
    });
    await expect(service.form(request("user_message"))).rejects.toMatchObject({
      code: "PORT_INJECTED_FAILURE",
    });
    const search = vi.spyOn(adapters.memory, "search");

    const replayed = await service.form({
      ...request("user_message"),
      memoryQueryTerms: ["changed", "after", "failure"],
    });

    const contextArtifact = await adapters.runPayloadArtifacts.lookup({
      runId: RUN_ID,
      purpose: "context",
      operationKey: `context:${RUN_ID}`,
    });
    expect(contextArtifact).toBeDefined();
    expect(replayed.contextEnvelopeRef).toBe(contextArtifact?.payloadRef);
    expect(replayed.traceEventIds).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("places the runtime environment last with a fixed ref and keeps it on replay", async () => {
    const { service } = createService();
    const formed = await service.form({
      ...request("user_message"),
      runtimeEnvironmentRef: "payload-runtime-environment-01",
    });
    expect(formed.envelope.contextBlocks.at(-1)).toEqual({
      kind: "runtime-environment",
      ref: "runtime-environment",
      payloadRef: "payload-runtime-environment-01",
      dataClassification: "private",
    });
    expect(formed.injectedContentRefs).toContain("payload-runtime-environment-01");
    const replayed = await service.form({
      ...request("user_message"),
      runtimeEnvironmentRef: "payload-runtime-environment-01",
    });
    expect(replayed.envelope.contextBlocks).toEqual(formed.envelope.contextBlocks);
    expect(replayed.injectedContentRefs).toContain("payload-runtime-environment-01");
    const withoutEnvironment = await createService().service.form(request("user_message"));
    expect(
      withoutEnvironment.envelope.contextBlocks.some(({ kind }) => kind === "runtime-environment"),
    ).toBe(false);
  });

  it("selects permitted history deterministically and injects the protected answer locale policy", async () => {
    const { adapters, service } = createService();
    const formed = await service.form({
      ...request("user_message"),
      historyCandidates: [
        {
          id: "message-low",
          role: "user",
          payloadRef: "payload-history-low",
          sourceRef: "thread:context:message:low",
          occurredAt: "2026-08-25T00:00:01.000Z",
          dataClassification: "private",
          relevanceScore: 0.2,
        },
        {
          id: "message-restricted",
          role: "assistant",
          payloadRef: "payload-history-restricted",
          sourceRef: "thread:context:message:restricted",
          occurredAt: "2026-08-25T00:00:02.000Z",
          dataClassification: "restricted",
          relevanceScore: 1,
        },
        {
          id: "message-high-newer",
          role: "assistant",
          payloadRef: "payload-history-high-newer",
          sourceRef: "thread:context:message:high-newer",
          occurredAt: "2026-08-25T00:00:04.000Z",
          dataClassification: "private",
          relevanceScore: 0.9,
        },
        {
          id: "message-high-older",
          role: "user",
          payloadRef: "payload-history-high-older",
          sourceRef: "thread:context:message:high-older",
          occurredAt: "2026-08-25T00:00:03.000Z",
          dataClassification: "private",
          relevanceScore: 0.8,
        },
      ],
      maxThreadMessages: 2,
      answerLocalePolicy: {
        ref: "policy-answer-locale-ja",
        payloadRef: "payload-policy-answer-locale-ja",
        locale: "ja",
      },
    });

    expect(formed.answerLocale).toBe("ja");
    expect(formed.injectedContentRefs.slice(0, 4)).toEqual([
      "payload-history-high-older",
      "payload-history-high-newer",
      "payload-trigger-user_message",
      "payload-policy-owner-01",
    ]);
    expect(formed.injectedContentRefs).toContain("payload-policy-answer-locale-ja");

    const events = await adapters.trace.readRun(RUN_ID, 0, 10);
    const finalPayload = await adapters.payload.get(events.at(-1)?.payloadRef ?? "missing");
    if (!finalPayload) throw new Error("Expected protected context payload");
    await expect(adapters.payloadProtector.revealForTest(finalPayload)).resolves.toMatchObject({
      answerLocalePolicy: { locale: "ja", ref: "policy-answer-locale-ja" },
      threadHistory: {
        selected: [
          { id: "message-high-older", sourceRef: "thread:context:message:high-older" },
          { id: "message-high-newer", sourceRef: "thread:context:message:high-newer" },
        ],
        excluded: expect.arrayContaining([
          expect.objectContaining({
            id: "message-low",
            reasonCode: "history_selection_limit_reached",
          }),
          expect.objectContaining({
            id: "message-restricted",
            reasonCode: "classification_exceeds_context",
          }),
        ]),
      },
    });
  });

  it("adds an eligible durable Thread summary without replacing transcript messages", async () => {
    const { service } = createService({
      async latestSummary(threadId) {
        return {
          id: "summary-context-01",
          generationId: createMemoryGenerationId("generation-context-01"),
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId,
          contentRef: "payload-thread-summary-01",
          dataClassification: "private",
          sourceStartSequence: 1,
          sourceEndSequence: 8,
          sourceWatermark: 8,
          policyVersion: "thread-distillation-v1",
          modelDescriptorRef: "deterministic/thread-distiller@v1",
          createdAt: T1,
        };
      },
    });

    const formed = await service.form(request("user_message"));
    expect(formed.injectedContentRefs.slice(0, 2)).toEqual([
      "payload-thread-summary-01",
      "payload-thread-message-01",
    ]);
  });

  it("selects relevant permitted memories with provenance and traces each formation phase", async () => {
    const { adapters, service } = createService();
    await seedMemory(adapters.memory, {
      id: "memory-beef",
      contentRef: "payload-memory-beef",
      sourceRef: "trace-user-preference-beef",
      searchTerms: ["beef", "restaurant"],
      dataClassification: "private",
    });
    await seedMemory(adapters.memory, {
      id: "memory-dinner",
      contentRef: "payload-memory-dinner",
      sourceRef: "trace-user-dinner",
      searchTerms: ["dinner"],
      dataClassification: "private",
    });
    await seedMemory(adapters.memory, {
      id: "memory-restricted",
      contentRef: "payload-memory-restricted",
      sourceRef: "trace-restricted-profile",
      searchTerms: ["beef", "dinner"],
      dataClassification: "restricted",
    });
    await seedMemory(adapters.memory, {
      id: "memory-unrelated",
      contentRef: "payload-memory-sushi",
      sourceRef: "trace-user-preference-sushi",
      searchTerms: ["sushi"],
      dataClassification: "private",
    });

    const formed = await service.form(request("user_message"));
    expect(formed.candidates.map(({ id }) => id)).toEqual([
      "memory-restricted",
      "memory-beef",
      "memory-dinner",
    ]);
    expect(formed.selected.map(({ id }) => id)).toEqual(["memory-beef", "memory-dinner"]);
    expect(formed.injectedContentRefs).toEqual([
      "payload-thread-message-01",
      "payload-trigger-user_message",
      "payload-policy-owner-01",
      "payload-memory-beef",
      "payload-memory-dinner",
      "payload-capability-summary-01",
    ]);

    const events = await adapters.trace.readRun(RUN_ID, 0, 10);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "memory.query",
      "memory.candidates",
      "memory.selection",
      "context.formed",
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(events[1]?.parentEventId).toBe(events[0]?.id);
    expect(events[2]?.parentEventId).toBe(events[1]?.id);
    expect(events[3]?.parentEventId).toBe(events[2]?.id);

    const candidatesPayload = await adapters.payload.get(events[1]?.payloadRef ?? "missing");
    const selectionPayload = await adapters.payload.get(events[2]?.payloadRef ?? "missing");
    const finalPayload = await adapters.payload.get(events[3]?.payloadRef ?? "missing");
    if (!candidatesPayload || !selectionPayload || !finalPayload) {
      throw new Error("Expected protected context Trace payloads");
    }
    await expect(adapters.payloadProtector.revealForTest(candidatesPayload)).resolves.toMatchObject(
      {
        candidates: [
          { id: "memory-restricted", sourceRef: "trace-restricted-profile" },
          { id: "memory-beef", sourceRef: "trace-user-preference-beef" },
          { id: "memory-dinner", sourceRef: "trace-user-dinner" },
        ],
      },
    );
    await expect(adapters.payloadProtector.revealForTest(selectionPayload)).resolves.toMatchObject({
      selected: [
        { id: "memory-beef", reasonCode: "relevant_and_classification_allowed" },
        { id: "memory-dinner", reasonCode: "relevant_and_classification_allowed" },
      ],
      excluded: [{ id: "memory-restricted", reasonCode: "classification_exceeds_context" }],
    });
    await expect(adapters.payloadProtector.revealForTest(finalPayload)).resolves.toMatchObject({
      trigger: { sourceType: "user_message" },
      injectedContentRefs: formed.injectedContentRefs,
    });
  });

  it("[ADR-0286] brings every memory that clears the relevance threshold, with no count cap, and leaves out unrelated ones", async () => {
    const written: DecisionLedgerWrite[] = [];
    const { adapters, service } = createService(undefined, {
      append: async (write) => {
        written.push(write);
      },
    });
    const related = Array.from({ length: 7 }, (_, index) => `memory-beef-${index}`);
    for (const id of [...related, "memory-piano"])
      await seedMemory(adapters.memory, {
        id,
        contentRef: `payload-${id}`,
        sourceRef: `trace-${id}`,
        searchTerms: [id === "memory-piano" ? "piano" : "beef"],
        dataClassification: "private",
      });
    const formed = await service.form(request("user_message"));
    expect(formed.selected.map(({ id }) => id).sort()).toEqual([...related].sort());
    expect(written).toEqual([]);
  });

  it("writes no ledger row when nothing was cut or only classification excluded a memory", async () => {
    const written: DecisionLedgerWrite[] = [];
    const { adapters, service } = createService(undefined, {
      append: async (write) => {
        written.push(write);
      },
    });
    await seedMemory(adapters.memory, {
      id: "memory-beef",
      contentRef: "payload-memory-beef",
      sourceRef: "trace-beef",
      searchTerms: ["beef"],
      dataClassification: "private",
    });
    await seedMemory(adapters.memory, {
      id: "memory-restricted",
      contentRef: "payload-memory-restricted",
      sourceRef: "trace-restricted",
      searchTerms: ["beef"],
      dataClassification: "restricted",
    });
    const formed = await service.form(request("user_message"));
    expect(formed.selected.map(({ id }) => id)).toEqual(["memory-beef"]);
    expect(written).toEqual([]);
  });

  it.each(["user_message", "schedule", "external_event"] as const)(
    "routes %s through the same context-formation pipeline",
    async (sourceType) => {
      const { adapters, service } = createService();
      await seedMemory(adapters.memory, {
        id: `memory-${sourceType}`,
        contentRef: `payload-memory-${sourceType}`,
        sourceRef: `trace-memory-${sourceType}`,
        searchTerms: ["beef"],
        dataClassification: "private",
      });

      const formed = await service.form(request(sourceType));
      expect(formed.triggerSourceType).toBe(sourceType);
      expect(formed.selected.map(({ id }) => id)).toEqual([`memory-${sourceType}`]);
      expect(
        (await adapters.trace.readRun(RUN_ID, 0, 10)).map(({ eventType }) => eventType),
      ).toEqual(["memory.query", "memory.candidates", "memory.selection", "context.formed"]);
    },
  );
});
