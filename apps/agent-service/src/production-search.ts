import type {
  DataClassification,
  MemoryProviderProjectionPort,
  MemoryTimeScope,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  SearchAskConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Query,
  GatewayV2Snapshot,
  HOME_LOCALES,
} from "@himawari-agent/gateway-contracts";
import { queryTerms } from "@himawari-agent/memory-engine";

type SearchSnapshot = Extract<GatewayV2Snapshot, { type: "search.ask.snapshot" }>;
type Locale = (typeof HOME_LOCALES)[number];
type Basis = SearchSnapshot["payload"]["basis"][number];

export const PRODUCTION_SEARCH_OPERATIONS = Object.freeze(["search.ask.read"] as const);

export const SEARCH_TEXT: Readonly<Record<Locale, { readonly notFound: string }>> = Object.freeze({
  "zh-CN": { notFound: "没有找到相关的记忆或对话。" },
  en: { notFound: "I couldn’t find a related memory or conversation." },
  ja: { notFound: "関連する記憶や会話は見つかりませんでした。" },
});

function dateParts(at: string, now: string, timeZone: string) {
  const part = (instant: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(instant));
    const value = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    return { year: value("year"), month: value("month"), day: value("day") };
  };
  const date = part(at);
  return { ...date, otherYear: date.year !== part(now).year };
}

const BASIS_LABELS: Readonly<
  Record<Locale, (kind: Basis["kind"], date: ReturnType<typeof dateParts>) => string>
> = Object.freeze({
  "zh-CN": (kind, { year, month, day, otherYear }) => {
    const when = `${otherYear ? `${year} 年 ` : ""}${month} 月 ${day} 日`;
    return kind === "conversation" ? `${when}你在对话里说的` : `记忆 · ${when}记下`;
  },
  en: (kind, { year, month, day, otherYear }) => {
    const when = new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      ...(otherYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
    return kind === "conversation"
      ? `You said this in a conversation on ${when}`
      : `Memory · saved ${when}`;
  },
  ja: (kind, { year, month, day, otherYear }) => {
    const when = `${otherYear ? `${year}年` : ""}${month}月${day}日`;
    return kind === "conversation" ? `${when}の会話であなたが話したこと` : `記憶 · ${when}に記録`;
  },
});

const SUGGESTION_CATEGORIES: ReadonlySet<string> = new Set([
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
]);
const ASK_MAXIMUM_CHARACTERS = 120;

export interface ProductionSearchOptions {
  readonly ownerId: ProductMemoryRecord["ownerId"];
  readonly agentId: ProductMemoryRecord["agentId"];
  readonly settings: SearchAskConfiguration;
  readonly timeZone?: string;
  readonly provider: Pick<MemoryProviderProjectionPort, "search">;
  readonly state: Pick<ProductMemoryStatePort, "readMany" | "listActive">;
  readonly episodes?: {
    search(input: {
      readonly ownerId: ProductMemoryRecord["ownerId"];
      readonly agentId: ProductMemoryRecord["agentId"];
      readonly query: string;
      readonly scope: MemoryTimeScope | null;
      readonly allowedClassifications: readonly DataClassification[];
      readonly limit: number;
      readonly lexicalOnly?: boolean;
    }): Promise<
      readonly {
        readonly episode: {
          readonly threadId: string;
          readonly endedAt: string;
          readonly dataClassification: DataClassification;
        };
        readonly text: string;
      }[]
    >;
  };
  readonly readText: (record: ProductMemoryRecord) => Promise<string | undefined>;
  readonly clock: { readonly now: () => string };
}

interface Candidate {
  readonly answer: string;
  readonly coverage: number;
  readonly order: number;
  readonly basis: Omit<Basis, "label">;
}

const SEARCH_VISIBLE: readonly DataClassification[] = Object.freeze(["public", "private"]);

function searchVisible(classification: string): boolean {
  return (SEARCH_VISIBLE as readonly string[]).includes(classification);
}

function currentlyShown(memory: ProductMemoryRecord, now: string): boolean {
  const attributes = memory.attributes;
  if ((attributes?.supersededBy ?? null) !== null || attributes?.tentative === true) return false;
  const validTo = attributes?.validTo ?? null;
  if (validTo !== null && validTo <= now) return false;
  return searchVisible(memory.dataClassification);
}

function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function coverage(terms: readonly string[], text: string): number {
  if (terms.length === 0) return 0;
  const haystack = text.normalize("NFKC").toLowerCase();
  return (
    terms.filter((term) => haystack.includes(term.normalize("NFKC").toLowerCase())).length /
    terms.length
  );
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > limit - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

export class ProductionSearchControl {
  readonly #options: ProductionSearchOptions;

  constructor(options: ProductionSearchOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "search.ask.read") throw new Error("SEARCH_OPERATION_NOT_INSTALLED");
    const asked = singleLine(query.payload.query ?? "");
    const payload =
      asked.length === 0
        ? await this.#suggestions()
        : await this.#answer(asked, query.payload.locale);
    return {
      ...query,
      kind: "snapshot",
      type: "search.ask.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: { ...payload, generatedAt: this.#options.clock.now() },
    };
  }

  async #suggestions(): Promise<Omit<SearchSnapshot["payload"], "generatedAt">> {
    const { ownerId, agentId, settings } = this.#options;
    const now = this.#options.clock.now();
    const empty = {
      state: "suggestions",
      query: null,
      answer: null,
      notFoundText: null,
      basis: [],
      asks: [],
    } as const;
    if (settings.askLimit === 0) return empty;
    const active = await this.#options.state.listActive(ownerId, agentId);
    const counted = new Map<string, { uses: number; updatedAt: string }>();
    for (const record of active) {
      const attributes = record.attributes;
      if (
        !attributes ||
        !SUGGESTION_CATEGORIES.has(attributes.category) ||
        !currentlyShown(record, now)
      )
        continue;
      for (const entity of attributes.entities) {
        const name = singleLine(entity);
        if (name.length === 0 || name.length > ASK_MAXIMUM_CHARACTERS) continue;
        const current = counted.get(name);
        counted.set(name, {
          uses: (current?.uses ?? 0) + 1 + (record.useCount ?? 0),
          updatedAt:
            current && current.updatedAt > record.updatedAt ? current.updatedAt : record.updatedAt,
        });
      }
    }
    const asks = [...counted.entries()]
      .sort(
        ([leftName, left], [rightName, right]) =>
          right.uses - left.uses ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          leftName.localeCompare(rightName),
      )
      .slice(0, settings.askLimit)
      .map(([name]) => name);
    return { ...empty, asks };
  }

  async #answer(
    asked: string,
    locale: Locale,
  ): Promise<Omit<SearchSnapshot["payload"], "generatedAt">> {
    const { ownerId, agentId, settings } = this.#options;
    const terms = queryTerms(asked);
    const minimum = settings.minimumCoveragePercent / 100;
    const now = this.#options.clock.now();
    const candidates: Candidate[] = [];
    if (terms.length > 0) {
      const hits = await this.#options.provider.search({
        ownerId,
        agentId,
        query: asked,
        limit: settings.candidateLimit,
        lexicalOnly: true,
      });
      const records = new Map(
        (
          await this.#options.state.readMany({
            ownerId,
            agentId,
            memoryIds: hits.map(({ productMemoryId }) => productMemoryId),
          })
        ).map((record) => [record.id, record]),
      );
      let order = 0;
      for (const hit of hits) {
        const memory = records.get(hit.productMemoryId);
        if (
          !memory ||
          memory.status !== "active" ||
          memory.providerRecordId !== hit.providerRecordId ||
          !currentlyShown(memory, now)
        )
          continue;
        const text = singleLine((await this.#options.readText(memory).catch(() => "")) ?? "");
        const matched = coverage(terms, text);
        if (text.length === 0 || matched < minimum) continue;
        candidates.push({
          answer: text,
          coverage: matched,
          order: order++,
          basis: {
            kind: memory.sourceThreadId ? "conversation" : "memory",
            memoryId: memory.id,
            threadId: memory.sourceThreadId,
            at: memory.recordedAt ?? memory.updatedAt,
          },
        });
      }
      const episodes = this.#options.episodes
        ? await this.#options.episodes
            .search({
              ownerId,
              agentId,
              query: asked,
              scope: null,
              allowedClassifications: SEARCH_VISIBLE,
              limit: settings.candidateLimit,
              lexicalOnly: true,
            })
            .catch(() => [])
        : [];
      for (const { episode, text } of episodes) {
        const line = singleLine(text);
        const matched = coverage(terms, line);
        if (line.length === 0 || matched < minimum || !searchVisible(episode.dataClassification))
          continue;
        candidates.push({
          answer: line,
          coverage: matched,
          order: order++,
          basis: {
            kind: "conversation",
            memoryId: null,
            threadId: episode.threadId,
            at: episode.endedAt,
          },
        });
      }
    }
    const ranked = candidates.sort(
      (left, right) => right.coverage - left.coverage || left.order - right.order,
    );
    const best = ranked[0];
    if (!best)
      return {
        state: "not_found",
        query: asked,
        answer: null,
        notFoundText: SEARCH_TEXT[locale].notFound,
        basis: [],
        asks: [],
      };
    return {
      state: "answered",
      query: asked,
      answer: clip(best.answer, settings.answerCharacters),
      notFoundText: null,
      basis: ranked.slice(0, settings.basisLimit).map(({ basis }) => ({
        ...basis,
        label: BASIS_LABELS[locale](
          basis.kind,
          dateParts(basis.at, now, this.#options.timeZone ?? "UTC"),
        ),
      })),
      asks: [],
    };
  }
}
