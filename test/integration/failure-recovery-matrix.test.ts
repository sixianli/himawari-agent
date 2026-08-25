import {
  CapabilityRegistryService,
  ModelRouterService,
  PermissionService,
  ReliableEventPublisher,
  RunStateCommitCoordinator,
  SessionDeletionCoordinator,
  SessionTraceRecorder,
  type ActionIntent,
  type PermissionAllowDecision,
  type RunTransitionCommand,
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
  type RunStatus,
} from "@himawari-agent/domain";
import type { ExecuteWorkRequest, ReconcileWorkRequest } from "@himawari-agent/execution-contracts";
import { createLocalExecutionWorkerProcess } from "@himawari-agent/execution-worker";
import {
  DeterministicFailureScheduler,
  IdempotentRuntimeToolPort,
  InMemoryDeletionTarget,
  ManualClock,
  ScriptedCapabilityPort,
  ScriptedExternalActionReconciliationPort,
  ScriptedModelPort,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function scenario(
  suffix: string,
  options: {
    readonly failures?: DeterministicFailureScheduler;
    readonly leaseDurationMs?: number;
  } = {},
) {
  const owner = createOwner(createOwnerId(`owner-recovery-${suffix}`));
  const agent = createAgent({ id: createAgentId(`agent-recovery-${suffix}`), owner });
  const thread = createThread({ id: createThreadId(`thread-recovery-${suffix}`), agent });
  const session = createSession({
    id: createSessionId(`session-recovery-${suffix}`),
    agent,
    thread,
  });
  const trigger = createTrigger({
    id: createTriggerId(`trigger-recovery-${suffix}`),
    idempotencyKey: createIdempotencyKey(`trigger-key-recovery-${suffix}`),
    agent,
    thread,
  });
  const run = createRun({ id: createRunId(`run-recovery-${suffix}`), session, trigger });
  const correlationId = `correlation-recovery-${suffix}`;
  const clock = new ManualClock(T0);
  const adapters = createReferenceAdapterSet({
    clock,
    ...(options.failures ? { failures: options.failures } : {}),
  });
  const lease = createAgentAuthorityLease({
    id: createAuthorityLeaseId(`lease-recovery-${suffix}`),
    agent,
    holderId: createAuthorityHolderId(`holder-recovery-${suffix}`),
  });
  const claimed = await adapters.authority.claim(lease, options.leaseDurationMs ?? 60_000);
  const authority = { leaseId: lease.id, fencingToken: claimed.fencingToken };
  const runs = new RunStateCommitCoordinator(adapters.productState, clock);
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  const record = async (eventType: string, status: string, details: object = {}) => {
    const existing = await adapters.trace.readRun(run.id, 0, 1_000);
    const previous = existing.at(-1)?.id ?? null;
    return trace.record({
      ownerId: owner.id,
      agentId: agent.id,
      sessionId: session.id,
      threadId: thread.id,
      runId: run.id,
      turnId: null,
      parentEventId: previous,
      causationId: previous ?? `scenario:${suffix}`,
      correlationId,
      actorId: "recovery-matrix",
      dataClassification: "private",
      eventType,
      payload: { status, ...details },
    });
  };
  const admitInput = {
    run,
    idempotencyKey: createIdempotencyKey(`admit-recovery-${suffix}`),
    commandFingerprint: `admit:recovery:${suffix}:v1`,
    authority,
    payloadRef: `payload-admit-recovery-${suffix}`,
  };
  return {
    owner,
    agent,
    thread,
    session,
    trigger,
    run,
    correlationId,
    clock,
    adapters,
    lease,
    authority,
    runs,
    trace,
    record,
    admitInput,
  };
}

function transitionCommand(suffix: string, status: RunStatus): RunTransitionCommand {
  return {
    idempotencyKey: createIdempotencyKey(`transition-${suffix}-${status}`),
    commandFingerprint: `transition:${suffix}:${status}:v1`,
    payloadRef: `payload-transition-${suffix}-${status}`,
  };
}

async function transition(
  setup: Awaited<ReturnType<typeof scenario>>,
  status: RunStatus,
  revision: number,
) {
  return setup.runs.transitionRun({
    runId: setup.run.id,
    ownerId: setup.owner.id,
    agentId: setup.agent.id,
    expectedRevision: revision,
    nextStatus: status,
    authority: setup.authority,
    ...transitionCommand(setup.run.id, status),
  });
}

async function tracePayload(
  setup: Awaited<ReturnType<typeof scenario>>,
  eventType: string,
): Promise<unknown> {
  const events = await setup.adapters.trace.readRun(setup.run.id, 0, 1_000);
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event?.payloadRef) throw new Error(`Trace event ${eventType} missing payload`);
  const payload = await setup.adapters.payload.get(event.payloadRef);
  if (!payload) throw new Error(`Trace payload ${event.payloadRef} missing`);
  return setup.adapters.payloadProtector.revealForTest(payload);
}

describe("Task 19 failure and recovery matrix", () => {
  it("retries after restart before Run-state commit without partial state", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("productState.commit.before", 1);
    const setup = await scenario("before-commit", { failures });

    await expect(setup.runs.admitRun(setup.admitInput)).rejects.toMatchObject({
      code: "PORT_INJECTED_FAILURE",
    });
    expect(await setup.runs.readRun(setup.run.id)).toBeUndefined();

    const restarted = new RunStateCommitCoordinator(setup.adapters.productState, setup.clock);
    const committed = await restarted.admitRun(setup.admitInput);
    await setup.record("recovery.run_commit_retried", "accepted", {
      revision: committed.state.revision,
    });

    expect(committed).toMatchObject({ replayed: false, state: { revision: 1 } });
    expect(await tracePayload(setup, "recovery.run_commit_retried")).toMatchObject({
      status: "accepted",
    });
  });

  it("publishes the existing outbox event after restart without repeating the state mutation", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("reliableEventSink.publish", 1);
    const setup = await scenario("after-commit", { failures });
    await setup.runs.admitRun(setup.admitInput);
    const firstPublisher = new ReliableEventPublisher(
      setup.adapters.productState,
      setup.adapters.eventSink,
      setup.clock,
    );

    await expect(firstPublisher.publishPending(10)).rejects.toMatchObject({
      code: "PORT_INJECTED_FAILURE",
    });
    await setup.record("recovery.event_publication_pending", "pending", {
      stateRevision: 1,
    });
    expect(await setup.adapters.productState.listPending(10)).toHaveLength(1);

    const restarted = new ReliableEventPublisher(
      setup.adapters.productState,
      setup.adapters.eventSink,
      setup.clock,
    );
    await expect(restarted.publishPending(10)).resolves.toMatchObject({ published: 1 });
    await setup.record("recovery.event_publication_completed", "completed");

    expect(await setup.runs.readRun(setup.run.id)).toMatchObject({ revision: 1 });
    expect(await setup.adapters.productState.listPending(10)).toEqual([]);
    expect(await tracePayload(setup, "recovery.event_publication_completed")).toMatchObject({
      status: "completed",
    });
  });

  it("restores an awaiting-approval Run without answering for the owner", async () => {
    const setup = await scenario("approval");
    await setup.runs.admitRun(setup.admitInput);
    await transition(setup, "building_context", 1);
    await transition(setup, "running", 2);
    await transition(setup, "awaiting_approval", 3);
    const policy = { version: "recovery-ask-v1", rules: [] };
    const permission = new PermissionService({
      store: setup.adapters.authorization,
      clock: setup.clock,
      ids: setup.adapters.ids,
      policy,
    });
    const intent: ActionIntent = {
      id: "intent-recovery-approval",
      ownerId: setup.owner.id,
      agentId: setup.agent.id,
      runId: setup.run.id,
      capabilityRef: "restaurant-reservation",
      operation: "reserve",
      resourceRef: "restaurant:recovery",
      dataClassification: "private",
      sideEffect: "reversible",
      estimatedCostMicros: 100,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey: createIdempotencyKey("intent-recovery-approval"),
      reversible: true,
      requestedAt: T0,
    };
    const decision = await permission.evaluate(intent, {
      uiAvailable: false,
      approvalExpiresAt: T2,
    });
    if (decision.decision !== "ASK") throw new Error("approval fixture must ask");
    await setup.record("approval.awaiting", "pending", {
      approvalRequestId: decision.approvalRequest.id,
      deliveryState: decision.approvalRequest.deliveryState,
    });

    const restarted = new PermissionService({
      store: setup.adapters.authorization,
      clock: setup.clock,
      ids: setup.adapters.ids,
      policy,
    });
    const resumed = await restarted.resume(decision.approvalRequest.id);
    await setup.record("recovery.approval_pending", resumed.status, {
      approvalRequestId: resumed.id,
    });

    expect(resumed).toMatchObject({ status: "pending", deliveryState: "queued_no_ui" });
    expect(await setup.runs.readRun(setup.run.id)).toMatchObject({
      run: { status: "awaiting_approval" },
    });
    expect(await tracePayload(setup, "recovery.approval_pending")).toMatchObject({
      status: "pending",
    });
  });

  it("records a model stream interruption and blocks a privacy-incompatible fallback", async () => {
    const setup = await scenario("model-interruption");
    const primary = {
      ref: "model-recovery-primary",
      provider: "deterministic",
      model: "primary",
      version: "1.0.0",
      routingClass: "primary" as const,
      priority: 1,
      disclosure: "trusted_remote" as const,
      capabilities: ["reasoning"],
      allowedDataClassifications: ["private" as const],
      secretRequirement: null,
    };
    const fallback = {
      ...primary,
      ref: "model-recovery-external",
      model: "external-fallback",
      routingClass: "fallback" as const,
      disclosure: "external_remote" as const,
    };
    const model = new ScriptedModelPort([primary, fallback], [], {
      [primary.ref]: [
        { type: "model.started", invocationId: "primary-call", occurredAt: T0 },
        {
          type: "model.output",
          invocationId: "primary-call",
          sequence: 1,
          payloadRef: "payload-partial-model-output",
          occurredAt: T0,
        },
        {
          type: "model.failed",
          invocationId: "primary-call",
          errorCode: "MODEL_STREAM_INTERRUPTED",
          retryable: true,
          latencyMs: 500,
          occurredAt: T1,
        },
      ],
    });
    const router = new ModelRouterService({
      model,
      secrets: setup.adapters.secret,
      trace: setup.trace,
      clock: setup.clock,
      ids: setup.adapters.ids,
    });
    const result = await router.route({
      ownerId: setup.owner.id,
      agentId: setup.agent.id,
      sessionId: setup.session.id,
      threadId: setup.thread.id,
      runId: setup.run.id,
      taskProfile: "primary",
      requiredCapabilities: ["reasoning"],
      inputRef: "payload-model-recovery-input",
      dataClassification: "private",
      maxDisclosure: "external_remote",
      allowedDisclosureRef: "disclosure-recovery-v1",
      forbidFallbackDisclosureExpansion: true,
      correlationId: setup.correlationId,
      causationId: "model-recovery-start",
      parentEventId: null,
      actorId: "model-router",
      deadlineAt: T2,
    });
    await setup.record("recovery.run_failed", "failed", {
      errorCode: result.status === "blocked" ? result.errorCode : "unexpected",
    });

    expect(result).toMatchObject({
      status: "blocked",
      errorCode: "MODEL_FALLBACK_DISCLOSURE_BLOCKED",
    });
    expect(
      (await setup.adapters.trace.readRun(setup.run.id, 0, 20)).map(({ eventType }) => eventType),
    ).toContain("model.fallback_blocked");
    expect(await tracePayload(setup, "recovery.run_failed")).toMatchObject({ status: "failed" });
  });

  it("recovers Worker crashes before and after an external side effect without duplication", async () => {
    const setup = await scenario("worker-crash");
    const tools = new IdempotentRuntimeToolPort({
      descriptors: [
        {
          capabilityRef: "restaurant-reservation",
          capabilityHandleRef: "handle-recovery-reservation",
          name: "restaurant_reservation",
          description: "Reserve a restaurant",
          parameters: { type: "object" },
        },
      ],
      execution: {
        outcome: "succeeded",
        resultRef: "payload-reservation-recovery-result",
        errorCode: null,
        externalActionId: "external-reservation-recovery",
        modelContent: "Reserved",
      },
    });
    const invocation = (toolCallId: string): RuntimeToolInvocation => ({
      runId: setup.run.id,
      toolCallId,
      capabilityRef: "restaurant-reservation",
      capabilityHandleRef: "handle-recovery-reservation",
      arguments: { restaurant: "Recovery Beef House" },
      dataClassification: "private",
    });
    let crashBefore = true;
    const executeBefore = async () => {
      if (crashBefore) {
        crashBefore = false;
        throw new Error("worker crashed before external side effect");
      }
      return tools.execute(invocation("tool-before-side-effect"));
    };

    await expect(executeBefore()).rejects.toThrow("before external side effect");
    await setup.record("worker.crashed_before_side_effect", "pending");
    await expect(executeBefore()).resolves.toMatchObject({ outcome: "succeeded" });
    await setup.record("recovery.worker_completed", "completed");

    const afterInvocation = invocation("tool-after-side-effect");
    const first = await tools.execute(afterInvocation);
    await setup.record("worker.crashed_after_side_effect", "reconciling");
    const replay = await tools.execute(afterInvocation);
    await setup.record("recovery.external_action_replayed_safely", "completed");

    expect(replay).toEqual(first);
    expect(tools.underlyingExecutionCount()).toBe(2);
    expect(await tracePayload(setup, "recovery.external_action_replayed_safely")).toMatchObject({
      status: "completed",
    });
  });

  it("keeps an unknown external action pending until explicit reconciliation", async () => {
    const setup = await scenario("unknown-result");
    const registry = new CapabilityRegistryService({
      store: setup.adapters.capabilityRegistry,
      clock: setup.clock,
      ids: setup.adapters.ids,
    });
    const declaration = {
      ref: "restaurant-reservation",
      displayName: "Restaurant Reservation",
      version: "1.0.0",
      source: { type: "builtin" as const, locator: "builtin:restaurant-reservation:1.0.0" },
      integrity: `sha256:${"c".repeat(64)}`,
      operations: ["reserve"],
      permissionRefs: [],
      isolation: "worker" as const,
    };
    await registry.discover(declaration);
    await registry.proposeInstallation(declaration.ref);
    await registry.approveInstallation(declaration.ref, "approval-install-reservation-recovery");
    await registry.activate(declaration.ref);
    const permission: PermissionAllowDecision = {
      decision: "ALLOW",
      basis: { type: "policy", ref: "policy-reservation-recovery" },
      executionScope: {
        capabilityRef: declaration.ref,
        operations: ["reserve"],
        exactResourceRef: "restaurant:recovery",
        resourcePrefixes: [],
        maxDataClassification: "private",
        sideEffects: ["reversible"],
        maxCostMicrosPerUse: 1_000,
        maxFrequency: { count: 1, intervalMs: null },
      },
    };
    const handle = await registry.issueExecutionHandle({
      ownerId: setup.owner.id,
      agentId: setup.agent.id,
      runId: setup.run.id,
      capabilityRef: declaration.ref,
      operation: "reserve",
      permission,
      inputRefs: ["payload-reservation-recovery-input"],
      delegatedContextRefs: [],
      secretRefs: [],
      expiresAt: T2,
    });
    const externalActionId = "external-reservation-unknown";
    const capability = new ScriptedCapabilityPort(
      [
        {
          ref: declaration.ref,
          version: declaration.version,
          integrity: declaration.integrity,
          lifecycle: "active",
          permissionRefs: [],
          isolation: "worker",
        },
      ],
      [
        {
          type: "capability.result_unknown",
          invocationId: "execution-reservation-unknown",
          externalActionId,
          occurredAt: T1,
        },
      ],
    );
    const reconciliation = new ScriptedExternalActionReconciliationPort({
      [externalActionId]: {
        outcome: "confirmed_succeeded",
        resultRef: "payload-reservation-reconciled",
        errorCode: null,
      },
    });
    const worker = createLocalExecutionWorkerProcess({
      handles: setup.adapters.capabilityRegistry,
      capability,
      secrets: setup.adapters.secret,
      reconciliation,
      clock: setup.clock,
      ids: setup.adapters.ids,
    });
    await worker.start();
    const execute: ExecuteWorkRequest = {
      schemaVersion: "execution.v1",
      kind: "request",
      type: "work.execute",
      messageId: "execution-reservation-unknown",
      correlationId: `correlation-${setup.run.id}`,
      causationId: "reservation-unknown-start",
      dataClassification: "private",
      scope: {
        ownerId: setup.owner.id,
        agentId: setup.agent.id,
        runId: setup.run.id,
        workerRunId: "worker-reservation-unknown",
      },
      idempotencyKey: "execution-reservation-unknown",
      payload: {
        capabilityId: declaration.ref,
        capabilityVersion: declaration.version,
        operation: "reserve",
        inputRef: "payload-reservation-recovery-input",
        capabilityHandleRef: handle.ref,
        delegatedContextRefs: [],
        secretRefs: [],
        requestedAt: T0,
        deadlineAt: T2,
      },
    };
    const unknown = await collect(worker.client.dispatch(execute));
    await setup.record("external_result.pending", "reconciling_external_result", {
      externalActionId,
    });
    const reconcile: ReconcileWorkRequest = {
      schemaVersion: "execution.v1",
      kind: "request",
      type: "work.reconcile",
      messageId: "reconcile-reservation-unknown",
      correlationId: execute.correlationId,
      causationId: execute.messageId,
      dataClassification: execute.dataClassification,
      scope: execute.scope,
      idempotencyKey: "reconcile-reservation-unknown",
      payload: {
        externalActionId,
        resultLookupRef: "lookup-reservation-unknown",
        requestedAt: T1,
      },
    };
    const reconciled = await collect(worker.client.dispatch(reconcile));
    await setup.record("external_result.reconciled", "completed", { externalActionId });
    await worker.shutdown();

    expect(unknown).toMatchObject([
      { type: "work.result", payload: { outcome: "result_unknown", externalActionId } },
    ]);
    expect(reconciled).toMatchObject([
      { type: "work.reconciled", payload: { outcome: "confirmed_succeeded" } },
    ]);
    expect(await tracePayload(setup, "external_result.pending")).toMatchObject({
      status: "reconciling_external_result",
    });
    expect(await tracePayload(setup, "external_result.reconciled")).toMatchObject({
      status: "completed",
    });
  });

  it("fails closed when the authority lease is lost mid-Run", async () => {
    const setup = await scenario("authority-loss", { leaseDurationMs: 1_000 });
    await setup.runs.admitRun(setup.admitInput);
    await transition(setup, "building_context", 1);
    await transition(setup, "running", 2);
    setup.clock.advance(1_001);
    await setup.adapters.authority.claim(
      createAgentAuthorityLease({
        id: createAuthorityLeaseId("lease-recovery-authority-new"),
        agent: setup.agent,
        holderId: createAuthorityHolderId("holder-recovery-authority-new"),
      }),
      60_000,
    );

    await expect(
      setup.runs.transitionRun({
        runId: setup.run.id,
        ownerId: setup.owner.id,
        agentId: setup.agent.id,
        expectedRevision: 3,
        nextStatus: "completed",
        authority: setup.authority,
        ...transitionCommand("authority-old-fence", "completed"),
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    await setup.record("authority.lost", "pending", {
      runStatus: "running",
      oldLeaseId: setup.lease.id,
    });

    expect(await setup.runs.readRun(setup.run.id)).toMatchObject({ run: { status: "running" } });
    expect(await tracePayload(setup, "authority.lost")).toMatchObject({
      status: "pending",
      runStatus: "running",
    });
  });

  it("keeps partial deletion visible until delayed third-party cleanup verifies", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("deletion.archive.delete", 1);
    const setup = await scenario("partial-deletion", { failures });
    const targets = ["payload", "search", "cache", "archive"].map(
      (target) => new InMemoryDeletionTarget(target, failures),
    );
    for (const target of targets) target.seed(setup.session.id);
    const deletion = new SessionDeletionCoordinator({
      state: setup.adapters.deletionState,
      targets,
      audit: setup.adapters.audit,
      clock: setup.clock,
      ids: setup.adapters.ids,
    });

    const partial = await deletion.request({
      ownerId: setup.owner.id,
      agentId: setup.agent.id,
      sessionId: setup.session.id,
    });
    await setup.record("session.deletion_incomplete", "pending", {
      deletionId: partial.id,
      archiveStatus: partial.targets.archive.status,
    });
    const resumed = await new SessionDeletionCoordinator({
      state: setup.adapters.deletionState,
      targets,
      audit: setup.adapters.audit,
      clock: setup.clock,
      ids: setup.adapters.ids,
    }).resume(partial.id);
    await setup.record("session.deletion_verified", "completed", {
      deletionId: resumed.id,
    });

    expect(partial).toMatchObject({
      status: "incomplete",
      targets: { archive: { status: "failed" } },
    });
    expect(resumed.status).toBe("verified");
    expect(Object.values(resumed.targets).every(({ status }) => status === "verified")).toBe(true);
    expect(await tracePayload(setup, "session.deletion_incomplete")).toMatchObject({
      status: "pending",
    });
    expect(await tracePayload(setup, "session.deletion_verified")).toMatchObject({
      status: "completed",
    });
  });
});
