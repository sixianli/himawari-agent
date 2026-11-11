import { MEMORY_SOURCE_REF_MAX_LENGTH, memorySourceState } from "@himawari-agent/gateway-contracts";
import type { AgentId, MemoryGenerationId, MemoryId, OwnerId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  type MemoryCheckupAction,
  type MemoryCheckupBefore,
  type MemoryCheckupItem,
  type MemoryCheckupReason,
  type MemoryCheckupStorePort,
  PORT_ERROR_CODES,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
} from "../ports/index.js";
import type { DurableMemoryService } from "./durable-memory-service.js";
import { startOfZonedDay } from "./proactive-rules.js";

const DAY_MS = 86_400_000;
export const MEMORY_CHECKUP_CONFIRM_QUIET_DAYS = 84;
export const MEMORY_CHECKUP_REASON_ORDER: readonly MemoryCheckupReason[] = [
  "conflict",
  "unused",
  "low_confidence",
  "source_unavailable",
];

export interface MemoryCheckupPair {
  readonly memoryId: MemoryId;
  readonly relatedMemoryId: MemoryId;
}

export interface MemoryCheckupCandidate {
  readonly memoryId: MemoryId;
  readonly relatedMemoryId: MemoryId | null;
  readonly reason: MemoryCheckupReason;
}

const WEEKDAY_OFFSET: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export function checkupWeekStart(now: string, timeZone: string): string {
  const today = startOfZonedDay(now, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(new Date(Date.parse(today) + DAY_MS / 2));
  const offset = WEEKDAY_OFFSET[weekday] ?? 0;
  return startOfZonedDay(
    new Date(Date.parse(today) - offset * DAY_MS + DAY_MS / 2).toISOString(),
    timeZone,
  );
}

function lastUse(record: ProductMemoryRecord): number {
  return Date.parse(record.lastUsedAt ?? record.recordedAt ?? record.updatedAt);
}

function live(record: ProductMemoryRecord | undefined): record is ProductMemoryRecord {
  return record?.status === "active" && (record.attributes?.supersededBy ?? null) === null;
}

export function pickMemoryCheckup(input: {
  readonly records: readonly ProductMemoryRecord[];
  readonly sourceMessageIds: ReadonlyMap<string, string | null>;
  readonly pairs: readonly MemoryCheckupPair[];
  readonly quiet: ReadonlySet<string>;
  readonly now: string;
  readonly unusedDays: number;
  readonly lowConfidenceThreshold: (category: string | null) => number;
  readonly limit: number;
}): readonly MemoryCheckupCandidate[] {
  const records = input.records.filter(live);
  const byId = new Map(records.map((record) => [record.id as string, record]));
  const unusedBefore = Date.parse(input.now) - input.unusedDays * DAY_MS;
  const byKey = (left: ProductMemoryRecord, right: ProductMemoryRecord) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  const pairs = input.pairs.filter(
    ({ memoryId, relatedMemoryId }) =>
      byId.get(memoryId)?.attributes?.tentative === true && byId.has(relatedMemoryId),
  );
  const paired = new Set<string>(
    pairs.flatMap(({ memoryId, relatedMemoryId }) => [memoryId, relatedMemoryId]),
  );
  const queues: Record<MemoryCheckupReason, MemoryCheckupCandidate[]> = {
    conflict: pairs.map(({ memoryId, relatedMemoryId }) => ({
      memoryId,
      relatedMemoryId,
      reason: "conflict",
    })),
    unused: records
      .filter((record) => lastUse(record) < unusedBefore)
      .toSorted((left, right) => lastUse(left) - lastUse(right) || byKey(left, right))
      .map(({ id }) => ({
        memoryId: id,
        relatedMemoryId: null,
        reason: "unused",
      })),
    low_confidence: records
      .filter(
        (record) =>
          record.confidencePermille <
          input.lowConfidenceThreshold(record.attributes?.category ?? null),
      )
      .toSorted(
        (left, right) => left.confidencePermille - right.confidencePermille || byKey(left, right),
      )
      .map(({ id }) => ({
        memoryId: id,
        relatedMemoryId: null,
        reason: "low_confidence",
      })),
    source_unavailable: records
      .filter(
        (record) =>
          memorySourceState({
            memoryId: record.id,
            importBatchId: record.attributes?.importBatchId ?? null,
            sourceThreadId: record.sourceThreadId,
            sourceMessageId: input.sourceMessageIds.get(record.id) ?? null,
            sourceRefs: record.sourceRefs.filter(
              (ref) => ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH,
            ),
            history: [],
          }) === "unavailable",
      )
      .toSorted((left, right) => lastUse(left) - lastUse(right) || byKey(left, right))
      .map(({ id }) => ({
        memoryId: id,
        relatedMemoryId: null,
        reason: "source_unavailable",
      })),
  };
  const taken: MemoryCheckupCandidate[] = [];
  const seen = new Set<string>();
  const ordered = MEMORY_CHECKUP_REASON_ORDER.map((reason) =>
    reason === "conflict"
      ? queues[reason]
      : queues[reason].filter(
          ({ memoryId }) => !input.quiet.has(memoryId) && !paired.has(memoryId),
        ),
  );
  const cursors = ordered.map(() => 0);
  while (taken.length < input.limit) {
    let added = false;
    for (const [index, queue] of ordered.entries()) {
      if (taken.length >= input.limit) break;
      while ((cursors[index] ?? 0) < queue.length) {
        const next = queue[cursors[index] ?? 0];
        cursors[index] = (cursors[index] ?? 0) + 1;
        if (!next) continue;
        const ids = [next.memoryId, ...(next.relatedMemoryId ? [next.relatedMemoryId] : [])];
        if (ids.some((id) => seen.has(id))) continue;
        for (const id of ids) seen.add(id);
        taken.push(next);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return taken;
}

export interface MemoryCheckupServiceOptions {
  readonly scope: { readonly ownerId: OwnerId; readonly agentId: AgentId };
  readonly store: MemoryCheckupStorePort;
  readonly state: Pick<ProductMemoryStatePort, "read" | "listActive">;
  readonly memory: Pick<DurableMemoryService, "confirm" | "trash" | "recover" | "revise">;
  readonly generationFor: (memoryId: MemoryId) => Promise<MemoryGenerationId>;
  readonly sourceMessageIds: (
    records: readonly ProductMemoryRecord[],
  ) => Promise<ReadonlyMap<string, string | null>>;
  readonly pairs: () => Promise<readonly MemoryCheckupPair[]>;
  readonly unusedDays: number;
  readonly lowConfidenceThreshold: (category: string | null) => number;
  readonly capacity: () => number;
  readonly timeZone: string;
  readonly now: () => string;
  readonly id: () => string;
}

function refuse(code: string, reason: string): never {
  throw new ApplicationPortError(
    code === "conflict" ? PORT_ERROR_CODES.CONFLICT : PORT_ERROR_CODES.INVALID_OPERATION,
    reason,
  );
}

export class MemoryCheckupService {
  readonly #options: MemoryCheckupServiceOptions;
  #emptyWeek: string | null = null;

  constructor(options: MemoryCheckupServiceOptions) {
    this.#options = options;
  }

  async week(): Promise<readonly MemoryCheckupItem[]> {
    const { scope, store } = this.#options;
    const now = this.#options.now();
    const weekStart = checkupWeekStart(now, this.#options.timeZone);
    if (this.#emptyWeek === weekStart) return [];
    const existing = await store.listWeek({ ...scope, weekStart });
    if (existing.length > 0) return existing;
    const records = await this.#options.state.listActive(scope.ownerId, scope.agentId);
    const quiet = new Set<string>(
      await store.listConfirmedSince({
        ...scope,
        since: new Date(Date.parse(now) - MEMORY_CHECKUP_CONFIRM_QUIET_DAYS * DAY_MS).toISOString(),
      }),
    );
    const picked = pickMemoryCheckup({
      records,
      sourceMessageIds: await this.#options.sourceMessageIds(records),
      pairs: await this.#options.pairs(),
      quiet,
      now,
      unusedDays: this.#options.unusedDays,
      lowConfidenceThreshold: this.#options.lowConfidenceThreshold,
      limit: this.#options.capacity(),
    });
    if (picked.length === 0) {
      this.#emptyWeek = weekStart;
      return [];
    }
    await store.createWeek({
      ...scope,
      weekStart,
      items: picked.map((candidate) => ({
        id: this.#options.id(),
        ...candidate,
      })),
      createdAt: now,
    });
    return store.listWeek({ ...scope, weekStart });
  }

  async #item(id: string): Promise<MemoryCheckupItem> {
    const item = await this.#options.store.read({ ...this.#options.scope, id });
    if (!item)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_CHECKUP_NOT_FOUND");
    return item;
  }

  async #live(memoryId: MemoryId): Promise<ProductMemoryRecord> {
    const record = await this.#options.state.read(memoryId);
    if (!live(record)) refuse("invalid", "MEMORY_CHECKUP_STALE");
    return record;
  }

  async act(input: {
    readonly id: string;
    readonly action: MemoryCheckupAction;
    readonly keep: MemoryId | null;
  }): Promise<MemoryCheckupItem> {
    const item = await this.#item(input.id);
    if (item.action !== null) refuse("conflict", "MEMORY_CHECKUP_ALREADY_HANDLED");
    const now = this.#options.now();
    const subject = await this.#live(item.memoryId);
    const tentative = subject.attributes?.tentative === true;
    if (item.reason === "conflict" && !tentative) refuse("invalid", "MEMORY_CHECKUP_STALE");
    const { memory, generationFor } = this.#options;
    let before: MemoryCheckupBefore;
    let keptMemoryId: MemoryId | null = null;
    let apply: () => Promise<void>;
    if (input.action === "confirm") {
      before = { tentative };
      apply = async () => {
        if (tentative) await memory.confirm(subject.id, await generationFor(subject.id));
      };
    } else if (input.action === "delete") {
      before = { tentative, status: "active" };
      apply = async () => {
        await memory.trash(subject.id, await generationFor(subject.id));
      };
    } else {
      const related = item.relatedMemoryId;
      if (related === null || (input.keep !== item.memoryId && input.keep !== related))
        refuse("invalid", "MEMORY_CHECKUP_MERGE_REFUSED");
      const keep = await this.#live(input.keep);
      const drop = await this.#live(input.keep === item.memoryId ? related : item.memoryId);
      const keepTentative = keep.attributes?.tentative === true;
      keptMemoryId = keep.id;
      before = {
        tentative,
        dropMemoryId: drop.id,
        dropStatus: "active",
        dropSupersededBy: drop.attributes?.supersededBy ?? null,
        dropValidTo: drop.attributes?.validTo ?? null,
        keepTentative,
      };
      apply = async () => {
        await memory.revise({
          memoryId: drop.id,
          expectedRevision: drop.revision,
          status: "archived",
          attributes: { supersededBy: keep.id, validTo: now },
          generationId: await generationFor(drop.id),
        });
        if (keepTentative) await memory.confirm(keep.id, await generationFor(keep.id));
      };
    }
    const claimed = await this.#options.store.recordAction({
      ...this.#options.scope,
      id: item.id,
      action: input.action,
      keptMemoryId,
      before,
      handledAt: now,
    });
    if (!claimed) refuse("conflict", "MEMORY_CHECKUP_ALREADY_HANDLED");
    try {
      await apply();
    } catch (error) {
      const restored = await this.#restore(item.id).then(
        () => true,
        () => false,
      );
      if (!restored) refuse("conflict", "MEMORY_CHECKUP_RESTORE_FAILED");
      throw error;
    }
    return this.#item(item.id);
  }

  async undo(id: string): Promise<MemoryCheckupItem> {
    return this.#restore(id);
  }

  async #restore(id: string): Promise<MemoryCheckupItem> {
    const item = await this.#item(id);
    const before = item.before;
    if (item.action === null || before === null) refuse("invalid", "MEMORY_CHECKUP_NOT_HANDLED");
    const { memory, generationFor, state } = this.#options;
    if (item.action === "confirm") {
      const current = await state.read(item.memoryId);
      if (before.tentative && live(current) && current.attributes?.tentative !== true)
        await memory.revise({
          memoryId: current.id,
          expectedRevision: current.revision,
          attributes: { tentative: true },
          generationId: await generationFor(current.id),
        });
    } else if (item.action === "delete") {
      const current = await state.read(item.memoryId);
      if (current?.status === "trashed")
        await memory.recover(current.id, await generationFor(current.id));
    } else {
      const dropId = before.dropMemoryId;
      const keepId = item.keptMemoryId;
      const drop = dropId ? await state.read(dropId) : undefined;
      const merged =
        keepId !== null && drop?.status === "archived" && drop.attributes?.supersededBy === keepId;
      if (merged)
        await memory.revise({
          memoryId: drop.id,
          expectedRevision: drop.revision,
          status: before.dropStatus ?? "active",
          attributes: {
            supersededBy: before.dropSupersededBy ?? null,
            validTo: before.dropValidTo ?? null,
          },
          generationId: await generationFor(drop.id),
        });
      const keep = keepId ? await state.read(keepId) : undefined;
      if (before.keepTentative && live(keep) && keep.attributes?.tentative !== true)
        await memory.revise({
          memoryId: keep.id,
          expectedRevision: keep.revision,
          attributes: { tentative: true },
          generationId: await generationFor(keep.id),
        });
    }
    const undone = await this.#options.store.recordUndo({
      ...this.#options.scope,
      id: item.id,
      undoneAt: this.#options.now(),
    });
    if (!undone) refuse("conflict", "MEMORY_CHECKUP_NOT_HANDLED");
    return this.#item(item.id);
  }
}
