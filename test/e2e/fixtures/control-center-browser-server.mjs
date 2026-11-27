import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staticRoot = path.resolve(
  process.env.HIMAWARI_BROWSER_STATIC_ROOT ?? path.join(repositoryRoot, "apps/control-center/dist"),
);
await readFile(path.join(staticRoot, "index.html"));
const port = Number(process.env.HIMAWARI_BROWSER_FIXTURE_PORT ?? "4173");
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("CONTROL_CENTER_PORT_INVALID");
const now = "2026-08-27T00:00:00.000Z";
const executionQualification = process.env.HIMAWARI_EXECUTION_FIXTURE === "1";
const memoryFixture = process.env.HIMAWARI_MEMORY_FIXTURE === "1";
const reviewFixture = memoryFixture && process.env.HIMAWARI_MEMORY_REVIEW_FIXTURE === "1";
const reviewFixtureState = { undone: false, commands: [] };
const pinnedCharacters = Number(process.env.HIMAWARI_PROFILE_PINNED_CHARACTERS ?? "0");
const executionRecords = new Map();
const executionStates = new Map();
let executionEnvironment;
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
  ["payload:title-main", { content: "计划讨论", dataClassification: "private" }],
  ["payload:title-research", { content: "研究记录", dataClassification: "private" }],
  ["payload:message-01", { content: "请总结当前计划。", dataClassification: "private" }],
  ["payload:message-02", { content: "计划处于实施阶段。", dataClassification: "private" }],
  [
    "payload:message-research-01",
    { content: "整理一下这周读过的资料。", dataClassification: "private" },
  ],
]);
const threadEvents = [];
const threadEventClients = new Set();
const executionEventClients = new Map();
const threads = new Map([
  [
    "thread-home",
    {
      threadId: "thread-home",
      revision: 1,
      status: "active",
      titleRef: null,
      titleSource: null,
      titleRevision: 0,
      pinOrder: null,
      answerLocale: "zh-CN",
      messageWatermark: 0,
      sourceThreadId: null,
      sourceWatermark: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
      runs: [],
    },
  ],
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
      sourceThreadId: null,
      sourceWatermark: null,
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
          options: null,
          chosenFrom: null,
          spoken: false,
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
          options: null,
          chosenFrom: null,
          spoken: false,
        },
      ],
      runs: [
        {
          runId: "run-01",
          revision: 2,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          background: null,
          backgroundCommands: [],
        },
      ],
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
      messageWatermark: 1,
      sourceThreadId: null,
      sourceWatermark: null,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          messageId: "message-research-01",
          sequence: 1,
          role: "owner",
          contentRef: "payload:message-research-01",
          dataClassification: "private",
          status: "committed",
          turnId: "turn-research-01",
          runId: null,
          committedAt: now,
          options: null,
          chosenFrom: null,
          spoken: false,
        },
      ],
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
let unansweredDetailReads = 0;
let stalledReads = 0;
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
      display: null,
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
    lastInvalidation: null,
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
      label: "Approve and publish the article once",
      detail: {
        "zh-CN": ["范围 1 项", "收件对象 1 个", "已用 0/1 次", "会影响 1 个任务"],
        en: ["1 scope item", "1 recipient", "Used 0 of 1", "Affects 1 task"],
        ja: ["範囲 1 件", "宛先 1 件", "0/1 回使用", "1 件のタスクに影響"],
      },
      generatedAt: now,
    },
  ],
]);
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
let cursorSequence = 1;
let healthDegraded = false;

function fixtureFiles() {
  return [
    ["snake.html", "web", "text/html", 18432, 1],
    ["东京天气汇总.md", "document", "text/markdown", 2048, 2],
    ["expenses-2026-10.csv", "data", "text/csv", 5120, 1],
    ["sunflower.png", "image", "image/png", 245760, 1],
  ].map(([name, kind, mediaType, sizeBytes, version], index) => ({
    id: `file:${index}`,
    threadId: "thread-main",
    runId: "run-01",
    toolCallId: `call:${index}`,
    toolItemId: `item:${index}`,
    source: "write",
    path: name,
    name,
    kind,
    mediaType,
    sizeBytes,
    version,
    turn: 1,
    commandKey: null,
    stored: true,
    overlapped: false,
    createdAt: now,
  }));
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

const sensitiveFixtureState = { commands: [], items: [] };
function sensitiveReset(mode) {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const item = (id, minutesAgo, fields) => ({
    id: id.padEnd(64, "0"),
    threadId: null,
    source: "chat",
    purpose: "chat",
    part: "owner_message",
    outcome: "masked",
    firstSeenAt: at(minutesAgo),
    lastSeenAt: at(Math.max(0, minutesAgo - 30)),
    seenCount: 1,
    ...fields,
  });
  sensitiveFixtureState.items =
    mode === "empty"
      ? []
      : [
          item("a1", 20, { threadId: "thread-main", category: "password", seenCount: 5 }),
          item("a2", 21, {
            threadId: "thread-main",
            source: "memory_capture",
            purpose: "memory-capture",
            part: "memory_candidate",
            category: "password",
            outcome: "not_saved",
          }),
          item("a3", 160, {
            threadId: "thread-main",
            part: "tool_result",
            category: "machine-secret",
            seenCount: 3,
          }),
          item("a4", 300, {
            source: "mail",
            purpose: "mail-judgment",
            part: "mail",
            category: "verification-code",
          }),
          item("b1", 2 * 1440 + 30, {
            threadId: "thread-gone",
            category: "bank-card",
            seenCount: 7,
          }),
        ];
}
sensitiveReset("demo");
function sensitiveSnapshot() {
  const count = (outcome) =>
    sensitiveFixtureState.items.filter((entry) => entry.outcome === outcome).length;
  return {
    counts: { masked: count("masked"), withheld: count("withheld"), notSaved: count("not_saved") },
    items: [...sensitiveFixtureState.items].sort((left, right) =>
      right.firstSeenAt.localeCompare(left.firstSeenAt),
    ),
    next: null,
    generatedAt: new Date().toISOString(),
  };
}
const externalFixtureState = { items: [], batches: [], decided: new Map(), commands: [] };
function externalProposal(index, change = {}) {
  return {
    proposalId: `proposal-${index}`,
    text: `外部提议的记忆 ${index}`,
    category: "preference",
    dataClassification: "private",
    client: "Muse",
    receivedAt: "2026-08-26T23:40:00.000Z",
    ...change,
  };
}
function externalReset(mode) {
  externalFixtureState.batches = [];
  externalFixtureState.decided = new Map();
  externalFixtureState.commands = [];
  externalFixtureState.total = null;
  externalFixtureState.items =
    mode === "pending"
      ? [
          externalProposal(1, { text: "主人周末喜欢去镰仓" }),
          externalProposal(2, {
            text: "主人对花粉过敏",
            category: "health",
            dataClassification: "sensitive",
            client: "Claude Code",
          }),
          externalProposal(3, { text: "主人在学法语" }),
        ]
      : mode === "many"
        ? Array.from({ length: 100 }, (_, index) => externalProposal(index + 1))
        : [];
  if (mode === "many") externalFixtureState.total = 130;
}
function externalSnapshot() {
  return {
    total: externalFixtureState.total ?? externalFixtureState.items.length,
    items: externalFixtureState.items,
    batches: externalFixtureState.batches.map(({ batchId, decidedAt, committed, rejected }) => ({
      batchId,
      decidedAt,
      committed,
      rejected,
    })),
  };
}
const MCP_ZERO_USAGE = {
  reads: 0,
  readsByTool: [
    { tool: "start_here", calls: 0 },
    { tool: "find_memories", calls: 0 },
  ],
  delivered: 0,
  empty: 0,
  autoReads: 0,
  autoDelivered: 0,
  modelReads: 0,
  memoryPushes: 0,
  ruleProposals: 0,
  ruleProposalsRateLimited: 0,
  failed: 0,
  rateLimited: 0,
};
const mcpFixtureState = { connections: [] };
function mcpReset(mode) {
  mcpFixtureState.connections =
    mode === "one"
      ? [
          {
            id: "conn-fixture-existing",
            name: "Codex 笔记本",
            capabilities: ["mcp"],
            readCeiling: "private",
            pushPolicy: "ask",
            status: "active",
            reportedClient: "codex",
            createdAt: "2026-08-24T01:00:00.000Z",
            updatedAt: "2026-08-24T01:00:00.000Z",
            registration: "dynamic",
            clientHost: null,
            lastSeenAt: "2026-08-30T01:00:00.000Z",
            minute: { reads: 2, hookReads: 5 },
            usage: {
              ...MCP_ZERO_USAGE,
              reads: 8,
              readsByTool: [
                { tool: "start_here", calls: 2 },
                { tool: "find_memories", calls: 6 },
              ],
              delivered: 4,
              empty: 3,
              autoReads: 5,
              autoDelivered: 2,
              modelReads: 3,
              memoryPushes: 3,
              ruleProposals: 4,
              ruleProposalsRateLimited: 2,
              failed: 1,
              rateLimited: 3,
            },
          },
        ]
      : [];
}
function mcpSnapshot() {
  const live = mcpFixtureState.connections.filter(({ status }) => status !== "revoked");
  const minutes = mcpFixtureState.connections.map(({ minute }) => minute);
  return {
    connections: mcpFixtureState.connections,
    window: { fromDay: "2026-08-24", toDay: "2026-08-30", days: 7 },
    limits: [
      { key: "mcp.connections", value: 200, used: live.length },
      {
        key: "mcp.connection.name_characters",
        value: 64,
        used: Math.max(0, ...live.map(({ name }) => [...name].length)),
      },
      { key: "mcp.request.body_bytes", value: 65536, used: null },
      {
        key: "mcp.reads_per_minute",
        value: 30,
        used: Math.max(0, ...minutes.map(({ reads }) => reads)),
      },
      {
        key: "mcp.hook_reads_per_minute",
        value: 60,
        used: Math.max(0, ...minutes.map(({ hookReads }) => hookReads)),
      },
    ],
    generatedAt: now,
  };
}
function handleExternalCommand(message) {
  if (!["memory.external.respond", "memory.external.undo"].includes(message.type)) return null;
  externalFixtureState.commands.push({ type: message.type, payload: message.payload });
  if (message.type === "memory.external.undo") {
    const batch = externalFixtureState.batches.find(
      ({ batchId }) => batchId === message.payload.batchId,
    );
    if (!batch) return { status: 404, body: { error: { code: "PORT_NOT_FOUND" } } };
    externalFixtureState.batches = externalFixtureState.batches.filter((entry) => entry !== batch);
    externalFixtureState.items = [...batch.members, ...externalFixtureState.items];
    return { status: 200, body: { resultRef: batch.batchId, replayed: false } };
  }
  const batchId = `batch-${externalFixtureState.commands.length}`;
  const members = [];
  let committed = 0;
  let rejected = 0;
  for (const { proposalId, decision, editedText } of message.payload.items) {
    const item = externalFixtureState.items.find((entry) => entry.proposalId === proposalId);
    if (!item || item.text.includes("别处")) continue;
    externalFixtureState.items = externalFixtureState.items.filter((entry) => entry !== item);
    members.push(item);
    externalFixtureState.decided.set(proposalId, { decision, editedText });
    if (decision === "keep") committed += 1;
    else rejected += 1;
  }
  if (members.length === 0) return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
  externalFixtureState.batches.unshift({
    batchId,
    decidedAt: "2026-08-27T00:10:00.000Z",
    committed,
    rejected,
    members,
  });
  return { status: 200, body: { resultRef: batchId, replayed: false } };
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

function writeExecutionChanged(threadId, run) {
  const clients = executionEventClients.get(threadId);
  if (!clients?.size) return;
  cursorSequence += 1;
  const event = {
    ...threadEnvelope("event", "thread.execution_changed"),
    messageId: `execution:thread:${cursorSequence}`,
    payload: {
      threadId,
      runId: run.runId,
      runRevision: run.revision,
      traceSequence: (executionRecords.get(run.runId) ?? []).at(-1)?.sequence ?? 0,
      resourceRevision: null,
      observedAt: now,
    },
  };
  const wire = `event: thread.execution_changed\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(wire);
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
    "approval.list": ["approvals", ["approval-01"]],
  }[type];
}

function memoryOverview() {
  const item = (memoryId, text, category, change = {}) => ({
    memoryId,
    revision: 1,
    text,
    dataClassification: "private",
    topic: null,
    inference: false,
    sourceThreadId: "thread-main",
    sourceMessageId: "message-01",
    sourceRefs: [],
    updatedAt: "2026-10-28T10:21:00.000Z",
    supersededBy: null,
    validTo: null,
    tentative: false,
    category,
    subCategory: null,
    status: "active",
    recordedAt: "2026-10-28T10:21:00.000Z",
    lastUsedAt: "2026-10-28T10:40:00.000Z",
    importBatchId: null,
    importance: 700,
    profilePin: null,
    stance: null,
    history: [],
    ...change,
  });
  const memories = [
    item("memory-fish", "主人从 2026 年 10 月 28 日起喜欢吃鱼了", "preference", {
      subCategory: "饮食",
    }),
    item("memory-fish-v2", "主人不太喜欢吃鱼", "preference", {
      supersededBy: "memory-fish",
      recordedAt: "2026-10-12T08:03:00.000Z",
    }),
    item("memory-fish-v1", "主人喜欢吃寿司", "preference", {
      supersededBy: "memory-fish",
      recordedAt: "2025-03-02T01:00:00.000Z",
      importBatchId: "import-1",
    }),
    item("memory-blue", "主人最喜欢的颜色是蓝色", "preference", { profilePin: "on" }),
    item("memory-coffee", "主人喝咖啡不加糖", "preference", {
      subCategory: "饮食",
      importance: 450,
      recordedAt: "2026-10-28T12:30:00.000Z",
    }),
    item("memory-pill", "主人每天早上吃降压药", "health", {
      dataClassification: "sensitive",
      topic: "health",
      importance: 800,
    }),
    item("memory-trip", "主人 11 月 3 日去大阪出差", "event", { importance: 500 }),
    item("memory-short", "回答要先给结论", "preference"),
    item("memory-jst", "时间一律用日本时间", "preference"),
    item("memory-city", "主人住在东京都北区", "identity"),
    item("memory-job", "主人正在应聘 AI 应用工程师", "identity"),
    item("memory-lost-source", "主人以前在大阪住过", "identity", {
      sourceMessageId: null,
      sourceRefs: ["payload:gone"],
    }),
    item("memory-peikun", "陪坤是主人的前同事", "relationship"),
    item("memory-lilei", "李雷是主人的前同事", "relationship"),
    ...(reviewFixture
      ? [
          item("memory-review-german", "主人在学德语", "goal", {
            status: reviewFixtureState.undone ? "archived" : "active",
            revision: reviewFixtureState.undone ? 2 : 1,
            recordedAt: "2026-10-29T01:00:00.000Z",
            history: [
              {
                historyId: 1,
                kind: "created",
                text: "主人在学德语",
                stance: null,
                quote: "我最近每天晚上学一小时德语",
                sourceThreadId: "thread-main",
                sourceDeleted: false,
                at: "2026-10-29T01:00:00.000Z",
              },
            ],
          }),
        ]
      : []),
  ];
  const lines = (ids) =>
    ids.map((memoryId) => {
      const found = memories.find((entry) => entry.memoryId === memoryId);
      return { memoryId, text: found.text, updatedAt: found.updatedAt };
    });
  return {
    memories,
    tidyUps: [],
    conversationReviews: reviewFixture
      ? [
          {
            reviewId: "memory-review:episode-1",
            finishedAt: "2026-10-29T01:00:00.000Z",
            undone: reviewFixtureState.undone,
            undoable: true,
            changes: [{ memoryId: "memory-review-german", action: "created" }],
          },
        ]
      : [],
    reminders: [],
    upcoming: [
      {
        reminderId: "reminder-report",
        memoryId: "memory-job",
        text: "交面试作业",
        dueAt: "2026-10-31T01:00:00.000Z",
        repeat: "none",
        sourceThreadId: "thread-main",
      },
    ],
    cancelled: [
      {
        reminderId: "reminder-call",
        text: "给妈妈打电话",
        dueAt: "2026-11-02T01:00:00.000Z",
        repeat: "none",
      },
    ],
    people: [
      {
        personId: "person-peikun",
        name: "陪坤",
        aliases: [],
        relation: "前同事",
        reverseRelation: null,
        links: [],
        memoryIds: ["memory-peikun"],
      },
      {
        personId: "person-lilei",
        name: "李雷",
        aliases: [],
        relation: "前同事",
        reverseRelation: null,
        links: [],
        memoryIds: ["memory-lilei"],
      },
      {
        personId: "person-mina",
        name: "Mina",
        aliases: [],
        relation: "大学同学",
        reverseRelation: null,
        links: [],
        memoryIds: [],
      },
    ],
    personSuggestions: [],
    imports: [],
    capturePaused: false,
    manualAddReady: true,
    lastViewedAt: "2026-10-28T12:00:00.000Z",
    profileUsage: {
      used: Math.max(118, pinnedCharacters),
      limit: 2000,
      pinned: pinnedCharacters,
      queued: ["memory-coffee"],
    },
    profile: [
      { kind: "identity", lines: lines(["memory-city", "memory-job"]) },
      {
        kind: "preference",
        lines: lines(["memory-fish", "memory-blue", "memory-short", "memory-jst"]),
      },
      { kind: "relationship", lines: lines(["memory-peikun", "memory-lilei"]) },
    ],
    externalProposals: externalSnapshot(),
    mcpSync: { entriesTotal: 0, entries: [], projects: [], attention: [] },
    pending: [],
    generatedAt: now,
  };
}

function weeklySnapshot(withMails = false) {
  const startDay = "2026-08-19";
  const day = (offset) =>
    new Date(Date.parse(`${startDay}T00:00:00.000Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const checks = (offset) => [
    {
      code: "service_running",
      status: "pass",
      reason: "all_hours",
      facts: { missingHours: 0, longestGapHours: 0 },
    },
    {
      code: "proactive_writing",
      status: "pass",
      reason: "on_time",
      facts: { rows: 96, longestGapMinutes: 15 + (offset % 2), limitMinutes: 40 },
    },
    { code: "memory_capture", status: "pass", reason: "running", facts: {} },
    {
      code: "consolidation_recorded",
      status: "pass",
      reason: "rows_match",
      facts: { changes: 3, rows: 3 },
    },
    {
      code: "rows_kept",
      status: "pass",
      reason: "nothing_missing",
      facts: { checkedDays: offset },
    },
    { code: "time_format", status: "pass", reason: "well_formed", facts: {} },
  ];
  const rate = (successes, samples) => {
    if (samples < 5)
      return { successes, samples, enough: false, value: null, low: null, high: null };
    const z = 1.96;
    const p = successes / samples;
    const d = 1 + (z * z) / samples;
    const c = (p + (z * z) / (2 * samples)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples))) / d;
    return {
      successes,
      samples,
      enough: true,
      value: p,
      low: Math.max(0, c - h),
      high: Math.min(1, c + h),
    };
  };
  const group = (name, total, useful, second, applicable) => {
    const rated = useful + second;
    const counts = {
      useful: 0,
      unneeded: 0,
      missed: 0,
      [applicable[0]]: useful,
      [applicable[1]]: second,
    };
    return {
      group: name,
      total,
      rated,
      useful: counts.useful,
      unneeded: counts.unneeded,
      missed: counts.missed,
      applicable,
      rates: {
        useful: rate(counts.useful, rated),
        unneeded: applicable.includes("unneeded") ? rate(counts.unneeded, rated) : null,
        missed: applicable.includes("missed") ? rate(counts.missed, rated) : null,
      },
    };
  };
  return {
    serviceRevision: "41a6ce3",
    observation: {
      startDay,
      earliestStartDay: startDay,
      setAt: "2026-08-18T03:00:00.000Z",
      startRevision: "41a6ce3",
      firstReportDay: day(7),
      passStreak: 7,
      streakSince: startDay,
      accepted: true,
      days: Array.from({ length: 7 }, (_, offset) => ({
        day: day(offset),
        status: "pass",
        checkedAt: `${day(offset + 1)}T00:15:00.000Z`,
        serviceRevision: "41a6ce3",
        checks: checks(offset),
      })),
    },
    report: {
      start: "2026-08-18T15:00:00.000Z",
      end: "2026-08-25T15:00:00.000Z",
      startDay,
      endDay: day(7),
      complete: true,
      ratesWithheld: false,
      minimumSamples: 5,
      groups: [
        group("proactive_pushed", 12, 6, 2, ["useful", "unneeded"]),
        group("proactive_silent", 672, 5, 1, ["useful", "missed"]),
        group("memory_skipped", 86, 27, 4, ["useful", "missed"]),
        group("memory_kept", 23, 4, 0, ["useful", "unneeded"]),
        group("consolidation", 9, 6, 1, ["useful", "unneeded"]),
        group("memory_pending", 3, 2, 0, ["useful", "unneeded"]),
        group("context_truncation", 17, 0, 0, ["useful", "unneeded"]),
        group("retrieval_degrade", 1, 1, 0, ["useful", "unneeded"]),
      ],
      implicit: {
        pushedDecisions: 12,
        otherDecisionEvents: 1,
        signals: [
          {
            signal: "opened",
            decisions: 6,
            events: 7,
            medianDelayMs: 1_500_000,
            rate: rate(6, 12),
          },
          { signal: "undone", decisions: 1, events: 1, medianDelayMs: 90_000, rate: rate(1, 12) },
          {
            signal: "replied",
            decisions: 2,
            events: 2,
            medianDelayMs: 7_200_000,
            rate: rate(2, 12),
          },
        ],
      },
      prereview: {
        agreementPermille: 900,
        confidencePermille: 800,
        reductionEnabled: false,
        auditPermille: 200,
        minimumPairs: 35,
        otherVersions: withMails ? 2 : 0,
        groups: withMails
          ? [
              {
                group: "proactive_silent",
                prereviewed: 40,
                unsure: 6,
                paired: 30,
                agreement: rate(27, 30),
                kappa: 0.61,
                balancedAccuracy: 0.8,
                ownerUseful: rate(25, 30),
                hidden: rate(20, 22),
                confusion: [
                  { model: "useful", owner: "useful", count: 24 },
                  { model: "useful", owner: "missed", count: 2 },
                  { model: "missed", owner: "useful", count: 1 },
                  { model: "missed", owner: "missed", count: 3 },
                ],
                gate: { open: false, reason: "insufficient", requiredAgreement: 0.97 },
              },
            ]
          : [
              "proactive_pushed",
              "proactive_silent",
              "memory_skipped",
              "memory_kept",
              "consolidation",
            ].map((group) => ({
              group,
              prereviewed: 0,
              unsure: 0,
              paired: 0,
              agreement: null,
              kappa: null,
              balancedAccuracy: null,
              ownerUseful: null,
              hidden: null,
              confusion: [],
              gate: null,
            })),
      },
      mcpConnections: {
        fromDay: "2026-08-24",
        toDay: "2026-08-30",
        connections: mcpFixtureState.connections.map(({ id, name, status, lastSeenAt, usage }) => ({
          id,
          name,
          status,
          lastSeenAt,
          usage,
        })),
      },
      correction: withMails
        ? {
            handled: 12,
            agreed: 9,
            missed: 2,
            openMemories: 3,
            openRules: 1,
            agreement: {
              successes: 9,
              samples: 12,
              enough: true,
              value: 0.75,
              low: 0.4677,
              high: 0.9111,
            },
          }
        : null,
    },
    generatedAt: now,
  };
}

function unsetWeeklySnapshot() {
  const reported = weeklySnapshot();
  const tomorrow = new Date(Date.now() + 9 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  return {
    ...reported,
    observation: {
      ...reported.observation,
      startDay: null,
      earliestStartDay: tomorrow,
      setAt: null,
      startRevision: null,
      firstReportDay: null,
      passStreak: 0,
      streakSince: null,
      accepted: false,
      days: [],
    },
  };
}

function reviewSnapshot(prereviewHidden = 0) {
  const texts = [
    "我最近想吃牛肉，下周去大阪出差的时候想顺便找一家评价不错的烤肉店，最好是靠近车站的",
    "明天下午三点去银行办理住民税的缴纳手续",
    "来週の金曜日は娘の学校の面談があるので午後は予定を入れないでください",
    "牙医把预约改到了周四下午四点，请在前一天提醒我，并且别忘了带上上次的检查报告和医保卡",
  ];
  const kinds = [
    ["memory_candidate", "discarded", false],
    ["proactive", "pushed", true],
    ["mail", "skipped", false],
    ["proactive", "silent", false],
  ];
  const item = (index, folded) => {
    const [kind, outcome, acted] = folded
      ? ["consolidation", "merge", true]
      : kinds[index % kinds.length];
    return {
      key: `${kind === "mail" ? "mail" : "ledger"}:fixture-${folded ? "f" : "d"}-${index}`,
      source: kind === "mail" ? "mail" : "ledger",
      kind,
      outcome,
      decidedAt: "2026-08-26T23:30:00.000Z",
      acted,
      rating: null,
      text: kind === "proactive" ? "" : texts[index % texts.length],
      textHidden: false,
      category: null,
      fetched: kind === "proactive" ? 12 : null,
      checkup: null,
    };
  };
  const checkup = (index, reason, related) => ({
    key: `checkup:fixture-c-${index}`,
    source: "checkup",
    kind: "checkup",
    outcome: "pending",
    decidedAt: "2026-08-24T15:00:00.000Z",
    acted: false,
    rating: null,
    text: texts[index % texts.length],
    textHidden: false,
    category: null,
    fetched: null,
    checkup: {
      reason,
      action: null,
      memoryId: `memory:fixture-c-${index}`,
      relatedMemoryId: related ? `memory:fixture-c-${index}-old` : null,
      relatedText: related ? texts[(index + 1) % texts.length] : "",
      keptMemoryId: null,
    },
  });
  return {
    day: now,
    capacity: 24,
    sampled: 24,
    notSampled: 9,
    items: [
      item(0, false),
      checkup(0, "conflict", true),
      item(1, false),
      checkup(1, "unused", false),
      ...Array.from({ length: 20 }, (_, index) => item(index + 2, false)),
    ],
    folded: { total: 7, items: Array.from({ length: 7 }, (_, index) => item(index, true)) },
    memoryUnusedDays: 90,
    hiddenByModel: prereviewHidden,
    generatedAt: now,
  };
}

const decisionCounts = {
  fetched: 3,
  skipped: 0,
  judged: 3,
  act: 1,
  know: 1,
  check: 1,
  ignore: 0,
  floorRaised: 0,
  pushed: 1,
};
function decisionFixtureRows() {
  const row = (id, hour, verdict) => ({
    id,
    checkedAt: `2026-08-26T${hour}:00:00.000Z`,
    verdict,
    reasonCode: "FIXTURE",
    counts: decisionCounts,
    opened: false,
    rating: null,
  });
  return [
    row("decision-gmail-full", "09", "pushed"),
    row("decision-gmail-old", "08", "silent"),
    row("decision-gmail-gone", "07", "silent"),
  ];
}
function decisionChainFixture(decisionId) {
  const base = {
    decisionId,
    decision: {
      kind: "proactive",
      decidedAt: "2026-08-26T09:00:00.000Z",
      outcome: decisionId === "decision-gmail-full" ? "pushed" : "silent",
      reasonCode: "FIXTURE",
      rating: decisionId === "decision-gmail-full" ? "useful" : null,
      ratedAt: decisionId === "decision-gmail-full" ? "2026-08-26T09:30:00.000Z" : null,
    },
  };
  if (decisionId === "decision-gmail-old")
    return {
      ...base,
      inputs: "not_recorded",
      rules: { state: "not_recorded", items: [] },
      mails: { judged: null, related: null, relatedRead: "not_recorded", summaries: null },
      memories: {
        state: "not_recorded",
        recall: "not_recorded",
        total: 0,
        truncated: false,
        items: [],
      },
    };
  if (decisionId !== "decision-gmail-full") return null;
  const noSource = {
    threadId: null,
    messageId: null,
    quote: null,
    refs: [],
    importBatchId: null,
    firstSourceDeleted: false,
  };
  const memory = (memoryId, change) => ({
    memoryId,
    state: "visible",
    text: null,
    status: "active",
    inference: false,
    tentative: false,
    usedByModel: true,
    changedSinceDecision: false,
    supersededBy: null,
    source: noSource,
    basis: { nodes: [], complete: true },
    ...change,
  });
  return {
    ...base,
    inputs: "recorded",
    rules: {
      state: "recorded",
      items: [
        {
          ruleId: "floor_money_words",
          revision: 2,
          current: true,
          kind: "money_words",
          origin: "built_in",
          source: "ADR 0106 第 4 条；ADR 0209；ADR 0248",
          status: "active",
          changedAt: null,
          memory: null,
          wording: { values: [], quietHours: [], amount: null },
          tests: { state: "passed", total: 5, failedAt: null },
          mailCount: 2,
        },
        {
          ruleId: "floor_important_sender",
          revision: 2,
          current: false,
          kind: "important_sender",
          origin: "owner_setting",
          source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
          status: "needs_review",
          changedAt: "2026-11-02T01:00:00.000Z",
          memory: {
            memoryId: "memory-rule-bank",
            state: "visible",
            text: "银行来的信一律提醒我",
          },
          wording: { values: ["smbc.example"], quietHours: [], amount: null },
          tests: { state: "failed", total: 3, failedAt: 2 },
          mailCount: 1,
        },
        {
          ruleId: "quiet_hours",
          revision: 1,
          current: false,
          kind: "quiet_hours",
          origin: "owner_setting",
          source: "ADR 0106；主人的设置“静默时段”",
          status: "active",
          changedAt: "2026-11-01T01:00:00.000Z",
          memory: null,
          wording: {
            values: [],
            quietHours: [{ days: [1, 2, 3, 4, 5], start: "23:00", end: "07:00" }],
            amount: null,
          },
          tests: { state: "passed", total: 4, failedAt: null },
          mailCount: 0,
        },
      ],
    },
    mails: { judged: 3, related: 1, relatedRead: "ok", summaries: { count: 2, read: "ok" } },
    memories: {
      state: "recorded",
      recall: "ok",
      total: 3,
      truncated: false,
      items: [
        memory("memory-bank", {
          text: "主人的房租每月 27 日从三井住友扣款",
          source: {
            ...noSource,
            threadId: "thread-main",
            messageId: "message-01",
            quote: "房租每月 27 号扣",
          },
        }),
        memory("memory-ramen", {
          text: "主人常吃拉面",
          inference: true,
          basis: {
            nodes: [
              {
                memoryId: "memory-ramen",
                text: "主人常吃拉面",
                action: "merge",
                changedAt: "2026-08-20T00:00:00.000Z",
                basisMemoryIds: ["memory-friday"],
                repeated: false,
                truncated: false,
              },
              {
                memoryId: "memory-friday",
                text: "周五晚上吃了拉面",
                action: null,
                changedAt: null,
                basisMemoryIds: [],
                repeated: false,
                truncated: false,
              },
            ],
            complete: true,
          },
        }),
        memory("memory-medical", { state: "hidden", status: "active" }),
      ],
    },
  };
}

function decisionEmailFixture(messageId) {
  const known = {
    "mail-fixture-full": {
      decisionId: "decision-gmail-full",
      ruleIds: ["floor_money_words"],
      memoryIds: ["memory-bank"],
      relatedMessages: 1,
    },
    "mail-fixture-old": {
      decisionId: "decision-gmail-old",
      ruleIds: null,
      memoryIds: null,
      relatedMessages: null,
    },
  }[messageId];
  return {
    messageId,
    mail: known
      ? {
          threadId: "thread-main",
          outcome: "ignore",
          skipReason: null,
          processedAt: "2026-08-26T09:00:00.000Z",
          rating: "missed",
          decidedAt: "2026-08-26T09:00:00.000Z",
          ...known,
        }
      : null,
  };
}

function handleOperationsQuery(message, request) {
  switch (message.type) {
    case "memory.overview.read":
      return memoryFixture
        ? { ...envelope("snapshot", "memory.overview.snapshot"), payload: memoryOverview() }
        : undefined;
    case "mcp.connections.read":
      return memoryFixture
        ? { ...envelope("snapshot", "mcp.connections.snapshot"), payload: mcpSnapshot() }
        : undefined;
    case "sensitive.interceptions.read":
      return memoryFixture
        ? {
            ...envelope("snapshot", "sensitive.interceptions.snapshot"),
            payload: sensitiveSnapshot(),
          }
        : undefined;
    case "proactive.review.read":
      return memoryFixture
        ? {
            ...envelope("snapshot", "proactive.review.snapshot"),
            payload: reviewSnapshot(
              /(^|;\s*)himawari-fixture-prereview=on(;|$)/.test(request.headers.cookie ?? "")
                ? 3
                : 0,
            ),
          }
        : undefined;
    case "proactive.weekly.read":
      return memoryFixture
        ? {
            ...envelope("snapshot", "proactive.weekly.snapshot"),
            payload: /(^|;\s*)himawari-fixture-weekly=unset(;|$)/.test(request.headers.cookie ?? "")
              ? unsetWeeklySnapshot()
              : weeklySnapshot(
                  /(^|;\s*)himawari-fixture-mail=on(;|$)/.test(request.headers.cookie ?? ""),
                ),
          }
        : undefined;
    case "decision.email.read": {
      if (!memoryFixture) return undefined;
      const email = decisionEmailFixture(message.payload.messageId);
      return { ...envelope("snapshot", "decision.email.snapshot"), payload: email };
    }
    case "decision.chain.read": {
      if (!memoryFixture) return undefined;
      const chain = decisionChainFixture(message.payload.decisionId);
      return chain ? { ...envelope("snapshot", "decision.chain.snapshot"), payload: chain } : null;
    }
    case "proactive.overview.read":
      return memoryFixture
        ? {
            ...envelope("snapshot", "proactive.overview.snapshot"),
            payload: {
              source: "gmail",
              connection: /(^|;\s*)himawari-fixture-decisions=on(;|$)/.test(
                request.headers.cookie ?? "",
              )
                ? { status: "connected", account: "andy@example.com", connectedAt: now }
                : { status: "disconnected", account: null, connectedAt: null },
              enabled: true,
              quietHours: [],
              importantSenders: [],
              dailyLimitReached: false,
              insights: [],
              audit: { active: false, since: now, items: [], pending: 0 },
              decisions: /(^|;\s*)himawari-fixture-decisions=on(;|$)/.test(
                request.headers.cookie ?? "",
              )
                ? decisionFixtureRows()
                : [],
              metrics: { spoke: 12, hits: 7, misfires: 3, missed: 1, reviewed: 40 },
              generatedAt: now,
            },
          }
        : undefined;
    case "search.authorization.read":
      return memoryFixture
        ? {
            ...envelope("snapshot", "search.authorization.snapshot"),
            payload: {
              enabled: true,
              providersChanged: false,
              revision: 1,
              available: true,
              recipients: ["https://mcp.exa.ai"],
              generatedAt: now,
            },
          }
        : undefined;
    default:
      return undefined;
  }
}

function handleOperationsCommand(message) {
  if (message.type !== "memory.mutate") return null;
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
  if (message.type === "memory.mutate") target = memories.get(message.payload.memoryId);
  if (!target) return { status: 404, body: { error: { code: "PORT_NOT_FOUND" } } };
  const revision = target.sessionRevision ?? target.revision;
  if (message.payload.expectedRevision !== revision) {
    return { status: 409, body: { error: { code: "PORT_CONFLICT" } } };
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
          target.recentAuthenticationRequired &&
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
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
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
  if (message.type === "thread.main") {
    const main = threads.get("thread-home");
    if (!main) return null;
    return {
      ...common,
      type: "thread.main_snapshot",
      payload: {
        thread: threadSummary(main),
        snapshotRef: `snapshot:thread-main:${main.revision}`,
        generatedAt: now,
      },
    };
  }
  if (message.type === "thread.execution_environment" && executionEnvironment) {
    return {
      ...common,
      type: "thread.execution_environment_snapshot",
      payload: { environment: executionEnvironment, generatedAt: new Date().toISOString() },
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
  if (message.type === "thread.execution_state" && executionQualification) {
    const state = executionStates.get(message.payload.runId);
    if (!state) return null;
    return {
      ...common,
      type: "thread.execution_state_snapshot",
      payload: {
        threadId: thread.threadId,
        runId: message.payload.runId,
        state,
        generatedAt: new Date().toISOString(),
      },
    };
  }
  if (message.type === "thread.execution" && executionQualification) {
    const records = executionRecords.get(message.payload.runId) ?? [];
    return {
      ...common,
      type: "thread.execution_snapshot",
      payload: {
        threadId: thread.threadId,
        runId: message.payload.runId,
        records: records.filter((record) => record.sequence > message.payload.afterSequence),
        nextSequence: null,
        generatedAt: new Date().toISOString(),
      },
    };
  }
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
        sourceThreadId: thread.sourceThreadId,
        sourceTurnId: null,
        sourceWatermark: thread.sourceWatermark,
        summaryRefs: [],
        policyRefs: [],
        sourceContentAvailable: true,
        forkedAt: thread.sourceThreadId ? thread.createdAt : null,
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
          sourceThreadId: null,
          sourceWatermark: null,
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
        messageWatermark: 0,
        sourceThreadId: thread.threadId,
        sourceWatermark: message.payload.sourceWatermark,
        createdAt: now,
        updatedAt: now,
        messages: [],
        runs: [],
      });
      break;
    case "thread.message.submit_configured":
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
        options: null,
        chosenFrom: null,
        spoken: false,
      });
      thread.runs.push({
        runId: message.payload.runId,
        revision: 1,
        status: "accepted",
        createdAt: message.payload.occurredAt,
        updatedAt: message.payload.occurredAt,
        background: null,
        backgroundCommands: [],
      });
      break;
    case "thread.run.cancel": {
      const run = thread.runs.find((item) => item.runId === message.payload.runId);
      if (run) {
        run.status = "cancelled";
        run.revision += 1;
        run.updatedAt = new Date().toISOString();
      }
      break;
    }
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
      sessionId: "session-01",
      csrfToken: "csrf-fixture",
      ...(executionQualification
        ? {
            executionPresentationAvailable: true,
            executionStateAvailable: executionStates.size > 0,
            executionEventsAvailable: true,
            executionEnvironmentAvailable: executionEnvironment !== undefined,
            canCancelRun: true,
            availableModels: [
              {
                ref: "model:fixture-primary:v1",
                model: "fixture-primary",
                name: "受控测试模型 A",
                provider: "fixture",
                thinkingLevels: ["off", "low", "high"],
              },
              {
                ref: "model:fixture-secondary:v1",
                model: "fixture-secondary",
                name: "受控测试模型 B",
                provider: "fixture",
                thinkingLevels: ["off", "medium"],
              },
            ],
          }
        : {}),
      healthDependenciesAvailable: true,
      installedGatewayV2Operations: [
        "approval.list",
        "approval.detail",
        "approval.respond",
        "capability.list",
        "capability.detail",
        "capability.review",
        "capability.install.approve",
        "capability.update.respond",
        "capability.disable",
        "capability.rollback",
        "grant.list",
        "grant.detail",
        "grant.revoke",
        "github.monitor.set_state",
        "memory.mutate",
        ...(memoryFixture
          ? [
              "memory.overview.read",
              "memory.external.respond",
              "memory.external.undo",
              "search.authorization.read",
              "search.authorization.set",
              "proactive.overview.read",
              "sensitive.interceptions.read",
              "sensitive.interceptions.clear",
              "proactive.review.read",
              "proactive.review.rate",
              "proactive.review.checkup",
              "proactive.weekly.read",
              "decision.chain.read",
              "decision.email.read",
              "mcp.connections.read",
            ]
          : []),
      ],
      authorizationRef: governanceAuthorizationRef,
      recentAuthenticationRef: recentAuthenticationAvailable ? governanceAuthorizationRef : null,
      primaryModel: { provider: "fixture-provider", model: "fixture-primary", version: "v1" },
      primaryModelRef: "model:fixture-primary:v1",
      filesAvailable: memoryFixture,
      repositoryAllowlistRefs: ["fixture-owner/fixture-repository"],
      disclosedDataClassifications: ["private"],
    });
    return;
  }
  if (memoryFixture && url.pathname === "/__fixture/sensitive") {
    if (request.method === "POST") {
      const { mode } = await body(request);
      if (mode !== undefined) sensitiveReset(mode);
    }
    json(response, 200, sensitiveFixtureState);
    return;
  }
  if (memoryFixture && url.pathname === "/__fixture/external") {
    if (request.method === "POST") {
      const { mode, items } = await body(request);
      if (mode !== undefined) externalReset(mode);
      if (items !== undefined) externalFixtureState.items = items;
    }
    json(response, 200, {
      ...externalSnapshot(),
      decided: Object.fromEntries(externalFixtureState.decided),
      commands: externalFixtureState.commands,
    });
    return;
  }
  if (memoryFixture && url.pathname === "/__fixture/mcp") {
    if (request.method === "POST") {
      const { mode } = await body(request);
      if (mode !== undefined) mcpReset(mode);
    }
    json(response, 200, { connections: mcpFixtureState.connections });
    return;
  }
  if (executionQualification && url.pathname === "/__fixture/run-approvals") {
    if (request.method === "GET") {
      json(response, 200, {
        approvals: [...approvals.values()].map(({ approvalRequestId, status, intent }) => ({
          approvalRequestId,
          status,
          runId: intent.runId,
        })),
        stalledReads,
      });
      return;
    }
    const input = await body(request);
    for (const [approvalRequestId, approval] of approvals)
      if (approval.intent.runId === input.runId) approvals.delete(approvalRequestId);
    for (const approvalRequestId of input.approvalRequestIds)
      approvals.set(approvalRequestId, {
        approvalRequestId,
        revision: 1,
        status: "pending",
        deliveryState: "deliverable",
        semanticSnapshotHash: `sha256:${approvalRequestId}`,
        finalRisk: "low",
        recentAuthenticationRequired: false,
        recentAuthenticationRef: null,
        requestedAt: input.requestedAt ?? now,
        expiresAt: "2026-08-28T00:00:00.000Z",
        decidedAt: null,
        grantId: null,
        display: null,
        intent: {
          ...approvalIntent,
          intentId: `intent:${approvalRequestId}`,
          threadId: input.threadId,
          runId: input.runId,
          capabilityRef: "capability-web-search",
          operation: input.operation,
          disclosure: "named_recipients",
          recipientRefs: ["https://mcp.exa.ai"],
          sideEffect: "none",
          reversible: true,
          deterministicFactCodes: [],
          idempotencyKey: `intent:${approvalRequestId}`,
        },
        trueResultRef: null,
        generatedAt: now,
      });
    json(response, 200, { accepted: true });
    return;
  }
  if (executionQualification && url.pathname === "/__fixture/stall-detail-reads") {
    unansweredDetailReads = (await body(request)).count;
    json(response, 200, { accepted: true });
    return;
  }
  if (executionQualification && url.pathname === "/__fixture/execution-changed") {
    const input = await body(request);
    const thread = threads.get(input.threadId);
    const run = thread?.runs.find((item) => item.runId === input.runId);
    if (!run) {
      json(response, 404, {});
      return;
    }
    writeExecutionChanged(thread.threadId, run);
    json(response, 200, { accepted: true });
    return;
  }
  if (
    executionQualification &&
    request.method === "GET" &&
    url.pathname === "/api/gateway/thread/v3/execution-events"
  ) {
    let threadId;
    try {
      const subscription = JSON.parse(
        Buffer.from(url.searchParams.get("subscription") ?? "", "base64url").toString("utf8"),
      );
      if (subscription.type !== "thread.execution_events") throw new Error("type");
      threadId = subscription.payload.threadId;
    } catch {
      json(response, 400, { error: { code: "HTTP_GATEWAY_REQUEST_INVALID" } });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const clients = executionEventClients.get(threadId) ?? new Set();
    clients.add(response);
    executionEventClients.set(threadId, clients);
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    request.on("close", () => {
      clearInterval(timer);
      clients.delete(response);
    });
    return;
  }
  if (executionQualification && url.pathname === "/__fixture/execution") {
    if (request.method === "GET") {
      json(response, 200, {
        threads: [...threads.values()],
        commands: [...acceptedThreadCommands.values()],
        records: Object.fromEntries(executionRecords),
      });
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if ("environment" in input) executionEnvironment = input.environment ?? undefined;
    const thread = threads.get(input.threadId);
    const run = thread?.runs.find((item) => item.runId === input.runId);
    if (!run) {
      json(response, 404, {});
      return;
    }
    if (input.reset) {
      executionRecords.delete(run.runId);
      executionStates.delete(run.runId);
    }
    if (typeof input.title === "string") {
      const ref = `payload:fixture-title:${thread.threadId}:${thread.titleRevision + 1}`;
      payloads.set(ref, { content: input.title, dataClassification: "private" });
      thread.titleRef = ref;
      thread.titleSource = "automatic";
      thread.titleRevision += 1;
      thread.revision += 1;
      writeThreadEvent({ messageId: "fixture-title" }, thread.threadId, "thread.rename");
    }
    if (input.records)
      executionRecords.set(run.runId, [
        ...(executionRecords.get(run.runId) ?? []),
        ...input.records,
      ]);
    if (input.status) {
      run.status = input.status;
      run.revision += 1;
      run.updatedAt = input.occurredAt ?? new Date().toISOString();
    }
    if (input.state) executionStates.set(run.runId, { ...input.state, runRevision: run.revision });
    if (input.answer) {
      thread.messageWatermark += 1;
      const ref = `payload:fixture-answer:${run.runId}:${thread.messageWatermark}`;
      payloads.set(ref, { content: input.answer, dataClassification: "private" });
      const ownerMessage = thread.messages.find((item) => item.runId === run.runId);
      thread.revision += 1;
      thread.messages.push({
        messageId: `answer:${run.runId}:${thread.messageWatermark}`,
        sequence: thread.messageWatermark,
        role: "agent",
        contentRef: ref,
        dataClassification: "private",
        status: "committed",
        turnId: ownerMessage.turnId,
        runId: run.runId,
        committedAt: run.updatedAt,
        options: null,
        chosenFrom: null,
        spoken: false,
      });
    }
    if (!input.silent)
      writeThreadEvent(
        { messageId: "fixture-execution" },
        thread.threadId,
        "thread.execution.updated",
      );
    writeExecutionChanged(thread.threadId, run);
    if (input.replay) {
      const event = threadEvents.at(-1);
      for (const client of threadEventClients) client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (input.disconnect) {
      for (const client of threadEventClients) {
        threadEventClients.delete(client);
        client.end();
      }
    }
    json(response, 200, { accepted: true });
    return;
  }
  if (memoryFixture && request.method === "POST" && url.pathname === "/api/files/v1/list") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const items = fixtureFiles().filter(
      (file) =>
        (!input.kind || file.kind === input.kind) &&
        (!input.search || file.name.toLowerCase().includes(input.search.toLowerCase())),
    );
    json(response, 200, { items, nextCursor: null });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/degrade") {
    healthDegraded = true;
    json(response, 200, { degraded: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health/v1/dependencies") {
    json(response, 200, {
      id: "health-fixture",
      live: true,
      ready: true,
      status: healthDegraded ? "degraded" : "healthy",
      dependencies: [
        {
          name: "model-provider",
          required: false,
          status: healthDegraded ? "degraded" : "healthy",
          reasonCode: healthDegraded ? "PROVIDER_DEGRADED" : null,
        },
      ],
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/recent-auth") {
    const message = await body(request);
    recentAuthenticationAvailable = message.available === true;
    json(response, 200, { available: recentAuthenticationAvailable });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/finish-runs") {
    const message = await body(request);
    const thread = threads.get(message.threadId);
    if (!thread) {
      json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
      return;
    }
    for (const run of thread.runs)
      if (run.status === "accepted" || run.status === "running") {
        run.status = "completed";
        run.revision += 1;
        run.updatedAt = new Date().toISOString();
      }
    thread.revision += 1;
    json(response, 200, { threadId: thread.threadId, revision: thread.revision });
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
    const operation = handleOperationsQuery(message, request);
    if (operation !== undefined) {
      if (operation === null) {
        json(response, 404, { error: { code: "PORT_NOT_FOUND" } });
        return;
      }
      json(response, 200, operation);
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
    if (message.type === "thread.detail" && unansweredDetailReads > 0) {
      unansweredDetailReads -= 1;
      stalledReads += 1;
      return;
    }
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
  if (
    request.method === "POST" &&
    (url.pathname === "/api/payload/v1/text" || url.pathname === "/api/payload/v1/attachment")
  ) {
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
      if (memoryFixture && message.type === "sensitive.interceptions.clear") {
        sensitiveFixtureState.commands.push({ type: message.type, payload: message.payload });
        sensitiveFixtureState.items = [];
        json(response, 200, { resultRef: "sensitive-interceptions-cleared", replayed: false });
        return;
      }
      if (reviewFixture && message.type === "memory.conversationReview.undo") {
        reviewFixtureState.commands.push({ type: message.type, payload: message.payload });
        reviewFixtureState.undone = true;
        json(response, 200, { resultRef: "memory-review-undone", replayed: false });
        return;
      }
      const external = memoryFixture ? handleExternalCommand(message) : null;
      if (external) {
        json(response, external.status, external.body);
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
    response.write(": connected\n\n");
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
  process.stdout.write(`CONTROL_CENTER_FIXTURE_READY http://127.0.0.1:${server.address().port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
