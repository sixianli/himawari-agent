import {
  ApplicationPortError,
  type ClockPort,
  classificationRank,
  type DataClassification,
  type DecisionLedgerPort,
  type DurableMemoryService,
  isModelVisible,
  isReviewChangeUndoable,
  type MailMatchParameters,
  type McpMemorySyncStorePort,
  MEMORY_REVIEW_EXPAND_BATCH,
  MEMORY_REVIEW_LIST_LIMIT,
  type MemoryBookStorePort,
  type MemoryCategory,
  type MemoryConsolidationStorePort,
  type MemoryConversationReviewStorePort,
  type MemoryExtractionAuditRecord,
  type MemoryHistoryEvent,
  type MemoryProjectionJobStatePort,
  type MemoryReminderStorePort,
  type MemoryReviewStorePort,
  type MemorySourceMessage,
  modelVisibleCeiling,
  type OwnerProfileService,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type RuleReviewOwnerStorePort,
  reviewMemoryVisible,
  type SensitiveMemoryApprovalStatePort,
  type SensitiveMemoryTopic,
  type UnitOfWorkPort,
} from "@himawari-agent/application";
import {
  APPROVAL_ALLOWANCE_DAYS_DEFAULT,
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  MEMORY_SENSITIVE_CATEGORY_NAMES,
  MEMORY_SOURCE_REF_MAX_LENGTH,
  RULE_CONDITION_FIELDS,
} from "@himawari-agent/gateway-contracts";
import { isConsolidationUndoable } from "@himawari-agent/memory-engine";
import type { BuiltInActionRuleSwitches } from "./action-rule-switches.js";
import type { OwnerAllowances } from "./owner-allowances.js";
import { type DecisionChainMemoryView, readDecisionChain } from "./production-decision-chain.js";
import {
  externalProposalBatchId,
  type ProductionMcpMemoryWriter,
} from "./production-mcp-memory-writer.js";
import {
  createProductionAutomaticMemory,
  protectedMemoryCandidates,
} from "./production-memory-capture.js";
import {
  DETERMINISTIC_SENSITIVE,
  deterministicallySensitive,
  type MemoryClassification,
  type ProductionMemoryClassifier,
  UNCLASSIFIED,
} from "./production-memory-classification.js";
import type { ProductionImportDuplicateChecker } from "./production-memory-import-duplicates.js";
import { OwnerRuleError, type ProductionOwnerRuleWriter } from "./production-owner-rules.js";
import { ProductionReminderWriter, ReminderInputError } from "./production-reminder-writer.js";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type GenerationId = Parameters<DurableMemoryService["delete"]>[1];
type OverviewSnapshot = Extract<GatewayV2Snapshot, { type: "memory.overview.snapshot" }>;
type BasisSnapshot = Extract<GatewayV2Snapshot, { type: "memory.basis.snapshot" }>;
type ClassifySnapshot = Extract<GatewayV2Snapshot, { type: "memory.classify.snapshot" }>;
type ImportDuplicateResultView = Awaited<
  ReturnType<ProductionImportDuplicateChecker["check"]>
>[number];
type ImportDuplicatesSnapshot = Extract<
  GatewayV2Snapshot,
  { type: "memory.import.duplicates.snapshot" }
>;
const BASIS_NODES_SHOWN = 200;
type Command<T extends GatewayV2Command["type"]> = Extract<GatewayV2Command, { type: T }>;

export const PRODUCTION_MEMORY_OPERATIONS = Object.freeze([
  "memory.overview.read",
  "memory.basis.read",
  "memory.classify.read",
  "memory.import.duplicates.read",
  "decision.chain.read",
  "memory.approval.respond",
  "memory.mutate",
  "memory.tidy.undo",
  "memory.conversationReview.undo",
  "memory.reminder.respond",
  "memory.reminder.create",
  "memory.rules.read",
  "memory.rule.respond",
  "memory.review.read",
  "memory.review.respond",
  "memory.review.reportMissed",
  "memory.create",
  "memory.category.set",
  "memory.settings.set",
  "memory.page.viewed",
  "memory.person.respond",
  "memory.import.commit",
  "memory.import.undo",
  "memory.external.respond",
  "memory.external.undo",
  "memory.mcpSync.projectDecide",
  "memory.mcpSync.noteDecide",
  "memory.mcpSync.attentionResolve",
] as const);
const SENSITIVE_JUDGMENTS_KEPT = 5000;
const PINNABLE_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
]);
const TIDY_UPS_SHOWN = 30;
const REMINDERS_SHOWN = 10;
const UPCOMING_SHOWN = 20;
const UPCOMING_WINDOW_MS = 60 * 24 * 3_600_000;
const CANCELLED_SHOWN = 20;
const INACTIVE_SHOWN = 500;
const HISTORY_BATCH = 1000;
const IMPORTS_SHOWN = 20;
const TRASH_RETENTION_MS = 7 * 24 * 3_600_000;
const SNOOZE_MS = 3_600_000;
const OWNER_POLICY_VERSION = "memory-owner:v1";
const OWNER_RULE_IMPORTANCE = 800;
const OWNER_MEMORY_IMPORTANCE = 500;
const IMPORT_POLICY_VERSION = "memory-import:v1";
const EXTERNAL_PROPOSALS_SHOWN = 100;
const EXTERNAL_BATCHES_SHOWN = 10;
const MCP_SYNC_ENTRIES_SHOWN = 200;

function unsupportedRuleAction(): never {
  throw new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "MEMORY_RULE_ACTION_UNSUPPORTED",
  );
}

function sensitiveTopicFor(category: MemoryCategory): SensitiveMemoryTopic {
  return category === "health" || category === "finance" ? category : "other";
}

function sensitiveCategory(category: MemoryCategory): boolean {
  return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category);
}

function nextYear(instant: string): string {
  const date = new Date(instant);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

const singleLine = (text: string) =>
  [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 2000);

function earliestSourceMessage(
  memory: Pick<ProductMemoryRecord, "sourceThreadId" | "sourceRefs">,
  messages: readonly MemorySourceMessage[],
): string | null {
  if (!memory.sourceThreadId) return null;
  const refs = new Set(memory.sourceRefs);
  const matching = messages
    .filter(
      ({ threadId, contentRef }) => threadId === memory.sourceThreadId && refs.has(contentRef),
    )
    .toSorted((left, right) => left.sequence - right.sequence);
  return matching[0]?.messageId ?? null;
}

export async function findSourceMessageIds(
  book: Pick<MemoryBookStorePort, "findOwnerMessages">,
  scope: {
    readonly ownerId: ProductMemoryRecord["ownerId"];
    readonly agentId: ProductMemoryRecord["agentId"];
  },
  records: readonly ProductMemoryRecord[],
): Promise<ReadonlyMap<string, string | null>> {
  const refsByThread = new Map<string, Set<string>>();
  for (const { sourceThreadId, sourceRefs } of records) {
    if (!sourceThreadId) continue;
    const refs = refsByThread.get(sourceThreadId) ?? new Set<string>();
    for (const ref of sourceRefs) if (ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH) refs.add(ref);
    refsByThread.set(sourceThreadId, refs);
  }
  const sourceMessages = await book.findOwnerMessages({
    ...scope,
    lookups: [...refsByThread].map(([threadId, refs]) => ({ threadId, refs: [...refs] })),
  });
  return new Map(
    records.map((memory) => [memory.id as string, earliestSourceMessage(memory, sourceMessages)]),
  );
}

const MEMORY_REVIEW_EXPAND_ROUNDS = 10;

export async function expandMemoryReviews(
  store: Pick<MemoryReviewStorePort, "expand">,
  scope: Pick<ProductConfiguration, "ownerId" | "agentId">,
  now: () => string,
): Promise<number> {
  let expanded = 0;
  for (let round = 0; round < MEMORY_REVIEW_EXPAND_ROUNDS; round += 1) {
    const batch = await store.expand({
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      now: now(),
      limit: MEMORY_REVIEW_EXPAND_BATCH,
    });
    expanded += batch;
    if (batch < MEMORY_REVIEW_EXPAND_BATCH) break;
  }
  return expanded;
}

export type OwnerRuleControl = Pick<
  ProductionOwnerRuleWriter,
  "list" | "undo" | "confirm" | "reconfirm"
>;

const RULE_QUOTE_CHAIN_MAX_DEPTH = 8;

export class ProductionMemoryControl {
  private readonly options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: ProductMemoryStatePort;
    readonly jobs: Pick<MemoryProjectionJobStatePort, "listByMemory">;
    readonly approvals: SensitiveMemoryApprovalStatePort;
    readonly unitOfWork: UnitOfWorkPort;
    readonly memory: Pick<
      DurableMemoryService,
      | "applyProposal"
      | "correct"
      | "delete"
      | "restore"
      | "restoreVersion"
      | "confirm"
      | "trash"
      | "recover"
      | "revise"
    >;
    readonly book: MemoryBookStorePort;
    readonly ledger?: DecisionLedgerPort;
    readonly profile?: Pick<OwnerProfileService, "outline">;
    readonly consolidation?: {
      readonly store: Pick<MemoryConsolidationStorePort, "listChanges" | "readBasisChain">;
      readonly undo: (changeId: string) => Promise<unknown>;
    };
    readonly conversationReviews?: {
      readonly store: Pick<MemoryConversationReviewStorePort, "listWithChanges" | "listChanges">;
      readonly undo: (reviewId: string) => Promise<unknown>;
    };
    readonly reminders?: Pick<
      MemoryReminderStorePort,
      "schedule" | "listDue" | "countDue" | "listUpcoming" | "listCancelled" | "read" | "update"
    >;
    readonly ownerRules?: OwnerRuleControl;
    readonly actionRules?: Pick<BuiltInActionRuleSwitches, "list" | "setAskFirst">;
    readonly allowances?: Pick<OwnerAllowances, "list" | "days">;
    readonly reviews?: {
      readonly memories: MemoryReviewStorePort;
      readonly rules: RuleReviewOwnerStorePort;
    };
    readonly payloads: PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly clock: ClockPort;
    readonly timeZone?: string;
    readonly externalProposals?: Pick<
      ProductionMcpMemoryWriter,
      "listPending" | "pendingSummary" | "listBatches" | "undoBatch" | "respond"
    >;
    readonly mcpSync?: McpMemorySyncStorePort;
    readonly classifier?: Pick<ProductionMemoryClassifier, "classify">;
    readonly importDuplicates?: Pick<ProductionImportDuplicateChecker, "check" | "existingLimit">;
    readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  };

  readonly #sensitiveJudgments = new Map<string, MemoryClassification>();

  constructor(options: ProductionMemoryControl["options"]) {
    this.options = options;
  }

  private async readText(ref: string): Promise<string> {
    const payload = await this.options.payloads.get(ref);
    if (!payload || payload.contentType !== "text/plain")
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
    const { ownerId, agentId } = this.options.configuration;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.options.protector.unprotect({ ownerId, agentId, payload }),
    );
  }

  private assertOwner(command: GatewayV2Command) {
    const { ownerId, agentId } = this.options.configuration;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "MEMORY_OWNER_REQUIRED");
  }

  private assertStorable(text: string) {
    if (text.trim().length === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
  }

  async #versionContent(
    current: ProductMemoryRecord,
    historyId: number,
  ): Promise<{
    readonly contentRef: string;
    readonly stance: string | null;
    readonly copied: boolean;
  }> {
    if (current.status !== "active" || (current.attributes?.supersededBy ?? null) !== null)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_VERSION_TARGET_NOT_CURRENT",
      );
    const event = await this.options.state.readHistory({ ...this.#scope(), id: historyId });
    if (!event || !(await this.#replacedInto(event.memoryId, current.id)))
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_VERSION_NOT_FOUND");
    const payload = await this.options.payloads.get(event.contentRef);
    if (!payload || payload.contentType !== "text/plain")
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
    const text = await this.readText(event.contentRef);
    this.assertStorable(text);
    if (
      singleLine(text) === singleLine(await this.readText(current.contentRef)) &&
      event.stance === (current.attributes?.stance ?? null)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_VERSION_ALREADY_CURRENT",
      );
    if (payload.dataClassification === current.dataClassification)
      return { contentRef: event.contentRef, stance: event.stance, copied: false };
    if (
      classificationRank(payload.dataClassification) >
      classificationRank(current.dataClassification)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_VERSION_CLASSIFICATION_HIGHER",
      );
    const { ownerId, agentId } = this.options.configuration;
    const copy = await this.options.protector.protect({
      ownerId,
      agentId,
      ref: `memory-version:${current.id}:${current.revision}:${historyId}`,
      dataClassification: current.dataClassification,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode(text),
      createdAt: this.options.clock.now(),
    });
    try {
      await this.options.payloads.put(copy);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        throw error;
      return { contentRef: copy.ref, stance: event.stance, copied: false };
    }
    return { contentRef: copy.ref, stance: event.stance, copied: true };
  }

  async #replacedInto(memoryId: MemoryId, headId: MemoryId): Promise<boolean> {
    const seen = new Set<MemoryId>();
    let next: MemoryId | null = memoryId;
    while (next !== null && !seen.has(next)) {
      if (next === headId) return true;
      seen.add(next);
      const record = await this.options.state.read(next);
      const { ownerId, agentId } = this.options.configuration;
      if (
        !record ||
        record.ownerId !== ownerId ||
        record.agentId !== agentId ||
        record.status !== "active"
      )
        return false;
      next = (record.attributes?.supersededBy ?? null) as MemoryId | null;
    }
    return false;
  }

  #scope() {
    const { ownerId, agentId } = this.options.configuration;
    return { ownerId, agentId };
  }

  #trashCutoff(): string {
    return new Date(Date.parse(this.options.clock.now()) - TRASH_RETENTION_MS).toISOString();
  }

  async #generationFor(memoryId: MemoryId | null): Promise<GenerationId> {
    const own = memoryId
      ? (await this.options.jobs.listByMemory(memoryId)).at(-1)?.generationId
      : undefined;
    const generation = own ?? (await this.options.book.latestGeneration(this.#scope()));
    if (!generation)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_GENERATION_MISSING",
      );
    return generation;
  }

  async #purgeExpiredTrash() {
    const expired = await this.options.book.listExpiredTrash({
      ...this.#scope(),
      trashedBefore: this.#trashCutoff(),
      limit: 50,
    });
    for (const memoryId of expired)
      await this.options.memory.delete(memoryId, await this.#generationFor(memoryId));
  }

  async #inactive() {
    return this.options.book.listInactive({
      ...this.#scope(),
      trashedAfter: this.#trashCutoff(),
      limit: INACTIVE_SHOWN,
    });
  }

  async revision(): Promise<string> {
    const { ownerId, agentId } = this.options.configuration;
    const scope = this.#scope();
    const active = await this.options.state.listActive(ownerId, agentId);
    const inactive = await this.#inactive();
    const historyCount = new Map<string, number>();
    const tracked = [...active, ...inactive].map(({ id }) => id);
    for (let index = 0; index < tracked.length; index += HISTORY_BATCH)
      for (const { memoryId } of await this.options.state.listHistory({
        ownerId,
        agentId,
        memoryIds: tracked.slice(index, index + HISTORY_BATCH),
      }))
        historyCount.set(memoryId, (historyCount.get(memoryId) ?? 0) + 1);
    const settings = await this.options.book.readSettings(scope);
    const people = await this.options.book.listPeople(scope);
    const suggestions = await this.options.book.listPersonSuggestions(scope);
    const imports = await this.options.book.listImportBatches({ ...scope, limit: IMPORTS_SHOWN });
    const pins = await this.options.book.listProfilePins(scope);
    const pending = await this.options.approvals.listPending(ownerId, null);
    const changes =
      (await this.options.consolidation?.store.listChanges({
        ownerId,
        agentId,
        limit: TIDY_UPS_SHOWN,
      })) ?? [];
    const reviews =
      (await this.options.conversationReviews?.store.listWithChanges({
        ownerId,
        agentId,
        limit: TIDY_UPS_SHOWN,
      })) ?? [];
    const due = await this.#dueReminders();
    const external = (await this.options.externalProposals?.pendingSummary(
      EXTERNAL_PROPOSALS_SHOWN,
    )) ?? { total: 0, items: [] };
    const externalBatches =
      (await this.options.externalProposals?.listBatches(EXTERNAL_BATCHES_SHOWN)) ?? [];
    return JSON.stringify([
      active.map(({ id, revision }) => [id, revision, historyCount.get(id) ?? 0]),
      pending.map(({ id }) => id),
      changes.map(({ id, undoneAt }) => [id, undoneAt]),
      reviews.map(({ id, undoneAt }) => [id, undoneAt]),
      due.map(({ id, updatedAt }) => [id, updatedAt]),
      inactive.map(({ id, revision }) => [id, revision]),
      settings.updatedAt,
      (await this.options.book.latestGeneration(scope)) ?? null,
      people.map(({ id, updatedAt, memoryIds }) => [id, updatedAt, memoryIds.length]),
      suggestions.map(({ id }) => id),
      imports.map(({ id, undoneAt }) => [id, undoneAt]),
      pins.map(({ memoryId, pinned, updatedAt }) => [memoryId, pinned, updatedAt]),
      external.total,
      external.items.map(({ id, dataClassification }) => [id, dataClassification]),
      externalBatches.map(({ batchId, decidedAt }) => [batchId, decidedAt]),
    ]);
  }

  async externalProposalViews(limit: number) {
    const { total, items } = await this.#externalProposals(limit);
    return { total, items };
  }

  async rulesNeedingReview() {
    const rules = ((await this.options.ownerRules?.list()) ?? []).filter(
      ({ status }) => status === "needs_review",
    );
    return Promise.all(
      rules.map(async (rule) => ({
        ...rule,
        dataClassification: await this.#ruleClassification(rule.sourceMemoryId),
      })),
    );
  }

  async #ruleClassification(
    sourceMemoryId: string | null,
  ): Promise<ProductMemoryRecord["dataClassification"]> {
    const { ownerId, agentId } = this.options.configuration;
    const record = sourceMemoryId
      ? await this.options.state.read(sourceMemoryId as MemoryId).catch(() => undefined)
      : undefined;
    if (
      !record ||
      record.ownerId !== ownerId ||
      record.agentId !== agentId ||
      record.status === "trashed" ||
      record.status === "deletion_pending" ||
      record.status === "deleted_verified"
    )
      return "sensitive";
    return classificationRank(record.dataClassification) > classificationRank("private")
      ? record.dataClassification
      : "private";
  }

  async pendingRequests() {
    const { ownerId, agentId } = this.options.configuration;
    const candidates = protectedMemoryCandidates(this.options);
    const pending: (OverviewSnapshot["payload"]["pending"][number] & {
      readonly dataClassification: ProductMemoryRecord["dataClassification"];
    })[] = [];
    for (const request of await this.options.approvals.listPending(ownerId, null)) {
      if (request.agentId !== agentId) continue;
      const candidate = await candidates.read(request).catch(() => undefined);
      const text = candidate ? singleLine(candidate.text) : "";
      if (!candidate || !text) continue;
      pending.push({
        requestId: request.id,
        threadId: request.threadId,
        sourceRef: request.sourceRef,
        text,
        topic: candidate.sensitiveTopic ?? "other",
        requestedAt: request.requestedAt,
        dataClassification: request.dataClassification,
      });
    }
    return pending;
  }

  async dueReminderViews(limit: number) {
    const { ownerId, agentId } = this.options.configuration;
    const now = this.options.clock.now();
    const rows = (await this.options.reminders?.listDue({ ownerId, agentId, now, limit })) ?? [];
    const total =
      rows.length < limit
        ? rows.length
        : ((await this.options.reminders?.countDue({ ownerId, agentId, now })) ?? rows.length);
    const reminded = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: rows.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const items: {
      readonly reminderId: string;
      readonly memoryId: string;
      readonly text: string;
      readonly dueAt: string;
      readonly remindAt: string;
      readonly sourceThreadId: string | null;
      readonly dataClassification: ProductMemoryRecord["dataClassification"];
    }[] = [];
    for (const reminder of rows) {
      const memory = reminded.get(reminder.memoryId);
      const text = memory ? singleLine(await this.readText(memory.contentRef).catch(() => "")) : "";
      if (!memory || !text) continue;
      items.push({
        reminderId: reminder.id,
        memoryId: reminder.memoryId,
        text,
        dueAt: reminder.dueAt,
        remindAt: reminder.remindAt,
        sourceThreadId: memory.sourceThreadId ?? null,
        dataClassification: memory.dataClassification,
      });
    }
    return {
      items,
      rowIds: rows.map(({ id }) => id),
      unread: Math.max(0, total - rows.length),
    };
  }

  async upcomingViews(input: {
    readonly now: string;
    readonly until: string;
    readonly limit: number;
    readonly exclude: ReadonlySet<string>;
    readonly notYetDue?: boolean;
  }) {
    const { ownerId, agentId } = this.options.configuration;
    const { exclude } = input;
    const coming = (
      (await this.options.reminders?.listUpcoming({
        ownerId,
        agentId,
        from: input.now,
        to: input.until,
        limit: input.limit,
        ...(input.notYetDue ? { remindAfter: input.now } : {}),
      })) ?? []
    ).filter(({ id }) => !exclude.has(id));
    const comingMemories = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: coming.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const upcoming: (OverviewSnapshot["payload"]["upcoming"][number] & {
      readonly dataClassification: ProductMemoryRecord["dataClassification"];
    })[] = [];
    for (const reminder of coming) {
      const memory = comingMemories.get(reminder.memoryId);
      const text = memory ? singleLine(await this.readText(memory.contentRef).catch(() => "")) : "";
      if (!text) continue;
      upcoming.push({
        reminderId: reminder.id,
        memoryId: reminder.memoryId,
        text,
        dueAt: reminder.dueAt,
        repeat: reminder.repeat,
        sourceThreadId: memory?.sourceThreadId ?? null,
        dataClassification: memory?.dataClassification ?? "private",
      });
    }
    return upcoming;
  }

  async cancelledViews(limit: number) {
    const { ownerId, agentId } = this.options.configuration;
    const cancelled =
      (await this.options.reminders?.listCancelled({
        ownerId,
        agentId,
        limit,
      })) ?? [];
    const memories = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: cancelled.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const views: OverviewSnapshot["payload"]["cancelled"][number][] = [];
    for (const reminder of cancelled) {
      const memory = memories.get(reminder.memoryId);
      const text = memory ? singleLine(await this.readText(memory.contentRef).catch(() => "")) : "";
      if (!text) continue;
      views.push({
        reminderId: reminder.id,
        text,
        dueAt: reminder.dueAt,
        repeat: reminder.repeat,
      });
    }
    return views;
  }

  async tidyUpViews(limit: number) {
    const { ownerId, agentId } = this.options.configuration;
    const changes =
      (await this.options.consolidation?.store.listChanges({ ownerId, agentId, limit })) ?? [];
    const touched = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: [
            ...new Set(
              changes.flatMap(({ memoryId, relatedMemoryId }) =>
                relatedMemoryId ? [memoryId, relatedMemoryId] : [memoryId],
              ),
            ),
          ],
        })
      ).map((memory) => [memory.id, memory]),
    );
    const textOf = async (memoryId: string | null) => {
      const memory = memoryId ? touched.get(memoryId as MemoryId) : undefined;
      if (
        !memory ||
        memory.status === "deletion_pending" ||
        memory.status === "deleted_verified" ||
        memory.status === "trashed"
      )
        return null;
      return singleLine(await this.readText(memory.contentRef).catch(() => "")) || null;
    };
    const tidyUps: (OverviewSnapshot["payload"]["tidyUps"][number] & {
      readonly dataClassification: ProductMemoryRecord["dataClassification"];
    })[] = [];
    for (const change of changes) {
      const text = await textOf(change.memoryId);
      const memory = touched.get(change.memoryId);
      if (!text || !memory) continue;
      tidyUps.push({
        changeId: change.id,
        memoryId: change.memoryId,
        action: change.action,
        text,
        relatedText: await textOf(change.relatedMemoryId),
        createdAt: change.createdAt,
        undone: change.undoneAt !== null,
        undoable: isConsolidationUndoable(change, memory),
        dataClassification: memory.dataClassification,
      });
    }
    return tidyUps;
  }

  async conversationReviewViews(limit: number, options: { readonly lead: boolean }) {
    const { ownerId, agentId } = this.options.configuration;
    const conversationReviews: (OverviewSnapshot["payload"]["conversationReviews"][number] & {
      readonly lead: {
        readonly memoryId: string;
        readonly text: string;
        readonly dataClassification: ProductMemoryRecord["dataClassification"];
      } | null;
    })[] = [];
    for (const review of (await this.options.conversationReviews?.store.listWithChanges({
      ownerId,
      agentId,
      limit,
    })) ?? []) {
      const reviewChanges = (
        (await this.options.conversationReviews?.store.listChanges(review.id)) ?? []
      ).filter(({ afterRevision }) => afterRevision !== null);
      if (reviewChanges.length === 0) continue;
      const current = new Map(
        (
          await this.options.state.readMany({
            ownerId,
            agentId,
            memoryIds: reviewChanges.map(({ memoryId }) => memoryId),
          })
        ).map((memory) => [memory.id as string, memory]),
      );
      let lead: (typeof conversationReviews)[number]["lead"] = null;
      for (const { memoryId } of options.lead ? reviewChanges : []) {
        const memory = current.get(memoryId);
        if (!memory || memory.status !== "active") continue;
        const text = singleLine(await this.readText(memory.contentRef).catch(() => ""));
        if (!text) continue;
        lead = { memoryId, text, dataClassification: memory.dataClassification };
        break;
      }
      conversationReviews.push({
        reviewId: review.id,
        finishedAt: review.finishedAt ?? review.startedAt,
        undone: review.undoneAt !== null,
        undoable:
          review.undoneAt === null &&
          reviewChanges.every((change) =>
            isReviewChangeUndoable(change, current.get(change.memoryId)),
          ),
        changes: reviewChanges.map(({ memoryId, action }) => ({ memoryId, action })),
        lead,
      });
    }
    return conversationReviews;
  }

  async #externalProposals(limit: number) {
    const writer = this.options.externalProposals;
    if (!writer) return { total: 0, items: [], batches: [] };
    const { items, total } = await writer.listPending(limit);
    return {
      total,
      items: items.map(({ id, text, category, dataClassification, client, receivedAt }) => ({
        proposalId: id,
        text,
        category,
        dataClassification,
        client,
        receivedAt,
      })),
      batches: (await writer.listBatches(EXTERNAL_BATCHES_SHOWN)).map(
        ({ batchId, decidedAt, committed, rejected }) => ({
          batchId,
          decidedAt,
          committed,
          rejected,
        }),
      ),
    };
  }

  async #mcpSyncView() {
    const store = this.options.mcpSync;
    if (!store) return { entriesTotal: 0, entries: [], projects: [], attention: [] };
    const { ownerId, agentId } = this.options.configuration;
    const overview = await store.overview({ ownerId, agentId, limit: MCP_SYNC_ENTRIES_SHOWN });
    const entries = [];
    for (const row of overview.entries) {
      let text: string;
      try {
        text = await this.readText(row.contentRef);
      } catch {
        continue;
      }
      let previousText: string | null = null;
      if (row.previousContentRef !== null)
        try {
          previousText = await this.readText(row.previousContentRef);
        } catch {
          previousText = null;
        }
      entries.push({
        entryId: row.entryId,
        connectionName: row.connectionName,
        projectName: row.projectName,
        category: row.category,
        classification: row.classification,
        state: row.state,
        version: row.version,
        text,
        previousText,
        sourceDeleted: row.sourceDeleted,
        lastSyncedAt: row.lastSyncedAt,
      });
    }
    return {
      entriesTotal: overview.entriesTotal,
      entries,
      projects: overview.projects.map((project) => ({
        connectionId: project.connectionId,
        projectId: project.projectId,
        connectionName: project.connectionName,
        projectName: project.projectName,
        approval: project.approval,
      })),
      attention: overview.attention.map(
        ({ attentionId, projectName, heldEntries, baseline, createdAt, connectionName }) => ({
          attentionId,
          connectionName,
          projectName,
          heldEntries,
          baseline,
          createdAt,
        }),
      ),
    };
  }

  async #mcpSyncCommand(
    command: Command<
      | "memory.mcpSync.projectDecide"
      | "memory.mcpSync.noteDecide"
      | "memory.mcpSync.attentionResolve"
    >,
  ) {
    const store = this.options.mcpSync;
    if (!store)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    const { ownerId, agentId } = this.options.configuration;
    const now = this.options.clock.now();
    const missing = () =>
      new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_MCP_SYNC_TARGET_NOT_FOUND");
    if (command.type === "memory.mcpSync.projectDecide") {
      const { connectionId, projectId, decision } = command.payload;
      const result = await store.decideProject({
        ownerId,
        agentId,
        connectionId,
        projectId,
        decision,
        now,
      });
      if (!result.found) throw missing();
      return { resultRef: projectId, replayed: false };
    }
    if (command.type === "memory.mcpSync.noteDecide") {
      const { entryId, decision } = command.payload;
      const result = await store.decideNote({ ownerId, agentId, entryId, decision, now });
      if (!result.found) throw missing();
      return { resultRef: entryId, replayed: false };
    }
    const { attentionId, decision } = command.payload;
    const result = await store.resolveAttention({ ownerId, agentId, attentionId, decision, now });
    if (!result.found) throw missing();
    return { resultRef: attentionId, replayed: false };
  }

  async #dueReminders() {
    const { ownerId, agentId } = this.options.configuration;
    return (
      (await this.options.reminders?.listDue({
        ownerId,
        agentId,
        now: this.options.clock.now(),
        limit: REMINDERS_SHOWN,
      })) ?? []
    );
  }

  async #basisChain(
    query: Extract<GatewayV2Query, { type: "memory.basis.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const { memoryId } = query.payload;
    if (!this.options.consolidation)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    const { ownerId, agentId } = this.options.configuration;
    const root = await this.options.consolidation.store.readBasisChain({
      ownerId,
      agentId,
      memoryId: memoryId as MemoryId,
    });
    const nodes: BasisSnapshot["payload"]["nodes"][number][] = [];
    const queued = [root];
    let complete = true;
    for (const node of queued) {
      if (nodes.length >= BASIS_NODES_SHOWN) {
        complete = false;
        break;
      }
      nodes.push({
        memoryId: node.memoryId,
        changeId: node.change?.id ?? null,
        action: node.change?.action ?? null,
        changedAt: node.change?.createdAt ?? null,
        decisionRecordId: node.ledgerId,
        basisMemoryIds: node.basis.map((child) => child.memoryId),
        repeated: node.repeated,
        truncated: node.truncated,
      });
      queued.push(...node.basis);
    }
    if (nodes.some(({ truncated }) => truncated)) complete = false;
    return {
      ...query,
      kind: "snapshot",
      type: "memory.basis.snapshot",
      payload: { memoryId, nodes, complete },
    };
  }

  async #ruleQuote(
    sourceMemoryId: string | null,
    summary: string,
  ): Promise<{
    readonly quote: string | null;
    readonly quoteSuperseded: boolean;
    readonly quoteLatestMemoryId: string | null;
  }> {
    const none = { quote: null, quoteSuperseded: false, quoteLatestMemoryId: null };
    if (!sourceMemoryId) return none;
    const record = await this.options.state.read(sourceMemoryId as MemoryId);
    if (!record || !this.#quotable(record)) return none;
    const text = await this.readText(record.contentRef).catch(() => null);
    const suffix = `\n${summary}`;
    if (text === null || !text.endsWith(suffix)) return none;
    const quote = singleLine(text.slice(0, text.length - suffix.length));
    if (quote.length === 0 || quote.length > 500) return none;
    const supersededBy = record.attributes?.supersededBy ?? null;
    if (record.status !== "active" || supersededBy === null)
      return { quote, quoteSuperseded: false, quoteLatestMemoryId: null };
    return {
      quote,
      quoteSuperseded: true,
      quoteLatestMemoryId: await this.#latestVersion(supersededBy as MemoryId, record.id),
    };
  }

  #quotable(record: ProductMemoryRecord): boolean {
    const { ownerId, agentId } = this.options.configuration;
    return (
      record.ownerId === ownerId &&
      record.agentId === agentId &&
      record.status !== "deletion_pending" &&
      record.status !== "deleted_verified" &&
      record.status !== "trashed" &&
      reviewMemoryVisible(record.dataClassification)
    );
  }

  async #latestVersion(first: MemoryId, sourceId: MemoryId): Promise<string | null> {
    const seen = new Set<MemoryId>([sourceId]);
    let next: MemoryId = first;
    for (;;) {
      if (seen.has(next) || seen.size > RULE_QUOTE_CHAIN_MAX_DEPTH) return null;
      seen.add(next);
      const record = await this.options.state.read(next);
      if (!record || !this.#quotable(record)) return null;
      const after = (record.attributes?.supersededBy ?? null) as MemoryId | null;
      if (after === null) return record.status === "active" ? record.id : null;
      next = after;
    }
  }

  async #ruleLastUsed(
    ruleIds: ReadonlySet<string>,
  ): Promise<
    Map<string, { readonly at: string; readonly kind: string; readonly decisionId: string }>
  > {
    const found = new Map<
      string,
      { readonly at: string; readonly kind: string; readonly decisionId: string }
    >();
    const ledger = this.options.ledger;
    if (!ledger || ruleIds.size === 0) return found;
    const { ownerId, agentId } = this.options.configuration;
    const all = [...ruleIds];
    for (let start = 0; start < all.length; start += 64)
      for (const use of await ledger.lastRuleUses({
        ownerId,
        agentId,
        ruleIds: all.slice(start, start + 64),
      }))
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(use.decisionId))
          found.set(use.ruleId, { at: use.decidedAt, kind: use.kind, decisionId: use.decisionId });
    return found;
  }

  async #rules(
    query: Extract<GatewayV2Query, { type: "memory.rules.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const control = this.options.ownerRules;
    if (!control)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    const listed = (await control.list()).filter((rule) => rule.status !== "retired");
    const lastUsed = await this.#ruleLastUsed(new Set(listed.map(({ ruleId }) => ruleId)));
    const rules = await Promise.all(
      listed.map(async (rule) => {
        const summary = Array.from(rule.summary).slice(0, 200).join("");
        return {
          ruleId: rule.ruleId,
          type: rule.type.slice(0, 64),
          summary,
          status: rule.status as "active" | "needs_review",
          enforced: rule.enforced,
          updatedAt: rule.updatedAt,
          ...(await this.#ruleQuote(rule.sourceMemoryId, rule.summary)),
          changes: Math.max(0, rule.revision - 1),
          lastUsed: lastUsed.get(rule.ruleId) ?? null,
        };
      }),
    );
    return {
      ...query,
      kind: "snapshot",
      type: "memory.rules.snapshot",
      payload: {
        rules,
        builtIn: [...((await this.options.actionRules?.list()) ?? [])],
        allowances: [...((await this.options.allowances?.list()) ?? [])],
        allowanceDays: (await this.options.allowances?.days()) ?? APPROVAL_ALLOWANCE_DAYS_DEFAULT,
        generatedAt: this.options.clock.now(),
      },
    };
  }

  #reviews() {
    const reviews = this.options.reviews;
    const control = this.options.ownerRules;
    if (!reviews || !control)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    return { reviews, control };
  }

  async #review(
    query: Extract<GatewayV2Query, { type: "memory.review.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const { reviews, control } = this.#reviews();
    const scope = this.#scope();
    await expandMemoryReviews(reviews.memories, scope, () => this.options.clock.now());
    const items = await reviews.memories.listOpen({ ...scope, limit: MEMORY_REVIEW_LIST_LIMIT });
    const records = new Map(
      (
        await this.options.state.readMany({
          ...scope,
          memoryIds: [
            ...new Set(items.flatMap((item) => [item.memoryId, item.upstreamMemoryId as MemoryId])),
          ],
        })
      ).map((record) => [record.id as string, record]),
    );
    const textOf = async (memoryId: string) => {
      const record = records.get(memoryId);
      if (!record) return null;
      const text = singleLine(await this.readText(record.contentRef).catch(() => ""));
      return text ? Array.from(text).slice(0, 200).join("") : null;
    };
    const memories = [];
    for (const item of items) {
      memories.push({
        memoryId: item.memoryId,
        text: await textOf(item.memoryId),
        upstreamMemoryId: item.upstreamMemoryId,
        upstreamText: await textOf(item.upstreamMemoryId),
        reason: item.reason,
        depth: item.depth,
        truncated: item.truncated,
        flaggedAt: item.flaggedAt,
      });
    }
    const summaries = new Map(
      (await control.list()).map((rule) => [rule.ruleId, rule.summary] as const),
    );
    const clip = (text: string) => Array.from(text).slice(0, 200).join("");
    const rules = (await reviews.rules.listOpen({ ...scope, limit: MEMORY_REVIEW_LIST_LIMIT })).map(
      (rule) => ({
        ruleId: rule.ruleId,
        revision: rule.revision,
        status: rule.status,
        summary: clip(summaries.get(rule.ruleId) ?? ""),
        suggestion: rule.suggestion ? clip(rule.suggestion.summary) : null,
        suggestionConditions: rule.suggestion
          ? RULE_CONDITION_FIELDS.flatMap((field) => {
              const params = rule.suggestion?.params;
              const values =
                params && field in params ? (params as MailMatchParameters)[field] : [];
              return values.length ? [{ field, values: values.map(clip) }] : [];
            })
          : [],
        suspendReason: rule.suspendReason,
        rechecking: rule.rechecking,
        sourceMemoryId: rule.sourceMemoryId,
        updatedAt: rule.updatedAt,
      }),
    );
    return {
      ...query,
      kind: "snapshot",
      type: "memory.review.snapshot",
      payload: {
        memories,
        rules,
        agreement: await reviews.memories.agreement(scope),
        generatedAt: this.options.clock.now(),
      },
    };
  }

  async #resolveMemoryReview(memoryId: MemoryId): Promise<void> {
    await this.options.reviews?.memories.resolve({
      ...this.#scope(),
      memoryId,
      resolution: "owner_edited",
      now: this.options.clock.now(),
    });
  }

  async #memoryViews(
    records: readonly ProductMemoryRecord[],
    keepUnreadable: boolean,
  ): Promise<
    {
      readonly record: ProductMemoryRecord;
      readonly item: OverviewSnapshot["payload"]["memories"][number] | null;
    }[]
  > {
    const { ownerId, agentId } = this.options.configuration;
    const scope = this.#scope();
    const pins = new Map(
      (await this.options.book.listProfilePins(scope)).map(({ memoryId, pinned }) => [
        memoryId,
        pinned ? ("on" as const) : ("off" as const),
      ]),
    );
    const views: {
      record: ProductMemoryRecord;
      item: OverviewSnapshot["payload"]["memories"][number] | null;
    }[] = [];
    const texts = new Map<string, Promise<string>>();
    const textOfRef = (ref: string) => {
      const cached = texts.get(ref);
      if (cached) return cached;
      const read = this.readText(ref)
        .then(singleLine)
        .catch(() => "");
      texts.set(ref, read);
      return read;
    };
    const history = new Map<string, MemoryHistoryEvent[]>();
    for (let index = 0; index < records.length; index += HISTORY_BATCH)
      for (const event of await this.options.state.listHistory({
        ownerId,
        agentId,
        memoryIds: records.slice(index, index + HISTORY_BATCH).map(({ id }) => id),
      }))
        history.set(event.memoryId, [...(history.get(event.memoryId) ?? []), event]);
    const sourceMessageIds = await findSourceMessageIds(this.options.book, scope, records);
    for (const memory of records) {
      if (
        memory.status !== "active" &&
        memory.status !== "archived" &&
        memory.status !== "trashed"
      ) {
        if (keepUnreadable) views.push({ record: memory, item: null });
        continue;
      }
      const text = await textOfRef(memory.contentRef);
      if (!text) {
        if (keepUnreadable) views.push({ record: memory, item: null });
        continue;
      }
      const nodes: OverviewSnapshot["payload"]["memories"][number]["history"][number][] = [];
      for (const event of history.get(memory.id) ?? []) {
        const eventText = await textOfRef(event.contentRef);
        if (!eventText) continue;
        nodes.push({
          historyId: event.id,
          kind: event.kind,
          text: eventText,
          stance: event.stance,
          quote: event.quoteRef ? (await textOfRef(event.quoteRef)) || null : null,
          sourceThreadId: event.sourceThreadId,
          sourceDeleted: event.sourceDeleted,
          at: event.occurredAt,
        });
      }
      views.push({
        record: memory,
        item: {
          memoryId: memory.id,
          revision: memory.revision,
          text,
          dataClassification: memory.dataClassification,
          topic: memory.attributes?.sensitiveTopic ?? null,
          inference: memory.inference,
          sourceThreadId: memory.sourceThreadId,
          sourceMessageId: sourceMessageIds.get(memory.id) ?? null,
          sourceRefs: memory.sourceRefs.filter((ref) => ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH),
          updatedAt: memory.updatedAt,
          supersededBy: memory.attributes?.supersededBy ?? null,
          validTo: memory.attributes?.validTo ?? null,
          tentative: memory.attributes?.tentative === true,
          category: memory.attributes?.category ?? "other",
          subCategory: memory.attributes?.subCategory ?? null,
          status: memory.status,
          recordedAt: memory.recordedAt ?? memory.updatedAt,
          lastUsedAt: memory.lastUsedAt,
          importBatchId: memory.attributes?.importBatchId ?? null,
          importance: memory.attributes?.importancePermille ?? 0,
          profilePin: pins.get(memory.id) ?? null,
          stance: memory.attributes?.stance ?? null,
          history: nodes,
        },
      });
    }
    return views;
  }

  async #decisionChain(
    query: Extract<GatewayV2Query, { type: "decision.chain.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const { ledger, consolidation } = this.options;
    if (!ledger || !consolidation)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    const scope = this.#scope();
    return readDecisionChain(
      {
        scope,
        ledger,
        readBasisChain: (memoryId) =>
          consolidation.store.readBasisChain({ ...scope, memoryId: memoryId as MemoryId }),
        views: async (memoryIds) => {
          const records = await this.options.state.readMany({
            ...scope,
            memoryIds: memoryIds as readonly MemoryId[],
          });
          const views = new Map<string, DecisionChainMemoryView>();
          for (const { record, item } of await this.#memoryViews(records, true))
            views.set(record.id, { record, item });
          for (const id of memoryIds)
            if (!views.has(id)) views.set(id, { record: undefined, item: null });
          return views;
        },
        texts: async (memoryIds) => {
          const records = await this.options.state.readMany({
            ...scope,
            memoryIds: memoryIds as readonly MemoryId[],
          });
          const texts = new Map<string, { text: string | null; hidden: boolean }>();
          for (const record of records) {
            if (
              record.status === "deletion_pending" ||
              record.status === "deleted_verified" ||
              record.status === "trashed"
            ) {
              texts.set(record.id, { text: null, hidden: false });
              continue;
            }
            if (!reviewMemoryVisible(record.dataClassification)) {
              texts.set(record.id, { text: null, hidden: true });
              continue;
            }
            texts.set(record.id, {
              text: singleLine(await this.readText(record.contentRef).catch(() => "")) || null,
              hidden: false,
            });
          }
          return texts;
        },
        visible: reviewMemoryVisible,
      },
      query,
    );
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "memory.basis.read") return this.#basisChain(query);
    if (query.type === "memory.classify.read") return this.#classify(query);
    if (query.type === "memory.import.duplicates.read") return this.#importDuplicates(query);
    if (query.type === "decision.chain.read") return this.#decisionChain(query);
    if (query.type === "memory.rules.read") return this.#rules(query);
    if (query.type === "memory.review.read") return this.#review(query);
    if (query.type !== "memory.overview.read") throw new Error("MEMORY_OPERATION_NOT_INSTALLED");
    const { ownerId, agentId } = this.options.configuration;
    const scope = this.#scope();
    await this.#purgeExpiredTrash();
    const records = [
      ...(await this.options.state.listActive(ownerId, agentId)),
      ...(await this.#inactive()),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const memories = (await this.#memoryViews(records, false)).flatMap(({ item }) =>
      item ? [item] : [],
    );
    const tidyUps = (await this.tidyUpViews(TIDY_UPS_SHOWN)).map(
      ({ dataClassification: _dataClassification, ...change }) => change,
    );
    const conversationReviews = (
      await this.conversationReviewViews(TIDY_UPS_SHOWN, { lead: false })
    ).map(({ lead: _lead, ...review }) => review);
    const outline = await this.options.profile?.outline({
      ownerId,
      agentId,
      maxClassification: modelVisibleCeiling(),
      now: this.options.clock.now(),
    });
    const lines = (items: readonly { memoryId: string; text: string; updatedAt: string }[]) =>
      items.map(({ memoryId, text, updatedAt }) => ({
        memoryId,
        text: singleLine(text),
        updatedAt,
      }));
    const profile: OverviewSnapshot["payload"]["profile"][number][] = outline
      ? [
          ...(outline.rules.length
            ? [{ kind: "rules" as const, lines: lines(outline.rules) }]
            : []),
          ...outline.sections.flatMap(({ category, lines: items }) =>
            category === "identity" ||
            category === "preference" ||
            category === "relationship" ||
            category === "goal" ||
            category === "project"
              ? [{ kind: category, lines: lines(items) }]
              : [],
          ),
        ]
      : [];
    const pending = (await this.pendingRequests()).map(
      ({ dataClassification: _dataClassification, ...request }) => request,
    );
    const due = await this.dueReminderViews(REMINDERS_SHOWN);
    const reminders = due.items.map(({ reminderId, text, dueAt, remindAt, sourceThreadId }) => ({
      reminderId,
      text,
      dueAt,
      remindAt,
      sourceThreadId,
    }));
    const now = this.options.clock.now();
    const upcoming = (
      await this.upcomingViews({
        now,
        until: new Date(Date.parse(now) + UPCOMING_WINDOW_MS).toISOString(),
        limit: UPCOMING_SHOWN,
        exclude: new Set(due.rowIds),
      })
    ).map(({ dataClassification: _dataClassification, ...entry }) => entry);
    const cancelled = await this.cancelledViews(CANCELLED_SHOWN);
    const people = (await this.options.book.listPeople(scope)).map((person) => ({
      personId: person.id,
      name: person.name,
      aliases: person.aliases,
      relation: person.relation,
      reverseRelation: person.reverseRelation,
      links: person.links,
      memoryIds: person.memoryIds,
    }));
    const personSuggestions = (await this.options.book.listPersonSuggestions(scope)).map(
      ({ id, personId, candidateId, createdAt }) => ({
        suggestionId: id,
        personId,
        candidateId,
        createdAt,
      }),
    );
    const imports = (
      await this.options.book.listImportBatches({ ...scope, limit: IMPORTS_SHOWN })
    ).map(({ id, source, itemCount, createdAt, undoneAt }) => ({
      batchId: id,
      source,
      itemCount,
      createdAt,
      undone: undoneAt !== null,
    }));
    const externalProposals = await this.#externalProposals(EXTERNAL_PROPOSALS_SHOWN);
    const mcpSync = await this.#mcpSyncView();
    const { capturePaused, lastViewedAt } = await this.options.book.readSettings(scope);
    const manualAddReady = (await this.options.book.latestGeneration(scope)) !== undefined;
    return {
      ...query,
      kind: "snapshot",
      type: "memory.overview.snapshot",
      payload: {
        memories,
        profile,
        pending,
        externalProposals,
        mcpSync,
        tidyUps,
        conversationReviews,
        reminders,
        upcoming,
        cancelled,
        people,
        personSuggestions,
        imports,
        capturePaused,
        manualAddReady,
        lastViewedAt,
        profileUsage: {
          used: outline?.usage.used ?? 0,
          limit: outline?.usage.limit ?? 0,
          pinned: outline?.usage.pinned ?? 0,
          queued: [...(outline?.usage.queued ?? [])],
        },
        generatedAt: now,
      },
    } as GatewayV2Snapshot;
  }

  async #classify(
    query: Extract<GatewayV2Query, { type: "memory.classify.read" }>,
  ): Promise<ClassifySnapshot> {
    const results: MemoryClassification[] = [];
    const pending: { index: number; text: string }[] = [];
    for (const [index, ref] of query.payload.contentRefs.entries()) {
      const payload = await this.options.payloads.get(ref);
      if (payload && classificationRank(payload.dataClassification) > classificationRank("private"))
        results[index] = DETERMINISTIC_SENSITIVE;
      else pending.push({ index, text: await this.readText(ref) });
    }
    const judged = this.options.classifier
      ? await this.options.classifier.classify(pending.map(({ text }) => text))
      : pending.map(() => UNCLASSIFIED);
    for (const [position, { index }] of pending.entries())
      results[index] = judged[position] ?? UNCLASSIFIED;
    for (const [index, ref] of query.payload.contentRefs.entries()) {
      const result = results[index] ?? UNCLASSIFIED;
      if (result.classification !== "sensitive") continue;
      this.#sensitiveJudgments.delete(ref);
      this.#sensitiveJudgments.set(ref, result);
      for (const oldest of this.#sensitiveJudgments.keys()) {
        if (this.#sensitiveJudgments.size <= SENSITIVE_JUDGMENTS_KEPT) break;
        this.#sensitiveJudgments.delete(oldest);
      }
    }
    return {
      ...query,
      kind: "snapshot",
      type: "memory.classify.snapshot",
      payload: {
        items: query.payload.contentRefs.map((contentRef, index) => {
          const result = results[index] ?? UNCLASSIFIED;
          return {
            contentRef,
            category: result.category,
            classification: result.classification,
            topic: result.topic,
            failed: result.failed,
          };
        }),
      },
    } as ClassifySnapshot;
  }

  async #importDuplicates(
    query: Extract<GatewayV2Query, { type: "memory.import.duplicates.read" }>,
  ): Promise<ImportDuplicatesSnapshot> {
    const checker = this.options.importDuplicates;
    const refs = query.payload.contentRefs;
    const results = checker ? await this.#checkImportDuplicates(checker, refs) : null;
    return {
      ...query,
      kind: "snapshot",
      type: "memory.import.duplicates.snapshot",
      payload: {
        items: refs.map((contentRef, index) => ({
          contentRef,
          verdict: results?.[index]?.verdict ?? "skipped",
          memoryId: results?.[index]?.memoryId ?? null,
        })),
      },
    } as ImportDuplicatesSnapshot;
  }

  async #checkImportDuplicates(
    checker: Pick<ProductionImportDuplicateChecker, "check" | "existingLimit">,
    refs: readonly string[],
  ) {
    const { ownerId, agentId } = this.options.configuration;
    const candidates: string[] = [];
    const sendable: number[] = [];
    for (const [index, ref] of refs.entries()) {
      const payload = await this.options.payloads.get(ref);
      if (
        (payload &&
          classificationRank(payload.dataClassification) > classificationRank("private")) ||
        this.#sensitiveJudgments.has(ref)
      )
        candidates.push("");
      else {
        candidates.push(await this.readText(ref));
        sendable.push(index);
      }
    }
    if (sendable.length === 0)
      return candidates.map(
        (): ImportDuplicateResultView => ({ verdict: "skipped", memoryId: null }),
      );
    const existing: { memoryId: string; text: string }[] = [];
    let complete = true;
    const limit = checker.existingLimit;
    const active = [...(await this.options.state.listActive(ownerId, agentId))].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    for (const record of active) {
      if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
        continue;
      if (existing.length >= limit) {
        complete = false;
        break;
      }
      const text = await this.readText(record.contentRef).catch(() => null);
      if (text) existing.push({ memoryId: record.id, text });
      else complete = false;
    }
    if (existing.length === 0 && active.length > 0) complete = false;
    const checked = await checker.check(
      sendable.map((index) => candidates[index] ?? ""),
      existing,
      { complete },
    );
    const results = candidates.map(
      (): ImportDuplicateResultView => ({
        verdict: "skipped",
        memoryId: null,
      }),
    );
    for (const [position, index] of sendable.entries()) {
      const result = checked[position];
      if (result) results[index] = result;
    }
    return results;
  }

  async #storedAtLeast(
    contentRef: string,
    text: string,
    dataClassification: DataClassification,
  ): Promise<string> {
    const { ownerId, agentId } = this.options.configuration;
    const copy = await this.options.protector.protect({
      ownerId,
      agentId,
      ref: `memory-raised:${dataClassification}:${contentRef}`,
      dataClassification,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode(text),
      createdAt: this.options.clock.now(),
    });
    try {
      await this.options.payloads.put(copy);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        throw error;
    }
    return copy.ref;
  }

  async #createMemory(input: {
    readonly id: MemoryId;
    readonly contentRef: string;
    readonly category: MemoryCategory;
    readonly subCategory: string | null;
    readonly topic: SensitiveMemoryTopic | null;
    readonly policyVersion: string;
    readonly importBatchId: string | null;
  }): Promise<ProductMemoryRecord> {
    const payload = await this.options.payloads.get(input.contentRef);
    if (!payload)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
    const text = await this.readText(input.contentRef);
    this.assertStorable(text);
    if (payload.dataClassification === "restricted")
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
    const judged = this.#sensitiveJudgments.get(input.contentRef);
    const raised =
      classificationRank(payload.dataClassification) < classificationRank("sensitive") &&
      (sensitiveCategory(input.category) ||
        input.topic !== null ||
        judged !== undefined ||
        deterministicallySensitive(text));
    const dataClassification: DataClassification = raised
      ? "sensitive"
      : payload.dataClassification;
    const contentRef = raised
      ? await this.#storedAtLeast(input.contentRef, text, "sensitive")
      : input.contentRef;
    const { ownerId, agentId } = this.options.configuration;
    const subCategory = input.subCategory?.trim() || null;
    return this.options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: input.id,
          ownerId,
          agentId,
          contentRef,
          dataClassification,
          sourceThreadId: null,
          sourceRefs: [contentRef],
          inference: false,
          confidencePermille: 1000,
          policyVersion: input.policyVersion,
          attributes: {
            category: input.category,
            importancePermille:
              input.category === "rule" ? OWNER_RULE_IMPORTANCE : OWNER_MEMORY_IMPORTANCE,
            entities: [],
            validFrom: null,
            validTo: null,
            supersededBy: null,
            evidenceVerified: false,
            ...(dataClassification === "sensitive"
              ? {
                  sensitiveTopic: input.topic ?? judged?.topic ?? sensitiveTopicFor(input.category),
                }
              : {}),
            ...(subCategory ? { subCategory } : {}),
            ...(input.importBatchId ? { importBatchId: input.importBatchId } : {}),
          },
        },
      },
      await this.#generationFor(null),
    );
  }

  async #create(command: Command<"memory.create">) {
    const { contentRef, category, subCategory, topic, pinned } = command.payload;
    const saved = await this.#createMemory({
      id: `memory:owner:${command.idempotencyKey}` as MemoryId,
      contentRef,
      category,
      subCategory,
      topic: topic ?? null,
      policyVersion: OWNER_POLICY_VERSION,
      importBatchId: null,
    });
    if (pinned)
      await this.options.book.setProfilePin({
        ...this.#scope(),
        memoryId: saved.id,
        pinned: true,
        updatedAt: this.options.clock.now(),
      });
    return { resultRef: saved.id, replayed: false };
  }

  async #setCategory(command: Command<"memory.category.set">) {
    const { memoryId, expectedRevision, category } = command.payload;
    const { ownerId, agentId } = this.options.configuration;
    const current = await this.options.state.read(memoryId as MemoryId);
    if (!current || current.ownerId !== ownerId || current.agentId !== agentId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_NOT_FOUND");
    if (current.revision !== expectedRevision)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_REVISION_CHANGED");
    if ((current.attributes?.category ?? "other") === category)
      return { resultRef: current.id, replayed: false };
    if (
      current.dataClassification === "sensitive" ||
      current.attributes?.sensitiveTopic ||
      sensitiveCategory(category)
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_CATEGORY_LOCKED");
    const saved = await this.options.memory.revise({
      memoryId: current.id,
      expectedRevision,
      attributes: { category },
      generationId: await this.#generationFor(current.id),
    });
    return { resultRef: saved.id, replayed: false };
  }

  async #importCommit(command: Command<"memory.import.commit">) {
    const { batchId, source, items } = command.payload;
    const scope = this.#scope();
    const existing = await this.options.book.listImportBatches({ ...scope, limit: 1000 });
    if (existing.some(({ id }) => id === batchId)) return { resultRef: batchId, replayed: true };
    for (const item of items) {
      const payload = await this.options.payloads.get(item.contentRef);
      if (!payload)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
      this.assertStorable(await this.readText(item.contentRef));
    }
    await this.options.book.createImportBatch({
      ...scope,
      id: batchId,
      source,
      itemCount: items.length,
      createdAt: this.options.clock.now(),
      undoneAt: null,
    });
    for (const [ordinal, item] of items.entries())
      await this.#createMemory({
        id: `memory:import:${batchId}:${ordinal}` as MemoryId,
        contentRef: item.contentRef,
        category: item.category,
        subCategory: item.subCategory,
        topic: item.topic ?? null,
        policyVersion: IMPORT_POLICY_VERSION,
        importBatchId: batchId,
      });
    return { resultRef: batchId, replayed: false };
  }

  async #importUndo(command: Command<"memory.import.undo">) {
    const { batchId } = command.payload;
    const { ownerId, agentId } = this.options.configuration;
    const undone = await this.options.book.markImportUndone({
      ownerId,
      agentId,
      id: batchId,
      undoneAt: this.options.clock.now(),
    });
    if (!undone)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_IMPORT_NOT_FOUND");
    const members = [
      ...(await this.options.state.listActive(ownerId, agentId)),
      ...(await this.#inactive()),
    ].filter(
      (memory) =>
        memory.attributes?.importBatchId === batchId &&
        (memory.status === "active" || memory.status === "archived"),
    );
    for (const memory of members)
      await this.options.memory.trash(memory.id, await this.#generationFor(memory.id));
    return { resultRef: batchId, replayed: false };
  }

  #externalWriter() {
    const writer = this.options.externalProposals;
    if (!writer)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_OPERATION_NOT_INSTALLED",
      );
    return writer;
  }

  async #externalRespond(command: Command<"memory.external.respond">) {
    const writer = this.#externalWriter();
    for (const { editedText } of command.payload.items)
      if (editedText !== null) this.assertStorable(editedText);
    const batchId = externalProposalBatchId(command.idempotencyKey);
    await writer.respond(command.payload.items, batchId);
    return { resultRef: batchId, replayed: false };
  }

  async #externalUndo(command: Command<"memory.external.undo">) {
    const writer = this.#externalWriter();
    const { batchId } = command.payload;
    const reopened = await writer.undoBatch(batchId, async (memoryId) => {
      const memory = await this.options.state.read(memoryId);
      if (memory && (memory.status === "active" || memory.status === "archived"))
        await this.options.memory.trash(memory.id, await this.#generationFor(memory.id));
    });
    if (reopened === undefined)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_EXTERNAL_BATCH_NOT_FOUND");
    return { resultRef: batchId, replayed: false };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    this.assertOwner(command);
    if (command.type === "memory.create") return this.#create(command);
    if (command.type === "memory.category.set") return this.#setCategory(command);
    if (command.type === "memory.import.commit") return this.#importCommit(command);
    if (command.type === "memory.import.undo") return this.#importUndo(command);
    if (command.type === "memory.external.respond") return this.#externalRespond(command);
    if (command.type === "memory.external.undo") return this.#externalUndo(command);
    if (
      command.type === "memory.mcpSync.projectDecide" ||
      command.type === "memory.mcpSync.noteDecide" ||
      command.type === "memory.mcpSync.attentionResolve"
    )
      return this.#mcpSyncCommand(command);
    if (command.type === "memory.settings.set") {
      await this.options.book.writeSettings({
        ...this.#scope(),
        capturePaused: command.payload.capturePaused,
        updatedAt: this.options.clock.now(),
      });
      return { resultRef: "memory-settings", replayed: false };
    }
    if (command.type === "memory.page.viewed") {
      await this.options.book.markViewed({
        ...this.#scope(),
        viewedAt: this.options.clock.now(),
      });
      return { resultRef: "memory-page", replayed: false };
    }
    if (command.type === "memory.person.respond") {
      const decided = await this.options.book.decidePersonSuggestion({
        ...this.#scope(),
        id: command.payload.suggestionId,
        merge: command.payload.merge,
        now: this.options.clock.now(),
      });
      if (!decided)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PERSON_NOT_FOUND");
      return { resultRef: command.payload.suggestionId, replayed: false };
    }
    if (command.type === "memory.approval.respond") {
      const { requestId, resolution, editedText } = command.payload;
      if (resolution === "edited") {
        if (editedText === null)
          throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
        this.assertStorable(editedText);
      }
      const buffered: MemoryExtractionAuditRecord[] = [];
      const resolver = createProductionAutomaticMemory({
        product: this.options.memory,
        approvals: this.options.approvals,
        payloads: this.options.payloads,
        protector: this.options.protector,
        clock: this.options.clock,
        ...(this.options.reminders ? { reminders: this.options.reminders } : {}),
        book: this.options.book,
        ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
        extract: async () => [],
        readSourceText: (ref) => this.readText(ref),
        onAudit: (record) => {
          buffered.push(record);
        },
      });
      const committed = await this.options.unitOfWork.run(() =>
        resolver.resolveSensitive(
          resolution === "edited"
            ? { requestId, resolution, editedText: editedText ?? "" }
            : { requestId, resolution },
        ),
      );
      for (const record of buffered)
        try {
          this.options.onAudit(record);
        } catch {}
      return { resultRef: committed ?? requestId, replayed: false };
    }
    if (command.type === "memory.reminder.create") {
      if (!this.options.reminders)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      const writer = new ProductionReminderWriter({
        configuration: this.options.configuration,
        memory: this.options.memory,
        state: this.options.state,
        book: this.options.book,
        reminders: this.options.reminders,
        payloads: this.options.payloads,
        protector: this.options.protector,
        clock: this.options.clock,
        ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
      });
      try {
        const created = await writer.create({
          key: `owner:${command.idempotencyKey}`,
          contentRef: command.payload.contentRef,
          due: command.payload.due,
          repeat: command.payload.repeat,
        });
        return { resultRef: created.reminderId, replayed: created.replayed };
      } catch (error) {
        if (error instanceof ReminderInputError)
          throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, error.code);
        throw error;
      }
    }
    if (
      command.type === "memory.rule.respond" &&
      (command.payload.action === "ask_first" || command.payload.action === "allow_directly")
    ) {
      const switches = this.options.actionRules;
      if (!switches)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      await switches.setAskFirst(command.payload.target, command.payload.action === "ask_first");
      return { resultRef: command.payload.target, replayed: false };
    }
    if (command.type === "memory.review.respond") {
      const { reviews } = this.#reviews();
      const { target, action, expectedRevision } = command.payload;
      const now = this.options.clock.now();
      if (action === "dismiss") {
        const resolved = await reviews.memories.resolve({
          ...this.#scope(),
          memoryId: target as MemoryId,
          resolution: "owner_dismissed",
          now,
        });
        if (resolved === 0)
          throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_REVIEW_NOT_FOUND");
        return { resultRef: target, replayed: false };
      }
      if (expectedRevision === null)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "RULE_REVIEW_REVISION_REQUIRED",
        );
      const acted = await reviews.rules.act({
        ...this.#scope(),
        ruleId: target,
        expectedRevision,
        action,
        now,
      });
      if (!acted) throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "RULE_REVIEW_CHANGED");
      return { resultRef: target, replayed: false };
    }
    if (command.type === "memory.review.reportMissed") {
      const { reviews } = this.#reviews();
      const { memoryId, upstreamMemoryId } = command.payload;
      if (memoryId === upstreamMemoryId)
        throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_REVIEW_SELF");
      const recorded = await reviews.memories.reportMissed({
        ...this.#scope(),
        memoryId: memoryId as MemoryId,
        upstreamMemoryId: upstreamMemoryId as MemoryId,
        now: this.options.clock.now(),
      });
      return { resultRef: memoryId, replayed: !recorded };
    }
    if (command.type === "memory.rule.respond") {
      const control = this.options.ownerRules;
      if (!control)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      const { target, action } = command.payload;
      try {
        const result =
          action === "confirm"
            ? (await control.confirm(target)).ruleId
            : action === "reconfirm"
              ? (await control.reconfirm(target)).ruleId
              : action === "undo"
                ? (await control.undo(target)).ruleId
                : unsupportedRuleAction();
        return { resultRef: result ?? target, replayed: false };
      } catch (error) {
        if (error instanceof OwnerRuleError)
          throw new ApplicationPortError(
            error.code === "RULE_NOT_FOUND"
              ? PORT_ERROR_CODES.NOT_FOUND
              : PORT_ERROR_CODES.INVALID_OPERATION,
            error.code,
          );
        throw error;
      }
    }
    if (command.type === "memory.reminder.respond") {
      if (!this.options.reminders)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      const { reminderId, action } = command.payload;
      const { ownerId, agentId } = this.options.configuration;
      const reminder = await this.options.reminders.read(reminderId);
      if (!reminder || reminder.ownerId !== ownerId || reminder.agentId !== agentId)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_REMINDER_NOT_FOUND");
      if (reminder.status !== "cancelled" && action === "restore")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_REMINDER_NOT_CANCELLED",
        );
      if (reminder.status === "cancelled" && action !== "cancel" && action !== "restore")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_REMINDER_CANCELLED",
        );
      const now = this.options.clock.now();
      const next =
        action === "restore"
          ? {
              status: "scheduled" as const,
              dueAt: reminder.dueAt,
              remindAt: reminder.remindAt,
              dismissedAt: null,
            }
          : action === "snooze"
            ? {
                status: "scheduled" as const,
                dueAt: reminder.dueAt,
                remindAt: new Date(Date.parse(now) + SNOOZE_MS).toISOString(),
                dismissedAt: null,
              }
            : action === "dismiss" && reminder.repeat === "yearly"
              ? {
                  status: "scheduled" as const,
                  dueAt: nextYear(reminder.dueAt),
                  remindAt: nextYear(reminder.remindAt),
                  dismissedAt: null,
                }
              : {
                  status: (action === "cancel" ? "cancelled" : "dismissed") as
                    | "cancelled"
                    | "dismissed",
                  dueAt: reminder.dueAt,
                  remindAt: reminder.remindAt,
                  dismissedAt: now,
                };
      const updated = await this.options.reminders.update({
        id: reminder.id,
        expectedUpdatedAt: reminder.updatedAt,
        ...next,
        updatedAt: now === reminder.updatedAt ? new Date(Date.parse(now) + 1).toISOString() : now,
      });
      if (!updated)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_REMINDER_CHANGED");
      return { resultRef: reminderId, replayed: false };
    }
    if (command.type === "memory.tidy.undo") {
      if (!this.options.consolidation)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      const { changeId } = command.payload;
      const { ownerId, agentId } = this.options.configuration;
      const owned = (
        await this.options.consolidation.store.listChanges({ ownerId, agentId, limit: 500 })
      ).some(({ id }) => id === changeId);
      if (!owned)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_TIDY_CHANGE_NOT_FOUND");
      await this.options.consolidation.undo(changeId);
      return { resultRef: changeId, replayed: false };
    }
    if (command.type === "memory.conversationReview.undo") {
      if (!this.options.conversationReviews)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_OPERATION_NOT_INSTALLED",
        );
      const { reviewId } = command.payload;
      const { ownerId, agentId } = this.options.configuration;
      const owned = (
        await this.options.conversationReviews.store.listWithChanges({
          ownerId,
          agentId,
          limit: 200,
        })
      ).some(({ id }) => id === reviewId);
      if (!owned)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          "MEMORY_CONVERSATION_REVIEW_NOT_FOUND",
        );
      await this.options.conversationReviews.undo(reviewId);
      return { resultRef: reviewId, replayed: false };
    }
    if (command.type === "memory.mutate") {
      const { memoryId, action, expectedRevision, contentRef, historyId } = command.payload;
      const current = await this.options.state.read(memoryId as MemoryId);
      const { ownerId, agentId } = this.options.configuration;
      if (!current || current.ownerId !== ownerId || current.agentId !== agentId)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_NOT_FOUND");
      if (current.revision !== expectedRevision)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_REVISION_CHANGED");
      const generationId = await this.#generationFor(current.id);
      if (action === "correct" && contentRef) {
        this.assertStorable(await this.readText(contentRef));
        const saved = await this.options.memory.correct({
          memoryId: current.id,
          contentRef,
          sourceRef: contentRef,
          generationId,
        });
        await this.#resolveMemoryReview(current.id);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "confirm") {
        const saved = await this.options.memory.confirm(current.id, generationId);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "restore") {
        const saved = await this.options.memory.restore(current.id, generationId);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "restore_version" && historyId !== null) {
        const restored = await this.#versionContent(current, historyId);
        try {
          const saved = await this.options.memory.restoreVersion({
            memoryId: current.id,
            expectedRevision,
            contentRef: restored.contentRef,
            stance: restored.stance,
            generationId,
          });
          await this.#resolveMemoryReview(current.id);
          return { resultRef: saved.id, replayed: false };
        } catch (error) {
          if (restored.copied)
            await this.options.payloads.delete(restored.contentRef).catch(() => false);
          throw error;
        }
      }
      if (action === "delete") {
        const saved = await this.options.memory.trash(current.id, generationId);
        await this.#resolveMemoryReview(current.id);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "recover") {
        const saved = await this.options.memory.recover(current.id, generationId);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "pin" || action === "unpin") {
        if (
          current.status !== "active" ||
          !PINNABLE_CATEGORIES.has(current.attributes?.category ?? "other") ||
          !isModelVisible(current.dataClassification)
        )
          throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_NOT_PINNABLE");
        await this.options.book.setProfilePin({
          ...this.#scope(),
          memoryId: current.id,
          pinned: action === "pin",
          updatedAt: this.options.clock.now(),
        });
        return { resultRef: current.id, replayed: false };
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "MEMORY_OPERATION_NOT_INSTALLED",
    );
  }
}
