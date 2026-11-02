export interface ProportionResult {
  readonly successes: number;
  readonly samples: number;
  readonly enough: boolean;
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
}
export const DEFAULT_MINIMUM_SAMPLES: number;
export function wilsonInterval(
  successes: number,
  samples: number,
  z?: number,
): { low: number; high: number } | null;
export function proportion(
  successes: number,
  samples: number,
  minimumSamples?: number,
): ProportionResult;
export function formatProportion(result: ProportionResult): string;
export function resolveWindow(input?: { end?: string | null; days?: number; now?: Date }): {
  start: string;
  end: string;
  days: number;
  label: string;
  endDate: string;
};
