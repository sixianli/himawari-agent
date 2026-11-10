import type { PayloadRecord } from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { canonicalJson, type JsonValue, jsonLines, sha256Hex } from "./canonical.js";
import { type MarkdownMemory, renderMemoryMarkdown } from "./markdown.js";
import {
  DATA_FILES,
  FORMAT_VERSION,
  INDEX_FILE,
  MANIFEST_FILE,
  SCHEMA_FILES,
  SEALED_FILE,
} from "./schemas.js";
import { sealJson } from "./seal.js";
import { type Row, readSnapshot } from "./snapshot.js";
import {
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  type ExportScope,
  type ExportTextPolicy,
  type PortableCounts,
  type PortableFiles,
  type PortableManifest,
  type PortableTextDependencies,
  WITHHELD_PLACEHOLDER,
} from "./types.js";

export interface ExportOptions extends PortableTextDependencies {
  readonly database: Database.Database;
  readonly scope: ExportScope;
  readonly migrationSequence: number;
  readonly policy: ExportTextPolicy;
  readonly now: () => string;
  readonly sealPassphrase?: string;
  readonly withEvidence?: boolean;
}

export interface ExportResult {
  readonly files: PortableFiles;
  readonly manifest: PortableManifest;
}

type Nullable<T> = T | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const str = (value: unknown): string => String(value);
const optionalString = (value: unknown): Nullable<string> =>
  value === null ? null : String(value);
const flag = (value: unknown): boolean => value === 1;
const optionalFlag = (value: unknown): Nullable<boolean> => (value === null ? null : value === 1);
const num = (value: unknown): number => Number(value);
const optionalNumber = (value: unknown): Nullable<number> =>
  value === null ? null : Number(value);

function group(rows: readonly Row[], key: string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const id = str(row[key]);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

export async function buildPortableExport(options: ExportOptions): Promise<ExportResult> {
  if (options.withEvidence === true && options.sealPassphrase === undefined)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.EVIDENCE_REQUIRES_SEAL);
  const snapshot = readSnapshot(options.database, options.scope, options.withEvidence === true);
  const texts = new Map<string, string>();
  for (const [ref, payload] of snapshot.payloads) {
    if ("unavailable" in payload) continue;
    texts.set(
      ref,
      decoder.decode(
        await options.protector.unprotect({
          ownerId: options.scope.ownerId,
          agentId: options.scope.agentId,
          payload,
        }),
      ),
    );
  }
  const originals: { [key: string]: JsonValue } = {};
  const withheldKeys = new Set<string>();
  const withheldOwners = { memories: new Set<string>(), decisions: new Set<string>() };
  const unavailableHistory = { events: 0, quotes: 0 };

  const exportedText = (
    ref: string,
    key: string,
    owner?: { readonly set: Set<string>; readonly id: string },
  ): Nullable<JsonValue> => {
    const payload = snapshot.payloads.get(ref) as PayloadRecord | { unavailable: true } | undefined;
    const text = texts.get(ref);
    if (payload === undefined || "unavailable" in payload || text === undefined) return null;
    const base = {
      classification: payload.dataClassification,
      contentType: payload.contentType,
    };
    if (!options.policy.hasSecret(text)) return { ...base, text };
    withheldKeys.add(key);
    owner?.set.add(owner.id);
    originals[key] = text;
    const masked = options.policy.mask(text);
    return {
      ...base,
      text: options.policy.hasSecret(masked) ? WITHHELD_PLACEHOLDER : masked,
      withheld: true,
    };
  };
  const requiredText = (
    ref: string,
    key: string,
    owner?: { readonly set: Set<string>; readonly id: string },
  ): JsonValue => {
    const value = exportedText(ref, key, owner);
    if (value === null) throw new DataExportError(DATA_EXPORT_ERROR_CODES.PAYLOAD_UNAVAILABLE, key);
    return value;
  };

  const memoryIds = new Set(snapshot.memories.map((row) => str(row["id"])));
  const personIds = new Set(snapshot.people.map((row) => str(row["id"])));
  const batchIds = new Set(snapshot.importBatches.map((row) => str(row["id"])));
  const history = group(snapshot.history, "memory_id");
  const provenance = group(snapshot.provenance, "memory_id");
  const entities = group(snapshot.entities, "memory_id");
  const mentions = group(snapshot.mentions, "memory_id");
  const pins = group(snapshot.pins, "memory_id");
  const aliases = group(snapshot.aliases, "person_id");

  let historyEvents = 0;
  const memoryLines: JsonValue[] = snapshot.memories.map((row) => {
    const id = str(row["id"]);
    const owner = { set: withheldOwners.memories, id };
    const events: JsonValue[] = [];
    (history.get(id) ?? []).forEach((event, index) => {
      const content = exportedText(
        str(event["content_ref"]),
        `memory/${id}/history/${index}/content`,
        owner,
      );
      if (content === null) {
        unavailableHistory.events += 1;
        return;
      }
      const quoteRef = optionalString(event["quote_ref"]);
      const quote =
        quoteRef === null
          ? null
          : exportedText(quoteRef, `memory/${id}/history/${index}/quote`, owner);
      if (quoteRef !== null && quote === null) unavailableHistory.quotes += 1;
      events.push({
        kind: str(event["kind"]),
        content,
        stance: optionalString(event["stance"]),
        quote,
        sourceDeleted: flag(event["source_deleted"]),
        occurredAt: str(event["occurred_at"]),
      });
    });
    historyEvents += events.length;
    const pin = pins.get(id)?.[0];
    const supersededBy = optionalString(row["superseded_by"]);
    const batch = optionalString(row["import_batch_id"]);
    return {
      id,
      status: str(row["status"]),
      revision: num(row["revision"]),
      classification: str(row["classification"]),
      inference: flag(row["inference"]),
      confidencePermille: num(row["confidence_permille"]),
      policyVersion: str(row["policy_version"]),
      updatedAt: str(row["updated_at"]),
      recordedAt: optionalString(row["recorded_at"]),
      lastUsedAt: optionalString(row["last_used_at"]),
      category: str(row["category"]),
      subCategory: optionalString(row["sub_category"]),
      importancePermille: num(row["importance_permille"]),
      validFrom: optionalString(row["valid_from"]),
      validTo: optionalString(row["valid_to"]),
      supersededBy: supersededBy !== null && memoryIds.has(supersededBy) ? supersededBy : null,
      useCount: num(row["use_count"]),
      evidenceVerified: flag(row["evidence_verified"]),
      sensitiveTopic: optionalString(row["sensitive_topic"]),
      tentative: flag(row["tentative"]),
      stance: optionalString(row["stance"]),
      importBatchId: batch !== null && batchIds.has(batch) ? batch : null,
      content: requiredText(str(row["content_ref"]), `memory/${id}/content`, owner),
      history: events,
      provenance: (provenance.get(id) ?? []).map((source) => ({
        sourceType: str(source["source_type"]),
        sourceId: str(source["source_id"]),
        sourceDeleted: flag(source["source_deleted"]),
      })),
      entities: (entities.get(id) ?? []).map((entity) => str(entity["name"])),
      personIds: (mentions.get(id) ?? [])
        .map((mention) => str(mention["person_id"]))
        .filter((person) => personIds.has(person)),
      pin: pin ? { pinned: flag(pin["pinned"]), updatedAt: str(pin["updated_at"]) } : null,
    };
  });

  const peopleLines: JsonValue[] = snapshot.people.map((row) => {
    const id = str(row["id"]);
    const mergedInto = optionalString(row["merged_into"]);
    return {
      id,
      name: str(row["name"]),
      relation: optionalString(row["relation"]),
      reverseRelation: optionalString(row["reverse_relation"]),
      mergedInto: mergedInto !== null && personIds.has(mergedInto) ? mergedInto : null,
      createdAt: str(row["created_at"]),
      updatedAt: str(row["updated_at"]),
      aliases: (aliases.get(id) ?? []).map((alias) => str(alias["alias"])),
    };
  });

  const batchLines: JsonValue[] = snapshot.importBatches.map((row) => ({
    id: str(row["id"]),
    source: str(row["source"]),
    itemCount: num(row["item_count"]),
    createdAt: str(row["created_at"]),
    undoneAt: optionalString(row["undone_at"]),
  }));

  const basis = group(snapshot.basis, "change_id");
  const changesByRun = group(snapshot.changes, "consolidation_id");
  let consolidationChanges = 0;
  const consolidationLines: JsonValue[] = snapshot.runs.map((run) => {
    const changes: JsonValue[] = (changesByRun.get(str(run["id"])) ?? [])
      .filter((change) => memoryIds.has(str(change["memory_id"])))
      .map((change) => {
        const related = optionalString(change["related_memory_id"]);
        return {
          id: str(change["id"]),
          memoryId: str(change["memory_id"]),
          relatedMemoryId: related !== null && memoryIds.has(related) ? related : null,
          action: str(change["action"]),
          beforeRevision: optionalNumber(change["before_revision"]),
          afterRevision: num(change["after_revision"]),
          beforeStatus: optionalString(change["before_status"]),
          beforeSupersededBy: optionalString(change["before_superseded_by"]),
          beforeValidTo: optionalString(change["before_valid_to"]),
          createdAt: str(change["created_at"]),
          undoneAt: optionalString(change["undone_at"]),
          basis: (basis.get(str(change["id"])) ?? [])
            .map((item) => str(item["memory_id"]))
            .filter((id) => memoryIds.has(id)),
        };
      });
    consolidationChanges += changes.length;
    return {
      id: str(run["id"]),
      day: str(run["day"]),
      triggerRunId: str(run["trigger_run_id"]),
      status: str(run["status"]),
      reviewedThrough: optionalString(run["reviewed_through"]),
      modelCalled: flag(run["model_called"]),
      changeCount: num(run["change_count"]),
      errorCode: optionalString(run["error_code"]),
      startedAt: str(run["started_at"]),
      finishedAt: optionalString(run["finished_at"]),
      changes,
    };
  });

  const signals = group(snapshot.signals, "decision_id");
  let decisionSignals = 0;
  const decisionLines: JsonValue[] = snapshot.decisions.map((row) => {
    const id = str(row["id"]);
    const owner = { set: withheldOwners.decisions, id };
    const reasonRef = optionalString(row["reason_ref"]);
    const contentRef = optionalString(row["content_ref"]);
    const decisionSignalLines: JsonValue[] = (signals.get(id) ?? []).map((signal) => ({
      id: str(signal["id"]),
      signal: str(signal["signal"]),
      occurredAt: str(signal["occurred_at"]),
      delayMs: num(signal["delay_ms"]),
      detail: JSON.parse(str(signal["detail"])) as JsonValue,
      sourceRef: str(signal["source_ref"]),
      recordedAt: str(signal["recorded_at"]),
    }));
    decisionSignals += decisionSignalLines.length;
    return {
      id,
      kind: str(row["kind"]),
      scenario: optionalString(row["scenario"]),
      checkedAt: str(row["checked_at"]),
      counts: JSON.parse(str(row["counts"])) as JsonValue,
      verdict: optionalString(row["verdict"]),
      outcome: optionalString(row["outcome"]),
      reasonCode: str(row["reason_code"]),
      subjectRef: optionalString(row["subject_ref"]),
      inputs: JSON.parse(str(row["inputs"])) as JsonValue,
      reason: reasonRef === null ? null : exportedText(reasonRef, `decision/${id}/reason`, owner),
      content:
        contentRef === null ? null : exportedText(contentRef, `decision/${id}/content`, owner),
      pushSourceKey: optionalString(row["push_source_key"]),
      costMicros: num(row["cost_micros"]),
      durationMs: num(row["duration_ms"]),
      ownerRating: optionalString(row["owner_rating"]),
      ratedAt: optionalString(row["rated_at"]),
      category: optionalString(row["category"]),
      confidencePermille: optionalNumber(row["confidence_permille"]),
      inferred: optionalFlag(row["inferred"]),
      signals: decisionSignalLines,
    };
  });

  const evidence = options.withEvidence === true ? buildEvidence(snapshot, texts) : null;

  const files: PortableFiles = new Map();
  const roles = new Map<string, "data" | "schema" | "markdown" | "sealed">();
  const lineCounts = new Map<string, number>();
  const put = (
    path: string,
    role: "data" | "schema" | "markdown" | "sealed",
    content: string | Uint8Array,
    lines: number,
  ): void => {
    files.set(path, typeof content === "string" ? encoder.encode(content) : content);
    roles.set(path, role);
    lineCounts.set(path, lines);
  };
  put(DATA_FILES.memories, "data", jsonLines(memoryLines), memoryLines.length);
  put(DATA_FILES.people, "data", jsonLines(peopleLines), peopleLines.length);
  put(DATA_FILES.importBatches, "data", jsonLines(batchLines), batchLines.length);
  put(DATA_FILES.consolidations, "data", jsonLines(consolidationLines), consolidationLines.length);
  put(DATA_FILES.decisions, "data", jsonLines(decisionLines), decisionLines.length);
  for (const { path, schema } of SCHEMA_FILES)
    put(path, "schema", `${JSON.stringify(schema, null, 2)}\n`, 0);
  const markdown = renderMemoryMarkdown(memoryLines as unknown as readonly MarkdownMemory[]);
  for (const [path, content] of markdown.files) put(path, "markdown", content, 0);
  put(INDEX_FILE, "markdown", markdown.index, 0);

  let sealedEvidenceRows = 0;
  if (options.sealPassphrase !== undefined) {
    sealedEvidenceRows = evidence
      ? Object.values(evidence).reduce<number>(
          (total, rows) => total + (rows as unknown as readonly unknown[]).length,
          0,
        )
      : 0;
    const sealed = await sealJson(options.sealPassphrase, {
      format: FORMAT_VERSION,
      originals,
      evidence,
    });
    put(SEALED_FILE, "sealed", sealed, 0);
  }

  const omitted: { what: string; count: number | null; reason: string }[] = [
    {
      what: "正在删除或已删除的记忆",
      count: snapshot.omittedMemories,
      reason: "尊重删除，不导出",
    },
    {
      what: "分级为受限（restricted）的记忆",
      count: snapshot.restrictedMemories,
      reason: "按产品规则不应存在；遇到时只计数，不导出",
    },
    {
      what: "写入时原文已被删除的历史版本和引用原话",
      count: unavailableHistory.events + unavailableHistory.quotes,
      reason: "文字已按删除流程清除，无从导出",
    },
    { what: "对话和消息", count: null, reason: "不属于本格式；记忆的来源对话编号也不导出" },
    { what: "每日摘要", count: null, reason: "属于对话，随对话一起，不在本格式内" },
    {
      what: "检索索引和向量",
      count: null,
      reason: "可重建的派生数据；导入后服务启动时按当时的向量模型自动补建",
    },
  ];
  if (options.withEvidence !== true)
    omitted.push({
      what: "决策的模型输入输出原文、邮件检查结果、Muse 校准记录",
      count: null,
      reason: "可能含邮件正文等第三方内容；加 --with-evidence 才导出，且只放进密封文件",
    });

  const counts: PortableCounts = {
    memories: memoryLines.length,
    memoryHistoryEvents: historyEvents,
    people: peopleLines.length,
    importBatches: batchLines.length,
    consolidations: consolidationLines.length,
    consolidationChanges,
    decisions: decisionLines.length,
    decisionSignals,
    markdownMemories: markdown.count,
    sealedOriginals: options.sealPassphrase === undefined ? 0 : Object.keys(originals).length,
    sealedEvidenceRows,
  };
  const manifest: PortableManifest = {
    format: FORMAT_VERSION,
    migrationSequence: options.migrationSequence,
    exportedAt: options.now(),
    egressRuleset: options.policy.rulesetVersion,
    files: [...files.keys()].sort().map((path) => ({
      path,
      role: roles.get(path) ?? "data",
      bytes: files.get(path)?.byteLength ?? 0,
      lines: lineCounts.get(path) ?? 0,
      sha256: sha256Hex(files.get(path) ?? new Uint8Array()),
    })),
    counts,
    withheld: {
      texts: withheldKeys.size,
      memories: withheldOwners.memories.size,
      decisions: withheldOwners.decisions.size,
    },
    omitted,
  };
  files.set(
    MANIFEST_FILE,
    encoder.encode(
      `${JSON.stringify(JSON.parse(canonicalJson(manifest as unknown as JsonValue)), null, 2)}\n`,
    ),
  );
  return { files, manifest };
}

function buildEvidence(
  snapshot: ReturnType<typeof readSnapshot>,
  texts: ReadonlyMap<string, string>,
): { [key: string]: JsonValue } {
  const payloadOf = (ref: string): JsonValue => {
    const record = snapshot.payloads.get(ref);
    const text = texts.get(ref);
    if (record === undefined || "unavailable" in record || text === undefined)
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.PAYLOAD_UNAVAILABLE, ref);
    return { classification: record.dataClassification, contentType: record.contentType, text };
  };
  const optionalPayload = (value: unknown): JsonValue => {
    if (value === null) return null;
    const record = snapshot.payloads.get(str(value));
    return record === undefined || "unavailable" in record ? null : payloadOf(str(value));
  };
  return {
    decisionPayloads: snapshot.decisionPayloads.map((row) => ({
      decisionId: str(row["decision_id"]),
      sequence: num(row["sequence"]),
      role: str(row["role"]),
      payload: payloadOf(str(row["payload_ref"])),
    })),
    sourceInsights: snapshot.sourceInsights.map((row) => ({
      id: str(row["id"]),
      source: str(row["source"]),
      threadId: str(row["thread_id"]),
      lastMessageId: str(row["last_message_id"]),
      result: str(row["result"]),
      floorRaised: flag(row["floor_raised"]),
      content: payloadOf(str(row["content_ref"])),
      dueAt: optionalString(row["due_at"]),
      priority: optionalString(row["priority"]),
      status: str(row["status"]),
      decisionId: str(row["decision_id"]),
      ownerRating: optionalString(row["owner_rating"]),
      pushSourceKey: optionalString(row["push_source_key"]),
      createdAt: str(row["created_at"]),
      updatedAt: str(row["updated_at"]),
      pushClass: optionalString(row["push_class"]),
    })),
    processedMessages: snapshot.processedMessages.map((row) => ({
      source: str(row["source"]),
      messageId: str(row["message_id"]),
      threadId: str(row["thread_id"]),
      decisionId: str(row["decision_id"]),
      outcome: str(row["outcome"]),
      skipReason: optionalString(row["skip_reason"]),
      header: optionalPayload(row["header_ref"]),
      processedAt: str(row["processed_at"]),
      reviewedAt: optionalString(row["reviewed_at"]),
      ownerRating: optionalString(row["owner_rating"]),
      receivedAt: optionalString(row["received_at"]),
    })),
    museEntries: snapshot.museEntries.map((row) => ({
      id: str(row["id"]),
      museAt: str(row["muse_at"]),
      museReminded: flag(row["muse_reminded"]),
      timingOk: optionalFlag(row["timing_ok"]),
      contentOk: optionalFlag(row["content_ok"]),
      content: optionalPayload(row["content_ref"]),
      note: optionalPayload(row["note_ref"]),
      pairedDecisionId: optionalString(row["paired_decision_id"]),
      intakeItemKey: optionalString(row["intake_item_key"]),
      recordedAt: str(row["recorded_at"]),
      pairedMessageId: optionalString(row["paired_message_id"]),
    })),
  };
}
