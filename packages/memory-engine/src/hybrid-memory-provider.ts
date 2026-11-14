import {
  ApplicationPortError,
  type DataClassification,
  isModelVisible,
  type MemoryIndexStorePort,
  type MemoryProviderHit,
  type MemoryProviderProjectionPort,
  type MemoryTimeScope,
  PORT_ERROR_CODES,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type { Embedder } from "./embedding.js";
import { DEFAULT_FUSION_WEIGHTS, type FusionWeights, fuseCandidates } from "./fusion.js";
import {
  DEFAULT_RELEVANCE_TUNING,
  type RelevanceTuning,
  validRelevanceTuning,
} from "./relevance.js";
import { indexableTerms, queryTerms } from "./segmentation.js";

export const MEMORY_INDEX_RECORD_PREFIX = "memory-index:" as const;
const CANDIDATES_PER_SIGNAL = 50;

export interface HybridMemoryProviderOptions {
  readonly index: MemoryIndexStorePort;
  readonly embedder: Embedder | null;
  readonly embeddableClassifications: readonly DataClassification[];
  readonly now: () => string;
  readonly minimumSimilarity?: number;
  readonly weights?: FusionWeights;
  readonly relevance?: RelevanceTuning;
  readonly onRelevanceUnknown?: (
    count: number,
    scope: { readonly ownerId: OwnerId; readonly agentId: AgentId },
  ) => void;
  readonly onVectorFailure?: (
    error: unknown,
    scope: { readonly ownerId: OwnerId; readonly agentId: AgentId },
  ) => void;
  readonly timeZone?: string;
}

export function memoryIndexRecordId(memoryId: MemoryId): string {
  return `${MEMORY_INDEX_RECORD_PREFIX}${memoryId}`;
}

function memoryIdFromRecord(providerRecordId: string): MemoryId | null {
  return providerRecordId.startsWith(MEMORY_INDEX_RECORD_PREFIX)
    ? (providerRecordId.slice(MEMORY_INDEX_RECORD_PREFIX.length) as MemoryId)
    : null;
}

export class HybridMemoryProvider implements MemoryProviderProjectionPort {
  readonly #options: HybridMemoryProviderOptions;
  readonly #embeddable: ReadonlySet<DataClassification>;

  constructor(options: HybridMemoryProviderOptions) {
    const minimum = options.minimumSimilarity ?? 0;
    if (!Number.isFinite(minimum) || minimum < 0 || minimum >= 1)
      throw new RangeError("MEMORY_MINIMUM_SIMILARITY_INVALID");
    if (options.relevance !== undefined && !validRelevanceTuning(options.relevance))
      throw new RangeError("MEMORY_RELEVANCE_TUNING_INVALID");
    this.#options = options;
    this.#embeddable = new Set(options.embeddableClassifications);
  }

  get embedder(): Embedder | null {
    return this.#options.embedder;
  }

  get minimumSimilarity(): number {
    return this.#options.minimumSimilarity ?? 0;
  }

  get relevance(): RelevanceTuning {
    return this.#options.relevance ?? DEFAULT_RELEVANCE_TUNING;
  }

  get timeZone(): string | undefined {
    return this.#options.timeZone;
  }

  get embeddableClassifications(): readonly DataClassification[] {
    return this.#options.embeddableClassifications;
  }

  async upsert(input: {
    readonly memory: ProductMemoryRecord;
    readonly content: string;
  }): Promise<string> {
    if (input.content.trim().length === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_CONTENT_EMPTY");
    const { memory } = input;
    const terms = isModelVisible(memory.dataClassification)
      ? indexableTerms([input.content, ...(memory.attributes?.entities ?? [])].join("\n"))
      : [];
    const base = {
      memoryId: memory.id,
      ownerId: memory.ownerId,
      agentId: memory.agentId,
      revision: memory.revision,
      terms,
    };
    const embedder = this.#options.embedder;
    let embedding = null;
    if (embedder && this.#embeddable.has(memory.dataClassification)) {
      try {
        embedding = {
          model: embedder.model,
          dimensions: embedder.dimensions,
          vector: await embedder.embedDocument(input.content),
        };
      } catch (error) {
        await this.#options.index.upsert({
          ...base,
          embedding: null,
          indexedAt: this.#options.now(),
        });
        throw error;
      }
    }
    await this.#options.index.upsert({ ...base, embedding, indexedAt: this.#options.now() });
    return memoryIndexRecordId(memory.id);
  }

  async delete(providerRecordId: string): Promise<void> {
    const memoryId = memoryIdFromRecord(providerRecordId);
    if (memoryId) await this.#options.index.delete(memoryId);
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly query: string;
    readonly limit: number;
    readonly scope?: MemoryTimeScope;
    readonly minimumSimilarity?: number;
    readonly relevanceCutoff?: boolean;
    readonly includeTentative?: boolean;
    readonly tentativeOnly?: boolean;
  }): Promise<readonly MemoryProviderHit[]> {
    if (input.query.trim().length === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_QUERY_EMPTY");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 1000)
      throw new RangeError("limit must be an integer between 0 and 1000");
    if (input.limit === 0) return [];
    const minimumSimilarity = input.minimumSimilarity ?? this.#options.minimumSimilarity ?? 0;
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1)
      throw new RangeError("MEMORY_MINIMUM_SIMILARITY_INVALID");
    const embedder = this.#options.embedder;
    let embedding = null;
    if (embedder) {
      try {
        embedding = {
          model: embedder.model,
          dimensions: embedder.dimensions,
          vector: await embedder.embedQuery(input.query),
        };
      } catch (error) {
        this.#options.onVectorFailure?.(error, { ownerId: input.ownerId, agentId: input.agentId });
      }
    }
    const now = this.#options.now();
    const relevance = this.relevance;
    const result = await this.#options.index.search({
      ownerId: input.ownerId,
      agentId: input.agentId,
      embedding,
      terms: queryTerms(input.query),
      queryText: input.query,
      limit: Math.min(200, Math.max(CANDIDATES_PER_SIGNAL, input.limit)),
      minimumSimilarity,
      now,
      includeHistory: input.scope?.includeHistory === true,
      ...(input.includeTentative === true ? { includeTentative: true } : {}),
      ...(input.tentativeOnly === true ? { tentativeOnly: true } : {}),
    });
    return fuseCandidates(result, {
      now,
      limit: input.limit,
      weights: this.#options.weights ?? DEFAULT_FUSION_WEIGHTS,
      scope: input.scope ?? null,
      ...(input.relevanceCutoff === true
        ? {
            cutoff: {
              minimumScore: minimumSimilarity - relevance.cutoffMargin,
              keywordWeight: relevance.keywordWeight,
              entityWeight: relevance.entityWeight,
            },
            onRelevanceUnknown: (count: number) =>
              this.#options.onRelevanceUnknown?.(count, {
                ownerId: input.ownerId,
                agentId: input.agentId,
              }),
          }
        : {}),
    }).map(({ memoryId, score }) =>
      Object.freeze({
        providerRecordId: memoryIndexRecordId(memoryId),
        productMemoryId: memoryId,
        score,
      }),
    );
  }

  clearScope(ownerId: OwnerId, agentId: AgentId): Promise<void> {
    return this.#options.index.clearScope(ownerId, agentId);
  }
}
