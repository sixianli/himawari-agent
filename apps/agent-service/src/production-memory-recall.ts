import {
  classificationRank,
  type DataClassification,
  highestClassification,
  type MemoryProviderProjectionPort,
  type MemoryTimeScope,
  modelVisibleClassifications,
  nearDuplicateText,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type RuntimeRequest,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { type MemoryEpisodeService, requestedTimeScope } from "@himawari-agent/memory-engine";
import {
  TOOL_RECALL,
  TOOL_RESULT_RECALL_EMPTY,
  TOOL_RESULT_RECALL_HISTORY,
  TOOL_RESULT_RECALL_TENTATIVE,
} from "@himawari-agent/prompt-catalog";
import { carriesExternalContent } from "./context-external-content.js";

export const MEMORY_RECALL_CAPABILITY_REF = "memory.recall";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_LIMIT = 6;

export function memoryRecallDescriptor(): RuntimeToolDescriptor {
  return {
    name: "recall",
    capabilityRef: MEMORY_RECALL_CAPABILITY_REF,
    capabilityHandleRef: null,
    description: TOOL_RECALL.text,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        includeHistory: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export interface ProductionMemoryRecallOptions {
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly provider: Pick<MemoryProviderProjectionPort, "search">;
  readonly state: Pick<ProductMemoryStatePort, "readMany" | "numbers">;
  readonly episodes?: Pick<MemoryEpisodeService, "search">;
  readonly readText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly embedWithin: <T>(
    invocation: RuntimeToolInvocation,
    slot: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly dedupeSameSource?: boolean;
}

function argumentsOf(args: RuntimeToolInvocation["arguments"]) {
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  const from = args["from"];
  const to = args["to"];
  const limit = args["limit"] ?? DEFAULT_LIMIT;
  if (
    query.length === 0 ||
    query.length > 500 ||
    (from !== undefined && (typeof from !== "string" || !DATE.test(from))) ||
    (to !== undefined && (typeof to !== "string" || !DATE.test(to))) ||
    (args["includeHistory"] !== undefined && typeof args["includeHistory"] !== "boolean") ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    Object.keys(args).some(
      (name) => !["query", "from", "to", "includeHistory", "limit"].includes(name),
    )
  )
    throw new Error("MEMORY_RECALL_INPUT_INVALID");
  return {
    query,
    from: from as string | undefined,
    to: to as string | undefined,
    includeHistory: args["includeHistory"] === true,
    limit,
  };
}

export interface RecallResult {
  readonly output: Record<string, unknown>;
  readonly contentClassification: DataClassification;
  readonly memoryIds: readonly string[];
  readonly externalContent?: boolean;
}

export class ProductionMemoryRecall {
  readonly #options: ProductionMemoryRecallOptions;

  constructor(options: ProductionMemoryRecallOptions) {
    this.#options = options;
  }

  async recall(invocation: RuntimeToolInvocation): Promise<unknown> {
    return (await this.recallWithClassification(invocation)).output;
  }

  async recallWithClassification(invocation: RuntimeToolInvocation): Promise<RecallResult> {
    return this.#recall(invocation.arguments, invocation.dataClassification, (slot, operation) =>
      this.#options.embedWithin(invocation, slot, operation),
    );
  }

  recallOutsideRun(
    args: RuntimeToolInvocation["arguments"],
    within: <T>(slot: string, operation: () => Promise<T>) => Promise<T>,
    ceiling: DataClassification,
  ): Promise<RecallResult> {
    return this.#recall(args, "public", within, ceiling);
  }

  async #recall(
    args: RuntimeToolInvocation["arguments"],
    requestClassification: DataClassification,
    within: <T>(slot: string, operation: () => Promise<T>) => Promise<T>,
    ceiling?: DataClassification,
  ): Promise<RecallResult> {
    const input = argumentsOf(args);
    const timeZone = this.#options.timeZone ?? "UTC";
    const now = this.#options.now();
    let scope: MemoryTimeScope;
    try {
      scope = requestedTimeScope(input, timeZone);
    } catch (error) {
      if (error instanceof RangeError && error.message === "MEMORY_TIME_SCOPE_INVALID")
        throw new Error("MEMORY_RECALL_INPUT_INVALID");
      throw error;
    }
    const allowed = modelVisibleClassifications().filter(
      (classification) =>
        ceiling === undefined || classificationRank(classification) <= classificationRank(ceiling),
    );
    const shown: DataClassification[] = [];
    const shownIds: string[] = [];
    let externalContent = false;
    const tentativeLimit = Math.floor(input.limit / 2);
    const [confirmed, tentativeHits] = await Promise.all([
      within("memory-recall", () =>
        this.#options.provider.search({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          query: input.query,
          limit: input.limit * 3,
          scope,
          relevanceCutoff: true,
        }),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      tentativeLimit === 0
        ? Promise.resolve([])
        : within("memory-recall-tentative", () =>
            this.#options.provider.search({
              ownerId: this.#options.ownerId,
              agentId: this.#options.agentId,
              query: input.query,
              limit: input.limit * 3,
              scope,
              relevanceCutoff: true,
              includeTentative: true,
              tentativeOnly: true,
            }),
          ).catch(() => []),
    ]);
    if (confirmed.status === "rejected") throw confirmed.reason;
    const hits = confirmed.value;
    const records = new Map(
      (
        await this.#options.state.readMany({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          memoryIds: [...hits, ...tentativeHits].map(({ productMemoryId }) => productMemoryId),
        })
      ).map((record) => [record.id, record]),
    );
    type Shown = {
      readonly memory: ProductMemoryRecord;
      readonly text: string;
      readonly wanted: "confirmed" | "tentative";
    };
    const dedupe = this.#options.dedupeSameSource !== false;
    const duplicateOf = (
      shownSoFar: readonly Shown[],
      memory: ProductMemoryRecord,
      text: string,
    ) =>
      dedupe
        ? shownSoFar.find(
            (earlier) =>
              earlier.memory.sourceRefs.some((source) => memory.sourceRefs.includes(source)) &&
              nearDuplicateText(earlier.text, text),
          )
        : undefined;
    const eligible = async (
      hit: (typeof hits)[number],
      wanted: "confirmed" | "tentative",
    ): Promise<Shown | undefined> => {
      const memory = records.get(hit.productMemoryId);
      if (
        !memory ||
        memory.status !== "active" ||
        memory.providerRecordId !== hit.providerRecordId ||
        !allowed.includes(memory.dataClassification) ||
        (memory.attributes?.tentative === true) !== (wanted === "tentative")
      )
        return undefined;
      const text = await this.#options.readText(memory).catch(() => undefined);
      return text ? { memory, text, wanted } : undefined;
    };
    const tentativeKept: Shown[] = [];
    let nextTentative = 0;
    const fillTentative = async (): Promise<void> => {
      while (
        nextTentative < tentativeHits.length &&
        tentativeKept.length < tentativeLimit &&
        tentativeKept.length + confirmedKept.length < input.limit
      ) {
        const hit = tentativeHits[nextTentative] as (typeof tentativeHits)[number];
        nextTentative += 1;
        const shownHit = await eligible(hit, "tentative");
        if (
          shownHit &&
          !duplicateOf(tentativeKept, shownHit.memory, shownHit.text) &&
          !duplicateOf(confirmedKept, shownHit.memory, shownHit.text)
        )
          tentativeKept.push(shownHit);
      }
    };
    const confirmedKept: Shown[] = [];
    await fillTentative();
    let replaced = false;
    for (const hit of hits) {
      const room = input.limit - tentativeKept.length - confirmedKept.length;
      if (room <= 0 && (!dedupe || tentativeKept.length === 0)) break;
      const shownHit = await eligible(hit, "confirmed");
      if (!shownHit || duplicateOf(confirmedKept, shownHit.memory, shownHit.text)) continue;
      const twin = duplicateOf(tentativeKept, shownHit.memory, shownHit.text);
      if (twin) {
        tentativeKept.splice(tentativeKept.indexOf(twin), 1);
        replaced = true;
      } else if (room <= 0) continue;
      confirmedKept.push(shownHit);
    }
    if (replaced) await fillTentative();
    const numbers = new Map(
      (
        await this.#options.state.numbers({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          memoryIds: [...confirmedKept, ...tentativeKept].map(({ memory }) => memory.id),
        })
      ).map(({ memoryId, number }) => [memoryId as string, number]),
    );
    const present = ({ memory, text, wanted }: Shown): Record<string, unknown> => {
      shown.push(memory.dataClassification);
      shownIds.push(memory.id);
      if (carriesExternalContent(memory.sourceRefs)) externalContent = true;
      const attributes = memory.attributes;
      const validTo = attributes?.validTo ?? null;
      return {
        number: numbers.get(memory.id) ?? null,
        text,
        ...(wanted === "tentative" ? { tentative: true } : {}),
        current: validTo === null || validTo > now,
        ...(attributes?.supersededBy ? { correctedLater: true } : {}),
        recordedAt: memory.recordedAt ?? memory.updatedAt,
        validFrom: attributes?.validFrom ?? null,
        validTo,
      };
    };
    const confirmedMemories = confirmedKept.map(present);
    const tentativeMemories = tentativeKept.map(present);
    const memories = [...confirmedMemories, ...tentativeMemories];
    const tentativeCount = tentativeMemories.length;
    const episodes = this.#options.episodes
      ? await within("memory-recall-episodes", () =>
          (this.#options.episodes as Pick<MemoryEpisodeService, "search">).search({
            ownerId: this.#options.ownerId,
            agentId: this.#options.agentId,
            query: input.query,
            scope,
            allowedClassifications: allowed,
            limit: Math.min(5, input.limit),
          }),
        )
      : [];
    const contentClassification = highestClassification(requestClassification, [
      ...shown,
      ...episodes.map(({ episode }) => episode.dataClassification),
    ]);
    const output = {
      query: input.query,
      window: scope.from || scope.to ? { from: scope.from, to: scope.to, timeZone } : null,
      memories,
      conversations: episodes.map(({ episode, text }) => ({
        day: episode.day,
        source: episode.source,
        summary: text,
      })),
      note:
        memories.length === 0 && episodes.length === 0
          ? TOOL_RESULT_RECALL_EMPTY.text
          : TOOL_RESULT_RECALL_HISTORY.text,
      ...(tentativeCount > 0 ? { tentativeNote: TOOL_RESULT_RECALL_TENTATIVE.text } : {}),
    };
    return {
      output,
      contentClassification,
      memoryIds: shownIds,
      externalContent,
    };
  }
}
