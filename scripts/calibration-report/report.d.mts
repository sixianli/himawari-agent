import type { CalibrationWindow, GroupSummary, MuseSummary } from "@himawari-agent/calibration";
export interface CalibrationRun {
  readonly window: CalibrationWindow;
  readonly decisions: readonly GroupSummary[];
  readonly muse: MuseSummary;
}
export function parseArguments(argv: readonly string[]): Map<string, string>;
export function run(
  argv: readonly string[],
  options?: { now?: Date; output?: { write(text: string): unknown }; root?: string },
): CalibrationRun;
