import {
  ContextFormationService,
  PORT_ERROR_CODES,
  RunCoordinator,
  RunStateCommitCoordinator,
  SessionTraceRecorder,
  type AgentRuntimePort,
  type RuntimeEvent,
  type RuntimeRequest,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
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
} from "@himawari-agent/domain";
import {
  IdempotentRuntimeToolPort,
  ManualClock,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

function runCommands(suffix: string) {
  const command = (status: string) => ({
    idempotencyKey: createIdempotencyKey(`run-${suffix}-${status}`),
    commandFingerprint: `run:${suffix}:${status}:v1`,
    payloadRef: `payload-run-${suffix}-${status}`,
  });
  return {
    buildingContext: command("building-context"),
    running: command("running"),
    reconcilingExternalResult: command("reconciling-external-result"),
    completed: command("completed"),
    failed: command("failed"),
    cancelled: command("cancelled"),
  };
}

async function fixture(
  suffix: string,
  runtime: AgentRuntimePort,
  workers: ScriptedWorkerRunPort = new ScriptedWorkerRunPort(),
) {
  const owner = createOwner(createOwnerId(`owner-${suffix}`));
  const agent = createAgent({ id: createAgentId(`agent-${suffix}`), owner });
  const thread = createThread({ id: createThreadId(`thread-${suffix}`), agent });
  const session = createSession({ id: createSessionId(`session-${suffix}`), agent, thread });
  const trigger = createTrigger({
    id: createTriggerId(`trigger-${suffix}`),
    idempotencyKey: createIdempotencyKey(`trigger-${suffix}`),
    agent,
    thread,
  });
  const run = createRun({ id: createRunId(`run-${suffix}`), session, trigger });
  const clock = new ManualClock(T0);
  const adapters = createReferenceAdapterSet({ clock });
  const lease = createAgentAuthorityLease({
    id: createAuthorityLeaseId(`lease-${suffix}`),
    agent,
    holderId: createAuthorityHolderId(`coordinator-${suffix}`),
  });
  const authorityRecord = await adapters.authority.claim(lease, 60_000);
  const authority = {
    leaseId: lease.id,
    fencingToken: authorityRecord.fencingToken,
  };
  const runs = new RunStateCommitCoordinator(adapters.productState, clock);
  await runs.admitRun({
    run,
    idempotencyKey: createIdempotencyKey(`admit-${suffix}`),
    commandFingerprint: `admit:${suffix}:v1`,
    authority,
    payloadRef: `payload-admit-${suffix}`,
  });
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  const context = new ContextFormationService({ memory: adapters.memory, trace });
  const coordinator = new RunCoordinator({
    runs,
    checkpoints: adapters.state,
    context,
    runtime,
    workers,
    trace,
  });
  const input = {
    ownerId: owner.id,
    agentId: agent.id,
    runId: run.id,
    authority,
    context: {
      ownerId: owner.id,
      agentId: agent.id,
      sessionId: session.id,
      threadId: thread.id,
      runId: run.id,
      trigger: {
        id: trigger.id,
        sourceType: "user_message" as const,
        payloadRef: `payload-trigger-${suffix}`,
      },
      threadMessages: [
        {
          id: `message-${suffix}`,
          role: "user" as const,
          payloadRef: `payload-message-${suffix}`,
          occurredAt: T0,
        },
      ],
      policies: [],
      memoryQueryRef: `payload-query-${suffix}`,
      memoryQueryTerms: ["dinner"],
      memoryLimit: 5,
      maxSelectedMemories: 2,
      maxMemoryClassification: "private" as const,
      capabilities: [],
      correlationId: `correlation-${suffix}`,
      causationId: `trigger-event-${suffix}`,
      parentEventId: null,
      actorId: "run-coordinator",
      dataClassification: "private" as const,
    },
    runtime: {
      ownerId: owner.id,
      agentId: agent.id,
      runId: run.id,
      sessionId: session.id,
      threadId: thread.id,
      modelRef: "model-primary",
      systemInstructionRef: `payload-system-${suffix}`,
      capabilityHandleRefs: [] as readonly string[],
      budget: { maxTurns: 3 },
      correlationId: `correlation-${suffix}`,
      dataClassification: "private" as const,
    },
    workers: [],
    delegableCapabilityHandleRefs: [] as readonly string[],
    delegableContextRefs: [] as readonly string[],
    commands: runCommands(suffix),
  };
  return { adapters, coordinator, input, run, runs, trace, context, authority };
}

describe("Task 13 Run Coordinator and worker orchestration", () => {
  it("coordinates context, an explicitly delegated worker, runtime events and terminal Run state", async () => {
    const suffix = "task-13-complete";
    const runId = createRunId(`run-${suffix}`);
    const runtime = new ScriptedAgentRuntime(
      () => T0,
      [
        { type: "runtime.model_started", runId, occurredAt: T0 },
        {
          type: "runtime.tool_intent",
          runId,
          capabilityRef: "restaurant-search",
          payloadRef: "payload-tool-intent",
          occurredAt: T1,
        },
        {
          type: "runtime.tool_result",
          runId,
          capabilityRef: "restaurant-search",
          payloadRef: "payload-tool-result",
          occurredAt: T1,
        },
        { type: "runtime.completed", runId, occurredAt: T2 },
      ],
    );
    const workers = new ScriptedWorkerRunPort([
      {
        type: "worker.progress",
        workerRunId: "worker-ignored",
        sequence: 1,
        payloadRef: "payload-worker-progress",
        occurredAt: T0,
      },
      {
        type: "worker.completed",
        workerRunId: "worker-ignored",
        resultRef: "payload-worker-result",
        costMicros: 100,
        durationMs: 50,
        occurredAt: T1,
      },
    ]);
    const setup = await fixture(suffix, runtime, workers);
    const handleRef = "capability-handle-restaurant";
    const worker = {
      workerRunId: "worker-run-restaurant",
      idempotencyKey: "worker-command-restaurant",
      ownerId: setup.input.ownerId,
      agentId: setup.input.agentId,
      parentRunId: setup.run.id,
      taskRef: "payload-worker-task",
      delegatedContextRefs: [setup.input.context.trigger.payloadRef],
      capabilityHandleRefs: [handleRef],
      secretRefs: [] as readonly string[],
      dataClassification: "private" as const,
      budget: { maxDurationMs: 1_000, maxCostMicros: 1_000, maxProgressEvents: 2 },
      deadlineAt: T2,
    };

    const result = await setup.coordinator.execute({
      ...setup.input,
      runtime: { ...setup.input.runtime, capabilityHandleRefs: [handleRef] },
      workers: [{ request: worker }],
      delegableCapabilityHandleRefs: [handleRef],
    });

    expect(result.run.run.status).toBe("completed");
    expect(result.workerResultRefs).toEqual(["payload-worker-result"]);
    expect(runtime.observedRequests()[0]?.messageRefs).toEqual([
      result.checkpoint.contextRef,
      "payload-worker-result",
    ]);
    expect(workers.observedRequests()[0]).toMatchObject({
      parentRunId: setup.run.id,
      capabilityHandleRefs: [handleRef],
      secretRefs: [],
    });
    const events = await setup.adapters.trace.readRun(setup.run.id, 0, 30);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "memory.query",
      "memory.candidates",
      "memory.selection",
      "context.formed",
      "worker.delegated",
      "worker.progress",
      "worker.completed",
      "runtime.model_started",
      "runtime.tool_intent",
      "runtime.tool_result",
      "runtime.completed",
    ]);
    expect(events[4]?.parentEventId).toBe(events[3]?.id);
    expect(events[5]?.causationId).toBe(events[4]?.id);
  });

  it("rejects worker authority or context that was not explicitly delegated", async () => {
    const suffix = "task-13-scope";
    const runId = createRunId(`run-${suffix}`);
    const setup = await fixture(
      suffix,
      new ScriptedAgentRuntime(() => T0, [{ type: "runtime.completed", runId, occurredAt: T1 }]),
      new ScriptedWorkerRunPort(),
    );

    await expect(
      setup.coordinator.execute({
        ...setup.input,
        workers: [
          {
            request: {
              workerRunId: "worker-run-illegal",
              idempotencyKey: "worker-command-illegal",
              ownerId: setup.input.ownerId,
              agentId: setup.input.agentId,
              parentRunId: setup.run.id,
              taskRef: "payload-worker-task-illegal",
              delegatedContextRefs: ["payload-not-delegated"],
              capabilityHandleRefs: ["capability-handle-not-delegated"],
              secretRefs: [],
              dataClassification: "private",
              budget: { maxDurationMs: 1_000, maxCostMicros: 1_000, maxProgressEvents: 1 },
              deadlineAt: T2,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect((await setup.runs.readRun(setup.run.id))?.run.status).toBe("running");
  });

  it("fails the parent Run when a worker exceeds its explicit budget", async () => {
    const suffix = "task-13-budget";
    const runId = createRunId(`run-${suffix}`);
    const workers = new ScriptedWorkerRunPort([
      {
        type: "worker.completed",
        workerRunId: "worker-budget",
        resultRef: "payload-too-expensive",
        costMicros: 2_000,
        durationMs: 50,
        occurredAt: T1,
      },
    ]);
    const setup = await fixture(
      suffix,
      new ScriptedAgentRuntime(() => T0, [{ type: "runtime.completed", runId, occurredAt: T2 }]),
      workers,
    );
    const result = await setup.coordinator.execute({
      ...setup.input,
      workers: [
        {
          request: {
            workerRunId: "worker-budget",
            idempotencyKey: "worker-command-budget",
            ownerId: setup.input.ownerId,
            agentId: setup.input.agentId,
            parentRunId: setup.run.id,
            taskRef: "payload-worker-budget",
            delegatedContextRefs: [setup.input.context.trigger.payloadRef],
            capabilityHandleRefs: [],
            secretRefs: [],
            dataClassification: "private",
            budget: { maxDurationMs: 1_000, maxCostMicros: 1_000, maxProgressEvents: 1 },
            deadlineAt: T2,
          },
        },
      ],
    });

    expect(result.run.run.status).toBe("failed");
    expect(result.checkpoint.terminalStatus).toBe("failed");
    expect(
      (await setup.adapters.trace.readRun(setup.run.id, 0, 20)).map(({ eventType }) => eventType),
    ).toContain("worker.failed");
  });

  it("resumes after a crash without repeating an external tool action", async () => {
    const suffix = "task-13-resume";
    const runId = createRunId(`run-${suffix}`);
    const tools = new IdempotentRuntimeToolPort({
      descriptors: [
        {
          capabilityRef: "restaurant-booking",
          capabilityHandleRef: "capability-handle-booking",
          name: "restaurant_booking",
          description: "Book a restaurant",
          parameters: { type: "object" },
        },
      ],
      execution: {
        outcome: "succeeded",
        resultRef: "payload-booking-result",
        errorCode: null,
        externalActionId: "booking-external-01",
        modelContent: "Booked",
      },
    });
    let attempts = 0;
    const invocation: RuntimeToolInvocation = {
      runId,
      toolCallId: "tool-call-stable-01",
      capabilityRef: "restaurant-booking",
      capabilityHandleRef: "capability-handle-booking",
      arguments: { restaurant: "Himawari" },
      dataClassification: "private",
    };
    const crashingRuntime: AgentRuntimePort = {
      async *run(): AsyncIterable<RuntimeEvent> {
        attempts += 1;
        await tools.execute(invocation);
        if (attempts === 1) throw new Error("simulated runtime crash after external action");
        yield {
          type: "runtime.tool_result",
          runId,
          capabilityRef: invocation.capabilityRef,
          payloadRef: "payload-booking-result",
          occurredAt: T1,
        };
        yield { type: "runtime.completed", runId, occurredAt: T2 };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, crashingRuntime);

    await expect(setup.coordinator.execute(setup.input)).rejects.toThrow("simulated runtime crash");
    const restarted = new RunCoordinator({
      runs: setup.runs,
      checkpoints: setup.adapters.state,
      context: setup.context,
      runtime: crashingRuntime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    const result = await restarted.execute(setup.input);

    expect(result.resumed).toBe(true);
    expect(result.run.run.status).toBe("completed");
    expect(tools.underlyingExecutionCount()).toBe(1);
    expect(attempts).toBe(2);
  });

  it("propagates cancellation to an active runtime and settles the Run as cancelled", async () => {
    const suffix = "task-13-cancel";
    const runId = createRunId(`run-${suffix}`);
    let signalStarted: (() => void) | undefined;
    let releaseRuntime: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let cancelled = false;
    const blockingRuntime: AgentRuntimePort = {
      async *run(_request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
        signalStarted?.();
        await released;
        if (cancelled) {
          yield {
            type: "runtime.cancelled",
            runId,
            reasonCode: "OWNER_REQUESTED",
            occurredAt: T1,
          };
        }
      },
      async cancel(cancelledRunId) {
        if (cancelledRunId === runId) cancelled = true;
        releaseRuntime?.();
      },
    };
    const setup = await fixture(suffix, blockingRuntime);
    const execution = setup.coordinator.execute(setup.input);
    await started;
    await setup.coordinator.cancel({
      ownerId: setup.input.ownerId,
      agentId: setup.input.agentId,
      runId,
      authority: setup.authority,
      command: setup.input.commands.cancelled,
      reasonCode: "OWNER_REQUESTED",
    });

    await expect(execution).resolves.toMatchObject({
      run: { run: { status: "cancelled" } },
      checkpoint: { terminalStatus: "cancelled" },
    });
    expect(cancelled).toBe(true);
  });
});
