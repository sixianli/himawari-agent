import {
  FOLLOW_UP_CACHE_HIT_FLOOR,
  lowCacheHitRate,
  type ModelUsageStorePort,
} from "@himawari-agent/application/model-usage";

export interface LowFollowUpCacheHit {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly hitRate: number;
  readonly floor: number;
}

export function monitorFollowUpCacheHits(
  store: ModelUsageStorePort,
  report: (hit: LowFollowUpCacheHit) => void,
): ModelUsageStorePort {
  return Object.freeze<ModelUsageStorePort>({
    ...(store.isFollowUpTurn
      ? { isFollowUpTurn: (input) => store.isFollowUpTurn?.(input) as Promise<boolean> }
      : {}),
    record: async (observation) => {
      await store.record(observation);
      const hitRate = lowCacheHitRate(observation);
      if (hitRate === null || store.isFollowUpTurn === undefined) return;
      try {
        if (!(await store.isFollowUpTurn(observation))) return;
        report({
          runId: observation.runId,
          provider: observation.provider,
          model: observation.model,
          inputTokens: observation.inputTokens,
          cacheReadTokens: observation.cacheReadTokens,
          hitRate: Math.round(hitRate * 1000) / 1000,
          floor: FOLLOW_UP_CACHE_HIT_FLOOR,
        });
      } catch {
        return;
      }
    },
  });
}
