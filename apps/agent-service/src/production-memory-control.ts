import {
  ApplicationPortError,
  type ClockPort,
  type DecisionLedgerPort,
  type DurableMemoryService,
  type MemoryBookStorePort,
  type MemoryCategory,
  type MemoryConsolidationStorePort,
  type MemoryExtractionAuditRecord,
  type MemoryHistoryEvent,
  type MemoryProjectionJobStatePort,
  type MemoryReminderStorePort,
  type MemorySourceMessage,
  type OwnerProfileService,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type SensitiveMemoryApprovalStatePort,
  type SensitiveMemoryTopic,
} from "@himawari-agent/application";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  MEMORY_SENSITIVE_CATEGORY_NAMES,
  MEMORY_SOURCE_REF_MAX_LENGTH,
} from "@himawari-agent/gateway-contracts";
import {
  createProductionAutomaticMemory,
  protectedMemoryCandidates,
} from "./production-memory-capture.js";
import { ProductionReminderWriter, ReminderInputError } from "./production-reminder-writer.js";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type GenerationId = Parameters<DurableMemoryService["delete"]>[1];
type OverviewSnapshot = Extract<GatewayV2Snapshot, { type: "memory.overview.snapshot" }>;
type BasisSnapshot = Extract<GatewayV2Snapshot, { type: "memory.basis.snapshot" }>;
const BASIS_NODES_SHOWN = 200;
type Command<T extends GatewayV2Command["type"]> = Extract<GatewayV2Command, { type: T }>;

export const PRODUCTION_MEMORY_OPERATIONS = Object.freeze([
  "memory.overview.read",
  "memory.basis.read",
  "memory.approval.respond",
  "memory.mutate",
  "memory.tidy.undo",
  "memory.reminder.respond",
  "memory.reminder.create",
  "memory.create",
  "memory.category.set",
  "memory.settings.set",
  "memory.page.viewed",
  "memory.person.respond",
  "memory.import.commit",
  "memory.import.undo",
] as const);
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
const INACTIVE_SHOWN = 500;
const HISTORY_BATCH = 1000;
const IMPORTS_SHOWN = 20;
const TRASH_RETENTION_MS = 7 * 24 * 3_600_000;
const SNOOZE_MS = 3_600_000;
const OWNER_POLICY_VERSION = "memory-owner:v1";
const OWNER_RULE_IMPORTANCE = 800;
const OWNER_MEMORY_IMPORTANCE = 500;
const IMPORT_POLICY_VERSION = "memory-import:v1";

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

export class ProductionMemoryControl {
  private readonly options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: ProductMemoryStatePort;
    readonly jobs: Pick<MemoryProjectionJobStatePort, "listByMemory">;
    readonly approvals: SensitiveMemoryApprovalStatePort;
    readonly memory: Pick<
      DurableMemoryService,
      | "applyProposal"
      | "correct"
      | "delete"
      | "restore"
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
    readonly reminders?: Pick<
      MemoryReminderStorePort,
      "schedule" | "listDue" | "listUpcoming" | "read" | "update"
    >;
    readonly payloads: PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly clock: ClockPort;
    readonly timeZone?: string;
    readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  };

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
    const due = await this.#dueReminders();
    return JSON.stringify([
      active.map(({ id, revision }) => [id, revision, historyCount.get(id) ?? 0]),
      pending.map(({ id }) => id),
      changes.map(({ id, undoneAt }) => [id, undoneAt]),
      due.map(({ id, updatedAt }) => [id, updatedAt]),
      inactive.map(({ id, revision }) => [id, revision]),
      settings.updatedAt,
      (await this.options.book.latestGeneration(scope)) ?? null,
      people.map(({ id, updatedAt, memoryIds }) => [id, updatedAt, memoryIds.length]),
      suggestions.map(({ id }) => id),
      imports.map(({ id, undoneAt }) => [id, undoneAt]),
      pins.map(({ memoryId, pinned, updatedAt }) => [memoryId, pinned, updatedAt]),
    ]);
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

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "memory.basis.read") return this.#basisChain(query);
    if (query.type !== "memory.overview.read") throw new Error("MEMORY_OPERATION_NOT_INSTALLED");
    const { ownerId, agentId } = this.options.configuration;
    const scope = this.#scope();
    await this.#purgeExpiredTrash();
    const records = [
      ...(await this.options.state.listActive(ownerId, agentId)),
      ...(await this.#inactive()),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const pins = new Map(
      (await this.options.book.listProfilePins(scope)).map(({ memoryId, pinned }) => [
        memoryId,
        pinned ? ("on" as const) : ("off" as const),
      ]),
    );
    const memories: OverviewSnapshot["payload"]["memories"][number][] = [];
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
    const refsByThread = new Map<string, Set<string>>();
    for (const { sourceThreadId, sourceRefs } of records) {
      if (!sourceThreadId) continue;
      const refs = refsByThread.get(sourceThreadId) ?? new Set<string>();
      for (const ref of sourceRefs) if (ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH) refs.add(ref);
      refsByThread.set(sourceThreadId, refs);
    }
    const sourceMessages = await this.options.book.findOwnerMessages({
      ...scope,
      lookups: [...refsByThread].map(([threadId, refs]) => ({ threadId, refs: [...refs] })),
    });
    for (const memory of records) {
      if (memory.status !== "active" && memory.status !== "archived" && memory.status !== "trashed")
        continue;
      const text = await textOfRef(memory.contentRef);
      if (!text) continue;
      const nodes: OverviewSnapshot["payload"]["memories"][number]["history"][number][] = [];
      for (const event of history.get(memory.id) ?? []) {
        const eventText = await textOfRef(event.contentRef);
        if (!eventText) continue;
        nodes.push({
          kind: event.kind,
          text: eventText,
          stance: event.stance,
          quote: event.quoteRef ? (await textOfRef(event.quoteRef)) || null : null,
          sourceThreadId: event.sourceThreadId,
          sourceDeleted: event.sourceDeleted,
          at: event.occurredAt,
        });
      }
      memories.push({
        memoryId: memory.id,
        revision: memory.revision,
        text,
        dataClassification: memory.dataClassification,
        topic: memory.attributes?.sensitiveTopic ?? null,
        inference: memory.inference,
        sourceThreadId: memory.sourceThreadId,
        sourceMessageId: earliestSourceMessage(memory, sourceMessages),
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
      });
    }
    const changes =
      (await this.options.consolidation?.store.listChanges({
        ownerId,
        agentId,
        limit: TIDY_UPS_SHOWN,
      })) ?? [];
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
    const tidyUps: OverviewSnapshot["payload"]["tidyUps"][number][] = [];
    for (const change of changes) {
      const text = await textOf(change.memoryId);
      if (!text) continue;
      tidyUps.push({
        changeId: change.id,
        action: change.action,
        text,
        relatedText: await textOf(change.relatedMemoryId),
        createdAt: change.createdAt,
        undone: change.undoneAt !== null,
      });
    }
    const outline = await this.options.profile?.outline({
      ownerId,
      agentId,
      maxClassification: "private",
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
    const candidates = protectedMemoryCandidates(this.options);
    const pending: OverviewSnapshot["payload"]["pending"][number][] = [];
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
      });
    }
    const dueReminders = await this.#dueReminders();
    const reminded = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: dueReminders.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const reminders: OverviewSnapshot["payload"]["reminders"][number][] = [];
    for (const reminder of dueReminders) {
      const memory = reminded.get(reminder.memoryId);
      const text = memory ? singleLine(await this.readText(memory.contentRef).catch(() => "")) : "";
      if (!text) continue;
      reminders.push({
        reminderId: reminder.id,
        text,
        dueAt: reminder.dueAt,
        remindAt: reminder.remindAt,
        sourceThreadId: memory?.sourceThreadId ?? null,
      });
    }
    const now = this.options.clock.now();
    const due = new Set(dueReminders.map(({ id }) => id));
    const coming = (
      (await this.options.reminders?.listUpcoming({
        ownerId,
        agentId,
        from: now,
        to: new Date(Date.parse(now) + UPCOMING_WINDOW_MS).toISOString(),
        limit: UPCOMING_SHOWN,
      })) ?? []
    ).filter(({ id }) => !due.has(id));
    const comingMemories = new Map(
      (
        await this.options.state.readMany({
          ownerId,
          agentId,
          memoryIds: coming.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const upcoming: OverviewSnapshot["payload"]["upcoming"][number][] = [];
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
      });
    }
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
        tidyUps,
        reminders,
        upcoming,
        people,
        personSuggestions,
        imports,
        capturePaused,
        manualAddReady,
        lastViewedAt,
        profileUsage: {
          used: outline?.usage.used ?? 0,
          limit: outline?.usage.limit ?? 0,
          queued: [...(outline?.usage.queued ?? [])],
        },
        generatedAt: now,
      },
    } as GatewayV2Snapshot;
  }

  async #createMemory(input: {
    readonly id: MemoryId;
    readonly contentRef: string;
    readonly category: MemoryCategory;
    readonly subCategory: string | null;
    readonly policyVersion: string;
    readonly importBatchId: string | null;
  }): Promise<ProductMemoryRecord> {
    const payload = await this.options.payloads.get(input.contentRef);
    if (!payload)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
    this.assertStorable(await this.readText(input.contentRef));
    if (payload.dataClassification === "restricted")
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
    const { ownerId, agentId } = this.options.configuration;
    const subCategory = input.subCategory?.trim() || null;
    return this.options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: input.id,
          ownerId,
          agentId,
          contentRef: input.contentRef,
          dataClassification: payload.dataClassification,
          sourceThreadId: null,
          sourceRefs: [input.contentRef],
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
            ...(payload.dataClassification === "sensitive"
              ? { sensitiveTopic: sensitiveTopicFor(input.category) }
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
    const { contentRef, category, subCategory, pinned } = command.payload;
    const saved = await this.#createMemory({
      id: `memory:owner:${command.idempotencyKey}` as MemoryId,
      contentRef,
      category,
      subCategory,
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

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    this.assertOwner(command);
    if (command.type === "memory.create") return this.#create(command);
    if (command.type === "memory.category.set") return this.#setCategory(command);
    if (command.type === "memory.import.commit") return this.#importCommit(command);
    if (command.type === "memory.import.undo") return this.#importUndo(command);
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
        onAudit: this.options.onAudit,
      });
      const committed = await resolver.resolveSensitive(
        resolution === "edited"
          ? { requestId, resolution, editedText: editedText ?? "" }
          : { requestId, resolution },
      );
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
      const now = this.options.clock.now();
      const next =
        action === "snooze"
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
    if (command.type === "memory.mutate") {
      const { memoryId, action, expectedRevision, contentRef } = command.payload;
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
      if (action === "delete") {
        const saved = await this.options.memory.trash(current.id, generationId);
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
          (current.dataClassification !== "public" && current.dataClassification !== "private")
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
