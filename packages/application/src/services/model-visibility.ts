import type { DataClassification } from "../ports/common.js";

const RANK: Readonly<Record<DataClassification, number>> = Object.freeze({
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
});

const MODEL_VISIBLE: readonly DataClassification[] = Object.freeze([
  "public",
  "private",
  "sensitive",
]);

export function modelVisibleCeiling(): DataClassification {
  return "sensitive";
}

export function modelVisibleClassifications(): readonly DataClassification[] {
  return MODEL_VISIBLE;
}

export function isModelVisible(classification: string): boolean {
  return (MODEL_VISIBLE as readonly string[]).includes(classification);
}

export function classificationRank(classification: DataClassification): number {
  return RANK[classification];
}

export function highestClassification(
  floor: DataClassification,
  values: Iterable<DataClassification>,
): DataClassification {
  let highest = floor;
  for (const value of values) if (RANK[value] > RANK[highest]) highest = value;
  return highest;
}
