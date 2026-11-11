function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

const SUMMARY_READS = ["off", "ok", "partial", "failed"];

export function summaryInputsValid(
  inputs: {
    readonly summaryInjected?: unknown;
    readonly summaryIds?: unknown;
    readonly summaryDays?: unknown;
    readonly summaryCharacters?: unknown;
    readonly summaryRead?: unknown;
    readonly summaryGenerated?: unknown;
  },
  maxIds: number,
): boolean {
  const ids = (value: unknown, max: number): value is readonly string[] =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => text(item, 1, 256)) &&
    new Set(value).size === value.length;
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const others = [
    inputs.summaryInjected,
    inputs.summaryIds,
    inputs.summaryDays,
    inputs.summaryCharacters,
    inputs.summaryGenerated,
  ];
  if (inputs.summaryRead === undefined) return others.every((value) => value === undefined);
  return (
    typeof inputs.summaryInjected === "boolean" &&
    ids(inputs.summaryIds, maxIds) &&
    ids(inputs.summaryDays, 31) &&
    inputs.summaryDays.every((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day)) &&
    inputs.summaryInjected === inputs.summaryIds.length > 0 &&
    count(inputs.summaryCharacters) &&
    count(inputs.summaryGenerated) &&
    typeof inputs.summaryRead === "string" &&
    SUMMARY_READS.includes(inputs.summaryRead)
  );
}
