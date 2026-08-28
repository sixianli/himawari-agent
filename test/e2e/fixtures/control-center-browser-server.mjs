import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staticRoot = path.join(repositoryRoot, "apps/control-center/dist");
const port = Number(process.env.HIMAWARI_BROWSER_FIXTURE_PORT ?? "4173");
const now = "2026-08-27T00:00:00.000Z";
const accepted = new Set();
const acceptedThreadCommands = new Map();
const acceptedGovernanceCommands = new Map();
const acceptedOperationsCommands = new Map();
const governanceAuthorizationRef = "authentication:owner-session-01";
const capabilitySecretMaterials = new Map([
  ["secret-ref-provider-token", "fixture-machine-secret-value"],
]);
let recentAuthenticationAvailable = true;
const payloads = new Map([
  ["payload:title-main", { content: "主对话", dataClassification: "private" }],
  ["payload:title-research", { content: "研究记录", dataClassification: "private" }],
  ["payload:message-01", { content: "请总结当前计划。", dataClassification: "private" }],
  ["payload:message-02", { content: "计划处于实施阶段。", dataClassification: "private" }],
]);
const threadEvents = [];
const threadEventClients = new Set();
const threads = new Map([
  [
    "thread-main",
    {
      threadId: "thread-main",
      revision: 2,
      status: "active",
      titleRef: "payload:title-main",
      titleSource: "owner",
      titleRevision: 1,
      pinOrder: 0,
      answerLocale: "zh-CN",
      messageWatermark: 2,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          messageId: "message-01",
          sequence: 1,
          role: "owner",
          contentRef: "payload:message-01",
          dataClassification: "private",
          status: "committed",
          turnId: "turn-01",
          runId: "run-01",
          committedAt: now,
        },
        {
          messageId: "message-02",
          sequence: 2,
          role: "agent",
          contentRef: "payload:message-02",
          dataClassification: "private",
          status: "committed",
          turnId: "turn-01",
          runId: "run-01",
          committedAt: now,
        },
      ],
      runs: [{ runId: "run-01", revision: 2, status: "completed", createdAt: now, updatedAt: now }],
    },
  ],
  [
    "thread-research",
    {
      threadId: "thread-research",
      revision: 1,
      status: "active",
      titleRef: "payload:title-research",
      titleSource: "owner",
      titleRevision: 1,
      pinOrder: null,
      answerLocale: "ja",
      messageWatermark: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
      runs: [],
    },
  ],
]);
const approvalIntent = {
  intentId: "intent-publish-01",
  threadId: "thread-main",
  runId: "run-01",
  actionKind: "COMMUNICATE",
  capabilityRef: "capability-update-approve",
  capabilityVersion: "1.0.0",
  operation: "publish",
  targetRefs: ["target-reviewer-01"],
  resourceRefs: ["resource:article-01"],
  dataClassification: "private",
  disclosure: "named_recipients",
  recipientRefs: ["recipient:reviewer-01"],
  sideEffect: "irreversible",
  estimatedCostMicros: 1_000,
  frequency: { count: 1, intervalMs: null },
  credentialOrAccessChange: false,
  reversible: false,
  idempotencyKey: "intent-publish-01",
  deterministicFactCodes: ["EXTERNAL_COMMUNICATION"],
  modelReasonCode: "MODEL_COMMUNICATION",
  requestedAt: now,
  expiresAt: "2026-08-28T00:00:00.000Z",
};
const approvals = new Map(
  ["approval-approve", "approval-deny", "approval-recent-auth"].map((approvalRequestId) => [
    approvalRequestId,
    {
      approvalRequestId,
      revision: 1,
      status: "pending",
      deliveryState: "deliverable",
      semanticSnapshotHash: `sha256:${approvalRequestId}`,
      finalRisk: "critical",
      recentAuthenticationRequired: true,
      recentAuthenticationRef: null,
      requestedAt: now,
      expiresAt: "2026-08-28T00:00:00.000Z",
      decidedAt: null,
      grantId: null,
      intent: { ...approvalIntent, intentId: `intent:${approvalRequestId}` },
      trueResultRef: null,
      generatedAt: now,
    },
  ]),
);

function capabilityRecord(capabilityRef, lifecycle, overrides = {}) {
  return {
    capabilityRef,
    revision: 1,
    lifecycle,
    displayName: `Fixture ${capabilityRef}`,
    sourceType: "adapter",
    sourceLocator: `adapter:fixture:${capabilityRef}:1.0.0`,
    sourceIdentity: "publisher:fixture-reviewed",
    version: "1.0.0",
    integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    signatureStatus: "verified",
    signerRef: "signer-fixture",
    operations: ["publish"],
    permissionRefs: ["permission-publish"],
    dataClassifications: ["private"],
    networkScopes: ["api.example.test:443"],
    filesystemScopes: [],
    secretRefs: ["secret-ref-provider-token"],
    isolation: "remote",
    currency: "USD",
    maxMicrosPerInvocation: 1_000,
    healthStatus: "healthy",
    healthCheckedAt: now,
    reviewedBy: lifecycle === "review_required" ? null : "owner-01",
    reviewedAt: lifecycle === "review_required" ? null : now,
    approvalRefs: lifecycle === "active" ? ["approval-install-fixture"] : [],
    dependencyTaskRefs: ["task-dependent-01"],
    runtimeQualification:
      lifecycle === "active"
        ? {
            platform: "linux",
            runtimeIdentity: `adapter-runtime:${capabilityRef}`,
            productionSuitable: true,
            reasonCodes: [],
            checkedAt: now,
          }
        : null,
    pendingVersion: null,
    updateAssessment: null,
    rollbackVersion: lifecycle === "active" ? "0.9.0" : null,
    rollbackAvailable: lifecycle === "active",
    lastTransition:
      lifecycle === "active"
        ? {
            fromVersion: "0.9.0",
            toVersion: "1.0.0",
            outcome: "activated",
            occurredAt: now,
            externalEffectsRolledBack: false,
            productStateRolledBack: false,
          }
        : null,
    generatedAt: now,
    ...overrides,
  };
}

const capabilityUpdateAssessment = {
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  disposition: "approval_required",
  risk: "critical",
  sourceIdentityChanged: false,
  integrityChanged: true,
  semanticMajorChanged: true,
  runtimeKindChanged: false,
  executableIdentityChanged: false,
  executableCodeChanged: true,
  expansions: ["permission:publish-public"],
  contractions: [],
  compatibilityPreserved: true,
  reasonCodes: ["CAPABILITY_UPDATE_EXECUTABLE_CHANGED"],
};
const capabilities = new Map([
  [
    "capability-review",
    capabilityRecord("capability-review", "review_required", { healthStatus: "unknown" }),
  ],
  [
    "capability-update-approve",
    capabilityRecord("capability-update-approve", "update_proposed", {
      revision: 5,
      pendingVersion: "2.0.0",
      updateAssessment: capabilityUpdateAssessment,
      rollbackVersion: "0.9.0",
      rollbackAvailable: true,
    }),
  ],
  [
    "capability-update-deny",
    capabilityRecord("capability-update-deny", "update_proposed", {
      revision: 5,
      pendingVersion: "2.0.0",
      updateAssessment: capabilityUpdateAssessment,
      rollbackVersion: "0.9.0",
      rollbackAvailable: true,
    }),
  ],
  ["capability-active", capabilityRecord("capability-active", "active", { revision: 7 })],
]);
const grants = new Map([
  [
    "grant-active",
    {
      grantId: "grant-active",
      revision: 2,
      kind: "one_time",
      status: "active",
      capabilityRef: "capability-update-approve",
      capabilityVersion: "1.0.0",
      operations: ["publish"],
      exactResourceRef: "resource:article-01",
      resourceIdentities: ["resource:article-01"],
      resourcePrefixes: [],
      maxDataClassification: "private",
      disclosure: "named_recipients",
      sideEffects: ["irreversible"],
      recipientRefs: ["recipient:reviewer-01"],
      maxCostMicrosPerUse: 1_000,
      maxFrequency: { count: 1, intervalMs: null },
      validFrom: now,
      expiresAt: "2026-08-28T00:00:00.000Z",
      uses: 0,
      maxUses: 1,
      spentCostMicros: 0,
      maxTotalCostMicros: 1_000,
      sourceApprovalRequestId: "approval-approve",
      revokedAt: null,
      revocationReasonCode: null,
      affectedTaskRefs: ["task-dependent-01"],
      generatedAt: now,
    },
  ],
]);
const tasks = new Map([
  [
    "job-repository-monitor",
    {
      jobId: "job-repository-monitor",
      revision: 3,
      status: "active",
      triggerType: "github_event",
      timezone: "Asia/Tokyo",
      nextRunAt: "2026-08-27T01:00:00.000Z",
      occurrenceRef: "occurrence-repository-monitor-01",
      occurrenceStatus: "budget_blocked",
      runRef: "run-repository-monitor-01",
      resultRef: null,
      blockedReasonCode: "BUDGET_EXHAUSTED",
      maxCostMicros: 10_000,
      spentCostMicros: 10_000,
      requestedAttention: "NOTIFY",
      safetyFloor: "INBOX",
      effectiveAttention: "NOTIFY",
      deliveryRefs: ["delivery-repository-monitor-01"],
      generatedAt: now,
    },
  ],
  [
    "job-daily-review",
    {
      jobId: "job-daily-review",
      revision: 2,
      status: "paused",
      triggerType: "interval",
      timezone: "Asia/Tokyo",
      nextRunAt: null,
      occurrenceRef: "occurrence-daily-review-01",
      occurrenceStatus: "completed",
      runRef: "run-daily-review-01",
      resultRef: "result-daily-review-01",
      blockedReasonCode: null,
      maxCostMicros: 20_000,
      spentCostMicros: 4_200,
      requestedAttention: "DIGEST",
      safetyFloor: "INBOX",
      effectiveAttention: "DIGEST",
      deliveryRefs: ["delivery-daily-review-01"],
      generatedAt: now,
    },
  ],
]);
const inboxItems = new Map([
  [
    "inbox-01",
    {
      inboxItemId: "inbox-01",
      revision: 2,
      unread: true,
      priority: 80,
      attentionLevel: "INBOX",
      resultRef: "result-daily-review-01",
      sourceRefs: ["job:job-daily-review", "run:run-daily-review-01"],
      duplicateKey: "daily-review-result",
      createdAt: now,
      generatedAt: now,
    },
  ],
]);
const digest = {
  digestId: "digest-current",
  windowStart: "2026-08-26T15:00:00.000Z",
  windowEnd: "2026-08-27T15:00:00.000Z",
  itemRefs: ["inbox-01"],
  sourceResultRefs: ["result-daily-review-01"],
  generatedAt: now,
};
const memories = new Map([
  [
    "memory-01",
    {
      memoryId: "memory-01",
      revision: 2,
      status: "active",
      contentRef: "payload-memory-01",
      dataClassification: "sensitive",
      sourceThreadId: "thread-main",
      sourceRefs: ["message-01"],
      inference: true,
      confidencePermille: 860,
      policyVersion: "memory-policy-v1",
      sensitiveApprovalRef: "approval-memory-01",
      providerProjectionStatus: "completed",
      lastUsedAt: null,
      updatedAt: now,
      generatedAt: now,
    },
  ],
  [
    "memory-02",
    {
      memoryId: "memory-02",
      revision: 1,
      status: "archived",
      contentRef: "payload-memory-02",
      dataClassification: "private",
      sourceThreadId: "thread-research",
      sourceRefs: ["message-research-01"],
      inference: false,
      confidencePermille: 1000,
      policyVersion: "memory-policy-v1",
      sensitiveApprovalRef: null,
      providerProjectionStatus: "completed",
      lastUsedAt: now,
      updatedAt: now,
      generatedAt: now,
    },
  ],
]);
const traces = new Map(
  ["trace-01", "trace-02"].map((traceEventId, index) => [
    traceEventId,
    {
      traceEventId,
      sequence: index + 1,
      eventType: index === 0 ? "model.completed" : "result.committed",
      actorRef: "agent-01",
      parentEventRef: index === 0 ? null : "trace-01",
      causationRef: "event-run-01",
      threadRef: "thread-main",
      runRef: "run-01",
      modelRef: "model:fixture-primary:v1",
      providerRef: "fixture-provider",
      authorizationRef: "grant-active",
      capabilityRef: index === 0 ? null : "capability-update-approve",
      costMicros: index === 0 ? 24 : 0,
      retryAttempt: 0,
      resultRef: "result-daily-review-01",
      payloadRef: `payload:${traceEventId}`,
      occurredAt: now,
      generatedAt: now,
    },
  ]),
);
const sessions = new Map([
  [
    "session-01",
    {
      sessionId: "session-01",
      sessionRevision: 2,
      status: "active",
      deviceId: "device-01",
      deviceLabel: "Owner MacBook",
      deviceStatus: "active",
      authenticationRef: governanceAuthorizationRef,
      firstAuthenticatedAt: now,
      lastActiveAt: now,
      recentAuthenticatedAt: now,
      revokedAt: null,
      generatedAt: now,
    },
  ],
]);
const settings = {
  revision: 3,
  primaryModelRef: "model:fixture-primary:v1",
  fallbackModelRef: "model:fixture-fallback:v1",
  globalBudgetMicros: 1_000_000,
  spentBudgetMicros: 24,
  defaultAttention: "INBOX",
  digestTimezone: "Asia/Tokyo",
  digestScheduleRef: "schedule-digest-01",
  integrations: [
    {
      integrationRef: "github-app",
      status: "blocked_credentials",
      secretRefs: ["secret-ref-github-app"],
      reasonCode: "CREDENTIALS_REQUIRED",
    },
  ],
  generatedAt: now,
};
let cursorSequence = 1;
let healthDegraded = false;

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function envelope(kind, type) {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `${kind}:${type}:fixture`,
    correlationId: "correlation:fixture",
    causationId: "message:fixture",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system-01" },
  };
}

function threadEnvelope(kind, type, request = {}) {
  return {
    schemaVersion: "gateway.thread.v3",
    kind,
    type,
    messageId: `${kind}:${type}:fixture:${cursorSequence}`,
    correlationId: request.correlationId ?? "correlation:thread-fixture",
    causationId: request.messageId ?? null,
    scope: request.scope ?? { ownerId: "owner-01", agentId: "agent-01" },
    authority: request.authority ?? {
      deploymentId: "deployment-01",
      authorityEpoch: 1,
      fencingToken: 1,
    },
    actor: { actorType: "system", actorId: "thread-gateway-fixture" },
  };
}

function threadSummary(thread) {
  const { messages: _messages, runs: _runs, ...summary } = thread;
  return summary;
}

function threadResult(request, threadId, resultRef, replayed = false) {
  const thread = threads.get(threadId);
  return {
    ...threadEnvelope("result", "thread.command_result", request),
    payload: {
      commandType: request.type,
      commandId: request.messageId,
      threadId,
      threadRevision: thread?.revision ?? 1,
      resultRef,
      replayed,
      committedAt: now,
    },
  };
}

function threadConflict(request, threadId) {
  const thread = threads.get(threadId);
  return {
    ...threadEnvelope("conflict", "thread.conflict", request),
    payload: {
      commandType: request.type,
      threadId,
      reasonCode: "PORT_CONFLICT",
      latest: thread ? threadSummary(thread) : null,
      generatedAt: now,
    },
  };
}

function writeThreadEvent(request, threadId, eventType, payloadRef = null) {
  const thread = threads.get(threadId);
  if (!thread) return;
  cursorSequence += 1;
  const event = {
    ...threadEnvelope("event", "thread.event", request),
    messageId: `event:thread:${cursorSequence}`,
    payload: {
      eventId: `event:thread:${cursorSequence}`,
      threadId,
      revision: thread.revision,
      cursor: `thread-cursor:${cursorSequence}`,
      causationCommandId: request.messageId,
      eventType,
      payloadRef,
      occurredAt: now,
    },
  };
  threadEvents.push(event);
  const wire = `id: ${event.payload.cursor}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of threadEventClients) client.write(wire);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function collectionCategory(type) {
  return {
    "thread.list": ["threads", ["thread-main", "thread-research"]],
    "thread.timeline": ["messages", ["message-01", "message-02"]],
    "approval.list": ["approvals", ["approval-01"]],
    "task.list": ["tasks", ["job-repository-monitor", "job-daily-review"]],
    "inbox.list": ["inbox", ["inbox-01"]],
    "memory.search": ["memories", ["memory-01", "memory-02"]],
    "trace.timeline": ["trace", ["trace-01", "trace-02"]],
    "identity.sessions": ["sessions", ["session-01"]],
  }[type];
}

function operationsSnapshot(type, payload) {
  return {
    ...envelope("snapshot", type),
    messageId: `snapshot:${type}:${payload.revision ?? payload.sessionRevision ?? cursorSequence}`,
    payload: { ...payload, generatedAt: now },
  };
}

function handleOperationsQuery(message) {
  switch (message.type) {
    case "task.detail": {
      const value = tasks.get(message.payload.jobId);
      return value ? operationsSnapshot("task.snapshot", value) : null;
    }
    case "inbox.detail": {
      const value = inboxItems.get(message.payload.inboxItemId);
      return value ? operationsSnapshot("inbox.snapshot", value) : null;
    }
    case "inbox.digest":
      return operationsSnapshot("digest.snapshot", digest);
    case "memory.detail": {
      const value = memories.get(message.payload.memoryId);
      return value ? operationsSnapshot("memory.snapshot", value) : null;
    }
    case "trace.detail": {
      const value = traces.get(message.payload.traceEventId);
      return value ? operationsSnapshot("trace.snapshot", value) : null;
    }
    case "settings.read":
      return operationsSnapshot("settings.snapshot", settings);
    case "identity.session_detail": {
      const value = sessions.get(message.payload.sessionId);
      return value ? operationsSnapshot("session.snapshot", value) : null;
    }
    default:
      return undefined;
  }
}

function handleOperationsCommand(message) {
  if (
    !["task.set_state", "memory.mutate", "session.revoke", "settings.update"].includes(message.type)
  ) {
    return null;
  }
  const fingerprint = JSON.stringify({ type: message.type, payload: message.payload });
  const acceptedCommand = acceptedOperationsCommands.get(message.idempotencyKey);
  if (acceptedCommand) {
    if (acceptedCommand.fingerprint !== fingerprint) {
      return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
    }
    return { status: 200, body: { ...acceptedCommand.result, replayed: true } };
  }
  if (message.authorizationRef !== governanceAuthorizationRef) {
    return { status: 403, body: { error: { code: "PORT_NOT_AUTHORITATIVE" } } };
  }
  let target;
  if (message.type === "task.set_state") target = tasks.get(message.payload.jobId);
  if (message.type === "memory.mutate") target = memories.get(message.payload.memoryId);
  if (message.type === "session.revoke") target = sessions.get(message.payload.sessionId);
  if (message.type === "settings.update") target = settings;
  if (!target) return { status: 404, body: { error: { code: "PORT_NOT_FOUND" } } };
  const revision = target.sessionRevision ?? target.revision;
  if (message.payload.expectedRevision !== revision) {
    return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
  }
  if (message.type === "task.set_state") {
    target.revision += 1;
    target.status =
      message.payload.action === "revoke"
        ? "revoked"
        : message.payload.action === "pause"
          ? "paused"
          : "active";
    target.nextRunAt = target.status === "active" ? "2026-08-27T01:00:00.000Z" : null;
  }
  if (message.type === "memory.mutate") {
    target.revision += 1;
    target.status =
      message.payload.action === "delete"
        ? "deletion_pending"
        : message.payload.action === "archive"
          ? "archived"
          : "active";
    if (message.payload.action === "correct") target.contentRef = message.payload.contentRef;
  }
  if (message.type === "session.revoke") {
    if (message.payload.recentAuthenticationRef !== governanceAuthorizationRef) {
      return { status: 403, body: { error: { code: "RECENT_AUTHENTICATION_REQUIRED" } } };
    }
    target.sessionRevision += 1;
    target.status = "revoked";
    target.revokedAt = now;
  }
  if (message.type === "settings.update") target.revision += 1;
  cursorSequence += 1;
  const result = { resultRef: `operation:${message.type}:${cursorSequence}`, replayed: false };
  acceptedOperationsCommands.set(message.idempotencyKey, { fingerprint, result });
  return { status: 200, body: result };
}

function governanceSnapshot(type, payload, risk = "medium") {
  return {
    ...envelope("snapshot", type),
    risk,
    messageId: `snapshot:${type}:${payload.revision ?? cursorSequence}`,
    payload: { ...payload, generatedAt: now },
  };
}

function governanceCollection(category, itemRefs) {
  return {
    ...envelope("snapshot", "collection.snapshot"),
    payload: {
      category,
      itemRefs,
      nextCursor: null,
      snapshotRef: `snapshot:${category}:${cursorSequence}`,
      generatedAt: now,
    },
  };
}

function handleGovernanceQuery(message) {
  switch (message.type) {
    case "approval.list":
      return governanceCollection(
        "approvals",
        [...approvals.values()]
          .filter(
            ({ status }) => message.payload.status === null || message.payload.status === status,
          )
          .map(({ approvalRequestId }) => approvalRequestId),
      );
    case "approval.detail": {
      const approval = approvals.get(message.payload.approvalRequestId);
      return approval
        ? governanceSnapshot("approval.snapshot", approval, approval.finalRisk)
        : null;
    }
    case "capability.list":
      return governanceCollection(
        "capabilities",
        [...capabilities.values()]
          .filter(
            ({ lifecycle }) =>
              message.payload.lifecycle === null || message.payload.lifecycle === lifecycle,
          )
          .map(({ capabilityRef }) => capabilityRef),
      );
    case "capability.detail": {
      const capability = capabilities.get(message.payload.capabilityRef);
      return capability
        ? governanceSnapshot(
            "capability.snapshot",
            capability,
            capability.updateAssessment?.risk ?? "medium",
          )
        : null;
    }
    case "grant.list":
      return governanceCollection(
        "grants",
        [...grants.values()]
          .filter(({ status }) => message.payload.includeRevoked || status !== "revoked")
          .map(({ grantId }) => grantId),
      );
    case "grant.detail": {
      const grant = grants.get(message.payload.grantId);
      return grant ? governanceSnapshot("grant.snapshot", grant) : null;
    }
    default:
      return undefined;
  }
}

function governanceTarget(message) {
  switch (message.type) {
    case "approval.respond":
      return approvals.get(message.payload.approvalRequestId);
    case "grant.revoke":
      return grants.get(message.payload.grantId);
    case "capability.review":
    case "capability.install.approve":
    case "capability.update.respond":
    case "capability.disable":
    case "capability.rollback":
      return capabilities.get(message.payload.capabilityRef);
    default:
      return undefined;
  }
}

function handleGovernanceCommand(message) {
  if (
    ![
      "approval.respond",
      "grant.revoke",
      "capability.review",
      "capability.install.approve",
      "capability.update.respond",
      "capability.disable",
      "capability.rollback",
    ].includes(message.type)
  ) {
    return null;
  }
  const fingerprint = JSON.stringify({ type: message.type, payload: message.payload });
  const acceptedCommand = acceptedGovernanceCommands.get(message.idempotencyKey);
  if (acceptedCommand) {
    if (acceptedCommand.fingerprint !== fingerprint) {
      return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
    }
    return { status: 200, body: { ...acceptedCommand.result, replayed: true } };
  }
  if (message.authorizationRef !== governanceAuthorizationRef) {
    return { status: 403, body: { error: { code: "PORT_NOT_AUTHORITATIVE" } } };
  }
  const target = governanceTarget(message);
  if (!target) return { status: 404, body: { error: { code: "PORT_NOT_FOUND" } } };
  if (message.payload.expectedRevision !== target.revision) {
    return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
  }
  switch (message.type) {
    case "approval.respond":
      if (
        message.payload.semanticSnapshotHash !== target.semanticSnapshotHash ||
        (message.payload.decision === "approved" &&
          message.payload.recentAuthenticationRef !== governanceAuthorizationRef)
      ) {
        return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
      }
      target.revision += 1;
      target.status = message.payload.decision;
      target.decidedAt = now;
      target.recentAuthenticationRef =
        message.payload.decision === "approved" ? governanceAuthorizationRef : null;
      target.grantId = message.payload.decision === "approved" ? "grant-active" : null;
      target.trueResultRef = `result:${target.approvalRequestId}:${target.status}`;
      break;
    case "grant.revoke":
      target.revision += 1;
      target.status = "revoked";
      target.revokedAt = now;
      target.revocationReasonCode = message.payload.reasonCode;
      break;
    case "capability.review":
      if (target.lifecycle !== "review_required") {
        return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
      }
      target.revision += 1;
      target.lifecycle = "installation_proposed";
      target.reviewedBy = "owner-01";
      target.reviewedAt = now;
      break;
    case "capability.install.approve":
      if (target.lifecycle !== "installation_proposed") {
        return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
      }
      if (!target.secretRefs.every((secretRef) => capabilitySecretMaterials.has(secretRef))) {
        return { status: 503, body: { error: { code: "SECRET_REFERENCE_UNAVAILABLE" } } };
      }
      target.revision += 2;
      target.lifecycle = "active";
      target.approvalRefs = [message.payload.approvalRef];
      target.runtimeQualification = {
        platform: "linux",
        runtimeIdentity: `adapter-runtime:${target.capabilityRef}`,
        productionSuitable: true,
        reasonCodes: [],
        checkedAt: now,
      };
      target.healthStatus = "healthy";
      break;
    case "capability.update.respond": {
      if (target.lifecycle !== "update_proposed") {
        return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
      }
      const fromVersion = target.version;
      const toVersion = target.pendingVersion;
      target.revision += message.payload.decision === "approved" ? 2 : 1;
      if (message.payload.decision === "approved") {
        target.version = toVersion;
        target.rollbackVersion = fromVersion;
        target.rollbackAvailable = true;
        target.approvalRefs = [...target.approvalRefs, message.payload.approvalRef];
      }
      target.lifecycle = "active";
      target.lastTransition = {
        fromVersion,
        toVersion,
        outcome: message.payload.decision === "approved" ? "activated" : "rejected",
        occurredAt: now,
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      };
      target.pendingVersion = null;
      target.updateAssessment = null;
      break;
    }
    case "capability.disable":
      target.revision += 1;
      target.lifecycle = "disabled";
      target.healthStatus = "unknown";
      break;
    case "capability.rollback": {
      if (target.lifecycle !== "active" || !target.rollbackVersion) {
        return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
      }
      const fromVersion = target.version;
      target.version = target.rollbackVersion;
      target.rollbackVersion = fromVersion;
      target.revision += 1;
      target.lastTransition = {
        fromVersion,
        toVersion: target.version,
        outcome: "rolled_back",
        occurredAt: now,
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      };
      break;
    }
  }
  cursorSequence += 1;
  const result = { resultRef: `governance:${message.type}:${target.revision}`, replayed: false };
  acceptedGovernanceCommands.set(message.idempotencyKey, { fingerprint, result });
  return { status: 200, body: result };
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

function visibleThreads(statuses) {
  return [...threads.values()]
    .filter((thread) => statuses.length === 0 || statuses.includes(thread.status))
    .sort((left, right) => (left.pinOrder ?? 999) - (right.pinOrder ?? 999));
}

function handleThreadQuery(message) {
  const common = threadEnvelope(
    "snapshot",
    `${message.type.replace(/^thread\./, "thread.")}_snapshot`,
    message,
  );
  if (message.type === "thread.list") {
    return {
      ...common,
      type: "thread.collection_snapshot",
      payload: {
        threads: visibleThreads(message.payload.statuses).map(threadSummary),
        nextCursor: null,
        snapshotRef: `snapshot:thread-list:${cursorSequence}`,
        generatedAt: now,
      },
    };
  }
  if (message.type === "thread.search") {
    return {
      ...common,
      type: "thread.search_snapshot",
      payload: {
        queryRef: message.payload.queryRef,
        projectionVersion: message.payload.projectionVersion,
        threads: visibleThreads(message.payload.statuses).map(threadSummary),
        nextCursor: null,
        degraded: false,
        reasonCode: null,
        snapshotRef: `snapshot:thread-search:${cursorSequence}`,
        generatedAt: now,
      },
    };
  }
  const thread = threads.get(message.payload.threadId);
  if (!thread) return null;
  if (message.type === "thread.detail") {
    return {
      ...common,
      type: "thread.detail_snapshot",
      payload: {
        thread: threadSummary(thread),
        messages: thread.messages.filter(
          ({ sequence }) => sequence > message.payload.afterSequence,
        ),
        runs: thread.runs,
        nextSequence: null,
        snapshotRef: `snapshot:thread-detail:${thread.threadId}:${thread.revision}`,
        generatedAt: now,
      },
    };
  }
  if (message.type === "thread.lineage") {
    return {
      ...common,
      type: "thread.lineage_snapshot",
      payload: {
        threadId: thread.threadId,
        sourceThreadId: null,
        sourceTurnId: null,
        sourceWatermark: null,
        summaryRefs: [],
        policyRefs: [],
        sourceContentAvailable: true,
        forkedAt: null,
        snapshotRef: `snapshot:lineage:${thread.threadId}`,
        generatedAt: now,
      },
    };
  }
  if (message.type === "thread.checkpoint") {
    return {
      ...common,
      type: "thread.checkpoint_snapshot",
      payload: {
        threadId: thread.threadId,
        jobId: "checkpoint-job-01",
        generationId: "checkpoint-generation-01",
        sourceWatermark: thread.messageWatermark,
        policyVersion: "checkpoint-policy-v1",
        modelDescriptorRef: "model:fixture-primary:v1",
        trigger: "owner_explicit",
        summaryRef: "payload:checkpoint-summary",
        status: "completed",
        revision: 1,
        attemptCount: 1,
        nextRetryAt: null,
        errorCode: null,
        snapshotRef: `snapshot:checkpoint:${thread.threadId}`,
        generatedAt: now,
      },
    };
  }
  if (message.type === "thread.deletion_impact") {
    return {
      ...common,
      type: "thread.deletion_impact_snapshot",
      payload: {
        threadId: thread.threadId,
        threadRevision: thread.revision,
        associatedTasks: [],
        activeTaskIds: [],
        deletionAllowed: true,
        snapshotRef: `snapshot:deletion-impact:${thread.threadId}`,
        generatedAt: now,
      },
    };
  }
  return null;
}

function handleThreadCommand(message) {
  const replay = acceptedThreadCommands.get(message.idempotencyKey);
  if (replay) {
    return {
      ...replay,
      payload: { ...replay.payload, replayed: true },
    };
  }
  const sourceThreadId = message.payload.threadId ?? message.payload.sourceThreadId;
  const thread = threads.get(sourceThreadId);
  if (
    message.type !== "thread.create" &&
    message.type !== "thread.fork" &&
    thread &&
    "expectedRevision" in message.payload &&
    message.payload.expectedRevision !== thread.revision
  ) {
    return threadConflict(message, sourceThreadId);
  }
  let targetThreadId = sourceThreadId;
  switch (message.type) {
    case "thread.create":
      targetThreadId = message.payload.threadId;
      if (!threads.has(targetThreadId)) {
        threads.set(targetThreadId, {
          threadId: targetThreadId,
          revision: 1,
          status: "active",
          titleRef: null,
          titleSource: null,
          titleRevision: 0,
          pinOrder: null,
          answerLocale: message.payload.answerLocale,
          messageWatermark: 0,
          createdAt: now,
          updatedAt: now,
          messages: [],
          runs: [],
        });
      }
      break;
    case "thread.fork":
      targetThreadId = message.payload.targetThreadId;
      threads.set(targetThreadId, {
        ...threadSummary(thread),
        threadId: targetThreadId,
        revision: 1,
        pinOrder: null,
        createdAt: now,
        updatedAt: now,
        messages: thread.messages.filter(
          ({ sequence }) => sequence <= message.payload.sourceWatermark,
        ),
        runs: [],
      });
      break;
    case "thread.message.submit":
      thread.revision += 1;
      thread.messageWatermark += 1;
      thread.updatedAt = now;
      thread.messages.push({
        messageId: message.payload.messageId,
        sequence: thread.messageWatermark,
        role: "owner",
        contentRef: message.payload.contentRef,
        dataClassification: message.payload.dataClassification,
        status: "committed",
        turnId: message.payload.turnId,
        runId: message.payload.runId,
        committedAt: message.payload.occurredAt,
      });
      thread.runs.push({
        runId: message.payload.runId,
        revision: 1,
        status: "accepted",
        createdAt: message.payload.occurredAt,
        updatedAt: message.payload.occurredAt,
      });
      break;
    case "thread.rename":
      thread.revision += 1;
      thread.titleRevision += 1;
      thread.titleRef = message.payload.titleRef;
      thread.titleSource = message.payload.titleSource;
      thread.updatedAt = now;
      break;
    case "thread.pin":
      thread.revision += 1;
      thread.pinOrder = message.payload.pinOrder;
      thread.updatedAt = now;
      break;
    case "thread.archive":
      thread.revision += 1;
      thread.status = "archived";
      thread.updatedAt = now;
      break;
    case "thread.restore":
      thread.revision += 1;
      thread.status = "active";
      thread.updatedAt = now;
      break;
    case "thread.trash":
      thread.revision += 1;
      thread.status = "trashed";
      thread.updatedAt = now;
      break;
    case "thread.set_answer_locale":
      thread.revision += 1;
      thread.answerLocale = message.payload.answerLocale;
      thread.updatedAt = now;
      break;
    case "thread.task.resolve":
      break;
  }
  const result = threadResult(message, targetThreadId, message.payload.resultRef);
  acceptedThreadCommands.set(message.idempotencyKey, result);
  writeThreadEvent(message, targetThreadId, message.type, message.payload.resultRef);
  return result;
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/api/control-center/v1/config") {
    json(response, 200, {
      ownerId: "owner-01",
      agentId: "agent-01",
      deploymentId: "deployment-01",
      authorityEpoch: 1,
      fencingToken: 1,
      actorId: "owner-01",
      csrfToken: "csrf-fixture",
      authorizationRef: governanceAuthorizationRef,
      recentAuthenticationRef: recentAuthenticationAvailable ? governanceAuthorizationRef : null,
      primaryModel: { provider: "fixture-provider", model: "fixture-primary", version: "v1" },
      primaryModelRef: "model:fixture-primary:v1",
      repositoryAllowlistRefs: ["fixture-owner/fixture-repository"],
      disclosedDataClassifications: ["private"],
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/degrade") {
    healthDegraded = true;
    json(response, 200, { degraded: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/recent-auth") {
    const message = await body(request);
    recentAuthenticationAvailable = message.available === true;
    json(response, 200, { available: recentAuthenticationAvailable });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/conflict") {
    const message = await body(request);
    const thread = threads.get(message.threadId);
    if (!thread) {
      json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
      return;
    }
    thread.revision += 1;
    thread.updatedAt = now;
    json(response, 200, { threadId: thread.threadId, revision: thread.revision });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/governance-conflict") {
    const message = await body(request);
    const target =
      grants.get(message.objectRef) ??
      capabilities.get(message.objectRef) ??
      approvals.get(message.objectRef);
    if (!target) {
      json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
      return;
    }
    target.revision += 1;
    cursorSequence += 1;
    json(response, 200, { objectRef: message.objectRef, revision: target.revision });
    return;
  }
  if (
    request.method === "POST" &&
    /^\/api\/capabilities\/[^/]+\/(?:execute|invoke|run)$/.test(url.pathname)
  ) {
    json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gateway/v2/queries") {
    const message = await body(request);
    const governance = handleGovernanceQuery(message);
    if (governance !== undefined) {
      if (governance === null) {
        json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
        return;
      }
      json(response, 200, governance);
      return;
    }
    const operation = handleOperationsQuery(message);
    if (operation !== undefined) {
      if (operation === null) {
        json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
        return;
      }
      json(response, 200, operation);
      return;
    }
    if (message.type === "health.status") {
      json(response, 200, {
        ...envelope("snapshot", "health.snapshot"),
        payload: {
          deploymentId: "deployment-01",
          activeHost: "browser-fixture",
          authorityEpoch: 1,
          live: true,
          ready: !healthDegraded,
          status: healthDegraded ? "degraded" : "healthy",
          componentRefs: ["sqlite", "worker", "identity"],
          components: [
            { componentRef: "sqlite", status: "healthy", reasonCode: null },
            {
              componentRef: "worker",
              status: healthDegraded ? "degraded" : "healthy",
              reasonCode: healthDegraded ? "WORKER_RECOVERING" : null,
            },
            { componentRef: "identity", status: "healthy", reasonCode: null },
          ],
          operationCheckpoints: [
            {
              operationRef: "upgrade-fixture-01",
              kind: "upgrade",
              phase: "readback",
              revision: 4,
              status: "completed",
              readbackRef: "evidence:upgrade-fixture-01",
            },
          ],
          generatedAt: now,
        },
      });
      return;
    }
    const [category, itemRefs] = collectionCategory(message.type) ?? ["threads", []];
    json(response, 200, {
      ...envelope("snapshot", "collection.snapshot"),
      payload: {
        category,
        itemRefs,
        nextCursor: null,
        snapshotRef: `snapshot:${category}`,
        generatedAt: now,
      },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gateway/thread/v3/queries") {
    const message = await body(request);
    const snapshot = handleThreadQuery(message);
    if (!snapshot) {
      json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
      return;
    }
    json(response, 200, snapshot);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gateway/thread/v3/commands") {
    const message = await body(request);
    json(response, 200, handleThreadCommand(message));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/payload/v1/text") {
    const message = await body(request);
    const digest = createHash("sha256").update(message.content).digest("hex").slice(0, 24);
    const payloadRef = `payload:${digest}`;
    payloads.set(payloadRef, {
      content: message.content,
      dataClassification: message.dataClassification,
    });
    json(response, 201, { payloadRef });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/payload/v1/text/read") {
    const message = await body(request);
    const payload = payloads.get(message.payloadRef);
    if (!payload) {
      json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
      return;
    }
    json(response, 200, { ...payload, contentType: "text/plain" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/thread-search/v1/prepare") {
    const message = await body(request);
    const digest = createHash("sha256").update(message.query).digest("hex").slice(0, 24);
    const queryRef = `payload:search:${digest}`;
    payloads.set(queryRef, { content: message.query, dataClassification: "private" });
    json(response, 200, {
      queryRef,
      tokenRefs: [`search-token:${digest}`],
      projectionVersion: "thread-search-fixture-v1",
    });
    return;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/api/gateway/v2/commands" || url.pathname === "/api/gateway/v1/commands")
  ) {
    const message = await body(request);
    if (url.pathname === "/api/gateway/v2/commands") {
      const governance = handleGovernanceCommand(message);
      if (governance) {
        json(response, governance.status, governance.body);
        return;
      }
      const operation = handleOperationsCommand(message);
      if (operation) {
        json(response, operation.status, operation.body);
        return;
      }
    }
    const replayed = accepted.has(message.idempotencyKey);
    accepted.add(message.idempotencyKey);
    json(response, 200, { resultRef: `accepted:${message.type}`, replayed });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/gateway/v2/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    const eventTimer = setTimeout(() => {
      cursorSequence += 1;
      const event = {
        ...envelope("event", "stream.event"),
        messageId: `event:${cursorSequence}`,
        payload: {
          cursor: `cursor-${cursorSequence}`,
          retentionStartCursor: "cursor-01",
          eventId: `event-${cursorSequence}`,
          scopeKind: "run",
          scopeId: "run-01",
          sequence: cursorSequence,
          occurredAt: now,
          eventType: "run.completed",
          payloadRef: null,
        },
      };
      response.write(
        `id: cursor-${cursorSequence}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }, 100);
    request.on("close", () => {
      clearInterval(timer);
      clearTimeout(eventTimer);
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/gateway/thread/v3/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let afterCursor = null;
    try {
      const subscription = JSON.parse(
        Buffer.from(url.searchParams.get("subscription") ?? "", "base64url").toString("utf8"),
      );
      afterCursor = subscription.payload.afterCursor;
    } catch {
      json(response, 400, { error: { code: "HTTP_GATEWAY_REQUEST_INVALID" } });
      return;
    }
    const afterSequence = afterCursor ? Number(afterCursor.split(":").at(-1)) : 0;
    for (const event of threadEvents) {
      if (Number(event.payload.cursor.split(":").at(-1)) <= afterSequence) continue;
      response.write(
        `id: ${event.payload.cursor}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    threadEventClients.add(response);
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    request.on("close", () => {
      clearInterval(timer);
      threadEventClients.delete(response);
    });
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const target = path.resolve(staticRoot, relative);
  if (
    !target.startsWith(`${staticRoot}${path.sep}`) &&
    target !== path.join(staticRoot, "index.html")
  ) {
    response.writeHead(404).end();
    return;
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    const fallback = await readFile(path.join(staticRoot, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fallback);
    return;
  }
  response.writeHead(200, { "content-type": contentType(target) });
  createReadStream(target).pipe(response);
}

const server = createServer((request, response) => {
  request.on("error", () => undefined);
  void handleRequest(request, response).catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (request.aborted || code === "ECONNRESET" || code === "ABORT_ERR") {
      if (!response.destroyed) response.destroy();
      return;
    }
    process.stderr.write(
      `CONTROL_CENTER_FIXTURE_REQUEST_FAILED:${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (!response.headersSent) json(response, 500, { error: { code: "FIXTURE_REQUEST_FAILED" } });
    else if (!response.destroyed) response.destroy();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`CONTROL_CENTER_FIXTURE_READY http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
