import {
  ApplicationPortError,
  type DataClassification,
  highestClassification,
  isModelVisible,
  type MemoryEpisode,
  type MemoryEpisodeStorePort,
  type MemoryTimeScope,
  type PayloadRef,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { AgentId, OwnerId, ProductThreadMessage, ThreadId } from "@himawari-agent/domain";
import {
  MEMORY_EPISODE_SUMMARY,
  MEMORY_EPISODE_SUMMARY_INTRO,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { Embedder } from "./embedding.js";
import { indexableTerms, queryTerms } from "./segmentation.js";

const DEFAULT_IDLE_MS = 2 * 3_600_000;
const MAXIMUM_SEGMENT_MESSAGES = 120;
const MAXIMUM_MESSAGE_CHARACTERS = 1500;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 16000;
const MAXIMUM_SUMMARY_CHARACTERS = 1200;
const RRF_K = 60;
const UNSUMMARIZED = "（这段对话只含敏感内容，没有做摘要）";

const EPISODES_LISTED_PAST_LIMIT = 3;
const FIRST_EMBEDDING_RETRY_MS = 3_600_000;
const LONGEST_EMBEDDING_RETRY_MS = 24 * 3_600_000;
const REMEMBERED_EMBEDDING_FAILURES = 10_000;
const SUMMARY_EMBEDDING_FAILURES = new Set([
  "EMBEDDING_LOCAL_INPUT_LENGTH",
  "EMBEDDING_VECTOR_INVALID",
]);
const SUMMARY_REJECTION_STATUSES = new Set(["413", "422"]);

function summaryFailure(error: unknown): "this-summary" | "maybe-this-summary" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (SUMMARY_EMBEDDING_FAILURES.has(error.message)) return "this-summary";
  if (!(error instanceof ApplicationPortError) || error.message !== "EMBEDDING_HTTP_FAILURE")
    return undefined;
  const status = error.details["status"] ?? "";
  if (SUMMARY_REJECTION_STATUSES.has(status)) return "this-summary";
  return status === "400" ? "maybe-this-summary" : undefined;
}

export interface EpisodeSegment {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly day: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly dataClassification: DataClassification;
  readonly lines: readonly {
    readonly role: "owner" | "agent";
    readonly text: string;
    readonly committedAt: string;
  }[];
}

export interface EpisodeHit {
  readonly episode: MemoryEpisode;
  readonly text: string;
  readonly score: number;
}

export interface MemoryEpisodeServiceOptions {
  readonly store: MemoryEpisodeStorePort;
  readonly threads: Pick<ThreadRepositoryPort, "listMessages">;
  readonly readText: (input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly ref: PayloadRef;
  }) => Promise<string | undefined>;
  readonly storeText: (input: {
    readonly ref: PayloadRef;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  }) => Promise<void>;
  readonly embedder: Embedder | null;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly idleMs?: number;
  readonly onEmbeddingFailure?: (error: unknown) => void;
}

export interface RecentDaySummary {
  readonly episode: MemoryEpisode;
  readonly text: string;
}

export function localDay(instant: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

export function episodeSummaryPrompt(segment: EpisodeSegment): string {
  let budget = MAXIMUM_TRANSCRIPT_CHARACTERS;
  const lines: { role: string; text: string; at: string }[] = [];
  for (const line of [...segment.lines].reverse()) {
    const text = line.text.slice(0, MAXIMUM_MESSAGE_CHARACTERS);
    if (text.length > budget) break;
    budget -= text.length;
    lines.unshift({
      role: line.role === "owner" ? "主人" : "Himawari",
      text,
      at: line.committedAt,
    });
  }
  return [
    renderPrompt(MEMORY_EPISODE_SUMMARY_INTRO, { day: segment.day }),
    MEMORY_EPISODE_SUMMARY.text,
    JSON.stringify({ day: segment.day, messages: lines }),
  ].join("\n");
}

export class MemoryEpisodeService {
  readonly #options: MemoryEpisodeServiceOptions;
  readonly #embeddingRetries = new Map<
    string,
    { readonly notBefore: number; readonly failures: number }
  >();
  readonly #embeddingsInFlight = new Set<string>();

  constructor(options: MemoryEpisodeServiceOptions) {
    this.#options = options;
  }

  async dueSegments(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly activeWithinDays?: number;
    readonly signal?: AbortSignal;
    readonly limit: number;
  }): Promise<readonly EpisodeSegment[]> {
    const now = this.#options.now();
    const today = localDay(now, this.#options.timeZone);
    const idleMs = this.#options.idleMs ?? DEFAULT_IDLE_MS;
    const segments: EpisodeSegment[] = [];
    const watermarks = await this.#options.store.listUnsummarized({
      ownerId: input.ownerId,
      agentId: input.agentId,
      ...(input.activeWithinDays === undefined
        ? {}
        : {
            activeSince: new Date(
              Date.parse(now) -
                (Math.max(1, Math.floor(input.activeWithinDays)) * 24 + 1) * 3_600_000,
            ).toISOString(),
          }),
      limit: Math.min(100, Math.max(input.limit * 4, input.limit)),
    });
    for (const watermark of watermarks) {
      if (segments.length >= input.limit || input.signal?.aborted) break;
      const messages = (
        await this.#options.threads.listMessages(
          input.ownerId,
          input.agentId,
          watermark.threadId,
          watermark.summarizedThrough,
          MAXIMUM_SEGMENT_MESSAGES,
        )
      ).filter(({ sequence }) => sequence > watermark.summarizedThrough);
      const first = messages[0];
      if (!first) continue;
      const day = localDay(first.committedAt, this.#options.timeZone);
      const sameDay: ProductThreadMessage[] = [];
      for (const message of messages) {
        if (localDay(message.committedAt, this.#options.timeZone) !== day) break;
        sameDay.push(message);
      }
      const last = sameDay.at(-1) ?? first;
      const closed =
        day < today ||
        sameDay.length < messages.length ||
        sameDay.length >= MAXIMUM_SEGMENT_MESSAGES ||
        Date.parse(now) - Date.parse(last.committedAt) >= idleMs;
      if (!closed) continue;
      const lines: {
        role: "owner" | "agent";
        text: string;
        committedAt: string;
      }[] = [];
      const included: DataClassification[] = [];
      for (const message of sameDay) {
        if (message.role === "system" || !isModelVisible(message.dataClassification)) continue;
        if (message.status !== "committed") continue;
        const text = await this.#options
          .readText({ ownerId: input.ownerId, agentId: input.agentId, ref: message.contentRef })
          .catch(() => undefined);
        if (!text?.trim()) continue;
        included.push(message.dataClassification);
        lines.push({ role: message.role, text: text.trim(), committedAt: message.committedAt });
      }
      segments.push(
        Object.freeze({
          ownerId: input.ownerId,
          agentId: input.agentId,
          threadId: watermark.threadId,
          day,
          firstSequence: first.sequence,
          lastSequence: last.sequence,
          startedAt: first.committedAt,
          endedAt: last.committedAt,
          dataClassification: highestClassification("private", included),
          lines: Object.freeze(lines),
        }),
      );
    }
    return segments;
  }

  recentDays(days: number): { readonly fromDay: string; readonly toDay: string } {
    const toDay = localDay(this.#options.now(), this.#options.timeZone);
    const span = Math.max(1, Math.floor(days));
    const fromDay = new Date(Date.parse(`${toDay}T00:00:00.000Z`) - (span - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { fromDay, toDay };
  }

  async recent(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly days: number;
    readonly allowedClassifications: readonly DataClassification[];
    readonly limit: number;
  }): Promise<{ readonly summaries: readonly RecentDaySummary[]; readonly partial: boolean }> {
    const allowed = input.allowedClassifications.filter(isModelVisible);
    if (input.days < 1 || input.limit < 1 || allowed.length === 0)
      return { summaries: [], partial: false };
    const episodes = await this.#options.store.listDaySummaries({
      ownerId: input.ownerId,
      agentId: input.agentId,
      ...this.recentDays(input.days),
      allowedClassifications: allowed,
      limit: Math.min(100, input.limit * 4),
    });
    const summaries: RecentDaySummary[] = [];
    let partial = false;
    for (const episode of episodes) {
      const text = await this.#options
        .readText({ ownerId: input.ownerId, agentId: input.agentId, ref: episode.contentRef })
        .catch(() => undefined);
      if (text === undefined || text.trim().length === 0) {
        partial = true;
        continue;
      }
      if (text === UNSUMMARIZED) continue;
      summaries.push(Object.freeze({ episode, text: text.trim() }));
      if (summaries.length >= input.limit) break;
    }
    if (episodes.length >= Math.min(100, input.limit * 4) && summaries.length < input.limit)
      partial = true;
    return { summaries, partial };
  }

  async summarize(
    segment: EpisodeSegment,
    generate: (prompt: string, dataClassification: DataClassification) => Promise<string>,
  ): Promise<MemoryEpisode> {
    const summary =
      segment.lines.length === 0
        ? UNSUMMARIZED
        : (await generate(episodeSummaryPrompt(segment), segment.dataClassification))
            .replace(/^```[a-z]*\s*|\s*```$/giu, "")
            .trim()
            .slice(0, MAXIMUM_SUMMARY_CHARACTERS);
    if (summary.length === 0) throw new Error("MEMORY_EPISODE_SUMMARY_EMPTY");
    return this.#record({
      ownerId: segment.ownerId,
      agentId: segment.agentId,
      threadId: segment.threadId,
      day: segment.day,
      source: "day_summary",
      firstSequence: segment.firstSequence,
      lastSequence: segment.lastSequence,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      text: summary,
      dataClassification: segment.dataClassification,
      indexed: segment.lines.length > 0,
    });
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly query: string;
    readonly scope: MemoryTimeScope | null;
    readonly allowedClassifications: readonly DataClassification[];
    readonly limit: number;
    readonly lexicalOnly?: boolean;
  }): Promise<readonly EpisodeHit[]> {
    if (input.limit <= 0 || input.query.trim().length === 0) return [];
    const embedder = input.lexicalOnly === true ? null : this.#options.embedder;
    let embedding = null;
    if (embedder) {
      try {
        embedding = {
          model: embedder.model,
          dimensions: embedder.dimensions,
          vector: await embedder.embedQuery(input.query),
        };
      } catch (error) {
        this.#options.onEmbeddingFailure?.(error);
      }
    }
    const result = await this.#options.store.search({
      ownerId: input.ownerId,
      agentId: input.agentId,
      embedding,
      terms: queryTerms(input.query),
      allowedClassifications: input.allowedClassifications.filter(isModelVisible),
      from: input.scope?.from ?? null,
      to: input.scope?.to ?? null,
      limit: Math.min(200, Math.max(20, input.limit * 4)),
    });
    const fused = new Map<string, { episode: MemoryEpisode; score: number }>();
    for (const list of [result.vector, result.lexical])
      list.forEach(({ episode }, rank) => {
        const current = fused.get(episode.id) ?? { episode, score: 0 };
        current.score += 1 / (RRF_K + rank + 1);
        fused.set(episode.id, current);
      });
    const hits: EpisodeHit[] = [];
    for (const { episode, score } of [...fused.values()]
      .sort(
        (left, right) =>
          right.score - left.score || left.episode.id.localeCompare(right.episode.id),
      )
      .slice(0, input.limit)) {
      const text = await this.#options
        .readText({ ownerId: input.ownerId, agentId: input.agentId, ref: episode.contentRef })
        .catch(() => undefined);
      if (text) hits.push(Object.freeze({ episode, text, score }));
    }
    return hits;
  }

  async backfillEmbeddings(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
    readonly within?: <T>(
      episode: Pick<MemoryEpisode, "id" | "dataClassification">,
      operation: () => Promise<T>,
    ) => Promise<T>;
  }): Promise<number> {
    const embedder = this.#options.embedder;
    if (!embedder || input.limit <= 0) return 0;
    const position = [input.ownerId, input.agentId, embedder.model, embedder.dimensions].join(
      "\u0000",
    );
    const pageSize = Math.min(100, input.limit + EPISODES_LISTED_PAST_LIMIT);
    let after: { createdAt: string; id: string } | undefined;
    let embedded = 0;
    let failure: { readonly error: unknown } | undefined;
    const uncertain: {
      key: string;
      retry: { readonly notBefore: number; readonly failures: number } | undefined;
    }[] = [];
    pages: for (;;) {
      const episodes = await this.#options.store.listUnembedded({
        ownerId: input.ownerId,
        agentId: input.agentId,
        model: embedder.model,
        dimensions: embedder.dimensions,
        ...(after ? { after } : {}),
        limit: pageSize,
      });
      for (const episode of episodes) {
        after = { createdAt: episode.createdAt, id: episode.id };
        if (!isModelVisible(episode.dataClassification)) continue;
        const key = `${position}\u0000${episode.id}`;
        const retry = this.#embeddingRetries.get(key);
        if (this.#embeddingsInFlight.has(key)) continue;
        const now = Date.parse(this.#options.now());
        if (retry && retry.notBefore > now && retry.notBefore - now <= LONGEST_EMBEDDING_RETRY_MS)
          continue;
        this.#embeddingsInFlight.add(key);
        try {
          const text = await this.#options.readText({
            ownerId: input.ownerId,
            agentId: input.agentId,
            ref: episode.contentRef,
          });
          if (!text) continue;
          let vector: Float32Array;
          try {
            vector = await (input.within ?? ((_, operation) => operation()))(episode, () =>
              embedder.embedDocument(`${episode.day}\n${text}`),
            );
          } catch (error) {
            const kind = summaryFailure(error);
            if (!kind) throw error;
            failure ??= { error };
            if (kind === "this-summary") this.#waitBeforeRetrying(key, retry);
            else uncertain.push({ key, retry });
            continue;
          }
          await this.#options.store.attachEmbedding({
            episodeId: episode.id,
            embedding: {
              model: embedder.model,
              dimensions: embedder.dimensions,
              vector,
            },
          });
          this.#embeddingRetries.delete(key);
        } finally {
          this.#embeddingsInFlight.delete(key);
        }
        embedded += 1;
        if (embedded >= input.limit) break pages;
      }
      if (episodes.length < pageSize) break;
    }
    if (embedded > 0) for (const { key, retry } of uncertain) this.#waitBeforeRetrying(key, retry);
    if (failure && embedded === 0) throw failure.error;
    return embedded;
  }

  #waitBeforeRetrying(
    key: string,
    retry: { readonly notBefore: number; readonly failures: number } | undefined,
  ): void {
    const failures = (retry?.failures ?? 0) + 1;
    this.#embeddingRetries.delete(key);
    this.#embeddingRetries.set(key, {
      failures,
      notBefore:
        Date.parse(this.#options.now()) +
        Math.min(FIRST_EMBEDDING_RETRY_MS * 2 ** (failures - 1), LONGEST_EMBEDDING_RETRY_MS),
    });
    for (const oldest of this.#embeddingRetries.keys()) {
      if (this.#embeddingRetries.size <= REMEMBERED_EMBEDDING_FAILURES) break;
      this.#embeddingRetries.delete(oldest);
    }
  }

  async #record(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly day: string;
    readonly source: MemoryEpisode["source"];
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly indexed: boolean;
  }): Promise<MemoryEpisode> {
    const createdAt = this.#options.now();
    const id = `episode:${input.source}:${input.threadId}:${input.firstSequence}`;
    const contentRef = `memory-episode:${input.threadId}:${input.source}:${input.firstSequence}`;
    await this.#options.storeText({
      ref: contentRef,
      ownerId: input.ownerId,
      agentId: input.agentId,
      text: input.text,
      dataClassification: input.dataClassification,
      createdAt,
    });
    let embedding = null;
    const embedder = this.#options.embedder;
    if (embedder && input.indexed && isModelVisible(input.dataClassification)) {
      try {
        embedding = {
          model: embedder.model,
          dimensions: embedder.dimensions,
          vector: await embedder.embedDocument(`${input.day}\n${input.text}`),
        };
      } catch (error) {
        this.#options.onEmbeddingFailure?.(error);
      }
    }
    const episode: MemoryEpisode = Object.freeze({
      id,
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      day: input.day,
      source: input.source,
      contentRef,
      dataClassification: input.dataClassification,
      firstSequence: input.firstSequence,
      lastSequence: input.lastSequence,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      createdAt,
    });
    await this.#options.store.upsert({
      ...episode,
      terms:
        input.indexed && isModelVisible(input.dataClassification) ? indexableTerms(input.text) : [],
      embedding,
    });
    return episode;
  }
}
