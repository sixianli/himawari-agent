import { type JsonValue, sha256Hex } from "./canonical.js";
import { foldText } from "./markdown.js";
import {
  assertRuleHistory,
  assertRuleIdentifiers,
  checkRulesMarkdown,
  enforcedRuleCount,
  type PortableRule,
  RULES_INDEX_FILE,
  storedRuleProblem,
} from "./rules.js";
import { validateAgainst } from "./schema.js";
import {
  CONSOLIDATION_SCHEMA,
  CONVERSATION_REVIEW_SCHEMA,
  DATA_FILES,
  DECISION_SCHEMA,
  EXTERNAL_PROPOSAL_SCHEMA,
  FORMAT_VERSION,
  IMPORT_BATCH_SCHEMA,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  MAXIMUM_LINE_LENGTH,
  MEMORY_SCHEMA,
  OWNER_PROPOSAL_SCHEMA,
  PAIRED_DEVICE_SCHEMA,
  PERCEPTION_FILE_KEYS,
  PERCEPTION_FILE_SCHEMAS,
  type PerceptionFileKey,
  PERSON_SCHEMA,
  RULE_SCHEMA,
} from "./schemas.js";
import {
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  type PortableCounts,
  type PortableFiles,
  type PortableManifest,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ParsedMemory {
  readonly id: string;
  readonly status: "active" | "archived" | "trashed";
  readonly revision: number;
  readonly classification: string;
  readonly inference: boolean;
  readonly confidencePermille: number;
  readonly policyVersion: string;
  readonly updatedAt: string;
  readonly recordedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly category: string;
  readonly subCategory: string | null;
  readonly importancePermille: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly supersededBy: string | null;
  readonly useCount: number;
  readonly evidenceVerified: boolean;
  readonly sensitiveTopic: string | null;
  readonly tentative: boolean;
  readonly stance: string | null;
  readonly importBatchId: string | null;
  readonly content: ParsedText;
  readonly history: readonly {
    readonly kind: string;
    readonly content: ParsedText;
    readonly stance: string | null;
    readonly quote: ParsedText | null;
    readonly sourceDeleted: boolean;
    readonly occurredAt: string;
  }[];
  readonly provenance: readonly {
    readonly sourceType: string;
    readonly sourceId: string;
    readonly sourceDeleted: boolean;
  }[];
  readonly entities: readonly string[];
  readonly personIds: readonly string[];
  readonly pin: { readonly pinned: boolean; readonly updatedAt: string } | null;
}

export interface ParsedText {
  readonly text: string;
  readonly classification: string;
  readonly contentType: string;
  readonly withheld?: true;
}

export interface ParsedExternalProposal {
  readonly id: string;
  readonly subjectRef: string;
  readonly client: string;
  readonly sourceKey: string | null;
  readonly textSha256: string | null;
  readonly normalization: string;
  readonly category: string;
  readonly classification: string;
  readonly status: "pending" | "committed" | "rejected" | "superseded";
  readonly receivedAt: string;
  readonly decidedAt: string | null;
  readonly batchId: string | null;
  readonly memoryId: string | null;
  readonly supersededBy: string | null;
  readonly content: ParsedText | null;
  readonly keys: readonly { readonly client: string; readonly sourceKey: string }[];
  readonly unkeyedClients: readonly string[];
}

export interface ParsedOwnerProposal {
  readonly id: string;
  readonly type: string;
  readonly summary: string;
  readonly effect: string;
  readonly origin: string;
  readonly sourceRef: string | null;
  readonly sourceVersion: string | null;
  readonly version: number;
  readonly fingerprint: string;
  readonly status: string;
  readonly execStatus: string;
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly proposedCount: number;
  readonly rejectCount: number;
  readonly lastRejectedAt: string | null;
  readonly attempts: number;
  readonly executedAt: string | null;
  readonly requiresFullRead: boolean;
  readonly requiresPresence: boolean;
  readonly basis: ParsedText | null;
  readonly execution: ParsedText | null;
}

const STORED_TIME = /^.{4}-.{2}-.{2}T.{2}:.{2}:.{2}\..{3}Z$/u;

export function ownerProposalProblem(proposal: ParsedOwnerProposal): string | null {
  const where = `提给主人的提议 ${proposal.id}`;
  for (const value of [
    proposal.proposedAt,
    proposal.expiresAt,
    proposal.decidedAt,
    proposal.lastRejectedAt,
    proposal.executedAt,
  ])
    if (value !== null && !STORED_TIME.test(value))
      return `${where}：时间不是库里存的格式（例如 2026-11-12T00:00:00.000Z）`;
  if ((proposal.status === "pending") !== (proposal.decidedAt === null))
    return `${where}：只有待采纳的没有处理时间`;
  if (proposal.rejectCount > 0 && proposal.lastRejectedAt === null)
    return `${where}：拒绝过但没有最近拒绝时间`;
  if (proposal.sourceRef === null && proposal.sourceVersion !== null)
    return `${where}：有来源版本却没有来源`;
  if (proposal.status === "pending" && proposal.execStatus !== "not_started")
    return `${where}：待采纳的不能有执行记录`;
  return null;
}

export function externalProposalProblem(proposal: ParsedExternalProposal): string | null {
  const where = `其他 agent 的提议 ${proposal.id}`;
  if (
    !STORED_TIME.test(proposal.receivedAt) ||
    (proposal.decidedAt !== null && !STORED_TIME.test(proposal.decidedAt))
  )
    return `${where}：时间不是库里存的格式（例如 2026-11-12T00:00:00.000Z）`;
  if ((proposal.status === "pending") !== (proposal.decidedAt === null))
    return `${where}：只有待确认的没有处理时间`;
  if (proposal.memoryId !== null && proposal.status !== "committed")
    return `${where}：只有已保存的能指向记忆`;
  if (
    proposal.content === null &&
    proposal.status !== "rejected" &&
    proposal.status !== "superseded"
  )
    return `${where}：待确认和已保存的必须有正文`;
  if (proposal.supersededBy !== null && proposal.status !== "superseded")
    return `${where}：只有被替换的能指向替换它的提议`;
  if (
    proposal.batchId !== null &&
    proposal.status !== "committed" &&
    proposal.status !== "rejected"
  )
    return `${where}：只有已保存或已拒绝的能属于一批`;
  if (proposal.content !== null && proposal.content.classification !== proposal.classification)
    return `${where}：正文的分级和提议的分级不一致`;
  if ((proposal.textSha256 === null) !== (proposal.content?.withheld === true))
    return `${where}：只有正文被扣留时摘要才不在明文里`;
  if (new Set(proposal.unkeyedClients).size !== proposal.unkeyedClients.length)
    return `${where}：不带编号的客户端重复`;
  return null;
}

export interface ParsedPerson {
  readonly id: string;
  readonly name: string;
  readonly relation: string | null;
  readonly reverseRelation: string | null;
  readonly mergedInto: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly aliases: readonly string[];
}

export interface ParsedBatch {
  readonly id: string;
  readonly source: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface ParsedPairedDevice {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly releaseChannel: string;
  readonly status: string;
  readonly pairedAt: string;
  readonly confirmedAt: string | null;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface ParsedConsolidation {
  readonly id: string;
  readonly day: string;
  readonly triggerRunId: string;
  readonly status: string;
  readonly reviewedThrough: string | null;
  readonly modelCalled: boolean;
  readonly changeCount: number;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly changes: readonly {
    readonly id: string;
    readonly memoryId: string;
    readonly relatedMemoryId: string | null;
    readonly action: string;
    readonly beforeRevision: number | null;
    readonly afterRevision: number;
    readonly beforeStatus: string | null;
    readonly beforeSupersededBy: string | null;
    readonly beforeValidTo: string | null;
    readonly createdAt: string;
    readonly undoneAt: string | null;
    readonly basis: readonly string[];
  }[];
}

export interface ParsedConversationReview {
  readonly id: string;
  readonly day: string;
  readonly status: string;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly undoneAt: string | null;
  readonly changes: readonly {
    readonly memoryId: string;
    readonly action: string;
    readonly afterRevision: number;
    readonly beforeSupersededBy: string | null;
    readonly beforeValidTo: string | null;
    readonly createdAt: string;
    readonly undoneRevision: number | null;
  }[];
}

export interface ParsedDecision {
  readonly id: string;
  readonly kind: string;
  readonly scenario: string | null;
  readonly checkedAt: string;
  readonly counts: JsonValue;
  readonly verdict: string | null;
  readonly outcome: string | null;
  readonly reasonCode: string;
  readonly subjectRef: string | null;
  readonly inputs: JsonValue;
  readonly reason: ParsedText | null;
  readonly content: ParsedText | null;
  readonly pushSourceKey: string | null;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly ownerRating: string | null;
  readonly ratedAt: string | null;
  readonly category: string | null;
  readonly confidencePermille: number | null;
  readonly inferred: boolean | null;
  readonly signals: readonly {
    readonly id: string;
    readonly signal: string;
    readonly occurredAt: string;
    readonly delayMs: number;
    readonly detail: JsonValue;
    readonly sourceRef: string;
    readonly recordedAt: string;
  }[];
}

export interface ParsedPortable {
  readonly manifest: PortableManifest;
  readonly memories: readonly ParsedMemory[];
  readonly people: readonly ParsedPerson[];
  readonly importBatches: readonly ParsedBatch[];
  readonly pairedDevices: readonly ParsedPairedDevice[];
  readonly perception: Readonly<Record<PerceptionFileKey, readonly Record<string, unknown>[]>>;
  readonly consolidations: readonly ParsedConsolidation[];
  readonly conversationReviews: readonly ParsedConversationReview[];
  readonly decisions: readonly ParsedDecision[];
  readonly rules: readonly PortableRule[];
  readonly externalProposals: readonly ParsedExternalProposal[];
  readonly ownerProposals: readonly ParsedOwnerProposal[];
}

export function assertSafePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 256 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.PATH_UNSAFE, path);
}

function countNewlines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines;
}

export function readManifest(files: PortableFiles): PortableManifest {
  const bytes = files.get(MANIFEST_FILE);
  if (bytes === undefined)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, "缺少清单");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, "清单不是有效的 JSON");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { format?: unknown }).format !== FORMAT_VERSION
  )
    throw new DataExportError(
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
      String((value as { format?: unknown }).format),
    );
  const problem = validateAgainst(MANIFEST_SCHEMA, value);
  if (problem !== null)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, problem);
  return value as PortableManifest;
}

export function verifyIntegrity(
  files: PortableFiles,
  expectedMigrationSequence: number,
): PortableManifest {
  for (const path of files.keys()) assertSafePath(path);
  const manifest = readManifest(files);
  if (manifest.migrationSequence !== expectedMigrationSequence)
    throw new DataExportError(
      DATA_EXPORT_ERROR_CODES.MIGRATION_MISMATCH,
      `${manifest.migrationSequence} != ${expectedMigrationSequence}`,
    );
  const listed = new Set<string>();
  for (const entry of manifest.files) {
    assertSafePath(entry.path);
    if (listed.has(entry.path))
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
        `重复 ${entry.path}`,
      );
    listed.add(entry.path);
    const bytes = files.get(entry.path);
    if (bytes === undefined)
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH,
        `缺少 ${entry.path}`,
      );
    if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256)
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH, entry.path);
    if (entry.role === "data" && countNewlines(bytes) !== entry.lines)
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH, entry.path);
  }
  for (const path of files.keys())
    if (path !== MANIFEST_FILE && !listed.has(path))
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH, `未登记 ${path}`);
  return manifest;
}

function parseLines<T>(
  files: PortableFiles,
  path: string,
  schema: Parameters<typeof validateAgainst>[0],
): T[] {
  const bytes = files.get(path);
  if (bytes === undefined)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH, `缺少 ${path}`);
  const text = decoder.decode(bytes);
  if (text === "") return [];
  if (!text.endsWith("\n"))
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, `${path}: 文件没有以换行结束`);
  const out: T[] = [];
  const lines = text.slice(0, -1).split("\n");
  lines.forEach((line, index) => {
    if (line.length > MAXIMUM_LINE_LENGTH)
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, `${path}:${index + 1} 过长`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, `${path}:${index + 1}`);
    }
    const problem = validateAgainst(schema, value);
    if (problem !== null)
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        `${path}:${index + 1} ${problem}`,
      );
    out.push(value as T);
  });
  return out;
}

function unique(ids: readonly string[], what: string): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id))
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, `${what} 编号重复 ${id}`);
    seen.add(id);
  }
  return seen;
}

export function parsePortable(
  files: PortableFiles,
  expectedMigrationSequence: number,
): ParsedPortable {
  const manifest = verifyIntegrity(files, expectedMigrationSequence);
  const memories = parseLines<ParsedMemory>(files, DATA_FILES.memories, MEMORY_SCHEMA);
  const people = parseLines<ParsedPerson>(files, DATA_FILES.people, PERSON_SCHEMA);
  const pairedDevices = parseLines<ParsedPairedDevice>(
    files,
    DATA_FILES.pairedDevices,
    PAIRED_DEVICE_SCHEMA,
  );
  unique(
    pairedDevices.map(({ id }) => id),
    "配对设备",
  );
  const perception = Object.fromEntries(
    PERCEPTION_FILE_KEYS.map((key) => [
      key,
      parseLines<Record<string, unknown>>(files, DATA_FILES[key], PERCEPTION_FILE_SCHEMAS[key]),
    ]),
  ) as Record<PerceptionFileKey, Record<string, unknown>[]>;
  for (const key of ["perceptionRecords", "perceptionEpisodes"] as const)
    unique(
      perception[key].map(({ id }) => String(id)),
      DATA_FILES[key],
    );
  const importBatches = parseLines<ParsedBatch>(
    files,
    DATA_FILES.importBatches,
    IMPORT_BATCH_SCHEMA,
  );
  const consolidations = parseLines<ParsedConsolidation>(
    files,
    DATA_FILES.consolidations,
    CONSOLIDATION_SCHEMA,
  );
  const conversationReviews = parseLines<ParsedConversationReview>(
    files,
    DATA_FILES.conversationReviews,
    CONVERSATION_REVIEW_SCHEMA,
  );
  const decisions = parseLines<ParsedDecision>(files, DATA_FILES.decisions, DECISION_SCHEMA);
  const rules = parseLines<PortableRule>(files, DATA_FILES.rules, RULE_SCHEMA);
  const externalProposals = parseLines<ParsedExternalProposal>(
    files,
    DATA_FILES.externalProposals,
    EXTERNAL_PROPOSAL_SCHEMA,
  );
  const ownerProposals = parseLines<ParsedOwnerProposal>(
    files,
    DATA_FILES.ownerProposals,
    OWNER_PROPOSAL_SCHEMA,
  );
  unique(
    ownerProposals.map(({ id }) => id),
    "提给主人的提议",
  );
  for (const proposal of ownerProposals) {
    const problem = ownerProposalProblem(proposal);
    if (problem !== null) throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, problem);
  }
  const memoryIds = unique(
    memories.map(({ id }) => id),
    "记忆",
  );
  const personIds = unique(
    people.map(({ id }) => id),
    "人物",
  );
  const batchIds = unique(
    importBatches.map(({ id }) => id),
    "导入批次",
  );
  const decisionIds = unique(
    decisions.map(({ id }) => id),
    "决策",
  );
  unique(
    consolidations.map(({ id }) => id),
    "整理",
  );
  unique(
    consolidations.flatMap(({ changes }) => changes.map(({ id }) => id)),
    "整理改动",
  );
  unique(
    conversationReviews.map(({ id }) => id),
    "回看对话",
  );
  for (const review of conversationReviews)
    unique(
      review.changes.map(({ memoryId }) => memoryId),
      `回看对话 ${review.id} 的改动`,
    );
  unique(
    decisions.flatMap(({ signals }) => signals.map(({ id }) => id)),
    "决策信号",
  );
  const broken = (detail: string): never => {
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN, detail);
  };
  for (const memory of memories) {
    if (memory.supersededBy !== null && !memoryIds.has(memory.supersededBy))
      broken(`记忆 ${memory.id} 的 supersededBy`);
    if (memory.importBatchId !== null && !batchIds.has(memory.importBatchId))
      broken(`记忆 ${memory.id} 的 importBatchId`);
    for (const person of memory.personIds)
      if (!personIds.has(person)) broken(`记忆 ${memory.id} 提到的人物 ${person}`);
  }
  for (const person of people)
    if (person.mergedInto !== null && !personIds.has(person.mergedInto))
      broken(`人物 ${person.id} 的 mergedInto`);
  for (const run of consolidations)
    for (const change of run.changes) {
      if (!memoryIds.has(change.memoryId)) broken(`整理改动 ${change.id} 的记忆`);
      if (change.relatedMemoryId !== null && !memoryIds.has(change.relatedMemoryId))
        broken(`整理改动 ${change.id} 的相关记忆`);
      for (const id of change.basis) if (!memoryIds.has(id)) broken(`整理改动 ${change.id} 的依据`);
    }
  for (const review of conversationReviews)
    for (const change of review.changes) {
      if (!memoryIds.has(change.memoryId))
        broken(`回看对话 ${review.id} 改动的记忆 ${change.memoryId}`);
      if (change.beforeSupersededBy !== null && !memoryIds.has(change.beforeSupersededBy))
        broken(`回看对话 ${review.id} 改动前的 supersededBy`);
    }
  void decisionIds;
  const proposalIds = unique(
    externalProposals.map(({ id }) => id),
    "其他 agent 的提议",
  );
  unique(
    externalProposals.flatMap(({ keys }) =>
      keys.map(({ client, sourceKey }) => JSON.stringify([client, sourceKey])),
    ),
    "其他 agent 的固定编号",
  );
  unique(
    externalProposals.flatMap(({ status, textSha256 }) =>
      status === "superseded" || textSha256 === null ? [] : [textSha256],
    ),
    "其他 agent 提议的正文摘要",
  );
  for (const proposal of externalProposals) {
    const problem = externalProposalProblem(proposal);
    if (problem !== null) throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, problem);
    if (proposal.memoryId !== null && !memoryIds.has(proposal.memoryId))
      broken(`其他 agent 的提议 ${proposal.id} 的记忆`);
    if (proposal.supersededBy !== null && !proposalIds.has(proposal.supersededBy))
      broken(`其他 agent 的提议 ${proposal.id} 的 supersededBy`);
  }
  unique(
    rules.map(({ ruleId }) => ruleId),
    "规则",
  );
  for (const rule of rules) {
    assertRuleIdentifiers(rule);
    assertRuleHistory(rule);
    for (const version of [rule, ...rule.history]) {
      if (version.sourceMemoryId !== null && !memoryIds.has(version.sourceMemoryId))
        broken(`规则 ${rule.ruleId} 第 ${version.revision} 版的来源记忆`);
      if (version.withheld === true) continue;
      const problem = storedRuleProblem(rule.ruleId, version);
      if (problem !== null)
        throw new DataExportError(DATA_EXPORT_ERROR_CODES.LINE_INVALID, problem);
      if (JSON.stringify(JSON.parse(version.parameters)) !== version.parameters)
        throw new DataExportError(
          DATA_EXPORT_ERROR_CODES.LINE_INVALID,
          `规则 ${rule.ruleId} 第 ${version.revision} 版的参数不是写规则的程序会写出的形式`,
        );
    }
  }
  const rulesProblem = checkRulesMarkdown(
    files.get(RULES_INDEX_FILE) === undefined
      ? undefined
      : decoder.decode(files.get(RULES_INDEX_FILE)),
    rules,
  );
  if (rulesProblem !== null)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN, rulesProblem);
  const actual: PortableCounts = {
    memories: memories.length,
    memoryHistoryEvents: memories.reduce((total, { history }) => total + history.length, 0),
    people: people.length,
    importBatches: importBatches.length,
    pairedDevices: pairedDevices.length,
    ...(Object.fromEntries(
      PERCEPTION_FILE_KEYS.map((key) => [key, perception[key].length]),
    ) as Record<PerceptionFileKey, number>),
    consolidations: consolidations.length,
    consolidationChanges: consolidations.reduce((total, { changes }) => total + changes.length, 0),
    conversationReviews: conversationReviews.length,
    conversationReviewChanges: conversationReviews.reduce(
      (total, { changes }) => total + changes.length,
      0,
    ),
    decisions: decisions.length,
    decisionSignals: decisions.reduce((total, { signals }) => total + signals.length, 0),
    markdownMemories: manifest.counts.markdownMemories,
    rules: rules.length,
    enforcedRules: enforcedRuleCount(rules),
    externalProposals: externalProposals.length,
    ownerProposals: ownerProposals.length,
    ruleHistoryVersions: rules.reduce((total, { history }) => total + history.length, 0),
    sealedOriginals: manifest.counts.sealedOriginals,
    sealedEvidenceRows: manifest.counts.sealedEvidenceRows,
  };
  for (const key of Object.keys(actual) as (keyof PortableCounts)[])
    if (actual[key] !== manifest.counts[key])
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
        `${key}: 文件里 ${actual[key]}，清单写 ${manifest.counts[key]}`,
      );
  const markdownProblems = checkMarkdownMapping(files, memories);
  const markdownCount = [...files].reduce(
    (total, [path, bytes]) =>
      path.startsWith("memory/") && path.endsWith(".md")
        ? total +
          decoder
            .decode(bytes)
            .split("\n")
            .filter((line) => line.startsWith("- ")).length
        : total,
    0,
  );
  if (markdownProblems.length > 0)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.REFERENCE_BROKEN, markdownProblems[0] ?? "");
  if (markdownCount !== manifest.counts.markdownMemories)
    throw new DataExportError(
      DATA_EXPORT_ERROR_CODES.FILE_COUNT_MISMATCH,
      `Markdown 条数 ${markdownCount}，清单写 ${manifest.counts.markdownMemories}`,
    );
  return {
    manifest,
    memories,
    people,
    importBatches,
    pairedDevices,
    perception,
    consolidations,
    conversationReviews,
    decisions,
    rules,
    externalProposals,
    ownerProposals,
  };
}

const MARKDOWN_ITEM = /^- > (.*) 〔m:([^〕]+)〕$/u;

export function checkMarkdownMapping(
  files: PortableFiles,
  memories: readonly {
    readonly id: string;
    readonly status: string;
    readonly tentative: boolean;
    readonly content: { readonly text: string };
  }[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const seen = new Set<string>();
  for (const [path, bytes] of files) {
    if (!path.startsWith("memory/") || !path.endsWith(".md")) continue;
    for (const line of decoder.decode(bytes).split("\n")) {
      if (!line.startsWith("- ")) continue;
      const match = MARKDOWN_ITEM.exec(line);
      if (match === null) {
        problems.push(`${path}: 无法解析 ${line.slice(0, 40)}`);
        continue;
      }
      const id = match[2] ?? "";
      const memory = byId.get(id);
      if (memory === undefined) problems.push(`${path}: 编号 ${id} 在 memories.jsonl 里找不到`);
      else if (foldText(memory.content.text) !== match[1])
        problems.push(`${path}: 编号 ${id} 的文字和 memories.jsonl 不一致`);
      seen.add(id);
    }
  }
  for (const memory of memories)
    if (memory.status === "active" && !memory.tentative && !seen.has(memory.id))
      problems.push(`有效记忆 ${memory.id} 没有出现在任何 Markdown 文件里`);
  return problems;
}
