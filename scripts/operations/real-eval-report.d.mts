import type Database from "better-sqlite3";

export const SCORE_COLUMNS: readonly ["fixed", "fresh", "abstain", "retrieval"];

export interface RealEvalScoreCell {
  readonly successes: number;
  readonly samples: number;
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

export interface RealEvalReportRow {
  readonly id: string;
  readonly day: string;
  readonly startedAt: string;
  readonly outcome: string;
  readonly trigger: string;
  readonly model: string;
  readonly costMicros: number;
  readonly items: number;
  readonly added: number;
  readonly retired: number;
  readonly scores: {
    readonly fixed: RealEvalScoreCell | null;
    readonly fresh: RealEvalScoreCell | null;
    readonly abstain: RealEvalScoreCell | null;
    readonly retrieval: RealEvalScoreCell | null;
  };
}

export function readRuns(
  database: Database.Database,
  options?: { readonly limit?: number },
): RealEvalReportRow[];
export function renderTable(rows: readonly RealEvalReportRow[]): string;
export function main(argv?: readonly string[], output?: { write(text: string): unknown }): void;
