import {
  type DataClassification,
  highestClassification,
  isModelVisible,
  type MemoryProviderProjectionPort,
  type MemoryTimeScope,
  modelVisibleClassifications,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type RuntimeRequest,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { type MemoryEpisodeService, parseTimeScope } from "@himawari-agent/memory-engine";
import {
  TOOL_RECALL,
  TOOL_RESULT_RECALL_EMPTY,
  TOOL_RESULT_RECALL_HISTORY,
  TOOL_RESULT_RECALL_TENTATIVE,
} from "@himawari-agent/prompt-catalog";

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
  readonly state: Pick<ProductMemoryStatePort, "readMany">;
  readonly episodes?: Pick<MemoryEpisodeService, "search">;
  readonly readText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly embedWithin: <T>(
    invocation: RuntimeToolInvocation,
    slot: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly now: () => string;
  readonly timeZone?: string;
}

function startOfDay(day: string, timeZone: string): string {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })
    .formatToParts(new Date(guess))
    .reduce<Record<string, number>>((parts, { type, value }) => {
      parts[type] = Number(value);
      return parts;
    }, {});
  const offset =
    Date.UTC(
      local["year"] ?? 1970,
      (local["month"] ?? 1) - 1,
      local["day"] ?? 1,
      local["hour"] ?? 0,
      local["minute"] ?? 0,
    ) - guess;
  return new Date(guess - offset).toISOString();
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
  ): Promise<RecallResult> {
    return this.#recall(args, "public", within);
  }

  async #recall(
    args: RuntimeToolInvocation["arguments"],
    requestClassification: DataClassification,
    within: <T>(slot: string, operation: () => Promise<T>) => Promise<T>,
  ): Promise<RecallResult> {
    const input = argumentsOf(args);
    const timeZone = this.#options.timeZone ?? "UTC";
    const now = this.#options.now();
    const parsed = parseTimeScope(input.query, now, timeZone);
    const explicit = input.from !== undefined || input.to !== undefined;
    const from = input.from ?? input.to;
    const to = input.to ?? input.from;
    const scope: MemoryTimeScope = explicit
      ? {
          includeHistory: true,
          from: from ? startOfDay(from, timeZone) : null,
          to: to
            ? new Date(
                Date.parse(
                  startOfDay(
                    new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000)
                      .toISOString()
                      .slice(0, 10),
                    timeZone,
                  ),
                ) - 1,
              ).toISOString()
            : null,
        }
      : {
          includeHistory: input.includeHistory || parsed?.includeHistory === true,
          from: parsed?.from ?? null,
          to: parsed?.to ?? null,
        };
    const allowed = modelVisibleClassifications();
    const shown: DataClassification[] = [];
    const shownIds: string[] = [];
    const searchScope = {
      ...scope,
      includeHistory: scope.includeHistory || input.includeHistory,
    };
    const tentativeLimit = Math.floor(input.limit / 2);
    const [hits, tentativeHits] = await Promise.all([
      within("memory-recall", () =>
        this.#options.provider.search({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          query: input.query,
          limit: input.limit * 3,
          scope: searchScope,
        }),
      ),
      tentativeLimit === 0
        ? Promise.resolve([])
        : within("memory-recall-tentative", () =>
            this.#options.provider.search({
              ownerId: this.#options.ownerId,
              agentId: this.#options.agentId,
              query: input.query,
              limit: input.limit * 3,
              scope: searchScope,
              includeTentative: true,
              tentativeOnly: true,
            }),
          ).catch(() => []),
    ]);
    const records = new Map(
      (
        await this.#options.state.readMany({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          memoryIds: [...hits, ...tentativeHits].map(({ productMemoryId }) => productMemoryId),
        })
      ).map((record) => [record.id, record]),
    );
    const render = async (
      candidates: typeof hits,
      wanted: "confirmed" | "tentative",
      count: number,
    ): Promise<Record<string, unknown>[]> => {
      const rendered: Record<string, unknown>[] = [];
      for (const hit of candidates) {
        if (rendered.length >= count) break;
        const memory = records.get(hit.productMemoryId);
        if (
          !memory ||
          memory.status !== "active" ||
          memory.providerRecordId !== hit.providerRecordId ||
          !isModelVisible(memory.dataClassification) ||
          (memory.attributes?.tentative === true) !== (wanted === "tentative")
        )
          continue;
        const text = await this.#options.readText(memory).catch(() => undefined);
        if (!text) continue;
        shown.push(memory.dataClassification);
        shownIds.push(memory.id);
        const attributes = memory.attributes;
        const validTo = attributes?.validTo ?? null;
        rendered.push({
          text,
          ...(wanted === "tentative" ? { tentative: true } : {}),
          current: validTo === null || validTo > now,
          ...(attributes?.supersededBy ? { correctedLater: true } : {}),
          recordedAt: memory.recordedAt ?? memory.updatedAt,
          validFrom: attributes?.validFrom ?? null,
          validTo,
        });
      }
      return rendered;
    };
    const tentativeMemories = await render(tentativeHits, "tentative", tentativeLimit);
    const confirmedMemories = await render(
      hits,
      "confirmed",
      input.limit - tentativeMemories.length,
    );
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
    };
  }
}
