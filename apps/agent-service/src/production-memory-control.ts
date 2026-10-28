import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  scanMachineSecrets,
  type ClockPort,
  type DurableMemoryService,
  type MemoryBookStorePort,
  type MemoryCategory,
  type MemoryConsolidationStorePort,
  type MemoryExtractionAuditRecord,
  type MemoryProjectionJobStatePort,
  type MemoryReminderStorePort,
  type OwnerProfileService,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductConfiguration,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type SensitiveMemoryApprovalStatePort,
  type SensitiveMemoryTopic,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  containsRestrictedIdentifier,
  createProductionAutomaticMemory,
  protectedMemoryCandidates,
} from "./production-memory-capture.js";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type GenerationId = Parameters<DurableMemoryService["delete"]>[1];
type OverviewSnapshot = Extract<GatewayV2Snapshot, { type: "memory.overview.snapshot" }>;
type Command<T extends GatewayV2Command["type"]> = Extract<GatewayV2Command, { type: T }>;

export const PRODUCTION_MEMORY_OPERATIONS = Object.freeze([
  "memory.overview.read",
  "memory.approval.respond",
  "memory.mutate",
  "memory.tidy.undo",
  "memory.reminder.respond",
  "memory.create",
  "memory.settings.set",
  "memory.person.respond",
  "memory.import.commit",
  "memory.import.undo",
] as const);
const TIDY_UPS_SHOWN = 30;
const REMINDERS_SHOWN = 10;
const UPCOMING_SHOWN = 20;
const UPCOMING_WINDOW_MS = 60 * 24 * 3_600_000;
const INACTIVE_SHOWN = 500;
const IMPORTS_SHOWN = 20;
const TRASH_RETENTION_MS = 7 * 24 * 3_600_000;
const SNOOZE_MS = 3_600_000;
const OWNER_POLICY_VERSION = "memory-owner:v1";
const IMPORT_POLICY_VERSION = "memory-import:v1";

function sensitiveTopicFor(category: MemoryCategory): SensitiveMemoryTopic {
  return category === "health" || category === "finance" ? category : "other";
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

export class ProductionMemoryControl {
  private readonly options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: ProductMemoryStatePort;
    readonly jobs: Pick<MemoryProjectionJobStatePort, "listByMemory">;
    readonly approvals: SensitiveMemoryApprovalStatePort;
    readonly memory: Pick<
      DurableMemoryService,
      "applyProposal" | "correct" | "delete" | "restore" | "confirm" | "trash" | "recover"
    >;
    readonly book: MemoryBookStorePort;
    readonly profile?: Pick<OwnerProfileService, "outline">;
    readonly consolidation?: {
      readonly store: Pick<MemoryConsolidationStorePort, "listChanges">;
      readonly undo: (changeId: string) => Promise<unknown>;
    };
    readonly reminders?: Pick<
      MemoryReminderStorePort,
      "schedule" | "listDue" | "listUpcoming" | "read" | "update"
    >;
    readonly payloads: PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly clock: ClockPort;
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
    if (
      text.trim().length === 0 ||
      scanMachineSecrets(text).length > 0 ||
      containsRestrictedIdentifier(text)
    )
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
    const settings = await this.options.book.readSettings(scope);
    const people = await this.options.book.listPeople(scope);
    const suggestions = await this.options.book.listPersonSuggestions(scope);
    const imports = await this.options.book.listImportBatches({ ...scope, limit: IMPORTS_SHOWN });
    const pending = await this.options.approvals.listPending(ownerId, null);
    const changes =
      (await this.options.consolidation?.store.listChanges({
        ownerId,
        agentId,
        limit: TIDY_UPS_SHOWN,
      })) ?? [];
    const due = await this.#dueReminders();
    return JSON.stringify([
      active.map(({ id, revision }) => [id, revision]),
      pending.map(({ id }) => id),
      changes.map(({ id, undoneAt }) => [id, undoneAt]),
      due.map(({ id, updatedAt }) => [id, updatedAt]),
      inactive.map(({ id, revision }) => [id, revision]),
      settings.updatedAt,
      (await this.options.book.latestGeneration(scope)) ?? null,
      people.map(({ id, updatedAt, memoryIds }) => [id, updatedAt, memoryIds.length]),
      suggestions.map(({ id }) => id),
      imports.map(({ id, undoneAt }) => [id, undoneAt]),
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

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "memory.overview.read") throw new Error("MEMORY_OPERATION_NOT_INSTALLED");
    const { ownerId, agentId } = this.options.configuration;
    const scope = this.#scope();
    await this.#purgeExpiredTrash();
    const records = [
      ...(await this.options.state.listActive(ownerId, agentId)),
      ...(await this.#inactive()),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const memories: OverviewSnapshot["payload"]["memories"][number][] = [];
    for (const memory of records) {
      if (memory.status !== "active" && memory.status !== "archived" && memory.status !== "trashed")
        continue;
      const text = singleLine(await this.readText(memory.contentRef).catch(() => ""));
      if (!text) continue;
      memories.push({
        memoryId: memory.id,
        revision: memory.revision,
        text,
        dataClassification: memory.dataClassification,
        topic: memory.attributes?.sensitiveTopic ?? null,
        inference: memory.inference,
        sourceThreadId: memory.sourceThreadId,
        sourceRefs: memory.sourceRefs.filter((ref) => ref.length <= 512),
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
    const { capturePaused } = await this.options.book.readSettings(scope);
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
            importancePermille: input.category === "rule" ? 800 : 600,
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
    const { contentRef, category, subCategory } = command.payload;
    const saved = await this.#createMemory({
      id: `memory:owner:${command.idempotencyKey}` as MemoryId,
      contentRef,
      category,
      subCategory,
      policyVersion: OWNER_POLICY_VERSION,
      importBatchId: null,
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
                status: "dismissed" as const,
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
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "MEMORY_OPERATION_NOT_INSTALLED",
    );
  }
}
