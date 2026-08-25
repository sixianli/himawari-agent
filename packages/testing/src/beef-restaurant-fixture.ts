import type {
  ActionIntent,
  CapabilityDeclaration,
  CapabilitySecretReference,
  LongTermGrantScope,
  MemoryWriteProposal,
  ModelDescriptor,
  ModelInvocationEvent,
  PermissionPolicy,
  ScheduledJobWrite,
  TraceEvent,
} from "@himawari-agent/application";
import {
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
} from "@himawari-agent/domain";
import type {
  EventSubscription,
  GetThreadSnapshotQuery,
  StreamEvent,
  ThreadSnapshot,
  TraceQuery,
} from "@himawari-agent/gateway-contracts";

const START = "2026-08-25T00:00:00.000Z";
const PROVIDER_COMPLETED = "2026-08-25T00:00:01.000Z";
const DEADLINE = "2026-08-25T00:05:00.000Z";
const APPROVAL_EXPIRES = "2026-08-25T00:10:00.000Z";
const TASK_EXPIRES = "2026-08-26T00:00:00.000Z";
const CORRELATION_ID = "correlation-beef-restaurant";

const payloads = Object.freeze({
  ownerProfile: "payload-owner-profile-tokyo",
  location: "payload-location-tokyo-station",
  beefPreference: "payload-preference-likes-beef",
  newThreadMessage: "payload-message-eat-out-today",
  memoryQuery: "payload-query-beef-restaurant-tokyo",
  searchCapabilitySummary: "payload-capability-restaurant-search",
  recommendationResult: "payload-recommendation-beef-restaurant",
  monitoringScope: "payload-monitoring-scope-beef-tokyo",
  restaurantSearchInput: "payload-search-beef-tokyo",
  restaurantSearchResult: "restaurant-search-result:execution-beef-search",
  reservationInput: "payload-reservation-beef-house",
  reservationResult: "restaurant-reservation-result:execution-beef-reservation",
});

function actionIntent(
  ownerId: ReturnType<typeof createOwnerId>,
  agentId: ReturnType<typeof createAgentId>,
  input: Omit<ActionIntent, "ownerId" | "agentId" | "idempotencyKey">,
): ActionIntent {
  return Object.freeze({
    ...input,
    ownerId,
    agentId,
    idempotencyKey: createIdempotencyKey(`intent-key:${input.id}`),
  });
}

function capabilityDeclaration(
  ref: "restaurant-search" | "restaurant-reservation",
  operation: "search" | "reserve",
  permissionRefs: readonly string[],
): CapabilityDeclaration {
  return Object.freeze({
    ref,
    displayName: ref === "restaurant-search" ? "Restaurant Search" : "Restaurant Reservation",
    version: "1.0.0",
    source: { type: "builtin" as const, locator: `builtin:${ref}:1.0.0` },
    integrity: `sha256:${ref === "restaurant-search" ? "a".repeat(64) : "b".repeat(64)}`,
    operations: [operation],
    permissionRefs,
    isolation: "worker",
  });
}

export function createBeefRestaurantFixture() {
  const owner = createOwner(createOwnerId("owner-beef-restaurant"));
  const agent = createAgent({ id: createAgentId("agent-himawari"), owner });
  const thread = createThread({ id: createThreadId("thread-eat-out-today"), agent });
  const session = createSession({ id: createSessionId("session-beef-restaurant"), agent, thread });
  const recommendationTrigger = createTrigger({
    id: createTriggerId("trigger-eat-out-today"),
    idempotencyKey: createIdempotencyKey("trigger-key-eat-out-today"),
    agent,
    thread,
  });
  const monitoringTrigger = createTrigger({
    id: createTriggerId("schedule-trigger:job-beef-monitor:0"),
    idempotencyKey: createIdempotencyKey("schedule-command:job-beef-monitor:0"),
    agent,
    thread,
  });
  const reservationTrigger = createTrigger({
    id: createTriggerId("trigger-reserve-beef-house"),
    idempotencyKey: createIdempotencyKey("trigger-key-reserve-beef-house"),
    agent,
    thread,
  });
  const runs = Object.freeze({
    recommendation: createRun({
      id: createRunId("run-beef-recommendation"),
      session,
      trigger: recommendationTrigger,
    }),
    monitoring: createRun({
      id: createRunId("run-beef-monitoring"),
      session,
      trigger: monitoringTrigger,
    }),
    reservation: createRun({
      id: createRunId("run-beef-reservation"),
      session,
      trigger: reservationTrigger,
    }),
  });

  const memoryProposal: MemoryWriteProposal = Object.freeze({
    id: "memory-proposal-likes-beef",
    ownerId: owner.id,
    agentId: agent.id,
    contentRef: payloads.beefPreference,
    sourceRef: "thread-message:likes-beef",
    searchTerms: ["beef", "restaurant", "tokyo"],
    dataClassification: "private",
    proposedAt: START,
  });
  const model: ModelDescriptor = Object.freeze({
    ref: "model-beef-primary",
    provider: "deterministic",
    model: "beef-recommendation-fixture",
    version: "1.0.0",
    routingClass: "primary",
    priority: 1,
    disclosure: "trusted_remote",
    capabilities: ["reasoning"],
    allowedDataClassifications: ["public", "private"] as const,
    secretRequirement: null,
  });
  const modelEvents: readonly ModelInvocationEvent[] = Object.freeze([
    {
      type: "model.started",
      invocationId: "model-beef-call",
      occurredAt: START,
    },
    {
      type: "model.output",
      invocationId: "model-beef-call",
      sequence: 1,
      payloadRef: payloads.recommendationResult,
      occurredAt: START,
    },
    {
      type: "model.completed",
      invocationId: "model-beef-call",
      inputTokens: 120,
      outputTokens: 30,
      costMicros: 0,
      latencyMs: 100,
      occurredAt: PROVIDER_COMPLETED,
    },
  ]);
  const permissionPolicy: PermissionPolicy = Object.freeze({
    version: "beef-restaurant-policy-v1",
    rules: [
      {
        id: "allow-readonly-restaurant-search",
        effect: "ALLOW" as const,
        capabilityRefs: ["restaurant-search"],
        operations: ["search"],
        resourcePrefixes: ["city:tokyo"],
        dataClassifications: ["public", "private"] as const,
        sideEffects: ["none"] as const,
        maxCostMicros: 10_000,
        reasonCode: "readonly_restaurant_search",
      },
    ],
  });
  const monitoringIntent = actionIntent(owner.id, agent.id, {
    id: "intent-monitor-beef-restaurants",
    runId: runs.recommendation.id,
    capabilityRef: "restaurant-monitor",
    operation: "scan",
    resourceRef: "city:tokyo:beef",
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 100,
    frequency: { count: 1, intervalMs: 3_600_000 },
    reversible: true,
    requestedAt: START,
  });
  const monitoringGrantScope: LongTermGrantScope = Object.freeze({
    capabilityRef: "restaurant-monitor",
    operations: ["scan"],
    resourcePrefixes: ["city:tokyo"],
    maxDataClassification: "private",
    sideEffects: ["none"] as const,
    maxCostMicrosPerUse: 100,
    maxFrequency: { count: 1, intervalMs: 3_600_000 },
    maxTotalCostMicros: 2_400,
    maxUses: 24,
    expiresAt: TASK_EXPIRES,
  });
  const searchIntent = actionIntent(owner.id, agent.id, {
    id: "intent-search-beef-restaurants",
    runId: runs.monitoring.id,
    capabilityRef: "restaurant-search",
    operation: "search",
    resourceRef: "city:tokyo:beef",
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 100,
    frequency: { count: 1, intervalMs: null },
    reversible: true,
    requestedAt: START,
  });
  const reservationIntent = actionIntent(owner.id, agent.id, {
    id: "intent-reserve-beef-house",
    runId: runs.reservation.id,
    capabilityRef: "restaurant-reservation",
    operation: "reserve",
    resourceRef: "restaurant:beef-house",
    dataClassification: "private",
    sideEffect: "reversible",
    estimatedCostMicros: 500,
    frequency: { count: 1, intervalMs: null },
    reversible: true,
    requestedAt: START,
  });
  const reservationSecret: CapabilitySecretReference = Object.freeze({
    secretRef: "booking-provider",
    secretVersion: "v1",
    purpose: "restaurant-reservation",
  });
  const scheduledJob: ScheduledJobWrite = Object.freeze({
    id: "job-beef-monitor",
    ownerId: owner.id,
    agentId: agent.id,
    threadId: thread.id,
    payloadRef: payloads.monitoringScope,
    sourceProofRef: "proof-grant-beef-monitor",
    dataClassification: "private",
    authorizationRef: "grant-pending",
    taskScopeRef: payloads.monitoringScope,
    capabilityRef: "restaurant-monitor",
    operation: "scan",
    resourceRef: "city:tokyo:beef",
    sideEffect: "none",
    estimatedCostMicros: 100,
    intervalMs: 3_600_000,
    minimumIntervalMs: 3_600_000,
    expiresAt: TASK_EXPIRES,
    revokedAt: null,
    nextRunAt: START,
    occurrence: 0,
    status: "active",
  });
  const capabilityDeclarations = Object.freeze([
    capabilityDeclaration("restaurant-search", "search", []),
    capabilityDeclaration("restaurant-reservation", "reserve", ["secret:booking-provider"]),
  ]);
  const secondaryClient = Object.freeze({
    subjectId: "client-secondary",
    ownerId: owner.id,
    deviceId: "device-secondary",
    authenticatedAt: START,
    authenticationRef: "auth-secondary",
  });
  const responseEnvelope = Object.freeze({
    schemaVersion: "gateway.v1" as const,
    messageId: "snapshot-thread-beef",
    correlationId: CORRELATION_ID,
    causationId: "query-thread-beef",
    dataClassification: "private" as const,
    scope: { ownerId: owner.id, agentId: agent.id },
    actor: { actorType: "system" as const, actorId: "gateway-read-model" },
  });
  const threadSnapshot: ThreadSnapshot = Object.freeze({
    ...responseEnvelope,
    kind: "snapshot",
    type: "thread.snapshot",
    payload: {
      threadId: thread.id,
      status: "open" as const,
      revision: 3,
      sessionIds: [session.id],
      runIds: [runs.recommendation.id, runs.monitoring.id, runs.reservation.id],
    },
  });
  const requestEnvelope = Object.freeze({
    schemaVersion: "gateway.v1" as const,
    correlationId: CORRELATION_ID,
    causationId: null,
    dataClassification: "private" as const,
    scope: { ownerId: owner.id, agentId: agent.id },
    actor: { actorType: "client" as const, actorId: secondaryClient.subjectId },
  });
  const threadSnapshotQuery: GetThreadSnapshotQuery = Object.freeze({
    ...requestEnvelope,
    kind: "query",
    type: "thread.get_snapshot",
    messageId: "query-thread-beef",
    payload: { threadId: thread.id },
  });
  const traceQuery: TraceQuery = Object.freeze({
    ...requestEnvelope,
    kind: "query",
    type: "trace.query",
    messageId: "query-trace-beef",
    payload: { sessionId: session.id, runId: null, afterSequence: 0, limit: 1_000 },
  });
  const subscription: EventSubscription = Object.freeze({
    ...requestEnvelope,
    kind: "subscription",
    type: "events.subscribe",
    messageId: "subscribe-trace-beef",
    payload: {
      subscriptionId: "subscription-beef-secondary",
      sessionId: session.id,
      threadId: thread.id,
      runId: null,
      afterCursor: null,
    },
  });

  return Object.freeze({
    owner,
    agent,
    thread,
    session,
    runs,
    correlationId: CORRELATION_ID,
    times: Object.freeze({
      start: START,
      providerCompleted: PROVIDER_COMPLETED,
      deadline: DEADLINE,
      approvalExpires: APPROVAL_EXPIRES,
      taskExpires: TASK_EXPIRES,
    }),
    payloads,
    memoryId: "memory-likes-beef",
    memoryProposal,
    model,
    modelEvents,
    permissionPolicy,
    monitoringIntent,
    monitoringGrantScope,
    searchIntent,
    reservationIntent,
    reservationSecret,
    reservationExternalActionId: "external:execution-beef-reservation",
    scheduledJob,
    capabilityDeclarations,
    secondaryClient,
    threadSnapshot,
    threadSnapshotQuery,
    traceQuery,
    subscription,
    toStreamEvent(event: TraceEvent, cursorNumber: number): StreamEvent {
      return Object.freeze({
        schemaVersion: "gateway.v1",
        kind: "event",
        type: "stream.event",
        messageId: `stream:${event.id}`,
        correlationId: event.correlationId,
        causationId: event.causationId,
        dataClassification: event.dataClassification,
        scope: { ownerId: event.ownerId, agentId: event.agentId },
        actor: { actorType: "system" as const, actorId: "gateway-event-stream" },
        payload: {
          cursor: `cursor-${String(cursorNumber).padStart(4, "0")}`,
          sessionId: event.sessionId,
          threadId: event.threadId,
          runId: event.runId,
          turnId: event.turnId,
          parentEventId: event.parentEventId,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          recordedAt: event.recordedAt,
          eventType: event.eventType,
          payloadRef: event.payloadRef,
        },
      });
    },
  });
}
