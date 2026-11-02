export interface CalibrationRun {
  readonly window: { start: string; end: string; days: number; label: string; endDate: string };
  readonly decisions: readonly {
    kind: string;
    total: number;
    rated: number;
    useful: number;
    unneeded: number;
    missed: number;
    hit: import("./calibration.mjs").ProportionResult;
    nuisance: import("./calibration.mjs").ProportionResult;
    missedRate: import("./calibration.mjs").ProportionResult;
  }[];
  readonly muse: {
    entries: number;
    reminded: number;
    silent: number;
    unpaired: number;
    pairedMails: number;
    buckets: {
      both: number;
      museOnly: number;
      himawariOnly: number;
      bothSilent: number;
      noHimawariRecord: number;
    };
    himawariRatingsOnPairedMails: {
      useful: number;
      unneeded: number;
      missed: number;
      unrated: number;
    };
    timing: import("./calibration.mjs").ProportionResult;
    content: import("./calibration.mjs").ProportionResult;
    pairing: import("./calibration.mjs").ProportionResult;
  };
}
export function parseArguments(argv: readonly string[]): Map<string, string>;
export function run(
  argv: readonly string[],
  options?: { now?: Date; output?: { write(text: string): unknown }; root?: string },
): CalibrationRun;
