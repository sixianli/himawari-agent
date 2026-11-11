import type { GateAnalysis, UngatedKind } from "@himawari-agent/calibration";
export interface ThresholdRun {
  readonly required: number;
  readonly analyses: readonly GateAnalysis[];
  readonly ungated: readonly UngatedKind[];
}
export function parseArguments(argv: readonly string[]): Map<string, string>;
export function run(
  argv: readonly string[],
  options?: { now?: Date; output?: { write(text: string): unknown } },
): ThresholdRun;
