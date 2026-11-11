export interface RelevanceTuning {
  readonly keywordWeight: number;
  readonly entityWeight: number;
  readonly cutoffMargin: number;
}

export const DEFAULT_RELEVANCE_TUNING: RelevanceTuning = Object.freeze({
  keywordWeight: 0.15,
  entityWeight: 0.15,
  cutoffMargin: 0.05,
});

export function validRelevanceTuning(tuning: RelevanceTuning): boolean {
  return [tuning.keywordWeight, tuning.entityWeight, tuning.cutoffMargin].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1,
  );
}
