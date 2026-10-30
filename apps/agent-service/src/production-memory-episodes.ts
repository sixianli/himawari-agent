import type {
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeRequest,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { MemoryEpisodeService } from "@himawari-agent/memory-engine";

const MAXIMUM_EPISODES_PER_RUN = 1;

export interface ProductionMemoryEpisodesOptions {
  readonly service: Pick<MemoryEpisodeService, "dueSegments" | "summarize" | "backfillEmbeddings">;
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

  async #summarize(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    await this.#within(request, "memory-episode-backfill", () =>
      this.#options.service.backfillEmbeddings({
        ownerId: request.ownerId,
        agentId: request.agentId,
        limit: 1,
      }),
    ).catch(this.#options.onFailure);
    const segments = await this.#options.service.dueSegments({
      ownerId: request.ownerId,
      agentId: request.agentId,
      limit: this.#options.maximumPerRun ?? MAXIMUM_EPISODES_PER_RUN,
    });
    for (const [index, segment] of segments.entries()) {
      if (this.#stopping) return;
      await this.#options.assertActive();
      await this.#within(request, `memory-episode-embed-${index}`, () =>
        this.#options.service.summarize(segment, (prompt) =>
          this.#options.generate(
            { ...request, dataClassification: "private" },
            prompt,
            onAdmitted,
            `memory-episode-${index}`,
          ),
        ),
      );
    }
  }
}
