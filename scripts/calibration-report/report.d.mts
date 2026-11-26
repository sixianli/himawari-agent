import type { CalibrationWindow, GroupSummary } from "@himawari-agent/calibration";
import type { PrereviewWeekSummary } from "@himawari-agent/calibration/prereview";
export interface CalibrationRun {
  readonly window: CalibrationWindow;
  readonly decisions: readonly GroupSummary[];
  readonly prereview: PrereviewWeekSummary;
}
export function parseArguments(argv: readonly string[]): Map<string, string>;
export function run(
  argv: readonly string[],
  options?: { now?: Date; output?: { write(text: string): unknown }; root?: string },
): CalibrationRun;
