import { DECISION_KINDS } from "@himawari-agent/application/decision-ledger";
import type { JsonSchema } from "./schema.js";

export const FORMAT_VERSION = "himawari.data-export.v3" as const;

const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] as const;
const SENSITIVE_TOPICS = [
  "health",
  "finance",
  "beliefs",
  "intimacy",
  "third_party",
  "location",
  "legal",
  "other",
] as const;
const RATINGS = ["useful", "unneeded", "missed"] as const;

const text = (minLength = 0, maxLength = 1_000_000): JsonSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const nullable = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  type: ["null", ...[schema.type ?? []].flat()],
  ...(schema.enum === undefined ? {} : { enum: [...schema.enum, null] }),
});
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({
  type: "integer",
  minimum,
  maximum,
});
const permille: JsonSchema = integer(0, 1000);
const enumOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: values });
const bool: JsonSchema = { type: "boolean" };
const timestamp: JsonSchema = { type: "string", minLength: 20, maxLength: 40 };
const objectOf = (
  properties: { readonly [key: string]: JsonSchema },
  optional: readonly string[] = [],
  description?: string,
): JsonSchema => ({
  type: "object",
  ...(description === undefined ? {} : { description }),
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});

export const EXPORTED_TEXT_SCHEMA: JsonSchema = objectOf(
  {
    text: text(),
    classification: enumOf(CLASSIFICATIONS),
    contentType: text(1, 512),
    withheld: { type: "boolean", const: true },
  },
  ["withheld"],
  "正文。withheld 为 true 时，text 是遮盖后的样子，原文在密封文件里（key 见清单说明）。",
);

const nullableText: JsonSchema = nullable(EXPORTED_TEXT_SCHEMA);

export const MEMORY_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 512),
    status: enumOf(["active", "archived", "trashed"]),
    revision: integer(0),
    classification: enumOf(CLASSIFICATIONS),
    inference: bool,
    confidencePermille: permille,
    policyVersion: text(1, 512),
    updatedAt: timestamp,
    recordedAt: nullable(timestamp),
    lastUsedAt: nullable(timestamp),
    category: enumOf(CATEGORIES),
    subCategory: nullable(text(1, 32)),
    importancePermille: permille,
    validFrom: nullable(text(1, 40)),
    validTo: nullable(text(1, 40)),
    supersededBy: nullable(text(1, 512)),
    useCount: integer(0),
    evidenceVerified: bool,
    sensitiveTopic: nullable(enumOf(SENSITIVE_TOPICS)),
    tentative: bool,
    stance: nullable(text(1, 16)),
    importBatchId: nullable(text(1, 512)),
    content: EXPORTED_TEXT_SCHEMA,
    history: {
      type: "array",
      items: objectOf({
        kind: enumOf(["created", "updated", "reaffirmed", "edited", "restored"]),
        content: EXPORTED_TEXT_SCHEMA,
        stance: nullable(text(1, 16)),
        quote: nullableText,
        sourceDeleted: bool,
        occurredAt: timestamp,
      }),
    },
    provenance: {
      type: "array",
      items: objectOf({
        sourceType: text(1, 512),
        sourceId: text(1, 512),
        sourceDeleted: bool,
      }),
    },
    entities: { type: "array", items: text(1, 64) },
    personIds: { type: "array", items: text(1, 512) },
    pin: nullable(objectOf({ pinned: bool, updatedAt: timestamp })),
  },
  [],
  "一条记忆，连同它的版本历史、来源、实体、人物提及和置顶状态。来源对话不导出（它在别处不存在）。",
);

export const PERSON_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 512),
    name: text(1, 64),
    relation: nullable(text(1, 32)),
    reverseRelation: nullable(text(1, 32)),
    mergedInto: nullable(text(1, 512)),
    createdAt: timestamp,
    updatedAt: timestamp,
    aliases: { type: "array", items: text(1, 64) },
  },
  [],
  "一个人物，带别名。",
);

export const IMPORT_BATCH_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 512),
    source: enumOf(["codex", "assistant", "himawari"]),
    itemCount: integer(1, 500),
    createdAt: timestamp,
    undoneAt: nullable(timestamp),
  },
  [],
  "一次从别处导入记忆的批次。",
);

export const PAIRED_DEVICE_SCHEMA: JsonSchema = objectOf(
  {
    id: { type: "string", pattern: "^dev_[A-Za-z0-9_-]{22}$" },
    kind: enumOf(["iphone", "watch", "mac"]),
    name: text(1, 256),
    releaseChannel: enumOf(["direct", "testflight", "app_store", "mac_direct"]),
    status: enumOf(["pending", "active", "revoked"]),
    pairedAt: timestamp,
    confirmedAt: nullable(timestamp),
    revokedAt: nullable(timestamp),
    lastSeenAt: nullable(timestamp),
  },
  [],
  "一台配对过的 iPhone、Apple Watch 或 Mac：名字、种类、状态。只供查看，导入时不恢复；公钥、配对码和请求随机值是凭据，不导出。",
);

export const EXTERNAL_PROPOSAL_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "health",
  "finance",
  "event",
  "other",
] as const;
export const EXTERNAL_PROPOSAL_STATUSES = [
  "pending",
  "committed",
  "rejected",
  "superseded",
] as const;

export const externalProposalTextKey = (id: string): string => `externalProposal/${id}/content`;
export const externalProposalDigestKey = (id: string): string =>
  `externalProposal/${id}/textSha256`;

export const EXTERNAL_PROPOSAL_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    subjectRef: text(1, 128),
    client: text(1, 64),
    sourceKey: nullable(text(1, 200)),
    textSha256: nullable({ type: "string", pattern: "^[0-9a-f]{64}$" }),
    normalization: text(1, 64),
    category: enumOf(EXTERNAL_PROPOSAL_CATEGORIES),
    classification: enumOf(["private", "sensitive"]),
    status: enumOf(EXTERNAL_PROPOSAL_STATUSES),
    receivedAt: timestamp,
    decidedAt: nullable(timestamp),
    batchId: nullable(text(1, 128)),
    memoryId: nullable(text(1, 512)),
    supersededBy: nullable(text(1, 128)),
    content: nullableText,
    keys: {
      type: "array",
      items: objectOf({ client: text(1, 64), sourceKey: text(1, 200) }),
    },
    unkeyedClients: { type: "array", items: text(1, 64) },
  },
  [],
  "其他 agent 通过 MCP 提议的一条记忆和它的处理结果。content 为 null 表示正文已按规则删掉（拒绝满 30 天，或被替换）。content 被扣留时 textSha256 为 null，摘要和原文一起在密封文件里。keys 是各客户端的固定编号现在指向这一条的；unkeyedClients 是不带编号送过这段正文的客户端。",
);

export const OWNER_PROPOSAL_ORIGINS = [
  "owner_said",
  "inferred",
  "external_agent",
  "external_content",
] as const;
export const OWNER_PROPOSAL_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "withdrawn",
] as const;
export const OWNER_PROPOSAL_EXECUTIONS = [
  "not_started",
  "running",
  "executed_unverified",
  "succeeded",
  "failed",
  "unknown",
  "undone",
] as const;

export const ownerProposalBasisKey = (id: string): string => `ownerProposal/${id}/basis`;
export const ownerProposalExecutionKey = (id: string): string => `ownerProposal/${id}/execution`;

export const OWNER_PROPOSAL_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    type: text(1, 64),
    summary: text(1, 200),
    effect: text(1, 200),
    origin: enumOf(OWNER_PROPOSAL_ORIGINS),
    sourceRef: nullable(text(1, 256)),
    sourceVersion: nullable(text(1, 128)),
    version: integer(1),
    fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    status: enumOf(OWNER_PROPOSAL_STATUSES),
    execStatus: enumOf(OWNER_PROPOSAL_EXECUTIONS),
    proposedAt: timestamp,
    expiresAt: timestamp,
    decidedAt: nullable(timestamp),
    proposedCount: integer(1),
    rejectCount: integer(0),
    lastRejectedAt: nullable(timestamp),
    attempts: integer(0),
    executedAt: nullable(timestamp),
    requiresFullRead: { type: "boolean" },
    requiresPresence: { type: "boolean" },
    basis: nullableText,
    execution: nullableText,
  },
  [],
  "一条提给主人的下一步和它的处理结果：主人的决定（status）和执行（execStatus）分开记。basis 是主人看到的依据和处理方的数据（JSON 文字），execution 是执行改了什么（撤销用）；两者为 null 表示载荷已按规则清掉。导入时执行中和已执行待核实的记成结果不明，租约不导出。",
);

const exportedPayload = nullable({ type: "object" });
const scalarMap: JsonSchema = { type: "object" };
const day: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const PERCEPTION_RECORD_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    type: text(1, 64),
    origin: enumOf(["owner_spoken", "other"]),
    captureSource: text(1, 64),
    occurredAt: timestamp,
    deviceTime: text(1, 64),
    localDay: day,
    deviceId: text(1, 64),
    confidence: permille,
    speakerKind: nullable(text(1, 32)),
    speakerRef: nullable(text(1, 128)),
    episodeId: nullable(text(1, 128)),
    classification: enumOf(CLASSIFICATIONS),
    evidence: scalarMap,
    content: exportedPayload,
  },
  [],
  "一条感知记录：设备感知到的一件事。origin 是服务器定的，只有认出是主人亲口说的才是 owner_spoken。只供查看，导入时不恢复。",
);

export const PERCEPTION_EPISODE_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    startedAt: timestamp,
    endedAt: timestamp,
    localDay: day,
    recordCount: integer(0),
  },
  [],
  "一段经历：时间上连在一起的一段对话。只供查看，导入时不恢复。",
);

export const DEVICE_MIRROR_ITEM_SCHEMA: JsonSchema = objectOf(
  {
    deviceId: text(1, 64),
    kind: text(1, 64),
    externalId: text(1, 256),
    version: integer(0),
    updatedAt: timestamp,
    data: scalarMap,
  },
  [],
  "设备上日历、提醒事项、通讯录、家居配件在服务器的一份副本。只供查看，导入时不恢复。",
);

export const TRACK_POINT_SCHEMA: JsonSchema = objectOf(
  {
    deviceId: text(1, 64),
    occurredAt: timestamp,
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    accuracyMeters: nullable({ type: "number", minimum: 0 }),
    speedMetersPerSecond: nullable({ type: "number", minimum: 0 }),
  },
  [],
  "一个轨迹点。只供查看，导入时不恢复。",
);

export const PERCEPTION_SETTINGS_SCHEMA: JsonSchema = objectOf(
  {
    disabledSenses: { type: "array", items: text(1, 32) },
    pausedFrom: nullable(timestamp),
    pausedUntil: nullable(timestamp),
    retentionDays: scalarMap,
    limitOverrides: scalarMap,
    updatedAt: timestamp,
  },
  [],
  "感知的设置：关掉的感官、暂停时段、保留天数、改过的上限。只供查看，导入时不恢复。",
);

export const LIMIT_USAGE_SCHEMA: JsonSchema = objectOf(
  {
    key: text(1, 128),
    periodStart: timestamp,
    deviceId: nullable(text(1, 64)),
    used: integer(0),
  },
  [],
  "某个上限在某一天的已用量；deviceId 有值的是设备自己报的数。只供查看，导入时不恢复。",
);

export const CONSOLIDATION_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 512),
    day: text(10, 10),
    triggerRunId: text(1, 256),
    status: enumOf(["running", "completed", "failed"]),
    reviewedThrough: nullable(text(1, 64)),
    modelCalled: bool,
    changeCount: integer(0),
    errorCode: nullable(text(1, 512)),
    startedAt: timestamp,
    finishedAt: nullable(timestamp),
    changes: {
      type: "array",
      items: objectOf({
        id: text(1, 512),
        memoryId: text(1, 512),
        relatedMemoryId: nullable(text(1, 512)),
        action: enumOf(["merge", "supersede", "archive", "reflect", "hold"]),
        beforeRevision: nullable(integer(1)),
        afterRevision: integer(1),
        beforeStatus: nullable(text(1, 64)),
        beforeSupersededBy: nullable(text(1, 512)),
        beforeValidTo: nullable(text(1, 64)),
        createdAt: timestamp,
        undoneAt: nullable(timestamp),
        basis: { type: "array", items: text(1, 512) },
      }),
    },
  },
  [],
  "一次整理（把相近的记忆合并、取代、归档，或把有冲突的新记忆标为待你确认），带每次改动和依据的记忆编号。",
);

export const CONVERSATION_REVIEW_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    day: text(10, 10),
    status: enumOf(["running", "completed", "failed", "gave_up"]),
    attempts: integer(1, 100),
    errorCode: nullable(text(1, 128)),
    startedAt: timestamp,
    finishedAt: nullable(timestamp),
    undoneAt: nullable(timestamp),
    changes: {
      type: "array",
      items: objectOf({
        memoryId: text(1, 512),
        action: enumOf(["created", "superseded", "confirmed"]),
        afterRevision: integer(1),
        beforeSupersededBy: nullable(text(1, 512)),
        beforeValidTo: nullable(text(1, 64)),
        createdAt: timestamp,
        undoneRevision: nullable(integer(2)),
      }),
    },
  },
  [],
  "一次回看对话（后台重读一段过去的对话，补记新记忆、标出被取代的旧记忆、确认待确认的记忆），带这次改动了哪些记忆；来源对话和消息的编号不导出。",
);

export const DECISION_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    kind: enumOf(DECISION_KINDS),
    scenario: nullable(enumOf(["gmail"])),
    checkedAt: timestamp,
    counts: { type: "object" },
    verdict: nullable(
      enumOf(["pushed", "silent", "deferred", "failed", "capped", "capped_daily", "needs_owner"]),
    ),
    outcome: nullable(text(1, 64)),
    reasonCode: text(1, 64),
    subjectRef: nullable(text(1, 256)),
    inputs: { type: "object" },
    reason: nullableText,
    content: nullableText,
    pushSourceKey: nullable(text(1, 256)),
    costMicros: integer(0),
    durationMs: integer(0, 86_400_000),
    ownerRating: nullable(enumOf(RATINGS)),
    ratedAt: nullable(timestamp),
    category: nullable(enumOf(CATEGORIES)),
    confidencePermille: nullable(permille),
    inferred: nullable(bool),
    signals: {
      type: "array",
      items: objectOf({
        id: text(1, 128),
        signal: enumOf(["opened", "undone", "replied"]),
        occurredAt: timestamp,
        delayMs: integer(0),
        detail: { type: "object" },
        sourceRef: text(1, 256),
        recordedAt: timestamp,
      }),
    },
  },
  [],
  "一条决策记录：系统每次由模型做出的门槛决策，以及你的评价和之后的反应。成本和耗时对应模型调用部分：costMicros 是这次调用的花费（百万分之一美元），durationMs 是耗时；模型输入输出原文属于证据，默认不导出。",
);

const RULE_STATUSES = ["active", "needs_review", "suspended", "retired"] as const;
const RULE_SUSPEND_REASONS = [
  "source_removed",
  "no_longer_standing",
  "parameters_changed",
] as const;
export const RULE_PARAMETERS_MAXIMUM_LENGTH = 262_144;
export const MAXIMUM_LINE_LENGTH = 64 * 1024 * 1024;

const ruleVersionFields = {
  revision: integer(1),
  status: enumOf(RULE_STATUSES),
  source: text(1, 256),
  sourceMemoryId: nullable(text(1, 128)),
  parameters: text(2, RULE_PARAMETERS_MAXIMUM_LENGTH),
  withheld: { type: "boolean", const: true },
} as const;

export const RULE_SCHEMA: JsonSchema = objectOf(
  {
    ruleId: text(1, 64),
    ...ruleVersionFields,
    updatedAt: timestamp,
    suspendReason: enumOf(RULE_SUSPEND_REASONS),
    history: {
      type: "array",
      items: objectOf(
        {
          ...ruleVersionFields,
          changeReason: nullable(text(1, 64)),
          changedAt: timestamp,
        },
        ["withheld"],
      ),
    },
  },
  ["withheld", "suspendReason"],
  "规则手册里存下来的一条规则：当前版本加全部修订历史（历史最后一版就是当前版本）。parameters 是规则参数在库里存的 JSON 原文（逐字保留，用 JSON 解析即可读）；表达式由程序按参数生成，所以不导出表达式。withheld 为 true 时参数里有机密，或者库里存的原文不是写规则的程序会写出的形式（例如带重复的键），parameters 是遮盖后的 JSON，原文在密封文件里（key 为 rule/<ruleId>/parameters 和 rule/<ruleId>/history/<revision>/parameters）。产品自带的规则随版本发布，不在这里。status 为 suspended 时规则已暂停、不执行，suspendReason 写明原因（source_removed 出处记忆没了，no_longer_standing 主人改口不要了，parameters_changed 主人改了条件）；挂起时系统算出的建议值不导出。",
);

const payloadText = EXPORTED_TEXT_SCHEMA;

export const EVIDENCE_SCHEMA: JsonSchema = objectOf(
  {
    decisionPayloads: {
      type: "array",
      items: objectOf({
        decisionId: text(1, 128),
        sequence: integer(0, 1_000_000),
        role: enumOf(["model_input", "model_output"]),
        payload: payloadText,
      }),
    },
    sourceInsights: {
      type: "array",
      items: objectOf({
        id: text(1, 128),
        source: enumOf(["gmail"]),
        threadId: text(1, 256),
        lastMessageId: text(1, 256),
        result: enumOf(["act", "know", "check"]),
        floorRaised: bool,
        content: payloadText,
        dueAt: nullable(text(1, 64)),
        priority: nullable(enumOf(["high", "medium", "low"])),
        status: enumOf(["open", "replied", "done", "muted"]),
        decisionId: text(1, 128),
        ownerRating: nullable(enumOf(RATINGS)),
        pushSourceKey: nullable(text(1, 256)),
        createdAt: timestamp,
        updatedAt: timestamp,
        pushClass: nullable(text(1, 512)),
      }),
    },
    processedMessages: {
      type: "array",
      items: objectOf({
        source: enumOf(["gmail"]),
        messageId: text(1, 256),
        threadId: text(1, 256),
        decisionId: text(1, 128),
        outcome: enumOf(["act", "know", "check", "ignore", "skipped"]),
        skipReason: nullable(enumOf(["category", "sensitive", "own_mail"])),
        header: nullableText,
        processedAt: timestamp,
        reviewedAt: nullable(timestamp),
        ownerRating: nullable(enumOf(RATINGS)),
        receivedAt: nullable(timestamp),
      }),
    },
    museEntries: {
      type: "array",
      items: objectOf({
        id: text(1, 128),
        museAt: timestamp,
        museReminded: bool,
        timingOk: nullable(bool),
        contentOk: nullable(bool),
        content: nullableText,
        note: nullableText,
        pairedDecisionId: nullable(text(1, 128)),
        intakeItemKey: nullable(text(3, 200)),
        recordedAt: timestamp,
        pairedMessageId: nullable(text(1, 256)),
      }),
    },
    prereviews: {
      type: "array",
      items: objectOf({
        id: text(1, 128),
        decisionId: nullable(text(1, 128)),
        mailSource: nullable(enumOf(["gmail"])),
        messageId: nullable(text(1, 256)),
        group: enumOf([
          "proactive_pushed",
          "proactive_silent",
          "memory_skipped",
          "memory_kept",
          "consolidation",
        ]),
        category: nullable(text(1, 64)),
        status: enumOf(["done", "failed"]),
        rating: nullable(enumOf(["useful", "unneeded", "missed", "unsure"])),
        confidencePermille: nullable(permille),
        historyConflict: nullable(bool),
        failureCode: nullable(text(1, 128)),
        modelRef: text(1, 256),
        promptId: text(1, 128),
        textDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        dataClassification: enumOf(["public", "private", "sensitive"]),
        costMicros: integer(0),
        durationMs: integer(0, 86_400_000),
        createdAt: timestamp,
      }),
    },
  },
  [],
  "证据：模型输入输出原文、邮件检查结果、Muse 校准记录。只放在密封文件里。",
);

export const SEALED_SCHEMA: JsonSchema = objectOf({
  format: { type: "string", const: FORMAT_VERSION },
  originals: { type: "object" },
  evidence: nullable(EVIDENCE_SCHEMA),
});

export const MANIFEST_SCHEMA: JsonSchema = objectOf({
  format: { type: "string", const: FORMAT_VERSION },
  migrationSequence: integer(1),
  exportedAt: timestamp,
  egressRuleset: integer(0),
  files: {
    type: "array",
    items: objectOf({
      path: text(1, 256),
      role: enumOf(["data", "schema", "markdown", "sealed"]),
      bytes: integer(0),
      lines: integer(0),
      sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }),
  },
  counts: {
    type: "object",
    properties: {
      memories: integer(0),
      memoryHistoryEvents: integer(0),
      people: integer(0),
      importBatches: integer(0),
      pairedDevices: integer(0),
      perceptionRecords: integer(0),
      perceptionEpisodes: integer(0),
      deviceMirrorItems: integer(0),
      trackPoints: integer(0),
      perceptionSettings: integer(0),
      limitUsage: integer(0),
      consolidations: integer(0),
      consolidationChanges: integer(0),
      conversationReviews: integer(0),
      conversationReviewChanges: integer(0),
      decisions: integer(0),
      decisionSignals: integer(0),
      markdownMemories: integer(0),
      rules: integer(0),
      enforcedRules: integer(0),
      externalProposals: integer(0),
      ownerProposals: integer(0),
      ruleHistoryVersions: integer(0),
      sealedOriginals: integer(0),
      sealedEvidenceRows: integer(0),
    },
    required: [
      "memories",
      "memoryHistoryEvents",
      "people",
      "importBatches",
      "pairedDevices",
      "perceptionRecords",
      "perceptionEpisodes",
      "deviceMirrorItems",
      "trackPoints",
      "perceptionSettings",
      "limitUsage",
      "consolidations",
      "consolidationChanges",
      "conversationReviews",
      "conversationReviewChanges",
      "decisions",
      "decisionSignals",
      "markdownMemories",
      "rules",
      "enforcedRules",
      "externalProposals",
      "ownerProposals",
      "ruleHistoryVersions",
      "sealedOriginals",
      "sealedEvidenceRows",
    ],
    additionalProperties: false,
  },
  withheld: objectOf({
    texts: integer(0),
    memories: integer(0),
    decisions: integer(0),
    rules: integer(0),
  }),
  omitted: {
    type: "array",
    items: objectOf({
      what: text(1, 512),
      count: nullable(integer(0)),
      reason: text(1, 512),
    }),
  },
});

export const SCHEMA_FILES: readonly { readonly path: string; readonly schema: JsonSchema }[] =
  Object.freeze([
    { path: "schema/consolidations.schema.json", schema: CONSOLIDATION_SCHEMA },
    { path: "schema/conversation-reviews.schema.json", schema: CONVERSATION_REVIEW_SCHEMA },
    { path: "schema/decisions.schema.json", schema: DECISION_SCHEMA },
    { path: "schema/device-mirror-items.schema.json", schema: DEVICE_MIRROR_ITEM_SCHEMA },
    { path: "schema/evidence.schema.json", schema: EVIDENCE_SCHEMA },
    { path: "schema/external-memory-proposals.schema.json", schema: EXTERNAL_PROPOSAL_SCHEMA },
    { path: "schema/import-batches.schema.json", schema: IMPORT_BATCH_SCHEMA },
    { path: "schema/limit-usage.schema.json", schema: LIMIT_USAGE_SCHEMA },
    { path: "schema/manifest.schema.json", schema: MANIFEST_SCHEMA },
    { path: "schema/memories.schema.json", schema: MEMORY_SCHEMA },
    { path: "schema/owner-proposals.schema.json", schema: OWNER_PROPOSAL_SCHEMA },
    { path: "schema/paired-devices.schema.json", schema: PAIRED_DEVICE_SCHEMA },
    { path: "schema/people.schema.json", schema: PERSON_SCHEMA },
    { path: "schema/perception-episodes.schema.json", schema: PERCEPTION_EPISODE_SCHEMA },
    { path: "schema/perception-records.schema.json", schema: PERCEPTION_RECORD_SCHEMA },
    { path: "schema/perception-settings.schema.json", schema: PERCEPTION_SETTINGS_SCHEMA },
    { path: "schema/rules.schema.json", schema: RULE_SCHEMA },
    { path: "schema/track-points.schema.json", schema: TRACK_POINT_SCHEMA },
  ]);

export const DATA_FILES = Object.freeze({
  memories: "data/memories.jsonl",
  people: "data/people.jsonl",
  importBatches: "data/import-batches.jsonl",
  pairedDevices: "data/paired-devices.jsonl",
  perceptionRecords: "data/perception-records.jsonl",
  perceptionEpisodes: "data/perception-episodes.jsonl",
  deviceMirrorItems: "data/device-mirror-items.jsonl",
  trackPoints: "data/track-points.jsonl",
  perceptionSettings: "data/perception-settings.jsonl",
  limitUsage: "data/limit-usage.jsonl",
  consolidations: "data/consolidations.jsonl",
  conversationReviews: "data/conversation-reviews.jsonl",
  decisions: "data/decisions.jsonl",
  rules: "data/rules.jsonl",
  externalProposals: "data/external-memory-proposals.jsonl",
  ownerProposals: "data/owner-proposals.jsonl",
} as const);

export const PERCEPTION_FILE_KEYS = [
  "perceptionRecords",
  "perceptionEpisodes",
  "deviceMirrorItems",
  "trackPoints",
  "perceptionSettings",
  "limitUsage",
] as const;
export type PerceptionFileKey = (typeof PERCEPTION_FILE_KEYS)[number];

export const PERCEPTION_FILE_SCHEMAS: Readonly<Record<PerceptionFileKey, JsonSchema>> =
  Object.freeze({
    perceptionRecords: PERCEPTION_RECORD_SCHEMA,
    perceptionEpisodes: PERCEPTION_EPISODE_SCHEMA,
    deviceMirrorItems: DEVICE_MIRROR_ITEM_SCHEMA,
    trackPoints: TRACK_POINT_SCHEMA,
    perceptionSettings: PERCEPTION_SETTINGS_SCHEMA,
    limitUsage: LIMIT_USAGE_SCHEMA,
  });

export const EMPTY_PERCEPTION_COUNTS: Readonly<Record<PerceptionFileKey, number>> = Object.freeze(
  Object.fromEntries(PERCEPTION_FILE_KEYS.map((key) => [key, 0])) as Record<
    PerceptionFileKey,
    number
  >,
);

export const SEALED_FILE = "sealed/sealed.enc";
export const MANIFEST_FILE = "manifest.json";
export const INDEX_FILE = "MEMORY.md";
