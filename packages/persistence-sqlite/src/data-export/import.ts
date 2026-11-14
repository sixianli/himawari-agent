import { randomUUID } from "node:crypto";
import type { PayloadRecord } from "@himawari-agent/application";
import { PROACTIVE_SOURCE_NAMES } from "@himawari-agent/application/proactive-sources";
import type Database from "better-sqlite3";
import { proposalTextDigest } from "../external-proposal-text.js";
import type { JsonValue } from "./canonical.js";
import {
  assertRuleHistory,
  enforcedRuleCount,
  type PortableRule,
  type PortableRuleVersion,
  ruleParametersKey,
  storedRuleProblem,
} from "./rules.js";
import { validateAgainst } from "./schema.js";
import {
  externalProposalDigestKey,
  EMPTY_PERCEPTION_COUNTS,
  externalProposalTextKey,
  ownerProposalBasisKey,
  ownerProposalExecutionKey,
  RULE_PARAMETERS_MAXIMUM_LENGTH,
  SEALED_FILE,
  SEALED_SCHEMA,
} from "./schemas.js";
import { unsealJson } from "./seal.js";
import {
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  type ExportScope,
  type PortableCounts,
  type PortableFiles,
  type PortableTextDependencies,
} from "./types.js";
import { isKnownMemorySourceType, PERCEPTION_MEMORY_SOURCE_ID } from "../memory-source-types.ts";
import {
  type ParsedExternalProposal,
  type ParsedMemory,
  type ParsedOwnerProposal,
  type ParsedText,
  parsePortable,
} from "./verify.js";

export interface ImportOptions extends PortableTextDependencies {
  readonly database: Database.Database;
  readonly scope: ExportScope;
  readonly migrationSequence: number;
  readonly now: () => string;
  readonly passphrase?: string;
  readonly dryRun?: boolean;
  readonly newPayloadRef?: () => string;
  readonly proactiveSources?: readonly string[];
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly imported: PortableCounts;
  readonly skipped: {
    readonly memoriesWithoutOriginal: number;
    readonly historyEventsWithoutOriginal: number;
    readonly decisionTextsWithoutOriginal: number;
    readonly rulesWithoutOriginal: number;
    readonly externalProposalsWithoutOriginal: number;
    readonly ownerProposalsWithoutOriginal: number;
    readonly evidenceNotImported: boolean;
  };
}

interface Sealed {
  readonly originals: { readonly [key: string]: string };
  readonly evidence: {
    readonly decisionPayloads: readonly {
      decisionId: string;
      sequence: number;
      role: string;
      payload: ParsedText;
    }[];
    readonly sourceInsights: readonly Record<string, unknown>[];
    readonly processedMessages: readonly Record<string, unknown>[];
    readonly museEntries: readonly Record<string, unknown>[];
    readonly prereviews: readonly Record<string, unknown>[];
  } | null;
}

const encoder = new TextEncoder();

const EMPTY_TARGET_TABLES = [
  "memory_records",
  "decision_ledger",
  "memory_people",
  "memory_import_batches",
  "memory_consolidation_runs",
  "memory_conversation_reviews",
  "source_insights",
  "proactive_processed_messages",
  "muse_reference_entries",
  "rule_book_rules",
  "rule_book_history",
  "external_memory_proposals",
  "owner_proposals",
] as const;

function assertEmptyTarget(database: Database.Database, scope: ExportScope): void {
  for (const table of EMPTY_TARGET_TABLES) {
    const found = database
      .prepare(`SELECT 1 FROM ${table} WHERE owner_id = ? AND agent_id = ? LIMIT 1`)
      .get(scope.ownerId, scope.agentId);
    if (found !== undefined)
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY, table);
  }
}

export async function importPortableExport(
  files: PortableFiles,
  options: ImportOptions,
): Promise<ImportReport> {
  const parsed = parsePortable(files, options.migrationSequence);
  const sealedBytes = files.get(SEALED_FILE);
  let sealed: Sealed | null = null;
  if (sealedBytes !== undefined && options.passphrase !== undefined) {
    const value = await unsealJson(options.passphrase, sealedBytes);
    const problem = validateAgainst(SEALED_SCHEMA, value);
    if (problem !== null) throw new DataExportError(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH, problem);
    sealed = value as unknown as Sealed;
    const evidenceRows = sealed.evidence
      ? Object.values(sealed.evidence).reduce((total, rows) => total + rows.length, 0)
      : 0;
    if (
      Object.keys(sealed.originals).length !== parsed.manifest.counts.sealedOriginals ||
      evidenceRows !== parsed.manifest.counts.sealedEvidenceRows
    )
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH, "密封文件条数和清单不符");
  }
  const proactiveSources: readonly string[] = options.proactiveSources ?? PROACTIVE_SOURCE_NAMES;
  const registered = (value: unknown, where: string): void => {
    if (value !== null && value !== undefined && !proactiveSources.includes(value as string))
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        `${where} 的来源 ${String(value)} 没有登记`,
      );
  };
  for (const decision of parsed.decisions) registered(decision.scenario, "决策记录");
  for (const row of sealed?.evidence?.sourceInsights ?? []) registered(row["source"], "提醒条目");
  for (const row of sealed?.evidence?.processedMessages ?? [])
    registered(row["source"], "已处理条目");
  for (const row of sealed?.evidence?.prereviews ?? []) registered(row["mailSource"], "预审记录");
  assertEmptyTarget(options.database, options.scope);

  const sealedText = (key: string): string | null => {
    const value: unknown = sealed?.originals[key];
    if (value === undefined) return null;
    if (typeof value !== "string")
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH, `${key} 的原文不是文字`);
    return value;
  };
  const original = (key: string, text: ParsedText): string | null =>
    text.withheld === true ? sealedText(key) : text.text;

  const skippedMemories = new Set<string>();
  let historyWithout = 0;
  let decisionWithout = 0;
  const memories: ParsedMemory[] = [];
  for (const memory of parsed.memories) {
    if (original(`memory/${memory.id}/content`, memory.content) === null) {
      skippedMemories.add(memory.id);
      continue;
    }
    memories.push(memory);
  }

  const now = options.now();
  const newRef = options.newPayloadRef ?? ((): string => `payload-import-${randomUUID()}`);
  const records: PayloadRecord[] = [];
  const protect = async (text: ParsedText, plaintext: string): Promise<string> => {
    const ref = newRef();
    records.push(
      await options.protector.protect({
        ownerId: options.scope.ownerId,
        agentId: options.scope.agentId,
        ref,
        dataClassification: text.classification as PayloadRecord["dataClassification"],
        contentType: text.contentType,
        plaintext: encoder.encode(plaintext),
        createdAt: now,
      }),
    );
    return ref;
  };

  interface MemoryPlan {
    readonly memory: ParsedMemory;
    readonly contentRef: string;
    readonly history: {
      event: ParsedMemory["history"][number];
      contentRef: string;
      quoteRef: string | null;
    }[];
  }
  const plans: MemoryPlan[] = [];
  for (const memory of memories) {
    const contentRef = await protect(
      memory.content,
      original(`memory/${memory.id}/content`, memory.content) ?? "",
    );
    const history: MemoryPlan["history"] = [];
    for (const [index, event] of memory.history.entries()) {
      const text = original(`memory/${memory.id}/history/${index}/content`, event.content);
      const quote =
        event.quote === null
          ? undefined
          : original(`memory/${memory.id}/history/${index}/quote`, event.quote);
      if (text === null || quote === null) {
        historyWithout += 1;
        continue;
      }
      history.push({
        event,
        contentRef: await protect(event.content, text),
        quoteRef:
          event.quote === null || quote === undefined ? null : await protect(event.quote, quote),
      });
    }
    plans.push({ memory, contentRef, history });
  }
  const decisionRefs = new Map<string, { content: string | null; reason: string | null }>();
  for (const decision of parsed.decisions) {
    const refs = { content: null as string | null, reason: null as string | null };
    for (const [slot, text] of [
      ["content", decision.content],
      ["reason", decision.reason],
    ] as const) {
      if (text === null) continue;
      const plain = original(`decision/${decision.id}/${slot}`, text);
      if (plain === null) {
        decisionWithout += 1;
        continue;
      }
      refs[slot] = await protect(text, plain);
    }
    decisionRefs.set(decision.id, refs);
  }

  const evidence = sealed?.evidence ?? null;
  const evidenceRefs = new Map<unknown, string>();
  if (evidence) {
    for (const row of evidence.decisionPayloads)
      evidenceRefs.set(row, await protect(row.payload, row.payload.text));
    for (const row of evidence.sourceInsights)
      evidenceRefs.set(
        row,
        await protect(row["content"] as ParsedText, (row["content"] as ParsedText).text),
      );
    for (const row of evidence.processedMessages)
      if (row["header"] !== null)
        evidenceRefs.set(
          row,
          await protect(row["header"] as ParsedText, (row["header"] as ParsedText).text),
        );
    for (const row of evidence.museEntries) {
      if (row["content"] !== null)
        evidenceRefs.set(
          `${String(row["id"])}/content`,
          await protect(row["content"] as ParsedText, (row["content"] as ParsedText).text),
        );
      if (row["note"] !== null)
        evidenceRefs.set(
          `${String(row["id"])}/note`,
          await protect(row["note"] as ParsedText, (row["note"] as ParsedText).text),
        );
    }
  }

  const importedMemoryIds = new Set(plans.map(({ memory }) => memory.id));
  const keptMemoryLink = (id: string | null): string | null =>
    id !== null && importedMemoryIds.has(id) ? id : null;
  const restoreVersion = <T extends PortableRuleVersion | PortableRule>(
    ruleId: string,
    version: T,
    key: string,
  ): T | null => {
    if (version.withheld !== true) return version;
    const parameters = sealedText(key);
    if (parameters === null) return null;
    if ([...parameters].length > RULE_PARAMETERS_MAXIMUM_LENGTH)
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
        `规则 ${ruleId} 的原文超过上限`,
      );
    const restored = { ...version, parameters } as T;
    const problem = storedRuleProblem(ruleId, restored);
    if (problem !== null) throw new DataExportError(DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH, problem);
    return restored;
  };
  let rulesWithout = 0;
  const rulePlans: { rule: PortableRule; history: PortableRuleVersion[] }[] = [];
  for (const rule of parsed.rules) {
    const current = restoreVersion(rule.ruleId, rule, ruleParametersKey(rule.ruleId));
    const history = rule.history.map((version) =>
      restoreVersion(rule.ruleId, version, ruleParametersKey(rule.ruleId, version.revision)),
    );
    if (current === null || history.some((version) => version === null)) {
      rulesWithout += 1;
      continue;
    }
    assertRuleHistory({ ...current, history: history as PortableRuleVersion[] });
    rulePlans.push({
      rule: { ...current, sourceMemoryId: keptMemoryLink(current.sourceMemoryId) },
      history: (history as PortableRuleVersion[]).map((version) => ({
        ...version,
        sourceMemoryId: keptMemoryLink(version.sourceMemoryId),
      })),
    });
  }
  const proposalPlans: {
    readonly proposal: ParsedExternalProposal;
    readonly textSha256: string;
    readonly contentRef: string | null;
  }[] = [];
  let proposalsWithout = 0;
  for (const proposal of parsed.externalProposals) {
    const withheld = proposal.content?.withheld === true;
    const digest = withheld
      ? sealedText(externalProposalDigestKey(proposal.id))
      : proposal.textSha256;
    const text =
      proposal.content === null
        ? null
        : original(externalProposalTextKey(proposal.id), proposal.content);
    if (digest === null || (proposal.content !== null && text === null)) {
      proposalsWithout += 1;
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(digest) || (text !== null && proposalTextDigest(text) !== digest))
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.SEAL_MISMATCH,
        `其他 agent 的提议 ${proposal.id} 的正文摘要不对`,
      );
    proposalPlans.push({
      proposal,
      textSha256: digest,
      contentRef:
        proposal.content === null || text === null ? null : await protect(proposal.content, text),
    });
  }
  const liveDigests = new Set<string>();
  for (const { proposal, textSha256 } of proposalPlans) {
    if (proposal.status === "superseded") continue;
    if (liveDigests.has(textSha256))
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        `其他 agent 的提议 ${proposal.id} 的正文摘要和另一条没被替换的提议重复`,
      );
    liveDigests.add(textSha256);
  }
  const ownerProposalPlans: {
    readonly proposal: ParsedOwnerProposal;
    readonly basisRef: string | null;
    readonly executionRef: string | null;
    readonly execStatus: string;
  }[] = [];
  let ownerProposalsWithout = 0;
  for (const proposal of parsed.ownerProposals) {
    const basis =
      proposal.basis === null ? null : original(ownerProposalBasisKey(proposal.id), proposal.basis);
    const execution =
      proposal.execution === null
        ? null
        : original(ownerProposalExecutionKey(proposal.id), proposal.execution);
    if (
      (proposal.basis !== null && basis === null) ||
      (proposal.execution !== null && execution === null)
    ) {
      ownerProposalsWithout += 1;
      continue;
    }
    ownerProposalPlans.push({
      proposal,
      basisRef:
        proposal.basis === null || basis === null ? null : await protect(proposal.basis, basis),
      executionRef:
        proposal.execution === null || execution === null
          ? null
          : await protect(proposal.execution, execution),
      execStatus:
        proposal.execStatus === "running" || proposal.execStatus === "executed_unverified"
          ? "unknown"
          : proposal.execStatus,
    });
  }
  const importedProposalIds = new Set(proposalPlans.map(({ proposal }) => proposal.id));
  const imported: PortableCounts = {
    memories: plans.length,
    memoryHistoryEvents: plans.reduce((total, { history }) => total + history.length, 0),
    people: parsed.people.length,
    importBatches: parsed.importBatches.length,
    pairedDevices: 0,
    ...EMPTY_PERCEPTION_COUNTS,
    consolidations: parsed.consolidations.length,
    consolidationChanges: 0,
    conversationReviews: parsed.conversationReviews.length,
    conversationReviewChanges: 0,
    decisions: parsed.decisions.length,
    decisionSignals: parsed.decisions.reduce((total, { signals }) => total + signals.length, 0),
    markdownMemories: parsed.manifest.counts.markdownMemories,
    rules: rulePlans.length,
    enforcedRules: enforcedRuleCount(rulePlans.map(({ rule }) => rule)),
    externalProposals: proposalPlans.length,
    ownerProposals: ownerProposalPlans.length,
    ruleHistoryVersions: rulePlans.reduce((total, { history }) => total + history.length, 0),
    sealedOriginals: options.passphrase === undefined ? 0 : parsed.manifest.counts.sealedOriginals,
    sealedEvidenceRows: evidence
      ? Object.values(evidence).reduce((total, rows) => total + rows.length, 0)
      : 0,
  };
  const keptChanges = parsed.consolidations.map((run) => ({
    run,
    changes: run.changes.filter(({ memoryId }) => importedMemoryIds.has(memoryId)),
  }));
  imported.consolidationChanges = keptChanges.reduce(
    (total, { changes }) => total + changes.length,
    0,
  );
  const keptReviews = parsed.conversationReviews.map((review) => ({
    review,
    changes: review.changes.filter(({ memoryId }) => importedMemoryIds.has(memoryId)),
  }));
  imported.conversationReviewChanges = keptReviews.reduce(
    (total, { changes }) => total + changes.length,
    0,
  );

  const report = (dryRun: boolean): ImportReport => ({
    dryRun,
    imported,
    skipped: {
      memoriesWithoutOriginal: skippedMemories.size,
      historyEventsWithoutOriginal: historyWithout,
      decisionTextsWithoutOriginal: decisionWithout,
      rulesWithoutOriginal: rulesWithout,
      externalProposalsWithoutOriginal: proposalsWithout,
      ownerProposalsWithoutOriginal: ownerProposalsWithout,
      evidenceNotImported: evidence === null && parsed.manifest.counts.sealedEvidenceRows > 0,
    },
  });
  for (const { memory } of plans)
    for (const source of memory.provenance)
      if (
        !isKnownMemorySourceType(source.sourceType) ||
        (source.sourceType === "perception" && !PERCEPTION_MEMORY_SOURCE_ID.test(source.sourceId))
      )
        throw new DataExportError(
          DATA_EXPORT_ERROR_CODES.LINE_INVALID,
          "记忆出处的类型或编号不合规",
        );
  if (options.dryRun === true) return report(true);

  const { ownerId, agentId } = options.scope;
  const database = options.database;
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext, ciphertext_path,
      content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type,
      encryption_metadata_json
    ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, NULL, ?, ?, ?, 'active', ?, ?, ?)`,
  );
  database
    .transaction(() => {
      database.pragma("defer_foreign_keys = ON");
      for (const record of records)
        insertPayload.run(
          record.ref,
          ownerId,
          agentId,
          record.dataClassification,
          record.ciphertext,
          record.contentDigest,
          record.encryption.algorithm,
          record.encryption.keyRef,
          record.createdAt,
          record.contentType,
          JSON.stringify(record.encryption),
        );
      const batch = database.prepare(
        `INSERT INTO memory_import_batches (id, owner_id, agent_id, source, item_count, created_at, undone_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of parsed.importBatches)
        batch.run(
          item.id,
          ownerId,
          agentId,
          item.source,
          item.itemCount,
          item.createdAt,
          item.undoneAt,
        );
      const person = database.prepare(
        `INSERT INTO memory_people (id, owner_id, agent_id, name, relation, reverse_relation, merged_into, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const alias = database.prepare(
        "INSERT INTO memory_person_aliases (person_id, alias) VALUES (?, ?)",
      );
      for (const item of parsed.people) {
        person.run(
          item.id,
          ownerId,
          agentId,
          item.name,
          item.relation,
          item.reverseRelation,
          item.mergedInto,
          item.createdAt,
          item.updatedAt,
        );
        for (const name of item.aliases) alias.run(item.id, name);
      }
      const memory = database.prepare(
        `INSERT INTO memory_records (
          id, owner_id, agent_id, revision, status, content_ref, classification, source_thread_id,
          inference, confidence_permille, policy_version, updated_at,
          last_used_at, category, importance_permille, valid_from, valid_to, superseded_by,
          use_count, evidence_verified, sensitive_topic, recorded_at, tentative, sub_category,
          import_batch_id, stance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const history = database.prepare(
        `INSERT INTO memory_history_events (memory_id, kind, content_ref, stance, quote_ref, source_thread_id, source_deleted, occurred_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      const provenance = database.prepare(
        "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES (?, ?, ?, ?)",
      );
      const entity = database.prepare(
        "INSERT INTO memory_entities (memory_id, name) VALUES (?, ?)",
      );
      const mention = database.prepare(
        "INSERT INTO memory_person_mentions (memory_id, person_id) VALUES (?, ?)",
      );
      const pin = database.prepare(
        "INSERT INTO memory_profile_pins (memory_id, owner_id, agent_id, pinned, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const plan of plans) {
        const item = plan.memory;
        memory.run(
          item.id,
          ownerId,
          agentId,
          item.revision,
          item.status,
          plan.contentRef,
          item.classification,
          item.inference ? 1 : 0,
          item.confidencePermille,
          item.policyVersion,
          item.updatedAt,
          item.lastUsedAt,
          item.category,
          item.importancePermille,
          item.validFrom,
          item.validTo,
          item.supersededBy !== null && importedMemoryIds.has(item.supersededBy)
            ? item.supersededBy
            : null,
          item.useCount,
          item.evidenceVerified ? 1 : 0,
          item.sensitiveTopic,
          item.recordedAt,
          item.tentative ? 1 : 0,
          item.subCategory,
          item.importBatchId,
          item.stance,
        );
        for (const event of plan.history)
          history.run(
            item.id,
            event.event.kind,
            event.contentRef,
            event.event.stance,
            event.quoteRef,
            event.event.sourceDeleted ? 1 : 0,
            event.event.occurredAt,
          );
        for (const source of item.provenance) {
          provenance.run(
            item.id,
            source.sourceType,
            source.sourceId,
            source.sourceDeleted || source.sourceType === "perception" ? 1 : 0,
          );
        }
        for (const name of item.entities) entity.run(item.id, name);
        for (const personId of item.personIds) mention.run(item.id, personId);
        if (item.pin)
          pin.run(item.id, ownerId, agentId, item.pin.pinned ? 1 : 0, item.pin.updatedAt);
      }
      const indexable = plans.filter(({ memory: item }) => item.status === "active");
      const suffix = randomUUID();
      const threadId = `data-import-thread-${suffix}`;
      if (indexable.length > 0 || keptReviews.length > 0)
        database
          .prepare(
            `INSERT INTO threads (
              id, owner_id, agent_id, revision, status, created_at, updated_at, archived_at
            ) VALUES (?, ?, ?, 1, 'open', ?, ?, ?)`,
          )
          .run(threadId, ownerId, agentId, now, now, now);
      if (indexable.length > 0) {
        const checkpointId = `data-import-checkpoint-${suffix}`;
        const generationId = `data-import-generation-${suffix}`;
        database
          .prepare(
            `INSERT INTO thread_checkpoint_jobs (
              id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
              policy_version, status, attempt_count, requested_at
            ) VALUES (?, ?, ?, ?, ?, 1, 1, 'data-import', 'completed', 1, ?)`,
          )
          .run(checkpointId, generationId, ownerId, agentId, threadId, now);
        database
          .prepare(
            `INSERT INTO memory_generations (
              id, checkpoint_job_id, owner_id, agent_id, thread_id, status, model_descriptor_ref,
              policy_version, output_ref
            ) VALUES (?, ?, ?, ?, ?, 'completed', 'data-import', 'data-import', NULL)`,
          )
          .run(generationId, checkpointId, ownerId, agentId, threadId);
        const job = database.prepare(
          `INSERT INTO memory_projection_jobs (
            id, memory_id, memory_revision, generation_id, operation, status, attempt_count
          ) VALUES (?, ?, ?, ?, 'upsert', 'pending', 0)`,
        );
        for (const plan of indexable)
          job.run(
            `data-import-projection-${randomUUID()}`,
            plan.memory.id,
            plan.memory.revision,
            generationId,
          );
      }
      const run = database.prepare(
        `INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id, status, reviewed_through, model_called, change_count, error_code, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const change = database.prepare(
        `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id, related_memory_id, action, before_revision, after_revision, before_status, before_superseded_by, before_valid_to, created_at, undone_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const basis = database.prepare(
        "INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id) VALUES (?, ?, ?)",
      );
      for (const { run: item, changes } of keptChanges) {
        run.run(
          item.id,
          ownerId,
          agentId,
          item.day,
          item.triggerRunId,
          item.status,
          item.reviewedThrough,
          item.modelCalled ? 1 : 0,
          item.changeCount,
          item.errorCode,
          item.startedAt,
          item.finishedAt,
        );
        for (const entry of changes) {
          change.run(
            entry.id,
            item.id,
            ownerId,
            agentId,
            entry.memoryId,
            entry.relatedMemoryId !== null && importedMemoryIds.has(entry.relatedMemoryId)
              ? entry.relatedMemoryId
              : null,
            entry.action,
            entry.beforeRevision,
            entry.afterRevision,
            entry.beforeStatus,
            entry.beforeSupersededBy !== null && importedMemoryIds.has(entry.beforeSupersededBy)
              ? entry.beforeSupersededBy
              : null,
            entry.beforeValidTo,
            entry.createdAt,
            entry.undoneAt,
          );
          const kept = entry.basis.filter((id) => importedMemoryIds.has(id));
          for (const [position, id] of kept.entries()) basis.run(entry.id, position, id);
        }
      }
      const review = database.prepare(
        `INSERT INTO memory_conversation_reviews (id, owner_id, agent_id, thread_id, episode_id, episode_created_at, day, status, attempts, output_ref, error_code, started_at, finished_at, undone_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      );
      const reviewChange = database.prepare(
        `INSERT INTO memory_conversation_review_changes (review_id, memory_id, action, source_message_id, after_revision, before_superseded_by, before_valid_to, created_at, undone_revision)
        VALUES (?, ?, ?, 'data-import', ?, ?, ?, ?, ?)`,
      );
      for (const { review: item, changes } of keptReviews) {
        review.run(
          item.id,
          ownerId,
          agentId,
          threadId,
          `data-import-episode:${item.id}`,
          item.startedAt,
          item.day,
          item.status,
          item.attempts,
          item.errorCode,
          item.startedAt,
          item.finishedAt,
          item.undoneAt,
        );
        for (const entry of changes)
          reviewChange.run(
            item.id,
            entry.memoryId,
            entry.action,
            entry.afterRevision,
            entry.beforeSupersededBy !== null && importedMemoryIds.has(entry.beforeSupersededBy)
              ? entry.beforeSupersededBy
              : null,
            entry.beforeValidTo,
            entry.createdAt,
            entry.undoneRevision,
          );
      }
      const decision = database.prepare(
        `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const signal = database.prepare(
        `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of parsed.decisions) {
        const refs = decisionRefs.get(item.id) ?? { content: null, reason: null };
        decision.run(
          item.id,
          ownerId,
          agentId,
          item.kind,
          item.scenario,
          item.checkedAt,
          JSON.stringify(item.counts),
          item.verdict,
          item.outcome,
          item.reasonCode,
          item.subjectRef,
          JSON.stringify(item.inputs),
          refs.reason,
          refs.content,
          item.pushSourceKey,
          item.costMicros,
          item.durationMs,
          item.ownerRating,
          item.ratedAt,
          item.category,
          item.confidencePermille,
          item.inferred === null ? null : item.inferred ? 1 : 0,
        );
        for (const entry of item.signals)
          signal.run(
            entry.id,
            ownerId,
            agentId,
            item.id,
            entry.signal,
            entry.occurredAt,
            entry.delayMs,
            JSON.stringify(entry.detail),
            entry.sourceRef,
            entry.recordedAt,
          );
      }
      const ruleRow = database.prepare(
        `INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id, updated_at, suspend_reason, review_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ruleVersion = database.prepare(
        `INSERT INTO rule_book_history (owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id, change_reason, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { rule, history: versions } of rulePlans) {
        ruleRow.run(
          ownerId,
          agentId,
          rule.ruleId,
          rule.revision,
          rule.parameters,
          rule.status,
          rule.source,
          rule.sourceMemoryId,
          rule.updatedAt,
          rule.suspendReason ?? null,
          rule.status === "needs_review" ? rule.updatedAt : null,
        );
        for (const version of versions)
          ruleVersion.run(
            ownerId,
            agentId,
            rule.ruleId,
            version.revision,
            version.parameters,
            version.status,
            version.source,
            version.sourceMemoryId,
            version.changeReason,
            version.changedAt,
          );
      }
      const proposal = database.prepare(
        `INSERT INTO external_memory_proposals (
          id, owner_id, agent_id, subject_ref, client, source_key, text_sha256, normalization,
          content_ref, category, classification, status, received_at, decided_at, batch_id,
          memory_id, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const proposalKey = database.prepare(
        `INSERT INTO external_memory_proposal_keys (owner_id, agent_id, client, source_key, proposal_id)
        VALUES (?, ?, ?, ?, ?)`,
      );
      const proposalUnkeyed = database.prepare(
        "INSERT INTO external_memory_proposal_unkeyed (proposal_id, client) VALUES (?, ?)",
      );
      for (const plan of proposalPlans) {
        const item = plan.proposal;
        proposal.run(
          item.id,
          ownerId,
          agentId,
          item.subjectRef,
          item.client,
          item.sourceKey,
          plan.textSha256,
          item.normalization,
          plan.contentRef,
          item.category,
          item.classification,
          item.status,
          item.receivedAt,
          item.decidedAt,
          (item.status === "committed" && keptMemoryLink(item.memoryId) === null) ||
            plan.contentRef === null
            ? null
            : item.batchId,
          keptMemoryLink(item.memoryId),
          item.supersededBy !== null && importedProposalIds.has(item.supersededBy)
            ? item.supersededBy
            : null,
        );
        for (const key of item.keys)
          proposalKey.run(ownerId, agentId, key.client, key.sourceKey, item.id);
        for (const client of item.unkeyedClients) proposalUnkeyed.run(item.id, client);
      }
      const ownerProposal = database.prepare(
        `INSERT INTO owner_proposals (
          id, owner_id, agent_id, type, summary, effect, origin, thread_id, source_ref,
          source_version, version, fingerprint, evidence_ref, status, proposed_at, expires_at,
          decided_at, proposed_count, reject_count, last_rejected_at, exec_status, lease_id,
          lease_expires_at, attempts, requires_full_read, requires_presence, executed_at,
          execution_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      );
      for (const plan of ownerProposalPlans) {
        const item = plan.proposal;
        ownerProposal.run(
          item.id,
          ownerId,
          agentId,
          item.type,
          item.summary,
          item.effect,
          item.origin,
          item.sourceRef,
          item.sourceVersion,
          item.version,
          item.fingerprint,
          plan.basisRef,
          item.status,
          item.proposedAt,
          item.expiresAt,
          item.decidedAt,
          item.proposedCount,
          item.rejectCount,
          item.lastRejectedAt,
          plan.execStatus,
          item.attempts,
          item.requiresFullRead ? 1 : 0,
          item.requiresPresence ? 1 : 0,
          item.executedAt,
          plan.executionRef,
        );
      }
      if (evidence) writeEvidence(database, ownerId, agentId, evidence, evidenceRefs);
    })
    .immediate();
  return report(false);
}

function writeEvidence(
  database: Database.Database,
  ownerId: string,
  agentId: string,
  evidence: NonNullable<Sealed["evidence"]>,
  refs: ReadonlyMap<unknown, string>,
): void {
  const payload = database.prepare(
    "INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref) VALUES (?, ?, ?, ?)",
  );
  for (const row of evidence.decisionPayloads)
    payload.run(row.decisionId, row.sequence, row.role, refs.get(row));
  const insight = database.prepare(
    `INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key, created_at, updated_at, push_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of evidence.sourceInsights)
    insight.run(
      row["id"],
      ownerId,
      agentId,
      row["source"],
      row["threadId"],
      row["lastMessageId"],
      row["result"],
      row["floorRaised"] ? 1 : 0,
      refs.get(row),
      row["dueAt"],
      row["priority"],
      row["status"],
      row["decisionId"],
      row["ownerRating"],
      row["pushSourceKey"],
      row["createdAt"],
      row["updatedAt"],
      row["pushClass"],
    );
  const processed = database.prepare(
    `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of evidence.processedMessages)
    processed.run(
      ownerId,
      agentId,
      row["source"],
      row["messageId"],
      row["threadId"],
      row["decisionId"],
      row["outcome"],
      row["skipReason"],
      refs.get(row) ?? null,
      row["processedAt"],
      row["reviewedAt"],
      row["ownerRating"],
      row["receivedAt"],
    );
  const muse = database.prepare(
    `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const bit = (value: unknown): number | null => (value === null ? null : value ? 1 : 0);
  for (const row of evidence.museEntries)
    muse.run(
      row["id"],
      ownerId,
      agentId,
      row["museAt"],
      row["museReminded"] ? 1 : 0,
      bit(row["timingOk"]),
      bit(row["contentOk"]),
      refs.get(`${String(row["id"])}/content`) ?? null,
      refs.get(`${String(row["id"])}/note`) ?? null,
      row["pairedDecisionId"],
      row["intakeItemKey"],
      row["recordedAt"],
      row["pairedMessageId"],
    );
  const prereview = database.prepare(
    `INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, mail_source, message_id, calibration_group, category, status, rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of evidence.prereviews ?? [])
    prereview.run(
      row["id"],
      ownerId,
      agentId,
      row["decisionId"],
      row["mailSource"],
      row["messageId"],
      row["group"],
      row["category"],
      row["status"],
      row["rating"],
      row["confidencePermille"],
      bit(row["historyConflict"]),
      row["failureCode"],
      row["modelRef"],
      row["promptId"],
      row["textDigest"],
      row["dataClassification"],
      row["costMicros"],
      row["durationMs"],
      row["createdAt"],
    );
}

export type { JsonValue };
