import type { PayloadRecord } from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { proposalTextDigest } from "../external-proposal-text.js";
import { canonicalJson, type JsonValue, jsonLines, sha256Hex } from "./canonical.js";
import { type MarkdownMemory, renderMemoryMarkdown } from "./markdown.js";
import {
  assertRuleHistory,
  assertRuleIdentifiers,
  enforcedRuleCount,
  type PortableRule,
  type PortableRuleVersion,
  type RuleSuspendReason,
  RULES_INDEX_FILE,
  renderRulesMarkdown,
  ruleParametersKey,
} from "./rules.js";
import {
  DATA_FILES,
  externalProposalDigestKey,
  externalProposalTextKey,
  FORMAT_VERSION,
  INDEX_FILE,
  MANIFEST_FILE,
  MAXIMUM_LINE_LENGTH,
  ownerProposalBasisKey,
  ownerProposalExecutionKey,
  PERCEPTION_FILE_KEYS,
  type PerceptionFileKey,
  RULE_PARAMETERS_MAXIMUM_LENGTH,
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
  SHORT_TEXT_OMISSION_LABEL,
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
  readonly onProgress?: (textsRead: number, textsTotal: number) => void;
  readonly signal?: AbortSignal;
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

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export async function buildPortableExport(options: ExportOptions): Promise<ExportResult> {
  if (options.withEvidence === true && options.sealPassphrase === undefined)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.EVIDENCE_REQUIRES_SEAL);
  const snapshot = readSnapshot(options.database, options.scope, options.withEvidence === true);
  const texts = new Map<string, string>();
  const restrictedRefs = new Set(
    snapshot.restrictedMemoryTexts.map((row) => str(row["content_ref"])),
  );
  let unreadableRestricted = 0;
  let textsRead = 0;
  options.signal?.throwIfAborted();
  options.onProgress?.(textsRead, snapshot.payloads.size);
  for (const [ref, payload] of snapshot.payloads) {
    options.signal?.throwIfAborted();
    textsRead += 1;
    if ("unavailable" in payload) {
      if (restrictedRefs.has(ref)) unreadableRestricted += 1;
      options.onProgress?.(textsRead, snapshot.payloads.size);
      continue;
    }
    const read = async () =>
      decoder.decode(
        await options.protector.unprotect({
          ownerId: options.scope.ownerId,
          agentId: options.scope.agentId,
          payload,
        }),
      );
    if (!restrictedRefs.has(ref)) texts.set(ref, await read());
    else {
      const text = await read().catch(() => null);
      if (text === null) unreadableRestricted += 1;
      else texts.set(ref, text);
    }
    options.onProgress?.(textsRead, snapshot.payloads.size);
  }
  options.signal?.throwIfAborted();
  const restrictedDigests = new Set<string>();
  for (const row of snapshot.restrictedMemoryTexts) {
    const text = texts.get(str(row["content_ref"]));
    if (text !== undefined) restrictedDigests.add(proposalTextDigest(text));
  }
  for (const row of snapshot.externalProposals)
    if (row["restricted_link"] === 1) restrictedDigests.add(str(row["text_sha256"]));
  const restrictedProposal = (row: Row): boolean => {
    if (row["restricted_link"] === 1 || restrictedDigests.has(str(row["text_sha256"]))) return true;
    const contentRef = optionalString(row["content_ref"]);
    const text = contentRef === null ? undefined : texts.get(contentRef);
    return text !== undefined && restrictedDigests.has(proposalTextDigest(text));
  };
  const exportedProposals = snapshot.externalProposals.filter((row) => !restrictedProposal(row));
  const restrictedProposals = snapshot.externalProposals.length - exportedProposals.length;
  const exportedProposalIds = new Set(exportedProposals.map((row) => str(row["id"])));
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
  let replacedShortTexts = 0;
  const shortTextNumbers = new Map<string, number>();
  const existingPlaceholderMax = (() => {
    let highest = 0;
    const scanned = JSON.stringify([
      snapshot.entities,
      snapshot.aliases,
      snapshot.provenance,
      snapshot.people,
      snapshot.decisions,
      snapshot.signals,
      snapshot.rules,
      snapshot.ruleHistory,
      exportedProposals,
      snapshot.ownerProposals.map((row) => [
        row["summary"],
        row["effect"],
        row["source_ref"],
        row["source_version"],
      ]),
      snapshot.externalProposalKeys.filter((row) =>
        exportedProposalIds.has(str(row["proposal_id"])),
      ),
      snapshot.externalProposalUnkeyed.filter((row) =>
        exportedProposalIds.has(str(row["proposal_id"])),
      ),
    ]);
    for (const match of scanned.matchAll(/\[已扣留:(\d{1,6})\]/g))
      highest = Math.max(highest, Number(match[1]));
    return highest;
  })();
  const safeString = (value: string): string => {
    if (!options.policy.hasSecret(value)) return value;
    replacedShortTexts += 1;
    let number = shortTextNumbers.get(value);
    if (number === undefined) {
      number = existingPlaceholderMax + shortTextNumbers.size + 1;
      shortTextNumbers.set(value, number);
    }
    return `[已扣留:${number}]`;
  };
  const safeOptional = (value: string | null): string | null =>
    value === null ? null : safeString(value);
  const safeJson = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return safeString(value);
    if (Array.isArray(value)) return value.map(safeJson);
    if (value !== null && typeof value === "object") {
      const result: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(value))
        result[safeString(key)] = safeJson(item as JsonValue);
      return result;
    }
    return value;
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
  const keepMemoryRef = (id: string | null): string | null =>
    id !== null && memoryIds.has(id) ? id : null;
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
    (history.get(id) ?? []).forEach((event) => {
      const index = events.length;
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
      provenance: (provenance.get(id) ?? [])
        .map((source) => ({
          sourceType: str(source["source_type"]),
          sourceId: safeString(str(source["source_id"])),
          sourceDeleted: flag(source["source_deleted"]),
        }))
        .sort((left, right) =>
          compareText(
            `${left.sourceType}\u0000${left.sourceId}`,
            `${right.sourceType}\u0000${right.sourceId}`,
          ),
        ),
      entities: (entities.get(id) ?? [])
        .map((entity) => safeString(str(entity["name"])))
        .sort(compareText),
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
      name: safeString(str(row["name"])),
      relation: safeOptional(optionalString(row["relation"])),
      reverseRelation: safeOptional(optionalString(row["reverse_relation"])),
      mergedInto: mergedInto !== null && personIds.has(mergedInto) ? mergedInto : null,
      createdAt: str(row["created_at"]),
      updatedAt: str(row["updated_at"]),
      aliases: (aliases.get(id) ?? [])
        .map((alias) => safeString(str(alias["alias"])))
        .sort(compareText),
    };
  });

  const batchLines: JsonValue[] = snapshot.importBatches.map((row) => ({
    id: str(row["id"]),
    source: str(row["source"]),
    itemCount: num(row["item_count"]),
    createdAt: str(row["created_at"]),
    undoneAt: optionalString(row["undone_at"]),
  }));

  const pairedDeviceLines: JsonValue[] = snapshot.pairedDevices.map((row) => ({
    id: str(row["id"]),
    kind: str(row["kind"]),
    name: safeString(str(row["name"])),
    releaseChannel: str(row["release_channel"]),
    status: str(row["status"]),
    pairedAt: str(row["paired_at"]),
    confirmedAt: optionalString(row["confirmed_at"]),
    revokedAt: optionalString(row["revoked_at"]),
    lastSeenAt: optionalString(row["last_seen_at"]),
  }));

  const instant = (value: unknown): string => new Date(num(value)).toISOString();
  const scaled = (value: unknown, divisor: number): Nullable<number> =>
    value === null ? null : num(value) / divisor;
  const stored = (value: unknown): JsonValue => safeJson(JSON.parse(str(value)) as JsonValue);
  const perceptionLines: Record<PerceptionFileKey, JsonValue[]> = {
    perceptionRecords: snapshot.perception.perceptionRecords.map((row) => {
      const id = str(row["id"]);
      const contentRef = optionalString(row["content_ref"]);
      return {
        id,
        type: str(row["type"]),
        origin: str(row["origin"]),
        captureSource: str(row["capture_source"]),
        occurredAt: instant(row["occurred_at_ms"]),
        deviceTime: str(row["occurred_at_device"]),
        localDay: str(row["local_day"]),
        deviceId: str(row["device_id"]),
        confidence: num(row["confidence"]),
        speakerKind: optionalString(row["speaker_kind"]),
        speakerRef: safeOptional(optionalString(row["speaker_ref"])),
        episodeId: optionalString(row["episode_id"]),
        classification: str(row["data_classification"]),
        evidence: stored(row["evidence"]),
        content: contentRef === null ? null : exportedText(contentRef, `perception/${id}/content`),
      };
    }),
    perceptionEpisodes: snapshot.perception.perceptionEpisodes.map((row) => ({
      id: str(row["id"]),
      startedAt: instant(row["started_at_ms"]),
      endedAt: instant(row["ended_at_ms"]),
      localDay: str(row["local_day"]),
      recordCount: num(row["record_count"]),
    })),
    deviceMirrorItems: snapshot.perception.deviceMirrorItems.map((row) => ({
      deviceId: str(row["device_id"]),
      kind: str(row["kind"]),
      externalId: safeString(str(row["external_id"])),
      version: num(row["version"]),
      updatedAt: instant(row["updated_at_ms"]),
      data: stored(row["data"]),
    })),
    trackPoints: snapshot.perception.trackPoints.map((row) => ({
      deviceId: str(row["device_id"]),
      occurredAt: instant(row["occurred_at_ms"]),
      latitude: num(row["latitude_e7"]) / 1e7,
      longitude: num(row["longitude_e7"]) / 1e7,
      accuracyMeters: scaled(row["accuracy_dm"], 10),
      speedMetersPerSecond: scaled(row["speed_cms"], 100),
    })),
    perceptionSettings: snapshot.perception.perceptionSettings.map((row) => ({
      disabledSenses: JSON.parse(str(row["disabled_senses"])) as JsonValue,
      pausedFrom: optionalString(row["paused_from"]),
      pausedUntil: optionalString(row["paused_until"]),
      retentionDays: JSON.parse(str(row["retention_days"])) as JsonValue,
      limitOverrides: JSON.parse(str(row["limit_overrides"])) as JsonValue,
      updatedAt: str(row["updated_at"]),
    })),
    limitUsage: snapshot.perception.limitUsage.map((row) => ({
      key: str(row["key"]),
      periodStart: str(row["period_start"]),
      deviceId: str(row["device_id"]) === "" ? null : str(row["device_id"]),
      used: num(row["used"]),
    })),
  };
  const perceptionCounts = Object.fromEntries(
    PERCEPTION_FILE_KEYS.map((key) => [key, perceptionLines[key].length]),
  ) as Record<PerceptionFileKey, number>;

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
          beforeSupersededBy: keepMemoryRef(optionalString(change["before_superseded_by"])),
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

  const changesByReview = group(snapshot.reviewChanges, "review_id");
  let conversationReviewChanges = 0;
  const reviewLines: JsonValue[] = snapshot.reviews.map((review) => {
    const changes: JsonValue[] = (changesByReview.get(str(review["id"])) ?? [])
      .filter((change) => memoryIds.has(str(change["memory_id"])))
      .map((change) => ({
        memoryId: str(change["memory_id"]),
        action: str(change["action"]),
        afterRevision: num(change["after_revision"]),
        beforeSupersededBy: keepMemoryRef(optionalString(change["before_superseded_by"])),
        beforeValidTo: optionalString(change["before_valid_to"]),
        createdAt: str(change["created_at"]),
        undoneRevision: change["undone_revision"] === null ? null : num(change["undone_revision"]),
      }));
    conversationReviewChanges += changes.length;
    return {
      id: str(review["id"]),
      day: str(review["day"]),
      status: str(review["status"]),
      attempts: num(review["attempts"]),
      errorCode: optionalString(review["error_code"]),
      startedAt: str(review["started_at"]),
      finishedAt: optionalString(review["finished_at"]),
      undoneAt: optionalString(review["undone_at"]),
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
      detail: safeJson(JSON.parse(str(signal["detail"])) as JsonValue),
      sourceRef: safeString(str(signal["source_ref"])),
      recordedAt: str(signal["recorded_at"]),
    }));
    decisionSignals += decisionSignalLines.length;
    return {
      id,
      kind: str(row["kind"]),
      scenario: optionalString(row["scenario"]),
      checkedAt: str(row["checked_at"]),
      counts: safeJson(JSON.parse(str(row["counts"])) as JsonValue),
      verdict: optionalString(row["verdict"]),
      outcome: optionalString(row["outcome"]),
      reasonCode: str(row["reason_code"]),
      subjectRef: safeOptional(optionalString(row["subject_ref"])),
      inputs: safeJson(JSON.parse(str(row["inputs"])) as JsonValue),
      reason: reasonRef === null ? null : exportedText(reasonRef, `decision/${id}/reason`, owner),
      content:
        contentRef === null ? null : exportedText(contentRef, `decision/${id}/content`, owner),
      pushSourceKey: safeOptional(optionalString(row["push_source_key"])),
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

  const withheldRules = new Set<string>();
  let droppedRuleMemoryLinks = 0;
  const hasSecretLeaf = (value: JsonValue): boolean => {
    if (typeof value === "string") return options.policy.hasSecret(value);
    if (Array.isArray(value)) return value.some(hasSecretLeaf);
    if (value !== null && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) => options.policy.hasSecret(key) || hasSecretLeaf(item as JsonValue),
      );
    return false;
  };
  const maskedText = (value: string): string => {
    if (!options.policy.hasSecret(value)) return value;
    const masked = options.policy.mask(value);
    return options.policy.hasSecret(masked) ? WITHHELD_PLACEHOLDER : masked;
  };
  const maskLeaves = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return maskedText(value);
    if (Array.isArray(value)) return value.map(maskLeaves);
    if (value !== null && typeof value === "object") {
      const result: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(value))
        result[maskedText(key)] = maskLeaves(item as JsonValue);
      return result;
    }
    return value;
  };
  const ruleParameters = (
    raw: unknown,
    key: string,
    ruleId: string,
  ): { parameters: string; withheld?: true } => {
    const parameters = str(raw);
    const parsed = JSON.parse(parameters) as JsonValue;
    if ([...parameters].length > RULE_PARAMETERS_MAXIMUM_LENGTH)
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        `规则 ${ruleId} 的参数超过 ${RULE_PARAMETERS_MAXIMUM_LENGTH} 个字符`,
      );
    if (!hasSecretLeaf(parsed) && JSON.stringify(parsed) === parameters) return { parameters };
    withheldKeys.add(key);
    withheldRules.add(ruleId);
    originals[key] = parameters;
    return { parameters: JSON.stringify(maskLeaves(parsed)), withheld: true };
  };
  const ruleMemoryLink = (value: unknown): string | null => {
    const id = optionalString(value);
    const kept = keepMemoryRef(id);
    if (id !== null && kept === null) droppedRuleMemoryLinks += 1;
    return kept;
  };
  let droppedRuleSuggestions = 0;
  const ruleHistory = group(snapshot.ruleHistory, "rule_id");
  const ruleLines: PortableRule[] = snapshot.rules.map((row) => {
    const ruleId = str(row["rule_id"]);
    const history: PortableRuleVersion[] = (ruleHistory.get(ruleId) ?? []).map((version) => ({
      revision: num(version["revision"]),
      status: str(version["status"]) as PortableRuleVersion["status"],
      source: safeString(str(version["source"])),
      sourceMemoryId: ruleMemoryLink(version["source_memory_id"]),
      changeReason: safeOptional(optionalString(version["change_reason"])),
      changedAt: str(version["changed_at"]),
      ...ruleParameters(
        version["parameters"],
        ruleParametersKey(ruleId, num(version["revision"])),
        ruleId,
      ),
    }));
    const rule: PortableRule = {
      ruleId,
      revision: num(row["revision"]),
      status: str(row["status"]) as PortableRule["status"],
      source: safeString(str(row["source"])),
      sourceMemoryId: ruleMemoryLink(row["source_memory_id"]),
      updatedAt: str(row["updated_at"]),
      ...ruleParameters(row["parameters"], ruleParametersKey(ruleId), ruleId),
      ...(row["suspend_reason"] === null || row["suspend_reason"] === undefined
        ? {}
        : { suspendReason: str(row["suspend_reason"]) as RuleSuspendReason }),
      history,
    };
    if (row["suggestion"] !== null && row["suggestion"] !== undefined) droppedRuleSuggestions += 1;
    assertRuleIdentifiers(rule);
    assertRuleHistory(rule);
    return rule;
  });
  const ruleHistoryVersions = ruleLines.reduce((total, { history }) => total + history.length, 0);

  const proposalKeys = group(snapshot.externalProposalKeys, "proposal_id");
  const proposalUnkeyed = group(snapshot.externalProposalUnkeyed, "proposal_id");
  const proposalLines: JsonValue[] = exportedProposals.map((row) => {
    const id = str(row["id"]);
    const contentRef = optionalString(row["content_ref"]);
    const content =
      contentRef === null ? null : requiredText(contentRef, externalProposalTextKey(id));
    const withheld =
      content !== null && (content as { readonly withheld?: boolean }).withheld === true;
    const digest = str(row["text_sha256"]);
    if (withheld) originals[externalProposalDigestKey(id)] = digest;
    const supersededBy = optionalString(row["superseded_by"]);
    const memoryId = keepMemoryRef(optionalString(row["memory_id"]));
    return {
      id,
      subjectRef: safeString(str(row["subject_ref"])),
      client: safeString(str(row["client"])),
      sourceKey: safeOptional(optionalString(row["source_key"])),
      textSha256: withheld ? null : digest,
      normalization: str(row["normalization"]),
      category: str(row["category"]),
      classification: str(row["classification"]),
      status: str(row["status"]),
      receivedAt: str(row["received_at"]),
      decidedAt: optionalString(row["decided_at"]),
      batchId:
        (str(row["status"]) === "committed" && memoryId === null) || content === null
          ? null
          : optionalString(row["batch_id"]),
      memoryId,
      supersededBy:
        supersededBy !== null && exportedProposalIds.has(supersededBy) ? supersededBy : null,
      content,
      keys: (proposalKeys.get(id) ?? []).map((key) => ({
        client: safeString(str(key["client"])),
        sourceKey: safeString(str(key["source_key"])),
      })),
      unkeyedClients: (proposalUnkeyed.get(id) ?? []).map((entry) =>
        safeString(str(entry["client"])),
      ),
    };
  });

  const ownerProposalLines: JsonValue[] = snapshot.ownerProposals.map((row) => {
    const id = str(row["id"]);
    const basisRef = optionalString(row["evidence_ref"]);
    const executionRef = optionalString(row["execution_ref"]);
    return {
      id,
      type: str(row["type"]),
      summary: safeString(str(row["summary"])),
      effect: safeString(str(row["effect"])),
      origin: str(row["origin"]),
      sourceRef: safeOptional(optionalString(row["source_ref"])),
      sourceVersion: safeOptional(optionalString(row["source_version"])),
      version: Number(row["version"]),
      fingerprint: str(row["fingerprint"]),
      status: str(row["status"]),
      execStatus: str(row["exec_status"]),
      proposedAt: str(row["proposed_at"]),
      expiresAt: str(row["expires_at"]),
      decidedAt: optionalString(row["decided_at"]),
      proposedCount: Number(row["proposed_count"]),
      rejectCount: Number(row["reject_count"]),
      lastRejectedAt: optionalString(row["last_rejected_at"]),
      attempts: Number(row["attempts"]),
      executedAt: optionalString(row["executed_at"]),
      requiresFullRead: row["requires_full_read"] === 1,
      requiresPresence: row["requires_presence"] === 1,
      basis: basisRef === null ? null : exportedText(basisRef, ownerProposalBasisKey(id)),
      execution:
        executionRef === null ? null : exportedText(executionRef, ownerProposalExecutionKey(id)),
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
  put(DATA_FILES.pairedDevices, "data", jsonLines(pairedDeviceLines), pairedDeviceLines.length);
  for (const key of PERCEPTION_FILE_KEYS)
    put(DATA_FILES[key], "data", jsonLines(perceptionLines[key]), perceptionLines[key].length);
  put(DATA_FILES.consolidations, "data", jsonLines(consolidationLines), consolidationLines.length);
  put(DATA_FILES.conversationReviews, "data", jsonLines(reviewLines), reviewLines.length);
  put(DATA_FILES.decisions, "data", jsonLines(decisionLines), decisionLines.length);
  const rulesText = jsonLines(ruleLines as unknown as readonly JsonValue[]);
  for (const [index, line] of rulesText.split("\n").entries())
    if (line.length > MAXIMUM_LINE_LENGTH)
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        `规则 ${ruleLines[index]?.ruleId ?? ""} 连同历史超过单行上限`,
      );
  put(DATA_FILES.rules, "data", rulesText, ruleLines.length);
  put(DATA_FILES.externalProposals, "data", jsonLines(proposalLines), proposalLines.length);
  put(DATA_FILES.ownerProposals, "data", jsonLines(ownerProposalLines), ownerProposalLines.length);
  for (const { path, schema } of SCHEMA_FILES)
    put(path, "schema", `${JSON.stringify(schema, null, 2)}\n`, 0);
  const markdown = renderMemoryMarkdown(memoryLines as unknown as readonly MarkdownMemory[]);
  for (const [path, content] of markdown.files) put(path, "markdown", content, 0);
  put(INDEX_FILE, "markdown", markdown.index, 0);
  put(RULES_INDEX_FILE, "markdown", renderRulesMarkdown(ruleLines, WITHHELD_PLACEHOLDER), 0);

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
      what: "保存进受限（restricted）记忆的其他 agent 提议，以及正文和它相同的提议",
      count: restrictedProposals,
      reason:
        "正文和受限记忆的文字（当前文字、历史版本或主人的原话）相同，或已保存进受限记忆；和受限记忆一样不导出，明文和封存文件里都没有",
    },
    {
      what: "读不出文字、没法和提议比较的受限（restricted）记忆版本",
      count: unreadableRestricted,
      reason: "密文缺失或解不开；和它同文的提议认不出来，会照常导出",
    },
    {
      what: "写入时原文已被删除的历史版本和引用原话",
      count: unavailableHistory.events + unavailableHistory.quotes,
      reason: "文字已按删除流程清除，无从导出",
    },
    {
      what: SHORT_TEXT_OMISSION_LABEL,
      count: replacedShortTexts,
      reason:
        "已换成编号占位（接着库里已有占位的最大编号往后排；同一原文同一编号，不同原文不同编号）；这些是名称和编号，原文不保留，不进封存文件",
    },
    {
      what: "规则暂停时系统算出的建议值",
      count: droppedRuleSuggestions,
      reason: "只是待你确认的建议，导入后规则仍是暂停状态，你可以恢复原规则或确认停用",
    },
    {
      what: "等你确认的待重审记忆标记",
      count: snapshot.openMemoryReviews,
      reason: "是本机的待办清单，不进导出；导入后从空清单开始",
    },
    {
      what: "规则出处里指向未导出记忆的链接",
      count: droppedRuleMemoryLinks,
      reason: "那条记忆已删除或分级为受限，不在导出里；链接置空，规则本身照常导出",
    },
    { what: "对话和消息", count: null, reason: "不属于本格式；记忆的来源对话编号也不导出" },
    { what: "每日摘要", count: null, reason: "属于对话，随对话一起，不在本格式内" },
    {
      what: "检索索引和向量",
      count: null,
      reason: "可重建的派生数据；导入后服务启动时按当时的向量模型自动补建",
    },
    {
      what: "配对设备的公钥、配对码和请求随机值",
      count: null,
      reason:
        "是凭据，不导出；设备的名字、种类和状态在 data/paired-devices.jsonl 里，只供查看，导入时不恢复，换库后设备要重新配对",
    },
    {
      what: "苹果推送令牌和通知按钮凭据",
      count: null,
      reason: "是凭据，不导出；换库后设备重新配对时会重新登记推送令牌，旧通知上的按钮失效",
    },
    {
      what: "上传凭据，和还没处理的原始音频、图片、屏幕画面",
      count: null,
      reason:
        "上传凭据是凭据，不导出；原始材料只是等待处理的临时文件，超过配置的天数（runPolicy.perception.mediaRetentionDays）后，在下一次有设备交数据时删除，不属于长期数据。感知记录、一段经历、镜像、轨迹、感知设置和用量在 data/ 下各有一个文件，只供查看，导入时不恢复",
    },
    {
      what: "记忆评测的题库和每次评测的分数",
      count: null,
      reason:
        "评测用的派生数据：题目由模型从记忆和原话生成，导入后下一次评测会从导入的记忆重新出题；分数只是统计数字",
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
    pairedDevices: pairedDeviceLines.length,
    ...perceptionCounts,
    consolidations: consolidationLines.length,
    consolidationChanges,
    conversationReviews: reviewLines.length,
    conversationReviewChanges,
    decisions: decisionLines.length,
    decisionSignals,
    markdownMemories: markdown.count,
    rules: ruleLines.length,
    enforcedRules: enforcedRuleCount(ruleLines),
    externalProposals: proposalLines.length,
    ownerProposals: ownerProposalLines.length,
    ruleHistoryVersions,
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
      rules: withheldRules.size,
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
    prereviews: snapshot.prereviews.map((row) => ({
      id: str(row["id"]),
      decisionId: optionalString(row["decision_id"]),
      mailSource: optionalString(row["mail_source"]),
      messageId: optionalString(row["message_id"]),
      group: str(row["calibration_group"]),
      category: optionalString(row["category"]),
      status: str(row["status"]),
      rating: optionalString(row["rating"]),
      confidencePermille: optionalNumber(row["confidence_permille"]),
      historyConflict: optionalFlag(row["history_conflict"]),
      failureCode: optionalString(row["failure_code"]),
      modelRef: str(row["model_ref"]),
      promptId: str(row["prompt_id"]),
      textDigest: str(row["text_digest"]),
      dataClassification: str(row["data_classification"]),
      costMicros: num(row["cost_micros"]),
      durationMs: num(row["duration_ms"]),
      createdAt: str(row["created_at"]),
    })),
  };
}
