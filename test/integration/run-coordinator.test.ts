import {
  type AgentRuntimePort,
  ContextFormationService,
  PORT_ERROR_CODES,
  RunCoordinator,
  type RunExecutionLeaseClaim,
  RunStateCommitCoordinator,
  type RuntimeEvent,
  type RuntimeRequest,
  type RuntimeToolInvocation,
  SessionTraceRecorder,
} from "@himawari-agent/application";
import {
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createRun,
  createRunExecutionLeaseId,
  createRunId,
  createSession,
  createSessionId,
  createThread,
  createThreadId,
  createTrigger,
  createTriggerId,
} from "@himawari-agent/domain";
import {
  createReferenceAdapterSet,
  IdempotentRuntimeToolPort,
  ManualClock,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
} from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";

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
  const executionLease = Object.freeze({
    executionLeaseId: createRunExecutionLeaseId(`execution-${suffix}`),
    expectedLeaseRevision: 1,
    authorityLeaseId: lease.id,
    authorityFencingToken: authorityRecord.fencingToken,
    deploymentId: createDeploymentId(`deployment-${suffix}`),
    authorityEpoch: 1,
    fencingToken: authorityRecord.fencingToken,
    consumerId: `coordinator-${suffix}`,
  }) satisfies RunExecutionLeaseClaim;
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
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  const context = new ContextFormationService({
    memory: adapters.memory,
    trace,
    artifacts: adapters.runPayloadArtifacts,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    clock,
    ids: adapters.ids,
  });
  const coordinator = new RunCoordinator({
    clock,
    runs,
    checkpoints: adapters.runCheckpoints,
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
    executionLease,
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
        occurredAt: T0,
      },
      threadMessages: [
        {
          id: `message-${suffix}`,
          role: "user" as const,
          payloadRef: `payload-message-${suffix}`,
          occurredAt: T0,
        },
      ],
      sourceWatermark: null,
      policyVersion: "context-policy-v1",
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
  return { adapters, coordinator, input, run, runs, trace, context, authority, clock };
}

describe("Task 13 Run Coordinator and worker orchestration", () => {
  it("persists repeated suspensions and resumes the same Run without restarting the user request", async () => {
    const suffix = "generic-suspension";
    const runId = createRunId(`run-${suffix}`);
    const requests: RuntimeRequest[] = [];
    const runtime: AgentRuntimePort = {
      async *run(request) {
        requests.push(request);
        if (requests.length <= 2)
          yield {
            type: "runtime.suspended",
            runId,
            occurredAt: T1,
            continuationRef: `continuation-${requests.length}`,
            approval: {
              approvalRequestId: `approval-${requests.length}`,
              semanticSnapshotHash: "frozen",
              expiresAt: T2,
            },
          };
        else
          yield {
            type: "runtime.completed",
            runId,
            occurredAt: T2,
            output: { kind: "assistant-answer", contentRef: "final-generic-answer" },
          };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, runtime);
    const first = await setup.coordinator.execute(setup.input);
    expect(first.run.run.status).toBe("awaiting_approval");
    expect(first.checkpoint.terminalStatus).toBeNull();
    expect(first.checkpoint.suspension?.continuationRef).toBe("continuation-1");
    const second = await setup.coordinator.execute(setup.input);
    expect(second.run.run.status).toBe("awaiting_approval");
    expect(requests[1]?.continuationRef).toBe("continuation-1");
    const third = await setup.coordinator.execute(setup.input);
    expect(third.run.run.status).toBe("completed");
    expect(requests[2]?.continuationRef).toBe("continuation-2");
    await setup.coordinator.execute(setup.input);
    expect(requests).toHaveLength(3);
  });
  it("fails a durable approval wait at the original deadline without entering Pi again", async () => {
    const suffix = "expired-suspension";
    const runId = createRunId(`run-${suffix}`);
    let attempts = 0;
    const runtime: AgentRuntimePort = {
      async *run() {
        attempts += 1;
        yield {
          type: "runtime.suspended",
          runId,
          occurredAt: T1,
          continuationRef: "expired-continuation",
          approval: {
            approvalRequestId: "pending",
            semanticSnapshotHash: "frozen",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, runtime);
    const input = { ...setup.input, executionDeadlineAt: T2 };
    await setup.coordinator.execute(input);
    setup.clock.set(T2);
    const result = await setup.coordinator.execute(input);
    expect(result.run.run.status).toBe("failed");
    expect(result.checkpoint).toMatchObject({
      phase: "failed",
      diagnosticCode: "RUN_EXECUTION_DEADLINE_EXCEEDED",
    });
    expect(attempts).toBe(1);
  });
  it("does not resume a cancelled approval wait after a late decision", async () => {
    const suffix = "cancel-suspension";
    const runId = createRunId(`run-${suffix}`);
    let attempts = 0;
    const runtime: AgentRuntimePort = {
      async *run() {
        attempts += 1;
        yield {
          type: "runtime.suspended",
          runId,
          occurredAt: T1,
          continuationRef: "cancelled-continuation",
          approval: {
            approvalRequestId: "cancelled-approval",
            semanticSnapshotHash: "frozen",
            expiresAt: T2,
          },
        };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, runtime);
    await setup.coordinator.execute(setup.input);
    await setup.coordinator.cancel({
      ownerId: setup.input.ownerId,
      agentId: setup.input.agentId,
      runId,
      authority: setup.input.authority,
      command: setup.input.commands.cancelled,
      reasonCode: "OWNER_CANCELLED",
    });
    const resumed = await setup.coordinator.execute(setup.input);
    expect(resumed.run.run.status).toBe("cancelled");
    // The reference Run adapter checks terminal dispatch here; SQLite tests below
    // cover atomic cancellation of the checkpoint and lease.
    expect(attempts).toBe(1);
  });
  it("interrupts the runtime at its deadline without accepting a late successful answer", async () => {
    const suffix = "runtime-deadline";
    const runId = createRunId(`run-${suffix}`);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = vi.fn(async () => {
      release();
    });
    const runtime: AgentRuntimePort = {
      async *run() {
        started();
        await pending;
        yield {
          type: "runtime.completed" as const,
          runId,
          output: { kind: "assistant-answer" as const, contentRef: "late-answer" },
          occurredAt: T1,
        };
      },
      cancel,
    };
    const setup = await fixture(suffix, runtime);
    vi.useFakeTimers();
    try {
      const execution = setup.coordinator.execute({
        ...setup.input,
        executionDeadlineAt: new Date(Date.parse(T0) + 1000).toISOString(),
      });
      const rejected = expect(execution).rejects.toMatchObject({
        reasonCode: "RUN_EXECUTION_DEADLINE_EXCEEDED",
      });
      await running;
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect((await setup.runs.readRun(runId))?.run.status).toBe("running");
      expect((await setup.adapters.runCheckpoints.read(runId))?.checkpoint).toMatchObject({
        phase: "runtime_running",
        terminalStatus: null,
        output: null,
      });
      expect(vi.getTimerCount()).toBe(0);
      const restarted = new RunCoordinator({
        runs: setup.runs,
        checkpoints: setup.adapters.runCheckpoints,
        context: setup.context,
        runtime,
        workers: new ScriptedWorkerRunPort(),
        trace: setup.trace,
        clock: setup.clock,
      });
      expect((await restarted.execute(setup.input)).run.run.status).toBe(
        "reconciling_external_result",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its deadline timer when execution finishes early", async () => {
    const suffix = "early-deadline-completion";
    const runId = createRunId(`run-${suffix}`);
    const runtime: AgentRuntimePort = {
      async *run() {
        yield {
          type: "runtime.completed",
          runId,
          output: { kind: "assistant-answer", contentRef: "answer" },
          occurredAt: T0,
        };
      },
      cancel: vi.fn(async () => {}),
    };
    const setup = await fixture(suffix, runtime);
    vi.useFakeTimers();
    try {
      expect(
        (await setup.coordinator.execute({ ...setup.input, executionDeadlineAt: T1 })).run.run
          .status,
      ).toBe("completed");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(runtime.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an expired or malformed execution deadline before context or model work", async () => {
    const runtime = new ScriptedAgentRuntime(() => T0, []);
    const setup = await fixture("expired-deadline", runtime);
    await expect(
      setup.coordinator.execute({ ...setup.input, executionDeadlineAt: T0 }),
    ).rejects.toMatchObject({ reasonCode: "RUN_EXECUTION_DEADLINE_EXCEEDED" });
    await expect(
      setup.coordinator.execute({ ...setup.input, executionDeadlineAt: "invalid" }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
    expect(runtime.observedRequests()).toHaveLength(0);
    expect(await setup.adapters.trace.readRun(setup.run.id, 0, 20)).toHaveLength(0);
  });

  it("persists runtime tool uncertainty and never accepts a following completion or reruns it", async () => {
    const suffix = "runtime-tool-unknown";
    const runId = createRunId(`run-${suffix}`);
    let attempts = 0;
    let advancedAfterUnknown = false;
    const runtime: AgentRuntimePort = {
      async *run() {
        attempts += 1;
        yield {
          type: "runtime.result_unknown" as const,
          runId,
          toolCallId: "uncertain-tool-call",
          capabilityRef: "restaurant-search",
          externalActionId: "external:unknown",
          occurredAt: T1,
        };
        advancedAfterUnknown = true;
        yield {
          type: "runtime.completed" as const,
          runId,
          output: { kind: "assistant-answer" as const, contentRef: "must-not-commit" },
          occurredAt: T2,
        };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, runtime);
    const result = await setup.coordinator.execute(setup.input);
    expect(result.run.run.status).toBe("reconciling_external_result");
    expect(result.checkpoint).toMatchObject({
      phase: "reconciling_external_result",
      terminalStatus: null,
      output: null,
      diagnosticCode: "RUNTIME_TOOL_RESULT_UNKNOWN",
    });
    expect(advancedAfterUnknown).toBe(false);
    const restarted = new RunCoordinator({
      runs: setup.runs,
      checkpoints: setup.adapters.runCheckpoints,
      context: setup.context,
      runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    expect((await restarted.execute(setup.input)).run.run.status).toBe(
      "reconciling_external_result",
    );
    expect(attempts).toBe(1);
    expect(
      (await setup.adapters.trace.readRun(runId, 0, 30)).map((event) => event.eventType),
    ).toContain("runtime.result_unknown");
  });

  it("passes the frozen dispatch lease claim unchanged to the runtime", async () => {
    const suffix = "task-13-runtime-lease";
    const runId = createRunId(`run-${suffix}`);
    let observed: RuntimeRequest | undefined;
    const runtime: AgentRuntimePort = {
      async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
        observed = request;
        yield {
          type: "runtime.completed",
          runId,
          output: { kind: "assistant-answer", contentRef: "payload-answer" },
          occurredAt: T1,
        };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, runtime);

    await setup.coordinator.execute(setup.input);

    expect(observed?.executionLease).toBe(setup.input.executionLease);
    expect(Object.isFrozen(observed?.executionLease)).toBe(true);
  });

  it("rejects a lease claim that does not match the active authority fence", async () => {
    const suffix = "task-13-runtime-lease-mismatch";
    const runtime = new ScriptedAgentRuntime(() => T0, []);
    const setup = await fixture(suffix, runtime);
    const mismatchedClaim = Object.freeze({
      ...setup.input.executionLease,
      authorityFencingToken: setup.authority.fencingToken + 1,
      fencingToken: setup.authority.fencingToken + 1,
    });

    await expect(
      setup.coordinator.execute({ ...setup.input, executionLease: mismatchedClaim }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(runtime.observedRequests()).toHaveLength(0);
  });

  it("rejects an unfrozen lease claim before runtime admission", async () => {
    const suffix = "task-13-runtime-lease-unfrozen";
    const runtime = new ScriptedAgentRuntime(() => T0, []);
    const setup = await fixture(suffix, runtime);
    const mutableClaim = { ...setup.input.executionLease };

    await expect(
      setup.coordinator.execute({ ...setup.input, executionLease: mutableClaim }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(runtime.observedRequests()).toHaveLength(0);
  });

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
        {
          type: "runtime.completed",
          runId,
          output: { kind: "assistant-answer", contentRef: "payload-answer" },
          occurredAt: T2,
        },
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
      selectedModelRef: "model-worker-fixture",
      allowedModelRefs: ["model-worker-fixture"],
      outputSchema: { type: "object" },
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
    expect(runtime.observedRequests()[0]?.contextEnvelopeRef).toBe(result.checkpoint.contextRef);
    expect(runtime.observedRequests()[0]?.workerResultRefs).toEqual([
      { workerRunId: "worker-run-restaurant", resultRef: "payload-worker-result" },
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
      new ScriptedAgentRuntime(
        () => T0,
        [
          {
            type: "runtime.completed",
            runId,
            output: { kind: "assistant-answer", contentRef: "payload-answer" },
            occurredAt: T1,
          },
        ],
      ),
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
              selectedModelRef: "model-worker-fixture",
              allowedModelRefs: ["model-worker-fixture"],
              outputSchema: { type: "object" },
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
      new ScriptedAgentRuntime(
        () => T0,
        [
          {
            type: "runtime.completed",
            runId,
            output: { kind: "assistant-answer", contentRef: "payload-answer" },
            occurredAt: T2,
          },
        ],
      ),
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
            selectedModelRef: "model-worker-fixture",
            allowedModelRefs: ["model-worker-fixture"],
            outputSchema: { type: "object" },
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
        yield {
          type: "runtime.completed",
          runId,
          output: { kind: "assistant-answer", contentRef: "payload-answer" },
          occurredAt: T2,
        };
      },
      async cancel() {},
    };
    const setup = await fixture(suffix, crashingRuntime);

    await expect(setup.coordinator.execute(setup.input)).rejects.toThrow("simulated runtime crash");
    const restarted = new RunCoordinator({
      runs: setup.runs,
      checkpoints: setup.adapters.runCheckpoints,
      context: setup.context,
      runtime: crashingRuntime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    const result = await restarted.execute(setup.input);

    expect(result.resumed).toBe(true);
    expect(result.run.run.status).toBe("reconciling_external_result");
    expect(result.checkpoint.diagnosticCode).toBe("RUNTIME_ATTEMPT_INTERRUPTED");
    expect(tools.underlyingExecutionCount()).toBe(1);
    expect(attempts).toBe(1);
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
