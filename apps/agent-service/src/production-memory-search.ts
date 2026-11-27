import type {
  MemoryProviderProjectionPort,
  ProductMemoryRecord,
  ProductMemoryStatePort,
} from "@himawari-agent/application";
import {
  type GatewayV2Query,
  type GatewayV2Snapshot,
  MEMORY_CATEGORY_NAMES,
} from "@himawari-agent/gateway-contracts";
import type { ProductionOwnerRuleWriter } from "./production-owner-rules.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";

type SearchSnapshot = Extract<GatewayV2Snapshot, { type: "memory.search.snapshot" }>;
type Result = SearchSnapshot["payload"]["results"][number];

export const PRODUCTION_MEMORY_SEARCH_OPERATIONS = Object.freeze(["memory.search.read"] as const);
export const MEMORY_SEARCH_DEPTH = 50;
const TEXT_MAXIMUM = 2000;

export interface ProductionMemorySearchOptions {
  readonly ownerId: ProductMemoryRecord["ownerId"];
  readonly agentId: ProductMemoryRecord["agentId"];
  readonly provider: Pick<MemoryProviderProjectionPort, "search">;
  readonly state: Pick<ProductMemoryStatePort, "readMany">;
  readonly rules?: Pick<ProductionOwnerRuleWriter, "list">;
  readonly readText: (record: ProductMemoryRecord) => Promise<string | undefined>;
  readonly embedOutsideRun: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly requestTimeoutMs: number;
  readonly clock: { readonly now: () => string };
}

function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function clip(text: string): string {
  if (text.length <= TEXT_MAXIMUM) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > TEXT_MAXIMUM - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

function categoryOf(memory: ProductMemoryRecord): Result["category"] {
  const category = memory.attributes?.category ?? "other";
  return (MEMORY_CATEGORY_NAMES as readonly string[]).includes(category)
    ? (category as Result["category"])
    : "other";
}

export class ProductionMemorySearch {
  readonly #options: ProductionMemorySearchOptions;

  constructor(options: ProductionMemorySearchOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "memory.search.read") throw new Error("MEMORY_OPERATION_NOT_INSTALLED");
    const asked = singleLine(query.payload.query);
    return {
      ...query,
      kind: "snapshot",
      type: "memory.search.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        query: query.payload.query,
        results: asked.length === 0 ? [] : await this.#search(asked),
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async #search(asked: string): Promise<Result[]> {
    const { ownerId, agentId, requestTimeoutMs } = this.#options;
    const now = this.#options.clock.now();
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const hits = await this.#options.embedOutsideRun(
      {
        deadlineAt: new Date(Date.parse(now) + requestTimeoutMs).toISOString(),
        signal: timeout,
        costMicros: 0,
      },
      () =>
        this.#options.provider.search({
          ownerId,
          agentId,
          query: asked,
          limit: MEMORY_SEARCH_DEPTH,
          relevanceCutoff: true,
          includeTentative: true,
        }),
    );
    if (hits.length === 0) return [];
    const [records, rules] = await Promise.all([
      this.#options.state.readMany({
        ownerId,
        agentId,
        memoryIds: hits.map(({ productMemoryId }) => productMemoryId),
      }),
      this.#options.rules ? this.#options.rules.list() : Promise.resolve([]),
    ]);
    const byId = new Map(records.map((record) => [record.id as string, record]));
    const ruleBySource = new Map<string, string>();
    for (const rule of rules)
      if (rule.sourceMemoryId !== null) ruleBySource.set(rule.sourceMemoryId, rule.ruleId);
    const results: Result[] = [];
    const seen = new Set<string>();
    for (const hit of [...hits].sort((left, right) => right.score - left.score)) {
      const memory = byId.get(hit.productMemoryId);
      if (
        !memory ||
        seen.has(memory.id) ||
        memory.status !== "active" ||
        memory.providerRecordId !== hit.providerRecordId ||
        (memory.attributes?.supersededBy ?? null) !== null
      )
        continue;
      const text = singleLine((await this.#options.readText(memory).catch(() => "")) ?? "");
      if (text.length === 0) continue;
      seen.add(memory.id);
      const category = categoryOf(memory);
      const ruleId = ruleBySource.get(memory.id) ?? null;
      results.push({
        kind: category === "rule" || ruleId !== null ? "rule" : "memory",
        memoryId: memory.id,
        ruleId,
        text: clip(text),
        category,
        tentative: memory.attributes?.tentative === true,
        updatedAt: memory.updatedAt,
      });
    }
    return results;
  }
}
