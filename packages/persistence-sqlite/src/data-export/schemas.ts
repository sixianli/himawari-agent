import type { JsonSchema } from "./schema.js";

export const FORMAT_VERSION = "himawari.data-export.v1" as const;

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
        action: enumOf(["merge", "supersede", "archive", "reflect"]),
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
  "一次整理（把相近的记忆合并、取代、归档），带每次改动和依据的记忆编号。",
);

export const DECISION_SCHEMA: JsonSchema = objectOf(
  {
    id: text(1, 128),
    kind: enumOf([
      "proactive",
      "memory_candidate",
      "consolidation",
      "context_truncation",
      "retrieval_degrade",
      "external_read",
    ]),
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
      consolidations: integer(0),
      consolidationChanges: integer(0),
      decisions: integer(0),
      decisionSignals: integer(0),
      markdownMemories: integer(0),
      sealedOriginals: integer(0),
      sealedEvidenceRows: integer(0),
    },
    required: [
      "memories",
      "memoryHistoryEvents",
      "people",
      "importBatches",
      "consolidations",
      "consolidationChanges",
      "decisions",
      "decisionSignals",
      "markdownMemories",
      "sealedOriginals",
      "sealedEvidenceRows",
    ],
    additionalProperties: false,
  },
  withheld: objectOf({
    texts: integer(0),
    memories: integer(0),
    decisions: integer(0),
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
    { path: "schema/decisions.schema.json", schema: DECISION_SCHEMA },
    { path: "schema/evidence.schema.json", schema: EVIDENCE_SCHEMA },
    { path: "schema/import-batches.schema.json", schema: IMPORT_BATCH_SCHEMA },
    { path: "schema/manifest.schema.json", schema: MANIFEST_SCHEMA },
    { path: "schema/memories.schema.json", schema: MEMORY_SCHEMA },
    { path: "schema/people.schema.json", schema: PERSON_SCHEMA },
  ]);

export const DATA_FILES = Object.freeze({
  memories: "data/memories.jsonl",
  people: "data/people.jsonl",
  importBatches: "data/import-batches.jsonl",
  consolidations: "data/consolidations.jsonl",
  decisions: "data/decisions.jsonl",
} as const);

export const SEALED_FILE = "sealed/sealed.enc";
export const MANIFEST_FILE = "manifest.json";
export const INDEX_FILE = "MEMORY.md";
