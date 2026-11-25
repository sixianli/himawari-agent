import {
  AgentGatewayService,
  CapabilityRegistryService,
  ContextFormationService,
  type GatewayAuthenticationContext,
  ModelRouterService,
  type PermissionAllowDecision,
  PermissionService,
  SessionTraceRecorder,
} from "@himawari-agent/application";
import {
  createAgentAuthorityLease,
  createAuthorityHolderId,
  createAuthorityLeaseId,
} from "@himawari-agent/domain";
import type { ExecuteWorkRequest, ReconcileWorkRequest } from "@himawari-agent/execution-contracts";
import { createLocalExecutionWorkerProcess } from "@himawari-agent/execution-worker";
import type { EventSubscription } from "@himawari-agent/gateway-contracts";
import {
  createBeefRestaurantFixture,
  createReferenceAdapterSet,
  DeterministicRestaurantCapabilityPort,
  InMemoryGatewayAccessPolicy,
  InMemoryGatewayControlPlane,
  InMemoryGatewayReadModel,
  ManualClock,
  ScriptedExternalActionReconciliationPort,
  ScriptedModelPort,
} from "@himawari-agent/testing";
import { beforeAll, describe, expect, it } from "vitest";

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function runJourney() {
  const fixture = createBeefRestaurantFixture();
  const clock = new ManualClock(fixture.times.start);
  const model = new ScriptedModelPort([fixture.model], fixture.modelEvents);
  const adapters = createReferenceAdapterSet({
    clock,
    model: { descriptors: [fixture.model], events: fixture.modelEvents },
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
  const router = new ModelRouterService({
    model,
    secrets: adapters.secret,
    trace,
    clock,
    ids: adapters.ids,
  });
  const permissions = new PermissionService({
    store: adapters.authorization,
    clock,
    ids: adapters.ids,
    policy: fixture.permissionPolicy,
  });
  const registry = new CapabilityRegistryService({
    store: adapters.capabilityRegistry,
    clock,
    ids: adapters.ids,
  });
  const capability = new DeterministicRestaurantCapabilityPort(
    fixture.times.start,
    fixture.times.providerCompleted,
    { reservationResultUnknown: true },
  );
  const reconciliation = new ScriptedExternalActionReconciliationPort({
    [fixture.reservationExternalActionId]: {
      outcome: "confirmed_succeeded",
      resultRef: fixture.payloads.reservationResult,
      errorCode: null,
    },
  });
  const worker = createLocalExecutionWorkerProcess({
    handles: adapters.capabilityRegistry,
    capability,
    secrets: adapters.secret,
    reconciliation,
    clock,
    ids: adapters.ids,
  });
  await worker.start();

  const lastEventByRun = new Map<string, string>();
  const record = async (
    runId: (typeof fixture.runs)[keyof typeof fixture.runs]["id"],
    eventType: string,
    payload: unknown,
  ) => {
    const previous = lastEventByRun.get(runId) ?? null;
    const result = await trace.record({
      ownerId: fixture.owner.id,
      agentId: fixture.agent.id,
      sessionId: fixture.session.id,
      threadId: fixture.thread.id,
      runId,
      turnId: null,
      parentEventId: previous,
      causationId: previous ?? "journey-start",
      correlationId: fixture.correlationId,
      actorId: "beef-restaurant-fixture",
      dataClassification: "private",
      eventType,
      payload,
    });
    lastEventByRun.set(runId, result.event.id);
    return result.event;
  };

  await adapters.memory.proposeWrite(fixture.memoryProposal);
  await record(fixture.runs.recommendation.id, "memory.write_proposed", {
    proposalId: fixture.memoryProposal.id,
    contentRef: fixture.memoryProposal.contentRef,
    sourceRef: fixture.memoryProposal.sourceRef,
  });
  const memory = await adapters.memory.commitWrite(
    fixture.memoryProposal.id,
    fixture.memoryId,
    fixture.times.start,
  );
  await record(fixture.runs.recommendation.id, "memory.committed", {
    memoryId: memory.id,
    contentRef: memory.contentRef,
    sourceRef: memory.sourceRef,
  });
  const trigger = await record(fixture.runs.recommendation.id, "trigger.admitted", {
    triggerId: fixture.runs.recommendation.triggerId,
    sourceType: "user_message",
    payloadRef: fixture.payloads.newThreadMessage,
  });

  const formed = await context.form({
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    sessionId: fixture.session.id,
    threadId: fixture.thread.id,
    runId: fixture.runs.recommendation.id,
    trigger: {
      id: fixture.runs.recommendation.triggerId,
      sourceType: "user_message",
      payloadRef: fixture.payloads.newThreadMessage,
      occurredAt: fixture.times.start,
    },
    threadMessages: [],
    sourceWatermark: null,
    policyVersion: "context-policy-v1",
    policies: [{ ref: "policy-owner-v1", payloadRef: fixture.payloads.ownerProfile }],
    memoryQueryRef: fixture.payloads.memoryQuery,
    memoryQueryTerms: ["beef", "restaurant", "tokyo"],
    memoryLimit: 5,
    capabilities: [
      {
        ref: "restaurant-search",
        version: "1.0.0",
        summaryRef: fixture.payloads.searchCapabilitySummary,
        authorizationRef: null,
      },
    ],
    correlationId: fixture.correlationId,
    causationId: trigger.id,
    parentEventId: trigger.id,
    actorId: "context-formation",
    dataClassification: "private",
  });
  lastEventByRun.set(fixture.runs.recommendation.id, formed.traceEventIds.at(-1) ?? trigger.id);

  const routed = await router.route({
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    sessionId: fixture.session.id,
    threadId: fixture.thread.id,
    runId: fixture.runs.recommendation.id,
    taskProfile: "primary",
    requiredCapabilities: ["reasoning"],
    inputRef: formed.contextEnvelopeRef,
    dataClassification: "private",
    maxDisclosure: "trusted_remote",
    allowedDisclosureRef: "disclosure-owner-private-v1",
    forbidFallbackDisclosureExpansion: true,
    correlationId: fixture.correlationId,
    causationId: formed.traceEventIds.at(-1) ?? trigger.id,
    parentEventId: formed.traceEventIds.at(-1) ?? trigger.id,
    actorId: "model-router",
    deadlineAt: fixture.times.deadline,
  });
  const recommendationEvents = await adapters.trace.readRun(fixture.runs.recommendation.id, 0, 100);
  lastEventByRun.set(fixture.runs.recommendation.id, recommendationEvents.at(-1)?.id ?? trigger.id);
  await record(fixture.runs.recommendation.id, "assistant.recommendation", {
    outputRef: fixture.payloads.recommendationResult,
    selectedMemoryIds: formed.selected.map(({ id }) => id),
  });
  await record(fixture.runs.recommendation.id, "task.monitoring_proposed", {
    intentId: fixture.monitoringIntent.id,
    taskScopeRef: fixture.payloads.monitoringScope,
  });

  const monitoringAsk = await permissions.evaluate(fixture.monitoringIntent, {
    uiAvailable: true,
    approvalExpiresAt: fixture.times.approvalExpires,
  });
  if (monitoringAsk.decision !== "ASK") throw new Error("monitoring task must ask");
  await record(fixture.runs.recommendation.id, "approval.requested", {
    approvalRequestId: monitoringAsk.approvalRequest.id,
    semanticSnapshotHash: monitoringAsk.approvalRequest.semanticSnapshotHash,
    intentId: fixture.monitoringIntent.id,
  });
  const monitoringApproval = await permissions.respond({
    approvalRequestId: monitoringAsk.approvalRequest.id,
    semanticSnapshotHash: monitoringAsk.approvalRequest.semanticSnapshotHash,
    decision: "approved",
    grantKind: "long_term",
    longTermScope: fixture.monitoringGrantScope,
  });
  if (!monitoringApproval.grantId) throw new Error("monitoring grant missing");
  await record(fixture.runs.recommendation.id, "approval.responded", {
    approvalRequestId: monitoringApproval.id,
    decision: monitoringApproval.status,
  });
  await record(fixture.runs.recommendation.id, "grant.issued", {
    grantId: monitoringApproval.grantId,
    scopeRef: fixture.payloads.monitoringScope,
  });

  const lease = createAgentAuthorityLease({
    id: createAuthorityLeaseId("lease-beef-restaurant"),
    agent: fixture.agent,
    holderId: createAuthorityHolderId("holder-beef-restaurant"),
  });
  await adapters.authority.claim(lease, 60_000);
  await adapters.scheduler.upsert(
    { ...fixture.scheduledJob, authorizationRef: monitoringApproval.grantId },
    null,
  );
  const timer = await record(fixture.runs.monitoring.id, "scheduler.triggered", {
    jobId: fixture.scheduledJob.id,
    triggerId: fixture.runs.monitoring.triggerId,
    grantId: monitoringApproval.grantId,
  });
  const monitorContext = await context.form({
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    sessionId: fixture.session.id,
    threadId: fixture.thread.id,
    runId: fixture.runs.monitoring.id,
    trigger: {
      id: fixture.runs.monitoring.triggerId,
      sourceType: "schedule",
      payloadRef: fixture.payloads.monitoringScope,
      occurredAt: fixture.times.start,
    },
    threadMessages: [],
    sourceWatermark: null,
    policyVersion: "context-policy-v1",
    policies: [{ ref: monitoringApproval.grantId, payloadRef: fixture.payloads.monitoringScope }],
    memoryQueryRef: fixture.payloads.memoryQuery,
    memoryQueryTerms: ["beef", "restaurant", "tokyo"],
    memoryLimit: 5,
    capabilities: [
      {
        ref: "restaurant-search",
        version: "1.0.0",
        summaryRef: fixture.payloads.searchCapabilitySummary,
        authorizationRef: monitoringApproval.grantId,
      },
    ],
    correlationId: fixture.correlationId,
    causationId: timer.id,
    parentEventId: timer.id,
    actorId: "scheduler-context",
    dataClassification: "private",
  });
  lastEventByRun.set(fixture.runs.monitoring.id, monitorContext.traceEventIds.at(-1) ?? timer.id);
  await record(fixture.runs.monitoring.id, "worker.delegated", {
    workerRunId: "worker-beef-search",
    taskRef: fixture.payloads.restaurantSearchInput,
    delegatedContextRefs: [monitorContext.contextEnvelopeRef],
  });

  for (const declaration of fixture.capabilityDeclarations) {
    await registry.discover(declaration);
    await registry.proposeInstallation(declaration.ref);
    await registry.approveInstallation(declaration.ref, `approval-install-${declaration.ref}`);
    await registry.activate(declaration.ref);
  }
  const searchDecision = await permissions.evaluate(fixture.searchIntent, {
    uiAvailable: false,
    approvalExpiresAt: fixture.times.approvalExpires,
  });
  if (searchDecision.decision !== "ALLOW") throw new Error("search must be policy allowed");
  await record(fixture.runs.monitoring.id, "tool.intent", {
    intentId: fixture.searchIntent.id,
    capabilityRef: fixture.searchIntent.capabilityRef,
  });
  await record(fixture.runs.monitoring.id, "tool.authorized", {
    intentId: fixture.searchIntent.id,
    basis: searchDecision.basis,
  });
  const searchHandle = await registry.issueExecutionHandle({
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    runId: fixture.runs.monitoring.id,
    capabilityRef: "restaurant-search",
    operation: "search",
    permission: searchDecision,
    inputRefs: [fixture.payloads.restaurantSearchInput],
    delegatedContextRefs: [monitorContext.contextEnvelopeRef],
    secretRefs: [],
    expiresAt: fixture.times.deadline,
  });
  const searchRequest: ExecuteWorkRequest = {
    schemaVersion: "execution.v1",
    kind: "request",
    type: "work.execute",
    messageId: "execution-beef-search",
    correlationId: fixture.correlationId,
    causationId: lastEventByRun.get(fixture.runs.monitoring.id) ?? timer.id,
    dataClassification: "private",
    scope: {
      ownerId: fixture.owner.id,
      agentId: fixture.agent.id,
      runId: fixture.runs.monitoring.id,
      workerRunId: "worker-beef-search",
    },
    idempotencyKey: "execution-beef-search",
    payload: {
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: fixture.payloads.restaurantSearchInput,
      capabilityHandleRef: searchHandle.ref,
      delegatedContextRefs: [monitorContext.contextEnvelopeRef],
      secretRefs: [],
      requestedAt: fixture.times.start,
      deadlineAt: fixture.times.deadline,
    },
  };
  const searchEvents = await collect(worker.client.dispatch(searchRequest));
  await record(fixture.runs.monitoring.id, "worker.progress", {
    workerRunId: "worker-beef-search",
    sequence: 1,
  });
  await record(fixture.runs.monitoring.id, "tool.result", {
    workerRunId: "worker-beef-search",
    resultRef: fixture.payloads.restaurantSearchResult,
    outcome: searchEvents.at(-1)?.type,
  });

  const reservationAsk = await permissions.evaluate(fixture.reservationIntent, {
    uiAvailable: true,
    approvalExpiresAt: fixture.times.approvalExpires,
  });
  if (reservationAsk.decision !== "ASK") throw new Error("reservation must ask");
  await record(fixture.runs.reservation.id, "reservation.intent", {
    intentId: fixture.reservationIntent.id,
    resourceRef: fixture.reservationIntent.resourceRef,
  });
  await record(fixture.runs.reservation.id, "approval.requested", {
    approvalRequestId: reservationAsk.approvalRequest.id,
    semanticSnapshotHash: reservationAsk.approvalRequest.semanticSnapshotHash,
  });
  const reservationApproval = await permissions.respond({
    approvalRequestId: reservationAsk.approvalRequest.id,
    semanticSnapshotHash: reservationAsk.approvalRequest.semanticSnapshotHash,
    decision: "approved",
    grantKind: "one_time",
  });
  await record(fixture.runs.reservation.id, "approval.responded", {
    approvalRequestId: reservationApproval.id,
    decision: reservationApproval.status,
  });
  const reservationDecision = await permissions.evaluate(fixture.reservationIntent, {
    uiAvailable: true,
    approvalExpiresAt: fixture.times.approvalExpires,
  });
  if (reservationDecision.decision !== "ALLOW") throw new Error("reservation grant missing");
  const reservationHandle = await registry.issueExecutionHandle({
    ownerId: fixture.owner.id,
    agentId: fixture.agent.id,
    runId: fixture.runs.reservation.id,
    capabilityRef: "restaurant-reservation",
    operation: "reserve",
    permission: reservationDecision,
    inputRefs: [fixture.payloads.reservationInput],
    delegatedContextRefs: [formed.contextEnvelopeRef],
    secretRefs: [fixture.reservationSecret],
    expiresAt: fixture.times.deadline,
  });
  await record(fixture.runs.reservation.id, "secret.handle_issued", {
    secretRef: fixture.reservationSecret.secretRef,
    secretVersion: fixture.reservationSecret.secretVersion,
    purpose: fixture.reservationSecret.purpose,
  });
  const reservationRequest: ExecuteWorkRequest = {
    schemaVersion: "execution.v1",
    kind: "request",
    type: "work.execute",
    messageId: "execution-beef-reservation",
    correlationId: fixture.correlationId,
    causationId: lastEventByRun.get(fixture.runs.reservation.id) ?? "reservation-start",
    dataClassification: "private",
    scope: {
      ownerId: fixture.owner.id,
      agentId: fixture.agent.id,
      runId: fixture.runs.reservation.id,
      workerRunId: "worker-beef-reservation",
    },
    idempotencyKey: "execution-beef-reservation",
    payload: {
      capabilityId: "restaurant-reservation",
      capabilityVersion: "1.0.0",
      operation: "reserve",
      inputRef: fixture.payloads.reservationInput,
      capabilityHandleRef: reservationHandle.ref,
      delegatedContextRefs: [formed.contextEnvelopeRef],
      secretRefs: [fixture.reservationSecret],
      requestedAt: fixture.times.start,
      deadlineAt: fixture.times.deadline,
    },
  };
  const reservationEvents = await collect(worker.client.dispatch(reservationRequest));
  await record(fixture.runs.reservation.id, "tool.progress", {
    workerRunId: "worker-beef-reservation",
    sequence: 1,
  });
  await record(fixture.runs.reservation.id, "external_result.pending", {
    workerRunId: "worker-beef-reservation",
    externalActionId: fixture.reservationExternalActionId,
    status: "reconciling_external_result",
  });
  const reservationReconcileRequest: ReconcileWorkRequest = {
    schemaVersion: "execution.v1",
    kind: "request",
    type: "work.reconcile",
    messageId: "reconcile-beef-reservation",
    correlationId: reservationRequest.correlationId,
    causationId: reservationRequest.messageId,
    dataClassification: reservationRequest.dataClassification,
    scope: reservationRequest.scope,
    idempotencyKey: "reconcile-beef-reservation",
    payload: {
      externalActionId: fixture.reservationExternalActionId,
      resultLookupRef: "lookup-beef-reservation",
      requestedAt: fixture.times.providerCompleted,
    },
  };
  const reservationReconciliation = await collect(
    worker.client.dispatch(reservationReconcileRequest),
  );
  await record(fixture.runs.reservation.id, "external_result.reconciled", {
    workerRunId: "worker-beef-reservation",
    resultRef: fixture.payloads.reservationResult,
    outcome: reservationReconciliation.at(-1)?.type,
  });
  await record(fixture.runs.reservation.id, "client.resumed", {
    clientId: "client-secondary",
    threadId: fixture.thread.id,
  });

  const allTrace = await adapters.trace.readSession(fixture.session.id, null, 1_000);
  const reads = new InMemoryGatewayReadModel();
  reads.seedThreadSnapshot(fixture.threadSnapshot);
  allTrace.forEach((event, index) => {
    reads.appendEvent(fixture.toStreamEvent(event, index + 1));
  });
  const secondary: GatewayAuthenticationContext = fixture.secondaryClient;
  const gateway = new AgentGatewayService({
    access: new InMemoryGatewayAccessPolicy([secondary]),
    controlPlane: new InMemoryGatewayControlPlane(),
    reads,
  });
  const threadSnapshot = await gateway.request(secondary, fixture.threadSnapshotQuery);
  const traceResult = await gateway.request(secondary, fixture.traceQuery);
  const resumeFrom = allTrace[9];
  if (!resumeFrom) throw new Error("resume cursor fixture missing");
  const subscription: EventSubscription = {
    ...fixture.subscription,
    payload: {
      ...fixture.subscription.payload,
      afterCursor: fixture.toStreamEvent(resumeFrom, 10).payload.cursor,
    },
  };
  const resumedEvents = await collect(gateway.subscribe(secondary, subscription));
  const reservationInvocation = capability
    .observedInvocations()
    .find(({ capabilityRef }) => capabilityRef === "restaurant-reservation");
  const reservationSecretHandleRef = reservationInvocation?.secretHandleRefs[0];
  const secretHandle = reservationSecretHandleRef
    ? await adapters.secret.inspectHandle(reservationSecretHandleRef)
    : undefined;
  await worker.shutdown();

  return {
    fixture,
    memory,
    formed,
    routed,
    monitoringApproval,
    searchDecision,
    searchEvents,
    reservationApproval,
    reservationDecision: reservationDecision as PermissionAllowDecision,
    reservationEvents,
    reservationReconciliation,
    reservationInvocation,
    secretHandle,
    allTrace,
    threadSnapshot,
    traceResult,
    resumedEvents,
  };
}

describe("beef-restaurant architecture baseline", () => {
  let journey: Awaited<ReturnType<typeof runJourney>>;

  beforeAll(async () => {
    journey = await runJourney();
  });

  it("uses durable preference memory in a new Thread and approves a scheduled research task", () => {
    expect(journey.memory).toMatchObject({
      contentRef: journey.fixture.payloads.beefPreference,
      sourceRef: journey.fixture.memoryProposal.sourceRef,
    });
    expect(journey.formed.selected).toMatchObject([
      {
        id: journey.fixture.memoryId,
        contentRef: journey.fixture.payloads.beefPreference,
      },
    ]);
    expect(journey.routed).toMatchObject({
      status: "completed",
      selectedModelRef: journey.fixture.model.ref,
      outputRefs: [journey.fixture.payloads.recommendationResult],
    });
    expect(journey.monitoringApproval).toMatchObject({
      status: "approved",
      grantId: expect.stringMatching(/^grant-/),
    });
  });

  it("runs timer research and semantically approves reservation", () => {
    expect(journey.searchDecision).toMatchObject({ decision: "ALLOW" });
    expect(journey.searchEvents.map(({ type }) => type)).toEqual(["work.progress", "work.result"]);
    expect(journey.reservationApproval).toMatchObject({ status: "approved" });
    expect(journey.reservationDecision).toMatchObject({ decision: "ALLOW" });
    expect(journey.reservationEvents.map(({ type }) => type)).toEqual([
      "work.progress",
      "work.result",
    ]);
    expect(journey.reservationEvents.at(-1)).toMatchObject({
      payload: {
        outcome: "result_unknown",
        externalActionId: journey.fixture.reservationExternalActionId,
      },
    });
    expect(journey.reservationReconciliation).toMatchObject([
      {
        type: "work.reconciled",
        payload: {
          outcome: "confirmed_succeeded",
          resultRef: journey.fixture.payloads.reservationResult,
        },
      },
    ]);
    expect(journey.reservationInvocation).toMatchObject({
      capabilityRef: "restaurant-reservation",
      operation: "reserve",
      secretHandleRefs: [expect.stringMatching(/^secret-handle-/)],
    });
    expect(journey.secretHandle).toMatchObject({
      secretRef: journey.fixture.reservationSecret.secretRef,
      revokedAt: journey.fixture.times.start,
    });
  });

  it("lets a second client resume the Thread and read the complete causal event graph", () => {
    expect(journey.threadSnapshot).toMatchObject({
      type: "thread.snapshot",
      payload: { threadId: journey.fixture.thread.id, sessionIds: [journey.fixture.session.id] },
    });
    if (!Array.isArray(journey.traceResult)) throw new Error("complete Trace query missing");
    expect(journey.traceResult).toHaveLength(journey.allTrace.length);
    expect(journey.resumedEvents).toHaveLength(journey.allTrace.length - 10);

    const expectedEventTypes = [
      "memory.write_proposed",
      "memory.committed",
      "trigger.admitted",
      "memory.query",
      "memory.candidates",
      "memory.selection",
      "context.formed",
      "model.route_decided",
      "model.request",
      "model.started",
      "model.output",
      "model.completed",
      "assistant.recommendation",
      "task.monitoring_proposed",
      "approval.requested",
      "approval.responded",
      "grant.issued",
      "scheduler.triggered",
      "memory.query",
      "memory.candidates",
      "memory.selection",
      "context.formed",
      "worker.delegated",
      "tool.intent",
      "tool.authorized",
      "worker.progress",
      "tool.result",
      "reservation.intent",
      "approval.requested",
      "approval.responded",
      "secret.handle_issued",
      "tool.progress",
      "external_result.pending",
      "external_result.reconciled",
      "client.resumed",
    ];
    expect(journey.allTrace.map(({ eventType }) => eventType)).toEqual(expectedEventTypes);

    const eventById = new Map(journey.allTrace.map((event) => [event.id, event]));
    const lastSequenceByRun = new Map<string, number>();
    for (const event of journey.allTrace) {
      expect(event.sequence).toBe((lastSequenceByRun.get(event.runId) ?? 0) + 1);
      lastSequenceByRun.set(event.runId, event.sequence);
      if (event.parentEventId !== null) {
        expect(eventById.get(event.parentEventId)).toMatchObject({ runId: event.runId });
      }
    }
  });
});
