import type { MemoryIndexCandidate, MemoryIndexSearchResult } from "@himawari-agent/application";
import type { MemoryId } from "@himawari-agent/domain";

export interface FusionWeights {
  readonly rrfK: number;
  readonly vector: number;
  readonly lexical: number;
  readonly entity: number;
  readonly importance: number;
  readonly confidence: number;
  readonly recency: number;
  readonly recencyHalfLifeDays: number;
}

export const DEFAULT_FUSION_WEIGHTS: FusionWeights = Object.freeze({
  rrfK: 60,
  vector: 1,
  lexical: 1,
  entity: 1,
  importance: 0.2,
  confidence: 0.1,
  recency: 0.1,
  recencyHalfLifeDays: 90,
});

export interface FusedHit {
  readonly memoryId: MemoryId;
  readonly score: number;
  readonly sources: readonly ("vector" | "lexical" | "entity")[];
}

const DAY_MS = 86_400_000;

function recency(candidate: MemoryIndexCandidate, now: number, halfLifeDays: number): number {
  const touched = Date.parse(candidate.lastUsedAt ?? candidate.updatedAt);
  const touchedUpdate = Date.parse(candidate.updatedAt);
  const latest = Math.max(
    Number.isFinite(touched) ? touched : 0,
    Number.isFinite(touchedUpdate) ? touchedUpdate : 0,
  );
  const ageDays = Math.max(0, (now - latest) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

export function fuseCandidates(
  result: MemoryIndexSearchResult,
  input: { readonly now: string; readonly limit: number; readonly weights?: FusionWeights },
): FusedHit[] {
  const weights = input.weights ?? DEFAULT_FUSION_WEIGHTS;
  const now = Date.parse(input.now);
  const fused = new Map<
    MemoryId,
    { rrf: number; candidate: MemoryIndexCandidate; sources: Set<"vector" | "lexical" | "entity"> }
  >();
  for (const [source, list, weight] of [
    ["vector", result.vector, weights.vector],
    ["lexical", result.lexical, weights.lexical],
    ["entity", result.entity, weights.entity],
  ] as const) {
    list.forEach((candidate, rank) => {
      const current = fused.get(candidate.memoryId) ?? {
        rrf: 0,
        candidate,
        sources: new Set(),
      };
      current.rrf += weight / (weights.rrfK + rank + 1);
      current.sources.add(source);
      fused.set(candidate.memoryId, current);
    });
  }
  return [...fused.entries()]
    .map(([memoryId, { rrf, candidate, sources }]) => {
      const boost =
        1 +
        weights.importance * (candidate.importancePermille / 1000 - 0.5) +
        weights.confidence * (candidate.confidencePermille / 1000 - 0.5) +
        weights.recency * recency(candidate, now, weights.recencyHalfLifeDays);
      return Object.freeze({
        memoryId,
        score: rrf * boost,
        sources: Object.freeze([...sources]),
      });
    })
    .sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId))
    .slice(0, input.limit);
}
