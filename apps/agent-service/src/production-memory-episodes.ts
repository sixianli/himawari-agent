import type {
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeRequest,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { ConversationTurnService, MemoryEpisodeService } from "@himawari-agent/memory-engine";

const MAXIMUM_EPISODES_PER_RUN = 1;
const MAXIMUM_TURNS_PER_RUN = 20;

export interface ProductionMemoryEpisodesOptions {
  readonly service: Pick<MemoryEpisodeService, "dueSegments" | "summarize" | "backfillEmbeddings">;
  readonly turns?: Pick<ConversationTurnService, "indexDue" | "backfillEmbeddings">;
  readonly threads: Pick<ThreadRepositoryPort, "read">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly assertActive: () => Promise<void>;
  readonly generate: (
    request: RuntimeRequest,
    prompt: string,
    onAdmitted: () => void,
    purpose: string,
  ) => Promise<string>;
  readonly embedWithin?: <T>(
    request: RuntimeRequest,
    slot: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly onFailure: (error: unknown) => void;
  readonly maximumPerRun?: number;
}

export class ProductionMemoryEpisodes {
  readonly #options: ProductionMemoryEpisodesOptions;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #started = new Set<string>();
  #stopping = false;

  constructor(options: ProductionMemoryEpisodesOptions) {
    this.#options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    if (this.#stopping || !request.threadId || request.continuationRef || request.knownToolResult)
      return Promise.resolve();
    if (this.#started.has(request.runId)) return Promise.resolve();
    this.#started.add(request.runId);
    if (this.#started.size > 1000) {
      const oldest = this.#started.values().next().value;
      if (oldest !== undefined) this.#started.delete(oldest);
    }
    let onAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    const work = this.#summarize(request, onAdmitted)
      .catch(this.#options.onFailure)
      .finally(() => {
        onAdmitted();
        this.#pending.delete(request.runId);
      });
    this.#pending.set(request.runId, work);
    return admitted;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#pending.values()]);
  }

  #within<T>(request: RuntimeRequest, slot: string, operation: () => Promise<T>): Promise<T> {
    return this.#options.embedWithin
      ? this.#options.embedWithin(request, `${slot}:${request.runId}`, operation)
      : operation();
  }

  async #indexTurns(request: RuntimeRequest): Promise<void> {
    const turns = this.#options.turns;
    if (!turns) return;
    let slot = 0;
    const within = <T>(
      dataClassification: RuntimeRequest["dataClassification"],
      operation: () => Promise<T>,
    ) => {
      slot += 1;
      return this.#within(
        { ...request, dataClassification },
        `conversation-turn-${slot}`,
        operation,
      );
    };
    await turns
      .backfillEmbeddings({
        ownerId: request.ownerId,
        agentId: request.agentId,
        limit: MAXIMUM_TURNS_PER_RUN,
        within,
      })
      .catch(this.#options.onFailure);
    if (this.#stopping) return;
    await turns
      .indexDue({
        ownerId: request.ownerId,
        agentId: request.agentId,
        limit: MAXIMUM_TURNS_PER_RUN,
        within,
      })
      .catch(this.#options.onFailure);
  }

  async #summarize(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    await this.#indexTurns(request);
    await this.#options.service
      .backfillEmbeddings({
        ownerId: request.ownerId,
        agentId: request.agentId,
        limit: 1,
        within: ({ id, dataClassification }, operation) =>
          this.#within(
            { ...request, dataClassification },
            `memory-episode-backfill:${id}`,
            operation,
          ),
      })
      .catch(this.#options.onFailure);
    const segments = await this.#options.service.dueSegments({
      ownerId: request.ownerId,
      agentId: request.agentId,
      limit: this.#options.maximumPerRun ?? MAXIMUM_EPISODES_PER_RUN,
    });
    for (const [index, segment] of segments.entries()) {
      if (this.#stopping) return;
      await this.#options.assertActive();
      const scoped = { ...request, dataClassification: segment.dataClassification };
      await this.#within(scoped, `memory-episode-embed-${index}`, () =>
        this.#options.service.summarize(segment, (prompt, dataClassification) =>
          this.#options.generate(
            { ...request, dataClassification },
            prompt,
            onAdmitted,
            `memory-episode-${index}`,
          ),
        ),
      );
    }
  }
}
