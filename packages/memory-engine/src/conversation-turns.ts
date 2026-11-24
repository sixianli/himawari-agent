import {
  type ConversationTurn,
  type ConversationTurnStorePort,
  type DataClassification,
  highestClassification,
  isModelVisible,
  type PayloadRef,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { AgentId, OwnerId, ProductThreadMessage, ThreadId } from "@himawari-agent/domain";
import type { Embedder } from "./embedding.js";
import { localDay } from "./episodes.js";
import { indexableTerms, queryTerms } from "./segmentation.js";

const MESSAGES_PER_READ = 200;
const MAXIMUM_EMBEDDED_CHARACTERS = 2000;
const RRF_K = 60;

export interface ConversationLine {
  readonly sequence: number;
  readonly role: "owner" | "agent";
  readonly committedAt: string;
  readonly dataClassification: DataClassification;
  readonly text: string;
}

export interface ConversationTurnHit {
  readonly turn: ConversationTurn;
  readonly lines: readonly ConversationLine[];
  readonly score: number;
}

export interface ConversationWindow {
  readonly threadId: ThreadId;
  readonly lines: readonly ConversationLine[];
  readonly earlierFrom: number | null;
  readonly laterFrom: number | null;
}

export interface ConversationTurnServiceOptions {
  readonly store: ConversationTurnStorePort;
  readonly threads: Pick<ThreadRepositoryPort, "listMessages" | "read">;
  readonly readText: (input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly ref: PayloadRef;
  }) => Promise<string | undefined>;
  readonly embedder?: Embedder | null;
  readonly embeddableClassifications: readonly DataClassification[];
  readonly minimumSimilarity: number;
  readonly onEmbeddingFailure?: (error: unknown) => void;
  readonly onIndexFailure?: (error: unknown) => void;
  readonly now: () => string;
  readonly timeZone?: string;
}

export type EmbedWithin = <T>(
  dataClassification: DataClassification,
  operation: () => Promise<T>,
) => Promise<T>;

const direct: EmbedWithin = (_dataClassification, operation) => operation();

interface Turn {
  readonly messages: ProductThreadMessage[];
}

function groupTurns(messages: readonly ProductThreadMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const current = turns.at(-1);
    if (!current || message.role === "owner") turns.push({ messages: [message] });
    else current.messages.push(message);
  }
  return turns;
}

function joined(lines: readonly ConversationLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

export class ConversationTurnService {
  readonly #options: ConversationTurnServiceOptions;

  constructor(options: ConversationTurnServiceOptions) {
    this.#options = options;
  }

  async #line(
    ownerId: OwnerId,
    agentId: AgentId,
    message: ProductThreadMessage,
    strict = false,
  ): Promise<ConversationLine | undefined> {
    if (message.role === "system" || message.status !== "committed") return undefined;
    if (!isModelVisible(message.dataClassification)) return undefined;
    const reading = this.#options.readText({ ownerId, agentId, ref: message.contentRef });
    const text = await (strict ? reading : reading.catch(() => undefined));
    if (!text?.trim()) return undefined;
    return Object.freeze({
      sequence: message.sequence,
      role: message.role,
      committedAt: message.committedAt,
      dataClassification: message.dataClassification as DataClassification,
      text: text.trim(),
    });
  }

  async #lines(
    ownerId: OwnerId,
    agentId: AgentId,
    messages: readonly ProductThreadMessage[],
    strict = false,
  ): Promise<ConversationLine[]> {
    const lines: ConversationLine[] = [];
    for (const message of messages) {
      const line = await this.#line(ownerId, agentId, message, strict);
      if (line) lines.push(line);
    }
    return lines;
  }

  async #embed(
    text: string,
    dataClassification: DataClassification,
    within: EmbedWithin,
  ): Promise<{
    readonly model: string;
    readonly dimensions: number;
    readonly vector: Float32Array;
  } | null> {
    const embedder = this.#options.embedder;
    if (
      !embedder ||
      text.length === 0 ||
      !this.#options.embeddableClassifications.includes(dataClassification)
    )
      return null;
    try {
      return {
        model: embedder.model,
        dimensions: embedder.dimensions,
        vector: await within(dataClassification, () =>
          embedder.embedDocument(text.slice(0, MAXIMUM_EMBEDDED_CHARACTERS)),
        ),
      };
    } catch (error) {
      this.#options.onEmbeddingFailure?.(error);
      return null;
    }
  }

  async indexDue(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
    readonly within?: EmbedWithin;
    readonly signal?: AbortSignal;
  }): Promise<number> {
    let indexed = 0;
    const behind = await this.#options.store.listBehind({
      ownerId: input.ownerId,
      agentId: input.agentId,
      limit: Math.min(100, Math.max(1, input.limit)),
    });
    for (const watermark of behind) {
      if (input.signal?.aborted || indexed >= input.limit) break;
      try {
        const { messages, reachedEnd } = await this.#readTurns(
          input.ownerId,
          input.agentId,
          watermark.threadId,
          Math.max(0, watermark.indexedFrom - 1),
        );
        const turns = groupTurns(messages);
        for (const turn of reachedEnd ? turns : turns.slice(0, -1)) {
          if (input.signal?.aborted || indexed >= input.limit) break;
          const first = turn.messages[0];
          const last = turn.messages.at(-1);
          if (!first || !last) continue;
          if (last.sequence <= watermark.indexedThrough && first.sequence !== watermark.indexedFrom)
            continue;
          await this.#index(
            input.ownerId,
            input.agentId,
            watermark.threadId,
            turn,
            input.within ?? direct,
          );
          indexed += 1;
        }
      } catch (error) {
        this.#options.onIndexFailure?.(error);
      }
    }
    return indexed;
  }

  async #readTurns(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    afterSequence: number,
  ): Promise<{ readonly messages: ProductThreadMessage[]; readonly reachedEnd: boolean }> {
    const messages: ProductThreadMessage[] = [];
    let cursor = afterSequence;
    for (;;) {
      const page = await this.#options.threads.listMessages(
        ownerId,
        agentId,
        threadId,
        cursor,
        MESSAGES_PER_READ,
      );
      messages.push(...page);
      const last = page.at(-1);
      if (!last || page.length < MESSAGES_PER_READ) return { messages, reachedEnd: true };
      if (messages.slice(1).filter((message) => message.role === "owner").length >= 2)
        return { messages, reachedEnd: false };
      cursor = last.sequence;
    }
  }

  async #index(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    turn: Turn,
    within: EmbedWithin,
  ) {
    const first = turn.messages[0];
    const last = turn.messages.at(-1);
    if (!first || !last) return;
    const lines = await this.#lines(ownerId, agentId, turn.messages, true);
    const text = joined(lines);
    const visible = lines.length > 0;
    const classifications = turn.messages
      .filter((message) => lines.some((line) => line.sequence === message.sequence))
      .map((message) => message.dataClassification as DataClassification);
    const dataClassification: DataClassification = visible
      ? highestClassification("private", classifications)
      : "restricted";
    await this.#options.store.upsert({
      id: `turn:${threadId}:${first.sequence}`,
      ownerId,
      agentId,
      threadId,
      day: localDay(first.committedAt, this.#options.timeZone),
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      dataClassification,
      startedAt: first.committedAt,
      endedAt: last.committedAt,
      indexedAt: this.#options.now(),
      terms: visible ? indexableTerms(text) : [],
      embedding: visible ? await this.#embed(text, dataClassification, within) : null,
    });
  }

  async backfillEmbeddings(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
    readonly within?: EmbedWithin;
  }): Promise<number> {
    const embedder = this.#options.embedder;
    if (!embedder) return 0;
    const turns = await this.#options.store.listUnembedded({
      ownerId: input.ownerId,
      agentId: input.agentId,
      model: embedder.model,
      dimensions: embedder.dimensions,
      classifications: this.#options.embeddableClassifications,
      limit: Math.min(100, Math.max(1, input.limit)),
    });
    let embedded = 0;
    for (const turn of turns) {
      try {
        const lines = await this.#turnLines(turn, true);
        const embedding = await this.#embed(
          joined(lines),
          turn.dataClassification,
          input.within ?? direct,
        );
        if (!embedding) continue;
        await this.#options.store.attachEmbedding({
          turnId: turn.id,
          lastSequence: turn.lastSequence,
          embedding,
        });
        embedded += 1;
      } catch (error) {
        this.#options.onIndexFailure?.(error);
      }
    }
    return embedded;
  }

  turnLines(turn: ConversationTurn): Promise<ConversationLine[]> {
    return this.#turnLines(turn, false);
  }

  async #turnLines(turn: ConversationTurn, strict: boolean): Promise<ConversationLine[]> {
    const messages = await this.#options.threads.listMessages(
      turn.ownerId,
      turn.agentId,
      turn.threadId,
      turn.firstSequence - 1,
      Math.min(1000, turn.lastSequence - turn.firstSequence + 1),
    );
    return this.#lines(
      turn.ownerId,
      turn.agentId,
      messages.filter((message) => message.sequence <= turn.lastSequence),
      strict,
    );
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly query: string;
    readonly from: string | null;
    readonly to: string | null;
    readonly excludeThreadId: ThreadId | null;
    readonly allowedClassifications: readonly DataClassification[];
    readonly limit: number;
    readonly within?: EmbedWithin;
  }): Promise<readonly ConversationTurnHit[]> {
    if (input.limit <= 0 || input.query.trim().length === 0) return [];
    const embedder = this.#options.embedder;
    let embedding = null;
    if (embedder && this.#options.embeddableClassifications.includes("private")) {
      try {
        embedding = {
          model: embedder.model,
          dimensions: embedder.dimensions,
          vector: await (input.within ?? direct)("private", () => embedder.embedQuery(input.query)),
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
      from: input.from,
      to: input.to,
      excludeThreadId: input.excludeThreadId,
      limit: Math.min(500, Math.max(20, input.limit * 2)),
    });
    const fused = new Map<string, { turn: ConversationTurn; score: number }>();
    const close = result.vector.filter(({ signal }) => signal >= this.#options.minimumSimilarity);
    for (const list of [close, result.lexical])
      list.forEach(({ turn }, rank) => {
        const current = fused.get(turn.id) ?? { turn, score: 0 };
        current.score += 1 / (RRF_K + rank + 1);
        fused.set(turn.id, current);
      });
    const hits: ConversationTurnHit[] = [];
    for (const { turn, score } of [...fused.values()]
      .sort((left, right) => right.score - left.score || left.turn.id.localeCompare(right.turn.id))
      .slice(0, input.limit)) {
      const lines = await this.turnLines(turn);
      if (lines.length > 0) hits.push(Object.freeze({ turn, lines: Object.freeze(lines), score }));
    }
    return hits;
  }

  async window(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly fromSequence: number;
    readonly direction: "later" | "earlier";
    readonly maximumCharacters: number;
  }): Promise<ConversationWindow | undefined> {
    const thread = await this.#options.threads.read(input.ownerId, input.agentId, input.threadId);
    if (!thread || (thread.status !== "active" && thread.status !== "archived")) return undefined;
    if (thread.origin === "think") return undefined;
    const start =
      input.direction === "later"
        ? input.fromSequence
        : Math.max(1, input.fromSequence - MESSAGES_PER_READ + 1);
    const messages = (
      await this.#options.threads.listMessages(
        input.ownerId,
        input.agentId,
        input.threadId,
        start - 1,
        MESSAGES_PER_READ,
      )
    ).filter((message) =>
      input.direction === "later"
        ? message.sequence >= input.fromSequence
        : message.sequence <= input.fromSequence,
    );
    const ordered = input.direction === "later" ? messages : [...messages].reverse();
    const taken: ConversationLine[] = [];
    let used = 0;
    let stoppedAt: number | null = null;
    for (const message of ordered) {
      const line = await this.#line(input.ownerId, input.agentId, message);
      if (!line) continue;
      if (taken.length > 0 && used + line.text.length > input.maximumCharacters) {
        stoppedAt = line.sequence;
        break;
      }
      taken.push(line);
      used += line.text.length;
    }
    const lines = input.direction === "later" ? taken : taken.reverse();
    const firstLine = lines[0];
    const lastLine = lines.at(-1);
    const reachedStart = input.direction === "earlier" ? stoppedAt === null && start === 1 : false;
    return Object.freeze({
      threadId: input.threadId,
      lines: Object.freeze(lines),
      earlierFrom:
        firstLine && firstLine.sequence > 1 && !reachedStart ? firstLine.sequence - 1 : null,
      laterFrom:
        lastLine &&
        (input.direction === "earlier" ||
          stoppedAt !== null ||
          messages.length >= MESSAGES_PER_READ)
          ? lastLine.sequence + 1
          : null,
    });
  }
}
