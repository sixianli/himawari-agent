import type {
  DataClassification,
  MemoryProviderProjectionPort,
  MemoryTimeScope,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { type MemoryEpisodeService, parseTimeScope } from "@himawari-agent/memory-engine";
import { TOOL_RECALL } from "@himawari-agent/prompt-catalog";

export const MEMORY_RECALL_CAPABILITY_REF = "memory.recall";
const CLASSIFICATIONS: readonly DataClassification[] = [
  "public",
  "private",
  "sensitive",
  "restricted",
];
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

function argumentsOf(invocation: RuntimeToolInvocation) {
  const args = invocation.arguments;
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

export class ProductionMemoryRecall {
  readonly #options: ProductionMemoryRecallOptions;

  constructor(options: ProductionMemoryRecallOptions) {
    this.#options = options;
  }

  async recall(invocation: RuntimeToolInvocation): Promise<unknown> {
    const input = argumentsOf(invocation);
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
    const allowed = CLASSIFICATIONS.slice(
      0,
      CLASSIFICATIONS.indexOf(invocation.dataClassification) + 1,
    );
    const hits = await this.#options.embedWithin(invocation, "memory-recall", () =>
      this.#options.provider.search({
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        query: input.query,
        limit: input.limit * 3,
        scope: { ...scope, includeHistory: scope.includeHistory || input.includeHistory },
      }),
    );
    const records = new Map(
      (
        await this.#options.state.readMany({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          memoryIds: hits.map(({ productMemoryId }) => productMemoryId),
        })
      ).map((record) => [record.id, record]),
    );
    const memories: Record<string, unknown>[] = [];
    for (const hit of hits) {
      if (memories.length >= input.limit) break;
      const memory = records.get(hit.productMemoryId);
      if (
        !memory ||
        memory.status !== "active" ||
        memory.providerRecordId !== hit.providerRecordId ||
        !allowed.includes(memory.dataClassification)
      )
        continue;
      const text = await this.#options.readText(memory).catch(() => undefined);
      if (!text) continue;
      const attributes = memory.attributes;
      const validTo = attributes?.validTo ?? null;
      memories.push({
        text,
        current: validTo === null || validTo > now,
        ...(attributes?.supersededBy ? { correctedLater: true } : {}),
        recordedAt: memory.recordedAt ?? memory.updatedAt,
        validFrom: attributes?.validFrom ?? null,
        validTo,
      });
    }
    const episodes = this.#options.episodes
      ? await this.#options.embedWithin(invocation, "memory-recall-episodes", () =>
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
    return {
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
          ? "没有找到相关的记忆或对话摘要。不要编造，直接告诉主人没有记录。"
          : "current 为 false 的记忆是以前的情况，回答时说明时间。",
    };
  }
}
