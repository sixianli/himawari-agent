import type { RuntimeRequest } from "@himawari-agent/application";
import type {
  MemoryConsolidationHit,
  MemoryConsolidationResult,
  MemoryConsolidationService,
} from "@himawari-agent/memory-engine";

const RETRY_AFTER_MS = 3_600_000;

export interface ProductionMemoryConsolidationOptions {
  readonly service: Pick<MemoryConsolidationService, "due" | "run">;
  readonly search: (
    request: RuntimeRequest,
    query: string,
    limit: number,
  ) => Promise<readonly MemoryConsolidationHit[]>;
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
  readonly onResult?: (result: MemoryConsolidationResult) => void;
  readonly onFailure: (error: unknown) => void;
  readonly now: () => string;
}

export class ProductionMemoryConsolidation {
  readonly #options: ProductionMemoryConsolidationOptions;
  readonly #pending = new Map<string, Promise<void>>();
  #attemptedAt = Number.NEGATIVE_INFINITY;
  #stopping = false;

  constructor(options: ProductionMemoryConsolidationOptions) {
    this.#options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    if (
      this.#stopping ||
      !request.threadId ||
      request.continuationRef ||
      request.knownToolResult ||
      this.#pending.size > 0 ||
      Date.parse(this.#options.now()) - this.#attemptedAt < RETRY_AFTER_MS
    )
      return Promise.resolve();
    this.#attemptedAt = Date.parse(this.#options.now());
    let onAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    const work = this.#run(request, onAdmitted)
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

  async #run(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    if (!(await this.#options.service.due(request.ownerId, request.agentId))) return;
    await this.#options.assertActive();
    let searches = 0;
    const result = await this.#options.service.run({
      ownerId: request.ownerId,
      agentId: request.agentId,
      triggerRunId: request.runId,
      search: (query, limit) => {
        const slot = `memory-consolidation-search-${searches++}:${request.runId}`;
        const operation = () => this.#options.search(request, query, limit);
        return this.#options.embedWithin
          ? this.#options.embedWithin(request, slot, operation)
          : operation();
      },
      generate: async (prompt) => {
        if (this.#stopping) throw new Error("MEMORY_CONSOLIDATION_STOPPING");
        await this.#options.assertActive();
        return this.#options.generate(
          { ...request, dataClassification: "private" },
          prompt,
          onAdmitted,
          "memory-consolidation",
        );
      },
    });
    if (result) this.#options.onResult?.(result);
  }
}
