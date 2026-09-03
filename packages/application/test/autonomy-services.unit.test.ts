import {
  DelegationService,
  DurableDelegationStateAdapter,
  DurableImprovementStateAdapter,
  DurableProactivityStateAdapter,
  ImprovementCandidateService,
  ReflectionService,
  SuggestionService,
  WorkerResultService,
  type CandidateWorkspacePort,
  type CommandProfile,
  type ImprovementComparison,
  type ReflectionCandidateDraft,
  type SuggestionDeliveryPort,
  type SuggestionTaskCreationPort,
  type WorkerResult,
  type WorkerRunEvent,
  type WorkerRunPort,
} from "../src/index.js";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import { TestStateStore, testDigest } from "./test-support.js";

const ownerId = createOwnerId("owner-autonomy-unit");
const agentId = createAgentId("agent-autonomy-unit");
const runId = createRunId("run-autonomy-unit");

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(
  options: { tasks?: SuggestionTaskCreationPort; delivery?: SuggestionDeliveryPort } = {},
) {
  const store = new TestStateStore();
  let now = "2026-03-08T06:30:00.000Z";
  let sequence = 0;
  const taskInputs: unknown[] = [];
  const createSuggestion = () =>
    new SuggestionService({
      state: new DurableProactivityStateAdapter(store),
      delivery: options.delivery ?? { enqueue: async ({ suggestion }) => `inbox:${suggestion.id}` },
      tasks: options.tasks ?? {
        createOrdinaryTask: async (input) => {
          taskInputs.push(input);
          return `task:${input.suggestionId}`;
        },
      },
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: { now: () => now },
      ids: { next: (namespace) => `${namespace}-${++sequence}` },
    });
  const suggestion = createSuggestion();
  return {
    store,
    suggestion,
    createSuggestion,
    taskInputs,
    clock: { now: () => now },
    ids: { next: (namespace: string) => `${namespace}-${++sequence}` },
    setNow: (value: string) => {
      now = value;
    },
  };
}

function draft(action: string, evidence = `evidence:${action}`): ReflectionCandidateDraft {
  return {
    kind: "goal-follow-up",
    titleRef: `payload:title:${action}`,
    bodyRef: `payload:body:${action}`,
    evidenceRefs: [evidence],
    sourceWatermark: "watermark:1",
    goalRef: "goal:1",
    commitmentRef: null,
    taskDraft: {
      goalRef: `payload:goal:${action}`,
      trigger: "owner_approved_suggestion",
      capabilityRefs: ["capability:read"],
      dataClassification: "private",
      estimatedCostMicros: 100,
      timezone: "America/New_York",
      timeoutMs: 10_000,
    },
    confidencePermille: 800,
    noveltyPermille: 700,
    targetEntity: "goal:1",
    proposedAction: action,
    ownerScopeRevision: 1,
    estimatedDataClasses: ["private"],
    expiresAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("SuggestionService and ReflectionService", () => {
  it("recovers an approved Task intent after its acknowledgement is lost", async () => {
    const tasks = new Map<string, string>();
    let fail = true;
    const f = fixture({
      tasks: {
        createOrdinaryTask: async ({ idempotencyKey, suggestionId }) => {
          const task = tasks.get(idempotencyKey) ?? `task:${suggestionId}`;
          tasks.set(idempotencyKey, task);
          if (fail) {
            fail = false;
            throw new Error("Task acknowledgement lost");
          }
          return task;
        },
      },
    });
    const proposed = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:lost-task",
      draft: draft("lost-task"),
    });
    if (!proposed.candidate) throw new Error("missing candidate");
    await expect(
      f.suggestion.respond({
        ownerId,
        agentId,
        suggestionId: proposed.candidate.id,
        decision: "approve",
        idempotencyKey: "owner-response",
      }),
    ).rejects.toThrow("Task acknowledgement lost");
    const state = new DurableProactivityStateAdapter(f.store);
    expect((await state.read(ownerId, agentId)).state.suggestions[0]).toMatchObject({
      status: "approved",
      taskRef: null,
    });
    await f.createSuggestion().recoverTaskIntents(ownerId, agentId);
    expect(tasks.size).toBe(1);
    expect((await state.read(ownerId, agentId)).state.suggestions[0]).toMatchObject({
      status: "approved",
      taskRef: `task:${proposed.candidate.id}`,
    });
  });

  it("resumes stored reflection output and preserves its original Run and Trace", async () => {
    let failDelivery = true;
    const f = fixture({
      delivery: {
        enqueue: async ({ suggestion }) => {
          if (failDelivery) {
            failDelivery = false;
            throw new Error("delivery interrupted");
          }
          return `inbox:${suggestion.id}`;
        },
      },
    });
    let modelCalls = 0;
    let contextCalls = 0;
    const createReflection = () =>
      new ReflectionService({
        state: new DurableProactivityStateAdapter(f.store),
        suggestions: f.createSuggestion(),
        context: {
          select: async () => {
            contextCalls += 1;
            return {
              inputRef: "payload:frozen-context",
              watermark: "watermark:frozen",
              itemCount: 1,
            };
          },
        },
        model: {
          reflect: async () => {
            modelCalls += 1;
            return {
              outcome: "candidates",
              candidates: [draft("resume-reflection")],
              costMicros: 12,
              metadata: {},
            };
          },
        },
        clock: f.clock,
        ids: f.ids,
      });
    const service = createReflection();
    await service.configure({
      id: "global-reflection",
      revision: 1,
      ownerId,
      agentId,
      schedule: "daily:09:00",
      timezone: "Asia/Tokyo",
      dailySuggestionQuota: 3,
      maximumContextItems: 10,
      maximumCostMicros: 1000,
      timeoutMs: 5000,
      maximumCandidates: 3,
      enabled: true,
    });
    const input = {
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:original",
      scheduledAt: f.clock.now(),
      hostWasOnlineAtSchedule: true,
      previousWatermark: "watermark:before",
    };
    await expect(service.run(input)).rejects.toThrow("delivery interrupted");
    expect(
      await createReflection().run({
        ...input,
        generationRunId: createRunId("recovery-run"),
        traceRef: "trace:recovery",
      }),
    ).toMatchObject({ outcome: "candidates", generationRunId: runId, traceRef: "trace:original" });
    expect(modelCalls).toBe(1);
    expect(contextCalls).toBe(1);
    const saved = await new DurableProactivityStateAdapter(f.store).read(ownerId, agentId);
    expect(saved.state.suggestions).toHaveLength(1);
    expect(saved.state.suggestions[0]).toMatchObject({
      generationRunId: runId,
      traceRef: "trace:original",
    });
  });
  it("claims approval before Task creation and rejects a competing response", async () => {
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const f = fixture({
      tasks: {
        createOrdinaryTask: async ({ suggestionId }) => {
          calls += 1;
          started.resolve();
          await release.promise;
          return `task:${suggestionId}`;
        },
      },
    });
    const proposed = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:race",
      draft: draft("race"),
    });
    if (!proposed.candidate) throw new Error("missing candidate");
    const input = { ownerId, agentId, suggestionId: proposed.candidate.id };
    const approving = f.suggestion.respond({
      ...input,
      decision: "approve",
      idempotencyKey: "approve:race",
    });
    await started.promise;
    const rejecting = await f.suggestion
      .respond({ ...input, decision: "reject", idempotencyKey: "reject:race" })
      .then(
        () => "accepted",
        () => "rejected",
      );
    release.resolve();
    expect((await approving).status).toBe("approved");
    expect(rejecting).toBe("rejected");
    expect(calls).toBe(1);
  });

  it("checks expiry inside the response decision without requiring an expiry sweep", async () => {
    const f = fixture();
    const proposed = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:expired",
      draft: draft("expired"),
    });
    if (!proposed.candidate) throw new Error("missing candidate");
    f.setNow(proposed.candidate.expiresAt);
    await expect(
      f.suggestion.respond({
        ownerId,
        agentId,
        suggestionId: proposed.candidate.id,
        decision: "approve",
        idempotencyKey: "expired:response",
      }),
    ).rejects.toThrow();
    expect(f.taskInputs).toHaveLength(0);
  });

  it("does not restore an expired suggestion when an earlier delivery completes", async () => {
    const started = deferred();
    const release = deferred();
    const f = fixture({
      delivery: {
        enqueue: async ({ suggestion }) => {
          started.resolve();
          await release.promise;
          return `inbox:${suggestion.id}`;
        },
      },
    });
    const pending = f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:delivery",
      draft: draft("delivery"),
    });
    await started.promise;
    f.setNow("2026-04-01T00:00:00.000Z");
    await f.suggestion.expire(ownerId, agentId);
    release.resolve();
    expect((await pending).candidate?.status).toBe("expired");
  });

  it("allows only one live reflection attempt per scheduled checkpoint", async () => {
    const f = fixture();
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const reflection = new ReflectionService({
      state: new DurableProactivityStateAdapter(f.store),
      suggestions: f.suggestion,
      context: {
        select: async () => ({
          inputRef: "payload:context",
          watermark: "watermark:one",
          itemCount: 1,
        }),
      },
      model: {
        reflect: async () => {
          calls += 1;
          started.resolve();
          await release.promise;
          return { outcome: "no_change", candidates: [], costMicros: 0, metadata: {} };
        },
      },
      clock: f.clock,
      ids: f.ids,
    });
    await reflection.configure({
      id: "global-reflection",
      revision: 1,
      ownerId,
      agentId,
      schedule: "daily:09:00",
      timezone: "Asia/Tokyo",
      dailySuggestionQuota: 3,
      maximumContextItems: 10,
      maximumCostMicros: 1000,
      timeoutMs: 5000,
      maximumCandidates: 3,
      enabled: true,
    });
    const input = {
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:concurrent-reflection",
      scheduledAt: f.clock.now(),
      hostWasOnlineAtSchedule: true,
      previousWatermark: "watermark:zero",
    };
    const first = reflection.run(input);
    await started.promise;
    const others = [reflection.run(input), reflection.run(input), reflection.run(input)];
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    release.resolve();
    await Promise.all([first, ...others]);
    expect(calls).toBe(1);
  });

  it("deduplicates evidence, atomically caps a local civil day, and creates only a re-authorized ordinary Task", async () => {
    const f = fixture();
    const first = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:1",
      draft: draft("act-1"),
    });
    expect(first.outcome).toBe("accepted");
    const duplicate = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:2",
      draft: draft("act-1"),
    });
    expect(duplicate.outcome).toBe("duplicate");
    await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:3",
      draft: draft("act-2"),
    });
    await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:4",
      draft: draft("act-3"),
    });
    const fourth = await f.suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:5",
      draft: draft("act-4"),
    });
    expect(fourth.outcome).toBe("quota_exhausted");

    if (!first.candidate) throw new TypeError("accepted suggestion missing");
    const approved = await f.suggestion.respond({
      ownerId,
      agentId,
      suggestionId: first.candidate.id,
      decision: "approve",
      idempotencyKey: "owner-response-1",
    });
    expect(approved.status).toBe("approved");
    expect(f.taskInputs).toEqual([
      expect.objectContaining({ capabilityHandleRefs: [], approvalRefs: [] }),
    ]);
    expect(
      await f.suggestion.respond({
        ownerId,
        agentId,
        suggestionId: first.candidate.id,
        decision: "approve",
        idempotencyKey: "owner-response-1",
      }),
    ).toEqual(approved);
  });

  it("recovers Inbox delivery by suggestion identity and reopens a rejection only for new evidence", async () => {
    const store = new TestStateStore();
    const state = new DurableProactivityStateAdapter(store);
    const delivered = new Set<string>();
    let crashOnce = true;
    let sequence = 0;
    const service = new SuggestionService({
      state,
      delivery: {
        enqueue: async ({ idempotencyKey }) => {
          delivered.add(idempotencyKey);
          if (crashOnce) {
            crashOnce = false;
            throw new Error("delivery acknowledgement lost");
          }
          return `inbox:${idempotencyKey}`;
        },
      },
      tasks: { createOrdinaryTask: async ({ suggestionId }) => `task:${suggestionId}` },
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: { now: () => "2026-03-08T07:30:00.000Z" },
      ids: { next: (namespace) => `${namespace}-recovery-${++sequence}` },
    });
    const input = {
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:delivery-recovery",
      draft: draft("recovery"),
      dailyQuota: 1,
    };
    await expect(service.propose(input)).rejects.toThrow("delivery acknowledgement lost");
    const recovered = await service.propose(input);
    expect(recovered).toMatchObject({ outcome: "accepted", candidate: { status: "delivered" } });
    expect(delivered.size).toBe(1);
    if (!recovered.candidate) throw new TypeError("recovered suggestion missing");
    await service.respond({
      ownerId,
      agentId,
      suggestionId: recovered.candidate.id,
      decision: "reject",
      idempotencyKey: "response:reject-recovery",
    });
    expect((await service.propose(input)).outcome).toBe("duplicate");
    expect(
      (
        await service.propose({
          ...input,
          draft: draft("recovery", "evidence:materially-new"),
        })
      ).outcome,
    ).toBe("accepted");
  });

  it("records no-change and offline MISSED checkpoints without backfill", async () => {
    const f = fixture();
    const state = new DurableProactivityStateAdapter(f.store);
    const reflection = new ReflectionService({
      state,
      suggestions: f.suggestion,
      context: {
        select: async () => ({
          inputRef: "payload:context",
          watermark: "watermark:2",
          itemCount: 2,
        }),
      },
      model: {
        reflect: async () => ({
          outcome: "no_change",
          candidates: [],
          costMicros: 10,
          metadata: {},
        }),
      },
      clock: f.clock,
      ids: f.ids,
    });
    await reflection.configure({
      id: "global-reflection",
      revision: 1,
      ownerId,
      agentId,
      schedule: "daily:09:00",
      timezone: "America/New_York",
      dailySuggestionQuota: 3,
      maximumContextItems: 10,
      maximumCostMicros: 1000,
      timeoutMs: 5000,
      maximumCandidates: 3,
      enabled: true,
    });
    const noChange = await reflection.run({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:reflection",
      scheduledAt: "2026-03-08T13:00:00.000Z",
      hostWasOnlineAtSchedule: true,
      previousWatermark: "watermark:1",
    });
    expect(noChange.outcome).toBe("no_change");
    expect(
      (
        await reflection.run({
          ownerId,
          agentId,
          generationRunId: runId,
          traceRef: "trace:reflection",
          scheduledAt: "2026-03-08T13:00:00.000Z",
          hostWasOnlineAtSchedule: true,
          previousWatermark: "watermark:1",
        })
      ).id,
    ).toBe(noChange.id);
    const missed = await reflection.run({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:reflection-2",
      scheduledAt: "2026-03-09T13:00:00.000Z",
      hostWasOnlineAtSchedule: false,
      previousWatermark: "watermark:2",
    });
    expect(missed.outcome).toBe("missed");
    expect(missed.candidateRefs).toEqual([]);
  });

  it("bounds reflection failures at three durable attempts", async () => {
    const f = fixture();
    const reflection = new ReflectionService({
      state: new DurableProactivityStateAdapter(f.store),
      suggestions: f.suggestion,
      context: {
        select: async () => ({
          inputRef: "payload:context",
          watermark: "watermark:failure",
          itemCount: 1,
        }),
      },
      model: {
        reflect: async () => {
          throw new Error("bounded provider failure");
        },
      },
      clock: f.clock,
      ids: f.ids,
    });
    await reflection.configure({
      id: "global-reflection",
      revision: 1,
      ownerId,
      agentId,
      schedule: "daily:09:00",
      timezone: "Asia/Tokyo",
      dailySuggestionQuota: 3,
      maximumContextItems: 10,
      maximumCostMicros: 1000,
      timeoutMs: 5000,
      maximumCandidates: 3,
      enabled: true,
    });
    const input = {
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:reflection-failure",
      scheduledAt: "2026-03-08T13:00:00.000Z",
      hostWasOnlineAtSchedule: true,
      previousWatermark: "watermark:before-failure",
    };
    await expect(reflection.run(input)).rejects.toThrow("bounded provider failure");
    await expect(reflection.run(input)).rejects.toThrow("bounded provider failure");
    expect(await reflection.run(input)).toMatchObject({
      outcome: "failed",
      attempts: 3,
      errorCode: "REFLECTION_FAILED",
    });
  });
});

class IdempotentWorker implements WorkerRunPort {
  readonly #completed = new Set<string>();
  actionCount = 0;
  crashOnce = true;
  async *run(request: Parameters<WorkerRunPort["run"]>[0]): AsyncIterable<WorkerRunEvent> {
    if (!this.#completed.has(request.idempotencyKey)) {
      this.#completed.add(request.idempotencyKey);
      this.actionCount += 1;
    }
    if (this.crashOnce) {
      this.crashOnce = false;
      throw new Error("worker crash after durable external result");
    }
    yield {
      type: "worker.completed",
      workerRunId: request.workerRunId,
      resultRef: "payload:worker-result",
      costMicros: 10,
      durationMs: 20,
      occurredAt: "2026-03-08T06:31:00.000Z",
    };
  }
  async cancel() {}
}

class ProgressWorker implements WorkerRunPort {
  cancelCount = 0;
  async *run(request: Parameters<WorkerRunPort["run"]>[0]): AsyncIterable<WorkerRunEvent> {
    for (let index = 0; index < 4; index += 1) {
      yield {
        type: "worker.progress",
        workerRunId: request.workerRunId,
        sequence: index + 1,
        payloadRef: `payload:progress:${index}`,
        occurredAt: "2026-03-08T06:31:00.000Z",
      };
    }
  }
  async cancel() {
    this.cancelCount += 1;
  }
}

describe("DelegationService", () => {
  it("deduplicates replayed progress and forwards the frozen model and output contract", async () => {
    let observed: Parameters<WorkerRunPort["run"]>[0] | undefined;
    const worker: WorkerRunPort = {
      async *run(request) {
        observed = request;
        for (const sequence of [1, 1, 2])
          yield {
            type: "worker.progress",
            workerRunId: request.workerRunId,
            sequence,
            payloadRef: `payload:${sequence}`,
            occurredAt: "2026-03-08T06:30:00.000Z",
          };
        yield {
          type: "worker.completed",
          workerRunId: request.workerRunId,
          resultRef: "payload:result",
          costMicros: 10,
          durationMs: 20,
          occurredAt: "2026-03-08T06:30:00.000Z",
        };
      },
      cancel: async () => undefined,
    };
    const h = delegationHarness(worker);
    const created = await h.service.create({ ...delegationInput(), maximumProgressEvents: 2 });
    if (created.outcome !== "created") throw new Error("missing delegation");
    expect(await h.service.execute({ ownerId, agentId }, created.delegation.id)).toMatchObject({
      status: "completed",
      progressEventsObserved: 2,
    });
    expect(observed).toMatchObject({
      selectedModelRef: "model:worker",
      allowedModelRefs: ["model:worker"],
      outputSchema: { type: "object" },
    });
  });

  it("revokes Handles even when Worker cancellation fails and retries only pending cleanup", async () => {
    let cancelCalls = 0;
    const h = delegationHarness({
      async *run() {},
      cancel: async () => {
        cancelCalls += 1;
        if (cancelCalls === 1) throw new Error("Worker offline");
      },
    });
    const created = await h.service.create(delegationInput());
    if (created.outcome !== "created") throw new Error("missing delegation");
    await expect(
      h.service.cancel({ ownerId, agentId }, created.delegation.id, "OWNER_CANCELLED"),
    ).rejects.toThrow("Worker offline");
    expect(h.ended).toHaveLength(1);
    expect(await h.state.read({ ownerId, agentId }, created.delegation.id)).toMatchObject({
      status: "cancelled",
      handlesEndedAt: h.f.clock.now(),
      workerCancelledAt: null,
    });
    expect(
      await h.createService().execute({ ownerId, agentId }, created.delegation.id),
    ).toMatchObject({ status: "cancelled", workerCancelledAt: h.f.clock.now() });
    expect(h.ended).toHaveLength(1);
    expect(cancelCalls).toBe(2);
  });

  it("ignores an expired executor before a later executor resumes the same Worker operation", async () => {
    const f = fixture();
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const h = delegationHarness(
      {
        async *run(request) {
          calls += 1;
          if (calls === 1) {
            started.resolve();
            await release.promise;
            yield {
              type: "worker.progress",
              workerRunId: request.workerRunId,
              sequence: 1,
              payloadRef: null,
              occurredAt: f.clock.now(),
            };
          } else
            yield {
              type: "worker.completed",
              workerRunId: request.workerRunId,
              resultRef: "payload:result",
              costMicros: 10,
              durationMs: 20,
              occurredAt: f.clock.now(),
            };
        },
        cancel: async () => undefined,
      },
      f,
    );
    const created = await h.service.create(delegationInput());
    if (created.outcome !== "created") throw new Error("missing delegation");
    const first = h.service.execute({ ownerId, agentId }, created.delegation.id);
    await started.promise;
    f.setNow("2026-03-08T06:30:02.000Z");
    release.resolve();
    expect(await first).toMatchObject({ status: "running", progressEventsObserved: 0 });
    expect(
      await h.createService().execute({ ownerId, agentId }, created.delegation.id),
    ).toMatchObject({ status: "completed", executionGeneration: 2 });
    expect(calls).toBe(2);
  });

  it("intersects authority, recovers with one stable idempotency key, validates the result, and revokes Handles", async () => {
    const f = fixture();
    const state = new DurableDelegationStateAdapter(f.store);
    const worker = new IdempotentWorker();
    const ended: string[][] = [];
    const handles = {
      endHandles: async ({ handleRefs }: { handleRefs: readonly string[] }) =>
        void ended.push([...handleRefs]),
    };
    const result: WorkerResult = {
      workerRunId: "placeholder",
      conclusionRef: "payload:conclusion",
      citationRefs: ["citation:1"],
      artifactRefs: [],
      unresolvedRefs: [],
      actualModelRef: "model:worker",
      usage: { inputTokens: 10, outputTokens: 5 },
      costMicros: 10,
      durationMs: 20,
      executionRecordRefs: ["execution:1"],
      dataClassification: "private",
      output: { answer: "reference-only" },
    };
    const results = new WorkerResultService({
      state,
      handles,
      verifier: {
        verify: async () => ({
          valid: true,
          conflictRefs: [],
          invalidCitationRefs: [],
          reasonCode: null,
        }),
      },
      clock: f.clock,
    });
    const proposals: unknown[] = [];
    let createdWorkerRunId = "";
    const service = new DelegationService({
      state,
      worker,
      handles,
      results,
      proposals: {
        protectScopeExpansion: async (input) => {
          proposals.push(input);
          return "payload:proposal";
        },
      },
      resultReader: { read: async () => ({ ...result, workerRunId: createdWorkerRunId }) },
      clock: f.clock,
      ids: f.ids,
    });
    const expanded = await service.create({
      ...delegationInput(),
      requestedContextRefs: ["context:private"],
      parentContextRefs: [],
    });
    expect(expanded.outcome).toBe("proposal_required");
    expect(proposals).toHaveLength(1);

    const created = await service.create(delegationInput());
    if (created.outcome !== "created") throw new TypeError("delegation not created");
    createdWorkerRunId = created.delegation.workerRunId;
    await expect(service.execute({ ownerId, agentId }, created.delegation.id)).rejects.toThrow(
      "Worker process failed",
    );
    const completed = await service.execute({ ownerId, agentId }, created.delegation.id);
    expect(completed.status).toBe("completed");
    expect(worker.actionCount).toBe(1);
    expect(ended).toEqual([["handle:read"]]);
    const late = await results.validateAndCommit(created.delegation, {
      ...result,
      workerRunId: createdWorkerRunId,
      actualModelRef: "model:outside-delegation",
    });
    expect(late.status).toBe("completed");
    expect(late.workerResult).toEqual(completed.workerResult);
    expect(ended).toHaveLength(1);
  });

  it("persists the progress budget and revokes Handles when cancellation becomes terminal", async () => {
    const f = fixture();
    const state = new DurableDelegationStateAdapter(f.store);
    const worker = new ProgressWorker();
    const ended: string[][] = [];
    const handles = {
      endHandles: async ({ handleRefs }: { handleRefs: readonly string[] }) =>
        void ended.push([...handleRefs]),
    };
    const results = new WorkerResultService({
      state,
      handles,
      verifier: {
        verify: async () => ({
          valid: true,
          conflictRefs: [],
          invalidCitationRefs: [],
          reasonCode: null,
        }),
      },
      clock: f.clock,
    });
    const service = new DelegationService({
      state,
      worker,
      handles,
      results,
      proposals: {
        protectScopeExpansion: async () => "payload:proposal",
      },
      resultReader: {
        read: async () => {
          throw new Error("result must not be read after progress overflow");
        },
      },
      clock: f.clock,
      ids: f.ids,
    });
    const created = await service.create({ ...delegationInput(), maximumProgressEvents: 3 });
    if (created.outcome !== "created") throw new TypeError("delegation not created");
    const cancelled = await service.execute({ ownerId, agentId }, created.delegation.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      progressEventsObserved: 3,
      failureReasonCode: "PROGRESS_BUDGET_EXCEEDED",
    });
    expect(worker.cancelCount).toBe(1);
    expect(ended).toEqual([["handle:read"]]);
  });

  it("rejects recursive delegation before a Worker or capability Handle is created", async () => {
    const f = fixture();
    const state = new DurableDelegationStateAdapter(f.store);
    const worker = new ProgressWorker();
    const handles = { endHandles: async () => undefined };
    const service = new DelegationService({
      state,
      worker,
      handles,
      results: new WorkerResultService({
        state,
        handles,
        verifier: {
          verify: async () => ({
            valid: true,
            conflictRefs: [],
            invalidCitationRefs: [],
            reasonCode: null,
          }),
        },
        clock: f.clock,
      }),
      proposals: { protectScopeExpansion: async () => "payload:proposal" },
      resultReader: {
        read: async () => {
          throw new Error("unreachable");
        },
      },
      clock: f.clock,
      ids: f.ids,
    });
    await expect(service.create({ ...delegationInput(), depth: 2 as 1 })).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
    });
    expect(await state.list(ownerId, agentId)).toEqual([]);
  });
});

function delegationHarness(worker: WorkerRunPort, f = fixture()) {
  const state = new DurableDelegationStateAdapter(f.store);
  const ended: string[] = [];
  const handles = {
    endHandles: async () => {
      ended.push("ended");
    },
  };
  const results = new WorkerResultService({
    state,
    handles,
    clock: f.clock,
    verifier: {
      verify: async () => ({
        valid: true,
        conflictRefs: [],
        invalidCitationRefs: [],
        reasonCode: null,
      }),
    },
  });
  const createService = () =>
    new DelegationService({
      state,
      worker,
      handles,
      results,
      clock: f.clock,
      ids: f.ids,
      proposals: { protectScopeExpansion: async () => "payload:proposal" },
      resultReader: {
        read: async () => ({
          workerRunId: (await state.list(ownerId, agentId))[0]?.workerRunId ?? "missing",
          conclusionRef: "payload:conclusion",
          citationRefs: [],
          artifactRefs: [],
          unresolvedRefs: [],
          actualModelRef: "model:worker",
          usage: { inputTokens: 1, outputTokens: 1 },
          costMicros: 10,
          durationMs: 20,
          executionRecordRefs: [],
          dataClassification: "private",
          output: {},
        }),
      },
    });
  return { state, ended, f, createService, service: createService() };
}

function delegationInput() {
  return {
    ownerId,
    agentId,
    parentRunId: runId,
    traceRef: "trace:delegation",
    subtaskRef: "payload:subtask",
    outputSchema: { type: "object" },
    requestedContextRefs: ["context:1"],
    requestedCapabilityHandleRefs: ["handle:read"],
    requestedModelRefs: ["model:worker"],
    selectedModelRef: "model:worker",
    parentContextRefs: ["context:1"],
    ownerGrantedContextRefs: ["context:1"],
    parentCapabilityHandleRefs: ["handle:read"],
    ownerGrantedCapabilityHandleRefs: ["handle:read"],
    parentModelRefs: ["model:worker"],
    ownerGrantedModelRefs: ["model:worker"],
    requestedRecipientRef: null,
    dataClassification: "private" as const,
    maximumDurationMs: 1000,
    requestedCostMicros: 100,
    parentCostMicros: 100,
    ownerGrantedCostMicros: 100,
    maximumProgressEvents: 3,
    deadlineAt: "2026-04-01T00:00:00.000Z",
    depth: 1,
  };
}

class CandidateWorkspaceFixture implements CandidateWorkspacePort {
  qualified = true;
  quarantined: string[] = [];
  disposed: string[] = [];
  validationOutcome: "passed" | "failed" = "passed";
  comparisonInputOverride: string | null = null;
  async qualify() {
    return {
      qualified: this.qualified,
      platform: "linux" as const,
      runtimeIdentity: "bwrap:0.11.2",
      evidenceRefs: ["evidence:isolation"],
      reasonCodes: this.qualified ? [] : ["NOT_QUALIFIED"],
    };
  }
  async create({ candidateId }: { candidateId: string }) {
    return `/candidate/${candidateId}`;
  }
  async patch({ allowedPaths }: { allowedPaths: readonly string[] }) {
    return { patchDigest: testDigest("patch"), changedPaths: [allowedPaths[0] ?? ""] };
  }
  async validate({ profiles }: { profiles: readonly CommandProfile[] }) {
    return profiles.map(({ id }) => ({
      profileId: id,
      commandObservationRef: `observation:${id}`,
      outcome: this.validationOutcome,
    }));
  }
  async compare({ inputSetDigest }: { inputSetDigest: string }): Promise<ImprovementComparison> {
    return {
      inputSetDigest: this.comparisonInputOverride ?? inputSetDigest,
      baseResultRef: "payload:base",
      candidateResultRef: "payload:candidate",
      qualityDeltaPermille: 10,
      performanceDeltaPermille: 0,
      resourceDeltaPermille: 0,
      regressionRefs: [],
    };
  }
  async packageArtifact() {
    return { artifactRef: "payload:artifact", artifactDigest: testDigest("artifact") };
  }
  async quarantine(_workspaceRef: string, reasonCode: string) {
    this.quarantined.push(reasonCode);
  }
  async dispose(workspaceRef: string) {
    this.disposed.push(workspaceRef);
  }
}

describe("ImprovementCandidateService", () => {
  it("keeps a validated candidate review-required and turns self-activation into a security failure", async () => {
    const f = fixture();
    const workspace = new CandidateWorkspaceFixture();
    const attention: unknown[] = [];
    const service = new ImprovementCandidateService({
      state: new DurableImprovementStateAdapter(f.store),
      workspace,
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: f.clock,
      ids: f.ids,
      attention: { raise: async (event) => void attention.push(event) },
    });
    const candidate = await service.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:improvement",
      observableProblemRef: "payload:problem",
      goalRef: "payload:goal",
      invariantRefs: ["invariant:no-regression"],
      baseRevision: "abc123",
      baseDigest: testDigest("base"),
      allowedPaths: ["packages/feature"],
      reasonRef: "payload:reason",
      risk: "medium",
      expiresAt: "2026-04-01T00:00:00.000Z",
      spaceBudgetBytes: 1_000_000,
    });
    const profile = commandProfile(candidate.workspaceRef);
    const review = await service.patchValidateCompare({
      scope: { ownerId, agentId },
      candidateId: candidate.id,
      patchRef: "payload:patch",
      profiles: [profile],
      inputSetDigest: testDigest("eval-inputs"),
      comparisonDefinition: { metric: "quality" },
    });
    expect(review.status).toBe("review_required");
    expect(review.reviewRequired).toBe(true);
    await expect(
      service.rejectSelfActivation({ ownerId, agentId }, candidate.id, "commit"),
    ).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
    });
    expect(workspace.quarantined).toContain("SELF_ACTIVATION_COMMIT");
    expect(attention).toEqual([
      expect.objectContaining({ candidateId: candidate.id, reasonCode: "SELF_ACTIVATION_COMMIT" }),
    ]);
  });

  it("blocks candidate creation when platform isolation is not qualified", async () => {
    const f = fixture();
    const workspace = new CandidateWorkspaceFixture();
    workspace.qualified = false;
    const service = new ImprovementCandidateService({
      state: new DurableImprovementStateAdapter(f.store),
      workspace,
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: f.clock,
      ids: f.ids,
      attention: { raise: async () => undefined },
    });
    await expect(
      service.propose({
        ownerId,
        agentId,
        generationRunId: runId,
        traceRef: "trace:improvement",
        observableProblemRef: "payload:problem",
        goalRef: "payload:goal",
        invariantRefs: ["invariant:1"],
        baseRevision: "abc123",
        baseDigest: testDigest("base"),
        allowedPaths: ["packages/feature"],
        reasonRef: "payload:reason",
        risk: "low",
        expiresAt: "2026-04-01T00:00:00.000Z",
        spaceBudgetBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  });

  it("raises protected-root risk, preserves failed validation, and disposes expired review artifacts", async () => {
    const f = fixture();
    const workspace = new CandidateWorkspaceFixture();
    const service = new ImprovementCandidateService({
      state: new DurableImprovementStateAdapter(f.store),
      workspace,
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: f.clock,
      ids: f.ids,
      attention: { raise: async () => undefined },
    });
    const candidate = await service.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:protected-root",
      observableProblemRef: "payload:problem",
      goalRef: "payload:goal",
      invariantRefs: ["invariant:authority-stable"],
      baseRevision: "abc123",
      baseDigest: testDigest("base"),
      allowedPaths: ["packages/authorization/policy.ts"],
      reasonRef: "payload:reason",
      risk: "low",
      expiresAt: "2026-04-01T00:00:00.000Z",
      spaceBudgetBytes: 1_000_000,
    });
    expect(candidate).toMatchObject({ risk: "critical", reviewRequired: true });
    expect(candidate.protectedRootFacts).toEqual([
      "protected-path:packages/authorization/policy.ts",
    ]);
    workspace.validationOutcome = "failed";
    const validationProfile = {
      ...commandProfile(candidate.workspaceRef),
      fileScopes: [candidate.workspaceRef],
    };
    const rejected = await service.patchValidateCompare({
      scope: { ownerId, agentId },
      candidateId: candidate.id,
      patchRef: "payload:patch",
      profiles: [validationProfile],
      inputSetDigest: testDigest("eval-inputs"),
      comparisonDefinition: { metric: "quality" },
    });
    expect(rejected.status).toBe("rejected_by_validation");
    expect(rejected.artifactRef).toBeNull();
    expect(await service.expire(ownerId, agentId, "2026-04-02T00:00:00.000Z")).toEqual([
      expect.objectContaining({ id: candidate.id, status: "expired" }),
    ]);
    expect(workspace.disposed).toEqual([candidate.workspaceRef]);
  });
});

function commandProfile(workspaceRef: string): CommandProfile {
  return {
    id: "profile:validation",
    revision: 1,
    workspaceId: workspaceRef,
    argvPattern: ["npm", "test"],
    workdir: workspaceRef,
    environmentNames: [],
    fileScopes: [workspaceRef],
    network: "none",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    resources: { maxCpuTimeMs: 500, maxMemoryBytes: 10_000_000, maxProcesses: 2 },
    sandboxTier: "isolated-high-risk",
    sandboxRuntimeIdentity: "bwrap:0.11.2",
    scriptDigest: testDigest("test-script"),
    scriptSource: "package.json#scripts.test",
    authorizationRef: "grant:validation",
    expiresAt: "2026-04-01T00:00:00.000Z",
    revokedAt: null,
  };
}
